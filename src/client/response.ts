import type { JobDetails, JobLimitsResponse, JobListResponse, JobSummary } from '../shared/jobs.js';
import type { Coordinate, NormalizedRouteInput, RouteProgress, RouteResult } from '../shared/route.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['queued', 'running', 'completed', 'cancelled', 'failed']);
const FAILURES = new Set(['timeout', 'worker_error', 'server_shutdown', 'database_unavailable', 'invalid_input', 'worker_lost']);

export class InvalidResponseError extends Error {
  constructor() { super('Сервер повернув некоректні дані. Оновіть дані або спробуйте пізніше.'); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function finite(value: unknown, minimum: number, maximum = Number.MAX_VALUE): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function date(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}

function nullableDate(value: unknown): value is string | null { return value === null || date(value); }

function coordinate(value: unknown): value is Coordinate {
  return isRecord(value) && finite(value.x, -1_000_000, 1_000_000) && finite(value.y, -1_000_000, 1_000_000);
}

function input(value: unknown): value is NormalizedRouteInput {
  return isRecord(value) && coordinate(value.warehouse)
    && Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= 2_000
    && value.points.every(coordinate) && safeInteger(value.iterations, 1, 200_000_000)
    && safeInteger(value.seed, 0, 4_294_967_295);
}

function progress(value: unknown, completed: boolean): value is RouteProgress {
  if (!isRecord(value) || typeof value.stage !== 'string' || !['preparing', 'searching', 'finishing'].includes(value.stage)
    || !safeInteger(value.totalIterations, 1, 200_000_000)
    || !safeInteger(value.completedIterations, 0, value.totalIterations)
    || !finite(value.percent, 0, 100)) return false;
  if (completed) return value.percent === 100 && value.stage === 'finishing';
  return value.percent < 100
    && (value.stage !== 'preparing' || (value.completedIterations === 0 && value.percent === 0));
}

export function isJobSummary(value: unknown): value is JobSummary {
  if (!isRecord(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || typeof value.status !== 'string' || !STATUSES.has(value.status)
    || !progress(value.progress, value.status === 'completed')
    || typeof value.cancelRequested !== 'boolean' || !date(value.createdAt) || !date(value.updatedAt)
    || !nullableDate(value.startedAt) || !nullableDate(value.finishedAt)
    || !(value.executedBy === null || (typeof value.executedBy === 'string' && UUID.test(value.executedBy)))) return false;
  const terminal = ['completed', 'cancelled', 'failed'].includes(value.status);
  if (terminal !== (value.finishedAt !== null)) return false;
  if (value.status === 'failed') return isRecord(value.error)
    && typeof value.error.reason === 'string' && FAILURES.has(value.error.reason)
    && typeof value.error.message === 'string' && value.error.message.length > 0 && value.error.message.length <= 2_000;
  return value.error === undefined;
}

function result(value: unknown, savedInput: NormalizedRouteInput): value is RouteResult {
  if (!isRecord(value) || !Array.isArray(value.order) || value.order.length !== savedInput.points.length + 2
    || value.order[0] !== 0 || value.order.at(-1) !== 0
    || !finite(value.length, 0) || !finite(value.initialLength, 0)
    || value.seed !== savedInput.seed || value.iterationsRequested !== savedInput.iterations
    || !safeInteger(value.iterationsCompleted, 0, savedInput.iterations)
    || !finite(value.elapsedMs, 0) || value.approximate !== true
    || typeof value.terminationReason !== 'string'
    || !['budget_exhausted', 'trivial_input', 'zero_length'].includes(value.terminationReason)) return false;
  const seen = new Set<number>();
  let previous = savedInput.warehouse;
  let length = 0;
  for (let index = 1; index < value.order.length; index++) {
    const delivery: unknown = value.order[index];
    if (!safeInteger(delivery, 0, savedInput.points.length)) return false;
    if (index !== value.order.length - 1) {
      if (delivery === 0 || seen.has(delivery)) return false;
      seen.add(delivery);
    }
    const current = delivery === 0 ? savedInput.warehouse : savedInput.points[delivery - 1];
    if (!current) return false;
    length += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
  }
  const tolerance = Number.EPSILON * Math.max(length, value.initialLength) * Math.max(16, savedInput.points.length * 8)
    + Number.MIN_VALUE * savedInput.points.length;
  if (Math.abs(value.length - length) > tolerance || value.length > value.initialLength + tolerance) return false;
  if (value.terminationReason === 'budget_exhausted') return value.iterationsCompleted === savedInput.iterations;
  if (value.iterationsCompleted !== 0) return false;
  return value.terminationReason === 'zero_length' ? value.length === 0 : savedInput.points.length <= 2;
}

export function parseJobDetails(value: unknown): JobDetails {
  if (!isJobSummary(value) || !isRecord(value) || !input(value.input)
    || value.progress.totalIterations !== value.input.iterations) throw new InvalidResponseError();
  if (value.status === 'completed') {
    if (!result(value.result, value.input) || value.progress.completedIterations !== value.result.iterationsCompleted) throw new InvalidResponseError();
  } else if (value.result !== undefined) throw new InvalidResponseError();
  return value as unknown as JobDetails;
}

export function parseJobList(value: unknown): JobListResponse {
  if (!isRecord(value) || !safeInteger(value.limit, 1, 50) || !safeInteger(value.offset, 0, 1_000_000)
    || !Array.isArray(value.jobs) || value.jobs.length > value.limit || !value.jobs.every(isJobSummary)
    || new Set(value.jobs.map((job) => job.id)).size !== value.jobs.length) throw new InvalidResponseError();
  return value as unknown as JobListResponse;
}

export function parseJobLimits(value: unknown): JobLimitsResponse {
  if (!isRecord(value) || !isRecord(value.route)
    || !safeInteger(value.route.maxPoints, 1, 2_000)
    || !safeInteger(value.route.maxIterations, 1, 200_000_000)
    || !safeInteger(value.route.timeoutMs, 1, 120_000)
    || !safeInteger(value.route.maxCoordinate, 1, 1_000_000)
    || !safeInteger(value.maxActivePerUser, 1, 100)) throw new InvalidResponseError();
  return value as unknown as JobLimitsResponse;
}
