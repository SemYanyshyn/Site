import type { RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import type { PublicUser } from '../../shared/auth.js';
import { sendError } from './errors.js';
import { findSessionUser, readSessionToken } from './sessions.js';

// перед захищеним маршрутом перевіряю сесію в PostgreSQL і передаю користувача через response.locals
// next віддає запит наступному обробнику лише після перевірки
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
