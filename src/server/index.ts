import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabasePool } from './database.js';

async function start(): Promise<void> {
  const config = readConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const instanceId = randomUUID();
  const app = createApp({ config, pool, instanceId });
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.info(`Courier Route: http://127.0.0.1:${config.port} (instanceId: ${instanceId})`);
  });
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`${signal}: завершення HTTP-сервера та пулу PostgreSQL.`);
    const timeout = setTimeout(() => {
      console.error('Перевищено час завершення HTTP-сервера та пулу PostgreSQL.');
      server.closeAllConnections();
      process.exit(1);
    }, 5_000);
    timeout.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await pool.end();
    } catch {
      console.error('Помилка завершення HTTP-сервера або пулу PostgreSQL.');
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  server.on('error', () => {
    console.error('Не вдалося запустити HTTP-сервер. Перевірте порт і дозволи.');
    process.exitCode = 1;
    void pool.end().catch(() => {
      console.error('Не вдалося закрити пул PostgreSQL.');
    });
  });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

start().catch((error: unknown) => {
  // Configuration errors never include the supplied environment values.
  console.error(error instanceof Error ? error.message : 'Не вдалося запустити сервер.');
  process.exitCode = 1;
});
