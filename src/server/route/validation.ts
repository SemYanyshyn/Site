import { randomBytes } from 'node:crypto';
import type { Coordinate, NormalizedRouteInput, RouteLimits } from '../../shared/route.js';
import { validateRouteLimits } from './config.js';

export class RouteValidationError extends Error {
  readonly code = 'invalid_input';

  constructor(message: string) {
    super(message);
    this.name = 'RouteValidationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteValidationError(`${label} має бути об’єктом.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RouteValidationError(`${label} має бути звичайним об’єктом.`);
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
      throw new RouteValidationError(`${label} містить непогоджене поле.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new RouteValidationError(`${label} має містити звичайні значення полів.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new RouteValidationError(`${label}: відсутнє обов’язкове поле ${key}.`);
    }
  }
}

function coordinate(value: unknown, maximum: number, label: string): Coordinate {
  const item = record(value, label);
  fields(item, ['x', 'y'], [], label);
  for (const key of ['x', 'y'] as const) {
    const component = item[key];
    if (typeof component !== 'number' || !Number.isFinite(component) || Math.abs(component) > maximum) {
      throw new RouteValidationError(`${label}.${key} має бути скінченним числом із модулем не більше ${maximum}.`);
    }
  }
  // No copy here: all validation, including the array's size, precedes normalization.
  return item as unknown as Coordinate;
}

// перевіряю зовнішній вхід і ліміти до копіювання даних та створення worker
export function validateRouteInput(input: unknown, configuredLimits: RouteLimits): NormalizedRouteInput {
  const limits = validateRouteLimits(configuredLimits);
  const value = record(input, 'Вхід маршруту');
  fields(value, ['warehouse', 'points', 'iterations'], ['seed'], 'Вхід маршруту');

  const points = value.points;
  if (!Array.isArray(points)) {
    throw new RouteValidationError('points має бути масивом доставок.');
  }
  if (points.length < 1 || points.length > limits.maxPoints) {
    throw new RouteValidationError(`Кількість доставок має бути від 1 до ${limits.maxPoints}.`);
  }
  // In particular, do not map, clone, enumerate or inspect entries of an oversized array.
  for (const key of Reflect.ownKeys(points)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= points.length) {
      throw new RouteValidationError('points містить непогоджене поле масиву.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(points, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new RouteValidationError('points має містити звичайні значення доставок.');
    }
  }

  const iterations = value.iterations;
  if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > limits.maxIterations) {
    throw new RouteValidationError(`iterations має бути цілим числом від 1 до ${limits.maxIterations}.`);
  }
  const suppliedSeed = Object.hasOwn(value, 'seed');
  const seed = value.seed;
  if (suppliedSeed && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff)) {
    throw new RouteValidationError('seed має бути цілим числом від 0 до 4294967295.');
  }

  const warehouse = coordinate(value.warehouse, limits.maxCoordinate, 'warehouse');
  for (let index = 0; index < points.length; index += 1) {
    if (!Object.hasOwn(points, index)) {
      throw new RouteValidationError(`points[${index}] має містити доставку; пропуски в масиві не дозволені.`);
    }
    coordinate(points[index], limits.maxCoordinate, `points[${index}]`);
  }

  const normalizedPoints: Coordinate[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index] as Coordinate;
    normalizedPoints.push({ x: point.x, y: point.y });
  }

  return {
    warehouse: { x: warehouse.x, y: warehouse.y },
    points: normalizedPoints,
    iterations,
    seed: suppliedSeed ? seed as number : randomBytes(4).readUInt32LE(0),
  };
}
