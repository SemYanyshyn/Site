import assert from 'node:assert/strict';
import { normalizeApiBase } from '../src/shared/public-api.ts';

try {
  const api = normalizeApiBase(process.env.VITE_API_BASE_URL);
  assert.ok(api, 'Set the public HTTPS backend origin in the VITE_API_BASE_URL repository variable.');
  assert.equal(process.env.PAGES_DEPLOYMENT_READY, 'true', 'Enable PAGES_DEPLOYMENT_READY only after configuring the public backend and domains.');
  const page = new URL(process.env.PAGES_URL ?? '');
  assert.equal(page.protocol, 'https:');
  const origin = page.origin;
  function cors(response) {
    assert.equal(response.headers.get('access-control-allow-origin'), origin, 'Backend must allow the exact Pages origin.');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true', 'Backend must allow credentialed requests.');
  }
  for (const [path, expected] of [['/api/health', 'ok'], ['/api/ready', 'ready']]) {
    const response = await fetch(`${api}${path}`, { headers: { Origin: origin }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
    cors(response); assert.equal(response.status, 200, 'Backend health/readiness failed.');
    assert.equal((await response.json()).status, expected, 'Unexpected backend response.');
  }
  const preflight = await fetch(`${api}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  cors(preflight); assert.equal(preflight.status, 204, 'Backend must accept the login preflight without a session.');
  assert.ok((preflight.headers.get('access-control-allow-methods') ?? '').split(',').some((value) => value.trim() === 'POST'));
  assert.ok((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').some((value) => value.trim() === 'content-type'));
  const me = await fetch(`${api}/api/auth/me`, { headers: { Origin: origin }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
  cors(me); assert.equal(me.status, 401, 'Anonymous session check must deny access.');
  console.log('Public HTTPS backend readiness, credentialed CORS and anonymous auth verified.');
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0]
    : 'Pages configuration/preflight failed. Check the public HTTPS API, TLS and exact allowed origin.');
  process.exitCode = 1;
}
