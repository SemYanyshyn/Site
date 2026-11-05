// Тут пов’язую браузерну cookie із сесією в PostgreSQL
// Браузер зберігає випадковий токен, а в таблицю sessions записую тільки його SHA-256 хеш
// Так різні HTTP-процеси можуть перевіряти один вхід через спільну базу

import { createHash, randomBytes } from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { PublicUser } from '../../shared/auth.js';
import { databaseUnavailable } from './errors.js';

export const SESSION_COOKIE = 'courier_session';

export interface UserRow {
  id: string;
  username: string;
  role: 'user' | 'admin';
  created_at: Date;
}

// Вибираю лише поля користувача, які можна показати клієнту, без хешу пароля
export function publicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at.toISOString() };
}

// Приймаю з cookie лише токен потрібного формату, довільний рядок до бази не передаю
export function readSessionToken(request: Request): string | null {
  const token = parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

// Обчислюю хеш токена для пошуку сесії, а сам токен у базі не зберігаю
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Встановлюю HttpOnly cookie, щоб JavaScript сторінки не читав токен
// Secure обмежує передавання HTTPS, а SameSite і строк життя беру з перевірених налаштувань
export function setSessionCookie(response: Response, token: string, expiresAt: Date, config: AppConfig): void {
  response.setHeader('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE, value: token,
    path: '/', httpOnly: true, sameSite: config.sessionCookieSameSite ?? 'lax', secure: config.cookieSecure,
    maxAge: config.sessionTtlSeconds, expires: expiresAt,
  }));
}

// Прибираю cookie з тими самими атрибутами, з якими її встановив
export function clearSessionCookie(response: Response, config: AppConfig): void {
  response.setHeader('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE, value: '',
    path: '/', httpOnly: true, sameSite: config.sessionCookieSameSite ?? 'lax', secure: config.cookieSecure,
    maxAge: 0, expires: new Date(0),
  }));
}

// браузер отримує випадковий токен у HttpOnly cookie а в БД зберігаю лише його хеш і строк дії
// У транзакції прибираю прострочені сесії та замінюю попередню сесію цієї cookie
// Записую новий хеш і строк дії, а токен повертаю лише після успішного commit
export async function createSession(
  pool: Pool, userId: string, previousToken: string | null, ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Після успішного входу також прибираю прострочені сесії невеликим SQL-запитом
    // Сесії читаю з бази без локального кешу й окремого планувальника очищення
    await client.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    if (previousToken) {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(previousToken)]);
    }
    const inserted = await client.query<{ expires_at: Date }>(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, clock_timestamp() + $3 * INTERVAL '1 second')
      RETURNING expires_at
    `, [hashSessionToken(token), userId, ttlSeconds]);
    const expiresAt = inserted.rows[0]?.expires_at;
    if (!expiresAt) throw new Error('Session was not created.');
    await client.query('COMMIT');
    return { token, expiresAt };
  } catch {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw databaseUnavailable();
  } finally {
    client?.release();
  }
}

// за токеном шукаю чинну сесію разом з актуальною роллю користувача в спільній БД
// Зіставляю хеш токена з непростроченою сесією та читаю актуальну роль користувача
// Роль не беру зі значень, які надіслав браузер
export async function findSessionUser(pool: Pool, token: string): Promise<PublicUser | null> {
  try {
    const result = await pool.query<UserRow>(`
      SELECT u.id, u.username, u.role, u.created_at
      FROM sessions AS s JOIN users AS u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW()
    `, [hashSessionToken(token)]);
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  } catch {
    throw databaseUnavailable();
  }
}
