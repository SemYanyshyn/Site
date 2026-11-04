// Тут запускаю клієнт і зв’язую форми входу, особисті задачі та адмінпанель із HTML.
import { apiFetch } from "./api-endpoint.js";
import "./styles.scss";
import { mountAuth } from "./auth-ui.js";
import type { AuthHandle } from "./auth-ui.js";
import { JobsController } from "./jobs-controller.js";
import { createJobsView } from "./jobs-view.js";
import { parseRouteDraft } from "./route-input.js";
import { AdminController } from "./admin-controller.js";
import { createAdminView } from "./admin-view.js";

let auth: AuthHandle | undefined;
// Створюю контролери задач і моніторингу та обробляю завершення сесії або втрату ролі.
const jobs = new JobsController(undefined, {
  onUnauthorized: () => auth?.expireSession(),
});
const admin = new AdminController(undefined, {
  onUnauthorized: () => auth?.expireSession(),
  onForbidden: () => auth?.loseAdminRole(),
});
// Передаю дії кнопок адмінпанелі відповідному контролеру.
const adminView = createAdminView({
  open: () => {
    void admin.open();
  },
  close: () => admin.close(),
  refresh: () => {
    void admin.refresh();
  },
  status: (status) => {
    void admin.setStatus(status);
  },
  page: (offset) => {
    void admin.goToPage(offset);
  },
});
// Перемикаю видимість особистих задач залежно від входу та відкритої адмінпанелі.
function showWorkspace(): void {
  const workspace = document.querySelector<HTMLElement>("#jobs-workspace");
  if (workspace)
    workspace.hidden = !jobs.state.authenticated || admin.state.open;
}
// Підключаю форму маршруту: перевіряю введення й передаю дії користувача контролеру задач.
const view = createJobsView({
  submit(draft) {
    const limits = jobs.state.limits;
    if (!limits) {
      view.showDraftError("Спочатку завантажте серверні ліміти.");
      return;
    }
    const parsed = parseRouteDraft(draft, limits.route);
    if (!parsed.ok) {
      view.showDraftError(parsed.message, parsed.field);
      return;
    }
    void jobs.submit(parsed.input);
  },
  selectJob: (id) => {
    void jobs.selectJob(id);
  },
  cancel: (id) => {
    void jobs.cancel(id);
  },
  historyPage: (offset) => {
    void jobs.goToHistoryPage(offset);
  },
  retryLimits: () => {
    void jobs.retryLimits();
  },
  refresh: () => {
    void jobs.refresh();
  },
});
// Підписую інтерфейс на зміни стану контролерів; функції відписки зберігаю для очищення.
const unsubscribe = jobs.subscribe((state) => {
  view.render(state);
  showWorkspace();
});
const unsubscribeAdmin = admin.subscribe((state) => {
  adminView.render(state);
  showWorkspace();
});
admin.setVisible(!document.hidden);
// Після входу завантажую задачі користувача; після виходу очищую приватні дані на екрані.
auth = mountAuth({
  onAuthenticated: (user) => {
    view.clearPrivate();
    admin.setUser(user);
    void jobs.startSession();
  },
  onSigningOut: () => admin.endSession(),
  onRoleChanged: (user) => admin.setUser(user),
  onSignedOut: () => {
    admin.endSession();
    jobs.endSession();
    view.clearPrivate();
  },
});

// Пов’язую службові обробники зі сторінкою та повідомляю моніторингу, чи вкладка видима.
const lifecycle = new AbortController();
document.addEventListener(
  "visibilitychange",
  () => admin.setVisible(!document.hidden),
  { signal: lifecycle.signal },
);
// Окремим коротким запитом перевіряю /api/health для індикатора доступності сервера.
void (async () => {
  const status = document.querySelector<HTMLElement>("#server-status");
  const card = document.querySelector<HTMLElement>(".status-card");
  if (!status || !card) return;
  try {
    const response = await apiFetch("/api/health", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(5_000)]),
    });
    const data: unknown = await response.json();
    if (
      !response.ok ||
      typeof data !== "object" ||
      data === null ||
      !("status" in data) ||
      data.status !== "ok"
    )
      throw new Error();
    if (lifecycle.signal.aborted) return;
    status.textContent = "Сервер доступний";
    card.dataset.state = "ok";
  } catch {
    if (lifecycle.signal.aborted) return;
    status.textContent =
      "Сервер недоступний. Перевірте з’єднання та оновіть сторінку.";
    card.dataset.state = "error";
  }
})();

// При залишенні сторінки зупиняю запити й підписки та очищую приватний інтерфейс.
window.addEventListener(
  "pagehide",
  () => {
    lifecycle.abort();
    jobs.endSession();
    admin.endSession();
    adminView.destroy();
    view.clearPrivate();
    unsubscribe();
    unsubscribeAdmin();
    auth?.destroy();
  },
  { once: true },
);
// При відновленні сторінки з кешу браузера завантажую її заново для перевірки сесії.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
