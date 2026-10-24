import type { RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import type { PublicUser } from '../../shared/auth.js';
import { sendError } from './errors.js';
import { findSessionUser, readSessionToken } from './sessions.js';

// Future APIs can reuse this middleware, then use response.locals.user. The
// validity of each request comes from PostgreSQL, including its expiry time.
export function requireAuth(pool: Pool,
  lookup: (token: string, response: Response) => Promise<PublicUser | null> = (token) => findSessionUser(pool, token),
): RequestHandler {
  return async (request, response, next) => {
    try {
      const token = readSessionToken(request);
      const user = token ? await lookup(token, response) : null;
      if (response.headersSent || response.destroyed) return;
      if (!user) {
        sendError(response, 401, 'AUTH_REQUIRED', 'Увійдіть до облікового запису. Строк сесії міг завершитися.');
        return;
      }
      response.locals.user = user;
      next();
    } catch (error) {
      if (!response.headersSent && !response.destroyed) next(error);
    }
  };
}
