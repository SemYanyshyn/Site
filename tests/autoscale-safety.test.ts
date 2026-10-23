import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
// @ts-expect-error Native executable deliberately has no emitted declarations.
import { assertScaleSnapshot, autoscaleBudget, parseCpuCores, parseMemoryBytes, proveExpandedWork, reconcileCancellation, summarizePods, validateCompletedRoute } from '../scripts/check-autoscale.mjs';
// @ts-expect-error Native deployment helper deliberately has no emitted declarations.
import { appApplyPlan, assertObjectOwner, replicaHandoffPatch } from '../scripts/deployment-autoscale.mjs';
// @ts-expect-error Native command runner deliberately has no emitted declarations.
import { DeploymentDeadlineError, runDeploymentCommand, withDeploymentDeadline, withoutDeploymentDeadline } from '../scripts/deployment-command.mjs';
// @ts-expect-error Native HTTPS fixture deliberately has no emitted declarations.
import { requestDeployment, verifiedCrossCancellation } from '../scripts/check-deployment.mjs';

const ownerId = '00000000-0000-4000-8000-000000000001';
const namespace = 'courier-route-test-hpa-unit';
const labels = { 'app.kubernetes.io/managed-by': 'courier-route-local', 'courier-route.local/owner-id': ownerId };
const live = (replicas: number) => ({ kind: 'Deployment', metadata: { name: 'app', namespace, labels }, spec: { replicas, template: { unchanged: true } } });

test('autoscale CPU quantities preserve cores and reject absent, malformed or unbounded usage', () => {
  for (const [input, expected] of [['250m', 0.25], ['200000000n', 0.2], ['500000u', 0.5], ['1', 1], ['1.2', 1.2], ['25e-2', 0.25], ['0', 0]] as const) {
    assert.equal(parseCpuCores(input), expected);
  }
  for (const input of [undefined, '', '-1m', 'NaN', 'Infinity', '2Mi', '1e999', '1000001', '2m trailing']) assert.throws(() => parseCpuCores(input));
});

test('autoscale memory quantities distinguish binary and decimal units with finite bounds', () => {
  for (const [input, expected] of [['128Mi', 134217728], ['64Ki', 65536], ['1Gi', 1073741824], ['2M', 2000000], ['2k', 2000], ['1024', 1024], ['1e3', 1000]] as const) {
    assert.equal(parseMemoryBytes(input), expected);
  }
  for (const input of [undefined, '', '-1Mi', 'NaN', 'Infinity', '3cpu', '1e999', '9Ei']) assert.throws(() => parseMemoryBytes(input));
});

test('autoscale load budgets cap real users, active/accepted jobs, finite feed and total deadline', () => {
  const defaults = autoscaleBudget();
  assert.deepEqual(defaults, { users: 3, maxActive: 9, maxAccepted: 200, feedMs: 120000, deadlineMs: 720000, pollMs: 2000 });
  assert.ok(Object.isFrozen(defaults));
  for (const overrides of [{ users: 4 }, { maxActive: 10 }, { maxActive: 9.5 }, { maxAccepted: 201 }, { feedMs: 180001 },
    { feedMs: 119999 }, { deadlineMs: Infinity }, { deadlineMs: 780001 }, { deadlineMs: 300000 }, { pollMs: 0 }]) assert.throws(() => autoscaleBudget(overrides));
});

test('replica ownership handoff removes only the old last-applied replica field with an optimistic test', () => {
  const previous = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'app', annotations: { keep: 'unchanged' } }, spec: { replicas: 2, template: { keep: true }, minReadySeconds: 2 } };
  const encoded = JSON.stringify(previous);
  const patch = replicaHandoffPatch({ metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': encoded } } });
  assert.equal(patch.length, 2);
  assert.deepEqual(patch[0], { op: 'test', path: '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration', value: encoded });
  const expected = structuredClone(previous) as { spec: { replicas?: number; template: { keep: boolean }; minReadySeconds: number } };
  delete expected.spec.replicas;
  assert.deepEqual(JSON.parse(patch[1].value), expected);
  assert.equal(patch[1].value, `${JSON.stringify(expected)}\n`, 'Preserve kubectl canonical trailing LF so a first repeat does not rewrite the annotation.');
  assert.equal(previous.spec.replicas, 2);
  assert.equal(replicaHandoffPatch({}), null);
  for (const value of ['{invalid', '[]', 'null']) assert.throws(() => replicaHandoffPatch({ metadata: { annotations: { 'kubectl.kubernetes.io/last-applied-configuration': value } } }));
});

test('HPA apply preserves live four; only new, explicit zero restart or static regression bootstrap two', () => {
  const manifest = { apiVersion: 'v1', kind: 'List', items: [live(2)] };
  const options = { autoscaling: true, namespace, ownerId };
  const plan = appApplyPlan(manifest, live(4), options);
  assert.equal(Object.hasOwn(plan.manifest.items[0].spec, 'replicas'), false);
  assert.equal(plan.bootstrap, false);
  for (const current of [undefined, live(0)]) {
    const boot = appApplyPlan(manifest, current, options);
    assert.equal(boot.bootstrap, true);
    assert.equal(boot.manifest.items[0].spec.replicas, 2);
  }
  assert.equal(appApplyPlan(manifest, live(4), { ...options, autoscaling: false }).manifest.items[0].spec.replicas, 2);
  assert.equal(manifest.items[0]!.spec.replicas, 2);
});

test('replica apply refuses a foreign namespace, owner, object kind or manager', () => {
  const options = { namespace, ownerId, kind: 'Deployment', name: 'app' };
  assert.doesNotThrow(() => assertObjectOwner(live(4), options));
  for (const changed of [{ ...options, namespace: 'courier-route' }, { ...options, ownerId: 'another' },
    { ...options, kind: 'StatefulSet' }, { ...options, name: 'other' }]) assert.throws(() => assertObjectOwner(live(4), changed));
  assert.throws(() => assertObjectOwner({ ...live(4), metadata: { ...live(4).metadata, labels: {} } }, options));
});

function actualPods(count: number) {
  return Array.from({ length: count }, (_, index) => ({ metadata: { name: `app-${index}`, uid: `pod-${index}` },
    spec: { containers: [{ name: 'app', image: 'courier:fixed' }] }, status: { conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: true, imageID: `sha256:${'a'.repeat(64)}`, restartCount: 0 }] } }));
}

test('autoscale capacity distinguishes terminating pods and exact ready endpoint UIDs, never counts desired pods', () => {
  const pods = actualPods(4);
  const endpoints = [{ endpoints: pods.map((pod) => ({ conditions: { ready: true }, targetRef: { uid: pod.metadata.uid } })) }];
  const capacity = summarizePods(pods, endpoints, 'courier:fixed');
  assert.equal(capacity.ready, 4); assert.equal(capacity.terminating, 0); assert.equal(capacity.endpointUids.length, 4);
  assert.throws(() => summarizePods(actualPods(5), endpoints, 'courier:fixed'));
  const restarted = structuredClone(pods);
  restarted[0]!.status.containerStatuses[0]!.restartCount = 1;
  assert.throws(() => summarizePods(restarted, endpoints, 'courier:fixed'));
  assert.throws(() => summarizePods(pods, [{ endpoints: [{ conditions: { ready: true }, targetRef: { uid: 'not-an-actual-pod' } }] }], 'courier:fixed'));
  const terminating = [{ ...pods[0], metadata: { ...pods[0]!.metadata, deletionTimestamp: new Date().toISOString() } }, pods[1]!];
  assert.equal(summarizePods(terminating, [], 'courier:fixed').ready, 1);
});

test('new C and D each need positive running work and the same completed job executed by that UUID', () => {
  const pods = Array.from({ length: 4 }, (_, index) => ({ name: `pod-${index}`, uid: String(index), instanceId: `00000000-0000-4000-8000-00000000000${index + 1}` }));
  const progress = pods.slice(2).map((pod, index) => ({ id: `job-${index}`, executedBy: pod.instanceId, completedIterations: 10 }));
  const completed = progress.map((job) => ({ ...job, status: 'completed' }));
  assert.equal(proveExpandedWork(new Set(['0', '1']), pods, progress, completed).length, 2);
  assert.throws(() => proveExpandedWork(new Set(['0', '1']), pods, progress.slice(0, 1), completed));
  assert.throws(() => proveExpandedWork(new Set(['0', '1']), pods, progress, completed.map((job) => ({ ...job, status: 'failed' }))));
  assert.throws(() => proveExpandedWork(new Set(['0', '1']), pods, progress.map((job) => ({ ...job, completedIterations: 0 })), completed));
});

test('scale-cycle acceptance rejects stale/missing metrics, missing actual registry or terminating capacity', () => {
  const pods = actualPods(2).map((pod, index) => ({ ...pod.metadata, ready: true, terminating: false, instanceId: `00000000-0000-4000-8000-00000000000${index + 1}` }));
  const snapshot = { hpa: { min: 2, max: 4, current: 2, desired: 2, conditions: ['AbleToScale', 'ScalingActive'].map((type) => ({ type, status: 'True' })) },
    deployment: { desired: 2 }, ready: 2, terminating: 0, pods, endpointUids: pods.map((pod) => pod.uid),
    registry: pods.map((pod) => ({ instance_id: pod.instanceId })), metrics: pods.map(() => ({ fresh: true, window: '15s', cpuCores: 0.01, memoryBytes: 1024 })) };
  assert.doesNotThrow(() => assertScaleSnapshot(snapshot, 2));
  for (const changed of [{ ...snapshot, ready: 1 }, { ...snapshot, terminating: 1 }, { ...snapshot, registry: [] },
    { ...snapshot, metrics: [] }, { ...snapshot, metrics: snapshot.metrics.map((value) => ({ ...value, fresh: false })) },
    { ...snapshot, endpointUids: ['invented-1', 'invented-2'] }]) assert.throws(() => assertScaleSnapshot(changed, 2));
});

test('added executor route proof checks actual result permutation, Euclidean length, seed and full iterations', () => {
  const detail = { status: 'completed', executedBy: ownerId, input: { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], seed: 0, iterations: 10000 },
    result: { order: [0, 1, 2, 3, 0], length: 4, initialLength: 4, seed: 0, iterationsRequested: 10000, iterationsCompleted: 10000 }, progress: { percent: 100 } };
  assert.doesNotThrow(() => validateCompletedRoute(detail));
  for (const changed of [{ ...detail, status: 'running' }, { ...detail, progress: { percent: 99 } },
    { ...detail, result: { ...detail.result, order: [0, 1, 1, 3, 0] } }, { ...detail, result: { ...detail.result, length: 3 } },
    { ...detail, result: { ...detail.result, seed: 1 } }, { ...detail, result: { ...detail.result, iterationsCompleted: 9999 } }]) assert.throws(() => validateCompletedRoute(changed));
});

test('expired command scope prevents a real mutation while cleanup runs outside that expired scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'courier-deadline-cleanup-'));
  const mutation = join(directory, 'late-mutation');
  const cleanup = join(directory, 'cleanup-ran');
  const write = (path: string) => runDeploymentCommand(process.execPath,
    ['--input-type=module', '-e', "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],'actual child mutation')", path]);
  try {
    await withDeploymentDeadline(Date.now() - 1, async () => {
      await assert.rejects(write(mutation), DeploymentDeadlineError);
      await withoutDeploymentDeadline(() => write(cleanup));
      assert.equal(await readFile(cleanup, 'utf8'), 'actual child mutation');
      await assert.rejects(write(mutation), DeploymentDeadlineError);
    });
    await assert.rejects(readFile(mutation), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('absolute deadline kills and reaps a real running child before it can perform its delayed mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'courier-deadline-child-'));
  const pidFile = join(directory, 'pid');
  const late = join(directory, 'late-mutation');
  try {
    await assert.rejects(withDeploymentDeadline(Date.now() + 800, () => runDeploymentCommand(process.execPath,
      ['--input-type=module', '-e', "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>writeFileSync(process.argv[2],'too late'),1100)", pidFile, late],
      { timeoutMs: 5000 })), DeploymentDeadlineError);
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'The deadline promise must settle after the actual child exits.');
    await delay(500);
    await assert.rejects(readFile(late), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nested command scope cannot extend its parent or contaminate another concurrent deadline scope', async () => {
  const [short, independent] = await Promise.allSettled([
    withDeploymentDeadline(Date.now() + 100, () => withDeploymentDeadline(Date.now() + 5000,
      () => runDeploymentCommand(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('late'),1000)"], { timeoutMs: 3000 }))),
    withDeploymentDeadline(Date.now() + 3000,
      () => runDeploymentCommand(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('independent'),250)"])),
  ]);
  assert.equal(short.status, 'rejected');
  if (short.status === 'rejected') assert.ok(short.reason instanceof DeploymentDeadlineError);
  assert.equal(independent.status, 'fulfilled');
  if (independent.status === 'fulfilled') assert.equal(independent.value, 'independent');
});

test('the absolute HTTPS-client budget terminates a real active trickle, rather than only timing out an idle socket', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"bounded":"');
    const interval = setInterval(() => response.write('x'), 10);
    const end = setTimeout(() => response.end('"}'), 450);
    response.once('close', () => { clearInterval(interval); clearTimeout(end); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const before = Date.now();
  try {
    await assert.rejects(requestDeployment(`http://localhost:${address.port}`, undefined, { timeoutMs: 80 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Deployment transport request failed.');
      return true;
    });
    assert.ok(Date.now() - before < 400, 'An active response must be stopped before its deliberately later normal completion.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a real reset after committed cancellation is reconciled only by reads and never supplies a missing 202 proof', async () => {
  const id = '00000000-0000-4000-8000-000000000099';
  let posts = 0;
  let status = 'running';
  const server = createServer((request, response) => {
    if (request.method === 'POST') { posts++; status = 'cancelled'; request.resume(); response.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id, status, executedBy: ownerId }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://localhost:${address.port}`;
  try {
    await assert.rejects(requestDeployment(origin, undefined, { path: `/api/jobs/${id}/cancel`, method: 'POST', body: {} }));
    const terminal = await reconcileCancellation(id, async (jobId: string) =>
      (await requestDeployment(origin, undefined, { path: `/api/jobs/${jobId}` })).value, async () => {});
    assert.equal(posts, 1);
    assert.equal(terminal.status, 'cancelled');
    assert.equal(verifiedCrossCancellation({ id, executedBy: ownerId }, { handler: null, status: null }, { value: terminal }), false);
    let reads = 0;
    await assert.rejects(reconcileCancellation(id, async () => { reads++; return null; }, async () => {}, 2), /bounded read budget/u);
    assert.equal(reads, 2);
    await assert.rejects(reconcileCancellation(id, async () => ({ id, status: 'failed' }), async () => {}));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
