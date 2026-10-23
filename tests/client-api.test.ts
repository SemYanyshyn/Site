import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiRequestError } from '../src/client/api.js';
import type { FetchLike } from '../src/client/api.js';
import { InvalidResponseError } from '../src/client/response.js';
import { clientJob, clientLimits, clientSummary, squareInput } from './fixtures/client-jobs.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('client API uses relative endpoints, same-origin cookies, no-store and finite abort signals', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetcher: FetchLike = async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/limits')) return json(clientLimits);
    if (path.includes('?')) return json({ jobs: [clientSummary()], limit: 20, offset: 0 });
    const job = clientJob();
    return json(init.method === 'GET' ? { ...job, queue: {
      estimatedWaitMs: null, calculatedAt: job.createdAt, queuedAhead: 0, executorCount: 0, basis: 'unavailable',
    } } : job);
  };
  const api = new ApiClient(fetcher);
  await api.limits();
  await api.list({ limit: 20, offset: 0 });
  await api.detail(clientJob().id);
  await api.create(squareInput);
  await api.cancel(clientJob().id);
  assert.equal(calls.length, 5);
  for (const { path, init } of calls) {
    assert.match(path, /^\/api\/jobs(?:\/|\?|$)/u);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).has('Origin'), false);
    if (init.method === 'POST') assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
  }
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), {});
  assert.equal(JSON.parse(String(calls[3]?.init.body)).seed, 0);
});

test('client API validates unknown success bodies, resource identity and requested list page/filter', async () => {
  await assert.rejects(new ApiClient(async () => json({})).limits(), InvalidResponseError);
  await assert.rejects(new ApiClient(async () => json(clientJob(2))).detail(clientJob(1).id), InvalidResponseError);
  await assert.rejects(new ApiClient(async () => json(clientJob(2))).cancel(clientJob(1).id), InvalidResponseError);
  await assert.rejects(new ApiClient(async () => json({ jobs: [], limit: 20, offset: 0 })).list({ limit: 20, offset: 20 }), InvalidResponseError);
  await assert.rejects(new ApiClient(async () => json({ jobs: [clientSummary(1, 'completed')], limit: 50, offset: 0 })).list({ limit: 50, offset: 0, status: 'active' }), InvalidResponseError);
});

test('client API preserves distinct HTTP error status/code and safely handles malformed error responses', async () => {
  for (const [status, code] of [[400, 'INVALID_ROUTE_INPUT'], [413, 'BODY_TOO_LARGE'], [429, 'USER_ACTIVE_LIMIT'], [503, 'SYSTEM_OUTSTANDING_LIMIT'], [503, 'DATABASE_UNAVAILABLE'], [404, 'JOB_NOT_FOUND'], [401, 'UNAUTHORIZED']] as const) {
    const api = new ApiClient(async () => json({ code, message: 'Зрозуміле повідомлення.' }, status));
    await assert.rejects(api.limits(), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.uncertain, false);
      return true;
    });
  }
  const malformed = new ApiClient(async () => json({ code: {}, message: ['private unexpected data'] }, 503));
  await assert.rejects(malformed.limits(), (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.code, 'HTTP_ERROR');
    assert.doesNotMatch(error.message, /private/u);
    assert.match(error.message, /[А-Яа-яІіЇїЄє]/u);
    return true;
  });
});

test('client API never automatically retries an uncertain create after network or invalid-success failure', async () => {
  for (const fetcher of [async () => { throw new TypeError('network'); }, async () => json({})]) {
    let calls = 0;
    const api = new ApiClient(async () => { calls++; return fetcher(); });
    await assert.rejects(api.create(squareInput), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, 'ACCEPTANCE_UNKNOWN');
      assert.equal(error.uncertain, true);
      assert.match(error.message, /Оновіть історію/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('client API combines session cancellation with a real bounded request deadline', async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const pending = new ApiClient(async (_path, init) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
  }).limits(controller.signal);
  controller.abort();
  await assert.rejects(pending, ApiRequestError);
  assert.equal(signal?.aborted, true);
  let timedOut = false;
  const api = new ApiClient(async (_path, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { timedOut = true; reject(init.signal?.reason); }, { once: true });
  }), 5);
  await Promise.all([
    assert.rejects(api.limits(), ApiRequestError),
    new Promise<void>((resolve) => setTimeout(resolve, 20)),
  ]);
  assert.equal(timedOut, true);
});
