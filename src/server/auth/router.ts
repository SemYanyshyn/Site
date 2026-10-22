import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Pool } from 'pg';
import { validateCredentials } from '../../shared/auth.js';
import type { AuthResponse } from '../../shared/auth.js';
import { normalizeOrigin } from '../config.js';
import type { AppConfig } from '../config.js';
import { isDatabaseReady } from '../database.js';
import { databaseUnavailable, HttpError, sendError } from './errors.js';
import { requireAuth } from './middleware.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  clearSessionCookie, createSession, hashSessionToken, publicUser, readSessionToken, setSessionCookie,
} from './sessions.js';
import type { UserRow } from './sessions.js';

interface LoginRow extends UserRow {
  password_hash: string;
}

async function assertDatabaseReady(pool: Pool): Promise<void> {
  if (!await isDatabaseReady(pool)) throw databaseUnavailable();
}

export function createAuthRouter(config: AppConfig, pool: Pool): express.Router {
  const router = express.Router();
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
      next();
      return;
    }
    const origin = request.get('Origin');
    const normalized = origin ? normalizeOrigin(origin) : null;
    if (!normalized || !config.appOrigins.has(normalized)) {
      sendError(response, 403, 'ORIGIN_FORBIDDEN', 'Походження запиту не дозволене.');
      return;
    }
    const contentType = request.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Для цього запиту потрібен Content-Type: application/json.');
      return;
    }
    express.json({ limit: '16kb', strict: true, type: () => true })(request, response, next);
  });

  router.post('/register', async (request, response) => {
    const credentials = validateCredentials(request.body);
    if (!credentials.ok) {
      sendError(response, 400, 'VALIDATION_ERROR', credentials.message);
      return;
    }
    await assertDatabaseReady(pool);
    const { username, password } = credentials.value;
    const passwordHash = await hashPassword(password);
    let row: UserRow | undefined;
    try {
      const result = await pool.query<UserRow>(`
        INSERT INTO users (id, username, normalized_username, password_hash, role)
        VALUES ($1, $2, $3, $4, 'user')
        RETURNING id, username, role, created_at
      `, [randomUUID(), username, username.toLowerCase(), passwordHash]);
      row = result.rows[0];
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new HttpError(409, 'USERNAME_TAKEN', 'Цей логін уже зайнятий. Оберіть інший.');
      }
      throw databaseUnavailable();
    }
    if (!row) throw new Error('Registration did not return a user.');
    const body: AuthResponse = { user: publicUser(row) };
    response.status(201).json(body);
  });

  router.post('/login', async (request, response) => {
    const credentials = validateCredentials(request.body);
    if (!credentials.ok) {
      sendError(response, 400, 'VALIDATION_ERROR', credentials.message);
      return;
    }
    await assertDatabaseReady(pool);
    const { username, password } = credentials.value;
    let row: LoginRow | undefined;
    try {
      const result = await pool.query<LoginRow>(`
        SELECT id, username, password_hash, role, created_at
        FROM users WHERE normalized_username = $1
      `, [username.toLowerCase()]);
      row = result.rows[0];
    } catch {
      throw databaseUnavailable();
    }
    // An unknown username also performs the password KDF. The public error is
    // identical to the wrong-password error and no session is created.
    const validPassword = row
      ? await verifyPassword(password, row.password_hash)
      : (await hashPassword(password), false);
    if (!row || !validPassword) {
      sendError(response, 401, 'INVALID_CREDENTIALS', 'Неправильний логін або пароль.');
      return;
    }
    const session = await createSession(pool, row.id, readSessionToken(request), config.sessionTtlSeconds);
    setSessionCookie(response, session.token, session.expiresAt, config);
    const body: AuthResponse = { user: publicUser(row) };
    response.json(body);
  });

  router.get('/me', async (_request, _response, next) => {
    await assertDatabaseReady(pool);
    next();
  }, requireAuth(pool), (_request, response) => {
    const body: AuthResponse = { user: response.locals.user };
    response.json(body);
  });

  router.post('/logout', async (request, response) => {
    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body) || Object.keys(request.body).length !== 0) {
      sendError(response, 400, 'VALIDATION_ERROR', 'Для виходу передайте порожній JSON-об’єкт.');
      return;
    }
    await assertDatabaseReady(pool);
    const token = readSessionToken(request);
    try {
      if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
    } catch {
      throw databaseUnavailable();
    }
    clearSessionCookie(response, config);
    response.status(204).end();
  });
  return router;
}
