// Тут описую HTTP-маршрути реєстрації, входу, перевірки сесії та виходу
// request містить дані браузера, response формує відповідь, а pool виконує запити до PostgreSQL
// Перед змінами перевіряю точний Origin і JSON, тому сам факт наявності cookie ще не дозволяє довільний POST

import { randomUUID } from "node:crypto";
import express from "express";
import type { Pool } from "pg";
import { validateCredentials } from "../../shared/auth.js";
import type { AuthResponse } from "../../shared/auth.js";
import type { AppConfig } from "../config.js";
import { isDatabaseReady } from "../database.js";
import { databaseUnavailable, HttpError, sendError } from "./errors.js";
import { requireAuth } from "./middleware.js";
import { hashPassword, verifyPassword } from "./password.js";
import { jsonMutationGuard } from "../http/json.js";
import {
  clearSessionCookie,
  createSession,
  hashSessionToken,
  publicUser,
  readSessionToken,
  setSessionCookie,
} from "./sessions.js";
import type { UserRow } from "./sessions.js";

interface LoginRow extends UserRow {
  password_hash: string;
}

// Перед запитами до користувачів перевіряю, що БД доступна й необхідні міграції вже застосовані
async function assertDatabaseReady(pool: Pool): Promise<void> {
  if (!(await isDatabaseReady(pool))) throw databaseUnavailable();
}

// Тут описую реєстрацію, вхід, перевірку сесії та вихід; сервер підключає ці маршрути за /api/auth
// Збираю обробники /api/auth в окремий router і передаю їм налаштування та спільний пул
// Реєстрація створює користувача, а сесія й cookie з’являються тільки після успішного входу
export function createAuthRouter(
  config: AppConfig,
  pool: Pool,
): express.Router {
  const router = express.Router();
  // Для POST перевіряю дозволений Origin, формат JSON і розмір тіла запиту до 16 КіБ
  router.use(jsonMutationGuard(config, "16kb"));

  // При реєстрації завжди створюю звичайного user; роль admin із запиту не приймаю
  // Для реєстрації перевіряю логін і пароль, обчислюю хеш та додаю користувача з роллю user
  // Параметри SQL передаю окремо від тексту запиту, щоб введення користувача не стало SQL-кодом
  router.post("/register", async (request, response) => {
    // Спочатку перевіряю логін і пароль; неправильні дані повертаю клієнту з кодом 400
    const credentials = validateCredentials(request.body);
    if (!credentials.ok) {
      sendError(response, 400, "VALIDATION_ERROR", credentials.message);
      return;
    }
    await assertDatabaseReady(pool);
    const { username, password } = credentials.value;
    // Зберігаю хеш пароля, а не сам пароль: hashPassword додає випадкову сіль і виконує scrypt
    const passwordHash = await hashPassword(password);
    let row: UserRow | undefined;
    try {
      // Передаю значення через параметри $1–$4, щоб дані користувача не ставали частиною SQL-команди
      const result = await pool.query<UserRow>(
        `
        INSERT INTO users (id, username, normalized_username, password_hash, role)
        VALUES ($1, $2, $3, $4, 'user')
        RETURNING id, username, role, created_at
      `,
        [randomUUID(), username, username.toLowerCase(), passwordHash],
      );
      row = result.rows[0];
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        // Код PostgreSQL 23505 означає порушення унікальності: повідомляю, що логін уже зайнятий
        throw new HttpError(
          409,
          "USERNAME_TAKEN",
          "Цей логін уже зайнятий. Оберіть інший.",
        );
      }
      throw databaseUnavailable();
    }
    if (!row) throw new Error("Registration did not return a user.");
    // Повертаю тільки відкриті дані користувача. Реєстрація ще не створює сесію — після неї потрібно ввійти
    const body: AuthResponse = { user: publicUser(row) };
    response.status(201).json(body);
  });

  // Під час входу знаходжу користувача й перевіряю пароль перед створенням сесії
  // Для входу знаходжу користувача, перевіряю пароль і створюю нову сесію в базі
  // У браузер віддаю HttpOnly cookie з випадковим токеном, а не пароль або його хеш
  router.post("/login", async (request, response) => {
    const credentials = validateCredentials(request.body);
    if (!credentials.ok) {
      sendError(response, 400, "VALIDATION_ERROR", credentials.message);
      return;
    }
    await assertDatabaseReady(pool);
    const { username, password } = credentials.value;
    let row: LoginRow | undefined;
    try {
      // Шукаю за нормалізованим логіном, тому великі й малі літери в ньому не розрізняю
      const result = await pool.query<LoginRow>(
        `
        SELECT id, username, password_hash, role, created_at
        FROM users WHERE normalized_username = $1
      `,
        [username.toLowerCase()],
      );
      row = result.rows[0];
    } catch {
      throw databaseUnavailable();
    }
    // Для невідомого логіна також виконую scrypt і повертаю ту саму помилку, що й для неправильного пароля
    // Так повідомленням помилки не підказую, чи існує цей обліковий запис
    const validPassword = row
      ? await verifyPassword(password, row.password_hash)
      : (await hashPassword(password), false);
    if (!row || !validPassword) {
      sendError(
        response,
        401,
        "INVALID_CREDENTIALS",
        "Неправильний логін або пароль.",
      );
      return;
    }
    // Після успішної перевірки створюю сесію у спільній PostgreSQL із заданим строком дії
    const session = await createSession(
      pool,
      row.id,
      readSessionToken(request),
      config.sessionTtlSeconds,
    );
    // Передаю токен браузеру через HttpOnly-cookie; сам токен у JSON-відповідь не додаю
    setSessionCookie(response, session.token, session.expiresAt, config);
    const body: AuthResponse = { user: publicUser(row) };
    response.json(body);
  });

  // Через GET /me браузер дізнається, хто зараз увійшов, зокрема після оновлення сторінки
  // requireAuth перевіряє cookie й сесію та передає користувача через response.locals.user
  // Для відновлення входу після оновлення сторінки повертаю користувача поточної сесії
  // Пароль, хеш і токен у цю JSON-відповідь не додаю
  router.get(
    "/me",
    async (_request, _response, next) => {
      await assertDatabaseReady(pool);
      next();
    },
    requireAuth(pool),
    (_request, response) => {
      const body: AuthResponse = { user: response.locals.user };
      response.json(body);
    },
  );

  // Через POST /logout завершую поточну сесію; клієнт має надіслати порожній JSON-об’єкт
  // При виході видаляю саме поточну сесію з бази й очищую відповідну cookie
  // Інші облікові записи та їхні задачі тут не змінюю
  router.post("/logout", async (request, response) => {
    if (
      typeof request.body !== "object" ||
      request.body === null ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      sendError(
        response,
        400,
        "VALIDATION_ERROR",
        "Для виходу передайте порожній JSON-об’єкт.",
      );
      return;
    }
    await assertDatabaseReady(pool);
    // Читаю токен із cookie й видаляю відповідну сесію з БД за хешем токена
    const token = readSessionToken(request);
    try {
      if (token)
        await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
          hashSessionToken(token),
        ]);
    } catch {
      throw databaseUnavailable();
    }
    // Очищую cookie в браузері; код 204 означає успішний вихід без тіла відповіді
    clearSessionCookie(response, config);
    response.status(204).end();
  });
  return router;
}
