import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
// The native deployment runner is intentionally usable without a Kubernetes
// connection, so its deletion guards and contract checks can be unit-tested.
// @ts-expect-error The executable is a native .mjs script, without emitted types.
import { assertOwnedDeployment, assertReadyReplicas, deploymentOrigin, requestDeployment, safeTrace, secureSessionCookie, verifiedCrossCancellation } from '../scripts/check-deployment.mjs';

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
