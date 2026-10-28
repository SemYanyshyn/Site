import type { JobDetails, JobLimitsResponse, JobSummary } from '../shared/jobs.js';
import type { RouteInput } from '../shared/route.js';
import { ApiClient, ApiRequestError, requestErrorMessage } from './api.js';
import type { JobsApi } from './api.js';

export interface JobsState {
  authenticated: boolean;
  limits: JobLimitsResponse | null;
  limitsLoading: boolean;
  limitsError: string;
  active: JobSummary[];
  activeLoading: boolean;
  activeError: string;
  history: JobSummary[];
  historyOffset: number;
  historyHasNext: boolean;
  historyLoading: boolean;
  historyError: string;
  selectedId: string | null;
  detail: JobDetails | null;
  detailLoading: boolean;
  detailError: string;
  submitting: boolean;
  cancellingId: string | null;
  actionMessage: string;
  actionError: string;
}

export interface JobsControllerOptions {
  pollMs?: number;
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  onUnauthorized?: () => void;
}

function emptyState(): JobsState {
  return {
    authenticated: false, limits: null, limitsLoading: false, limitsError: '',
    active: [], activeLoading: false, activeError: '', history: [], historyOffset: 0,
    historyHasNext: false, historyLoading: false, historyError: '', selectedId: null,
    detail: null, detailLoading: false, detailError: '', submitting: false,
    cancellingId: null, actionMessage: '', actionError: '',
  };
}

function pending(job: JobSummary | null): boolean { return job?.status === 'queued' || job?.status === 'running'; }

// номери сеансу й вибору відкидають запізнілі відповіді навіть коли abort уже не встиг їх зупинити
export class JobsController {
  private value = emptyState();
  private generation = 0;
  private selection = 0;
  private historyGeneration = 0;
  private historyLoadedOffset = 0;
  private readonly listeners = new Set<(state: JobsState) => void>();
  private readonly requests = new Set<AbortController>();
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private cycle: Promise<void> | null = null;
  private again = false;
  private limitsRequest: Promise<void> | null = null;
  private detailRequest: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  private historyRequest: AbortController | null = null;
  private autoSelected = false;
  private detailUnavailable = false;
  private readonly setTimer: NonNullable<JobsControllerOptions['setTimeout']>;
  private readonly clearTimer: NonNullable<JobsControllerOptions['clearTimeout']>;
  private readonly pollMs: number;

  constructor(private readonly api: JobsApi = new ApiClient(), private readonly options: JobsControllerOptions = {}) {
    // ?? бере запасний варіант лише для null або undefined на відміну від перевірки будь-якого falsy значення
    this.setTimer = options.setTimeout ?? ((callback, milliseconds) => globalThis.setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.pollMs = options.pollMs ?? 1_000;
    if (!Number.isFinite(this.pollMs) || this.pollMs < 250 || this.pollMs > 60_000) throw new Error('Некоректний інтервал оновлення.');
  }

  get state(): JobsState { return this.value; }

  subscribe(listener: (state: JobsState) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => { this.listeners.delete(listener); };
  }

  private update(partial: Partial<JobsState>): void {
    this.value = { ...this.value, ...partial };
    for (const listener of this.listeners) listener(this.value);
  }

  private current(generation: number): boolean { return this.value.authenticated && generation === this.generation; }
  private controller(): AbortController {
    const controller = new AbortController();
    this.requests.add(controller);
    return controller;
  }
  private stopTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  private unauthorized(error: unknown, generation: number): boolean {
    if (!this.current(generation)) return true;
    if (error instanceof ApiRequestError && error.status === 401) {
      this.endSession();
      this.options.onUnauthorized?.();
      return true;
    }
    return false;
  }
  // запускаю наступне читання коли є активна задача або дані для повторного читання і немає поточного циклу
  private schedule(): void {
    this.stopTimer();
    if (!this.value.authenticated || this.cycle) return;
    if (this.value.active.length === 0 && !pending(this.value.detail)
      && !this.value.activeError && !this.value.historyError && !(this.value.detailError && !this.detailUnavailable)) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.refresh();
    }, this.pollMs);
  }

  async startSession(): Promise<void> {
    this.endSession();
    this.update({ authenticated: true });
    await Promise.all([this.retryLimits(), this.refresh()]);
  }

  // очищую приватний стан і старі HTTP запити але не скасовую прийняті сервером задачі
  endSession(): void {
    this.generation++;
    this.selection++;
    this.historyGeneration++;
    this.stopTimer();
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.cycle = null;
    this.limitsRequest = null;
    this.detailRequest = null;
    this.historyRequest = null;
    this.historyLoadedOffset = 0;
    this.again = false;
    this.autoSelected = false;
    this.detailUnavailable = false;
    this.value = emptyState();
    for (const listener of this.listeners) listener(this.value);
  }

  retryLimits(): Promise<void> {
    if (!this.value.authenticated) return Promise.resolve();
    if (this.limitsRequest) return this.limitsRequest;
    const generation = this.generation;
    const controller = this.controller();
    this.update({ limitsLoading: true, limitsError: '' });
    const operation = (async () => {
      try {
        const limits = await this.api.limits(controller.signal);
        if (this.current(generation)) this.update({ limits, limitsError: '' });
      } catch (error) {
        if (!this.unauthorized(error, generation)) this.update({ limitsError: requestErrorMessage(error) });
      } finally {
        this.requests.delete(controller);
        if (this.current(generation)) this.update({ limitsLoading: false });
      }
    })();
    this.limitsRequest = operation;
    void operation.finally(() => { if (this.limitsRequest === operation) this.limitsRequest = null; });
    return operation;
  }

  private async readActive(generation: number): Promise<void> {
    const controller = this.controller();
    this.update({ activeLoading: true });
    try {
      const first = await this.api.list({ status: 'active', limit: 50, offset: 0 }, controller.signal);
      if (!this.current(generation)) return;
      const second = first.jobs.length === 50
        ? await this.api.list({ status: 'active', limit: 50, offset: 50 }, controller.signal) : null;
      if (!this.current(generation)) return;
      const jobs = [...new Map([...first.jobs, ...(second?.jobs ?? [])].map((job) => [job.id, job])).values()];
      this.update({ active: jobs, activeError: '' });
    } catch (error) {
      if (!this.unauthorized(error, generation)) this.update({ activeError: requestErrorMessage(error) });
    } finally {
      this.requests.delete(controller);
      if (this.current(generation)) this.update({ activeLoading: false });
    }
  }

  private async readHistory(generation: number): Promise<void> {
    const historyGeneration = this.historyGeneration;
    const offset = this.value.historyOffset;
    const controller = this.controller();
    this.historyRequest = controller;
    this.update({ historyLoading: true });
    try {
      const page = await this.api.list({ limit: 20, offset }, controller.signal);
      if (!this.current(generation) || historyGeneration !== this.historyGeneration) return;
      this.historyLoadedOffset = offset;
      this.update({ history: page.jobs, historyError: '', historyHasNext: page.jobs.length === 20 && offset <= 999_980 });
    } catch (error) {
      if (historyGeneration === this.historyGeneration && !this.unauthorized(error, generation)) this.update({
        historyOffset: this.historyLoadedOffset,
        historyError: `${requestErrorMessage(error)} Показано останню успішно завантажену сторінку.`,
      });
    } finally {
      this.requests.delete(controller);
      if (this.historyRequest === controller) this.historyRequest = null;
      if (this.current(generation) && historyGeneration === this.historyGeneration) this.update({ historyLoading: false });
    }
  }

  private readDetail(generation: number): Promise<void> {
    const id = this.value.selectedId;
    if (!id || !this.current(generation)) return Promise.resolve();
    if (this.detailRequest?.id === id) return this.detailRequest.promise;
    this.detailRequest?.controller.abort();
    const selection = this.selection;
    const controller = this.controller();
    this.update({ detailLoading: true });
    const operation = (async () => {
      try {
        const detail = await this.api.detail(id, controller.signal);
        if (this.current(generation) && selection === this.selection && id === this.value.selectedId) {
          this.detailUnavailable = false;
          this.update({ detail, detailError: '', ...(detail.status === 'cancelled' && this.value.detail?.cancelRequested
            ? { actionMessage: 'Скасування підтверджено сервером.' } : {}) });
        }
      } catch (error) {
        if (selection === this.selection && !this.unauthorized(error, generation)) {
          this.detailUnavailable = error instanceof ApiRequestError && error.status === 404;
          this.update({ detailError: requestErrorMessage(error), ...(this.detailUnavailable ? { detail: null } : {}) });
        }
      } finally {
        this.requests.delete(controller);
        if (this.current(generation) && selection === this.selection) this.update({ detailLoading: false });
      }
    })();
    this.detailRequest = { id, controller, promise: operation };
    void operation.finally(() => { if (this.detailRequest?.promise === operation) this.detailRequest = null; });
    return operation;
  }

  refresh(): Promise<void> {
    if (!this.value.authenticated) return Promise.resolve();
    this.stopTimer();
    if (this.cycle) { this.again = true; return this.cycle; }
    const generation = this.generation;
    const operation = (async () => {
      do {
        this.again = false;
        await Promise.all([this.readActive(generation), this.readHistory(generation)]);
        if (!this.current(generation)) return;
        if (!this.autoSelected && this.value.selectedId === null && (!this.value.activeError || !this.value.historyError)) {
          this.autoSelected = true;
          const newest = this.value.active[0] ?? this.value.history[0];
          if (newest) { this.selection++; this.update({ selectedId: newest.id, detail: null }); }
        }
        if (this.value.selectedId && (pending(this.value.detail)
          || (!this.detailUnavailable && (this.value.detail === null || this.value.detailError)))) {
          await this.readDetail(generation);
        }
      } while (this.again && this.current(generation));
    })();
    this.cycle = operation;
    void operation.finally(() => {
      if (this.cycle === operation) { this.cycle = null; this.schedule(); }
    });
    return operation;
  }

  async selectJob(id: string): Promise<void> {
    if (!this.value.authenticated) return;
    if (this.value.selectedId !== id) {
      this.selection++;
      this.detailUnavailable = false;
      this.detailRequest?.controller.abort();
      this.detailRequest = null;
      this.update({ selectedId: id, detail: null, detailError: '' });
    }
    await this.readDetail(this.generation);
    this.schedule();
  }

  async goToHistoryPage(offset: number): Promise<void> {
    if (!this.value.authenticated || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || offset % 20 !== 0) return;
    if (offset !== this.value.historyOffset) {
      this.historyGeneration++;
      this.historyRequest?.abort();
      this.update({ historyOffset: offset, historyLoading: true, historyError: '' });
    }
    await this.refresh();
  }

  async submit(input: RouteInput): Promise<void> {
    if (!this.value.authenticated || this.value.submitting) return;
    if (!this.value.limits || this.value.limitsLoading || this.value.limitsError) {
      this.update({ actionError: 'Спочатку завантажте актуальні серверні ліміти.', actionMessage: '' });
      return;
    }
    const generation = this.generation;
    const controller = this.controller();
    this.update({ submitting: true, actionError: '', actionMessage: '' });
    try {
      const detail = await this.api.create(input, controller.signal);
      if (!this.current(generation)) return;
      this.selection++;
      this.historyGeneration++;
      this.detailUnavailable = false;
      this.detailRequest?.controller.abort();
      this.detailRequest = null;
      this.historyRequest?.abort();
      this.update({ selectedId: detail.id, detail, detailError: '', detailLoading: false, historyOffset: 0,
        actionMessage: 'Задачу прийнято. Її стан збережено на сервері.' });
      await this.refresh();
    } catch (error) {
      if (!this.unauthorized(error, generation)) this.update({ actionError: requestErrorMessage(error), actionMessage: '' });
    } finally {
      this.requests.delete(controller);
      if (this.current(generation)) this.update({ submitting: false });
    }
  }

  async cancel(id: string): Promise<void> {
    if (!this.value.authenticated || this.value.cancellingId !== null) return;
    const generation = this.generation;
    const selection = this.selection;
    const controller = this.controller();
    this.update({ cancellingId: id, actionError: '', actionMessage: '' });
    try {
      const detail = await this.api.cancel(id, controller.signal);
      if (!this.current(generation)) return;
      if (this.value.selectedId === id && selection === this.selection) {
        // Invalidate a GET that started before cancellation acknowledgement.
        this.selection++;
        this.detailUnavailable = false;
        this.detailRequest?.controller.abort();
        this.detailRequest = null;
        this.update({ detail, detailError: '', detailLoading: false });
      }
      this.update({ actionMessage: detail.status === 'running' && detail.cancelRequested
        ? 'Запит на скасування прийнято. Очікуємо зупинки.'
        : detail.status === 'cancelled' ? 'Скасування підтверджено сервером.'
          : 'Сервер повернув актуальний стан задачі.' });
      await this.refresh();
    } catch (error) {
      if (!this.unauthorized(error, generation)) this.update({ actionError: requestErrorMessage(error), actionMessage: '' });
    } finally {
      this.requests.delete(controller);
      if (this.current(generation)) this.update({ cancellingId: null });
    }
  }
}
