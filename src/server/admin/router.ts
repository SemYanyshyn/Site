import express from 'express';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { ADMIN_UUID } from '../../shared/admin.js';
import type { AdminJobsOptions } from '../../shared/admin.js';
import type { JobStatus } from '../../shared/jobs.js';
import { databaseUnavailable, HttpError, sendError } from '../auth/errors.js';
import { requireAdmin } from './auth.js';
import { ADMIN_LIMITS } from './config.js';
import type { AdminService } from './service.js';

export function parseAdminJobsOptions(query: Record<string, unknown>): AdminJobsOptions {
  if (Object.keys(query).some((key) => !['limit', 'offset', 'status', 'executedBy'].includes(key))) {
    throw new HttpError(400, 'INVALID_QUERY', 'Дозволені лише limit, offset, status та executedBy.');
  }
  const integer = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))
      || Number(value) < minimum || Number(value) > maximum) throw new HttpError(400, 'INVALID_QUERY', 'Некоректні межі пагінації.');
    return Number(value);
  };
  const options: AdminJobsOptions = { limit: integer(query.limit, 20, 1, 50), offset: integer(query.offset, 0, 0, 1_000_000) };
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !['active', 'queued', 'running', 'completed', 'cancelled', 'failed'].includes(query.status)) {
      throw new HttpError(400, 'INVALID_QUERY', 'Некоректний фільтр стану.');
    }
    options.status = query.status as JobStatus | 'active';
  }
  if (query.executedBy !== undefined) {
    if (typeof query.executedBy !== 'string' || !ADMIN_UUID.test(query.executedBy)) throw new HttpError(400, 'INVALID_QUERY', 'executedBy має бути UUID.');
    options.executedBy = query.executedBy;
  }
  return options;
}

export function createAdminRouter(pool: Pool, service: AdminService): express.Router {
  const router = express.Router();
  router.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const controller = service.requestController();
    response.locals.adminDeadline = performance.now() + ADMIN_LIMITS.requestMs;
    response.locals.adminSignal = controller.signal;
    const timer = setTimeout(() => {
      controller.abort();
      if (!response.headersSent && !response.destroyed) {
        const error = databaseUnavailable(); sendError(response, error.status, error.code, error.message);
      }
    }, ADMIN_LIMITS.requestMs);
    const disconnected = (): void => { if (!response.writableFinished) controller.abort(); };
    const finish = (): void => { clearTimeout(timer); service.releaseController(controller); request.removeListener('aborted', disconnected); };
    request.once('aborted', disconnected); response.once('close', () => { disconnected(); finish(); });
    response.once('finish', finish);
    next();
  });
  router.use(requireAdmin(pool));
  router.get('/overview', async (request, response) => {
    if (Object.keys(request.query).length !== 0) throw new HttpError(400, 'INVALID_QUERY', 'Огляд не приймає параметрів.');
    const value = await service.overview(Number(response.locals.adminDeadline), response.locals.adminSignal as AbortSignal);
    if (!response.headersSent && !response.destroyed) response.json(value);
  });
  router.get('/jobs', async (request, response) => {
    const options = parseAdminJobsOptions(request.query);
    const value = await service.repository.jobs(options, Number(response.locals.adminDeadline), response.locals.adminSignal as AbortSignal);
    if (!response.headersSent && !response.destroyed) response.json(value);
  });
  return router;
}
