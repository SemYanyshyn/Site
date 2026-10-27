import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
// The native deployment runner is intentionally usable without a Kubernetes
// connection, so its deletion guards and contract checks can be unit-tested.
// @ts-expect-error The executable is a native .mjs script, without emitted types.
import { assertOwnedDeployment, assertReadyReplicas, deploymentOrigin, requestDeployment, safeTrace, secureSessionCookie, verifiedCrossCancellation } from '../scripts/check-deployment.mjs';
// @ts-expect-error The deployment CLI helper is a native .mjs executable.
import { collectDeploymentStatus, parseStatusArguments } from '../scripts/deployment-status.mjs';

const ownerId = '00000000-0000-4000-8000-000000000001';
const target = { namespace: 'courier-route-test-123abc', ownerId, context: 'kind-courier-route', kubeconfig: '/tmp/owned-kubeconfig' };
const owned = { metadata: { name: target.namespace, labels: { 'app.kubernetes.io/managed-by': 'courier-route-local',
  'courier-route.local/owner-id': ownerId } } };

test('deployment fault guard requires the exact owned random test namespace and identity', () => {
  assert.doesNotThrow(() => assertOwnedDeployment(target, owned));
  for (const changed of [{ ...target, namespace: 'courier-route' }, { ...target, ownerId: 'invalid' },
    { ...target, kubeconfig: 'relative' }, { ...target, context: '' }]) assert.throws(() => assertOwnedDeployment(changed, owned));
  assert.throws(() => assertOwnedDeployment(target, { metadata: { ...owned.metadata, labels: {} } }));
  assert.throws(() => assertOwnedDeployment(target, { metadata: { ...owned.metadata, name: 'another-namespace' } }));
});

test('deployment proof requires two distinct Ready pods with one exact image and actual Service endpoints', () => {
  const pods = [1, 2].map((index) => ({ metadata: { uid: String(index) }, spec: { containers: [{ name: 'app', image: 'courier:test-source' }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'app', ready: true, imageID: `sha256:${'a'.repeat(64)}` }] } }));
  const endpoints = [{ endpoints: [{ conditions: { ready: true }, addresses: ['10.1.0.1'], targetRef: { uid: '1' } },
    { conditions: { ready: true }, addresses: ['10.1.0.2'], targetRef: { uid: '2' } }] }];
  assert.doesNotThrow(() => assertReadyReplicas(pods, endpoints, 'courier:test-source'));
  assert.throws(() => assertReadyReplicas([pods[0]], endpoints, 'courier:test-source'));
  assert.throws(() => assertReadyReplicas(pods, endpoints, 'courier:other-source'));
  assert.throws(() => assertReadyReplicas(pods, [{ endpoints: [] }], 'courier:test-source'));
});

test('deployment cookie checks require every secure host-only session attribute', () => {
  const session = 'courier_session=opaque-fixture; Path=/; Secure; HttpOnly; SameSite=Lax';
  assert.equal(secureSessionCookie({ 'set-cookie': [session] }), 'courier_session=opaque-fixture');
  for (const attribute of ['; Secure', '; HttpOnly', '; SameSite=Lax', '; Path=/']) assert.throws(() => secureSessionCookie({ 'set-cookie': [session.replace(attribute, '')] }));
  assert.throws(() => secureSessionCookie({ 'set-cookie': [`${session}; Domain=localhost`] }));
});

test('deployment trace cannot serialize cookies, credentials, bodies or database addresses', () => {
  const output = safeTrace({ action: 'login', handler: ownerId, status: 200, cookie: 'private-fixture', password: 'private-fixture',
    body: { username: 'private-fixture' }, databaseUrl: 'private-fixture' });
  assert.deepEqual(output, { action: 'login', handler: ownerId, status: 200 });
  assert.doesNotMatch(JSON.stringify(output), /private/u);
});

test('deployment URL validation accepts only explicit local HTTP and HTTPS origins', () => {
  assert.equal(deploymentOrigin('https://localhost:8443', 'https:').hostname, 'localhost');
  assert.equal(deploymentOrigin('https://test.localhost:8443', 'https:').hostname, 'test.localhost');
  for (const value of ['https://example.com:8443', 'https://localhost', 'http://localhost:8443', 'https://user:secret@localhost:8443', 'https://localhost:8443/path']) {
    assert.throws(() => deploymentOrigin(value, 'https:'));
  }
});

test('a partial HTTP response reset rejects safely rather than causing an unhandled IncomingMessage error', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '128' });
    response.write('{"status":');
    setTimeout(() => response.destroy(), 10).unref();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(requestDeployment(`http://localhost:${address.port}`, undefined), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Deployment transport request failed.');
      return true;
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('cross-process cancellation proof excludes gateways, own handlers and completed races', () => {
  const victim = { id: '00000000-0000-4000-8000-000000000003', executedBy: ownerId };
  const response = { status: 202, handler: '00000000-0000-4000-8000-000000000002', value: { id: victim.id, status: 'running', cancelRequested: true } };
  const terminal = { value: { id: victim.id, status: 'cancelled' } };
  assert.equal(verifiedCrossCancellation(victim, response, terminal), true);
  for (const changed of [{ ...response, status: 503, handler: null }, { ...response, handler: ownerId },
    { ...response, status: 200 }, { ...response, value: { ...response.value, status: 'completed' } },
    { ...response, value: { ...response.value, cancelRequested: false } }]) assert.equal(verifiedCrossCancellation(victim, changed, terminal), false);
  assert.equal(verifiedCrossCancellation(victim, response, { value: { ...terminal.value, status: 'completed' } }), false);
});

const now = Date.parse('2026-10-26T10:00:00Z');
const namespace = 'courier-route';
const owner = '00000000-0000-4000-8000-000000000001';
type Row = Record<string, unknown>;
type ReadCall = { source: string; args: string[]; options: Row };

function metadata(name: string, component: string, ownNamespace = namespace) {
  return { name, namespace: ownNamespace, uid: `private-uid-${name}`, creationTimestamp: '2026-10-26T09:00:00Z',
    labels: { 'app.kubernetes.io/name': component === 'app' ? 'courier-route-app' : name,
      'app.kubernetes.io/component': component, 'app.kubernetes.io/managed-by': 'courier-route-local',
      'courier-route.local/owner-id': owner },
    annotations: { 'private-ip': '10.99.88.77', 'private-selector': 'do-not-render-selector' } };
}

function workload(kind: string, name: string, component: string, count: number) {
  return { apiVersion: 'apps/v1', kind, metadata: { ...metadata(name, component), generation: 1 },
    spec: { replicas: count }, status: { replicas: count, readyReplicas: count, availableReplicas: count, observedGeneration: 1 } };
}

function pod(name: string, component: string, container: string, options: {
  ready?: boolean; phase?: string; waiting?: string; terminating?: boolean; startedAt?: string;
} = {}) {
  const ready = options.ready ?? true;
  return { apiVersion: 'v1', kind: 'Pod',
    metadata: { ...metadata(name, component), ...(options.terminating ? { deletionTimestamp: '2026-10-26T09:59:58Z' } : {}) },
    spec: { containers: [{ name: container, image: 'private-image:sha256:do-not-render-image' }] },
    status: { phase: options.phase ?? 'Running', podIP: '10.99.88.77', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [{ name: container, ready, restartCount: 0,
        state: options.waiting ? { waiting: { reason: options.waiting, message: 'private-image:sha256:do-not-render-image' } }
          : { running: { startedAt: options.startedAt ?? '2026-10-26T09:00:00Z' } } }] } };
}

function hpa(cpu: number = 5) {
  return { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: metadata('app', 'autoscaling'),
    spec: { minReplicas: 2, maxReplicas: 4, metrics: [{ type: 'Resource', resource: { name: 'cpu',
      target: { type: 'Utilization', averageUtilization: 70 } } }] },
    status: { currentReplicas: 2, desiredReplicas: 2, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu',
      current: { averageUtilization: cpu } } }], conditions: [{ type: 'AbleToScale', status: 'True' },
      { type: 'ScalingActive', status: 'True' }, { type: 'ScalingLimited', status: 'False' }] } };
}

function metric(name: string, cpu: unknown = '125000000n', memory: unknown = '65536Ki', timestamp = '2026-10-26T09:59:50Z') {
  return { metadata: { name, namespace }, timestamp, window: '15s', containers: [
    { name: 'app', usage: { cpu, memory } }, { name: 'sidecar', usage: { cpu: '2000m', memory: '1Gi' } },
  ] };
}

function fixture() {
  return {
    workloads: { items: [workload('Deployment', 'app', 'app', 2), workload('Deployment', 'traefik', 'ingress', 1),
      workload('StatefulSet', 'postgres', 'database', 1), pod('app-a', 'app', 'app'), pod('app-b', 'app', 'app'),
      pod('traefik-a', 'ingress', 'traefik'), pod('postgres-0', 'database', 'postgres'), hpa()] as Row[] },
    metricsWorkloads: { items: [workload('Deployment', 'metrics-server', 'metrics', 1),
      pod('metrics-server-a', 'metrics', 'metrics-server')] as Row[] },
    apiService: { kind: 'APIService', metadata: { name: 'v1beta1.metrics.k8s.io' },
      status: { conditions: [{ type: 'Available', status: 'True' }] } } as Row | null,
    metrics: { items: [metric('app-a'), metric('app-b', '250m', '32Mi')] as Row[] },
  };
}

async function collect(data = fixture(), options: { failMetrics?: boolean; probe?: () => Promise<{ ok: boolean; message: string }> } = {}) {
  const calls: ReadCall[] = [];
  const kubectl = async (args: string[], commandOptions: Row) => {
    calls.push({ source: 'app', args, options: commandOptions });
    if (args.includes('--raw')) {
      if (options.failMetrics) throw new Error('Forbidden credentials-token-fixture https://10.99.88.77 private-image:sha256:hidden');
      return JSON.stringify(data.metrics);
    }
    if (args.includes('apiservice')) return data.apiService === null ? '' : JSON.stringify(data.apiService);
    return JSON.stringify(data.workloads);
  };
  const metricsKubectl = async (args: string[], commandOptions: Row) => {
    calls.push({ source: 'metrics', args, options: commandOptions });
    return JSON.stringify(data.metricsWorkloads);
  };
  const result = await collectDeploymentStatus({ kubectl, metricsKubectl, origin: 'https://localhost:8443',
    caPath: '/private/test-ca.crt', now, probe: options.probe ?? (async () => ({ ok: true, message: 'HTTPS /api/ready: HTTP 200' })) });
  return { ...result, calls } as { text: string; ok: boolean; calls: ReadCall[] };
}

test('deployment status accepts the compact default or one explicit verbose flag and rejects other arguments', () => {
  assert.deepEqual(parseStatusArguments([]), { verbose: false });
  assert.deepEqual(parseStatusArguments(['--verbose']), { verbose: true });
  for (const args of [['--verbose', '--verbose'], ['--wide'], ['--verbose=true'], ['--verbose', 'up'], ['stop']]) {
    assert.throws(() => parseStatusArguments(args));
  }
});

test('compact deployment status reads actual counts, HPA values and only app-container CPU/RAM', async () => {
  const result = await collect();
  assert.equal(result.ok, true);
  assert.match(result.text, /(?:Застосунок|застосунок)[^\n]*2\s*\/\s*2/u);
  assert.match(result.text, /Traefik[^\n]*1\s*\/\s*1/u);
  assert.match(result.text, /PostgreSQL[^\n]*1\s*\/\s*1/u);
  assert.match(result.text, /HPA[^\n]*2[^\n]*4/u);
  assert.match(result.text, /5\s*%/u);
  assert.match(result.text, /70\s*%/u);
  assert.match(result.text, /app-a[^\n]*125(?:[.,]0+)?\s*m(?:CPU)?[^\n]*64(?:[.,]0+)?\s*MiB/u);
  assert.match(result.text, /app-b[^\n]*250(?:[.,]0+)?\s*m(?:CPU)?[^\n]*32(?:[.,]0+)?\s*MiB/u);
  assert.match(result.text, /https:\/\/localhost:8443\/?/u);
  assert.match(result.text, /200/u);
  assert.doesNotMatch(result.text, /private-uid|10\.99\.88\.77|do-not-render|sha256|sidecar|2000|1024\s*MiB/u);
  assert.equal(result.calls.length, 4);
  assert.ok(result.calls.every(({ args, options }) => args[0] === 'get' && options.timeoutMs === 5000));
  assert.equal(result.calls.filter(({ source }) => source === 'metrics').length, 1);
});

test('actual zero CPU and RAM remain real measurements instead of missing-data fallbacks', async () => {
  const data = fixture();
  data.workloads.items = data.workloads.items.filter((entry) => entry.kind !== 'HorizontalPodAutoscaler');
  data.workloads.items.push(hpa(0));
  data.metrics.items = [metric('app-a', '0', '0'), metric('app-b', '0m', '0Ki')];
  const result = await collect(data);
  assert.equal(result.ok, true);
  assert.match(result.text, /CPU[^\n]*0\s*%/u);
  assert.match(result.text, /app-a[^\n]*0(?:[.,]0+)?\s*m(?:CPU)?[^\n]*0(?:[.,]0+)?\s*MiB/u);
  assert.doesNotMatch(result.text, /NaN|Infinity/u);
});

test('unavailable metrics do not hide component readiness or leak raw command diagnostics', async () => {
  const result = await collect(fixture(), { failMetrics: true });
  assert.equal(result.ok, false);
  assert.match(result.text, /(?:Застосунок|застосунок)[^\n]*2\s*\/\s*2/u);
  assert.match(result.text, /PostgreSQL[^\n]*1\s*\/\s*1/u);
  assert.match(result.text, /(?:недоступ|невідом|помил|не вдалося)/iu);
  assert.match(result.text, /app-a/u);
  assert.match(result.text, /app-b/u);
  assert.doesNotMatch(result.text, /credentials-token-fixture|10\.99\.88\.77|private-image|sha256|NaN/u);
});

test('missing workloads, HPA and Metrics API are explicit and never reported as healthy', async () => {
  const data = fixture();
  data.workloads.items = [];
  data.metricsWorkloads.items = [];
  data.apiService = null;
  data.metrics.items = [];
  const result = await collect(data, { probe: async () => ({ ok: false, message: 'Демо: HTTPS перевірка недоступна.' }) });
  assert.equal(result.ok, false);
  for (const label of ['Traefik', 'PostgreSQL', 'HPA', 'Metrics']) assert.ok(result.text.includes(label));
  assert.match(result.text, /(?:відсут|не знайден|немає|невідом|недоступ)/iu);
  assert.match(result.text, /https:\/\/localhost:8443/u);
  assert.doesNotMatch(result.text, /усе працює|все працює/iu);
});

test('pending, crashed and terminating app pods are visible despite optimistic Deployment counts', async () => {
  const data = fixture();
  data.workloads.items = data.workloads.items.filter((entry) => entry.kind !== 'Pod' || (entry.metadata as Row).labels === undefined
    || ((entry.metadata as Row).labels as Row)['app.kubernetes.io/component'] !== 'app');
  data.workloads.items.push(pod('app-a', 'app', 'app'), pod('app-crashed', 'app', 'app', { ready: false, waiting: 'CrashLoopBackOff' }),
    pod('app-pending', 'app', 'app', { ready: false, phase: 'Pending' }), pod('app-terminating', 'app', 'app', { terminating: true }));
  const result = await collect(data);
  assert.equal(result.ok, false);
  for (const name of ['app-a', 'app-crashed', 'app-pending', 'app-terminating']) assert.ok(result.text.includes(name));
  assert.match(result.text, /CrashLoopBackOff/u);
  assert.match(result.text, /(?:Pending|очіку)/u);
  assert.match(result.text, /(?:заверш|видал|terminat)/iu);
  assert.doesNotMatch(result.text, /private-image|sha256|10\.99\.88\.77/u);
});

test('stale or pre-restart metrics cannot masquerade as current CPU and RAM', async () => {
  const data = fixture();
  data.workloads.items = data.workloads.items.filter((entry) => entry.kind !== 'Pod' || (entry.metadata as Row).name !== 'app-b');
  data.workloads.items.push(pod('app-b', 'app', 'app', { startedAt: '2026-10-26T09:59:55Z' }));
  data.metrics.items = [metric('app-a', '125m', '64Mi', '2026-10-26T09:59:00Z'), metric('app-b', '250m', '32Mi')];
  const result = await collect(data);
  assert.equal(result.ok, false);
  assert.match(result.text, /(?:застар|поперед|перезапуск|невідом|недоступ)/iu);
  assert.doesNotMatch(result.text, /125\s*m(?:CPU)?|250\s*m(?:CPU)?/u);
  assert.doesNotMatch(result.text, /NaN|Infinity/u);
});

test('missing or malformed usage is reported explicitly without fabricated zero or NaN', async () => {
  const data = fixture();
  data.metrics.items = [metric('app-a', 'not-a-quantity', '64Mi'), metric('app-b', '250m', null)];
  const result = await collect(data);
  assert.equal(result.ok, false);
  assert.match(result.text, /(?:невідом|недоступ|некорект|немає|відсут|помил)/iu);
  assert.doesNotMatch(result.text, /NaN|Infinity|not-a-quantity/u);
});

test('the configured demo URL never overrides a failed real readiness probe', async () => {
  const result = await collect(fixture(), { probe: async () => ({ ok: false, message: 'Демо: HTTP 503 — не готове.' }) });
  assert.equal(result.ok, false);
  assert.match(result.text, /https:\/\/localhost:8443/u);
  assert.match(result.text, /503/u);
  assert.match(result.text, /(?:не готов|недоступ|помил)/iu);
});

test('an extra crashed Metrics Server pod remains visible when its desired replica is already ready', async () => {
  const data = fixture();
  data.metricsWorkloads.items.push(pod('metrics-server-crashed', 'metrics', 'metrics-server', {
    ready: false, waiting: 'CrashLoopBackOff',
  }));
  const result = await collect(data);
  assert.equal(result.ok, false);
  assert.match(result.text, /Metrics Server[^\n]*CrashLoopBackOff/u);
  assert.doesNotMatch(result.text, /private-image|sha256/u);
});

test('a metrics window crossing a container restart or a missing window cannot be called current', async () => {
  const data = fixture();
  data.workloads.items = data.workloads.items.filter((entry) => entry.kind !== 'Pod' || (entry.metadata as Row).name !== 'app-a');
  data.workloads.items.push(pod('app-a', 'app', 'app', { startedAt: '2026-10-26T09:59:45Z' }));
  const missingWindow: Row = { ...metric('app-b') };
  delete missingWindow.window;
  data.metrics.items = [metric('app-a'), missingWindow];
  const result = await collect(data);
  assert.equal(result.ok, false);
  assert.match(result.text, /(?:застар|непридат|недоступ|некорект)/iu);
  assert.doesNotMatch(result.text, /125\s*m(?:CPU)?|250\s*m(?:CPU)?|NaN/u);
});

test('inactive HPA cannot display its old CPU utilization as a current healthy measurement', async () => {
  const data = fixture();
  data.workloads.items = data.workloads.items.filter((entry) => entry.kind !== 'HorizontalPodAutoscaler');
  data.workloads.items.push({ ...hpa(5), status: { ...hpa(5).status,
    conditions: [{ type: 'ScalingActive', status: 'False', reason: 'FailedGetResourceMetric' }] } });
  const result = await collect(data);
  assert.equal(result.ok, false);
  assert.match(result.text, /HPA[^\n]*CPU невідомо[^\n]*FailedGetResourceMetric/u);
  assert.doesNotMatch(result.text, /HPA[^\n]*CPU 5%/u);
});
