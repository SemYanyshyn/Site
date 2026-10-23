import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { startServer } from '../src/server/index.js';
import type { AppConfig } from '../src/server/config.js';

function configuration(host: AppConfig['host']): AppConfig {
  return {
    host, port: 0,
    databaseUrl: 'postgresql://courier_bind_probe@127.0.0.1:1/courier_bind_probe',
    appOrigins: new Set(['http://127.0.0.1']), sessionTtlSeconds: 3600, cookieSecure: false,
  };
}

test('local HTTP listens on configured loopback and never echoes spoofed backend or proxy headers', async () => {
  const runtime = startServer(configuration('127.0.0.1'));
  try {
    if (!runtime.server.listening) await once(runtime.server, 'listening');
    const address = runtime.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
      headers: { 'X-Instance-Id': 'client-supplied-value', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'attacker.invalid' },
      signal: AbortSignal.timeout(3_000),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-instance-id'), runtime.instanceId);
    assert.match(runtime.instanceId, /^[0-9a-f-]{36}$/u);
    assert.ok(typeof body === 'object' && body !== null && 'instanceId' in body);
    assert.equal(body.instanceId, runtime.instanceId);
  } finally { await runtime.shutdown('BIND_TEST'); }
});

test('explicit container bind listens on all IPv4 interfaces and serves its published loopback connection', async () => {
  const runtime = startServer(configuration('0.0.0.0'));
  try {
    if (!runtime.server.listening) await once(runtime.server, 'listening');
    const address = runtime.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '0.0.0.0');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-instance-id'), runtime.instanceId);
  } finally { await runtime.shutdown('BIND_TEST'); }
});

test('every API outcome identifies its actual handler, including auth, jobs, JSON errors and unavailable readiness', async () => {
  const runtime = startServer(configuration('127.0.0.1'));
  try {
    if (!runtime.server.listening) await once(runtime.server, 'listening');
    const address = runtime.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const cases: Array<{ path: string; status: number; init?: RequestInit }> = [
      { path: '/api/health', status: 200 },
      { path: '/api/ready', status: 503 },
      { path: '/api/auth/me', status: 503 },
      { path: '/api/jobs', status: 401 },
      { path: '/api/does-not-exist', status: 404 },
      { path: '/api/auth/login', status: 400, init: {
        method: 'POST', headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' }, body: '{',
      } },
      { path: '/api/jobs', status: 403, init: {
        method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}',
      } },
    ];
    for (const scenario of cases) {
      const response = await fetch(`${origin}${scenario.path}`, { ...scenario.init, signal: AbortSignal.timeout(3_000) });
      assert.equal(response.status, scenario.status, scenario.path);
      assert.equal(response.headers.get('x-instance-id'), runtime.instanceId, scenario.path);
      await response.arrayBuffer();
    }
  } finally { await runtime.shutdown('BIND_TEST'); }
});
