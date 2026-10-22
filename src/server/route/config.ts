import type { RouteLimits } from '../../shared/route.js';

export const MAX_COORDINATE = 1_000_000;

export const DEFAULT_ROUTE_LIMITS: Readonly<RouteLimits> = Object.freeze({
  maxPoints: 500,
  maxIterations: 50_000_000,
  timeoutMs: 30_000,
  maxCoordinate: MAX_COORDINATE,
});

/** Hard ceilings prevent an accidental configuration from removing resource limits. */
export const ROUTE_CONFIG_CAPS: Readonly<RouteLimits> = Object.freeze({
  maxPoints: 2_000,
  maxIterations: 200_000_000,
  timeoutMs: 120_000,
  maxCoordinate: MAX_COORDINATE,
});

export class RouteConfigurationError extends Error {
  readonly code = 'invalid_route_config';

  constructor(message: string) {
    super(message);
    this.name = 'RouteConfigurationError';
  }
}

function positiveInteger(value: unknown, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RouteConfigurationError(`${name} має бути цілим числом від 1 до ${maximum}.`);
  }
  return value;
}

export function validateRouteLimits(limits: RouteLimits): RouteLimits {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new RouteConfigurationError('Ліміти маршруту мають бути об’єктом.');
  }
  return {
    maxPoints: positiveInteger(limits.maxPoints, ROUTE_CONFIG_CAPS.maxPoints, 'ROUTE_MAX_POINTS'),
    maxIterations: positiveInteger(limits.maxIterations, ROUTE_CONFIG_CAPS.maxIterations, 'ROUTE_MAX_ITERATIONS'),
    timeoutMs: positiveInteger(limits.timeoutMs, ROUTE_CONFIG_CAPS.timeoutMs, 'ROUTE_TIMEOUT_MS'),
    maxCoordinate: positiveInteger(limits.maxCoordinate, MAX_COORDINATE, 'Межа модуля координат'),
  };
}

function readInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new RouteConfigurationError(`${key} має містити додатне ціле десяткове число.`);
  }
  return Number(value);
}

/** Route-only configuration deliberately has no dependency on DB settings. */
export function readRouteConfig(env: NodeJS.ProcessEnv = process.env): RouteLimits {
  return validateRouteLimits({
    maxPoints: readInteger(env, 'ROUTE_MAX_POINTS', DEFAULT_ROUTE_LIMITS.maxPoints),
    maxIterations: readInteger(env, 'ROUTE_MAX_ITERATIONS', DEFAULT_ROUTE_LIMITS.maxIterations),
    timeoutMs: readInteger(env, 'ROUTE_TIMEOUT_MS', DEFAULT_ROUTE_LIMITS.timeoutMs),
    maxCoordinate: MAX_COORDINATE,
  });
}
