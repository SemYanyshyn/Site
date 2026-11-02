import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiFetch } from '../src/client/api-endpoint.js';
import { normalizeApiBase } from '../src/shared/public-api.js';
import { ApiClient, ApiRequestError } from '../src/client/api.js';
import { AdminApiClient } from '../src/client/admin-api.js';
import { clientLimits, squareInput } from './fixtures/client-jobs.js';
import { adminOverview } from './fixtures/admin-client.js';

test('public API config accepts only an HTTPS origin and never echoes invalid secrets', () => {
  assert.equal(normalizeApiBase(undefined), '');
  assert.equal(normalizeApiBase('https://api.example.test/'), 'https://api.example.test');
  for (const value of ['http://api.example.test', 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://demo.local', 'https://user:private-value@api.example.test', 'https://api.example.test/api',
    'https://api.example.test?token=private-value', 'https://api.example.test/#private-value', ' private-value']) {
    assert.throws(() => normalizeApiBase(value), (error: unknown) => error instanceof Error
      && error.message.includes('VITE_API_BASE_URL') && !error.message.includes('private-value'));
  }
});

test('one transport covers auth, jobs, cancellation, history, admin and health without the Pages prefix', async () => {
  for (const base of ['', 'https://api.example.test/']) {
    const controller = new AbortController();
    const paths = ['/api/auth/register', '/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/jobs/limits',
      '/api/jobs?limit=20&offset=0', '/api/jobs/id', '/api/jobs/id/cancel', '/api/admin/overview',
      '/api/admin/jobs?status=active', '/api/health'];
    const transport = createApiFetch(base, async (url, init) => {
      assert.equal(url, `${base.replace(/\/$/u, '')}${paths.shift()}`);
      assert.equal(init.credentials, base ? 'include' : 'same-origin');
      assert.equal(init.signal, controller.signal);
      assert.equal(init.cache, 'no-store');
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
      assert.equal(init.body, '{}');
      return new Response(null, { status: 204 });
    });
    for (const path of [...paths]) await transport(path, { method: 'POST', signal: controller.signal,
      credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(paths.length, 0);
  }
});

test('transport rejects arbitrary destinations before forwarding credentials', () => {
  let called = false;
  const transport = createApiFetch('https://api.example.test', async () => { called = true; return new Response(); });
  for (const path of ['https://attacker.invalid/api/jobs', '//attacker.invalid/api/jobs', '/Site/api/jobs', '/api/../private', '/api/jobs#fragment']) {
    assert.throws(() => transport(path, {}));
  }
  assert.equal(called, false);
});

test('jobs/admin clients use configured addresses while retaining parsing and cancellation', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const transport = createApiFetch('https://api.example.test', async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'include'); assert.ok(init.signal);
    if (url.endsWith('/limits')) return Response.json(clientLimits);
    if (url.endsWith('/overview')) return Response.json(adminOverview());
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
  });
  await new ApiClient(transport).limits();
  await new AdminApiClient(transport).overview();
  const pending = new ApiClient(transport).create(squareInput, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ApiRequestError && error.uncertain);
  assert.deepEqual(calls, ['https://api.example.test/api/jobs/limits', 'https://api.example.test/api/admin/overview', 'https://api.example.test/api/jobs']);
});
