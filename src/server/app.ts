import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Pool } from 'pg';
import type { HealthResponse } from '../shared/health.js';
import type { AppConfig } from './config.js';
import { isDatabaseReady } from './database.js';
import { databaseUnavailable, HttpError, sendError } from './auth/errors.js';
import { createAuthRouter } from './auth/router.js';
import type { RouteLimits } from '../shared/route.js';
import { readRouteConfig } from './route/config.js';
import { readJobsConfig } from './jobs/config.js';
import type { JobsConfig } from './jobs/config.js';
import { JobsRepository } from './jobs/repository.js';
import { createJobsRouter } from './jobs/router.js';
import { AdminService } from './admin/service.js';
import { createAdminRouter } from './admin/router.js';

interface AppOptions {
  config: AppConfig;
  pool: Pool;
  instanceId?: string;
  routeLimits?: RouteLimits;
  jobsConfig?: JobsConfig;
  jobsRepository?: JobsRepository;
  adminService?: AdminService;
}

// підключаю HTTP маршрути й готові файли клієнта але сам порт відкривається в index.ts
export function createApp({
  config, pool, instanceId = randomUUID(), routeLimits = readRouteConfig(), jobsConfig = readJobsConfig(),
  jobsRepository = new JobsRepository(pool),
  adminService = new AdminService(pool),
}: AppOptions): express.Express {
  const app = express();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new Error('Ідентифікатор HTTP-процесу має бути UUID.');
  }
  const clientDirectory = fileURLToPath(new URL('../client', import.meta.url));
  app.disable('x-powered-by');
  app.use('/api', (_request, response, next) => {
    // заголовок містить UUID фактичного процесу обраного Traefik а не значення від клієнта
    response.set('X-Instance-Id', instanceId);
    next();
  });

  app.get('/api/health', (_request, response) => {
    const health: HealthResponse = { status: 'ok', instanceId };
    response.set('Cache-Control', 'no-store').json(health);
  });

  // readiness перевіряє також готовність БД і схеми а health лише відповідає від живого HTTP процесу
  app.get('/api/ready', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!await isDatabaseReady(pool)) {
      const error = databaseUnavailable();
      sendError(response, error.status, error.code, error.message);
      return;
    }
    response.json({ status: 'ready' });
  });

  app.use('/api/auth', createAuthRouter(config, pool));
  app.use('/api/jobs', createJobsRouter(config, pool, jobsRepository, routeLimits, jobsConfig));
  app.use('/api/admin', createAdminRouter(pool, adminService));
  app.use('/api', (_request, response) => {
    sendError(response, 404, 'NOT_FOUND', 'API-маршрут не знайдено.');
  });
  app.use(express.static(clientDirectory));
  app.use((_request, response) => {
    sendError(response, 404, 'NOT_FOUND', 'Сторінку не знайдено.');
  });

  // спільний обробник перетворює помилки на API відповіді без внутрішніх даних і секретів
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      sendError(response, error.status, error.code, error.message);
      return;
    }
    const errorType = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (errorType === 'entity.parse.failed') {
      sendError(response, 400, 'INVALID_JSON', 'Некоректний JSON у тілі запиту.');
    } else if (errorType === 'entity.too.large') {
      const bodyLimit = response.locals.jsonBodyLimit === '256kb' ? '256 KiB' : '16 KiB';
      sendError(response, 413, 'BODY_TOO_LARGE', `Тіло запиту перевищує ${bodyLimit}.`);
    } else if (errorType === 'charset.unsupported' || errorType === 'encoding.unsupported') {
      sendError(response, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Непідтримуване кодування JSON-запиту.');
    } else if (errorType === 'request.aborted' || errorType === 'request.size.invalid') {
      sendError(response, 400, 'INVALID_REQUEST', 'Некоректне тіло запиту.');
    } else {
      // Error objects can contain SQL parameters, request bodies or credentials.
      // Keep application logs and public responses free of those values.
      console.error('Внутрішня помилка HTTP-запиту.');
      sendError(response, 500, 'INTERNAL_ERROR', 'Внутрішня помилка сервера.');
    }
  };
  app.use(handleError);
  return app;
}
