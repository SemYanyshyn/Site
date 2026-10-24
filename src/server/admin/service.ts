import type { Pool } from 'pg';
import type { AdminExecutor, AdminOverview, AdminServer, AdminUnmatchedExecutor } from '../../shared/admin.js';
import type { AdminConfig } from './config.js';
import { ADMIN_LIMITS, readAdminConfig } from './config.js';
import { abortable } from './budget.js';
import { KubernetesProvider, metricWindowMs } from './kubernetes.js';
import type { InfrastructureSnapshot } from './kubernetes.js';
import { AdminRepository } from './repository.js';
import type { AdminDatabaseSnapshot } from './repository.js';

/** A process's identity must belong to the current pod/container lifetime.
 * Pending pods stay visible without a made-up executor or metric. */
export function mergeAdminOverview(db: AdminDatabaseSnapshot, infra: InfrastructureSnapshot, now = Date.now()): AdminOverview {
  const used = new Set<string>();
  const servers: AdminServer[] = infra.pods.map((pod) => {
    const candidates = db.executors.filter((entry) => entry.podUid === pod.uid && entry.podName === pod.name && entry.podNamespace === pod.namespace
      && pod.containerStartedAt !== null && Date.parse(entry.startedAt) >= Date.parse(pod.containerStartedAt));
    candidates.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt) || right.instanceId.localeCompare(left.instanceId));
    const executor = candidates[0] ?? null;
    if (executor) used.add(executor.instanceId);
    const raw = infra.samples.find((entry) => entry.namespace === pod.namespace && entry.podName === pod.name
      && (entry.podUid === null || entry.podUid === pod.uid));
    const timestamp = raw ? Date.parse(raw.sample.timestamp) : NaN;
    // A metrics sample names a pod, not a process. Requiring both the current
    // container and process start prevents a restart from inheriting old CPU.
    const windowStart = raw ? timestamp - metricWindowMs(raw.sample.window) : NaN;
    const metric = raw && pod.containerStartedAt && windowStart >= Date.parse(pod.containerStartedAt)
      && (!executor || windowStart >= Date.parse(executor.startedAt)) && timestamp <= now + 5_000
      ? { ...raw.sample, stale: now - timestamp > ADMIN_LIMITS.sampleMaxAgeMs || infra.metrics.status !== 'ok' } : null;
    return { ...pod, executor, metric, mapping: executor ? 'matched' : 'unregistered' };
  });
  const unmatchedExecutors: AdminUnmatchedExecutor[] = db.executors.filter((entry) => !used.has(entry.instanceId)).map((entry) => {
    const sameUid = infra.pods.find((pod) => pod.uid === entry.podUid);
    const reason = entry.podUid === null ? 'outside-kubernetes'
      : !sameUid ? 'missing-pod'
        : sameUid.name !== entry.podName || sameUid.namespace !== entry.podNamespace ? 'metadata-mismatch' : 'previous-process';
    return { ...entry, reason };
  });
  const dedup = new Map<string, AdminExecutor>();
  for (const entry of db.executors) {
    const key = entry.podUid && entry.podNamespace ? `${entry.podNamespace}/${entry.podUid}` : entry.instanceId;
    const previous = dedup.get(key);
    if (!previous || Date.parse(entry.startedAt) > Date.parse(previous.startedAt)
      || (entry.startedAt === previous.startedAt && entry.instanceId > previous.instanceId)) dedup.set(key, entry);
  }
  const capacity = [...dedup.values()].filter((entry) => entry.fresh && entry.acceptingClaims);
  const matched = servers.filter((server) => server.executor?.fresh && server.executor.acceptingClaims && !server.terminating);
  const host = unmatchedExecutors.filter((entry) => entry.reason === 'outside-kubernetes' && entry.fresh && entry.acceptingClaims);
  const samples = servers.filter((server) => server.metric !== null && !server.metric.stale);
  const knownPods = infra.kubernetes.status !== 'disabled' && infra.kubernetes.status !== 'unavailable';
  return {
    database: { observedAt: db.observedAt, counts: db.counts, queueExecutorCount: capacity.length,
      busyExecutorCount: capacity.filter((entry) => entry.busy).length,
      registryRecentWindowSeconds: ADMIN_LIMITS.recentSeconds, registryRecentLimit: ADMIN_LIMITS.recentLimit,
      registryRecentTruncated: db.recentTruncated },
    infrastructure: { kubernetes: infra.kubernetes, metrics: infra.metrics, hpa: infra.hpa, deployment: infra.deployment },
    summary: { pods: knownPods ? servers.length : null, readyPods: knownPods ? servers.filter((server) => server.ready).length : null,
      terminatingPods: knownPods ? servers.filter((server) => server.terminating).length : null,
      confirmedExecutors: matched.length + host.length, busyExecutors: matched.filter((server) => server.executor!.busy).length + host.filter((entry) => entry.busy).length,
      cpuCores: samples.length ? samples.reduce((sum, server) => sum + server.metric!.cpuCores, 0) : null,
      memoryBytes: samples.length ? samples.reduce((sum, server) => sum + server.metric!.memoryBytes, 0) : null,
      metricCoverage: samples.length, metricPodCount: knownPods ? servers.length : null }, servers, unmatchedExecutors,
  };
}

export class AdminService {
  readonly repository: AdminRepository;
  readonly #controllers = new Set<AbortController>();
  #closed = false;
  constructor(pool: Pool, config: AdminConfig = readAdminConfig(), private readonly provider = new KubernetesProvider(config)) {
    this.repository = new AdminRepository(pool);
  }
  requestController(): AbortController {
    const controller = new AbortController();
    if (this.#closed) controller.abort(); else this.#controllers.add(controller);
    return controller;
  }
  releaseController(controller: AbortController): void { this.#controllers.delete(controller); }
  close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear(); this.provider.close();
  }
  async overview(deadline: number, signal: AbortSignal): Promise<AdminOverview> {
    const infrastructure = await abortable(this.provider.read(), signal);
    const database = await this.repository.overview(deadline, signal, infrastructure.pods.map((pod) => pod.uid));
    return mergeAdminOverview(database, infrastructure);
  }
}
