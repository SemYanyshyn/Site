import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { estimateQueue } from '../src/server/jobs/queue-estimator.js';
import type { QueueDurationSample, QueueExecutor, QueueRunningJob, QueueSnapshot } from '../src/server/jobs/queue-estimator.js';

const now = '2026-10-24T12:00:00.000Z';
const options = { timeoutMs: 60_000, handoffMs: 0, finalizationMs: 0 };
const sample: QueueDurationSample = { pointCount: 3, iterations: 6000, durationMs: 6000,
  iterationsCompleted: 6000, terminationReason: 'budget_exhausted', status: 'completed' };

function executor(index: number, busy = false): QueueExecutor {
  return { instanceId: `executor-${index}`, expiresAt: '2026-10-24T12:00:15.000Z', acceptingClaims: true, busy,
    currentJobId: busy ? `job-${index}` : null };
}
function running(index: number, elapsed: number): QueueRunningJob {
  return { id: `job-${index}`, instanceId: `executor-${index}`, startedAt: new Date(Date.parse(now) - elapsed).toISOString(),
    timeoutMs: 120_000, stage: 'searching', completedIterations: 10_000, totalIterations: 20_000,
    cancelRequested: false, pointCount: 3 };
}
function snapshot(changes: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return { calculatedAt: now, executors: [], running: [], queuedAhead: [], samples: [], ...changes };
}

test('queue estimator returns unknown for no fresh accepting executor, including paused/stopping/expired', () => {
  for (const executors of [[], [{ ...executor(1), acceptingClaims: false }], [{ ...executor(1), expiresAt: now }], [{ ...executor(1), expiresAt: '2026-10-24T11:59:59.000Z' }]]) {
    const result = estimateQueue(snapshot({ executors }), options);
    assert.equal(result.estimatedWaitMs, null);
    assert.equal(result.executorCount, 0);
    assert.equal(result.basis, 'unavailable');
    assert.equal(result.calculatedAt, now);
  }
});

test('queue estimator simulates the earliest of unequal worker releases, without target runtime', () => {
  const result = estimateQueue(snapshot({ executors: [executor(1, true), executor(2, true)],
    running: [running(1, 10_000), running(2, 30_000)], queuedAhead: [{ pointCount: 3, iterations: 6000 }], samples: [sample] }), options);
  assert.equal(result.estimatedWaitMs, 16_000);
  assert.equal(result.executorCount, 2);
  assert.equal(result.queuedAhead, 1);
  assert.equal(result.basis, 'measured');
});

test('one idle executor begins at handoff while two parallel slots serve unequal queued budgets', () => {
  assert.equal(estimateQueue(snapshot({ executors: [executor(1)] }), options).estimatedWaitMs, 0);
  const result = estimateQueue(snapshot({ executors: [executor(1), executor(2)], queuedAhead: [
    { pointCount: 3, iterations: 6000 }, { pointCount: 3, iterations: 12_009 }, { pointCount: 3, iterations: 3000 },
  ], samples: [sample] }), options);
  assert.ok(result.estimatedWaitMs !== null && result.estimatedWaitMs > 6000 && result.estimatedWaitMs < 12_009);
});

test('cold queued work uses explicit timeout basis and actual usable samples affect budget estimates', () => {
  const cold = estimateQueue(snapshot({ executors: [executor(1)], queuedAhead: [{ pointCount: 3, iterations: 6000 }] }), options);
  assert.equal(cold.estimatedWaitMs, 60_000);
  assert.equal(cold.basis, 'timeout');
  const measured = (iterations: number) => estimateQueue(snapshot({ executors: [executor(1)], queuedAhead: [{ pointCount: 3, iterations }], samples: [sample] }), options);
  assert.equal(measured(6000).estimatedWaitMs, 6000);
  assert.equal(measured(6000).basis, 'measured');
  assert.ok(measured(12_000).estimatedWaitMs! > measured(6000).estimatedWaitMs!);
  const mixed = estimateQueue(snapshot({ executors: [executor(1)], queuedAhead: [{ pointCount: 3, iterations: 6000 }, { pointCount: 1000, iterations: 6000 }], samples: [sample] }), options);
  assert.equal(mixed.basis, 'mixed');
});

test('failed, cancelled, zero, trivial and malformed duration samples cannot teach instant search', () => {
  const samples: QueueDurationSample[] = [
    { ...sample, status: 'failed' }, { ...sample, status: 'cancelled' }, { ...sample, durationMs: 0 },
    { ...sample, durationMs: NaN }, { ...sample, durationMs: Infinity }, { ...sample, iterationsCompleted: 0 },
    { ...sample, iterationsCompleted: 5999 }, { ...sample, terminationReason: 'trivial_input' },
    { ...sample, terminationReason: 'zero_length' }, { ...sample, pointCount: 1 },
  ];
  const result = estimateQueue(snapshot({ executors: [executor(1)], queuedAhead: [{ pointCount: 3, iterations: 6000 }], samples }), options);
  assert.equal(result.basis, 'timeout');
  assert.equal(result.estimatedWaitMs, 60_000);
});

test('busy preparation, finishing, zero progress, zero elapsed and cancel request stay finite and occupied', () => {
  for (const changes of [
    { stage: 'preparing' as const, completedIterations: 0 },
    { stage: 'finishing' as const, completedIterations: 20_000 },
    { completedIterations: 0 }, { startedAt: now }, { cancelRequested: true },
  ]) {
    const result = estimateQueue(snapshot({ executors: [executor(1, true)], running: [{ ...running(1, 1000), ...changes }] }), options);
    assert.ok(result.estimatedWaitMs !== null && Number.isFinite(result.estimatedWaitMs) && result.estimatedWaitMs > 0);
  }
});

test('a committed running claim overrides an older idle heartbeat and contradictory busy state is unknown', () => {
  const claimed = estimateQueue(snapshot({ executors: [executor(1)], running: [running(1, 10_000)] }), options);
  assert.equal(claimed.estimatedWaitMs, 10_000);
  const contradictory = estimateQueue(snapshot({ executors: [executor(1, true)], running: [] }), options);
  assert.equal(contradictory.estimatedWaitMs, null);
  assert.equal(contradictory.basis, 'unavailable');
});

test('fixed-snapshot predecessor removal or adding an idle executor never increases predicted wait', () => {
  const base = snapshot({ executors: [executor(1, true)], running: [running(1, 10_000)],
    queuedAhead: [{ pointCount: 3, iterations: 6000 }, { pointCount: 3, iterations: 12_000 }], samples: [sample] });
  const full = estimateQueue(base, options).estimatedWaitMs!;
  const removed = estimateQueue({ ...base, queuedAhead: base.queuedAhead.slice(1) }, options).estimatedWaitMs!;
  const extra = estimateQueue({ ...base, executors: [...base.executors, executor(2)] }, options).estimatedWaitMs!;
  assert.ok(removed <= full);
  assert.ok(extra <= full);
});

test('queue estimator models every bounded predecessor and completes maximum snapshot without quadratic work', (t) => {
  const input = snapshot({ executors: [executor(1), executor(2)],
    queuedAhead: Array.from({ length: 9999 }, (_, index) => ({ pointCount: 3, iterations: 6000 + index % 3 })),
    samples: Array.from({ length: 200 }, () => ({ ...sample })) });
  const started = performance.now();
  const result = estimateQueue(input, options);
  const elapsedMs = performance.now() - started;
  assert.equal(result.queuedAhead, 9999);
  assert.ok(result.estimatedWaitMs !== null && Number.isSafeInteger(result.estimatedWaitMs) && result.estimatedWaitMs > 29_000_000);
  assert.ok(elapsedMs < 3000, 'The maximum bounded pure snapshot must fit comfortably within the HTTP read budget.');
  t.diagnostic(`maximum_snapshot_9999_predecessors_200_samples_ms=${elapsedMs.toFixed(3)}`);
});

test('queue estimator rejects oversized snapshots and invalid timing options before unbounded simulation', () => {
  assert.throws(() => estimateQueue(snapshot({ queuedAhead: Array.from({ length: 10_001 }, () => ({ pointCount: 3, iterations: 1 })) }), options), RangeError);
  assert.throws(() => estimateQueue(snapshot({ samples: Array.from({ length: 201 }, () => sample) }), options), RangeError);
  assert.throws(() => estimateQueue(snapshot({ executors: Array.from({ length: 10_001 }, (_, index) => executor(index)) }), options), RangeError);
  assert.throws(() => estimateQueue(snapshot({ calculatedAt: 'not-a-date' }), options), RangeError);
  for (const changed of [{ timeoutMs: Infinity }, { timeoutMs: 0 }, { handoffMs: -1 }, { finalizationMs: 10_001 }]) {
    assert.throws(() => estimateQueue(snapshot(), { ...options, ...changed }), RangeError);
  }
});
