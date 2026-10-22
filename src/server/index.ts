import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { HealthResponse } from '../shared/health.js';

const portInput = process.env.PORT ?? '3000';
if (!/^\d+$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) {
  console.error('PORT має бути цілим числом від 1 до 65535.');
  process.exit(1);
}

const port = Number(portInput);
const instanceId = randomUUID();
const clientDirectory = fileURLToPath(new URL('../client', import.meta.url));
const app = express();
app.disable('x-powered-by');

app.get('/api/health', (_request, response) => {
  const health: HealthResponse = { status: 'ok', instanceId };
  response.set('Cache-Control', 'no-store').json(health);
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API-маршрут не знайдено.' });
});

app.use(express.static(clientDirectory));

app.use((_request, response) => {
  response.status(404).json({ error: 'Сторінку не знайдено.' });
});

const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  console.error('Помилка HTTP-запиту:', error);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).json({ error: 'Внутрішня помилка сервера.' });
};
app.use(handleError);

const server = app.listen(port, '127.0.0.1', () => {
  console.info(`Courier Route: http://127.0.0.1:${port} (instanceId: ${instanceId})`);
});

server.on('error', (error) => {
  console.error('Не вдалося запустити HTTP-сервер:', error.message);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal}: завершення HTTP-сервера.`);
  const timeout = setTimeout(() => {
    console.error('Перевищено час завершення HTTP-сервера.');
    server.closeAllConnections();
    process.exit(1);
  }, 5_000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error('Помилка завершення HTTP-сервера:', error.message);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
