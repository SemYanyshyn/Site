import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import type { DispatcherEvent } from '../../src/server/jobs/dispatcher.js';

// Only test IPC controls dispatcher admission. The HTTP application and its
// coordinator/executor are the actual built production modules, in this process.
const { startServer } = await import(new URL('../../dist/server/index.js', import.meta.url).href) as
  typeof import('../../src/server/index.js');
const { readConfig } = await import(new URL('../../dist/server/config.js', import.meta.url).href) as
  typeof import('../../src/server/config.js');
const { readRouteConfig } = await import(new URL('../../dist/server/route/config.js', import.meta.url).href) as
  typeof import('../../src/server/route/config.js');
const { readJobsConfig } = await import(new URL('../../dist/server/jobs/config.js', import.meta.url).href) as
  typeof import('../../src/server/jobs/config.js');
const workers = new Map<number, Worker>();
let claimedJob: string | undefined;
let crashNext = false;

function workerFactory(url: URL, options: WorkerOptions): Worker {
  const target = crashNext ? new URL('./route-crash.mjs', import.meta.url) : url;
  crashNext = false;
  const worker = new Worker(target, options);
  const originalId = worker.threadId;
  const jobId = claimedJob;
  workers.set(originalId, worker);
  process.send?.({ type: 'worker_created', jobId, threadId: originalId, activeWorkers: workers.size });
  worker.once('exit', () => {
    workers.delete(originalId);
    process.send?.({ type: 'worker_exit', jobId, originalId, threadId: worker.threadId, activeWorkers: workers.size });
  });
  return worker;
}

const runtime = startServer(readConfig(), readRouteConfig(), readJobsConfig(), {
  jobsInitiallyPaused: true,
  executorOptions: { workerFactory },
  onJobEvent(event: DispatcherEvent) {
    if (event.type === 'claimed') claimedJob = event.jobId;
    process.send?.({ ...event, executorBusy: runtime.executor.busy, activeWorkers: workers.size });
  },
});
if (!runtime.server.listening) await once(runtime.server, 'listening');
const address = runtime.server.address();
if (!address || typeof address === 'string') throw new Error('Expected a loopback HTTP listener.');
process.send?.({ type: 'ready', port: address.port, instanceId: runtime.instanceId, pid: process.pid });

process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  const requestId = 'requestId' in value ? value.requestId : undefined;
  void (async () => {
    if (value.type === 'pause') {
      runtime.dispatcher.pause();
      await runtime.dispatcher.tick();
    } else if (value.type === 'resume') runtime.dispatcher.resume();
    else if (value.type === 'tick') await runtime.dispatcher.tick();
    else if (value.type === 'crash_next') crashNext = true;
    else if (value.type === 'shutdown') {
      await runtime.shutdown('TEST_HARNESS');
      process.send?.({ type: 'stopped', requestId, activeWorkers: workers.size, busy: runtime.executor.busy });
      if (process.connected) process.disconnect();
      return;
    }
    process.send?.({ type: 'ack', requestId, activeWorkers: workers.size,
      busy: runtime.executor.busy, dispatcherBusy: runtime.dispatcher.busy });
  })().catch(() => {
    process.send?.({ type: 'harness_error', requestId });
  });
});

// Production signal handlers perform shutdown. The test listener only releases
// IPC after that same production shutdown Promise has completed.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void runtime.shutdown(signal).then(() => {
      process.send?.({ type: 'stopped', activeWorkers: workers.size, busy: runtime.executor.busy });
      if (process.connected) process.disconnect();
    });
  });
}
process.on('disconnect', () => { void runtime.shutdown('IPC_DISCONNECT'); });
