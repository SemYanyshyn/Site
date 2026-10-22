import assert from 'node:assert/strict';
import test from 'node:test';
import type { NormalizedRouteInput, RouteInput, RouteProgress, RouteResult } from '../src/shared/route.js';
import { calculateRoute } from '../src/server/route/algorithm.js';
import {
  DEFAULT_ROUTE_LIMITS, MAX_COORDINATE, readRouteConfig, ROUTE_CONFIG_CAPS,
  RouteConfigurationError, validateRouteLimits,
} from '../src/server/route/config.js';
import { RouteValidationError, validateRouteInput } from '../src/server/route/validation.js';

const limits = readRouteConfig({});
const baseInput: RouteInput = {
  warehouse: { x: 0, y: 0 },
  points: [{ x: 3, y: 4 }],
  iterations: 1_000,
  seed: 0,
};

function validate(input: unknown): NormalizedRouteInput {
  return validateRouteInput(input, limits);
}

function invalid(input: unknown, message?: RegExp): void {
  assert.throws(() => validate(input), (error: unknown) => {
    assert.ok(error instanceof RouteValidationError);
    assert.equal(error.code, 'invalid_input');
    assert.match(error.message, /[А-Яа-яІіЇїЄє]/u);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

function assertRoute(input: NormalizedRouteInput, result: RouteResult): void {
  assert.equal(result.order.length, input.points.length + 2);
  assert.equal(result.order[0], 0);
  assert.equal(result.order.at(-1), 0);
  assert.deepEqual(result.order.slice(1, -1).sort((a, b) => a - b), input.points.map((_, index) => index + 1));
  const coordinates = [input.warehouse, ...input.points];
  let independentLength = 0;
  for (let index = 1; index < result.order.length; index += 1) {
    const previous = coordinates[result.order[index - 1]!]!;
    const next = coordinates[result.order[index]!]!;
    // Independent direct Euclidean calculation, without the production matrix/summer.
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    independentLength += Math.sqrt(dx * dx + dy * dy);
  }
  const tolerance = Number.EPSILON * 128 * coordinates.length * Math.max(1, independentLength);
  assert.ok(Math.abs(result.length - independentLength) <= tolerance);
  assert.ok(result.length <= result.initialLength + tolerance);
  assert.ok(Number.isFinite(result.length) && result.length >= 0);
  assert.ok(Number.isFinite(result.initialLength) && result.initialLength >= 0);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  assert.equal(result.seed, input.seed);
  assert.equal(result.iterationsRequested, input.iterations);
  assert.equal(result.approximate, true);
}

test('route configuration is independent of PostgreSQL and has bounded defaults', () => {
  assert.deepEqual(readRouteConfig({ DATABASE_URL: 'deliberately-unavailable' }), {
    maxPoints: 500, maxIterations: 50_000_000, timeoutMs: 30_000, maxCoordinate: 1_000_000,
  });
  assert.deepEqual(limits, DEFAULT_ROUTE_LIMITS);
  assert.deepEqual(readRouteConfig({ ROUTE_MAX_POINTS: '2000', ROUTE_MAX_ITERATIONS: '200000000', ROUTE_TIMEOUT_MS: '120000' }), ROUTE_CONFIG_CAPS);
  assert.deepEqual(readRouteConfig({ ROUTE_MAX_POINTS: '1', ROUTE_MAX_ITERATIONS: '1', ROUTE_TIMEOUT_MS: '1' }), {
    maxPoints: 1, maxIterations: 1, timeoutMs: 1, maxCoordinate: MAX_COORDINATE,
  });
});

test('route configuration rejects malformed values and hard ceiling violations', () => {
  for (const key of ['ROUTE_MAX_POINTS', 'ROUTE_MAX_ITERATIONS', 'ROUTE_TIMEOUT_MS']) {
    for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '100000000000000000000']) {
      assert.throws(() => readRouteConfig({ [key]: value }), RouteConfigurationError);
    }
  }
  for (const [key, value] of [['ROUTE_MAX_POINTS', '2001'], ['ROUTE_MAX_ITERATIONS', '200000001'], ['ROUTE_TIMEOUT_MS', '120001']]) {
    assert.throws(() => readRouteConfig({ [key!]: value }), RouteConfigurationError);
  }
  for (const key of ['maxPoints', 'maxIterations', 'timeoutMs', 'maxCoordinate'] as const) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateRouteLimits({ ...limits, [key]: value }), RouteConfigurationError);
    }
    assert.throws(() => validateRouteLimits({ ...limits, [key]: ROUTE_CONFIG_CAPS[key] + 1 }), RouteConfigurationError);
  }
});

test('input requires plain objects, all mandatory fields and the delivery array', () => {
  for (const input of [undefined, null, [], 1, 'input', new Date(), {},
    { ...baseInput, warehouse: null }, { ...baseInput, warehouse: [] },
    { ...baseInput, points: null }, { ...baseInput, points: {} },
    { ...baseInput, points: [null] }, { ...baseInput, points: [new Date()] },
    { warehouse: baseInput.warehouse, points: baseInput.points },
    { points: baseInput.points, iterations: 1 },
    { warehouse: baseInput.warehouse, iterations: 1 },
    { ...baseInput, warehouse: { x: 0 } }, { ...baseInput, points: [{ y: 0 }] },
  ]) invalid(input);
});

test('unknown fields, Unicode lookalikes, symbols and accessor properties are rejected', () => {
  const extraArray = Object.assign([{ x: 0, y: 0 }], { timeoutMs: 10 });
  const getterCoordinate = Object.defineProperty({ y: 0 }, 'x', { get: () => 1, enumerable: true });
  const getterArray = Object.defineProperty([{}], '0', { get: () => ({ x: 0, y: 0 }) });
  for (const input of [
    { ...baseInput, timeoutMs: 100_000 }, { ...baseInput, maxPoints: 5 },
    { ...baseInput, sеed: 0 }, // Cyrillic e does not name the optional seed field.
    { ...baseInput, [Symbol('seed')]: 1 },
    { ...baseInput, warehouse: { x: 0, y: 0, z: 0 } },
    { ...baseInput, points: [{ x: 0, y: 0, id: 1 }] },
    { ...baseInput, points: extraArray },
    { ...baseInput, warehouse: getterCoordinate }, { ...baseInput, points: getterArray },
    { ...baseInput, warehouse: { х: 0, y: 0 } }, // Cyrillic x is not the x field.
  ]) invalid(input);
});

test('delivery size is checked before inspecting or copying oversized entries', () => {
  invalid({ ...baseInput, points: [] }, /Кількість/);
  const oversized = new Array<unknown>(limits.maxPoints + 1);
  Object.defineProperty(oversized, '0', { get: () => { throw new Error('oversized entry was inspected'); } });
  invalid({ ...baseInput, points: oversized }, /Кількість/);
  invalid({ ...baseInput, points: new Array(2) });
  const maximum = Array.from({ length: limits.maxPoints }, () => ({ x: 0, y: 0 }));
  assert.equal(validate({ ...baseInput, points: maximum }).points.length, limits.maxPoints);
});

test('coordinates reject strings, non-finite values and values beyond the modulus bound', () => {
  for (const value of ['0', undefined, null, true, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, MAX_COORDINATE + 1, -MAX_COORDINATE - 1]) {
    invalid({ ...baseInput, warehouse: { x: value, y: 0 } }, /warehouse.x/);
    invalid({ ...baseInput, points: [{ x: 0, y: value }] }, /points\[0\].y/);
  }
  const valid = validate({ ...baseInput, warehouse: { x: -MAX_COORDINATE, y: MAX_COORDINATE }, points: [{ x: -0.25, y: 1.5 }] });
  assert.equal(valid.warehouse.x, -MAX_COORDINATE);
  assert.equal(valid.points[0]!.y, 1.5);
});

test('iterations and seed are strictly numeric integral values, including a valid zero seed', () => {
  for (const iterations of [undefined, null, '100', 0, -1, 0.5, Number.NaN,
    Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, limits.maxIterations + 1]) {
    invalid({ ...baseInput, iterations }, /iterations/);
  }
  for (const seed of [undefined, null, '0', -1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
    invalid({ ...baseInput, seed }, /seed/);
  }
  assert.equal(validate({ ...baseInput, seed: 0 }).seed, 0);
  assert.equal(validate({ ...baseInput, seed: 0xffff_ffff }).seed, 0xffff_ffff);
  assert.equal(validate({ ...baseInput, iterations: limits.maxIterations }).iterations, limits.maxIterations);
});

test('normalization generates a seed only when absent and makes independent coordinate copies', () => {
  const input: RouteInput = { warehouse: { x: -1, y: 2 }, points: [{ x: 3, y: 4 }, { x: 3, y: 4 }], iterations: 100 };
  const normalized = validate(input);
  assert.ok(Number.isInteger(normalized.seed) && normalized.seed >= 0 && normalized.seed <= 0xffff_ffff);
  assert.equal(Object.hasOwn(input, 'seed'), false);
  assert.notEqual(normalized.warehouse, input.warehouse);
  assert.notEqual(normalized.points, input.points);
  assert.notEqual(normalized.points[0], input.points[0]);
  normalized.warehouse.x = 100;
  normalized.points[0]!.x = 100;
  assert.equal(input.warehouse.x, -1);
  assert.equal(input.points[0]!.x, 3);
  assert.equal(normalized.points.length, 2, 'equal coordinates identify two deliveries');
});

test('one delivery and two deliveries use truthful fast completion with known closed lengths', () => {
  const one = validate(baseInput);
  const first = calculateRoute(one);
  assertRoute(one, first);
  assert.deepEqual(first.order, [0, 1, 0]);
  assert.equal(first.length, 10);
  assert.equal(first.initialLength, 10);
  assert.equal(first.iterationsCompleted, 0);
  assert.equal(first.terminationReason, 'trivial_input');

  const two = validate({ ...baseInput, points: [{ x: 3, y: 0 }, { x: 0, y: 4 }] });
  const second = calculateRoute(two);
  assertRoute(two, second);
  assert.equal(second.length, 12);
  assert.equal(second.iterationsCompleted, 0);
  assert.equal(second.terminationReason, 'trivial_input');
});

test('a square and a rectangle produce independently known perimeter lengths', () => {
  for (const [width, height, perimeter] of [[1, 1, 4], [2, 1, 6]] as const) {
    const input = validate({ ...baseInput, points: [{ x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }] });
    const result = calculateRoute(input);
    assertRoute(input, result);
    assert.ok(Math.abs(result.length - perimeter) < 1e-12);
    assert.equal(result.iterationsCompleted, input.iterations);
    assert.equal(result.terminationReason, 'budget_exhausted');
  }
});

test('negative and fractional coordinates preserve the known translated rectangle length', () => {
  const input = validate({ ...baseInput, warehouse: { x: -1.5, y: -2.5 },
    points: [{ x: -0.5, y: -2.5 }, { x: -0.5, y: -0.5 }, { x: -1.5, y: -0.5 }] });
  const result = calculateRoute(input);
  assertRoute(input, result);
  assert.equal(result.length, 6);
});

test('coincident deliveries remain separate and a wholly zero route completes without fake iterations', () => {
  for (const count of [1, 2, 25]) {
    const input = validate({ ...baseInput, warehouse: { x: -1.5, y: 2 },
      points: Array.from({ length: count }, () => ({ x: -1.5, y: 2 })) });
    const result = calculateRoute(input);
    assertRoute(input, result);
    assert.equal(result.length, 0);
    assert.equal(result.initialLength, 0);
    assert.equal(result.iterationsCompleted, 0);
    assert.equal(result.terminationReason, 'zero_length');
  }
  const partial = validate({ ...baseInput, points: [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }, { x: 0, y: 0 }] });
  const result = calculateRoute(partial);
  assertRoute(partial, result);
  assert.equal(result.length, 10);
  assert.equal(result.iterationsCompleted, partial.iterations);
});

test('2-opt search improves a known nearest-neighbor detour', () => {
  const input = validate({ ...baseInput, seed: 42, iterations: 10_000,
    points: [{ x: 1, y: 0 }, { x: 0, y: 2 }, { x: 4, y: 0 }, { x: 4, y: 2 }] });
  const result = calculateRoute(input);
  assertRoute(input, result);
  assert.ok(Math.abs(result.initialLength - (11 + Math.sqrt(5))) < 1e-12);
  assert.equal(result.length, 12, 'the rectangle perimeter with an on-edge delivery is known independently');
  assert.ok(result.length < result.initialLength);
});

test('arbitrary routes have independently correct lengths and never degrade the initial tour', () => {
  const points = Array.from({ length: 60 }, (_, index) => ({
    x: Math.sin(index * 2.13) * 100_000,
    y: Math.cos(index * 1.77) * 100_000,
  }));
  for (const seed of [0, 1, 12345, 0xffff_ffff]) {
    const input = validate({ ...baseInput, points, seed, iterations: 25_000 });
    const result = calculateRoute(input);
    assertRoute(input, result);
    assert.equal(result.iterationsCompleted, input.iterations);
  }
});

test('the same seed and budget give identical routes without mutating frozen input', () => {
  const input = validate({ ...baseInput, points: Array.from({ length: 30 }, (_, index) => ({ x: index % 7 - 3.5, y: (index * 17) % 23 - 11.5 })), iterations: 20_000 });
  const before = structuredClone(input);
  Object.freeze(input.warehouse);
  for (const point of input.points) Object.freeze(point);
  Object.freeze(input.points);
  Object.freeze(input);
  const first = calculateRoute(input);
  const second = calculateRoute(input);
  assertRoute(input, first);
  assert.deepEqual(input, before);
  assert.deepEqual(first.order, second.order);
  assert.equal(first.length, second.length);
  assert.equal(first.initialLength, second.initialLength);
  assert.equal(first.iterationsCompleted, second.iterationsCompleted);
});

test('the search uses seeded randomness rather than Math.random', () => {
  const original = Math.random;
  const input = validate({ ...baseInput, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 50 });
  try {
    Math.random = () => { throw new Error('Global random used for route search'); };
    assertRoute(input, calculateRoute(input));
  } finally {
    Math.random = original;
  }
});

test('very small and maximum-magnitude valid coordinates do not produce NaN or invalid counters', () => {
  for (const magnitude of [Number.MIN_VALUE, 1e-200, MAX_COORDINATE]) {
    const input = validate({ ...baseInput, points: [{ x: magnitude, y: 0 }, { x: magnitude, y: magnitude }, { x: 0, y: magnitude }], iterations: 100 });
    const result = calculateRoute(input);
    assert.ok(Number.isFinite(result.length) && result.length >= 0);
    assert.equal(result.iterationsCompleted, input.iterations);
    assert.equal(new Set(result.order.slice(1, -1)).size, 3);
    assert.ok(result.length <= result.initialLength);
  }
});

test('internal progress uses monotonic real counters and leaves terminal 100 to the executor', () => {
  const progress: RouteProgress[] = [];
  const input = validate({ ...baseInput, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 500 });
  const result = calculateRoute(input, (value) => progress.push(value));
  assert.equal(progress[0]!.stage, 'preparing');
  assert.equal(progress[0]!.completedIterations, 0);
  assert.ok(progress.some((value) => value.stage === 'searching'));
  assert.equal(progress.at(-1)!.stage, 'finishing');
  assert.equal(progress.at(-1)!.completedIterations, result.iterationsCompleted);
  let lastCount = 0;
  let lastPercent = 0;
  for (const value of progress) {
    assert.ok(value.completedIterations >= lastCount && value.completedIterations <= input.iterations);
    assert.equal(value.totalIterations, input.iterations);
    assert.equal(value.percent, Math.min(99.9, value.completedIterations / input.iterations * 100));
    assert.ok(value.percent >= lastPercent && value.percent < 100);
    lastCount = value.completedIterations;
    lastPercent = value.percent;
  }
  const trivial: RouteProgress[] = [];
  calculateRoute(validate(baseInput), (value) => trivial.push(value));
  assert.deepEqual(trivial.map((value) => value.stage), ['preparing', 'finishing']);
  assert.ok(trivial.every((value) => value.completedIterations === 0 && value.percent === 0));
});
