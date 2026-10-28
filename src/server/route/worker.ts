import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import type { NormalizedRouteInput, RouteProgress } from '../../shared/route.js';
import { calculateRoute } from './algorithm.js';

// важкий пошук дозволений лише в worker щоб основний потік міг відповідати на HTTP запити
if (isMainThread || !parentPort) {
  throw new Error('Обчислення маршруту дозволене лише в окремому worker thread.');
}

const port = parentPort;
// as описує очікуваний тип але не перевіряє дані під час роботи
const { runId, input } = workerData as { runId: string; input: NormalizedRouteInput };
// callback передає реальний прогрес через повідомлення в основний потік
const result = calculateRoute(input, (progress: RouteProgress) => {
  port.postMessage({ kind: 'progress', runId, progress });
});
port.postMessage({ kind: 'result', runId, threadId, result });
// після результату закриваю порт щоб worker міг фізично завершитися
port.close();
