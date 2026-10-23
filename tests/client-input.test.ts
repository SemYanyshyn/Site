import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseRouteDraft } from '../src/client/route-input.js';
import type { RouteDraft } from '../src/client/route-input.js';
import { readRouteConfig, ROUTE_CONFIG_CAPS } from '../src/server/route/config.js';
import { validateRouteInput } from '../src/server/route/validation.js';
import { clientLimits } from './fixtures/client-jobs.js';

const draft: RouteDraft = { warehouseX: '0', warehouseY: '0', points: '1 0\n1 1\n0 1', iterations: '10000', seed: '' };

function valid(changes: Partial<RouteDraft> = {}, limits = clientLimits.route) {
  const result = parseRouteDraft({ ...draft, ...changes }, limits);
  if (!result.ok) assert.fail(result.message);
  return result.input;
}

function invalid(changes: Partial<RouteDraft>, field?: string) {
  const result = parseRouteDraft({ ...draft, ...changes }, clientLimits.route);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected invalid client draft');
  assert.match(result.message, /[А-Яа-яІіЇїЄє]/u);
  if (field !== undefined) assert.equal(result.field, field);
  return result;
}

test('client parser preserves negative, fractional, tab-separated and duplicate deliveries', () => {
  const input = valid({ warehouseX: '-4.25', warehouseY: '0.125', points: '\n-3.5\t2.75\n\n-3.5 2.75\n', seed: '0' });
  assert.deepEqual(input, {
    warehouse: { x: -4.25, y: 0.125 }, points: [{ x: -3.5, y: 2.75 }, { x: -3.5, y: 2.75 }], iterations: 10_000, seed: 0,
  });
  assert.equal(Object.hasOwn(valid(), 'seed'), false);
  assert.equal(valid({ seed: '4294967295' }).seed, 4_294_967_295);
});

test('client parser accepts one delivery and exact server point maximum but rejects one more', () => {
  assert.equal(valid({ points: '1 2' }).points.length, 1);
  const text = Array.from({ length: clientLimits.route.maxPoints }, () => '1 2').join('\n');
  assert.equal(valid({ points: text }).points.length, clientLimits.route.maxPoints);
  invalid({ points: `${text}\n3 4` }, 'points');
  invalid({ points: ' '.repeat(1_000_000) }, 'points');
});

test('client parser uses actual configured limits and agrees with the server validator', () => {
  for (const limits of [readRouteConfig({}), ROUTE_CONFIG_CAPS, readRouteConfig({ ROUTE_MAX_POINTS: '1', ROUTE_MAX_ITERATIONS: '2', ROUTE_TIMEOUT_MS: '1' })]) {
    const input = valid({ points: `${limits.maxCoordinate} -${limits.maxCoordinate}`, iterations: String(limits.maxIterations), seed: '0' }, limits);
    assert.deepEqual(validateRouteInput(input, limits), input);
    assert.equal(parseRouteDraft({ ...draft, points: '1 2', iterations: String(limits.maxIterations + 1) }, limits).ok, false);
    assert.equal(parseRouteDraft({ ...draft, points: `${limits.maxCoordinate + 1} 0`, iterations: '1' }, limits).ok, false);
  }
});

test('client parser rejects empty coordinates and reports the original malformed line number', () => {
  invalid({ warehouseX: '' }, 'warehouseX');
  invalid({ warehouseY: '  ' }, 'warehouseY');
  invalid({ points: '\n \t \n' }, 'points');
  assert.equal(invalid({ points: '\n1 2\n\n3 nope\n4 5' }, 'points').line, 4);
});

test('client parser consumes complete coordinate tokens and never drops extra coordinates', () => {
  for (const points of ['1 2 3', '1,2', '12abc 1', 'NaN 1', '1 Infinity', '-Infinity 2', '1e999 0']) invalid({ points }, 'points');
  for (const warehouseX of ['12abc', 'NaN', 'Infinity', '1 2']) invalid({ warehouseX }, 'warehouseX');
  assert.equal(valid({ points: '0.000000000001 -0.000000000001' }).points[0]?.x, 1e-12);
});

test('client parser enforces positive integer iterations and unsigned optional seed including zero', () => {
  for (const iterations of ['', ' ', '0', '-1', '1.2', '12abc', 'NaN', 'Infinity', String(clientLimits.route.maxIterations + 1)]) invalid({ iterations }, 'iterations');
  assert.equal(valid({ iterations: '1' }).iterations, 1);
  for (const seed of ['-1', '1.2', '4294967296', '12abc', 'NaN', 'Infinity']) invalid({ seed }, 'seed');
  assert.equal(valid({ seed: '0' }).seed, 0);
  assert.equal(Object.hasOwn(valid({ seed: '  ' }), 'seed'), false);
});

test('client parser and API validation modules have no imports from Node or server modules', async () => {
  for (const file of ['route-input.ts', 'response.ts', 'api.ts', 'jobs-controller.ts', 'route-geometry.ts']) {
    const source = await readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"](?:node:|\.\.\/server|pg['"])/u);
  }
});
