import { once } from 'node:events';
import { startServer } from '../../src/server/index.js';
import type { RouteProgress } from '../../src/shared/route.js';
import { routeInput } from './route-input.js';

// This is a test process, with a real Express app and the shared executor in that
// SAME process. No HTTP endpoint is added to initiate or control calculations.
const runtime = startServer({
  host: '127.0.0.1',
  port: 0,
  // A closed loopback port is sufficient: liveness does not require PostgreSQL.
  // No fake Pool or successful authentication is supplied.
  databaseUrl: 'postgresql://courier_route_probe@127.0.0.1:1/courier_route_probe',
  appOrigins: new Set(['http://127.0.0.1']),
  sessionTtlSeconds: 3600,
  cookieSecure: false,
}, { maxPoints: 500, maxIterations: 200_000_000, timeoutMs: 30_000, maxCoordinate: 1_000_000 });

if (!runtime.server.listening) await once(runtime.server, 'listening');
const address = runtime.server.address();
if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener.');
let progress: RouteProgress | undefined;
let pending = true;
let searchAnnounced = false;
let signalSeen = false;
const run = runtime.executor.start(routeInput(350, 200_000_000), (event) => {
  progress = event;
  if (!searchAnnounced && event.stage === 'searching' && event.completedIterations > 0) {
    searchAnnounced = true;
    process.send?.({ type: 'searching', port: address.port, threadId: run.threadId, pid: process.pid });
  }
});

const outcome = run.result.then((terminal) => {
  pending = false;
  process.send?.({ type: 'terminal', status: terminal.status, busy: runtime.executor.busy });
  if (signalSeen && process.connected) process.disconnect();
  return terminal;
});

process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message)) return;
  if (message.type === 'snapshot') {
    process.send?.({
      type: 'state',
      requestId: 'requestId' in message ? message.requestId : undefined,
      pending,
      busy: runtime.executor.busy,
      completedIterations: progress?.completedIterations ?? 0,
      threadId: run.threadId,
      pid: process.pid,
    });
  } else if (message.type === 'shutdown') {
    void runtime.shutdown('TEST_HARNESS').then(async () => {
      await outcome;
      process.send?.({ type: 'stopped', busy: runtime.executor.busy });
      if (process.connected) process.disconnect();
    });
  }
});

// startServer installs production signal handlers. The harness only releases its
// test-only IPC channel once the real active calculation has settled.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    signalSeen = true;
    if (!pending && process.connected) process.disconnect();
  });
}

process.on('disconnect', () => { void runtime.shutdown('IPC_DISCONNECT'); });
