import type { JobFailureReason, JobStatus } from './jobs.js';
import type { RouteProgress } from './route.js';

export type AdminSourceStatus = 'ok' | 'partial' | 'stale' | 'unavailable' | 'disabled';
export interface AdminSource {
  status: AdminSourceStatus;
  observedAt: string | null;
  cacheAgeMs: number | null;
  message: string | null;
}
export interface AdminCounts { queued: number; running: number; completed: number; cancelled: number; failed: number }
export interface AdminExecutor {
  instanceId: string;
  podUid: string | null;
  podName: string | null;
  podNamespace: string | null;
  startedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  fresh: boolean;
  acceptingClaims: boolean;
  busy: boolean;
  currentJobId: string | null;
  runningJobIds: string[];
}
export interface AdminMetric {
  timestamp: string;
  window: string;
  cpuCores: number;
  memoryBytes: number;
  stale: boolean;
}
export interface AdminPod {
  uid: string;
  name: string;
  namespace: string;
  phase: string;
  ready: boolean;
  terminating: boolean;
  createdAt: string;
  containerStartedAt: string | null;
  restarts: number;
  requests: { cpuCores: number | null; memoryBytes: number | null };
  limits: { cpuCores: number | null; memoryBytes: number | null };
}
export interface AdminServer extends AdminPod {
  executor: AdminExecutor | null;
  metric: AdminMetric | null;
  mapping: 'matched' | 'unregistered';
}
export interface AdminUnmatchedExecutor extends AdminExecutor {
  reason: 'outside-kubernetes' | 'missing-pod' | 'previous-process' | 'metadata-mismatch';
}
export interface AdminHpa {
  minReplicas: number;
  maxReplicas: number;
  currentReplicas: number;
  desiredReplicas: number;
  conditions: { type: string; status: string; reason: string }[];
}
export interface AdminOverview {
  database: {
    observedAt: string;
    counts: AdminCounts;
    queueExecutorCount: number;
    busyExecutorCount: number;
    registryRecentWindowSeconds: number;
    registryRecentLimit: number;
    registryRecentTruncated: boolean;
  };
  infrastructure: {
    kubernetes: AdminSource;
    metrics: AdminSource;
    hpa: AdminHpa | null;
    deployment: { replicas: number; readyReplicas: number; availableReplicas: number } | null;
  };
  summary: {
    pods: number | null;
    readyPods: number | null;
    terminatingPods: number | null;
    confirmedExecutors: number;
    busyExecutors: number;
    cpuCores: number | null;
    memoryBytes: number | null;
    metricCoverage: number;
    metricPodCount: number | null;
  };
  servers: AdminServer[];
  unmatchedExecutors: AdminUnmatchedExecutor[];
}
export interface AdminJob {
  id: string;
  owner: { id: string; username: string };
  status: JobStatus;
  progress: RouteProgress;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  executedBy: string | null;
  failureReason: JobFailureReason | null;
}
export interface AdminJobsResponse {
  jobs: AdminJob[];
  total: number;
  limit: number;
  offset: number;
  snapshotAt: string;
}
export interface AdminJobsOptions {
  limit: number;
  offset: number;
  status?: JobStatus | 'active';
  executedBy?: string;
}

// Every boundary validates its own whitelist. These shared predicates keep the
// public scalar rules identical without passing internal Kubernetes objects.
export const ADMIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function adminRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function adminTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
export function adminFinite(value: unknown, max = 1e15): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}
