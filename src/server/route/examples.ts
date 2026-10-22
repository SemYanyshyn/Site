import type { RouteInput } from '../../shared/route.js';

// Reproducible coordinates for bounded tests/benchmarks; not a route solver.
export function generateRouteInput(pointCount: number, iterations: number, seed = 42): RouteInput {
  if (!Number.isSafeInteger(pointCount) || pointCount < 1 || pointCount > 2000) {
    throw new Error('Генератор підтримує від 1 до 2000 точок.');
  }
  let state = seed >>> 0;
  const coordinate = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2000 - 1000;
  };
  return {
    warehouse: { x: 0, y: 0 },
    points: Array.from({ length: pointCount }, () => ({ x: coordinate(), y: coordinate() })),
    iterations,
    seed,
  };
}
