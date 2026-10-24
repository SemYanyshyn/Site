import type { AdminCounts, AdminExecutor, AdminHpa, AdminJob, AdminJobsResponse, AdminMetric, AdminOverview, AdminServer, AdminSource, AdminUnmatchedExecutor } from '../shared/admin.js';
import { ADMIN_UUID, adminRecord, adminTimestamp } from '../shared/admin.js';
import type { JobFailureReason, JobStatus } from '../shared/jobs.js';
import type { RouteProgress } from '../shared/route.js';
import { InvalidResponseError } from './response.js';

const statuses = new Set(['queued', 'running', 'completed', 'cancelled', 'failed']);
const reasons = new Set(['timeout', 'worker_error', 'server_shutdown', 'database_unavailable', 'invalid_input', 'worker_lost']);
function record(value: unknown): Record<string, unknown> { if (!adminRecord(value)) throw new InvalidResponseError(); return value; }
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new InvalidResponseError(); return value; }
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new InvalidResponseError(); return value; }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number { const result = number(value, maximum); if (!Number.isSafeInteger(result)) throw new InvalidResponseError(); return result; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new InvalidResponseError(); return value; }
function uuid(value: unknown): string { const result = text(value, 36); if (!ADMIN_UUID.test(result)) throw new InvalidResponseError(); return result; }
function date(value: unknown): string { if (!adminTimestamp(value)) throw new InvalidResponseError(); return value; }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function list<T>(value: unknown, maximum: number, parse: (value: unknown) => T): T[] { if (!Array.isArray(value) || value.length > maximum) throw new InvalidResponseError(); return value.map(parse); }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== 'string' || !choices.includes(value as T)) throw new InvalidResponseError(); return value as T; }

function source(input: unknown): AdminSource {
  const value = record(input);
  return { status: oneOf(value.status, ['ok', 'partial', 'stale', 'unavailable', 'disabled']), observedAt: nullable(value.observedAt, date),
    cacheAgeMs: nullable(value.cacheAgeMs, number), message: nullable(value.message, (s) => text(s, 2_000)) };
}
function counts(input: unknown): AdminCounts {
  const value = record(input);
  return { queued: integer(value.queued), running: integer(value.running), completed: integer(value.completed), cancelled: integer(value.cancelled), failed: integer(value.failed) };
}
function executor(input: unknown): AdminExecutor {
  const value = record(input);
  return { instanceId: uuid(value.instanceId), podUid: nullable(value.podUid, uuid), podName: nullable(value.podName, (s) => text(s, 253)),
    podNamespace: nullable(value.podNamespace, (s) => text(s, 63)), startedAt: date(value.startedAt), lastSeenAt: date(value.lastSeenAt), expiresAt: date(value.expiresAt),
    fresh: boolean(value.fresh), acceptingClaims: boolean(value.acceptingClaims), busy: boolean(value.busy), currentJobId: nullable(value.currentJobId, uuid),
    runningJobIds: list(value.runningJobIds, 1_000, uuid) };
}
function metric(input: unknown): AdminMetric {
  const value = record(input);
  const window = text(value.window, 64);
  const duration = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(window);
  const scale: Record<string, number> = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, ms: .001, s: 1, m: 60, h: 3_600 };
  const seconds = duration ? Number(duration[1]) * scale[duration[2]!]! : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) throw new InvalidResponseError();
  return { timestamp: date(value.timestamp), window, cpuCores: number(value.cpuCores, 1e6), memoryBytes: number(value.memoryBytes, 1e15), stale: boolean(value.stale) };
}
function resource(input: unknown): { cpuCores: number | null; memoryBytes: number | null } {
  const value = record(input);
  return { cpuCores: nullable(value.cpuCores, (n) => number(n, 1e6)), memoryBytes: nullable(value.memoryBytes, (n) => number(n, 1e15)) };
}
function server(input: unknown): AdminServer {
  const value = record(input);
  const parsed: AdminServer = { uid: uuid(value.uid), name: text(value.name, 253), namespace: text(value.namespace, 63),
    phase: oneOf(value.phase, ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']), ready: boolean(value.ready), terminating: boolean(value.terminating),
    createdAt: date(value.createdAt), containerStartedAt: nullable(value.containerStartedAt, date), restarts: integer(value.restarts, 1_000_000),
    requests: resource(value.requests), limits: resource(value.limits), executor: nullable(value.executor, executor), metric: nullable(value.metric, metric),
    mapping: oneOf(value.mapping, ['matched', 'unregistered']) };
  if ((parsed.mapping === 'matched') !== (parsed.executor !== null) || (parsed.executor && (parsed.executor.podUid !== parsed.uid
    || parsed.executor.podName !== parsed.name || parsed.executor.podNamespace !== parsed.namespace))) throw new InvalidResponseError();
  if (parsed.metric && (!parsed.containerStartedAt || Date.parse(parsed.metric.timestamp) < Date.parse(parsed.containerStartedAt)
    || (parsed.executor && Date.parse(parsed.metric.timestamp) < Date.parse(parsed.executor.startedAt)))) throw new InvalidResponseError();
  return parsed;
}
function hpa(input: unknown): AdminHpa {
  const value = record(input);
  const parsed = { minReplicas: integer(value.minReplicas, 10_000), maxReplicas: integer(value.maxReplicas, 10_000),
    currentReplicas: integer(value.currentReplicas, 10_000), desiredReplicas: integer(value.desiredReplicas, 10_000),
    conditions: list(value.conditions, 32, (item) => { const condition = record(item); return { type: text(condition.type, 128), status: text(condition.status, 32), reason: condition.reason === '' ? '' : text(condition.reason, 256) }; }) };
  if (parsed.minReplicas > parsed.maxReplicas) throw new InvalidResponseError();
  return parsed;
}

/** Rebuild the public projection instead of retaining unrecognized payload fields. */
export function parseAdminOverview(input: unknown): AdminOverview {
  const value = record(input), database = record(value.database), infrastructure = record(value.infrastructure), summary = record(value.summary);
  const servers = list(value.servers, 1_000, server);
  if (new Set(servers.map((item) => item.uid)).size !== servers.length) throw new InvalidResponseError();
  const deployment = nullable(infrastructure.deployment, (input) => { const item = record(input); return {
    replicas: integer(item.replicas, 10_000), readyReplicas: integer(item.readyReplicas, 10_000), availableReplicas: integer(item.availableReplicas, 10_000) }; });
  return {
    database: { observedAt: date(database.observedAt), counts: counts(database.counts), queueExecutorCount: integer(database.queueExecutorCount, 10_000),
      busyExecutorCount: integer(database.busyExecutorCount, 10_000), registryRecentWindowSeconds: integer(database.registryRecentWindowSeconds, 86_400),
      registryRecentLimit: integer(database.registryRecentLimit, 10_000), registryRecentTruncated: boolean(database.registryRecentTruncated) },
    infrastructure: { kubernetes: source(infrastructure.kubernetes), metrics: source(infrastructure.metrics), hpa: nullable(infrastructure.hpa, hpa), deployment },
    summary: { pods: nullable(summary.pods, integer), readyPods: nullable(summary.readyPods, integer), terminatingPods: nullable(summary.terminatingPods, integer),
      confirmedExecutors: integer(summary.confirmedExecutors, 10_000), busyExecutors: integer(summary.busyExecutors, 10_000),
      cpuCores: nullable(summary.cpuCores, (n) => number(n, 1e9)), memoryBytes: nullable(summary.memoryBytes, (n) => number(n, 1e18)),
      metricCoverage: integer(summary.metricCoverage, 1_000), metricPodCount: nullable(summary.metricPodCount, integer) },
    servers, unmatchedExecutors: list(value.unmatchedExecutors, 10_100, (item): AdminUnmatchedExecutor => {
      const data = record(item); return { ...executor(data), reason: oneOf(data.reason, ['outside-kubernetes', 'missing-pod', 'previous-process', 'metadata-mismatch']) };
    }),
  };
}
function progress(input: unknown, status: JobStatus): RouteProgress {
  const value = record(input);
  const parsed = { stage: oneOf(value.stage, ['preparing', 'searching', 'finishing']), completedIterations: integer(value.completedIterations, 200_000_000),
    totalIterations: integer(value.totalIterations, 200_000_000), percent: number(value.percent, 100) };
  if (parsed.totalIterations < 1 || parsed.completedIterations > parsed.totalIterations || (status !== 'completed' && parsed.percent >= 100)) throw new InvalidResponseError();
  return parsed;
}
function job(input: unknown): AdminJob {
  const value = record(input), owner = record(value.owner);
  if (typeof value.status !== 'string' || !statuses.has(value.status)) throw new InvalidResponseError();
  if (value.failureReason !== null && (typeof value.failureReason !== 'string' || !reasons.has(value.failureReason))) throw new InvalidResponseError();
  const status = value.status as JobStatus;
  return { id: uuid(value.id), owner: { id: uuid(owner.id), username: text(owner.username, 32) }, status,
    progress: progress(value.progress, status), cancelRequested: boolean(value.cancelRequested), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt),
    startedAt: nullable(value.startedAt, date), finishedAt: nullable(value.finishedAt, date), executedBy: nullable(value.executedBy, uuid), failureReason: value.failureReason as JobFailureReason | null };
}
export function parseAdminJobs(input: unknown): AdminJobsResponse {
  const value = record(input), jobs = list(value.jobs, 50, job), limit = integer(value.limit, 50), offset = integer(value.offset, 1_000_000), total = integer(value.total);
  if (limit < 1 || jobs.length > limit || total < jobs.length || new Set(jobs.map((item) => item.id)).size !== jobs.length) throw new InvalidResponseError();
  return { jobs, total, limit, offset, snapshotAt: date(value.snapshotAt) };
}
