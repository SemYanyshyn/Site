import type { Response } from 'express';
import type { ApiErrorResponse } from '../../shared/auth.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function sendError(response: Response, status: number, code: string, message: string): void {
  const body: ApiErrorResponse = { code, message };
  response.status(status).json(body);
}

export function databaseUnavailable(): HttpError {
  return new HttpError(503, 'DATABASE_UNAVAILABLE', 'База даних тимчасово недоступна або ще не підготовлена. Спробуйте пізніше.');
}
