import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import type { RouteLimits } from '../shared/route.js';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import type { AppConfig } from './config.js';
import { createDatabasePool } from './database.js';
import { readRouteConfig } from './route/config.js';
import { RouteExecutor } from './route/executor.js';
import { readJobsConfig, validateJobsConfig } from './jobs/config.js';
import type { JobsConfig } from './jobs/config.js';
import { JobsDispatcher } from './jobs/dispatcher.js';
import type { DispatcherEvent } from './jobs/dispatcher.js';
import { JobsRepository } from './jobs/repository.js';

export interface ServerOptions {
  // Internal harness controls are not HTTP parameters or environment backdoors.
  jobsInitiallyPaused?: boolean;
  onJobEvent?: (event: DispatcherEvent) => void;
  executorOptions?: {
    workerFactory?: (url: URL, options: WorkerOptions) => Worker;
    workerUrl?: URL;
  };
}

export interface ServerRuntime {
  server: Server;
  executor: RouteExecutor;
  dispatcher: JobsDispatcher;
  pool: Pool;
  instanceId: string;
  shutdown: (signal?: string) => Promise<void>;
}

/** A single calculation service belongs to the same process as this HTTP server. */
export function startServer(config: AppConfig = readConfig(), routeLimits: RouteLimits = readRouteConfig(),
  jobsConfig: JobsConfig = readJobsConfig(), options: ServerOptions = {}): ServerRuntime {
  validateJobsConfig(jobsConfig);
  const executor = new RouteExecutor(routeLimits, options.executorOptions);
  const pool = createDatabasePool(config.databaseUrl);
  const instanceId = randomUUID();
  const jobsRepository = new JobsRepository(pool);
  const dispatcherOptions = {
    ...(options.jobsInitiallyPaused === undefined ? {} : { initiallyPaused: options.jobsInitiallyPaused }),
    ...(options.onJobEvent === undefined ? {} : { onEvent: options.onJobEvent }),
  };
  const dispatcher = new JobsDispatcher(executor, jobsRepository, instanceId, routeLimits, jobsConfig, dispatcherOptions);
  const app = createApp({ config, pool, instanceId, routeLimits, jobsConfig, jobsRepository });
  const server = app.listen(config.port, '127.0.0.1', () => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : config.port;
    console.info(`Courier Route: http://127.0.0.1:${port} (instanceId: ${instanceId})`);
  });
  let shutdownPromise: Promise<void> | undefined;

  async function closeRuntime(signal: string): Promise<void> {
    console.info(`${signal}: завершення HTTP-сервера, dispatcher, worker та пулу PostgreSQL.`);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    const timeout = setTimeout(() => {
      console.error('Перевищено час завершення HTTP-сервера, worker та пулу PostgreSQL.');
      server.closeAllConnections();
      process.exit(1);
    }, 5_000);
    timeout.unref();
    try {
      // Stop admission and the CPU worker together; an in-flight HTTP request
      // must not postpone cancellation until the route's 30-second deadline.
      await Promise.all([
        new Promise<void>((done, reject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else done();
          });
        }),
        dispatcher.shutdown(),
        executor.shutdown(),
      ]);
      await pool.end();
    } catch {
      console.error('Помилка завершення HTTP-сервера, worker або пулу PostgreSQL.');
      process.exitCode = 1;
      // A close failure must not leave either of the other resources running.
      server.closeAllConnections();
      await dispatcher.shutdown();
      await executor.shutdown();
      await pool.end().catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }

  function shutdown(signal = 'shutdown'): Promise<void> {
    shutdownPromise ??= closeRuntime(signal);
    return shutdownPromise;
  }
  function onSigint(): void { void shutdown('SIGINT'); }
  function onSigterm(): void { void shutdown('SIGTERM'); }

  server.on('error', () => {
    console.error('Не вдалося запустити HTTP-сервер. Перевірте порт і дозволи.');
    process.exitCode = 1;
    void shutdown('HTTP error');
  });
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return { server, executor, dispatcher, pool, instanceId, shutdown };
}

// Test harnesses import startServer without accidentally opening another server.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startServer(); } catch (error: unknown) {
    // Configuration errors never include the supplied environment values.
    console.error(error instanceof Error ? error.message : 'Не вдалося запустити сервер.');
    process.exitCode = 1;
  }
}
