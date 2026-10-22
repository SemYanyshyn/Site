import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import { RouteExecutor } from '../src/server/route/executor.js';
import type { RouteLimits, RouteProgress } from '../src/shared/route.js';
import { quickRouteInput, routeInput } from './fixtures/route-input.js';

const limits: RouteLimits = {
  maxPoints: 500, maxIterations: 50_000_000, timeoutMs: 30_000, maxCoordinate: 1_000_000,
};

// The observer creates the actual production worker with unchanged URL/options.
// Retaining its reference lets assertions check real thread termination, rather
// than trusting only an executor flag or a resolved promise.
function observedExecutor(configuration = limits, fixture?: string) {
  const workers: Worker[] = [];
  const options = {
    workerFactory: (url: URL, workerOptions: WorkerOptions): Worker => {
      assert.ok(workerOptions.env && typeof workerOptions.env === 'object', 'Workers need an explicit isolated environment.');
      assert.ok(!('DATABASE_URL' in workerOptions.env), 'Database credentials must not be inherited by the worker.');
      assert.ok(!('TEST_DATABASE_URL' in workerOptions.env), 'Test credentials must not be inherited by the worker.');
      const worker = new Worker(url, workerOptions);
      workers.push(worker);
      return worker;
    },
    ...(fixture ? { workerUrl: new URL(`./fixtures/${fixture}`, import.meta.url) } : {}),
  };
  return { executor: new RouteExecutor(configuration, options), workers };
}

async function completesAgain(executor: RouteExecutor, workers: Worker[]): Promise<void> {
  assert.equal(executor.busy, false, 'The previous thread must release the slot.');
  const run = executor.start(quickRouteInput());
  assert.ok(run.threadId > 0, 'The route executes in a real worker thread.');
  const outcome = await run.result;
  assert.equal(outcome.status, 'completed');
  if (outcome.status === 'completed') assert.equal(outcome.result.length, 10);
  assert.equal(executor.busy, false);
  assert.equal(workers.at(-1)?.threadId, -1, 'The result promise must wait for real worker exit.');
}

function waitForSearch(executor: RouteExecutor, input = routeInput()) {
  const progress: RouteProgress[] = [];
  let notifySearch: (() => void) | undefined;
  const searching = new Promise<void>((resolve) => { notifySearch = resolve; });
  const run = executor.start(input, (event) => {
    progress.push(event);
    if (event.stage === 'searching' && event.completedIterations > 0) notifySearch?.();
  });
  return { run, progress, searching };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Expected worker event did not arrive in time.')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('real TypeScript worker completes and releases its actual thread and slot', async () => {
  const { executor, workers } = observedExecutor();
  try {
    await completesAgain(executor, workers);
    await completesAgain(executor, workers);
    assert.equal(workers.length, 2);
  } finally { await executor.shutdown(); }
});

test('invalid input is rejected before worker construction and never takes the slot', async () => {
  const { executor, workers } = observedExecutor();
  try {
    assert.throws(() => executor.start({ ...quickRouteInput(), points: [] }));
    assert.equal(workers.length, 0);
    assert.equal(executor.busy, false);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('busy is synchronous and a competing start creates no second worker', async () => {
  const { executor, workers } = observedExecutor();
  try {
    const run = executor.start(routeInput());
    assert.equal(executor.busy, true);
    assert.throws(() => executor.start(routeInput()), (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'executor_busy';
    });
    assert.equal(workers.length, 1);
    await executor.cancel(run.runId);
    assert.equal((await run.result).status, 'cancelled');
    assert.equal(workers[0]?.threadId, -1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('progress is monotonic, bounded, and tied to actual search counters', async () => {
  const { executor, workers } = observedExecutor();
  const progress: RouteProgress[] = [];
  const input = routeInput(90, 10_000_000);
  try {
    const run = executor.start(input, (event) => progress.push(event));
    const outcome = await run.result;
    assert.equal(outcome.status, 'completed');
    assert.ok(progress.length >= 3, 'Preparing, actual search and finishing must be observable.');
    let previousPercent = 0;
    let previousIterations = 0;
    for (const event of progress) {
      assert.ok(event.percent >= previousPercent && event.percent <= 100);
      assert.ok(Number.isSafeInteger(event.completedIterations));
      assert.ok(event.completedIterations >= previousIterations);
      assert.ok(event.completedIterations <= event.totalIterations);
      assert.equal(event.totalIterations, input.iterations);
      if (event.stage !== 'finishing') assert.ok(event.percent < 100);
      if (event.stage === 'searching') {
        assert.ok(event.percent <= 100 * event.completedIterations / event.totalIterations);
      }
      previousPercent = event.percent;
      previousIterations = event.completedIterations;
    }
    assert.equal(progress.at(-1)?.percent, 100);
    assert.equal(progress.at(-1)?.completedIterations, input.iterations);
    assert.ok(progress.some((event) => event.stage === 'searching' && event.completedIterations > 0));
    assert.equal(workers[0]?.threadId, -1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('a throwing user progress callback does not crash or strand a real worker', async () => {
  const { executor, workers } = observedExecutor();
  let callbacks = 0;
  try {
    const run = executor.start(routeInput(12, 2_000), () => {
      callbacks++;
      throw new Error('Intentional subscriber failure.');
    });
    assert.equal((await run.result).status, 'completed');
    assert.ok(callbacks > 0);
    assert.equal(workers[0]?.threadId, -1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('a rejected asynchronous progress callback is observed without stranding its worker', async () => {
  const { executor, workers } = observedExecutor();
  let callbacks = 0;
  try {
    const run = executor.start(routeInput(12, 2_000), async () => {
      callbacks++;
      await Promise.resolve();
      throw new Error('Intentional asynchronous subscriber failure.');
    });
    assert.equal((await run.result).status, 'completed');
    // Node's test runner reports any unhandled rejection as a test failure.
    await delay(0);
    assert.ok(callbacks > 0);
    assert.equal(workers[0]?.threadId, -1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('cancel interrupts actual searching, ignores a stale id, and permits recovery', async () => {
  const { executor, workers } = observedExecutor();
  try {
    const { run, progress, searching } = waitForSearch(executor);
    let terminalCount = 0;
    void run.result.then(() => { terminalCount++; });
    await within(searching, 5_000);
    await executor.cancel('unrelated-stale-run');
    assert.equal(executor.busy, true);
    await Promise.all([executor.cancel(run.runId), executor.cancel(run.runId)]);
    assert.equal((await run.result).status, 'cancelled');
    assert.equal(workers[0]?.threadId, -1);
    assert.ok(progress.some((event) => event.completedIterations > 0));
    assert.ok(progress.every((event) => event.percent < 100));
    const eventCount = progress.length;
    await delay(30);
    assert.equal(progress.length, eventCount, 'A stopped thread cannot deliver late progress.');
    assert.equal(terminalCount, 1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('early cancellation and cancelling a completed run are safe and idempotent', async () => {
  const { executor, workers } = observedExecutor();
  try {
    const early = executor.start(routeInput());
    await executor.cancel(early.runId);
    await executor.cancel(early.runId);
    assert.equal((await early.result).status, 'cancelled');
    assert.equal(workers[0]?.threadId, -1);
    const completed = executor.start(quickRouteInput());
    const outcome = await completed.result;
    assert.equal(outcome.status, 'completed');
    await executor.cancel(completed.runId);
    await executor.cancel();
    assert.equal(await completed.result, outcome, 'Cancellation cannot replace a completed terminal result.');
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('a short parent deadline terminates real search and releases the slot', async () => {
  const { executor, workers } = observedExecutor({ ...limits, timeoutMs: 1_000 });
  const started = performance.now();
  try {
    const { run, progress } = waitForSearch(executor);
    const outcome = await run.result;
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.equal(outcome.reason, 'timeout');
    assert.ok(performance.now() - started >= 900, 'A timeout must reflect the real elapsed deadline.');
    assert.ok(performance.now() - started < 5_000, 'A short timeout must not wait for the full default budget.');
    assert.ok(progress.some((event) => event.stage === 'searching' && event.completedIterations > 0),
      'The timeout scenario must interrupt actual search after completed iterations.');
    assert.ok(progress.every((event) => event.percent < 100));
    assert.equal(workers[0]?.threadId, -1);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

for (const fixture of ['route-crash.mjs', 'route-exit.mjs', 'route-invalid-result.mjs']) {
  test(`${fixture} is one worker_error and frees the slot for the next real run`, async () => {
    const workers: Worker[] = [];
    let attempts = 0;
    const executor = new RouteExecutor(limits, {
      workerFactory: (url, options) => {
        const selectedUrl = attempts++ === 0 ? new URL(`./fixtures/${fixture}`, import.meta.url) : url;
        const worker = new Worker(selectedUrl, options);
        workers.push(worker);
        return worker;
      },
    });
    try {
      const run = executor.start(quickRouteInput());
      let terminalCount = 0;
      void run.result.then(() => { terminalCount++; });
      const outcome = await within(run.result, 5_000);
      assert.equal(outcome.status, 'failed');
      if (outcome.status === 'failed') assert.equal(outcome.reason, 'worker_error');
      assert.equal(workers[0]?.threadId, -1);
      await delay(20);
      assert.equal(terminalCount, 1);
      await completesAgain(executor, workers);
    } finally { await executor.shutdown(); }
  });
}

test('worker construction failure settles and the next real worker still succeeds', async () => {
  const workers: Worker[] = [];
  let attempts = 0;
  const executor = new RouteExecutor(limits, {
    workerFactory: (url, options) => {
      if (attempts++ === 0) throw new Error('Intentional construction failure.');
      const worker = new Worker(url, options);
      workers.push(worker);
      return worker;
    },
  });
  try {
    const run = executor.start(quickRouteInput());
    const outcome = await within(run.result, 1_000);
    assert.equal(outcome.status, 'failed');
    if (outcome.status === 'failed') assert.equal(outcome.reason, 'worker_error');
    assert.equal(workers.length, 0);
    await completesAgain(executor, workers);
  } finally { await executor.shutdown(); }
});

test('shutdown terminates an active search, is repeatable, and prevents new work', async () => {
  const { executor, workers } = observedExecutor();
  const { run, searching } = waitForSearch(executor);
  try {
    await within(searching, 5_000);
    await within(Promise.all([executor.shutdown(), executor.shutdown()]), 3_000);
    assert.equal((await run.result).status, 'cancelled');
    assert.equal(workers[0]?.threadId, -1);
    assert.equal(executor.busy, false);
    assert.throws(() => executor.start(quickRouteInput()), (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'executor_shutdown';
    });
  } finally { await executor.shutdown(); }
});

test('built worker runs from another cwd without source TypeScript, tsx, or node_modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'courier-route-built-'));
  try {
    await cp(new URL('../dist/server/route/', import.meta.url), join(directory, 'server/route'), { recursive: true });
    await cp(new URL('../dist/shared/', import.meta.url), join(directory, 'shared'), { recursive: true });
    await writeFile(join(directory, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(directory, 'run.mjs'), `
      import { RouteExecutor } from './server/route/executor.js';
      const executor = new RouteExecutor({maxPoints:500,maxIterations:50000000,timeoutMs:30000,maxCoordinate:1000000});
      try {
        const run = executor.start({warehouse:{x:0,y:0},points:[{x:3,y:4}],iterations:10,seed:0});
        const outcome = await run.result;
        if (outcome.status !== 'completed' || outcome.result.length !== 10 || run.threadId <= 0 || executor.busy) process.exitCode = 1;
        console.log(JSON.stringify({status:outcome.status,threadId:run.threadId,busy:executor.busy}));
      } finally { await executor.shutdown(); }
    `);
    const files = await readdir(directory, { recursive: true });
    assert.ok(files.every((file) => !file.endsWith('.ts') && !file.includes('node_modules')));
    const child = spawn(process.execPath, [join(directory, 'run.mjs')], {
      cwd: tmpdir(), env: {}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      assert.equal(await within(closed, 5_000), 0);
      const summary = JSON.parse(output) as { status: string; threadId: number; busy: boolean };
      assert.equal(summary.status, 'completed');
      assert.ok(summary.threadId > 0);
      assert.equal(summary.busy, false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
