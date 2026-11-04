// Тут керую даними адмінпанелі: відкриттям, періодичним читанням, фільтром і сторінками задач.
import type {
  AdminJobsOptions,
  AdminJobsResponse,
  AdminOverview,
} from "../shared/admin.js";
import type { PublicUser } from "../shared/auth.js";
import { AdminApiClient } from "./admin-api.js";
import type { AdminApi } from "./admin-api.js";
import { ApiRequestError, requestErrorMessage } from "./api.js";

// Описую поточний огляд, задачі, фільтр, видимість панелі та помилки читання.
export interface AdminState {
  allowed: boolean;
  open: boolean;
  visible: boolean;
  overview: AdminOverview | null;
  jobs: AdminJobsResponse | null;
  query: AdminJobsOptions;
  overviewLoading: boolean;
  jobsLoading: boolean;
  overviewError: string;
  jobsError: string;
}
export interface AdminControllerOptions {
  pollMs?: number;
  setTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  onUnauthorized?: () => void;
  onForbidden?: () => void;
}
function emptyState(visible = true): AdminState {
  return {
    allowed: false,
    open: false,
    visible,
    overview: null,
    jobs: null,
    query: { limit: 20, offset: 0 },
    overviewLoading: false,
    jobsLoading: false,
    overviewError: "",
    jobsError: "",
  };
}

// Звіряю номери сесії, панелі та фільтра, щоб застарілі відповіді не оновили новий екран.
export class AdminController {
  private value = emptyState();
  private session = 0;
  private panel = 0;
  private selection = 0;
  private overviewRequest: AbortController | null = null;
  private jobsRequest: AbortController | null = null;
  private cycle: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly listeners = new Set<(state: AdminState) => void>();
  private readonly setTimer: NonNullable<AdminControllerOptions["setTimeout"]>;
  private readonly clearTimer: NonNullable<
    AdminControllerOptions["clearTimeout"]
  >;
  private readonly pollMs: number;

  constructor(
    private readonly api: AdminApi = new AdminApiClient(),
    private readonly options: AdminControllerOptions = {},
  ) {
    this.setTimer =
      options.setTimeout ??
      ((callback, milliseconds) =>
        globalThis.setTimeout(callback, milliseconds));
    this.clearTimer =
      options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    this.pollMs = options.pollMs ?? 5_000;
    if (
      !Number.isFinite(this.pollMs) ||
      this.pollMs < 1_000 ||
      this.pollMs > 60_000
    )
      throw new Error("Некоректний інтервал моніторингу.");
  }
  get state(): AdminState {
    return this.value;
  }
  // Підписую інтерфейс на оновлення стану моніторингу.
  subscribe(listener: (state: AdminState) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(patch: Partial<AdminState>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener(this.value);
  }
  // Перевіряю, чи потрібне автооновлення: роль admin, відкрита панель і видима вкладка.
  private active(): boolean {
    return this.value.allowed && this.value.open && this.value.visible;
  }
  private current(session: number, panel: number): boolean {
    return this.active() && session === this.session && panel === this.panel;
  }
  private stopTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  private abort(): void {
    this.overviewRequest?.abort();
    this.jobsRequest?.abort();
  }
  private schedule(): void {
    this.stopTimer();
    if (!this.active() || this.cycle) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.refresh();
    }, this.pollMs);
  }
  // За роллю показую доступ до панелі; право читати її дані додатково перевіряє сервер.
  setUser(user: PublicUser | null): void {
    this.endSession();
    if (user?.role === "admin") this.update({ allowed: true });
  }
  // При зміні користувача чи виході зупиняю запити й очищую приватні дані моніторингу.
  endSession(): void {
    this.session++;
    this.panel++;
    this.selection++;
    this.stopTimer();
    this.abort();
    this.again = false;
    this.value = emptyState(this.value.visible);
    for (const listener of this.listeners) listener(this.value);
  }
  // Відкриваю панель для адміністратора й одразу запитую свіжі дані.
  async open(): Promise<void> {
    if (!this.value.allowed) return;
    if (!this.value.open) {
      this.panel++;
      this.update({ open: true });
    }
    await this.refresh();
  }
  // Закриваю панель, очищую її дані та припиняю автоматичне читання.
  close(): void {
    this.panel++;
    this.selection++;
    this.stopTimer();
    this.abort();
    this.again = false;
    this.update({
      open: false,
      overview: null,
      jobs: null,
      query: { limit: 20, offset: 0 },
      overviewError: "",
      jobsError: "",
      overviewLoading: false,
      jobsLoading: false,
    });
  }
  // Зупиняю опитування в прихованій вкладці й поновлюю його при поверненні.
  setVisible(visible: boolean): void {
    if (visible === this.value.visible) return;
    this.panel++;
    this.stopTimer();
    this.abort();
    this.again = false;
    this.update({ visible, overviewLoading: false, jobsLoading: false });
    if (this.active()) void this.refresh();
  }
  // Окремо обробляю завершення сесії (401) і втрату прав адміністратора (403).
  private denied(error: unknown, session: number, panel: number): boolean {
    if (!this.current(session, panel)) return true;
    if (
      error instanceof ApiRequestError &&
      (error.status === 401 || error.status === 403)
    ) {
      this.endSession();
      if (error.status === 401) this.options.onUnauthorized?.();
      else this.options.onForbidden?.();
      return true;
    }
    return false;
  }
  // Читаю огляд серверів; при збої зберігаю попередній знімок із повідомленням про помилку.
  private async overview(session: number, panel: number): Promise<void> {
    const request = new AbortController();
    this.overviewRequest = request;
    this.update({ overviewLoading: true });
    try {
      const overview = await this.api.overview(request.signal);
      if (this.current(session, panel))
        this.update({ overview, overviewError: "" });
    } catch (error) {
      if (!this.denied(error, session, panel))
        this.update({ overviewError: requestErrorMessage(error) });
    } finally {
      if (this.overviewRequest === request) this.overviewRequest = null;
      if (this.current(session, panel)) this.update({ overviewLoading: false });
    }
  }
  // Читаю сторінку задач і звіряю, що користувач ще не змінив фільтр або сторінку.
  private async jobs(session: number, panel: number): Promise<void> {
    const request = new AbortController(),
      selection = this.selection,
      query = { ...this.value.query };
    this.jobsRequest = request;
    this.update({ jobsLoading: true });
    try {
      const jobs = await this.api.jobs(query, request.signal);
      if (this.current(session, panel) && selection === this.selection)
        this.update({ jobs, jobsError: "" });
    } catch (error) {
      // Враховую втрату авторизації для всієї поточної сесії, навіть якщо це відповідь старої сторінки.
      if (!this.denied(error, session, panel) && selection === this.selection)
        this.update({ jobsError: requestErrorMessage(error) });
    } finally {
      if (this.jobsRequest === request) this.jobsRequest = null;
      if (this.current(session, panel) && selection === this.selection)
        this.update({ jobsLoading: false });
    }
  }
  // Оновлюю огляд і задачі одним циклом; наступне автоматичне читання планую після його завершення.
  refresh(): Promise<void> {
    if (!this.active()) return Promise.resolve();
    this.stopTimer();
    if (this.cycle) {
      this.again = true;
      return this.cycle;
    }
    const operation = (async () => {
      do {
        this.again = false;
        const session = this.session,
          panel = this.panel;
        await Promise.all([
          this.overview(session, panel),
          this.jobs(session, panel),
        ]);
      } while (this.again && this.active());
    })();
    this.cycle = operation;
    void operation.finally(() => {
      if (this.cycle === operation) {
        this.cycle = null;
        this.schedule();
      }
    });
    return operation;
  }
  // Застосовую фільтр стану задач і повертаю список на першу сторінку.
  async setStatus(status?: AdminJobsOptions["status"]): Promise<void> {
    if (
      !this.value.allowed ||
      (status !== undefined &&
        ![
          "active",
          "queued",
          "running",
          "completed",
          "cancelled",
          "failed",
        ].includes(status))
    )
      return;
    if (status !== this.value.query.status || this.value.query.offset !== 0) {
      this.selection++;
      this.jobsRequest?.abort();
      this.update({
        query: { limit: 20, offset: 0, ...(status ? { status } : {}) },
        jobs: null,
        jobsError: "",
      });
    }
    await this.refresh();
  }
  // Перемикаю сторінки загального списку задач із перевіркою допустимого зміщення.
  async goToPage(offset: number): Promise<void> {
    if (
      !this.value.allowed ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1_000_000 ||
      offset % 20 !== 0
    )
      return;
    if (offset !== this.value.query.offset) {
      this.selection++;
      this.jobsRequest?.abort();
      this.update({
        query: { ...this.value.query, offset },
        jobs: null,
        jobsError: "",
      });
    }
    await this.refresh();
  }
}
