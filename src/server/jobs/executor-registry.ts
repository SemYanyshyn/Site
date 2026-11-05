// Тут повідомляю PostgreSQL, що процес живий і має один обчислювальний слот
// У реєстрі зберігаю зайнятість, поточну задачу й готовність брати нові задачі
// Кількість живих pod сама по собі ще не означає стільки ж вільних виконавців

import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type { ExecutorConfig, ExecutorPodMetadata } from './executor-config.js';
import { readExecutorPodMetadata, validateExecutorConfig } from './executor-config.js';

export interface ExecutorRegistrationState {
  acceptingClaims: boolean;
  busy: boolean;
  currentJobId: string | null;
}

// Порівнюю значущі поля стану, щоб помітити їх зміну під час запису heartbeat
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

  // Вважаю реєстрацію чинною лише до її локального дедлайну та до початку зупинки
  get confirmed(): boolean {
    return this.#confirmed && !this.#stopping && performance.now() < this.#lastConfirmedUntil;
  }

  // Після невдалого запису забороняю нові claim до наступного підтвердження реєстрації
  invalidate(): void {
    this.#confirmed = false;
    this.#nextRetryAt = performance.now() + this.#config.heartbeatIntervalMs;
  }

  // Отримую функцію актуального стану та обробник збою, після чого запускаю перший heartbeat
  start(state: () => ExecutorRegistrationState, onFailure: () => Promise<void>): void {
    if (this.#state || this.#stopping) throw new Error('Реєстр виконавця вже запущено або зупинено.');
    this.#state = state;
    this.#onFailure = onFailure;
    void this.refresh();
  }

  // Об’єдную одночасні звернення в одну операцію, щоб SQL-записи не накопичувалися в черзі
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

  // Створюю або оновлюю запис цього instanceId одним UPSERT
  // Строк expires_at рахую за часом PostgreSQL, щоб різниця годинників серверів не спотворила свіжість
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
    // На отримання з’єднання пул дає до 2 с, додатково резервую 250 мс на налаштування
    // І ще 500 мс на запис зупинки, щоб укластися у спільний бюджет 3 с
    const client = await this.#pool.connect();
    try {
      if (shutdownDeadline - performance.now() < 750) return;
      const limit = { text: "SELECT set_config('statement_timeout', '500ms', false)", query_timeout: 250 };
      await client.query(limit);
      const update = { text, values, query_timeout: 500 };
      await client.query(update);
    } finally {
      // Закриваю це з’єднання назавжди, щоб змінений таймаут або незавершений запит не повернувся в пул
      client.release(true);
    }
  }

  // Записую найновіший стан і підтверджую реєстрацію тільки після успішного SQL
  // При збої повідомляю диспетчеру, щоб він не продовжував обчислення без контролю
  async #refresh(): Promise<boolean> {
    try {
      // Якщо стан змінився під час SQL, перед завершенням зберігаю його найновішу версію
      // Claim чекає на цю ж операцію, а heartbeat не створює чергу паралельних записів
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
        try { await this.#onFailure?.(); } catch { /* Диспетчер продовжує утримувати свою резервацію слота */ }
      }
      return false;
    }
  }

  // Повторні виклики зупинки повертаю до тієї самої операції завершення
  shutdown(deadline = performance.now() + 3_800): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown(deadline);
    return this.#shutdownPromise;
  }

  // Вимикаю таймер, чекаю поточний heartbeat і за наявності часу записую acceptingClaims=false
  async #shutdown(deadline: number): Promise<void> {
    this.#stopping = true;
    this.#confirmed = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    // Перед фінальним записом зупинки чекаю вже запущений heartbeat
    // Так запізнілий запис готовності не перезапише зупинку, а після завершення можна закрити пул
    await this.#operation;
    if (deadline - performance.now() < 3_000 || !this.#state) return;
    const state = this.#state();
    try { await this.#write({ ...state, acceptingClaims: false }, deadline); } catch { /* Після закінчення TTL недоступний процес перестане враховуватися */ }
  }
}
