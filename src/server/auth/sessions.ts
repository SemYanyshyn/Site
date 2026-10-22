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

export function publicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at.toISOString() };
}

export function readSessionToken(request: Request): string | null {
  const token = parseCookie(request.headers.cookie ?? '')[SESSION_COOKIE];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setSessionCookie(response: Response, token: string, expiresAt: Date, config: AppConfig): void {
  response.setHeader('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE, value: token,
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure,
    maxAge: config.sessionTtlSeconds, expires: expiresAt,
  }));
}

export function clearSessionCookie(response: Response, config: AppConfig): void {
  response.setHeader('Set-Cookie', stringifySetCookie({
    name: SESSION_COOKIE, value: '',
    path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure,
    maxAge: 0, expires: new Date(0),
  }));
}

export async function createSession(
  pool: Pool, userId: string, previousToken: string | null, ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // A successful login also performs the small expiry cleanup; there is no
    // local session cache or separate scheduler.
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
