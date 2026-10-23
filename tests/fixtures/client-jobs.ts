import type { JobDetails, JobLimitsResponse, JobSummary } from '../../src/shared/jobs.js';
import type { NormalizedRouteInput } from '../../src/shared/route.js';

export const clientLimits: JobLimitsResponse = {
  route: { maxPoints: 500, maxIterations: 50_000_000, timeoutMs: 30_000, maxCoordinate: 1_000_000 },
  maxActivePerUser: 4,
};

export const squareInput: NormalizedRouteInput = {
  warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 10_000, seed: 0,
};

export function clientJob(number = 1, status: JobSummary['status'] = 'queued'): JobDetails {
  const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
  const job: JobDetails = {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    status,
    progress: {
      stage: status === 'completed' ? 'finishing' : status === 'running' ? 'searching' : 'preparing',
      completedIterations: status === 'completed' ? squareInput.iterations : status === 'running' ? 2_500 : 0,
      totalIterations: squareInput.iterations,
      percent: status === 'completed' ? 100 : status === 'running' ? 25 : 0,
    },
    cancelRequested: false,
    createdAt: '2026-10-23T10:00:00.000Z', updatedAt: terminal ? '2026-10-23T10:00:02.000Z' : '2026-10-23T10:00:01.000Z',
    startedAt: status === 'queued' ? null : '2026-10-23T10:00:00.500Z',
    finishedAt: terminal ? '2026-10-23T10:00:02.000Z' : null,
    executedBy: status === 'queued' ? null : '00000000-0000-4000-8000-000000000099',
    input: structuredClone(squareInput),
  };
  if (status === 'completed') {
    job.result = {
      order: [0, 1, 2, 3, 0], length: 4, initialLength: 4, seed: 0,
      iterationsRequested: squareInput.iterations, iterationsCompleted: squareInput.iterations,
      elapsedMs: 1.5, approximate: true, terminationReason: 'budget_exhausted',
    };
  }
  if (status === 'failed') job.error = { reason: 'timeout', message: 'Перевищено час обчислення.' };
  return job;
}

export function clientSummary(number = 1, status: JobSummary['status'] = 'queued'): JobSummary {
  const { input: _input, result: _result, ...summary } = clientJob(number, status);
  return summary;
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
