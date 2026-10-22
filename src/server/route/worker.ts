import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import type { NormalizedRouteInput, RouteProgress } from '../../shared/route.js';
import { calculateRoute } from './algorithm.js';

// Importing this module never starts a calculation in the HTTP/main thread.
if (isMainThread || !parentPort) {
  throw new Error('Обчислення маршруту дозволене лише в окремому worker thread.');
}

const port = parentPort;
const { runId, input } = workerData as { runId: string; input: NormalizedRouteInput };
const result = calculateRoute(input, (progress: RouteProgress) => {
  port.postMessage({ kind: 'progress', runId, progress });
});
port.postMessage({ kind: 'result', runId, threadId, result });
// In particular, a result message is not a reason to retain a worker or port.
port.close();
