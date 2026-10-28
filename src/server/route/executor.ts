import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import type {
  Coordinate, NormalizedRouteInput, RouteLimits, RouteOutcome, RouteProgress, RouteResult,
} from '../../shared/route.js';
import { readRouteConfig, validateRouteLimits } from './config.js';
import { validateRouteInput } from './validation.js';

interface ExecutorOptions {
  // Private injection for error tests; no HTTP input controls worker code.
  workerFactory?: (url: URL, options: WorkerOptions) => Worker;
  workerUrl?: URL;
}

export interface RouteRun {
  runId: string;
  threadId: number;
  result: Promise<RouteOutcome>;
}

interface ActiveRun {
  runId: string;
  input: NormalizedRouteInput;
  startedAt: number;
  worker?: Worker;
  threadId: number;
  timer?: NodeJS.Timeout;
  outcome?: RouteOutcome;
  candidate?: RouteResult;
  result: Promise<RouteOutcome>;
  resolve: (outcome: RouteOutcome) => void;
  onProgress: ((progress: RouteProgress) => void) | undefined;
  lastCompleted: number;
  lastPercent: number;
  lastStage: number;
  settled: boolean;
  terminating: boolean;
}

export class RouteExecutorError extends Error {
  constructor(readonly code: 'executor_busy' | 'executor_shutdown', message: string) {
    super(message);
    this.name = 'RouteExecutorError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function closedRouteLength(order: unknown, locations: readonly Coordinate[]): number | null {
  const count = locations.length - 1;
  if (!Array.isArray(order) || order.length !== count + 2 || order[0] !== 0 || order.at(-1) !== 0) return null;
  const seen = new Uint8Array(count + 1);
  let length = 0;
  for (let position = 1; position <= count + 1; position += 1) {
    const index: unknown = order[position];
    const previousIndex: unknown = order[position - 1];
    if (!Number.isInteger(index) || typeof index !== 'number' || index < 0 || index > count) return null;
    if (position <= count) {
      if (index === 0 || seen[index]) return null;
      seen[index] = 1;
    }
    if (typeof previousIndex !== 'number') return null;
    const current = locations[index];
    const previous = locations[previousIndex];
    if (!current || !previous) return null;
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return length;
}

/** Check the actual returned permutation and length independently of the solver. */
function validResult(value: unknown, input: NormalizedRouteInput, elapsedMs: number): value is RouteResult {
  if (!isRecord(value)) return false;
  const count = input.points.length;
  if (
    value.seed !== input.seed || value.iterationsRequested !== input.iterations ||
    !Number.isSafeInteger(value.iterationsCompleted) || typeof value.iterationsCompleted !== 'number' ||
    value.iterationsCompleted < 0 || value.iterationsCompleted > input.iterations ||
    !finiteNonnegative(value.length) || !finiteNonnegative(value.initialLength) ||
    !finiteNonnegative(value.elapsedMs) || value.elapsedMs > elapsedMs + 2 || value.approximate !== true
  ) return false;

  const locations = [input.warehouse, ...input.points];
  const length = closedRouteLength(value.order, locations);
  if (length === null) return false;
  const tolerance = Number.EPSILON * Math.max(length, value.initialLength) * Math.max(16, count * 8)
    + Number.MIN_VALUE * count;
  if (Math.abs(length - value.length) > tolerance || value.length > value.initialLength + tolerance) return false;
  if (value.initialOrder !== undefined) {
    const initialLength = closedRouteLength(value.initialOrder, locations);
    if (initialLength === null) return false;
    const initialTolerance = Number.EPSILON * Math.max(initialLength, value.initialLength) * Math.max(16, count * 8)
      + Number.MIN_VALUE * count;
    if (Math.abs(initialLength - value.initialLength) > initialTolerance) return false;
  }
  // Any valid initial closed route has this conservative geometric upper bound.
  const maxAbsoluteCoordinate = Math.max(...locations.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]));
  const maximumLength = (count + 1) * 2 * Math.SQRT2 * maxAbsoluteCoordinate;
  if (value.initialLength > maximumLength + tolerance) return false;

  if (value.terminationReason === 'zero_length') {
    return value.iterationsCompleted === 0 && value.length === 0 && value.initialLength === 0;
  }
  if (value.terminationReason === 'trivial_input') {
    return count <= 2 && value.iterationsCompleted === 0;
  }
  return value.terminationReason === 'budget_exhausted' && count > 2 &&
    value.iterationsCompleted === input.iterations;
}

// керую одним worker цього HTTP процесу а спільна черга живе окремо в PostgreSQL
export class RouteExecutor {
  readonly #limits: RouteLimits;
  readonly #options: ExecutorOptions;
  #active: ActiveRun | undefined;
  #closed = false;

  constructor(limits: RouteLimits = readRouteConfig(), options: ExecutorOptions = {}) {
    validateRouteLimits(limits);
    this.#limits = { ...limits };
    this.#options = options;
  }

  get busy(): boolean { return this.#active !== undefined; }

  start(input: unknown, onProgress?: (progress: RouteProgress) => void): RouteRun {
    if (this.#closed) throw new RouteExecutorError('executor_shutdown', 'Виконавець маршруту вже завершує роботу.');
    if (this.#active) throw new RouteExecutorError('executor_busy', 'Виконавець маршруту зайнятий. Повторіть запуск після завершення.');
    const normalized = validateRouteInput(input, this.#limits);
    let resolve!: (outcome: RouteOutcome) => void;
    const result = new Promise<RouteOutcome>((done) => { resolve = done; });
    const active: ActiveRun = {
      runId: randomUUID(), input: normalized, startedAt: performance.now(), result, resolve, onProgress,
      lastCompleted: 0, lastPercent: 0, lastStage: 0, settled: false, terminating: false, threadId: 0,
    };
    // займаю слот до створення worker і до асинхронних продовжень щоб не запустити другий одночасно
    this.#active = active;
    const run: RouteRun = { runId: active.runId, threadId: 0, result };
    try {
      const workerUrl = this.#options.workerUrl ?? (import.meta.url.endsWith('.ts')
        ? new URL('./dev-worker.mjs', import.meta.url)
        : new URL('./worker.js', import.meta.url));
      const factory = this.#options.workerFactory ?? ((url, options) => new Worker(url, options));
      // worker отримує лише вхід і runId без паролів БД та аргументів запуску основного процесу
      const worker = factory(workerUrl, {
        workerData: { runId: active.runId, input: normalized },
        env: {}, execArgv: [],
      });
      active.worker = worker;
      active.threadId = worker.threadId;
      run.threadId = worker.threadId;
      worker.on('message', (message: unknown) => this.#message(active, message));
      worker.once('error', () => this.#stop(active, {
        status: 'failed', reason: 'worker_error', message: 'Помилка окремого потоку обчислення маршруту.',
      }));
      worker.once('messageerror', () => this.#stop(active, {
        status: 'failed', reason: 'worker_error', message: 'Не вдалося прочитати повідомлення потоку обчислення.',
      }));
      worker.once('exit', (code) => {
        if (active.settled) return;
        this.#expire(active);
        const outcome: RouteOutcome = active.outcome ?? (code === 0 && active.candidate
          ? { status: 'completed', result: active.candidate }
          : { status: 'failed', reason: 'worker_error', message: 'Потік обчислення завершився без коректного результату.' });
        this.#finish(active, outcome);
      });
      const remaining = this.#limits.timeoutMs - (performance.now() - active.startedAt);
      if (remaining <= 0) this.#expire(active);
      else active.timer = setTimeout(() => this.#expire(active), remaining);
    } catch {
      this.#finish(active, {
        status: 'failed', reason: 'worker_error', message: 'Не вдалося створити потік обчислення маршруту.',
      });
    }
    return run;
  }

  // чекаю фактичної зупинки потоку а не лише записую бажання скасувати
  async cancel(runId?: string): Promise<void> {
    const active = this.#active;
    if (!active || (runId !== undefined && runId !== active.runId)) return;
    this.#stop(active, { status: 'cancelled' });
    await active.result;
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.cancel();
  }

  // після дедлайну ставлю failed з причиною timeout і через stop фізично зупиняю worker
  #expire(active: ActiveRun): boolean {
    if (active.settled || active.outcome) return false;
    const remaining = this.#limits.timeoutMs - (performance.now() - active.startedAt);
    if (remaining > 0) {
      // A timer may fire slightly before its requested monotonic deadline.
      if (active.timer) clearTimeout(active.timer);
      active.timer = setTimeout(() => this.#expire(active), remaining);
      return false;
    }
    this.#stop(active, {
      status: 'failed', reason: 'timeout', message: 'Перевищено дозволений час обчислення маршруту.',
    });
    return true;
  }

  #message(active: ActiveRun, message: unknown): void {
    if (active.settled || active.outcome || this.#expireIfDue(active)) return;
    if (!isRecord(message) || message.runId !== active.runId) {
      this.#invalidWorker(active);
      return;
    }
    if (message.kind === 'progress') {
      const progress = message.progress;
      const stages = { preparing: 0, searching: 1, finishing: 2 } as const;
      if (!isRecord(progress) || typeof progress.stage !== 'string' || !Object.hasOwn(stages, progress.stage) ||
        !Number.isSafeInteger(progress.completedIterations) || typeof progress.completedIterations !== 'number' ||
        progress.completedIterations < active.lastCompleted || progress.completedIterations > active.input.iterations ||
        progress.totalIterations !== active.input.iterations || !finiteNonnegative(progress.percent) || progress.percent > 100) {
        this.#invalidWorker(active);
        return;
      }
      const stage = progress.stage as RouteProgress['stage'];
      if (stages[stage] < active.lastStage || (stage === 'preparing' && progress.completedIterations !== 0)) {
        this.#invalidWorker(active);
        return;
      }
      active.lastStage = stages[stage];
      active.lastCompleted = progress.completedIterations;
      // відсоток беру з реальних ітерацій а 100 дозволяю тільки після перевірки результату й виходу worker
      const percent = Math.min(99.999, 100 * progress.completedIterations / active.input.iterations);
      this.#progress(active, { stage, completedIterations: progress.completedIterations,
        totalIterations: active.input.iterations, percent });
    } else if (message.kind === 'result' && !active.candidate && message.threadId === active.threadId &&
      validResult(message.result, active.input, performance.now() - active.startedAt)) {
      active.candidate = message.result;
    } else this.#invalidWorker(active);
  }

  #expireIfDue(active: ActiveRun): boolean {
    if (performance.now() - active.startedAt < this.#limits.timeoutMs) return false;
    return this.#expire(active);
  }

  #invalidWorker(active: ActiveRun): void {
    this.#stop(active, {
      status: 'failed', reason: 'worker_error', message: 'Потік обчислення повернув некоректні дані.',
    });
  }

  #stop(active: ActiveRun, outcome: RouteOutcome): void {
    if (active.settled || active.outcome) return;
    // перша кінцева причина лишається чинною включно зі скасуванням яке надійшло раніше за результат
    active.outcome = outcome;
    if (active.timer) clearTimeout(active.timer);
    const worker = active.worker;
    if (!worker) { this.#finish(active, outcome); return; }
    if (active.terminating) return;
    active.terminating = true;
    void worker.terminate().then(() => {
      // Promise від terminate завершується після фізичної зупинки потоку як і подія exit
      this.#finish(active, active.outcome ?? outcome);
    }).catch(() => {
      if (worker.threadId === -1) this.#finish(active, active.outcome ?? outcome);
    });
  }

  #progress(active: ActiveRun, progress: RouteProgress): void {
    if (progress.percent < active.lastPercent) return;
    active.lastPercent = progress.percent;
    try {
      // TypeScript permits an async function where a void callback is expected.
      // Observe that returned Promise as well as catching synchronous throws.
      const returned: unknown = active.onProgress?.(progress);
      void Promise.resolve(returned).catch(() => {});
    } catch {
      // A consumer callback must not escape an EventEmitter or strand a worker.
    }
  }

  #finish(active: ActiveRun, outcome: RouteOutcome): void {
    if (active.settled) return;
    active.settled = true;
    if (active.timer) clearTimeout(active.timer);
    active.worker?.removeAllListeners();
    delete active.worker;
    delete active.timer;
    if (this.#active === active) this.#active = undefined;
    if (outcome.status === 'completed') {
      this.#progress(active, { stage: 'finishing', completedIterations: outcome.result.iterationsCompleted,
        totalIterations: outcome.result.iterationsRequested, percent: 100 });
    }
    active.onProgress = undefined;
    active.resolve(outcome);
  }
}
