import { performance } from 'node:perf_hooks';
import type { Coordinate, NormalizedRouteInput, RouteProgress, RouteResult } from '../../shared/route.js';
import { createRandom } from './random.js';

const PROGRESS_INTERVAL_MS = 150;
const EXACT_LENGTH_INTERVAL = 32_768;
const ACCEPTED_LENGTH_INTERVAL = 2_048;

/** Compensated summation keeps full route lengths independent of accumulated deltas. */
function routeLength(order: readonly number[], distances: Float64Array, size: number): number {
  let sum = 0;
  let correction = 0;
  for (let index = 1; index < order.length; index += 1) {
    const edge = distances[order[index - 1]! * size + order[index]!]!;
    const next = sum + edge;
    correction += Math.abs(sum) >= edge ? (sum - next) + edge : (edge - next) + sum;
    sum = next;
  }
  return sum + correction;
}

function buildDistances(coordinates: readonly Coordinate[]): Float64Array {
  const size = coordinates.length;
  const distances = new Float64Array(size * size);
  for (let left = 0; left < size; left += 1) {
    const a = coordinates[left]!;
    for (let right = left + 1; right < size; right += 1) {
      const b = coordinates[right]!;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      distances[left * size + right] = distance;
      distances[right * size + left] = distance;
    }
  }
  return distances;
}

function nearestNeighbor(distances: Float64Array, size: number): number[] {
  const visited = new Uint8Array(size);
  const order = [0];
  visited[0] = 1;
  let current = 0;
  for (let position = 1; position < size; position += 1) {
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 1; candidate < size; candidate += 1) {
      const distance = distances[current * size + candidate]!;
      if (visited[candidate] === 0 && distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    order.push(closest);
    visited[closest] = 1;
    current = closest;
  }
  order.push(0);
  return order;
}

/**
 * Pure route computation: no environment, database, global randomness or input mutation.
 * The validated service input bounds the O(N²) Float64 matrix (N includes warehouse).
 * Preparation is O(N²); a proposal's delta is O(1), accepted reversal O(segment length).
 * Exact length checks and best snapshots cost O(N); auxiliary route storage is O(N).
 */
export function calculateRoute(input: NormalizedRouteInput, onProgress?: (progress: RouteProgress) => void): RouteResult {
  const started = performance.now();
  const totalIterations = input.iterations;
  let completedIterations = 0;
  let lastProgress = started;
  const progress = (stage: RouteProgress['stage']): void => {
    onProgress?.({
      stage,
      completedIterations,
      totalIterations,
      // The executor emits 100 only after validation and the worker's actual exit.
      percent: Math.min(99.9, completedIterations / totalIterations * 100),
    });
  };
  progress('preparing');

  const coordinates = [input.warehouse, ...input.points];
  const size = coordinates.length;
  const count = input.points.length;
  const distances = buildDistances(coordinates);
  const current = nearestNeighbor(distances, size);
  const initialLength = routeLength(current, distances, size);
  let currentLength = initialLength;
  let best = current.slice();
  let bestLength = initialLength;
  let terminationReason: RouteResult['terminationReason'] = 'budget_exhausted';

  if (initialLength === 0) {
    terminationReason = 'zero_length';
  } else if (count <= 2) {
    terminationReason = 'trivial_input';
  } else {
    const random = createRandom(input.seed);
    // Geometric cooling: T(k) = T0 * (Tend/T0)^(k / requested), Tend = T0/10000.
    // A subnormal lower bound also makes tiny but valid coordinates safe.
    let temperature = Math.max(initialLength / size * 0.25, Number.MIN_VALUE);
    const finalTemperature = Math.max(temperature * 0.0001, Number.MIN_VALUE);
    const cooling = Math.exp(Math.log(finalTemperature / temperature) / totalIterations);
    let acceptedSinceExact = 0;
    progress('searching');

    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      let left = 1 + Math.floor(random() * count);
      let right = 1 + Math.floor(random() * (count - 1));
      if (right >= left) right += 1;
      if (left > right) [left, right] = [right, left];
      // Reversing every delivery changes only the orientation of the same tour.
      // Remap that proposal to a proper segment; count>=3 guarantees two positions.
      if (left === 1 && right === count) right -= 1;

      const before = current[left - 1]!;
      const first = current[left]!;
      const last = current[right]!;
      const after = current[right + 1]!;
      const delta = distances[before * size + last]! + distances[first * size + after]!
        - distances[before * size + first]! - distances[last * size + after]!;
      if (delta <= 0 || random() < Math.exp(-delta / temperature)) {
        for (let start = left, end = right; start < end; start += 1, end -= 1) {
          const value = current[start]!;
          current[start] = current[end]!;
          current[end] = value;
        }
        currentLength += delta;
        acceptedSinceExact += 1;
        // Never save a best route using a drifting incremental length estimate.
        if (currentLength < bestLength || acceptedSinceExact >= ACCEPTED_LENGTH_INTERVAL) {
          currentLength = routeLength(current, distances, size);
          acceptedSinceExact = 0;
          if (currentLength < bestLength) {
            bestLength = currentLength;
            best = current.slice();
          }
        }
      }

      completedIterations = iteration + 1;
      temperature = Math.max(finalTemperature, temperature * cooling);
      if (completedIterations % EXACT_LENGTH_INTERVAL === 0) {
        currentLength = routeLength(current, distances, size);
        acceptedSinceExact = 0;
        if (currentLength < bestLength) {
          bestLength = currentLength;
          best = current.slice();
        }
      }
      // Checking a monotonic clock periodically does not delay or fabricate work.
      if ((completedIterations & 1_023) === 0) {
        const now = performance.now();
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          progress('searching');
          lastProgress = now;
        }
      }
    }
    currentLength = routeLength(current, distances, size);
    if (currentLength < bestLength) best = current.slice();
  }

  progress('finishing');
  return {
    order: best,
    length: routeLength(best, distances, size),
    initialLength,
    seed: input.seed,
    iterationsRequested: totalIterations,
    iterationsCompleted: completedIterations,
    elapsedMs: performance.now() - started,
    approximate: true,
    terminationReason,
  };
}
