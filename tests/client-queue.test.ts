import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiRequestError } from '../src/client/api.js';
import { JobsController } from '../src/client/jobs-controller.js';
import { queueDisplay } from '../src/client/queue-display.js';
import { InvalidResponseError, parseJobDetails } from '../src/client/response.js';
import { QUEUE_LIMITS } from '../src/shared/jobs.js';
import type { JobDetails, JobQueueInfo } from '../src/shared/jobs.js';
import { ControlledClock, ControlledJobsApi } from './fixtures/client-controller.js';
import { clientJob, deferred, squareInput } from './fixtures/client-jobs.js';

const queue: JobQueueInfo = {
  estimatedWaitMs: 16_000, calculatedAt: '2026-10-24T10:00:00.000Z',
  queuedAhead: 1, executorCount: 2, basis: 'measured',
};
const queued = (id = 1): JobDetails => ({ ...clientJob(id), queue: { ...queue } });

test('queue metadata accepts unknown and boundary values while requiring it only for a queued detail GET', () => {
  assert.deepEqual(parseJobDetails(queued(), true).queue, queue);
  assert.equal(parseJobDetails(clientJob()).queue, undefined, 'accepted create may precede queue read');
  assert.throws(() => parseJobDetails(clientJob(), true), InvalidResponseError);
  const unknown = { ...queue, estimatedWaitMs: null, executorCount: 0, basis: 'unavailable' };
  assert.equal(parseJobDetails({ ...clientJob(), queue: unknown }, true).queue?.estimatedWaitMs, null);
  assert.equal(parseJobDetails({ ...clientJob(), queue: { ...queue, estimatedWaitMs: QUEUE_LIMITS.maxWaitMs,
    queuedAhead: QUEUE_LIMITS.maxQueuedAhead, executorCount: QUEUE_LIMITS.maxExecutors } }, true).queue?.estimatedWaitMs, QUEUE_LIMITS.maxWaitMs);
  for (const status of ['running', 'completed', 'cancelled', 'failed'] as const) {
    assert.throws(() => parseJobDetails({ ...clientJob(1, status), queue }), InvalidResponseError);
    assert.equal(parseJobDetails(clientJob(1, status), true).queue, undefined);
  }
});

test('malformed or contradictory queue metadata cannot supply a misleading forecast', () => {
  const changes = [
    { estimatedWaitMs: NaN }, { estimatedWaitMs: Infinity }, { estimatedWaitMs: -1 },
    { estimatedWaitMs: 1.5 }, { estimatedWaitMs: '1200' }, { estimatedWaitMs: QUEUE_LIMITS.maxWaitMs + 1 },
    { estimatedWaitMs: null }, { basis: 'unavailable' }, { basis: 'guaranteed' },
    { executorCount: 0 }, { executorCount: -1 }, { executorCount: 1.5 }, { executorCount: QUEUE_LIMITS.maxExecutors + 1 },
    { queuedAhead: -1 }, { queuedAhead: 1.5 }, { queuedAhead: QUEUE_LIMITS.maxQueuedAhead + 1 },
    { calculatedAt: 'yesterday' }, { calculatedAt: 0 },
  ];
  for (const change of changes) assert.throws(() => parseJobDetails({ ...clientJob(), queue: { ...queue, ...change } }, true), InvalidResponseError);
  for (const value of [null, [], {}]) assert.throws(() => parseJobDetails({ ...clientJob(), queue: value }, true), InvalidResponseError);
});

test('the API rejects missing or invalid queued GET metadata but accepts an initial POST without it', async () => {
  const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const api = new ApiClient(async () => response(clientJob()));
  assert.equal((await api.create(squareInput)).queue, undefined);
  await assert.rejects(api.detail(clientJob().id), InvalidResponseError);
  const malformed = new ApiClient(async () => response({ ...queued(), queue: { ...queue, estimatedWaitMs: -1 } }));
  await assert.rejects(malformed.detail(clientJob().id), InvalidResponseError);
});

test('wait formatting distinguishes pending, unavailable, assignment, subsecond and fallback without a countdown', () => {
  assert.match(queueDisplay(undefined).estimate, /Оцінюємо/u);
  const unknown = queueDisplay({ ...queue, estimatedWaitMs: null, executorCount: 0, basis: 'unavailable' });
  assert.match(unknown.estimate, /немає доступної оцінки/u);
  assert.match(unknown.explanation, /Немає доступного виконавця/u);
  assert.doesNotMatch(unknown.estimate, /0 с/u);
  assert.match(queueDisplay({ ...queue, estimatedWaitMs: 0 }).estimate, /Очікуємо призначення/u);
  assert.match(queueDisplay({ ...queue, estimatedWaitMs: 1 }).estimate, /менше секунди/u);
  assert.match(queueDisplay({ ...queue, estimatedWaitMs: 1_001 }).estimate, /2 с/u);
  assert.match(queueDisplay({ ...queue, estimatedWaitMs: 60_001 }).estimate, /2 хв/u);
  assert.match(queueDisplay({ ...queue, basis: 'timeout' }).explanation, /Попередня оцінка за серверною межею часу/u);
  assert.match(queueDisplay({ ...queue, basis: 'mixed' }).explanation, /виміряною роботою та серверною межею/u);
  assert.deepEqual(queueDisplay(queue), queueDisplay({ ...queue }), 'formatting does not derive time from the local clock');
});

test('503 keeps the previous queued snapshot with a stale error, then running removes metadata', async () => {
  const api = new ControlledJobsApi();
  const clock = new ControlledClock();
  const controller = new JobsController(api, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await controller.startSession();
  api.onDetail = async () => queued();
  await controller.selectJob(clientJob().id);
  api.onDetail = async () => { throw new ApiRequestError(503, 'DATABASE_UNAVAILABLE', 'Не вдалося оновити оцінку.'); };
  await controller.refresh();
  assert.deepEqual(controller.state.detail?.queue, queue);
  assert.match(controller.state.detailError, /Не вдалося/u);
  assert.equal(clock.size, 1);
  api.onDetail = async () => clientJob(1, 'running');
  await clock.fire();
  assert.equal(controller.state.detail?.status, 'running');
  assert.equal(controller.state.detail?.queue, undefined);
  assert.equal(controller.state.detailError, '');
  controller.endSession();
  assert.equal(controller.state.detail, null);
  assert.equal(clock.size, 0);
});

test('late queued metadata cannot reappear after another selection or after a new authenticated session', async () => {
  const api = new ControlledJobsApi();
  const clock = new ControlledClock();
  const controller = new JobsController(api, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await controller.startSession();
  const old = deferred<JobDetails>();
  api.onDetail = async (id) => id === clientJob().id ? old.promise : clientJob(2, 'running');
  const previous = controller.selectJob(clientJob().id);
  await controller.selectJob(clientJob(2).id);
  old.resolve(queued());
  await previous;
  assert.equal(controller.state.detail?.id, clientJob(2).id);
  assert.equal(controller.state.detail?.queue, undefined);
  const late = deferred<JobDetails>();
  api.onDetail = () => late.promise;
  const pending = controller.selectJob(clientJob().id);
  controller.endSession();
  await controller.startSession();
  late.resolve(queued());
  await pending;
  assert.equal(controller.state.detail, null);
  assert.equal(controller.state.selectedId, null);
  controller.endSession();
});
