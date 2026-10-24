import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { ClientRequest } from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { PoolClient } from 'pg';
import express from 'express';
import type { AdminExecutor, AdminPod } from '../src/shared/admin.js';
import { adminRead } from '../src/server/admin/budget.js';
import { readAdminConfig } from '../src/server/admin/config.js';
import { KubernetesProvider, parseCpu, parseHpa, parseMemory, parseMetrics, parsePods, readKubernetesResponse } from '../src/server/admin/kubernetes.js';
import type { InfrastructureSnapshot, KubernetesTransport } from '../src/server/admin/kubernetes.js';
import type { AdminDatabaseSnapshot } from '../src/server/admin/repository.js';
import { parseAdminJobsOptions } from '../src/server/admin/router.js';
import { mergeAdminOverview } from '../src/server/admin/service.js';
import { AdminService } from '../src/server/admin/service.js';
import { createAdminRouter } from '../src/server/admin/router.js';
import { HttpError } from '../src/server/auth/errors.js';

const owner = randomUUID();
const podUid = randomUUID();
const config = { enabled: true, namespace: 'courier-test', ownerId: owner };
const stamp = '2026-01-02T03:04:05Z';
const meta = (name = 'app') => ({ name, namespace: config.namespace, uid: podUid, creationTimestamp: stamp,
  labels: { 'courier-route.local/owner-id': owner, 'app.kubernetes.io/name': 'courier-route-app', 'app.kubernetes.io/component': 'app' } });
function rawPod() {
  return { metadata: meta('app-pod'), spec: { containers: [{ name: 'app', env: [{ name: 'PRIVATE', value: 'must-not-project' }],
    resources: { requests: { cpu: '250m', memory: '128Mi' }, limits: { cpu: '1', memory: '384Mi' } } }] },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
    containerStatuses: [{ name: 'app', restartCount: 1, state: { running: { startedAt: stamp } } }] } };
}
function rawMetrics() {
  return { items: [{ metadata: { name: 'app-pod', namespace: config.namespace }, timestamp: '2026-01-02T03:04:10Z', window: '2.01s',
    containers: [{ name: 'app', usage: { cpu: '800000000n', memory: '40960Ki' } }] }] };
}
function rawHpa() { return { metadata: meta(), spec: { minReplicas: 2, maxReplicas: 4 }, status: { currentReplicas: 2, desiredReplicas: 4, conditions: [] } }; }
function fixturePod(overrides: Partial<AdminPod> = {}): AdminPod {
  return { uid: podUid, name: 'app-pod', namespace: config.namespace, phase: 'Running', ready: true, terminating: false,
    createdAt: stamp, containerStartedAt: stamp, restarts: 0,
    requests: { cpuCores: 0.25, memoryBytes: 128 * 1024 ** 2 }, limits: { cpuCores: 1, memoryBytes: 384 * 1024 ** 2 }, ...overrides };
}
function executor(overrides: Partial<AdminExecutor> = {}): AdminExecutor {
  return { instanceId: randomUUID(), podUid, podName: 'app-pod', podNamespace: config.namespace, startedAt: '2026-01-02T03:04:06Z',
    lastSeenAt: '2026-01-02T03:04:10Z', expiresAt: '2026-01-02T03:04:25Z', fresh: true, acceptingClaims: true,
    busy: false, currentJobId: null, runningJobIds: [], ...overrides };
}
function infra(pods = [fixturePod()]): InfrastructureSnapshot {
  const source = { status: 'ok' as const, observedAt: '2026-01-02T03:04:10Z', cacheAgeMs: 0, message: null };
  return { kubernetes: source, metrics: source, pods, samples: parseMetrics(rawMetrics(), config), hpa: null, deployment: null };
}
function database(executors: AdminExecutor[]): AdminDatabaseSnapshot {
  return { observedAt: '2026-01-02T03:04:10Z', counts: { queued: 0, running: 0, completed: 0, cancelled: 0, failed: 0 }, executors, recentTruncated: false };
}

test('CPU and memory quantity parsers preserve real zero/fractions and reject malformed, negative or unbounded values', () => {
  assert.equal(parseCpu('123000000n'), 0.12300000000000001); assert.equal(parseCpu('250m'), 0.25);
  assert.equal(parseCpu('123u'), 0.00012299999999999998); assert.equal(parseCpu('1e-3'), 0.001); assert.equal(parseCpu('0'), 0);
  assert.equal(parseMemory('128Mi'), 134217728); assert.equal(parseMemory('123Ki'), 125952); assert.equal(parseMemory('1.5Gi'), 1610612736);
  assert.equal(parseMemory('1G'), 1e9); assert.equal(parseMemory('0.1Ki'), 102.4); assert.equal(parseMemory('100m'), 0.1);
  for (const bad of [null, 2, '-1', 'NaN', 'Infinity', '2m trailing', '1e999']) {
    assert.throws(() => parseCpu(bad)); assert.throws(() => parseMemory(bad));
  }
});

test('external Kubernetes parsing whitelists actual fields, owner/namespace and bounded lists; absent HPA status stays unknown', () => {
  const pods = parsePods({ items: [rawPod()] }, config);
  assert.equal(pods[0]!.requests.cpuCores, 0.25); assert.equal(pods[0]!.restarts, 1);
  assert.equal(JSON.stringify(pods).includes('PRIVATE'), false);
  assert.throws(() => parsePods({ items: [rawPod()] }, { ...config, namespace: 'foreign' }));
  assert.throws(() => parsePods({ items: Array.from({ length: 101 }, rawPod) }, config));
  assert.equal(parseHpa(rawHpa(), config).desiredReplicas, 4);
  assert.throws(() => parseHpa({ ...rawHpa(), status: {} }, config));
  assert.throws(() => parseMetrics({ items: [{ ...rawMetrics().items[0], timestamp: 'invalid' }] }, config));
});

test('mapping uses pod UID/namespace/container lifetime; previous fresh process is separate and does not add another server', () => {
  const old = executor({ startedAt: '2026-01-02T03:04:04Z', busy: true });
  const current = executor();
  const value = mergeAdminOverview(database([old, current]), infra(), Date.parse('2026-01-02T03:04:11Z'));
  assert.equal(value.servers.length, 1); assert.equal(value.servers[0]!.executor?.instanceId, current.instanceId);
  assert.equal(value.summary.confirmedExecutors, 1); assert.equal(value.database.queueExecutorCount, 1);
  assert.equal(value.unmatchedExecutors[0]!.reason, 'previous-process'); assert.equal(value.unmatchedExecutors[0]!.busy, true);
  const mismatch = mergeAdminOverview(database([executor({ podNamespace: 'other' })]), infra());
  assert.equal(mismatch.servers[0]!.executor, null); assert.equal(mismatch.unmatchedExecutors[0]!.reason, 'metadata-mismatch');
});

test('Pending/terminating, expired running and cancel/finalization are distinct from available physical capacity', () => {
  const runningId = randomUUID();
  const expired = executor({ fresh: false, busy: true, currentJobId: runningId, runningJobIds: [runningId] });
  const value = mergeAdminOverview(database([expired]), infra([fixturePod({ ready: false, terminating: true })]));
  assert.equal(value.summary.readyPods, 0); assert.equal(value.summary.terminatingPods, 1);
  assert.equal(value.database.queueExecutorCount, 0); assert.equal(value.servers[0]!.executor?.currentJobId, runningId);
  const pending = mergeAdminOverview(database([]), infra([fixturePod({ phase: 'Pending', ready: false, containerStartedAt: null })]));
  assert.equal(pending.servers[0]!.executor, null); assert.equal(pending.servers[0]!.metric, null);
  assert.equal(pending.summary.confirmedExecutors, 0);
});

test('metrics keep source timestamp/window, reject previous container samples, and partial aggregates expose coverage', () => {
  const now = Date.parse('2026-01-02T03:04:11Z');
  const snapshot = infra([fixturePod(), fixturePod({ uid: randomUUID(), name: 'pending', phase: 'Pending', ready: false, containerStartedAt: null })]);
  const value = mergeAdminOverview(database([executor()]), snapshot, now);
  assert.equal(value.summary.metricCoverage, 1); assert.equal(value.summary.metricPodCount, 2);
  assert.equal(value.summary.cpuCores, 0.8); assert.equal(value.servers[0]!.metric!.timestamp, '2026-01-02T03:04:10Z');
  const restart = mergeAdminOverview(database([executor({ startedAt: '2026-01-02T03:04:12Z' })]),
    infra([fixturePod({ containerStartedAt: '2026-01-02T03:04:12Z' })]), now + 2000);
  assert.equal(restart.servers[0]!.metric, null);
  const stale = mergeAdminOverview(database([executor()]), snapshot, now + 46_000);
  assert.equal(stale.servers[0]!.metric?.stale, true); assert.equal(stale.summary.cpuCores, null); assert.equal(stale.summary.memoryBytes, null);
});

test('query validation rejects arrays, unknown keys, huge offsets and malformed UUID without SQL interpolation', () => {
  assert.deepEqual(parseAdminJobsOptions({}), { limit: 20, offset: 0 });
  assert.deepEqual(parseAdminJobsOptions({ status: 'active', limit: '50', offset: '0' }), { status: 'active', limit: 50, offset: 0 });
  for (const value of [{ limit: ['1', '2'] }, { offset: '1000001' }, { role: 'admin' }, { executedBy: "x' OR true" }, { limit: '2.0' }]) {
    assert.throws(() => parseAdminJobsOptions(value));
  }
  assert.deepEqual(readAdminConfig({}), { enabled: false, namespace: null, ownerId: null });
  assert.throws(() => readAdminConfig({ ADMIN_KUBERNETES_ENABLED: 'true', POD_NAMESPACE: '../foreign', ADMIN_CLUSTER_OWNER_ID: owner }));
});

test('single-flight/cache gate produces four fixed bounded calls, retains old sample times on real provider failure, then recovers', async () => {
  let clock = 0, calls = 0, failMetrics = false, closed = false;
  const transport: KubernetesTransport = {
    async request(path) {
      calls++; await delay(5);
      if (path.includes('metrics.k8s.io')) { if (failMetrics) throw new Error('Forbidden'); return rawMetrics(); }
      if (path.includes('horizontalpodautoscalers')) return rawHpa();
      if (path.includes('deployments')) return { metadata: meta(), status: { replicas: 2, readyReplicas: 2, availableReplicas: 2 } };
      assert.ok(path.includes('/namespaces/courier-test/pods?labelSelector=')); return { items: [rawPod()] };
    }, close() { closed = true; },
  };
  const provider = new KubernetesProvider(config, transport, () => clock);
  const [a, b] = await Promise.all([provider.read(), provider.read()]); assert.equal(calls, 4); assert.deepEqual(a, b);
  clock = 2500; const cached = await provider.read(); assert.equal(calls, 4); assert.equal(cached.kubernetes.cacheAgeMs, 2500);
  clock = 5001; failMetrics = true; const degraded = await provider.read();
  assert.equal(calls, 8); assert.equal(degraded.metrics.status, 'stale');
  assert.equal(degraded.samples[0]!.sample.timestamp, a.samples[0]!.sample.timestamp);
  assert.equal(degraded.metrics.observedAt, a.metrics.observedAt); assert.equal(degraded.metrics.cacheAgeMs, 5001);
  clock = 10002; failMetrics = false; assert.equal((await provider.read()).metrics.status, 'ok');
  provider.close(); assert.equal(closed, true); await assert.rejects(provider.read()); assert.equal(calls, 12);
});

test('consumed absolute budget never acquires; abort destroys active pg client and releases late acquisition without SQL', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://probe@127.0.0.1:1/courier_admin_test', connectionTimeoutMillis: 20 });
  let acquired = 0, destroyed = 0, statements = 0;
  let finishAcquire: ((client: PoolClient) => void) | undefined;
  const client = { release(discard: boolean) { if (discard) destroyed++; }, query() { statements++; return Promise.resolve({ rows: [] }); } } as unknown as PoolClient;
  const observed = new Proxy(pool, { get(target, key, receiver) {
    if (key === 'connect') return () => { acquired++; return new Promise<PoolClient>((resolve) => { finishAcquire = resolve; }); };
    return Reflect.get(target, key, receiver);
  } });
  try {
    for (const invalid of [performance.now() - 1, Infinity, NaN]) {
      await assert.rejects(adminRead(observed, invalid, new AbortController().signal, async () => undefined));
    }
    assert.equal(acquired, 0);
    const controller = new AbortController(); const pending = adminRead(observed, performance.now() + 8000, controller.signal, async (query) => query('SELECT 1'));
    controller.abort(); await assert.rejects(pending); assert.ok(finishAcquire); finishAcquire(client); await delay(0);
    assert.equal(destroyed, 1); assert.equal(statements, 0);
  } finally { await pool.end(); }
});

test('abort physically discards an active SQL connection and the operation cannot issue another query', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://probe@127.0.0.1:1/courier_admin_test' });
  let rejectQuery: ((error: Error) => void) | undefined;
  let statements = 0, discarded = 0;
  const client = { query() { statements++; return new Promise((_resolve, reject) => { rejectQuery = reject; }); },
    release(destroy: boolean) { if (destroy) { discarded++; rejectQuery?.(new Error('socket destroyed')); } } } as unknown as PoolClient;
  const observed = new Proxy(pool, { get(target, key, receiver) {
    if (key === 'connect') return async () => client;
    return Reflect.get(target, key, receiver);
  } });
  try {
    const controller = new AbortController();
    const pending = adminRead(observed, performance.now() + 8000, controller.signal, async (query) => {
      await query('SELECT pg_sleep(60)'); await query('SELECT unexpected_later_query');
    });
    await delay(0); assert.equal(statements, 1); controller.abort(); await assert.rejects(pending);
    assert.equal(discarded, 1); assert.equal(statements, 1);
  } finally { await pool.end(); }
});

test('role rejection precedes even a warmed provider cache and never reads general tables', async () => {
  const pool = new pg.Pool({ connectionString: 'postgresql://probe@127.0.0.1:1/courier_admin_test' });
  let authQueries = 0, providerReads = 0;
  const client = { release() {}, query(options: { text: string }) {
    assert.ok(options.text.includes('FROM sessions'), 'An unauthorized call must never read global monitoring tables.'); authQueries++;
    return Promise.resolve({ rows: [{ id: randomUUID(), username: 'normal_user', role: 'user', created_at: new Date() }] });
  } } as unknown as PoolClient;
  const observed = new Proxy(pool, { get(target, key, receiver) {
    if (key === 'connect') return async () => client;
    return Reflect.get(target, key, receiver);
  } });
  const provider = new KubernetesProvider({ enabled: false, namespace: null, ownerId: null });
  await provider.read();
  const observedProvider = new Proxy(provider, { get(target, key) {
    if (key === 'read') return () => { providerReads++; return target.read(); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = new AdminService(observed, { enabled: false, namespace: null, ownerId: null }, observedProvider);
  const app = express(); app.use('/api/admin', createAdminRouter(observed, service));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const path of ['overview', 'jobs']) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/admin/${path}`)).status, 401);
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/admin/${path}?role=admin`, {
        headers: { Cookie: `courier_session=${'a'.repeat(43)}`, 'X-Role': 'admin' },
      });
      assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(authQueries, 2); assert.equal(providerReads, 0);
  } finally { service.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await pool.end(); }
});

test('transport physically destroys timed-out/oversized sockets and clears its active handles', async () => {
  let closed = 0;
  const server = http.createServer((request, response) => {
    request.socket.once('close', () => closed++);
    if (request.url === '/large') { response.writeHead(200); response.end(Buffer.alloc(2 * 1024 * 1024 + 1, 97)); }
    else if (request.url === '/forbidden') { response.writeHead(403); response.end('{"sensitive":"must not return"}'); }
    else { response.writeHead(200); response.write('{'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const factory = ((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    assert.equal(options.agent, false, 'Completed monitoring reads must not retain global-agent idle sockets.');
    return http.request({ host: '127.0.0.1', port: address.port, path: options.path, method: 'GET', agent: false }, callback);
  }) as typeof https.request;
  const active = new Set<ClientRequest>();
  try {
    await assert.rejects(readKubernetesResponse('/slow', 'test', Buffer.alloc(0), active, factory, 40));
    assert.equal(active.size, 0); await delay(20); assert.ok(closed >= 1);
    await assert.rejects(readKubernetesResponse('/large', 'test', Buffer.alloc(0), active, factory)); assert.equal(active.size, 0);
    await assert.rejects(readKubernetesResponse('/forbidden', 'test', Buffer.alloc(0), active, factory), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes('sensitive'), false); return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
