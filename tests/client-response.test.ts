import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidResponseError, isJobSummary, parseJobDetails, parseJobLimits, parseJobList } from '../src/client/response.js';
import { clientJob, clientLimits, clientSummary } from './fixtures/client-jobs.js';

function altered(change: (value: Record<string, unknown>) => void, completed = true): unknown {
  const value: unknown = clientJob(1, completed ? 'completed' : 'running');
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  change(record);
  return record;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('runtime response parser accepts all real statuses and verified saved square result', () => {
  for (const status of ['queued', 'running', 'completed', 'cancelled', 'failed'] as const) {
    assert.equal(parseJobDetails(clientJob(1, status)).status, status);
    assert.equal(isJobSummary(clientSummary(1, status)), true);
  }
  assert.deepEqual(parseJobLimits(clientLimits), clientLimits);
  assert.deepEqual(parseJobList({ jobs: [clientSummary(1)], limit: 20, offset: 40 }).offset, 40);
});

test('runtime limits and list parsers reject malformed arrays, pagination, unsafe counts and duplicate IDs', () => {
  for (const value of [null, [], {}, { ...clientLimits, maxActivePerUser: 101 }, { ...clientLimits, route: { ...clientLimits.route, timeoutMs: Infinity } }, { ...clientLimits, route: { ...clientLimits.route, maxPoints: 0 } }]) {
    assert.throws(() => parseJobLimits(value), InvalidResponseError);
  }
  for (const value of [null, [], { jobs: {}, limit: 20, offset: 0 }, { jobs: [], limit: 51, offset: 0 }, { jobs: [], limit: 20, offset: 1_000_001 }, { jobs: [clientSummary(1), clientSummary(1)], limit: 20, offset: 0 }, { jobs: [clientSummary(1), clientSummary(2)], limit: 1, offset: 0 }]) {
    assert.throws(() => parseJobList(value), InvalidResponseError);
  }
});

test('runtime summary parser rejects invalid states, stages, counters, dates, completion and error shapes', () => {
  const changes: Array<(value: Record<string, unknown>) => void> = [
    (value) => { value.id = 'bad-id'; },
    (value) => { value.status = 'imaginary'; },
    (value) => { record(value.progress).stage = 'imaginary'; },
    (value) => { record(value.progress).completedIterations = -1; },
    (value) => { record(value.progress).completedIterations = 10_001; },
    (value) => { record(value.progress).percent = Infinity; },
    (value) => { value.createdAt = 'today'; },
    (value) => { value.updatedAt = 1; },
    (value) => { value.finishedAt = null; },
    (value) => { value.cancelRequested = 'false'; },
    (value) => { value.executedBy = {}; },
    (value) => { value.error = { reason: 'timeout', message: 'unexpected' }; },
  ];
  for (const change of changes) assert.throws(() => parseJobDetails(altered(change)), InvalidResponseError);
  assert.throws(() => parseJobDetails(altered((value) => { record(value.progress).percent = 100; }, false)), InvalidResponseError);
  const failed = clientJob(1, 'failed');
  assert.throws(() => parseJobDetails({ ...failed, error: { reason: 'fake', message: 'Помилка.' } }), InvalidResponseError);
  assert.throws(() => parseJobDetails({ ...failed, error: { reason: 'timeout', message: [] } }), InvalidResponseError);
});

test('runtime detail parser rejects malformed input and result order rather than allowing unsafe SVG', () => {
  const changes: Array<(value: Record<string, unknown>) => void> = [
    (value) => { record(value.input).points = {}; },
    (value) => { record(value.input).points = []; },
    (value) => { record(value.input).warehouse = { x: NaN, y: 0 }; },
    (value) => { record(value.input).seed = -1; },
    (value) => { record(value.input).iterations = 0; },
    (value) => { value.result = undefined; },
    (value) => { record(value.result).order = [0, 1, 1, 3, 0]; },
    (value) => { record(value.result).order = [0, 1, 2, 4, 0]; },
    (value) => { record(value.result).order = [0, 1, 2, 3]; },
    (value) => { record(value.result).order = '0,1,2,3,0'; },
    (value) => { record(value.result).length = NaN; },
    (value) => { record(value.result).length = 2; },
    (value) => { record(value.result).initialLength = 3; },
    (value) => { record(value.result).seed = 1; },
    (value) => { record(value.result).iterationsRequested = 9_999; },
    (value) => { record(value.result).iterationsCompleted = 9_999; },
    (value) => { record(value.result).elapsedMs = -1; },
    (value) => { record(value.result).approximate = false; },
    (value) => { record(value.result).terminationReason = 'global_optimum'; },
  ];
  for (const change of changes) assert.throws(() => parseJobDetails(altered(change)), InvalidResponseError);
  assert.throws(() => parseJobDetails({ ...clientJob(1, 'running'), result: clientJob(1, 'completed').result }), InvalidResponseError);
});

test('runtime detail parser keeps truthful zero-iteration trivial and coincident results', () => {
  const trivial = clientJob(1, 'completed');
  trivial.input.points = [{ x: 3, y: 4 }];
  assert.ok(trivial.result);
  trivial.result.order = [0, 1, 0];
  trivial.result.initialOrder = [0, 1, 0];
  trivial.result.length = 10;
  trivial.result.initialLength = 10;
  trivial.result.iterationsCompleted = 0;
  trivial.result.terminationReason = 'trivial_input';
  trivial.progress.completedIterations = 0;
  assert.equal(parseJobDetails(trivial).result?.iterationsCompleted, 0);
  const coincident = structuredClone(trivial);
  coincident.input.points[0] = { x: 0, y: 0 };
  assert.ok(coincident.result);
  coincident.result.length = 0;
  coincident.result.initialLength = 0;
  coincident.result.terminationReason = 'zero_length';
  assert.equal(parseJobDetails(coincident).result?.length, 0);
});

test('saved initial nearest-neighbor sequence is distinct from best and survives JSON history reload', () => {
  const job = clientJob(1, 'completed');
  job.input.points = [{ x: 2, y: 1 }, { x: 3, y: 5 }, { x: 7, y: 2 }, { x: 8, y: 7 }, { x: 1, y: 8 }];
  assert.ok(job.result);
  job.result.order = [0, 1, 3, 4, 5, 2, 0];
  job.result.length = 28.94167798686012;
  job.result.initialOrder = [0, 1, 2, 5, 4, 3, 0];
  job.result.initialLength = 29.41492209332022;
  const loaded = parseJobDetails(JSON.parse(JSON.stringify(job)));
  assert.deepEqual(loaded.result?.initialOrder, [0, 1, 2, 5, 4, 3, 0]);
  assert.notDeepEqual(loaded.result?.initialOrder, loaded.result?.order);
  const legacy = structuredClone(job);
  assert.ok(legacy.result);
  delete legacy.result.initialOrder;
  assert.equal(parseJobDetails(legacy).result?.initialOrder, undefined);
  assert.equal(parseJobDetails(legacy).result?.initialLength, job.result.initialLength);
});

test('runtime initial sequence rejects malformed, repeated, oversized and geometrically inconsistent values', () => {
  for (const initialOrder of [null, '0,1,2,3,0', [], [0, 1, 2, 3], [0, 1, 1, 3, 0], [0, 1, 2, 4, 0],
    [0, 0, 2, 3, 0], [1, 1, 2, 3, 0], [0, 1, 2, 3, 1], [0, 1, NaN, 3, 0], [0, 1, 2.5, 3, 0],
    Array.from({ length: 10_000 }, () => 0), [0, 1, 3, 2, 0]]) {
    assert.throws(() => parseJobDetails(altered(value => { record(value.result).initialOrder = initialOrder; })), InvalidResponseError);
  }
  const saved = clientJob(1, 'completed');
  assert.ok(saved.result);
  saved.result.initialOrder = [0, 1, 2, 3, 0];
  assert.equal(parseJobDetails(saved).result?.initialOrder, saved.result.initialOrder);
});
