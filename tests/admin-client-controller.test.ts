import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminController } from '../src/client/admin-controller.js';
import { ApiRequestError } from '../src/client/api.js';
import type { AdminJobsResponse, AdminOverview } from '../src/shared/admin.js';
import { ControlledAdminApi, adminJobs, adminOverview, adminUser } from './fixtures/admin-client.js';
import { ControlledClock } from './fixtures/client-controller.js';
import { deferred, settle } from './fixtures/client-jobs.js';

function setup() {
  const api = new ControlledAdminApi(), clock = new ControlledClock();
  let unauthorized = 0, forbidden = 0;
  const controller = new AdminController(api, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onUnauthorized: () => { unauthorized++; }, onForbidden: () => { forbidden++; } });
  return { api, clock, controller, unauthorized: () => unauthorized, forbidden: () => forbidden };
}
test('regular users and a closed administrator panel issue no monitoring reads', async () => {
  const { controller, api, clock } = setup();
  controller.setUser({ ...adminUser, role: 'user' });
  await controller.open(); await controller.refresh();
  assert.equal(api.calls.length, 0);
  controller.setUser(adminUser);
  await controller.refresh();
  assert.equal(api.calls.length, 0);
  await controller.open();
  assert.equal(api.calls.length, 2);
  assert.equal(clock.size, 1);
  assert.equal(clock.delays.at(-1), 5_000);
  controller.endSession();
});
test('manual refreshes share one cycle and coalesce into one further read per kind', async () => {
  const { controller, api, clock } = setup();
  controller.setUser(adminUser); await controller.open();
  const overview = deferred<AdminOverview>(), jobs = deferred<AdminJobsResponse>();
  api.onOverview = () => overview.promise; api.onJobs = () => jobs.promise;
  const first = controller.refresh(), second = controller.refresh(), third = controller.refresh();
  assert.equal(first, second); assert.equal(second, third);
  assert.equal(api.calls.filter((call) => call.kind === 'overview').length, 2);
  assert.equal(api.calls.filter((call) => call.kind === 'jobs').length, 2);
  assert.equal(clock.size, 0);
  api.onOverview = async () => adminOverview(); api.onJobs = async (query) => adminJobs(query);
  overview.resolve(adminOverview()); jobs.resolve(adminJobs()); await first;
  assert.equal(api.calls.filter((call) => call.kind === 'overview').length, 3);
  assert.equal(api.calls.filter((call) => call.kind === 'jobs').length, 3);
  assert.equal(clock.size, 1);
  controller.endSession();
});
test('filter and page generations reject late successes and serialize the replacement page', async () => {
  const { controller, api } = setup();
  controller.setUser(adminUser); await controller.open();
  const old = deferred<AdminJobsResponse>(); api.onJobs = () => old.promise;
  const reading = controller.refresh(), signal = api.calls.at(-1)?.signal;
  const changing = controller.setStatus('queued');
  assert.equal(signal?.aborted, true);
  assert.equal(controller.state.jobs, null);
  assert.equal(api.calls.filter((call) => call.kind === 'jobs').length, 2, 'replacement waits until old request has settled');
  api.onJobs = async (query) => adminJobs(query); old.resolve(adminJobs());
  await Promise.all([reading, changing]);
  assert.equal(controller.state.query.status, 'queued');
  assert.equal((controller.state.jobs as AdminJobsResponse | null)?.jobs[0]?.status, 'queued');
  const previousPage = deferred<AdminJobsResponse>(); api.onJobs = () => previousPage.promise;
  const previousRead = controller.refresh(), previousSignal = api.calls.at(-1)?.signal;
  const paging = controller.goToPage(20);
  assert.equal(previousSignal?.aborted, true);
  api.onJobs = async (query) => adminJobs(query); previousPage.resolve(adminJobs());
  await Promise.all([previousRead, paging]);
  assert.equal((controller.state.jobs as AdminJobsResponse | null)?.offset, 20); assert.equal(controller.state.query.status, 'queued');
  controller.endSession();
});
test('logout fences both late payloads across a subsequent administrator session', async () => {
  const { controller, api, clock } = setup(); controller.setUser(adminUser);
  const overview = deferred<AdminOverview>(), jobs = deferred<AdminJobsResponse>();
  api.onOverview = () => overview.promise; api.onJobs = () => jobs.promise;
  const old = controller.open(), signals = api.calls.map((call) => call.signal);
  controller.endSession();
  assert.ok(signals.every((signal) => signal?.aborted)); assert.equal(clock.size, 0);
  controller.setUser(adminUser);
  api.onOverview = async () => ({ ...adminOverview(), servers: [] }); api.onJobs = async (query) => ({ ...adminJobs(query), jobs: [] });
  const current = controller.open();
  overview.resolve(adminOverview()); jobs.resolve(adminJobs()); await Promise.all([old, current]);
  assert.deepEqual(controller.state.overview?.servers, []); assert.deepEqual(controller.state.jobs?.jobs, []);
  controller.endSession();
});
test('closing the panel clears private snapshots and blocks aborted successes from restoring them', async () => {
  const { controller, api, clock } = setup(); controller.setUser(adminUser); await controller.open();
  const old = deferred<AdminOverview>(); api.onOverview = () => old.promise;
  const reading = controller.refresh(), signal = api.calls.at(-2)?.signal;
  controller.close(); old.resolve(adminOverview()); await reading;
  assert.equal(signal?.aborted, true); assert.equal(controller.state.allowed, true); assert.equal(controller.state.open, false);
  assert.equal(controller.state.overview, null); assert.equal(controller.state.jobs, null); assert.equal(clock.size, 0);
  const calls = api.calls.length; await controller.refresh(); assert.equal(api.calls.length, calls);
});
test('hidden tabs stop timers and pending reads; visibility resumes one managed cycle', async () => {
  const { controller, api, clock } = setup(); controller.setUser(adminUser); await controller.open();
  const old = deferred<AdminOverview>(); api.onOverview = () => old.promise;
  const reading = controller.refresh(), signal = api.calls.at(-2)?.signal;
  controller.setVisible(false); assert.equal(signal?.aborted, true); assert.equal(clock.size, 0);
  old.resolve({ ...adminOverview(), servers: [] }); await reading;
  assert.equal(controller.state.overview?.servers.length, 1, 'hidden late result is ignored');
  const calls = api.calls.length; await controller.refresh(); assert.equal(api.calls.length, calls);
  api.onOverview = async () => adminOverview(); controller.setVisible(true); await settle();
  assert.equal(api.calls.length, calls + 2); assert.equal(clock.size, 1); controller.endSession();
});
test('human 401 and role 403 clear snapshots and reject a late successful sibling read', async () => {
  for (const status of [401, 403]) {
    const { controller, api, clock, unauthorized, forbidden } = setup(); controller.setUser(adminUser); await controller.open();
    const jobs = deferred<AdminJobsResponse>(); api.onJobs = () => jobs.promise;
    api.onOverview = async () => { throw new ApiRequestError(status, 'DENIED', 'Немає доступу'); };
    const reading = controller.refresh(); await settle();
    assert.equal(controller.state.overview, null); assert.equal(controller.state.jobs, null); assert.equal(controller.state.allowed, false);
    jobs.resolve(adminJobs()); await reading;
    assert.equal(controller.state.jobs, null); assert.equal(clock.size, 0);
    assert.equal(unauthorized(), status === 401 ? 1 : 0); assert.equal(forbidden(), status === 403 ? 1 : 0);
  }
});
test('source partial and 503 preserve last timestamps without revoking the human role', async () => {
  const { controller, api, unauthorized, forbidden } = setup(); controller.setUser(adminUser); await controller.open();
  const partial = adminOverview(); partial.infrastructure.metrics.status = 'stale'; partial.infrastructure.metrics.message = 'Метрики тимчасово недоступні';
  const metric = partial.servers[0]?.metric; assert.ok(metric); metric.stale = true;
  api.onOverview = async () => partial; await controller.refresh();
  assert.equal(controller.state.overview?.servers[0]?.metric?.timestamp, metric.timestamp);
  api.onOverview = async () => { throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'База тимчасово недоступна'); };
  await controller.refresh();
  assert.equal(controller.state.overview, partial); assert.match(controller.state.overviewError, /База/u);
  assert.equal(controller.state.allowed, true); assert.equal(unauthorized(), 0); assert.equal(forbidden(), 0); controller.endSession();
});
test('invalid page or filter input never triggers a read or changes the current selection', async () => {
  const { controller, api } = setup(); controller.setUser(adminUser); await controller.open(); const calls = api.calls.length;
  for (const offset of [-20, 1, 20.5, Number.NaN, 1_000_020]) await controller.goToPage(offset);
  await controller.setStatus('secret' as 'running');
  assert.equal(api.calls.length, calls); assert.equal(controller.state.query.offset, 0); controller.endSession();
});
