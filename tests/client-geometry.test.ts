import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProgress, projectRoute } from '../src/client/route-geometry.js';
import { squareInput } from './fixtures/client-jobs.js';
import { initialRouteSteps, routeSequence } from '../src/client/initial-route.js';

test('route projection preserves square geometry, saved indices, closed order and equal X/Y scale', () => {
  const projection = projectRoute(squareInput, [0, 3, 2, 1, 0]);
  const [warehouse, first, second, third] = projection.points;
  assert.ok(warehouse && first && second && third);
  assert.deepEqual(projection.points.map((point) => point.index), [0, 1, 2, 3]);
  assert.equal(warehouse.x, third.x);
  assert.equal(warehouse.y, first.y);
  assert.equal(first.x, second.x);
  assert.equal(second.y, third.y);
  assert.equal(first.x - warehouse.x, warehouse.y - third.y);
  assert.ok(first.x > warehouse.x && third.y < warehouse.y);
  assert.equal(projection.path, [warehouse, third, second, first, warehouse].map((point) => `${point.x},${point.y}`).join(' '));
  assert.ok(projection.points.every((point) => point.x >= projection.padding && point.x <= projection.width - projection.padding
    && point.y >= projection.padding && point.y <= projection.height - projection.padding));
});

test('route projection keeps negative, fractional, aligned and coincident deliveries finite and inside padding', () => {
  const inputs = [
    { warehouse: { x: -3.25, y: 2.5 }, points: [{ x: -1.25, y: 2.5 }, { x: -2.25, y: 2.5 }] },
    { warehouse: { x: 2, y: -3 }, points: [{ x: 2, y: -1 }, { x: 2, y: -2 }] },
    { warehouse: { x: -1.25, y: 0.5 }, points: [{ x: -1.25, y: 0.5 }, { x: -1.25, y: 0.5 }] },
    { warehouse: { x: 0, y: 0 }, points: [{ x: 1e-300, y: 0 }, { x: 1e-300, y: 1e-300 }] },
    { warehouse: { x: 0, y: 0 }, points: [{ x: Number.MIN_VALUE, y: 0 }] },
  ];
  for (const input of inputs) {
    const order = [0, ...input.points.map((_, index) => index + 1), 0];
    const projection = projectRoute(input, order);
    assert.ok(Number.isFinite(projection.scale) && projection.scale > 0);
    assert.equal(projection.points.length, input.points.length + 1);
    for (const point of projection.points) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= projection.padding && point.x <= projection.width - projection.padding);
      assert.ok(point.y >= projection.padding && point.y <= projection.height - projection.padding);
    }
    assert.doesNotMatch(projection.path, /NaN|Infinity/u);
  }
});

test('only a completed job can format as one hundred percent', () => {
  for (const status of ['queued', 'running', 'cancelled', 'failed'] as const) {
    assert.doesNotMatch(formatProgress(99.999, status), /100/u);
    assert.doesNotMatch(formatProgress(100, status), /100/u);
  }
  assert.match(formatProgress(100, 'completed'), /100/u);
});

test('initial route explanation follows the saved sequence and labels the final warehouse return separately', () => {
  const input = { warehouse: { x: 0, y: 0 }, points: [
    { x: 2, y: 1 }, { x: 3, y: 5 }, { x: 7, y: 2 }, { x: 8, y: 7 }, { x: 1, y: 8 },
  ] };
  const order = [0, 1, 2, 5, 4, 3, 0];
  const steps = initialRouteSteps(input, order);
  assert.deepEqual(steps.map(({ step, from, to, returnsToWarehouse }) => ({ step, from, to, returnsToWarehouse })), [
    { step: 1, from: 0, to: 1, returnsToWarehouse: false },
    { step: 2, from: 1, to: 2, returnsToWarehouse: false },
    { step: 3, from: 2, to: 5, returnsToWarehouse: false },
    { step: 4, from: 5, to: 4, returnsToWarehouse: false },
    { step: 5, from: 4, to: 3, returnsToWarehouse: false },
    { step: 6, from: 3, to: 0, returnsToWarehouse: true },
  ]);
  const expected = [Math.sqrt(5), Math.sqrt(17), Math.sqrt(13), Math.sqrt(50), Math.sqrt(26), Math.sqrt(53)];
  steps.forEach((step, index) => assert.ok(Math.abs(step.distance - expected[index]!) < 1e-12));
  assert.ok(Math.abs(steps.reduce((sum, step) => sum + step.distance, 0) - 29.41492209) < 5e-9);
  assert.equal(routeSequence(order), 'Склад → 1 → 2 → 5 → 4 → 3 → Склад');
  assert.deepEqual(order, [0, 1, 2, 5, 4, 3, 0]);
});

test('route explanation never selects neighbors or renumbers a valid saved permutation', () => {
  const input = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 7, y: 0 }, { x: 2, y: 0 }] };
  const steps = initialRouteSteps(input, [0, 2, 1, 3, 0]);
  assert.deepEqual(steps.map((step) => step.to), [2, 1, 3, 0]);
  assert.deepEqual(steps.map((step) => step.distance), [7, 6, 1, 2]);
  assert.equal(routeSequence([0, 2, 1, 3, 0]), 'Склад → 2 → 1 → 3 → Склад');
});

test('initial route explanation handles 500 deliveries and rejects missing, duplicated or nonfinite saved data', () => {
  const input = { warehouse: { x: 0, y: 0 }, points: Array.from({ length: 500 }, (_, index) => ({ x: index + 1, y: 0 })) };
  const order = [0, ...input.points.map((_, index) => index + 1), 0];
  const steps = initialRouteSteps(input, order);
  assert.equal(steps.length, 501);
  assert.equal(steps.at(-1)!.distance, 500);
  assert.equal(steps.filter((step) => step.returnsToWarehouse).length, 1);
  for (const invalid of [[0, 1, 2, 0], [0, ...Array(500).fill(1), 0], [...order.slice(0, -1), 1]]) {
    assert.throws(() => initialRouteSteps(input, invalid));
  }
  assert.throws(() => initialRouteSteps({ warehouse: { x: NaN, y: 0 }, points: [{ x: 1, y: 0 }] }, [0, 1, 0]));
});
