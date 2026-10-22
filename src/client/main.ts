import './styles.css';
import type { HealthResponse } from '../shared/health.js';
import { validateCredentials } from '../shared/auth.js';
import type { ApiErrorResponse, AuthResponse, PublicUser } from '../shared/auth.js';

const statusElement = document.querySelector<HTMLParagraphElement>('#server-status');
const statusCard = document.querySelector<HTMLDivElement>('.status-card');

if (!statusElement || !statusCard) {
  throw new Error('Не знайдено елементи статусу сервера.');
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'instanceId' in value &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0
  );
}

async function checkHealth(status: HTMLParagraphElement, card: HTMLDivElement): Promise<void> {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health: unknown = await response.json();
    if (!isHealthResponse(health)) throw new Error('Некоректна відповідь сервера.');

    status.textContent = 'Сервер доступний';
    card.dataset.state = 'ok';
  } catch {
    status.textContent = 'Сервер недоступний. Перевірте його запуск і оновіть сторінку.';
    card.dataset.state = 'error';
  }
}

void checkHealth(statusElement, statusCard);

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не знайдено елемент інтерфейсу: ${selector}`);
  return element;
}

const authCard = requireElement<HTMLElement>('.auth-card');
const authTitle = requireElement<HTMLHeadingElement>('#auth-title');
const authMessage = requireElement<HTMLParagraphElement>('#auth-message');
const authForms = requireElement<HTMLDivElement>('#auth-forms');
const authForm = requireElement<HTMLFormElement>('#auth-form');
const authFields = requireElement<HTMLFieldSetElement>('#auth-fields');
const usernameInput = requireElement<HTMLInputElement>('#username');
const passwordInput = requireElement<HTMLInputElement>('#password');
const submitButton = requireElement<HTMLButtonElement>('#auth-submit');
const loginModeButton = requireElement<HTMLButtonElement>('#login-mode');
const registerModeButton = requireElement<HTMLButtonElement>('#register-mode');
const userState = requireElement<HTMLDivElement>('#user-state');
const currentUsername = requireElement<HTMLElement>('#current-username');
const logoutButton = requireElement<HTMLButtonElement>('#logout');

type AuthMode = 'login' | 'register';
let mode: AuthMode = 'login';
let currentUser: PublicUser | null = null;
let busy = true;
let sessionChecked = false;

function renderAuth(): void {
  authCard.setAttribute('aria-busy', String(busy));
  authForms.hidden = !sessionChecked || currentUser !== null;
  userState.hidden = currentUser === null;
  authFields.disabled = busy;
  loginModeButton.disabled = busy;
  registerModeButton.disabled = busy;
  logoutButton.disabled = busy;
  loginModeButton.setAttribute('aria-pressed', String(mode === 'login'));
  registerModeButton.setAttribute('aria-pressed', String(mode === 'register'));
  passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  authTitle.textContent = currentUser ? 'Ваш обліковий запис' : mode === 'login' ? 'Вхід до облікового запису' : 'Створення облікового запису';
  submitButton.textContent = busy ? (mode === 'login' ? 'Входимо…' : 'Створюємо…') : (mode === 'login' ? 'Увійти' : 'Зареєструватися');
  logoutButton.textContent = busy ? 'Виходимо…' : 'Вийти';
  currentUsername.textContent = currentUser?.username ?? '';
}

function showAuthMessage(message: string, state: 'info' | 'error' | 'success' = 'info'): void {
  authMessage.textContent = message;
  authMessage.dataset.state = state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthResponse(value: unknown): value is AuthResponse {
  if (!isRecord(value) || !isRecord(value.user)) return false;
  const user = value.user;
  return typeof user.id === 'string' && user.id.length > 0 &&
    typeof user.username === 'string' && user.username.length > 0 &&
    (user.role === 'user' || user.role === 'admin') &&
    typeof user.createdAt === 'string';
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

class AuthRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function authRequest(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const response = await fetch(`/api/auth/${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    ...(method === 'POST' ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    } : {}),
  });
  if (response.status === 204) return null;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isApiError(data) ? data.message : response.status === 503
      ? 'База даних тимчасово недоступна. Спробуйте знову пізніше.'
      : 'Не вдалося виконати запит. Спробуйте знову.';
    throw new AuthRequestError(response.status, message);
  }
  if (!isAuthResponse(data)) throw new AuthRequestError(response.status, 'Некоректна відповідь сервера. Оновіть сторінку.');
  return data;
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) return error.message;
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'Сервер не відповів вчасно. Перевірте стан входу, оновивши сторінку.';
  }
  return 'Не вдалося зв’язатися із сервером. Перевірте з’єднання та спробуйте знову.';
}

function setMode(nextMode: AuthMode): void {
  if (busy) return;
  mode = nextMode;
  passwordInput.value = '';
  showAuthMessage(mode === 'register' ? 'Створіть обліковий запис, а потім увійдіть.' : 'Введіть логін і пароль свого облікового запису.');
  renderAuth();
  usernameInput.focus();
}

loginModeButton.addEventListener('click', () => setMode('login'));
registerModeButton.addEventListener('click', () => setMode('register'));

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const credentials = validateCredentials({ username: usernameInput.value, password: passwordInput.value });
  if (!credentials.ok) {
    showAuthMessage(credentials.message, 'error');
    return;
  }
  const action = mode;
  busy = true;
  showAuthMessage(action === 'login' ? 'Перевіряємо логін і пароль…' : 'Створюємо обліковий запис…');
  renderAuth();
  void (async () => {
    try {
      const response = await authRequest(action, 'POST', credentials.value);
      if (!isAuthResponse(response)) throw new Error('Некоректна відповідь сервера.');
      passwordInput.value = '';
      usernameInput.value = response.user.username;
      if (action === 'register') {
        mode = 'login';
        showAuthMessage('Обліковий запис створено. Увійдіть, використовуючи свій пароль.', 'success');
      } else {
        currentUser = response.user;
        showAuthMessage('Вхід виконано.', 'success');
      }
    } catch (error) {
      showAuthMessage(requestErrorMessage(error), 'error');
    } finally {
      busy = false;
      renderAuth();
      if (action === 'register' && mode === 'login') passwordInput.focus();
    }
  })();
});

logoutButton.addEventListener('click', () => {
  if (busy) return;
  busy = true;
  showAuthMessage('Завершуємо сеанс…');
  renderAuth();
  void (async () => {
    try {
      await authRequest('logout', 'POST');
      currentUser = null;
      mode = 'login';
      passwordInput.value = '';
      showAuthMessage('Ви вийшли з облікового запису. Можна увійти знову.', 'success');
    } catch (error) {
      if (error instanceof AuthRequestError && error.status === 401) {
        currentUser = null;
        showAuthMessage('Сеанс завершився. Увійдіть знову.');
      } else {
        showAuthMessage(requestErrorMessage(error), 'error');
      }
    } finally {
      busy = false;
      renderAuth();
      if (!currentUser) usernameInput.focus();
    }
  })();
});

async function restoreSession(): Promise<void> {
  try {
    const response = await authRequest('me', 'GET');
    if (!isAuthResponse(response)) throw new Error('Некоректна відповідь сервера.');
    currentUser = response.user;
    showAuthMessage('Вхід відновлено.', 'success');
  } catch (error) {
    if (error instanceof AuthRequestError && error.status === 401) {
      currentUser = null;
      showAuthMessage('Увійдіть до свого облікового запису або зареєструйтеся.');
    } else {
      showAuthMessage(requestErrorMessage(error), 'error');
    }
  } finally {
    sessionChecked = true;
    busy = false;
    renderAuth();
  }
}

renderAuth();
void restoreSession();
