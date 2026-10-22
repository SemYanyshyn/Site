import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

type HarnessMessage = Record<string, unknown>;
interface Harness {
  child: ChildProcess;
  messages: HarnessMessage[];
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startHarness(): Harness {
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('./fixtures/route-http-harness.ts', import.meta.url)),
  ], {
    // Also checks that server/worker locations do not depend on cwd.
    cwd: tmpdir(), env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const messages: HarnessMessage[] = [];
  child.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null) messages.push(message as HarnessMessage);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', () => resolve({ code: -1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, messages, closed };
}

async function waitMessage(harness: Harness, matches: (message: HarnessMessage) => boolean): Promise<HarnessMessage> {
  const existing = harness.messages.find(matches);
  if (existing) return existing;
  return new Promise<HarnessMessage>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('HTTP/worker harness event did not arrive in time.')), 8_000);
    const receive = (message: unknown): void => {
      if (typeof message === 'object' && message !== null && matches(message as HarnessMessage)) {
        finish(undefined, message as HarnessMessage);
      }
    };
    const exited = (): void => finish(new Error('HTTP/worker harness exited before the expected event.'));
    const finish = (error?: Error, message?: HarnessMessage): void => {
      clearTimeout(timeout);
      harness.child.off('message', receive);
      harness.child.off('exit', exited);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    harness.child.on('message', receive);
    harness.child.once('exit', exited);
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) exited();
  });
}

let nextRequestId = 0;
async function snapshot(harness: Harness): Promise<HarnessMessage> {
  const requestId = ++nextRequestId;
  harness.child.send({ type: 'snapshot', requestId });
  return waitMessage(harness, (message) => message.type === 'state' && message.requestId === requestId);
}

async function ensureStopped(harness: Harness): Promise<void> {
  if (harness.child.exitCode === null && harness.child.signalCode === null) harness.child.kill('SIGTERM');
  const result = await Promise.race([harness.closed, delay(6_000, undefined, { ref: false })]);
  if (!result) {
    harness.child.kill('SIGKILL');
    await harness.closed;
    assert.fail('Temporary HTTP/worker process did not terminate.');
  }
}

async function activeHarness(t: TestContext): Promise<{ harness: Harness; port: number; pid: number }> {
  const harness = startHarness();
  t.after(() => ensureStopped(harness));
  const searching = await waitMessage(harness, (message) => message.type === 'searching');
  assert.ok(typeof searching.port === 'number' && typeof searching.pid === 'number');
  assert.equal(searching.pid, harness.child.pid, 'The HTTP app and executor are in the spawned harness process.');
  assert.ok(typeof searching.threadId === 'number' && searching.threadId > 0);
  return { harness, port: searching.port, pid: searching.pid };
}

test('real health requests remain responsive while same-process worker search is pending', async (t) => {
  const { harness, port, pid } = await activeHarness(t);
  const latencies: number[] = [];
  for (let index = 0; index < 5; index++) {
    const before = await snapshot(harness);
    assert.equal(before.pid, pid);
    assert.equal(before.pending, true);
    assert.equal(before.busy, true);
    assert.ok(typeof before.completedIterations === 'number' && before.completedIterations > 0);
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    latencies.push(performance.now() - started);
    assert.equal(response.status, 200);
    const body = await response.json() as { status?: unknown; instanceId?: unknown };
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.instanceId, 'string');
    const after = await snapshot(harness);
    assert.equal(after.pending, true, 'Every measured response must precede the terminal worker result.');
    assert.equal(after.busy, true);
    assert.ok(typeof after.completedIterations === 'number' && after.completedIterations >= before.completedIterations);
    // Test pacing observes several real progress periods without slowing search.
    if (index < 4) await delay(80);
  }
  assert.equal(harness.messages.filter((message) => message.type === 'terminal').length, 0);
  t.diagnostic(JSON.stringify({ samples: latencies.length, latenciesMs: latencies.map((value) => Number(value.toFixed(2))), workerPendingForEveryResponse: true }));
  harness.child.send({ type: 'shutdown' });
  await waitMessage(harness, (message) => message.type === 'stopped');
  assert.deepEqual(await harness.closed, { code: 0, signal: null });
  const terminal = harness.messages.filter((message) => message.type === 'terminal');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.status, 'cancelled');
  assert.equal(terminal[0]?.busy, false);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`${signal} stops an active real worker and HTTP within the shutdown limit`, async (t) => {
    const { harness, port } = await activeHarness(t);
    const before = await snapshot(harness);
    assert.equal(before.pending, true);
    assert.equal(before.busy, true);
    const started = performance.now();
    harness.child.kill(signal);
    const result = await Promise.race([harness.closed, delay(5_000, undefined, { ref: false })]);
    assert.ok(result, 'Graceful shutdown must finish before its five-second hard limit.');
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(performance.now() - started < 5_000);
    const terminal = harness.messages.filter((message) => message.type === 'terminal');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.status, 'cancelled');
    assert.equal(terminal[0]?.busy, false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }));
    t.diagnostic(JSON.stringify({ signal, shutdownMs: Number((performance.now() - started).toFixed(2)), activeWorkerCancelled: true }));
  });
}
