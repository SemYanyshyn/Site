import { performance } from 'node:perf_hooks';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { QUEUE_LIMITS } from '../../shared/jobs.js';
import type { JobQueueInfo } from '../../shared/jobs.js';
import type { RouteProgress } from '../../shared/route.js';
import { estimateQueue, QUEUE_MODEL } from './queue-estimator.js';
import type { QueueDurationSample, QueueExecutor, QueueQueuedJob, QueueRunningJob } from './queue-estimator.js';

interface ExecutorRow {
  instance_id: string;
  expires_at: Date;
  accepting_claims: boolean;
  busy: boolean;
  current_job_id: string | null;
}
interface RunningRow {
  id: string;
  instance_id: string;
  started_at: Date;
  timeout_ms: number;
  progress_stage: RouteProgress['stage'];
  completed_iterations: string;
  total_iterations: string;
  cancel_requested: boolean;
  point_count: number;
}
interface WorkRow { point_count: number; iterations: string }
interface SampleRow extends WorkRow {
  duration_ms: string;
  iterations_completed: string;
  termination_reason: string;
  status: QueueDurationSample['status'];
}

/** The owning HTTP read has one monotonic deadline, including setup/commit.
 * A failed read discards its read-only connection rather than adding an
 * unbounded rollback round trip. Server-side limits remain a second guard. */
export async function queryQueueSnapshot<Row extends QueryResultRow>(
  client: PoolClient, deadline: number, text: string, values?: unknown[],
): Promise<QueryResult<Row>> {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw new Error('Перевищено час читання стану черги.');
  const query = { text, query_timeout: Math.min(1_000, remaining), ...(values === undefined ? {} : { values }) };
  return client.query<Row>(query);
}

/** Called only inside the owning detail's read-only REPEATABLE READ transaction.
 * Only the target detail contains coordinates; all global reads use scalars.
 * The supplied timestamp comes from that same transaction's first detail read. */
export async function readQueueSnapshot(
  client: PoolClient, targetId: string, calculatedAt: string, timeoutMs: number, deadline = performance.now() + 8_000,
): Promise<JobQueueInfo> {
  const executors = await queryQueueSnapshot<ExecutorRow>(client, deadline, `
    SELECT instance_id, expires_at, accepting_claims, busy, current_job_id
    FROM executor_registry WHERE accepting_claims AND expires_at > $1::timestamptz
    ORDER BY instance_id LIMIT $2
  `, [calculatedAt, QUEUE_LIMITS.maxExecutors + 1]);
  const running = await queryQueueSnapshot<RunningRow>(client, deadline, `
    SELECT id, instance_id, started_at, timeout_ms, progress_stage,
      completed_iterations::text, total_iterations::text,
      cancel_requested_at IS NOT NULL AS cancel_requested,
      jsonb_array_length(input -> 'points') AS point_count
    FROM jobs WHERE status = 'running' ORDER BY instance_id, id LIMIT $1
  `, [10_001]);
  const ahead = await queryQueueSnapshot<WorkRow>(client, deadline, `
    SELECT jsonb_array_length(j.input -> 'points') AS point_count, j.total_iterations::text AS iterations
    FROM jobs AS j CROSS JOIN (SELECT created_at, id FROM jobs WHERE id = $1) AS target
    WHERE j.status = 'queued' AND (j.created_at, j.id) < (target.created_at, target.id)
    ORDER BY j.created_at, j.id LIMIT $2
  `, [targetId, QUEUE_LIMITS.maxQueuedAhead + 1]);
  const samples = await queryQueueSnapshot<SampleRow>(client, deadline, `
    SELECT jsonb_array_length(input -> 'points') AS point_count,
      total_iterations::text AS iterations, completed_iterations::text AS iterations_completed,
      (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::text AS duration_ms,
      result ->> 'terminationReason' AS termination_reason, status
    FROM jobs WHERE status = 'completed' AND result ->> 'terminationReason' = 'budget_exhausted'
      AND completed_iterations > 0
    ORDER BY finished_at DESC, id DESC LIMIT $1
  `, [QUEUE_MODEL.maxSamples]);
  if (executors.rows.length > QUEUE_LIMITS.maxExecutors || running.rows.length > 10_000
    || ahead.rows.length > QUEUE_LIMITS.maxQueuedAhead) {
    throw new RangeError('Черга перевищує дозволений обсяг знімка.');
  }
  const executorValues: QueueExecutor[] = executors.rows.map((row) => ({
    instanceId: row.instance_id, expiresAt: row.expires_at.toISOString(), acceptingClaims: row.accepting_claims,
    busy: row.busy, currentJobId: row.current_job_id,
  }));
  const runningValues: QueueRunningJob[] = running.rows.map((row) => ({
    id: row.id, instanceId: row.instance_id, startedAt: row.started_at.toISOString(), timeoutMs: row.timeout_ms,
    stage: row.progress_stage, completedIterations: Number(row.completed_iterations),
    totalIterations: Number(row.total_iterations), cancelRequested: row.cancel_requested, pointCount: row.point_count,
  }));
  const queuedAhead: QueueQueuedJob[] = ahead.rows.map((row) => ({ pointCount: row.point_count, iterations: Number(row.iterations) }));
  const sampleValues: QueueDurationSample[] = samples.rows.map((row) => ({
    pointCount: row.point_count, iterations: Number(row.iterations), durationMs: Number(row.duration_ms),
    iterationsCompleted: Number(row.iterations_completed), terminationReason: row.termination_reason, status: row.status,
  }));
  return estimateQueue({ calculatedAt, executors: executorValues, running: runningValues, queuedAhead, samples: sampleValues }, { timeoutMs });
}
