import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/client/api.js';
import { JobsController } from '../src/client/jobs-controller.js';
import type { JobDetails, JobLimitsResponse, JobListResponse } from '../src/shared/jobs.js';
import { ControlledClock, ControlledJobsApi } from './fixtures/client-controller.js';
import { clientJob, clientLimits, clientSummary, deferred, settle, squareInput } from './fixtures/client-jobs.js';

function setup() {
  const api = new ControlledJobsApi();
  const clock = new ControlledClock();
  let unauthorized = 0;
  const controller = new JobsController(api, {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onUnauthorized: () => { unauthorized++; },
  });
  return { api, clock, controller, unauthorized: () => unauthorized };
}

function serveRunning(api: ControlledJobsApi, id = 1): void {
  api.onList = async (query) => ({ jobs: [clientSummary(id, 'running')], limit: query.limit, offset: query.offset });
  api.onDetail = async () => clientJob(id, 'running');
}

test('session restoration reads limits, active and history then detail without issuing a create', async () => {
  const { api, clock, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  assert.equal(controller.state.authenticated, true);
  assert.equal(controller.state.detail?.id, clientJob().id);
  assert.equal(controller.state.limits?.maxActivePerUser, clientLimits.maxActivePerUser);
  assert.equal(api.calls.filter((call) => call.method === 'create' || call.method === 'cancel').length, 0);
  assert.equal(clock.size, 1);
  controller.endSession();
  assert.equal(clock.size, 0);
});

test('late detail cannot overwrite a more recent user selection even if fetch ignores abort', async () => {
  const { api, controller } = setup();
  await controller.startSession();
  const old = deferred<JobDetails>();
  api.onDetail = async (id) => id === clientJob(1).id ? old.promise : clientJob(2, 'completed');
  const first = controller.selectJob(clientJob(1).id);
  const oldSignal = api.calls.at(-1)?.signal;
  await controller.selectJob(clientJob(2).id);
  assert.equal(oldSignal?.aborted, true);
  old.resolve(clientJob(1, 'completed'));
  await first;
  assert.equal(controller.state.selectedId, clientJob(2).id);
  assert.equal(controller.state.detail?.id, clientJob(2).id);
  controller.endSession();
});

test('late limits and list responses from the previous session cannot restore private data', async () => {
  const { api, clock, controller } = setup();
  const limits = deferred<JobLimitsResponse>();
  const active = deferred<JobListResponse>();
  const history = deferred<JobListResponse>();
  api.onLimits = () => limits.promise;
  api.onList = (query) => query.status === 'active' ? active.promise : history.promise;
  const oldSession = controller.startSession();
  const oldSignals = api.calls.map((call) => call.signal);
  controller.endSession();
  assert.ok(oldSignals.every((signal) => signal?.aborted));
  api.onLimits = async () => ({ ...clientLimits, maxActivePerUser: 2 });
  api.onList = async (query) => ({ jobs: [], limit: query.limit, offset: query.offset });
  await controller.startSession();
  limits.resolve(clientLimits);
  active.resolve({ jobs: [clientSummary()], limit: 50, offset: 0 });
  history.resolve({ jobs: [clientSummary()], limit: 20, offset: 0 });
  await oldSession;
  assert.equal(controller.state.limits?.maxActivePerUser, 2);
  assert.deepEqual(controller.state.active, []);
  assert.deepEqual(controller.state.history, []);
  assert.equal(controller.state.detail, null);
  assert.equal(clock.size, 0);
  controller.endSession();
});

test('late detail, create and cancel completions cannot cross logout and the next login', async () => {
  for (const operation of ['detail', 'create', 'cancel'] as const) {
    const { api, controller } = setup();
    await controller.startSession();
    const old = deferred<JobDetails>();
    api.onDetail = () => old.promise;
    api.onCreate = () => old.promise;
    api.onCancel = () => old.promise;
    const pending = operation === 'detail' ? controller.selectJob(clientJob(1).id)
      : operation === 'create' ? controller.submit(squareInput) : controller.cancel(clientJob(1).id);
    const oldSignal = api.calls.at(-1)?.signal;
    controller.endSession();
    await controller.startSession();
    assert.equal(oldSignal?.aborted, true);
    old.resolve(clientJob(1, 'completed'));
    await pending;
    assert.equal(controller.state.detail, null, operation);
    assert.equal(controller.state.selectedId, null, operation);
    assert.deepEqual(controller.state.history, [], operation);
    assert.equal(controller.state.actionMessage, '', operation);
    assert.equal(controller.state.submitting, false, operation);
    assert.equal(controller.state.cancellingId, null, operation);
    controller.endSession();
  }
});

test('one polling cycle coalesces repeated refresh and never overlaps the same pending list request', async () => {
  const { api, clock, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  let activeInFlight = 0;
  let maxActiveInFlight = 0;
  let historyInFlight = 0;
  let maxHistoryInFlight = 0;
  let activeCalls = 0;
  const blocked = deferred<JobListResponse>();
  api.onList = async (query) => {
    if (query.status === 'active') {
      activeCalls++;
      maxActiveInFlight = Math.max(maxActiveInFlight, ++activeInFlight);
      const result = activeCalls === 1 ? await blocked.promise : { jobs: [clientSummary(1, 'running')], limit: 50, offset: 0 };
      activeInFlight--;
      return result;
    }
    maxHistoryInFlight = Math.max(maxHistoryInFlight, ++historyInFlight);
    await Promise.resolve();
    historyInFlight--;
    return { jobs: [clientSummary(1, 'running')], limit: 20, offset: 0 };
  };
  const first = controller.refresh();
  const repeats = [controller.refresh(), controller.refresh(), controller.refresh()];
  assert.equal(clock.size, 0);
  await settle();
  assert.equal(activeCalls, 1);
  blocked.resolve({ jobs: [clientSummary(1, 'running')], limit: 50, offset: 0 });
  await Promise.all([first, ...repeats]);
  await settle();
  assert.equal(activeCalls, 2);
  assert.equal(maxActiveInFlight, 1);
  assert.equal(maxHistoryInFlight, 1);
  assert.equal(clock.size, 1);
  await clock.fire();
  assert.equal(clock.size, 1);
  controller.endSession();
});

test('active pagination fetches at most two fifty-row pages for the allowed quota of one hundred', async () => {
  const { api, controller } = setup();
  api.onLimits = async () => ({ ...clientLimits, maxActivePerUser: 100 });
  api.onList = async (query) => ({
    jobs: query.status === 'active' ? Array.from({ length: 50 }, (_, index) => clientSummary(query.offset + index + 1)) : [],
    limit: query.limit, offset: query.offset,
  });
  await controller.startSession();
  assert.equal(controller.state.active.length, 100);
  assert.deepEqual(api.calls.filter((call) => call.method === 'list' && call.query?.status === 'active').map((call) => call.query?.offset), [0, 50]);
  assert.equal(new Set(controller.state.active.map((job) => job.id)).size, 100);
  controller.endSession();
});

test('cancel acknowledgement keeps running until the server confirms terminal and blocks duplicate cancel', async () => {
  const { api, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  const acknowledgement = deferred<JobDetails>();
  api.onCancel = () => acknowledgement.promise;
  const cancellation = controller.cancel(clientJob().id);
  await controller.cancel(clientJob().id);
  assert.equal(api.calls.filter((call) => call.method === 'cancel').length, 1);
  const accepted = { ...clientJob(1, 'running'), cancelRequested: true };
  api.onDetail = async () => accepted;
  acknowledgement.resolve(accepted);
  await cancellation;
  assert.equal(controller.state.detail?.status, 'running');
  assert.equal(controller.state.detail?.cancelRequested, true);
  assert.match(controller.state.actionMessage, /Очікуємо зупинки/u);
  api.onDetail = async () => clientJob(1, 'cancelled');
  await controller.refresh();
  assert.equal(controller.state.detail?.status, 'cancelled');
  controller.endSession();
});

test('cancel completed race displays the completed result and no longer polls its detail', async () => {
  const { api, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  api.onCancel = async () => clientJob(1, 'completed');
  await controller.cancel(clientJob().id);
  const detailCalls = api.calls.filter((call) => call.method === 'detail').length;
  await controller.refresh();
  assert.equal(controller.state.detail?.status, 'completed');
  assert.equal(controller.state.detail?.result?.length, 4);
  assert.equal(api.calls.filter((call) => call.method === 'detail').length, detailCalls);
  controller.endSession();
});

test('late pre-cancel GET cannot erase acknowledged cancellation during a manual refresh', async () => {
  const { api, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  const oldRead = deferred<JobDetails>();
  let reads = 0;
  const accepted = { ...clientJob(1, 'running'), cancelRequested: true };
  api.onDetail = async () => ++reads === 1 ? oldRead.promise : accepted;
  const refresh = controller.refresh();
  await settle();
  api.onCancel = async () => accepted;
  const cancel = controller.cancel(clientJob().id);
  await settle();
  assert.equal(controller.state.detail?.cancelRequested, true);
  oldRead.resolve(clientJob(1, 'running'));
  await Promise.all([refresh, cancel]);
  assert.equal(controller.state.detail?.cancelRequested, true);
  assert.equal(controller.state.detail?.status, 'running');
  controller.endSession();
});

test('submission is guarded while pending and uncertain POST is never retried by reads or polling', async () => {
  const { api, clock, controller } = setup();
  await controller.startSession();
  const creation = deferred<JobDetails>();
  api.onCreate = () => creation.promise;
  const first = controller.submit(squareInput);
  await controller.submit(squareInput);
  assert.equal(api.calls.filter((call) => call.method === 'create').length, 1);
  creation.reject(new ApiRequestError(0, 'ACCEPTANCE_UNKNOWN', 'Запит міг бути прийнятий. Оновіть історію перед повторним запуском.', true));
  await first;
  assert.equal(controller.state.submitting, false);
  assert.match(controller.state.actionError, /Оновіть історію/u);
  await controller.refresh();
  assert.equal(api.calls.filter((call) => call.method === 'create').length, 1);
  assert.equal(clock.size, 0);
  controller.endSession();
});

test('failed limits block submission and explicit retry recovers without fake fallback limits', async () => {
  const { api, controller } = setup();
  api.onLimits = async () => { throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'База тимчасово недоступна.'); };
  await controller.startSession();
  assert.equal(controller.state.limits, null);
  assert.match(controller.state.limitsError, /недоступна/u);
  await controller.submit(squareInput);
  assert.equal(api.calls.filter((call) => call.method === 'create').length, 0);
  api.onLimits = async () => structuredClone(clientLimits);
  await controller.retryLimits();
  assert.equal(controller.state.limitsError, '');
  assert.deepEqual(controller.state.limits, clientLimits);
  controller.endSession();
});

test('503 preserves last real lists and detail, reports stale data and recovers on a bounded polling read', async () => {
  const { api, clock, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  const previous = structuredClone(controller.state.detail);
  api.onList = async () => { throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'Не вдалося оновити дані.'); };
  api.onDetail = async () => { throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'Не вдалося оновити задачу.'); };
  await controller.refresh();
  assert.equal(controller.state.active.length, 1);
  assert.equal(controller.state.history.length, 1);
  assert.deepEqual(controller.state.detail, previous);
  assert.ok(controller.state.activeError && controller.state.historyError && controller.state.detailError);
  assert.equal(clock.size, 1);
  serveRunning(api);
  await clock.fire();
  assert.equal(controller.state.activeError, '');
  assert.equal(controller.state.historyError, '');
  assert.equal(controller.state.detailError, '');
  assert.equal(api.calls.filter((call) => call.method === 'create').length, 0);
  controller.endSession();
});

test('history pagination preserves offset and selection across polling and handles an empty next page', async () => {
  const { api, controller } = setup();
  api.onList = async (query) => ({
    jobs: query.status === 'active' ? [clientSummary(100, 'running')]
      : query.offset < 40 ? Array.from({ length: 20 }, (_, index) => clientSummary(query.offset + index + 1, 'completed')) : [],
    limit: query.limit, offset: query.offset,
  });
  await controller.startSession();
  await controller.selectJob(clientJob(1).id);
  const selected = controller.state.selectedId;
  await controller.goToHistoryPage(20);
  await controller.refresh();
  assert.equal(controller.state.historyOffset, 20);
  assert.equal(controller.state.history.length, 20);
  assert.equal(controller.state.selectedId, selected);
  await controller.goToHistoryPage(40);
  assert.equal(controller.state.historyOffset, 40);
  assert.deepEqual(controller.state.history, []);
  assert.equal(controller.state.historyHasNext, false);
  await controller.goToHistoryPage(1_000_020);
  assert.equal(controller.state.historyOffset, 40);
  controller.endSession();
});

test('stale previous history page cannot overwrite the page selected later', async () => {
  const { api, controller } = setup();
  await controller.startSession();
  const old = deferred<JobListResponse>();
  api.onList = async (query) => query.status === 'active' ? { jobs: [], limit: query.limit, offset: query.offset }
    : query.offset === 20 ? old.promise : { jobs: [clientSummary(41, 'completed')], limit: query.limit, offset: query.offset };
  const previous = controller.goToHistoryPage(20);
  await settle();
  const current = controller.goToHistoryPage(40);
  old.resolve({ jobs: [clientSummary(21, 'completed')], limit: 20, offset: 20 });
  await Promise.all([previous, current]);
  assert.equal(controller.state.historyOffset, 40);
  assert.equal(controller.state.history[0]?.id, clientJob(41).id);
  controller.endSession();
});

test('failed next history page keeps its previous page label and rows and permits an explicit retry', async () => {
  const { api, controller } = setup();
  let unavailable = true;
  api.onList = async (query) => {
    if (query.status === 'active') return { jobs: [], limit: query.limit, offset: query.offset };
    if (query.offset === 20 && unavailable) throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'База тимчасово недоступна.');
    return {
      jobs: Array.from({ length: 20 }, (_, index) => clientSummary(query.offset + index + 1, 'completed')),
      limit: query.limit, offset: query.offset,
    };
  };
  await controller.startSession();
  const previous = structuredClone(controller.state.history);
  await controller.goToHistoryPage(20);
  assert.equal(controller.state.historyOffset, 0);
  assert.deepEqual(controller.state.history, previous);
  assert.equal(controller.state.historyLoading, false);
  assert.equal(controller.state.historyHasNext, true);
  assert.match(controller.state.historyError, /останню успішно завантажену сторінку/u);
  unavailable = false;
  await controller.goToHistoryPage(20);
  assert.equal(controller.state.historyOffset, 20);
  assert.equal(controller.state.history[0]?.id, clientJob(21).id);
  assert.equal(controller.state.historyError, '');
  controller.endSession();
});

test('401 from jobs clears private state and timers exactly once without claiming a database outage logged out', async () => {
  const { api, clock, controller, unauthorized } = setup();
  serveRunning(api);
  await controller.startSession();
  api.onList = async () => { throw new ApiRequestError(401, 'UNAUTHORIZED', 'Сеанс завершився.'); };
  await controller.refresh();
  assert.equal(unauthorized(), 1);
  assert.equal(controller.state.authenticated, false);
  assert.equal(controller.state.limits, null);
  assert.deepEqual(controller.state.active, []);
  assert.deepEqual(controller.state.history, []);
  assert.equal(controller.state.detail, null);
  assert.equal(clock.size, 0);
  const calls = api.calls.length;
  await controller.refresh();
  await controller.cancel(clientJob().id);
  await controller.submit(squareInput);
  assert.equal(api.calls.length, calls);
});

test('logout aborts pending reads, clears timers and data, and does not cancel accepted server jobs', async () => {
  const { api, clock, controller } = setup();
  serveRunning(api);
  await controller.startSession();
  const blocked = deferred<JobDetails>();
  api.onDetail = () => blocked.promise;
  const selected = controller.selectJob(clientJob(2).id);
  const signal = api.calls.at(-1)?.signal;
  controller.endSession();
  assert.equal(signal?.aborted, true);
  assert.equal(clock.size, 0);
  blocked.resolve(clientJob(2, 'completed'));
  await selected;
  assert.equal(controller.state.detail, null);
  assert.equal(controller.state.selectedId, null);
  assert.equal(api.calls.filter((call) => call.method === 'cancel').length, 0);
});
