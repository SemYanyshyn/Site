import { parentPort, threadId, workerData } from 'node:worker_threads';

// A structurally invalid message must never become a successful route.
parentPort.postMessage({
  kind: 'result', runId: workerData.runId, threadId,
  result: { order: [0, 0], length: -1 },
});
