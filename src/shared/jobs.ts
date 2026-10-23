import type { NormalizedRouteInput, RouteLimits, RouteOutcome, RouteProgress, RouteResult } from './route.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type JobFailureReason = 'timeout' | 'worker_error' | 'server_shutdown' | 'database_unavailable' | 'invalid_input' | 'worker_lost';
export type JobTerminal = RouteOutcome | { status: 'failed'; reason: JobFailureReason; message: string };

export interface JobSummary {
  id: string;
  status: JobStatus;
  progress: RouteProgress;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  executedBy: string | null;
  error?: { reason: JobFailureReason; message: string };
}

export interface JobDetails extends JobSummary {
  input: NormalizedRouteInput;
  result?: RouteResult;
  queue?: JobQueueInfo;
}

/** Bounds for one bounded shared snapshot; also safe for browser validation. */
export const QUEUE_LIMITS = Object.freeze({
  maxQueuedAhead: 10_000,
  maxExecutors: 10_000,
  maxWaitMs: 1_400_140_000,
});

export interface JobQueueInfo {
  estimatedWaitMs: number | null;
  calculatedAt: string;
  queuedAhead: number;
  executorCount: number;
  basis: 'measured' | 'mixed' | 'timeout' | 'unavailable';
}

export interface JobListResponse {
  jobs: JobSummary[];
  limit: number;
  offset: number;
}

export interface JobLimitsResponse {
  route: RouteLimits;
  maxActivePerUser: number;
}
