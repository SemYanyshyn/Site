import assert from 'node:assert/strict';
import type { JobsApi, JobListQuery } from '../../src/client/api.js';
import type { JobDetails, JobLimitsResponse, JobListResponse } from '../../src/shared/jobs.js';
import type { RouteInput } from '../../src/shared/route.js';
import { clientJob, clientLimits, settle } from './client-jobs.js';

export class ControlledJobsApi implements JobsApi {
  calls: Array<{ method: 'limits' | 'list' | 'detail' | 'create' | 'cancel'; query?: JobListQuery; id?: string; signal?: AbortSignal }> = [];
  onLimits: () => Promise<JobLimitsResponse> = async () => structuredClone(clientLimits);
  onList: (query: JobListQuery) => Promise<JobListResponse> = async (query) => ({ jobs: [], limit: query.limit, offset: query.offset });
  onDetail: (id: string) => Promise<JobDetails> = async (id) => ({ ...clientJob(), id });
  onCreate: (input: RouteInput) => Promise<JobDetails> = async () => clientJob();
  onCancel: (id: string) => Promise<JobDetails> = async (id) => ({ ...clientJob(), id, cancelRequested: true });

  limits(signal?: AbortSignal): Promise<JobLimitsResponse> {
    this.calls.push({ method: 'limits', ...(signal ? { signal } : {}) });
    return this.onLimits();
  }
  list(query: JobListQuery, signal?: AbortSignal): Promise<JobListResponse> {
    this.calls.push({ method: 'list', query: { ...query }, ...(signal ? { signal } : {}) });
    return this.onList(query);
  }
  detail(id: string, signal?: AbortSignal): Promise<JobDetails> {
    this.calls.push({ method: 'detail', id, ...(signal ? { signal } : {}) });
    return this.onDetail(id);
  }
  create(input: RouteInput, signal?: AbortSignal): Promise<JobDetails> {
    this.calls.push({ method: 'create', ...(signal ? { signal } : {}) });
    return this.onCreate(input);
  }
  cancel(id: string, signal?: AbortSignal): Promise<JobDetails> {
    this.calls.push({ method: 'cancel', id, ...(signal ? { signal } : {}) });
    return this.onCancel(id);
  }
}

/** A controlled timer for application state tests; it provides no DOM or browser. */
export class ControlledClock {
  private nextId = 0;
  private callbacks = new Map<ReturnType<typeof globalThis.setTimeout>, () => void>();
  delays: number[] = [];
  setTimeout = (callback: () => void, ms: number): ReturnType<typeof globalThis.setTimeout> => {
    const handle = Object.freeze({ timer: ++this.nextId }) as unknown as ReturnType<typeof globalThis.setTimeout>;
    this.callbacks.set(handle, callback);
    this.delays.push(ms);
    return handle;
  };
  clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>): void => { this.callbacks.delete(handle); };
  get size(): number { return this.callbacks.size; }
  async fire(): Promise<void> {
    assert.equal(this.callbacks.size, 1, 'exactly one polling timer should exist');
    const next = this.callbacks.entries().next().value;
    assert.ok(next);
    this.callbacks.delete(next[0]);
    next[1]();
    await settle();
  }
}
