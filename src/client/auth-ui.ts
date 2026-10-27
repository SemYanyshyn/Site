import { validateCredentials } from "../shared/auth.js";
import type { AuthResponse, PublicUser } from "../shared/auth.js";

export interface AuthCallbacks {
  onAuthenticated: (user: PublicUser) => void;
  onSignedOut: () => void;
  onSigningOut?: () => void;
  onRoleChanged?: (user: PublicUser) => void;
}

export interface AuthHandle {
  expireSession: () => void;
  loseAdminRole: () => void;
  destroy: () => void;
}

class AuthRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthResponse(value: unknown): value is AuthResponse {
  if (!isRecord(value) || !isRecord(value.user)) return false;
  const user = value.user;
  return (
    typeof user.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(user.id) &&
    typeof user.username === "string" &&
    user.username.length > 0 &&
    user.username.length <= 32 &&
    (user.role === "user" || user.role === "admin") &&
    typeof user.createdAt === "string" &&
    Number.isFinite(Date.parse(user.createdAt))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) return error.message;
  return "Не вдалося зв’язатися із сервером. Перевірте з’єднання та спробуйте знову.";
}

/** Authentication owns only its forms; private jobs are cleared by callbacks. */
export function mountAuth(callbacks: AuthCallbacks): AuthHandle {
  const element = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (!found) throw new Error(`Не знайдено елемент інтерфейсу: ${selector}`);
    return found;
  };
  const card = element<HTMLElement>(".auth-card");
  const title = element<HTMLElement>("#auth-title");
  const message = element<HTMLElement>("#auth-message");
  const forms = element<HTMLElement>("#auth-forms");
  const form = element<HTMLFormElement>("#auth-form");
  const fields = element<HTMLFieldSetElement>("#auth-fields");
  const username = element<HTMLInputElement>("#username");
  const password = element<HTMLInputElement>("#password");
  const submit = element<HTMLButtonElement>("#auth-submit");
  const loginMode = element<HTMLButtonElement>("#login-mode");
  const registerMode = element<HTMLButtonElement>("#register-mode");
  const userState = element<HTMLElement>("#user-state");
  const currentUsername = element<HTMLElement>("#current-username");
  const logout = element<HTMLButtonElement>("#logout");
  const listeners = new AbortController();
  let request = new AbortController();
  let generation = 0;
  let mode: "login" | "register" = "login";
  let user: PublicUser | null = null;
  let busy = true;
  let checked = false;
  let destroyed = false;

  function say(
    text: string,
    state: "info" | "error" | "success" = "info",
  ): void {
    message.textContent = text;
    message.dataset.state = state;
  }

  function render(): void {
    card.setAttribute("aria-busy", String(busy));
    forms.hidden = !checked || user !== null;
    userState.hidden = user === null;
    fields.disabled = busy;
    loginMode.disabled = busy;
    registerMode.disabled = busy;
    logout.disabled = busy;
    loginMode.setAttribute("aria-pressed", String(mode === "login"));
    registerMode.setAttribute("aria-pressed", String(mode === "register"));
    password.autocomplete =
      mode === "register" ? "new-password" : "current-password";
    title.textContent = user
      ? "Ваш обліковий запис"
      : mode === "login"
        ? "Вхід до облікового запису"
        : "Створення облікового запису";
    submit.textContent =
      mode === "login"
        ? busy
          ? "Входимо…"
          : "Увійти"
        : busy
          ? "Створюємо…"
          : "Зареєструватися";
    logout.textContent = busy ? "Виходимо…" : "Вийти";
    currentUsername.textContent = user?.username ?? "";
  }

  function nextGeneration(): number {
    request.abort();
    request = new AbortController();
    return ++generation;
  }

  async function send(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<AuthResponse | null> {
    const response = await fetch(`/api/auth/${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      ...(method === "POST"
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          }
        : {}),
    });
    if (response.status === 204) return null;
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const text =
        isRecord(data) &&
        typeof data.code === "string" &&
        typeof data.message === "string"
          ? data.message
          : response.status === 503
            ? "База даних тимчасово недоступна. Спробуйте пізніше."
            : "Не вдалося виконати запит. Спробуйте знову.";
      throw new AuthRequestError(response.status, text);
    }
    if (!isAuthResponse(data))
      throw new AuthRequestError(
        response.status,
        "Некоректна відповідь сервера. Оновіть сторінку.",
      );
    return data;
  }

  function expireSession(): void {
    if (destroyed) return;
    nextGeneration();
    user = null;
    checked = true;
    busy = false;
    mode = "login";
    username.value = "";
    password.value = "";
    callbacks.onSignedOut();
    say("Сеанс завершився. Увійдіть знову.");
    render();
  }

  for (const [button, nextMode] of [
    [loginMode, "login"],
    [registerMode, "register"],
  ] as const) {
    button.addEventListener(
      "click",
      () => {
        if (busy) return;
        mode = nextMode;
        password.value = "";
        say(
          mode === "register"
            ? "Створіть обліковий запис, а потім увійдіть."
            : "Введіть логін і пароль свого облікового запису.",
        );
        render();
        username.focus();
      },
      { signal: listeners.signal },
    );
  }

  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (busy) return;
      const credentials = validateCredentials({
        username: username.value,
        password: password.value,
      });
      if (!credentials.ok) {
        say(credentials.message, "error");
        return;
      }
      const action = mode;
      const version = nextGeneration();
      busy = true;
      say(
        action === "login"
          ? "Перевіряємо логін і пароль…"
          : "Створюємо обліковий запис…",
      );
      render();
      void (async () => {
        try {
          const response = await send(action, "POST", credentials.value);
          if (destroyed || version !== generation) return;
          if (response === null)
            throw new Error("Некоректна відповідь сервера.");
          password.value = "";
          username.value = response.user.username;
          if (action === "register") {
            mode = "login";
            say(
              "Обліковий запис створено. Увійдіть, використовуючи свій пароль.",
              "success",
            );
          } else {
            user = response.user;
            callbacks.onAuthenticated(user);
            say("Вхід виконано.", "success");
          }
        } catch (error) {
          if (destroyed || version !== generation) return;
          say(errorMessage(error), "error");
        } finally {
          if (!destroyed && version === generation) {
            busy = false;
            render();
            if (action === "register" && mode === "login") password.focus();
          }
        }
      })();
    },
    { signal: listeners.signal },
  );

  logout.addEventListener(
    "click",
    () => {
      if (busy) return;
      const version = nextGeneration();
      callbacks.onSigningOut?.();
      busy = true;
      say("Завершуємо сеанс…");
      render();
      void (async () => {
        try {
          await send("logout", "POST");
          if (destroyed || version !== generation) return;
          user = null;
          mode = "login";
          username.value = "";
          password.value = "";
          callbacks.onSignedOut();
          say("Ви вийшли з облікового запису.", "success");
        } catch (error) {
          if (destroyed || version !== generation) return;
          if (error instanceof AuthRequestError && error.status === 401) {
            expireSession();
            return;
          }
          if (user) callbacks.onRoleChanged?.(user);
          say(errorMessage(error), "error");
        } finally {
          if (!destroyed && version === generation) {
            busy = false;
            render();
          }
        }
      })();
    },
    { signal: listeners.signal },
  );

  render();
  const version = generation;
  void (async () => {
    try {
      const response = await send("me", "GET");
      if (destroyed || version !== generation) return;
      if (response === null)
        throw new Error("Некоректна відповідь сервера.");
      user = response.user;
      callbacks.onAuthenticated(user);
      say("Вхід відновлено.", "success");
    } catch (error) {
      if (destroyed || version !== generation) return;
      if (error instanceof AuthRequestError && error.status === 401)
        say("Увійдіть до свого облікового запису або зареєструйтеся.");
      else say(errorMessage(error), "error");
    } finally {
      if (!destroyed && version === generation) {
        checked = true;
        busy = false;
        render();
      }
    }
  })();

  return {
    expireSession,
    loseAdminRole: () => {
      if (destroyed || !user || user.role !== "admin") return;
      user = { ...user, role: "user" };
      callbacks.onRoleChanged?.(user);
      say("Доступ адміністратора знято. Ваші особисті маршрути доступні.");
      render();
    },
    destroy: () => {
      destroyed = true;
      nextGeneration();
      listeners.abort();
      password.value = "";
    },
  };
}
