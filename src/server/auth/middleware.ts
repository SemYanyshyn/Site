import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendError } from './errors.js';
import { findSessionUser, readSessionToken } from './sessions.js';

// Future APIs can reuse this middleware, then use response.locals.user. The
// validity of each request comes from PostgreSQL, including its expiry time.
export function requireAuth(pool: Pool): RequestHandler {
  return async (request, response, next) => {
    try {
      const token = readSessionToken(request);
      const user = token ? await findSessionUser(pool, token) : null;
      if (!user) {
        sendError(response, 401, 'AUTH_REQUIRED', 'Увійдіть до облікового запису. Строк сесії міг завершитися.');
        return;
      }
      response.locals.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
