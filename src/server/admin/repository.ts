import type { Pool, QueryResultRow } from 'pg';
import type { AdminCounts, AdminExecutor, AdminJob, AdminJobsOptions, AdminJobsResponse } from '../../shared/admin.js';
import type { JobFailureReason, JobStatus } from '../../shared/jobs.js';
import type { RouteProgress } from '../../shared/route.js';
import { ADMIN_LIMITS } from './config.js';
import { adminRead } from './budget.js';

interface CountRow extends QueryResultRow { queued: string; running: string; completed: string; cancelled: string; failed: string }
interface ExecutorRow extends QueryResultRow {
  instance_id: string; pod_uid: string | null; pod_name: string | null; pod_namespace: string | null;
  started_at: Date; last_seen_at: Date; expires_at: Date; accepting_claims: boolean; busy: boolean;
  current_job_id: string | null; running_job_ids: string[]; fresh: boolean; recent_only: boolean;
}
interface JobRow extends QueryResultRow {
  id: string; user_id: string; username: string; status: JobStatus; progress_stage: RouteProgress['stage'];
  completed_iterations: string; total_iterations: string; progress_percent: number; cancel_requested: boolean;
  created_at: Date; updated_at: Date; started_at: Date | null; finished_at: Date | null;
  instance_id: string | null; failure_reason: JobFailureReason | null;
}
export interface AdminDatabaseSnapshot {
  observedAt: string;
  counts: AdminCounts;
  executors: AdminExecutor[];
  recentTruncated: boolean;
}
const BEGIN = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
  SET LOCAL statement_timeout = '1000ms'; SET LOCAL lock_timeout = '500ms';
  SET LOCAL idle_in_transaction_session_timeout = '1500ms'; SET LOCAL transaction_timeout = '5000ms'`;
function projectJob(row: JobRow): AdminJob {
  return { id: row.id, owner: { id: row.user_id, username: row.username }, status: row.status,
    progress: { stage: row.progress_stage, completedIterations: Number(row.completed_iterations), totalIterations: Number(row.total_iterations), percent: row.progress_percent },
    cancelRequested: row.cancel_requested, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null,
    executedBy: row.instance_id, failureReason: row.failure_reason };
}
export class AdminRepository {
  constructor(private readonly pool: Pool) {}
  overview(deadline: number, signal: AbortSignal, podUids: string[]): Promise<AdminDatabaseSnapshot> {
    return adminRead(this.pool, deadline, signal, async (query) => {
      await query(BEGIN);
      const stamp = await query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = stamp.rows[0]!.now;
      const counts = await query<CountRow>(`SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
        COUNT(*) FILTER (WHERE status = 'running')::text AS running,
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
        COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed FROM jobs`);
      // Current pod matches, every fresh lease and every unfinished executor
      // are mandatory. Only the separate recent unavailable tail is capped.
      const result = await query<ExecutorRow>(`WITH running AS (
        SELECT instance_id, array_agg(id ORDER BY id) AS job_ids FROM jobs WHERE status = 'running' GROUP BY instance_id
      ), mandatory AS (
        SELECT e.instance_id FROM executor_registry e
        WHERE e.pod_uid = ANY($2::uuid[]) OR e.expires_at > $1::timestamptz
          OR EXISTS (SELECT 1 FROM running r WHERE r.instance_id = e.instance_id)
      ), recent AS (
        SELECT e.instance_id FROM executor_registry e
        WHERE e.last_seen_at >= $1::timestamptz - $3::integer * INTERVAL '1 second'
          AND NOT EXISTS (SELECT 1 FROM mandatory m WHERE m.instance_id = e.instance_id)
        ORDER BY e.last_seen_at DESC, e.instance_id DESC LIMIT $4
      ) SELECT e.instance_id, e.pod_uid, e.pod_name, e.pod_namespace,
        e.started_at, e.last_seen_at, e.expires_at, e.accepting_claims, e.busy, e.current_job_id,
        e.expires_at > $1::timestamptz AS fresh,
        NOT EXISTS (SELECT 1 FROM mandatory m WHERE m.instance_id = e.instance_id) AS recent_only,
        COALESCE(r.job_ids, ARRAY[]::uuid[]) AS running_job_ids
      FROM executor_registry e LEFT JOIN running r ON r.instance_id = e.instance_id
      WHERE e.instance_id IN (SELECT instance_id FROM mandatory UNION ALL SELECT instance_id FROM recent)
      ORDER BY e.started_at DESC, e.instance_id DESC LIMIT $5`,
      [now, podUids, ADMIN_LIMITS.recentSeconds, ADMIN_LIMITS.recentLimit + 1, ADMIN_LIMITS.maxExecutors + ADMIN_LIMITS.recentLimit + 2]);
      const mandatory = result.rows.filter((row) => !row.recent_only);
      const recent = result.rows.filter((row) => row.recent_only);
      if (mandatory.length > ADMIN_LIMITS.maxExecutors || result.rows.length > ADMIN_LIMITS.maxExecutors + ADMIN_LIMITS.recentLimit + 1
        || result.rows.some((row) => row.running_job_ids.length > 10_000)) {
        throw new Error('Перевищено межу реєстру.');
      }
      const rows = [...mandatory, ...recent.slice(0, ADMIN_LIMITS.recentLimit)];
      const value: AdminDatabaseSnapshot = { observedAt: now.toISOString(), counts: {
        queued: Number(counts.rows[0]!.queued), running: Number(counts.rows[0]!.running), completed: Number(counts.rows[0]!.completed),
        cancelled: Number(counts.rows[0]!.cancelled), failed: Number(counts.rows[0]!.failed),
      }, recentTruncated: recent.length > ADMIN_LIMITS.recentLimit,
      executors: rows.map((row) => ({ instanceId: row.instance_id, podUid: row.pod_uid, podName: row.pod_name, podNamespace: row.pod_namespace,
        startedAt: row.started_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(), expiresAt: row.expires_at.toISOString(),
        acceptingClaims: row.accepting_claims, fresh: row.fresh, busy: row.busy || row.current_job_id !== null || row.running_job_ids.length > 0,
        currentJobId: row.running_job_ids[0] ?? row.current_job_id, runningJobIds: row.running_job_ids })) };
      await query('COMMIT'); return value;
    });
  }
  jobs(options: AdminJobsOptions, deadline: number, signal: AbortSignal): Promise<AdminJobsResponse> {
    return adminRead(this.pool, deadline, signal, async (query) => {
      await query(BEGIN);
      const statuses = options.status === undefined ? null : options.status === 'active' ? ['queued', 'running'] : [options.status];
      const values = [statuses, options.executedBy ?? null];
      const counts = await query<{ total: string; snapshot_at: Date }>(`SELECT COUNT(*)::text AS total, clock_timestamp() AS snapshot_at
        FROM jobs j WHERE ($1::text[] IS NULL OR j.status = ANY($1::text[])) AND ($2::uuid IS NULL OR j.instance_id = $2::uuid)`, values);
      const result = await query<JobRow>(`SELECT j.id, j.user_id, u.username, j.status, j.progress_stage,
        j.completed_iterations::text, j.total_iterations::text, j.progress_percent,
        j.cancel_requested_at IS NOT NULL AS cancel_requested, j.created_at, j.updated_at, j.started_at, j.finished_at,
        j.instance_id, j.failure_reason FROM jobs j JOIN users u ON u.id = j.user_id
        WHERE ($1::text[] IS NULL OR j.status = ANY($1::text[])) AND ($2::uuid IS NULL OR j.instance_id = $2::uuid)
        ORDER BY j.created_at DESC, j.id DESC LIMIT $3 OFFSET $4`, [...values, options.limit, options.offset]);
      await query('COMMIT');
      return { jobs: result.rows.map(projectJob), total: Number(counts.rows[0]!.total), limit: options.limit, offset: options.offset,
        snapshotAt: counts.rows[0]!.snapshot_at.toISOString() };
    });
  }
}
