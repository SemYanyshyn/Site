import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { UserRow } from '../auth/sessions.js';
import { hashSessionToken, publicUser } from '../auth/sessions.js';
import { HttpError } from '../auth/errors.js';
import { requireAuth } from '../auth/middleware.js';
import { adminRead } from './budget.js';

/** Same persisted session contract as requireAuth; deliberately no role cache.
 * Its lookup participates in the admin request's pre-auth absolute deadline. */
export function requireAdmin(pool: Pool): RequestHandler {
  const authenticated = requireAuth(pool, (token, response) =>
    adminRead(pool, Number(response.locals.adminDeadline), response.locals.adminSignal as AbortSignal, async (query) => {
        const result = await query<UserRow>(`SELECT u.id, u.username, u.role, u.created_at
          FROM sessions AS s JOIN users AS u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > clock_timestamp()`, [hashSessionToken(token)]);
        return result.rows[0] ? publicUser(result.rows[0]) : null;
      }));
  return (request, response, next) => authenticated(request, response, (error?: unknown) => {
    if (error) { next(error); return; }
    if (response.locals.user?.role !== 'admin') {
      next(new HttpError(403, 'ADMIN_REQUIRED', 'Потрібна актуальна роль адміністратора.'));
      return;
    }
    next();
  });
}
