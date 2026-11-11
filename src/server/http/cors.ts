
import type { RequestHandler } from 'express';
import type { AppConfig } from '../config.js';
import { normalizeOrigin } from '../config.js';
import { sendError } from '../auth/errors.js';

export function apiCors(config: AppConfig): RequestHandler {
  return (request, response, next) => {
    response.vary('Origin');
    const origin = request.get('Origin');
    if (origin !== undefined) {
      const normalized = normalizeOrigin(origin);
      if (!normalized || !config.appOrigins.has(normalized)) {
        sendError(response, 403, 'ORIGIN_FORBIDDEN', 'Походження запиту не дозволене.');
        return;
      }
      response.set('Access-Control-Allow-Origin', normalized);
      response.set('Access-Control-Allow-Credentials', 'true');
      response.set('Access-Control-Expose-Headers', 'X-Instance-Id');
    }
    if (request.method !== 'OPTIONS') { next(); return; }
    response.vary('Access-Control-Request-Method');
    response.vary('Access-Control-Request-Headers');
    const method = request.get('Access-Control-Request-Method');
    const headers = (request.get('Access-Control-Request-Headers') ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!origin || !method || !['GET', 'POST'].includes(method) || headers.some((value) => value !== 'content-type')) {
      sendError(response, 403, 'PREFLIGHT_FORBIDDEN', 'Попередній запит не дозволений.');
      return;
    }
    response.set('Access-Control-Allow-Methods', 'GET, POST');
    response.set('Access-Control-Allow-Headers', 'Content-Type');
    response.set('Cache-Control', 'no-store');
    response.status(204).end();
  };
}
