import type { AdminJob, AdminJobsOptions, AdminJobsResponse, AdminOverview } from '../../src/shared/admin.js';
import type { PublicUser } from '../../src/shared/auth.js';
import type { AdminApi } from '../../src/client/admin-api.js';

export const adminTime = '2026-10-25T01:02:03.000Z';
export const adminId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const adminUser: PublicUser = { id: adminId(1), username: 'test_admin', role: 'admin', createdAt: adminTime };
export function adminOverview(): AdminOverview {
  return {
    database: { observedAt: adminTime, counts: { queued: 2, running: 1, completed: 24, cancelled: 0, failed: 0 }, queueExecutorCount: 2, busyExecutorCount: 1,
      registryRecentWindowSeconds: 300, registryRecentLimit: 100, registryRecentTruncated: false },
    infrastructure: { kubernetes: { status: 'ok', observedAt: adminTime, cacheAgeMs: 0, message: null }, metrics: { status: 'ok', observedAt: adminTime, cacheAgeMs: 0, message: null },
      deployment: { replicas: 2, readyReplicas: 2, availableReplicas: 2 }, hpa: { minReplicas: 2, maxReplicas: 4, currentReplicas: 2, desiredReplicas: 2, conditions: [] } },
    summary: { pods: 2, readyPods: 2, terminatingPods: 0, confirmedExecutors: 1, busyExecutors: 1, cpuCores: .9, memoryBytes: 45_000_000, metricCoverage: 1, metricPodCount: 2 },
    servers: [{ uid: adminId(2), name: 'app-example-12345', namespace: 'courier-test', phase: 'Running', ready: true, terminating: false, createdAt: adminTime,
      containerStartedAt: adminTime, restarts: 0, requests: { cpuCores: .25, memoryBytes: 134_217_728 }, limits: { cpuCores: 1, memoryBytes: 402_653_184 },
      mapping: 'matched', metric: { timestamp: adminTime, window: '15.02s', cpuCores: .9, memoryBytes: 45_000_000, stale: false },
      executor: { instanceId: adminId(3), podUid: adminId(2), podName: 'app-example-12345', podNamespace: 'courier-test', startedAt: adminTime, lastSeenAt: adminTime,
        expiresAt: '2026-10-25T01:02:08.000Z', fresh: true, acceptingClaims: true, busy: true, currentJobId: adminId(4), runningJobIds: [adminId(4)] } }],
    unmatchedExecutors: [],
  };
}
export function adminJob(n = 4): AdminJob {
  return { id: adminId(n), owner: { id: adminId(8), username: 'other_owner' }, status: 'running', progress: { stage: 'searching', completedIterations: 20, totalIterations: 100, percent: 20 },
    cancelRequested: false, createdAt: adminTime, updatedAt: adminTime, startedAt: adminTime, finishedAt: null, executedBy: adminId(3), failureReason: null };
}
export function adminJobs(query: AdminJobsOptions = { limit: 20, offset: 0 }): AdminJobsResponse {
  const job = adminJob(4 + query.offset);
  if (query.status && query.status !== 'active') job.status = query.status;
  return { jobs: [job], total: 43, limit: query.limit, offset: query.offset, snapshotAt: adminTime };
}
export class ControlledAdminApi implements AdminApi {
  calls: Array<{ kind: 'overview' | 'jobs'; signal?: AbortSignal; query?: AdminJobsOptions }> = [];
  onOverview: () => Promise<AdminOverview> = async () => adminOverview();
  onJobs: (query: AdminJobsOptions) => Promise<AdminJobsResponse> = async (query) => adminJobs(query);
  overview(signal?: AbortSignal): Promise<AdminOverview> { this.calls.push({ kind: 'overview', ...(signal ? { signal } : {}) }); return this.onOverview(); }
  jobs(query: AdminJobsOptions, signal?: AbortSignal): Promise<AdminJobsResponse> { this.calls.push({ kind: 'jobs', query: { ...query }, ...(signal ? { signal } : {}) }); return this.onJobs(query); }
}
