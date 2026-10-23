import assert from 'node:assert/strict';
import test from 'node:test';
import { formatProgress, projectRoute } from '../src/client/route-geometry.js';
import { squareInput } from './fixtures/client-jobs.js';

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
