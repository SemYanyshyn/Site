import type { JobDetails, JobLimitsResponse, JobListResponse, JobStatus } from '../shared/jobs.js';
import type { RouteInput } from '../shared/route.js';
import { InvalidResponseError, isRecord, parseJobDetails, parseJobLimits, parseJobList } from './response.js';

export interface JobListQuery { limit: number; offset: number; status?: JobStatus | 'active' }
export interface JobsApi {
  limits(signal?: AbortSignal): Promise<JobLimitsResponse>;
  list(query: JobListQuery, signal?: AbortSignal): Promise<JobListResponse>;
  detail(id: string, signal?: AbortSignal): Promise<JobDetails>;
  create(input: RouteInput, signal?: AbortSignal): Promise<JobDetails>;
  cancel(id: string, signal?: AbortSignal): Promise<JobDetails>;
}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly uncertain = false) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function requestErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof InvalidResponseError) return error.message;
  return 'Не вдалося зв’язатися із сервером. Перевірте з’єднання та оновіть дані.';
}

function fallback(status: number): string {
  if (status === 401) return 'Сеанс завершився. Увійдіть знову.';
  if (status === 404) return 'Задача недоступна або не існує.';
  if (status === 413) return 'Вхідні дані завеликі. Скоротіть список доставок.';
  if (status === 429) return 'Досягнуто особистого ліміту незавершених задач.';
  if (status === 503) return 'Сервіс тимчасово недоступний. Оновіть дані пізніше.';
  return 'Не вдалося виконати запит. Перевірте введення й спробуйте знову.';
}

/** All endpoints remain relative, including in Vite development mode. */
export class ApiClient implements JobsApi {
  constructor(private readonly fetcher: FetchLike = (path, init) => fetch(path, init), private readonly timeoutMs = 10_000) {}

  private async request<T>(path: string, method: 'GET' | 'POST', parse: (value: unknown) => T,
    body?: unknown, signal?: AbortSignal, creating = false): Promise<T> {
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetcher(path, {
        method, credentials: 'same-origin', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const validError = isRecord(payload) && typeof payload.code === 'string' && payload.code.length <= 100
          && typeof payload.message === 'string' && payload.message.length > 0 && payload.message.length <= 2_000;
        throw new ApiRequestError(response.status, validError ? payload.code as string : 'HTTP_ERROR',
          validError ? payload.message as string : fallback(response.status));
      }
      return parse(payload);
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (creating) throw new ApiRequestError(0, 'ACCEPTANCE_UNKNOWN',
        'Запит міг бути прийнятий. Оновіть історію перед повторним запуском.', true);
      if (error instanceof InvalidResponseError) throw error;
      throw new ApiRequestError(0, 'NETWORK_ERROR', 'Не вдалося оновити дані. Перевірте з’єднання й повторіть читання.');
    }
  }

  limits(signal?: AbortSignal): Promise<JobLimitsResponse> {
    return this.request('/api/jobs/limits', 'GET', parseJobLimits, undefined, signal);
  }
  list(query: JobListQuery, signal?: AbortSignal): Promise<JobListResponse> {
    const parameters = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) parameters.set('status', query.status);
    return this.request(`/api/jobs?${parameters}`, 'GET', (payload) => {
      const value = parseJobList(payload);
      if (value.limit !== query.limit || value.offset !== query.offset
        || (query.status && value.jobs.some((job) => query.status === 'active'
          ? job.status !== 'queued' && job.status !== 'running' : job.status !== query.status))) throw new InvalidResponseError();
      return value;
    }, undefined, signal);
  }
  detail(id: string, signal?: AbortSignal): Promise<JobDetails> {
    return this.request(`/api/jobs/${encodeURIComponent(id)}`, 'GET', (payload) => {
      const value = parseJobDetails(payload, true);
      if (value.id !== id) throw new InvalidResponseError();
      return value;
    }, undefined, signal);
  }
  create(input: RouteInput, signal?: AbortSignal): Promise<JobDetails> {
    return this.request('/api/jobs', 'POST', parseJobDetails, input, signal, true);
  }
  cancel(id: string, signal?: AbortSignal): Promise<JobDetails> {
    return this.request(`/api/jobs/${encodeURIComponent(id)}/cancel`, 'POST', (payload) => {
      const value = parseJobDetails(payload);
      if (value.id !== id) throw new InvalidResponseError();
      return value;
    }, {}, signal);
  }
}
