import type { AdminJobsOptions, AdminJobsResponse, AdminOverview } from '../shared/admin.js';
import { ApiRequestError } from './api.js';
import type { FetchLike } from './api.js';
import { parseAdminJobs, parseAdminOverview } from './admin-response.js';
import { InvalidResponseError } from './response.js';

export interface AdminApi {
  overview(signal?: AbortSignal): Promise<AdminOverview>;
  jobs(query: AdminJobsOptions, signal?: AbortSignal): Promise<AdminJobsResponse>;
}
export class AdminApiClient implements AdminApi {
  constructor(private readonly fetcher: FetchLike = (path, init) => fetch(path, init), private readonly timeoutMs = 10_000) {}
  private async read<T>(path: string, parse: (input: unknown) => T, signal?: AbortSignal): Promise<T> {
    try {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetcher(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new ApiRequestError(response.status, response.status === 403 ? 'ADMIN_REQUIRED' : 'ADMIN_READ_FAILED',
        response.status === 401 ? 'Сеанс завершився. Увійдіть знову.' : response.status === 403 ? 'Доступ адміністратора більше не надано.'
          : response.status === 503 ? 'Моніторинг тимчасово недоступний. Показані попередні дані можуть бути застарілими.' : 'Не вдалося прочитати моніторинг. Оновіть дані.');
      return parse(await response.json() as unknown);
    } catch (error) {
      if (error instanceof ApiRequestError || error instanceof InvalidResponseError) throw error;
      throw new ApiRequestError(0, 'NETWORK_ERROR', 'Не вдалося оновити моніторинг. Показані попередні дані можуть бути застарілими.');
    }
  }
  overview(signal?: AbortSignal): Promise<AdminOverview> { return this.read('/api/admin/overview', parseAdminOverview, signal); }
  jobs(query: AdminJobsOptions, signal?: AbortSignal): Promise<AdminJobsResponse> {
    const parameters = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) parameters.set('status', query.status);
    if (query.executedBy) parameters.set('executedBy', query.executedBy);
    return this.read(`/api/admin/jobs?${parameters}`, (input) => {
      const value = parseAdminJobs(input);
      if (value.limit !== query.limit || value.offset !== query.offset || value.jobs.some((job) =>
        (query.status && (query.status === 'active' ? job.status !== 'queued' && job.status !== 'running' : job.status !== query.status))
        || (query.executedBy && job.executedBy !== query.executedBy))) throw new InvalidResponseError();
      return value;
    }, signal);
  }
}
