import './styles.css';
import { mountAuth } from './auth-ui.js';
import type { AuthHandle } from './auth-ui.js';
import { JobsController } from './jobs-controller.js';
import { createJobsView } from './jobs-view.js';
import { parseRouteDraft } from './route-input.js';
import { AdminController } from './admin-controller.js';
import { createAdminView } from './admin-view.js';

let auth: AuthHandle | undefined;
const jobs = new JobsController(undefined, { onUnauthorized: () => auth?.expireSession() });
const admin = new AdminController(undefined, {
  onUnauthorized: () => auth?.expireSession(),
  onForbidden: () => auth?.loseAdminRole(),
});
const adminView = createAdminView({
  open: () => { void admin.open(); }, close: () => admin.close(), refresh: () => { void admin.refresh(); },
  status: (status) => { void admin.setStatus(status); }, page: (offset) => { void admin.goToPage(offset); },
});
function showWorkspace(): void {
  const workspace = document.querySelector<HTMLElement>('#jobs-workspace');
  if (workspace) workspace.hidden = !jobs.state.authenticated || admin.state.open;
}
const view = createJobsView({
  submit(draft) {
    const limits = jobs.state.limits;
    if (!limits) { view.showDraftError('Спочатку завантажте серверні ліміти.'); return; }
    const parsed = parseRouteDraft(draft, limits.route);
    if (!parsed.ok) { view.showDraftError(parsed.message, parsed.field); return; }
    void jobs.submit(parsed.input);
  },
  selectJob: (id) => { void jobs.selectJob(id); },
  cancel: (id) => { void jobs.cancel(id); },
  historyPage: (offset) => { void jobs.goToHistoryPage(offset); },
  retryLimits: () => { void jobs.retryLimits(); },
  refresh: () => { void jobs.refresh(); },
});
const unsubscribe = jobs.subscribe((state) => { view.render(state); showWorkspace(); });
const unsubscribeAdmin = admin.subscribe((state) => { adminView.render(state); showWorkspace(); });
admin.setVisible(!document.hidden);
auth = mountAuth({
  onAuthenticated: (user) => { view.clearPrivate(); admin.setUser(user); void jobs.startSession(); },
  onSigningOut: () => admin.endSession(),
  onRoleChanged: (user) => admin.setUser(user),
  onSignedOut: () => { admin.endSession(); jobs.endSession(); view.clearPrivate(); },
});

const lifecycle = new AbortController();
document.addEventListener('visibilitychange', () => admin.setVisible(!document.hidden), { signal: lifecycle.signal });
void (async () => {
  const status = document.querySelector<HTMLElement>('#server-status');
  const card = document.querySelector<HTMLElement>('.status-card');
  if (!status || !card) return;
  try {
    const response = await fetch('/api/health', {
      credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(5_000)]),
    });
    const data: unknown = await response.json();
    if (!response.ok || typeof data !== 'object' || data === null || !('status' in data) || data.status !== 'ok') throw new Error();
    if (lifecycle.signal.aborted) return;
    status.textContent = 'Сервер доступний';
    card.dataset.state = 'ok';
  } catch {
    if (lifecycle.signal.aborted) return;
    status.textContent = 'Сервер недоступний. Перевірте з’єднання та оновіть сторінку.';
    card.dataset.state = 'error';
  }
})();

window.addEventListener('pagehide', () => {
  lifecycle.abort();
  jobs.endSession();
  admin.endSession();
  adminView.destroy();
  view.clearPrivate();
  unsubscribe();
  unsubscribeAdmin();
  auth?.destroy();
}, { once: true });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
