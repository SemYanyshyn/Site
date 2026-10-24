import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiClient } from '../src/client/admin-api.js';
import { ApiRequestError } from '../src/client/api.js';
import { parseAdminJobs, parseAdminOverview } from '../src/client/admin-response.js';
import { InvalidResponseError } from '../src/client/response.js';
import { adminId, adminJob, adminJobs, adminOverview, adminTime } from './fixtures/admin-client.js';

test('monitoring projection retains zero, unknown and original stale sample timestamps distinctly', () => {
  const overview = adminOverview(); overview.summary.cpuCores = 0; overview.summary.memoryBytes = null;
  overview.infrastructure.metrics.status = 'stale'; overview.infrastructure.metrics.cacheAgeMs = 12_000;
  const sample = overview.servers[0]?.metric; assert.ok(sample); sample.stale = true; sample.cpuCores = 0;
  const parsed = parseAdminOverview(overview);
  assert.equal(parsed.summary.cpuCores, 0); assert.equal(parsed.summary.memoryBytes, null);
  assert.equal(parsed.servers[0]?.metric?.timestamp, adminTime); assert.equal(parsed.servers[0]?.metric?.cpuCores, 0);
  overview.servers[0]!.metric = null;
  assert.equal(parseAdminOverview(overview).servers[0]?.metric, null);
});
test('client rebuilds whitelisted overview and jobs instead of retaining unexpected private payloads', () => {
  const source = adminOverview(), raw = { ...source, token: 'unexpected', infrastructure: { ...source.infrastructure, secret: 'unexpected' },
    servers: source.servers.map((server) => ({ ...server, env: { PRIVATE: 'unexpected' }, executor: { ...server.executor, claimToken: 'unexpected' } })) };
  const parsed = JSON.stringify(parseAdminOverview(raw)); assert.doesNotMatch(parsed, /unexpected|claimToken|PRIVATE/u);
  const jobs = adminJobs();
  const list = parseAdminJobs({ ...jobs, input: { secret: true }, jobs: jobs.jobs.map((job) => ({ ...job, input: { points: [] }, result: {}, claimToken: 'unexpected', owner: { ...job.owner, passwordHash: 'unexpected' } })) });
  assert.doesNotMatch(JSON.stringify(list), /input|result|claimToken|passwordHash|unexpected/u);
});
test('malformed quantities, impossible progress, duplicate pods and excessive lists are rejected', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '0.25']) {
    const overview = adminOverview(); Object.assign(overview.servers[0]!.metric!, { cpuCores: bad });
    assert.throws(() => parseAdminOverview(overview), InvalidResponseError);
  }
  const duplicate = adminOverview(); duplicate.servers.push(structuredClone(duplicate.servers[0]!)); assert.throws(() => parseAdminOverview(duplicate), InvalidResponseError);
  const window = adminOverview(); window.servers[0]!.metric!.window = 'Infinitys'; assert.throws(() => parseAdminOverview(window), InvalidResponseError);
  const list = adminJobs(); list.jobs = Array.from({ length: 51 }, (_, n) => adminJob(n + 10)); assert.throws(() => parseAdminJobs(list), InvalidResponseError);
  const progress = adminJobs(); progress.jobs[0]!.progress.percent = 100; assert.throws(() => parseAdminJobs(progress), InvalidResponseError);
});
test('pod/process identity mismatches and samples from before container restart are rejected', () => {
  const mismatch = adminOverview(); mismatch.servers[0]!.executor!.podName = 'another-pod';
  assert.throws(() => parseAdminOverview(mismatch), InvalidResponseError);
  const restarted = adminOverview(); restarted.servers[0]!.containerStartedAt = '2026-10-25T01:02:04.000Z';
  assert.throws(() => parseAdminOverview(restarted), InvalidResponseError);
  const unregistered = adminOverview(); unregistered.servers[0]!.executor = null; unregistered.servers[0]!.mapping = 'unregistered';
  assert.equal(parseAdminOverview(unregistered).servers[0]?.executor, null);
});
test('legitimate fractional bytes, duration units and long stale ages preserve provider values', () => {
  const overview = adminOverview(); overview.servers[0]!.metric!.memoryBytes = 102.4; overview.infrastructure.metrics.cacheAgeMs = 172_800_000;
  for (const window of ['15000000000ns', '15000000us', '15000000µs', '15000ms', '15s', '0.25m', '0.004h']) {
    overview.servers[0]!.metric!.window = window; assert.equal(parseAdminOverview(overview).servers[0]?.metric?.window, window);
  }
  assert.equal(parseAdminOverview(overview).servers[0]?.metric?.memoryBytes, 102.4);
});
test('full active registry plus the explicitly bounded recent unavailable window remains readable', () => {
  const overview = adminOverview(), base = overview.servers[0]!.executor!;
  overview.unmatchedExecutors = Array.from({ length: 10_100 }, (_, n) => ({ ...base, instanceId: adminId(n + 100), podUid: null, podName: null, podNamespace: null,
    fresh: n < 10_000, acceptingClaims: n < 10_000, reason: 'outside-kubernetes' as const }));
  assert.equal(parseAdminOverview(overview).unmatchedExecutors.length, 10_100);
  overview.unmatchedExecutors.push({ ...overview.unmatchedExecutors[0]!, instanceId: adminId(99_999) });
  assert.throws(() => parseAdminOverview(overview), InvalidResponseError);
});
test('admin API uses relative bounded authenticated GET and validates the requested page and filter', async () => {
  let path = '', request: RequestInit = {};
  const api = new AdminApiClient(async (url, init) => { path = url; request = init; return Response.json(adminJobs({ limit: 20, offset: 20, status: 'queued' })); });
  await api.jobs({ limit: 20, offset: 20, status: 'queued' });
  assert.equal(path, '/api/admin/jobs?limit=20&offset=20&status=queued'); assert.equal(request.method, 'GET');
  assert.equal(request.credentials, 'same-origin'); assert.equal(request.cache, 'no-store'); assert.ok(request.signal);
  const invalid = new AdminApiClient(async () => Response.json(adminJobs()));
  await assert.rejects(invalid.jobs({ limit: 20, offset: 20 }), InvalidResponseError);
});
test('provider failures in partial 200 remain separate from human role403 and session401', async () => {
  const partial = adminOverview(); partial.infrastructure.metrics.status = 'partial'; partial.infrastructure.metrics.message = 'Джерело не дозволяє читання';
  const api = new AdminApiClient(async () => Response.json(partial));
  assert.equal((await api.overview()).infrastructure.metrics.status, 'partial');
  for (const status of [401, 403, 503]) {
    const denied = new AdminApiClient(async () => Response.json({ token: 'do-not-repeat', message: 'do-not-repeat' }, { status }));
    await assert.rejects(denied.overview(), (error: unknown) => error instanceof ApiRequestError && error.status === status && !error.message.includes('do-not-repeat'));
  }
});
test('admin API abort physically reaches fetch and never retries an aborted read', async () => {
  let calls = 0, aborted = false;
  const api = new AdminApiClient(async (_url, init) => { calls++; return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }); });
  const controller = new AbortController(), pending = api.overview(controller.signal); controller.abort();
  await assert.rejects(pending, ApiRequestError); assert.equal(calls, 1); assert.equal(aborted, true);
});
