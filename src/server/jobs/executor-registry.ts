import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type { ExecutorConfig, ExecutorPodMetadata } from './executor-config.js';
import { readExecutorPodMetadata, validateExecutorConfig } from './executor-config.js';

export interface ExecutorRegistrationState {
  acceptingClaims: boolean;
  busy: boolean;
  currentJobId: string | null;
}

function same(left: ExecutorRegistrationState, right: ExecutorRegistrationState): boolean {
  return left.acceptingClaims === right.acceptingClaims && left.busy === right.busy && left.currentJobId === right.currentJobId;
}

// heartbeat записує живий процес і його один слот з TTL без черги паралельних SQL записів
export class ExecutorRegistry {
  readonly #pool: Pool;
  readonly #instanceId: string;
  readonly #config: ExecutorConfig;
  readonly #metadata: ExecutorPodMetadata;
  #state: (() => ExecutorRegistrationState) | undefined;
  #onFailure: (() => Promise<void>) | undefined;
  #operation: Promise<boolean> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastConfirmedUntil = 0;
  #confirmed = false;
  #nextRetryAt = 0;
  #stopping = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(pool: Pool, instanceId: string, config: ExecutorConfig, metadata: ExecutorPodMetadata = readExecutorPodMetadata()) {
    this.#pool = pool;
    this.#instanceId = instanceId;
    this.#config = validateExecutorConfig(config);
    this.#metadata = readExecutorPodMetadata(metadata.podUid === null && metadata.podName === null && metadata.podNamespace === null
      ? {} : { POD_UID: metadata.podUid ?? undefined, POD_NAME: metadata.podName ?? undefined, POD_NAMESPACE: metadata.podNamespace ?? undefined });
  }

  get confirmed(): boolean {
    return this.#confirmed && !this.#stopping && performance.now() < this.#lastConfirmedUntil;
  }

  invalidate(): void {
    this.#confirmed = false;
    this.#nextRetryAt = performance.now() + this.#config.heartbeatIntervalMs;
  }

  start(state: () => ExecutorRegistrationState, onFailure: () => Promise<void>): void {
    if (this.#state || this.#stopping) throw new Error('Реєстр виконавця вже запущено або зупинено.');
    this.#state = state;
    this.#onFailure = onFailure;
    void this.refresh();
  }

  refresh(): Promise<boolean> {
    if (this.#stopping || !this.#state) return Promise.resolve(false);
    if (this.#operation) return this.#operation;
    if (!this.#confirmed && performance.now() < this.#nextRetryAt) return Promise.resolve(false);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const operation = this.#refresh();
    this.#operation = operation;
    void operation.finally(() => {
      if (this.#operation === operation) this.#operation = undefined;
      if (!this.#stopping) {
        this.#timer = setTimeout(() => { this.#timer = undefined; void this.refresh(); }, this.#config.heartbeatIntervalMs);
        this.#timer.unref();
      }
    });
    return operation;
  }

  async #write(state: ExecutorRegistrationState, shutdownDeadline?: number): Promise<void> {
    const text = `
      WITH stamp AS (SELECT clock_timestamp() AS now)
      INSERT INTO executor_registry(instance_id, started_at, last_seen_at, expires_at, accepting_claims, busy, current_job_id,
        pod_uid, pod_name, pod_namespace)
      SELECT $1::uuid, now, now, now + $2::integer * INTERVAL '1 millisecond', $3::boolean, $4::boolean, $5::uuid,
        $6::uuid, $7::text, $8::text
      FROM stamp
      ON CONFLICT(instance_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
        expires_at = EXCLUDED.expires_at, accepting_claims = EXCLUDED.accepting_claims,
        busy = EXCLUDED.busy, current_job_id = EXCLUDED.current_job_id,
        pod_uid = EXCLUDED.pod_uid, pod_name = EXCLUDED.pod_name, pod_namespace = EXCLUDED.pod_namespace
    `;
    const values = [this.#instanceId, this.#config.leaseTtlMs, state.acceptingClaims, state.busy, state.currentJobId,
      this.#metadata.podUid, this.#metadata.podName, this.#metadata.podNamespace];
    if (shutdownDeadline === undefined) {
      await this.#pool.query(text, values);
      return;
    }
    // Acquisition is bounded by the pool's 2s limit. Reserve 250ms for setting
    // the server limit plus 500ms for the stopping write, within a 3s budget.
    const client = await this.#pool.connect();
    try {
      if (shutdownDeadline - performance.now() < 750) return;
      const limit = { text: "SELECT set_config('statement_timeout', '500ms', false)", query_timeout: 250 };
      await client.query(limit);
      const update = { text, values, query_timeout: 500 };
      await client.query(update);
    } finally {
      // A changed session limit or timed-out query must never return to the pool.
      client.release(true);
    }
  }

  async #refresh(): Promise<boolean> {
    try {
      // If a transition happened during SQL, persist just the newest state before
      // resolving. Claim waits on this same operation; heartbeats never enqueue.
      for (let attempt = 0; attempt < 2 && !this.#stopping && this.#state; attempt++) {
        const state = this.#state();
        const issuedAt = performance.now();
        await this.#write(state);
        if (this.#stopping) return false;
        this.#confirmed = true;
        // локальний час лише забороняє собі новий claim після TTL а публічну свіжість визначає час БД
        this.#lastConfirmedUntil = issuedAt + this.#config.leaseTtlMs;
        if (same(state, this.#state())) return true;
      }
      return false;
    } catch {
      this.invalidate();
      if (!this.#stopping) {
        try { await this.#onFailure?.(); } catch { /* The owning dispatcher retains its reservation. */ }
      }
      return false;
    }
  }

  shutdown(deadline = performance.now() + 3_800): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown(deadline);
    return this.#shutdownPromise;
  }

  async #shutdown(deadline: number): Promise<void> {
    this.#stopping = true;
    this.#confirmed = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    // Drain an issued heartbeat before the final stopping write; no late ready
    // update may overwrite it, and callers may close the pool after this resolves.
    await this.#operation;
    if (deadline - performance.now() < 3_000 || !this.#state) return;
    const state = this.#state();
    try { await this.#write({ ...state, acceptingClaims: false }, deadline); } catch { /* TTL excludes an unreachable process. */ }
  }
}
