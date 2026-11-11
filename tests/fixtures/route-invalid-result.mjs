import { parentPort, threadId, workerData } from 'node:worker_threads';

parentPort.postMessage({
  kind: 'result', runId: workerData.runId, threadId,
  result: { order: [0, 0], length: -1 },
});
