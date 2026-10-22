import express from 'express';
import type { PublicUser } from '../../shared/auth.js';
import type { JobLimitsResponse, JobStatus } from '../../shared/jobs.js';
import type { RouteLimits } from '../../shared/route.js';
import type { AppConfig } from '../config.js';
import type { Pool } from 'pg';
import { HttpError } from '../auth/errors.js';
import { requireAuth } from '../auth/middleware.js';
import { jsonMutationGuard } from '../http/json.js';
import { validateRouteInput, RouteValidationError } from '../route/validation.js';
import type { JobsConfig } from './config.js';
import { JobsRepository } from './repository.js';
import type { JobListOptions } from './repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set<JobStatus | 'active'>(['active', 'queued', 'running', 'completed', 'cancelled', 'failed']);

function jobId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new HttpError(400, 'INVALID_JOB_ID', 'Ідентифікатор задачі має бути UUID.');
  }
  return value;
}

function listOptions(query: Record<string, unknown>): JobListOptions {
  if (Object.keys(query).some((key) => !['limit', 'offset', 'status'].includes(key))) {
    throw new HttpError(400, 'INVALID_QUERY', 'Дозволені лише параметри limit, offset і status.');
  }
  const integer = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new HttpError(400, 'INVALID_QUERY', 'Параметри пагінації мають бути цілими десятковими числами.');
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
      throw new HttpError(400, 'INVALID_QUERY', `Параметр пагінації має бути від ${minimum} до ${maximum}.`);
    }
    return number;
  };
  const value: JobListOptions = { limit: integer(query.limit, 20, 1, 50), offset: integer(query.offset, 0, 0, 1_000_000) };
  if (query.status !== undefined) {
    if (typeof query.status !== 'string' || !STATUSES.has(query.status as JobStatus | 'active')) {
      throw new HttpError(400, 'INVALID_QUERY', 'Некоректний фільтр стану задач.');
    }
    value.status = query.status as JobStatus | 'active';
  }
  return value;
}

function notFound(): HttpError {
  return new HttpError(404, 'JOB_NOT_FOUND', 'Задачу не знайдено.');
}

export function createJobsRouter(
  config: AppConfig, pool: Pool, repository: JobsRepository, routeLimits: RouteLimits, jobsConfig: JobsConfig,
): express.Router {
  const router = express.Router();
  router.use(jsonMutationGuard(config, '256kb'));
  router.use(requireAuth(pool));

  router.get('/limits', (_request, response) => {
    const body: JobLimitsResponse = { route: { ...routeLimits }, maxActivePerUser: jobsConfig.maxActivePerUser };
    response.json(body);
  });

  router.post('/', async (request, response) => {
    let input;
    try {
      input = validateRouteInput(request.body, routeLimits);
    } catch (error) {
      if (error instanceof RouteValidationError) throw new HttpError(400, 'INVALID_ROUTE_INPUT', error.message);
      throw error;
    }
    const user = response.locals.user as PublicUser;
    const job = await repository.create(user.id, input, jobsConfig);
    response.location(`/api/jobs/${job.id}`).status(202).json(job);
  });

  router.get('/', async (request, response) => {
    const options = listOptions(request.query);
    const user = response.locals.user as PublicUser;
    response.json(await repository.list(user.id, options));
  });

  router.get('/:id', async (request, response) => {
    const id = jobId(request.params.id);
    const user = response.locals.user as PublicUser;
    const job = await repository.get(user.id, id);
    if (!job) throw notFound();
    response.json(job);
  });

  router.post('/:id/cancel', async (request, response) => {
    const id = jobId(request.params.id);
    if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 0) {
      throw new HttpError(400, 'INVALID_CANCEL_INPUT', 'Для скасування передайте порожній JSON-об’єкт.');
    }
    const user = response.locals.user as PublicUser;
    const job = await repository.cancel(user.id, id);
    if (!job) throw notFound();
    response.status(job.status === 'running' ? 202 : 200).json(job);
  });

  return router;
}
