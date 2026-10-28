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

/** Internal observations for process tests; neither claim tokens nor inputs escape. */
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

  /** Private harness control: pausing claims never disables an active cancel check. */
  pause(): void {
    this.#paused = true;
    if (!this.#closing) void this.#registry.refresh();
  }
  resume(): void {
    if (this.#closing) return;
    this.#paused = false;
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.#closing || this.#polling) return this.#pollPromise;
    // Reserve the complete polling cycle before its first asynchronous operation.
    this.#polling = true;
    this.#pollPromise = this.#poll().catch(async () => {
      this.#registry.invalidate();
      const active = this.#active;
      if (active) await this.#databaseFailure(active);
    }).finally(() => {
      this.#polling = false;
      const finishPending = this.#finishPending;
      this.#finishPending = false;
      // One worker result permits one eager terminal attempt. A failed SQL
      // write retries on the ordinary interval, never in a recursive busy loop.
      if (finishPending && !this.#closing && this.#active?.outcome) void this.tick();
    });
    return this.#pollPromise;
  }

  async #poll(): Promise<void> {
    if (!this.#registry.confirmed && !await this.#registry.refresh()) return;
    if (this.#closing) return;
    const finished = this.#active;
    if (finished?.outcome) {
      // Persist our known physical stop before considering global lost rows.
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
    // A direct executor run from the previous route harness also owns this slot.
    if (this.#paused || this.#executor.busy || this.#closing) return;
    this.#claiming = true;
    let claim: JobClaim | null = null;
    try {
      // Advertise a reserved slot before the claim transaction can commit. A
      // stale idle heartbeat must not imply a free slot during this transition.
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
    // The committed running row identifies this slot even while its previous
    // heartbeat still says current_job_id=NULL. Do not add another bounded DB
    // round trip between lost_after and worker start: that would consume grace
    // reserved for claim/progress/terminal. A failed update still stops this run.
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

  #requestFinalization(active: ActiveJob): void {
    if (this.#closing || this.#active !== active || !active.outcome) return;
    if (this.#polling) this.#finishPending = true;
    else void this.tick();
  }

  #progress(active: ActiveJob, progress: RouteProgress): void {
    if (this.#closing || this.#active !== active || active.outcome || active.override || progress.percent >= 100) return;
    active.latestProgress = { ...progress };
    this.#pumpProgress(active);
  }

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

  async #databaseFailure(active: ActiveJob): Promise<void> {
    this.#registry.invalidate();
    // Cancellation returned by RouteExecutor describes physical termination only;
    // this cause distinguishes infrastructure failure from the user's DB flag.
    active.override ??= failed('database_unavailable');
    delete active.latestProgress;
    if (active.outcome) active.outcome = active.override;
    await this.#stop(active);
  }

  async #stop(active: ActiveJob): Promise<void> {
    if (active.run) await this.#executor.cancel(active.run.runId);
    else active.outcome ??= active.override ?? { status: 'cancelled' };
  }

  async #flushProgress(active: ActiveJob): Promise<void> {
    if (active.progressWrite) await active.progressWrite;
    if (active.latestProgress && !active.lost && !active.override) {
      this.#pumpProgress(active);
      if (active.progressWrite) await active.progressWrite;
    }
  }

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
    // The repository may give a committed user cancel precedence over this
    // proposed outcome, so this observation does not invent a final DB status.
    if (saved) this.#event('settled', active);
    if (this.#active === active) this.#active = undefined;
    if (!this.#closing) void this.#registry.refresh();
  }

  #event(type: DispatcherEvent['type'], active: ActiveJob,
    extra: Pick<DispatcherEvent, 'runId' | 'threadId' | 'status'> = {}): void {
    try {
      const returned: unknown = this.#options.onEvent?.({ type, jobId: active.claim.id,
        instanceId: this.#instanceId, ...extra });
      void Promise.resolve(returned).catch(() => {});
    } catch { /* Observation must not change the production lifecycle. */ }
  }

  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown();
    return this.#shutdownPromise;
  }

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
    // Drain already issued operations; do not leave a raced continuation that
    // could issue another SQL query after the caller starts closing the Pool.
    await this.#pollPromise;
    const reservation = this.#active;
    if (!reservation) { await registrationStopped; return; }
    if (!reservation.outcome) reservation.override = failed('server_shutdown');
    await this.#stop(reservation);
    if (reservation.progressWrite) await reservation.progressWrite;
    delete reservation.latestProgress;
    // A dedicated terminal write needs <=2s acquisition + <=250ms SET + <=500ms
    // UPDATE. Otherwise deadline recovery retains the persisted running row.
    // There are no shutdown retries and its session setting never leaks to Pool.
    if (deadline - performance.now() >= 3_000) {
      try { await this.#finalize(reservation, true); } catch { /* worker_lost recovery remains available. */ }
    }
    await registrationStopped;
  }
}
