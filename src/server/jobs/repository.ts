import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import type { JobDetails, JobFailureReason, JobListResponse, JobStatus, JobSummary, JobTerminal } from '../../shared/jobs.js';
import type { NormalizedRouteInput, RouteProgress, RouteResult } from '../../shared/route.js';
import { databaseUnavailable, HttpError } from '../auth/errors.js';
import type { JobsConfig } from './config.js';
import { queryQueueSnapshot, readQueueSnapshot } from './queue-snapshot.js';

export type { JobTerminal } from '../../shared/jobs.js';

export interface JobClaim {
  id: string;
  claimToken: string;
  input: NormalizedRouteInput;
}

export interface JobListOptions {
  limit: number;
  offset: number;
  status?: JobStatus | 'active';
}

interface SummaryRow {
  id: string;
  status: JobStatus;
  progress_stage: RouteProgress['stage'];
  completed_iterations: string;
  total_iterations: string;
  progress_percent: number;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  instance_id: string | null;
  failure_reason: JobFailureReason | null;
}

interface DetailsRow extends SummaryRow {
  input: NormalizedRouteInput;
  result: RouteResult | null;
}

const SUMMARY_COLUMNS = `id, status, progress_stage, completed_iterations, total_iterations, progress_percent,
  cancel_requested_at, created_at, updated_at, started_at, finished_at, instance_id, failure_reason`;
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, input, result`;

const FAILURE_MESSAGES: Readonly<Record<JobFailureReason, string>> = Object.freeze({
  timeout: 'Перевищено серверний час обчислення. Роботу зупинено.',
  worker_error: 'Обчислювальний потік завершився з помилкою. Подайте нову задачу.',
  server_shutdown: 'Сервер завершив роботу й зупинив обчислення. Подайте нову задачу.',
  database_unavailable: 'Обчислення зупинено через втрату зв’язку з базою даних.',
  invalid_input: 'Збережений вхід не відповідає поточним обмеженням сервера.',
  worker_lost: 'Виконавця втрачено після граничного часу задачі. Подайте нову задачу.',
});

function summary(row: SummaryRow): JobSummary {
  const value: JobSummary = {
    id: row.id,
    status: row.status,
    progress: {
      stage: row.progress_stage,
      completedIterations: Number(row.completed_iterations),
      totalIterations: Number(row.total_iterations),
      percent: row.progress_percent,
    },
    cancelRequested: row.cancel_requested_at !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    executedBy: row.instance_id,
  };
  if (row.status === 'failed' && row.failure_reason) {
    value.error = { reason: row.failure_reason, message: FAILURE_MESSAGES[row.failure_reason] };
  }
  return value;
}

function details(row: DetailsRow): JobDetails {
  const value: JobDetails = { ...summary(row), input: row.input };
  if (row.status === 'completed' && row.result) value.result = row.result;
  return value;
}

// operation виконує кілька запитів на одному з'єднанні і вони або всі підтверджуються або відкочуються
async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '3000ms'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof HttpError) throw error;
    throw databaseUnavailable();
  } finally {
    client?.release();
  }
}

// тут читаю й змінюю спільний стан задач у PostgreSQL без окремої черги в пам'яті
export class JobsRepository {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, input: NormalizedRouteInput, config: JobsConfig): Promise<JobDetails> {
    return transaction(this.pool, async (client) => {
      // advisory lock серіалізує створення задач щоб два сервери не обійшли ліміти одночасно
      // завершення лише зменшує лічильники тому цього блокування не потребує
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [18024, 4]);
      const counts = await client.query<{ personal: string; outstanding: string }>(`
        SELECT COUNT(*) FILTER (WHERE user_id = $1)::text AS personal, COUNT(*)::text AS outstanding
        FROM jobs WHERE status IN ('queued', 'running')
      `, [userId]);
      const current = counts.rows[0]!;
      if (Number(current.personal) >= config.maxActivePerUser) {
        throw new HttpError(429, 'USER_ACTIVE_LIMIT', 'Досягнуто ліміту ваших незавершених задач. Дочекайтеся завершення або скасуйте задачу.');
      }
      if (Number(current.outstanding) >= config.maxOutstanding) {
        throw new HttpError(503, 'SYSTEM_OUTSTANDING_LIMIT', 'Спільна черга заповнена. Спробуйте пізніше.');
      }
      // нова задача отримує queued за замовчуванням у БД а її запуск відбудеться після commit
      const inserted = await client.query<DetailsRow>(`
        INSERT INTO jobs(id, user_id, input, total_iterations) VALUES ($1, $2, $3::jsonb, $4)
        RETURNING ${DETAIL_COLUMNS}
      `, [randomUUID(), userId, JSON.stringify(input), input.iterations]);
      return details(inserted.rows[0]!);
    });
  }

  async list(userId: string, options: JobListOptions): Promise<JobListResponse> {
    const statuses = options.status === undefined ? null
      : options.status === 'active' ? ['queued', 'running'] : [options.status];
    try {
      const result = await this.pool.query<SummaryRow>(`
        SELECT ${SUMMARY_COLUMNS} FROM jobs
        WHERE user_id = $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
        ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4
      `, [userId, statuses, options.limit, options.offset]);
      return { jobs: result.rows.map(summary), limit: options.limit, offset: options.offset };
    } catch {
      throw databaseUnavailable();
    }
  }

  async get(userId: string, id: string): Promise<JobDetails | null> {
    try {
      const result = await this.pool.query<DetailsRow>(`
        SELECT ${DETAIL_COLUMNS} FROM jobs WHERE id = $1 AND user_id = $2
      `, [id, userId]);
      return result.rows[0] ? details(result.rows[0]) : null;
    } catch {
      throw databaseUnavailable();
    }
  }

  /** Ownership, detail, capacity and queue metadata share one short MVCC
   * snapshot. This read never acquires the admission or claim locks. */
  async getWithQueue(userId: string, id: string, timeoutMs: number,
    deadline = performance.now() + 8_000): Promise<JobDetails | null> {
    let client: PoolClient | undefined;
    let discard = false;
    try {
      if (!Number.isFinite(deadline) || deadline <= performance.now()) throw databaseUnavailable();
      client = await this.pool.connect();
      // PostgreSQL 18 is the project's runtime. The transaction-wide limit
      // complements the 8s monotonic deadline, including the <=2s acquisition,
      // setup and commit, below the browser's 10-second request timeout.
      await queryQueueSnapshot(client, deadline, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SET LOCAL statement_timeout = '1000ms';
        SET LOCAL lock_timeout = '500ms';
        SET LOCAL idle_in_transaction_session_timeout = '1500ms';
        SET LOCAL transaction_timeout = '5000ms'`);
      const result = await queryQueueSnapshot<DetailsRow & { queue_calculated_at: Date }>(client, deadline, `
        SELECT ${DETAIL_COLUMNS}, clock_timestamp() AS queue_calculated_at
        FROM jobs WHERE id = $1 AND user_id = $2
      `, [id, userId]);
      const row = result.rows[0];
      if (!row) { await queryQueueSnapshot(client, deadline, 'COMMIT'); return null; }
      const value = details(row);
      if (value.status === 'queued') {
        value.queue = await readQueueSnapshot(client, id, row.queue_calculated_at.toISOString(), timeoutMs, deadline);
      }
      await queryQueueSnapshot(client, deadline, 'COMMIT');
      return value;
    } catch (error) {
      // Closing a failed read-only session rolls its transaction back. Do not
      // start another SQL round trip after an expired response budget.
      discard = true;
      if (error instanceof HttpError) throw error;
      throw databaseUnavailable();
    } finally { client?.release(discard); }
  }

  async cancel(userId: string, id: string): Promise<JobDetails | null> {
    try {
      // queued скасовую одразу а running лише отримує прапорець для фізичної зупинки worker
      // UPDATE блокує рядок і узгоджує cancel з claim або завершенням не змінюючи вже кінцеві дані
      const result = await this.pool.query<DetailsRow>(`
        UPDATE jobs SET
          status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
          cancel_requested_at = CASE WHEN status IN ('queued', 'running') THEN COALESCE(cancel_requested_at, clock_timestamp()) ELSE cancel_requested_at END,
          finished_at = CASE WHEN status = 'queued' THEN clock_timestamp() ELSE finished_at END,
          updated_at = CASE WHEN status IN ('queued', 'running') THEN clock_timestamp() ELSE updated_at END
        WHERE id = $1 AND user_id = $2 RETURNING ${DETAIL_COLUMNS}
      `, [id, userId]);
      return result.rows[0] ? details(result.rows[0]) : null;
    } catch {
      throw databaseUnavailable();
    }
  }

  // SKIP LOCKED пропускає вже захоплені рядки а новий claim token позначає право саме цього запуску
  async claim(instanceId: string, timeoutMs: number, graceMs: number): Promise<JobClaim | null> {
    return transaction(this.pool, async (client) => {
      const token = randomUUID();
      const result = await client.query<{ id: string; claim_token: string; input: NormalizedRouteInput }>(`
        WITH next_job AS (
          SELECT id FROM jobs WHERE status = 'queued'
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE jobs AS j SET status = 'running', instance_id = $1, claim_token = $2,
          started_at = clock_timestamp(), updated_at = clock_timestamp(), timeout_ms = $3,
          lost_after = clock_timestamp() + ($3::integer + $4::integer) * INTERVAL '1 millisecond'
        FROM next_job WHERE j.id = next_job.id AND j.status = 'queued'
        RETURNING j.id, j.claim_token, j.input
      `, [instanceId, token, timeoutMs, graceMs]);
      const row = result.rows[0];
      return row ? { id: row.id, claimToken: row.claim_token, input: row.input } : null;
    });
  }

  // id і claim token не дають старому виконавцю перезаписати прогрес чужого або вже завершеного запуску
  async saveProgress(claim: JobClaim, progress: RouteProgress): Promise<boolean> {
    const stage = { preparing: 0, searching: 1, finishing: 2 } as const;
    if (!Object.hasOwn(stage, progress.stage)
      || !Number.isSafeInteger(progress.completedIterations) || !Number.isSafeInteger(progress.totalIterations)
      || progress.completedIterations < 0 || progress.totalIterations !== claim.input.iterations
      || progress.completedIterations > progress.totalIterations
      || !Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent >= 100
      || (progress.stage === 'preparing' && (progress.completedIterations !== 0 || progress.percent !== 0))) return false;
    try {
      const result = await this.pool.query(`
        UPDATE jobs SET progress_stage = $3, completed_iterations = $4, progress_percent = $5, updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'running' AND claim_token = $2
          AND total_iterations = $6 AND completed_iterations <= $4 AND progress_percent <= $5
          AND CASE progress_stage WHEN 'preparing' THEN 0 WHEN 'searching' THEN 1 ELSE 2 END <= $7
      `, [claim.id, claim.claimToken, progress.stage, progress.completedIterations, progress.percent,
        progress.totalIterations, stage[progress.stage]]);
      return (result.rowCount ?? 0) > 0;
    } catch {
      throw databaseUnavailable();
    }
  }

  async control(claim: JobClaim): Promise<'running' | 'cancel_requested' | 'lost'> {
    try {
      const result = await this.pool.query<{ cancel_requested_at: Date | null }>(`
        SELECT cancel_requested_at FROM jobs WHERE id = $1 AND status = 'running' AND claim_token = $2
      `, [claim.id, claim.claimToken]);
      const row = result.rows[0];
      return row ? row.cancel_requested_at ? 'cancel_requested' : 'running' : 'lost';
    } catch {
      throw databaseUnavailable();
    }
  }

  // зберігаю кінцевий стан і результат а вже прийнятий cancel у БД має пріоритет
  async finish(claim: JobClaim, terminal: JobTerminal, queryTimeoutMs?: number): Promise<boolean> {
    if (queryTimeoutMs !== undefined && (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 1_000)) {
      throw new RangeError('Некоректний бюджет фінального запису задачі.');
    }
    const completed = terminal.status === 'completed' ? terminal.result : null;
    const reason = terminal.status === 'failed' ? terminal.reason : null;
    // Never persist raw errors or caller-provided exception text.
    const message = reason ? FAILURE_MESSAGES[reason] : null;
    try {
      const query = { text: `
        UPDATE jobs SET
          status = CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE $3 END,
          result = CASE WHEN cancel_requested_at IS NULL AND $3 = 'completed' THEN $4::jsonb ELSE NULL END,
          failure_reason = CASE WHEN cancel_requested_at IS NULL AND $3 = 'failed' THEN $5 ELSE NULL END,
          failure_message = CASE WHEN cancel_requested_at IS NULL AND $3 = 'failed' THEN $6 ELSE NULL END,
          progress_stage = CASE WHEN cancel_requested_at IS NULL AND $3 = 'completed' THEN 'finishing' ELSE progress_stage END,
          completed_iterations = CASE WHEN cancel_requested_at IS NULL AND $3 = 'completed' THEN $7::bigint ELSE completed_iterations END,
          progress_percent = CASE WHEN cancel_requested_at IS NULL AND $3 = 'completed' THEN 100 ELSE progress_percent END,
          finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = $1 AND status = 'running' AND claim_token = $2
      `, values: [claim.id, claim.claimToken, terminal.status, completed ? JSON.stringify(completed) : null,
        reason, message, completed?.iterationsCompleted ?? null] };
      const result = queryTimeoutMs === undefined ? await this.pool.query(query) : await (async () => {
        // Shutdown has a smaller remaining budget. Bound server execution as
        // well as node-postgres' reply wait; destroy this dedicated connection
        // so its session setting and any timed-out operation never reenter pool.
        const client = await this.pool.connect();
        try {
          const setting = { text: "SELECT set_config('statement_timeout', $1, false)",
            values: [`${queryTimeoutMs}ms`], query_timeout: 250 };
          const bounded = { ...query, query_timeout: queryTimeoutMs };
          await client.query(setting);
          return await client.query(bounded);
        } finally { client.release(true); }
      })();
      return (result.rowCount ?? 0) > 0;
    } catch {
      throw databaseUnavailable();
    }
  }

  // після збереженого lost_after позначаю втрачений running як failed без автоматичного повтору
  async recoverLost(): Promise<number> {
    try {
      const result = await this.pool.query(`
        UPDATE jobs SET status = 'failed', failure_reason = 'worker_lost', failure_message = $1,
          finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE status = 'running' AND lost_after <= clock_timestamp()
      `, [FAILURE_MESSAGES.worker_lost]);
      return result.rowCount ?? 0;
    } catch {
      throw databaseUnavailable();
    }
  }
}
