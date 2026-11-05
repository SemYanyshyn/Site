// Тут з’єдную спільну чергу PostgreSQL з одним локальним RouteExecutor
// Диспетчер періодично бере задачу, передає worker, записує прогрес і узгоджує кінцевий стан
// Слот утримую до фізичного завершення потоку та погодження результату в базі

import { performance } from 'node:perf_hooks';
import type { RouteLimits, RouteOutcome, RouteProgress } from '../../shared/route.js';
import { RouteExecutor } from '../route/executor.js';
import type { RouteRun } from '../route/executor.js';
import { RouteValidationError } from '../route/validation.js';
import type { JobsConfig } from './config.js';
import { effectiveWorkerLostGraceMs, validateJobsConfig } from './config.js';
import { JobsRepository } from './repository.js';
import type { JobClaim, JobTerminal } from './repository.js';
import type { ExecutorRegistry } from './executor-registry.js';

/* Передаю внутрішнім тестам лише події процесу без claim token і вхідних координат */
export interface DispatcherEvent {
  type: 'claimed' | 'started' | 'worker_stopped' | 'settled';
  jobId: string;
  instanceId: string;
  runId?: string;
  threadId?: number;
  status?: JobTerminal['status'];
}

export interface DispatcherOptions {
  initiallyPaused?: boolean;
  onEvent?: (event: DispatcherEvent) => void;
}

interface ActiveJob {
  claim: JobClaim;
  run?: RouteRun;
  outcome?: JobTerminal;
  override?: JobTerminal;
  latestProgress?: RouteProgress;
  progressWrite?: Promise<void>;
  lost: boolean;
}

function failed(reason: 'server_shutdown' | 'database_unavailable' | 'invalid_input' | 'worker_error'): JobTerminal {
  const messages = {
    server_shutdown: 'Виконавець припинив обчислення через завершення сервера.',
    database_unavailable: 'Обчислення припинено через недоступність бази даних.',
    invalid_input: 'Збережений вхід не відповідає дозволеним параметрам обчислення.',
    worker_error: 'Не вдалося запустити окремий потік обчислення маршруту.',
  };
  return { status: 'failed', reason, message: messages[reason] };
}

// беру задачу зі спільної черги і передаю її одному локальному worker
export class JobsDispatcher {
  readonly #executor: RouteExecutor;
  readonly #repository: JobsRepository;
  readonly #instanceId: string;
  readonly #routeLimits: RouteLimits;
  readonly #config: JobsConfig;
  readonly #options: DispatcherOptions;
  readonly #registry: ExecutorRegistry;
  readonly #timer: NodeJS.Timeout;
  #active: ActiveJob | undefined;
  #polling = false;
  #claiming = false;
  #finishPending = false;
  #pollPromise: Promise<void> = Promise.resolve();
  #paused: boolean;
  #closing = false;
  #shutdownPromise: Promise<void> | undefined;

  constructor(executor: RouteExecutor, repository: JobsRepository, instanceId: string,
    routeLimits: RouteLimits, config: JobsConfig, registry: ExecutorRegistry, options: DispatcherOptions = {}) {
    validateJobsConfig(config);
    this.#executor = executor;
    this.#repository = repository;
    this.#instanceId = instanceId;
    this.#routeLimits = { ...routeLimits };
    this.#config = { ...config };
    this.#options = options;
    this.#registry = registry;
    this.#paused = options.initiallyPaused ?? false;
    this.#timer = setInterval(() => { void this.tick(); }, config.pollIntervalMs);
    this.#timer.unref();
    this.#registry.start(() => ({
      acceptingClaims: !this.#paused && !this.#closing,
      busy: this.busy || this.#executor.busy,
      currentJobId: this.#active?.claim.id ?? null,
    }), async () => {
      if (!this.#closing && this.#active) await this.#databaseFailure(this.#active);
    });
    void this.tick();
  }

  get busy(): boolean { return this.#active !== undefined || this.#claiming; }

  /* При паузі внутрішнього тесту забороняю нові claim, але продовжую перевіряти скасування активної задачі */
  pause(): void {
    this.#paused = true;
    if (!this.#closing) void this.#registry.refresh();
  }
  resume(): void {
    if (this.#closing) return;
    this.#paused = false;
    void this.tick();
  }

  // Запускаю не більше одного циклу перевірки одночасно, навіть якщо попередній SQL ще не завершився
  tick(): Promise<void> {
    if (this.#closing || this.#polling) return this.#pollPromise;
    // Резервую весь цикл перевірки синхронно до першої асинхронної операції
    this.#polling = true;
    this.#pollPromise = this.#poll().catch(async () => {
      this.#registry.invalidate();
      const active = this.#active;
      if (active) await this.#databaseFailure(active);
    }).finally(() => {
      this.#polling = false;
      const finishPending = this.#finishPending;
      this.#finishPending = false;
      // Після результату worker дозволяю одну негайну спробу записати кінцевий стан
      // Якщо SQL не спрацював, повторюю за звичайним інтервалом без нескінченного швидкого циклу
      if (finishPending && !this.#closing && this.#active?.outcome) void this.tick();
    });
    return this.#pollPromise;
  }

  // Спочатку підтверджую реєстрацію й контролюю активну задачу
  // Лише за вільного слота забираю нову queued, після commit запускаю executor
  async #poll(): Promise<void> {
    if (!this.#registry.confirmed && !await this.#registry.refresh()) return;
    if (this.#closing) return;
    const finished = this.#active;
    if (finished?.outcome) {
      // Спочатку зберігаю відому фізичну зупинку свого worker, а потім шукаю інші втрачені задачі
      await this.#finalize(finished);
      if (!this.#closing) await this.#repository.recoverLost();
      return;
    }
    await this.#repository.recoverLost();
    if (this.#closing) return;
    const active = this.#active;
    if (active) {
      if (!active.outcome) {
        const control = await this.#repository.control(active.claim);
        if (control === 'lost') {
          active.lost = true;
          await this.#stop(active);
        } else if (control === 'cancel_requested') await this.#stop(active);
      }
      if (this.#closing) return;
      if (active.outcome) await this.#finalize(active);
      return;
    }
    // Враховую, що прямий запуск executor із внутрішнього тесту також займає цей слот
    if (this.#paused || this.#executor.busy || this.#closing) return;
    this.#claiming = true;
    let claim: JobClaim | null = null;
    try {
      // Позначаю слот зайнятим ще до commit транзакції, яка забирає задачу
      // Так попередній heartbeat зі станом вільно не створить хибне уявлення про доступний слот
      if (!await this.#registry.refresh() || this.#paused || this.#closing) return;
      claim = await this.#repository.claim(this.#instanceId, this.#routeLimits.timeoutMs,
        effectiveWorkerLostGraceMs(this.#config));
    } finally {
      this.#claiming = false;
      if (!claim && !this.#closing) void this.#registry.refresh();
    }
    if (!claim) return;
    const reservation: ActiveJob = { claim, lost: false };
    // worker стартує лише після commit claim а резервація лишається до узгодження кінцевого стану в БД
    this.#active = reservation;
    this.#event('claimed', reservation);
    if (this.#closing) {
      reservation.outcome = failed('server_shutdown');
      return;
    }
    if (!this.#registry.confirmed || reservation.override || reservation.lost) {
      reservation.outcome = failed('database_unavailable');
      this.#requestFinalization(reservation);
      return;
    }
    // Після commit рядок running уже пов’язує задачу з цим процесом
    // Heartbeat ще може містити current_job_id=NULL, але додаткового очікування SQL тут не додаю
    // Між записом lost_after і стартом worker не витрачаю час на ще один запит до бази
    // Цей час уже зарезервований для claim, прогресу й завершення, а збій heartbeat усе одно зупинить запуск
    void this.#registry.refresh();
    if (this.#closing) {
      reservation.outcome = failed('server_shutdown');
      return;
    }
    try {
      const run = this.#executor.start(claim.input, (progress) => this.#progress(reservation, progress));
      reservation.run = run;
      if (run.threadId > 0) this.#event('started', reservation, { runId: run.runId, threadId: run.threadId });
      void run.result.then((outcome: RouteOutcome) => {
        reservation.outcome = reservation.override ?? outcome;
        this.#event('worker_stopped', reservation, { runId: run.runId, threadId: -1,
          status: reservation.outcome.status });
        this.#requestFinalization(reservation);
      });
    } catch (error: unknown) {
      reservation.outcome = failed(error instanceof RouteValidationError ? 'invalid_input' : 'worker_error');
      this.#requestFinalization(reservation);
    }
  }

  // Після зупинки worker прошу якнайшвидше зберегти кінцевий результат без очікування наступного таймера
  #requestFinalization(active: ActiveJob): void {
    if (this.#closing || this.#active !== active || !active.outcome) return;
    if (this.#polling) this.#finishPending = true;
    else void this.tick();
  }

  // Залишаю найсвіжіший прогрес і не дозволяю попередньому повідомленню перезаписати нове
  #progress(active: ActiveJob, progress: RouteProgress): void {
    if (this.#closing || this.#active !== active || active.outcome || active.override || progress.percent >= 100) return;
    active.latestProgress = { ...progress };
    this.#pumpProgress(active);
  }

  // Пишу прогрес одним SQL-запитом за раз, не накопичую всі проміжні повідомлення worker
  #pumpProgress(active: ActiveJob): void {
    if (this.#closing || active.progressWrite || !active.latestProgress || active.lost || active.override) return;
    const progress = active.latestProgress;
    delete active.latestProgress;
    // тримаю один SQL запис і лише найсвіжіший прогрес щоб callback не накопичували чергу записів
    active.progressWrite = this.#repository.saveProgress(active.claim, progress).then(async (saved) => {
      if (!saved) {
        active.lost = true;
        await this.#stop(active);
      }
    }).catch(async () => { await this.#databaseFailure(active); }).finally(() => {
      delete active.progressWrite;
      if (!this.#closing && !active.outcome) this.#pumpProgress(active);
    });
  }

  // При втраті контролю через базу зупиняю worker з інфраструктурною причиною
  // Не називаю це добровільним скасуванням користувача
  async #databaseFailure(active: ActiveJob): Promise<void> {
    this.#registry.invalidate();
    // Скасування від RouteExecutor означає фізичну зупинку потоку
    // Окремо зберігаю інфраструктурну причину, щоб не видати її за добровільне скасування користувачем
    active.override ??= failed('database_unavailable');
    delete active.latestProgress;
    if (active.outcome) active.outcome = active.override;
    await this.#stop(active);
  }

  // Чекаю фізичного завершення потоку через executor.cancel
  async #stop(active: ActiveJob): Promise<void> {
    if (active.run) await this.#executor.cancel(active.run.runId);
    else active.outcome ??= active.override ?? { status: 'cancelled' };
  }

  // Перед кінцевим записом дочікуюся вже початого збереження прогресу
  async #flushProgress(active: ActiveJob): Promise<void> {
    if (active.progressWrite) await active.progressWrite;
    if (active.latestProgress && !active.lost && !active.override) {
      this.#pumpProgress(active);
      if (active.progressWrite) await active.progressWrite;
    }
  }

  // Узгоджую результат worker із PostgreSQL і тільки тоді звільняю резервацію
  // При втраті claim token не переписую стан, який уже контролює інше виконання
  async #finalize(active: ActiveJob, duringShutdown = false): Promise<void> {
    await this.#flushProgress(active);
    if (this.#closing && !duringShutdown) return;
    if (!active.outcome) return;
    if (active.lost) {
      if (this.#active === active) this.#active = undefined;
      if (!this.#closing) void this.#registry.refresh();
      return;
    }
    // тут слот ще зарезервований бо результат потрібно спочатку зберегти в БД
    // якщо SQL падає наступний poll повторить спробу а нова задача поки не стартує
    const saved = await this.#repository.finish(active.claim, active.override ?? active.outcome, duringShutdown ? 500 : undefined);
    // Пам’ятаю, що repository може надати пріоритет уже збереженому запиту користувача на скасування
    // Тому ця внутрішня подія ще не оголошує остаточний статус у базі
    if (saved) this.#event('settled', active);
    if (this.#active === active) this.#active = undefined;
    if (!this.#closing) void this.#registry.refresh();
  }

  // Передаю внутрішнім тестам подію без координат і приватного claim token
  #event(type: DispatcherEvent['type'], active: ActiveJob,
    extra: Pick<DispatcherEvent, 'runId' | 'threadId' | 'status'> = {}): void {
    try {
      const returned: unknown = this.#options.onEvent?.({ type, jobId: active.claim.id,
        instanceId: this.#instanceId, ...extra });
      void Promise.resolve(returned).catch(() => {});
    } catch { /* Не дозволяю спостерігачу тесту змінити життєвий цикл задачі */ }
  }

  // Роблю завершення ідемпотентним, тобто повторний виклик не запускає другу зупинку
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

  // Припиняю нові claim, зупиняю worker і дочікуюся вже початих операцій
  // Фінальний запис роблю тільки за достатнього залишку часу без нескінченних повторів
  async #shutdown(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#timer);
    const deadline = performance.now() + 3_800;
    const registrationStopped = this.#registry.shutdown(deadline);
    const active = this.#active;
    if (active && !active.outcome) {
      active.override = failed('server_shutdown');
      void this.#stop(active);
    }
    // Чекаю завершення вже початих операцій перед закриттям пулу
    // Так їхнє відкладене продовження не запустить новий SQL-запит після початку закриття
    await this.#pollPromise;
    const reservation = this.#active;
    if (!reservation) { await registrationStopped; return; }
    if (!reservation.outcome) reservation.override = failed('server_shutdown');
    await this.#stop(reservation);
    if (reservation.progressWrite) await reservation.progressWrite;
    delete reservation.latestProgress;
    // На окремий фінальний запис залишаю до 2 с отримання з’єднання, 250 мс налаштування і 500 мс UPDATE
    // Якщо часу недостатньо, залишаю збережений running для відновлення за дедлайном
    // При завершенні процесу не повторюю запис і не повертаю змінені налаштування сесії в пул
    if (deadline - performance.now() >= 3_000) {
      try { await this.#finalize(reservation, true); } catch { /* Залишаю можливість відновлення через worker_lost */ }
    }
    await registrationStopped;
  }
}
