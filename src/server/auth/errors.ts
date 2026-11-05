// Тут описую безпечні помилки API з HTTP-статусом, кодом і зрозумілим повідомленням
// Внутрішню помилку SQL не передаю користувачу, бо вона може розкрити дані бази

import type { Response } from 'express';
import type { ApiErrorResponse } from '../../shared/auth.js';

// Зберігаю очікувану помилку так, щоб кінцевий обробник знав статус і публічний код
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// Повертаю однакову JSON-структуру помилки, яку вміє читати frontend
export function sendError(response: Response, status: number, code: string, message: string): void {
  const body: ApiErrorResponse = { code, message };
  response.status(status).json(body);
}

// Для недоступної бази створюю відповідь 503 без адреси підключення та тексту SQL
export function databaseUnavailable(): HttpError {
  return new HttpError(503, 'DATABASE_UNAVAILABLE', 'База даних тимчасово недоступна або ще не підготовлена. Спробуйте пізніше.');
}
