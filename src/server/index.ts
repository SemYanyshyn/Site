// Це головна точка запуску backend, яка з’єднує HTTP, PostgreSQL і виконавця задач
// Для кожного процесу створюю власний UUID, але черга й сесії спільні та зберігаються в базі
// На завершення процесу звільняю ресурси, щоб не лишити обчислення без керування

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { Worker, WorkerOptions } from "node:worker_threads";
import type { RouteLimits } from "../shared/route.js";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { createDatabasePool } from "./database.js";
import { readRouteConfig } from "./route/config.js";
import { RouteExecutor } from "./route/executor.js";
import { readJobsConfig, validateJobsConfig } from "./jobs/config.js";
import type { JobsConfig } from "./jobs/config.js";
import { JobsDispatcher } from "./jobs/dispatcher.js";
import type { DispatcherEvent } from "./jobs/dispatcher.js";
import { JobsRepository } from "./jobs/repository.js";
import {
  readExecutorConfig,
  validateExecutorConfig,
} from "./jobs/executor-config.js";
import type { ExecutorConfig } from "./jobs/executor-config.js";
import { ExecutorRegistry } from "./jobs/executor-registry.js";
import { readAdminConfig } from "./admin/config.js";
import { AdminService } from "./admin/service.js";

export interface ServerOptions {
  // Залишаю ці параметри тільки для внутрішніх тестів, їх не можна передати через HTTP чи змінні середовища
  jobsInitiallyPaused?: boolean;
  executorConfig?: ExecutorConfig;
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
  registry: ExecutorRegistry;
  pool: Pool;
  instanceId: string;
  shutdown: (signal?: string) => Promise<void>;
}

// збираю HTTP сервер пул БД і один обчислювальний слот цього процесу
// Спочатку перевіряю конфігурацію, створюю пул, executor, реєстр і dispatcher
// Після цього відкриваю HTTP-порт, а під час помилки запуску прибираю вже створені ресурси
export function startServer(
  config: AppConfig = readConfig(),
  routeLimits: RouteLimits = readRouteConfig(),
  jobsConfig: JobsConfig = readJobsConfig(),
  options: ServerOptions = {},
): ServerRuntime {
  validateJobsConfig(jobsConfig);
  const executorConfig = validateExecutorConfig(
    options.executorConfig ?? readExecutorConfig(),
  );
  const adminConfig = readAdminConfig();
  const executor = new RouteExecutor(routeLimits, options.executorOptions);
  const pool = createDatabasePool(config.databaseUrl);
  const adminService = new AdminService(pool, adminConfig);
  const instanceId = randomUUID();
  const jobsRepository = new JobsRepository(pool);
  const registry = new ExecutorRegistry(pool, instanceId, executorConfig);
  const dispatcherOptions = {
    ...(options.jobsInitiallyPaused === undefined
      ? {}
      : { initiallyPaused: options.jobsInitiallyPaused }),
    ...(options.onJobEvent === undefined
      ? {}
      : { onEvent: options.onJobEvent }),
  };
  const dispatcher = new JobsDispatcher(
    executor,
    jobsRepository,
    instanceId,
    routeLimits,
    jobsConfig,
    registry,
    dispatcherOptions,
  );
  // Враховую, що прямий запуск executor у внутрішньому тесті теж займає спільний слот
  // Оновлюю реєстр тут, щоб не додавати залежність від PostgreSQL у RouteExecutor і окрему CLI-команду
  const startRoute = executor.start.bind(executor);
  executor.start = (input, onProgress) => {
    const run = startRoute(input, onProgress);
    void registry.refresh();
    void run.result.then(() => {
      void registry.refresh();
    });
    return run;
  };
  const app = createApp({
    config,
    pool,
    instanceId,
    routeLimits,
    jobsConfig,
    jobsRepository,
    adminService,
  });
  // callback зі стрілкою виконається коли сервер почне слухати порт
  const server = app.listen(config.port, config.host, () => {
    const address = server.address();
    const port =
      address && typeof address !== "string" ? address.port : config.port;
    console.info(
      `Courier Route: http://${config.host}:${port} (instanceId: ${instanceId})`,
    );
  });
  let shutdownPromise: Promise<void> | undefined;

  // Зупиняю приймання запитів, диспетчер і worker, потім закриваю пул PostgreSQL
  // Залишаю загальну межу часу завершення, щоб процес не чекав нескінченно
  async function closeRuntime(signal: string): Promise<void> {
    console.info(
      `${signal}: завершення HTTP-сервера, dispatcher, worker та пулу PostgreSQL.`,
    );
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    // Спочатку скасовую HTTP і SQL моніторингу, а потім закриваю спільний пул бази
    adminService.close();
    const timeout = setTimeout(() => {
      console.error(
        "Перевищено час завершення HTTP-сервера, worker та пулу PostgreSQL.",
      );
      server.closeAllConnections();
      adminService.close();
      process.exit(1);
    }, 5_000);
    timeout.unref();
    try {
      // паралельно закриваю HTTP і зупиняю обчислення щоб активний запит не затримав shutdown
      await Promise.all([
        new Promise<void>((done, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            )
              reject(error);
            else done();
          });
        }),
        dispatcher.shutdown(),
        executor.shutdown(),
      ]);
      await pool.end();
    } catch {
      console.error(
        "Помилка завершення HTTP-сервера, worker або пулу PostgreSQL.",
      );
      process.exitCode = 1;
      // Навіть після помилки закриття одного ресурсу намагаюся зупинити решту
      server.closeAllConnections();
      await dispatcher.shutdown();
      await executor.shutdown();
      await pool.end().catch(() => {});
    } finally {
      clearTimeout(timeout);
    }
  }

  function shutdown(signal = "shutdown"): Promise<void> {
    shutdownPromise ??= closeRuntime(signal);
    return shutdownPromise;
  }
  function onSigint(): void {
    void shutdown("SIGINT");
  }
  function onSigterm(): void {
    void shutdown("SIGTERM");
  }

  server.on("error", () => {
    console.error(
      "Не вдалося запустити HTTP-сервер. Перевірте порт і дозволи.",
    );
    process.exitCode = 1;
    void shutdown("HTTP error");
  });
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return { server, executor, dispatcher, registry, pool, instanceId, shutdown };
}

// імпорт дає доступ до startServer а порт відкриваю лише при прямому запуску цього файлу
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    startServer();
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : "Не вдалося запустити сервер.",
    );
    process.exitCode = 1;
  }
}
