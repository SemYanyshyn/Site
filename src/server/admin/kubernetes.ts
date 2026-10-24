import { readFile } from 'node:fs/promises';
import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { AdminHpa, AdminMetric, AdminPod, AdminSource } from '../../shared/admin.js';
import { ADMIN_UUID, adminRecord, adminTimestamp } from '../../shared/admin.js';
import type { AdminConfig } from './config.js';
import { ADMIN_LIMITS } from './config.js';

type ObjectValue = Record<string, unknown>;
const OWNER = 'courier-route.local/owner-id';
function object(value: unknown): ObjectValue { if (!adminRecord(value)) throw new Error('Некоректний формат джерела.'); return value; }
function string(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('Некоректний рядок джерела.');
  return value;
}
function number(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1e9) throw new Error('Некоректне число джерела.');
  return value as number;
}
function date(value: unknown): string { if (!adminTimestamp(value)) throw new Error('Некоректний час джерела.'); return value; }
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Перевищено межу джерела.');
  return value;
}

/** Kubernetes quantities are scalar decimal values, never JS expressions. */
export function parseCpu(value: unknown): number {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[num]|[eE][+-]?\d+)?$/.test(value) || value.length > 40) throw new Error('Некоректна CPU quantity.');
  const unit = value.match(/[num]$/)?.[0];
  const result = Number(unit ? value.slice(0, -1) : value) * (unit === 'n' ? 1e-9 : unit === 'u' ? 1e-6 : unit === 'm' ? 1e-3 : 1);
  if (!Number.isFinite(result) || result < 0 || result > 1e6) throw new Error('CPU quantity поза межею.');
  return result;
}
export function parseMemory(value: unknown): number {
  if (typeof value !== 'string' || value.length > 40) throw new Error('Некоректна memory quantity.');
  const match = /^(\d+(?:\.\d*)?|\.\d+)([EPTGMK]i|[EPTGMkK]|m|[eE][+-]?\d+)?$/.exec(value);
  if (!match) throw new Error('Некоректна memory quantity.');
  const suffix = match[2] ?? '';
  const scale = suffix.endsWith('i') ? 1024 ** ('KMGTPE'.indexOf(suffix[0]!) + 1)
    : /^[eE][+-]?\d+$/.test(suffix) ? 10 ** Number(suffix.slice(1))
      : suffix === 'm' ? 1e-3 : suffix ? 1000 ** ('kKMGTPE'.replace('kK', 'K').indexOf(suffix.toUpperCase()) + 1) : 1;
  const result = Number(match[1]) * scale;
  if (!Number.isFinite(result) || result < 0 || result > 1e15) throw new Error('Memory quantity поза межею.');
  return result;
}
export function metricWindowMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(value);
  if (!match) throw new Error('Некоректне вікно метрик.');
  const scale: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 };
  const result = Number(match[1]) * scale[match[2]!]!;
  if (!Number.isFinite(result) || result <= 0 || result > 3_600_000) throw new Error('Вікно метрик поза межею.');
  return result;
}
function resources(value: unknown): { cpuCores: number | null; memoryBytes: number | null } {
  const row = value === undefined ? {} : object(value);
  return { cpuCores: row.cpu === undefined ? null : parseCpu(row.cpu), memoryBytes: row.memory === undefined ? null : parseMemory(row.memory) };
}
function metadata(value: unknown, config: AdminConfig, name?: string): ObjectValue {
  const row = object(value);
  if (row.namespace !== config.namespace || (name !== undefined && row.name !== name)
    || object(row.labels)[OWNER] !== config.ownerId) throw new Error('Джерело не відповідає власному namespace/owner.');
  return row;
}

export function parsePods(value: unknown, config: AdminConfig): AdminPod[] {
  return array(object(value).items, ADMIN_LIMITS.maxPods).map((item) => {
    const row = object(item), meta = metadata(row.metadata, config);
    if (object(meta.labels)['app.kubernetes.io/component'] !== 'app'
      || object(meta.labels)['app.kubernetes.io/name'] !== 'courier-route-app') throw new Error('Чужий pod у відповіді джерела.');
    const uid = string(meta.uid); if (!ADMIN_UUID.test(uid)) throw new Error('Pod UID має бути UUID.');
    const status = object(row.status ?? {}), spec = object(row.spec);
    const app = array(spec.containers, 10).map(object).find((container) => container.name === 'app');
    if (!app) throw new Error('Немає app-контейнера.');
    const container = array(status.containerStatuses ?? [], 10).map(object).find((entry) => entry.name === 'app');
    const running = container && adminRecord(container.state) && adminRecord(container.state.running) ? container.state.running : null;
    const ready = array(status.conditions ?? [], 30).map(object).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    return { uid, name: string(meta.name, 253), namespace: string(meta.namespace, 63),
      phase: string(status.phase ?? 'Unknown', 40), ready, terminating: meta.deletionTimestamp !== undefined,
      createdAt: date(meta.creationTimestamp), containerStartedAt: running ? date(running.startedAt) : null,
      restarts: container ? number(container.restartCount) : 0,
      requests: resources(adminRecord(app.resources) ? app.resources.requests : undefined),
      limits: resources(adminRecord(app.resources) ? app.resources.limits : undefined) };
  });
}
export function parseHpa(value: unknown, config: AdminConfig): AdminHpa {
  const row = object(value); metadata(row.metadata, config, 'app');
  const spec = object(row.spec), status = object(row.status ?? {});
  return { minReplicas: number(spec.minReplicas, 1), maxReplicas: number(spec.maxReplicas),
    currentReplicas: number(status.currentReplicas), desiredReplicas: number(status.desiredReplicas),
    conditions: array(status.conditions ?? [], 20).map((item) => {
      const condition = object(item);
      return { type: string(condition.type, 80), status: string(condition.status, 10), reason: string(condition.reason ?? '', 120) };
    }) };
}
export interface RawMetric { podName: string; namespace: string; podUid: string | null; sample: AdminMetric }
export function parseMetrics(value: unknown, config: AdminConfig): RawMetric[] {
  return array(object(value).items, ADMIN_LIMITS.maxPods).map((item) => {
    const row = object(item), meta = object(row.metadata);
    if (meta.namespace !== config.namespace) throw new Error('Метрики іншого namespace.');
    const container = array(row.containers, 10).map(object).find((entry) => entry.name === 'app');
    if (!container) throw new Error('Немає метрик app-контейнера.');
    const usage = object(container.usage), timestamp = date(row.timestamp), window = string(row.window, 40);
    metricWindowMs(window);
    const podUid = meta.uid === undefined ? null : string(meta.uid);
    if (podUid !== null && !ADMIN_UUID.test(podUid)) throw new Error('Некоректний UID метрик.');
    return { podName: string(meta.name, 253), namespace: string(meta.namespace, 63), podUid,
      sample: { timestamp, window, cpuCores: parseCpu(usage.cpu), memoryBytes: parseMemory(usage.memory), stale: false } };
  });
}
export interface InfrastructureSnapshot {
  kubernetes: AdminSource;
  metrics: AdminSource;
  pods: AdminPod[];
  samples: RawMetric[];
  hpa: AdminHpa | null;
  deployment: { replicas: number; readyReplicas: number; availableReplicas: number } | null;
}
export interface KubernetesTransport {
  request(path: string): Promise<unknown>;
  close(): void;
}
interface Cached<T> { value: T; observedAt: string; monotonic: number }

/** Fixed-origin HTTPS transport. The optional request factory is dependency
 * injection for socket-level tests, never HTTP/environment configuration. */
export function readKubernetesResponse(path: string, token: string, ca: Buffer, requests: Set<ClientRequest>,
  requestFactory: typeof https.request = https.request, timeoutMs: number = ADMIN_LIMITS.providerMs,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const request = requestFactory({ hostname: 'kubernetes.default.svc', port: 443, path, method: 'GET', ca, agent: false,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' } }, (response) => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > ADMIN_LIMITS.providerBytes) { response.destroy(); request.destroy(new Error('Завелика відповідь джерела.')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { finish(new Error('Джерело відмовило в читанні.')); return; }
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
        catch { finish(new Error('Некоректна JSON-відповідь джерела.')); }
      });
      response.on('error', () => finish(new Error('Не вдалося прочитати джерело.')));
    });
    const timer = setTimeout(() => request.destroy(new Error('Перевищено час джерела.')), Math.max(1, timeoutMs));
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); requests.delete(request);
      if (error) reject(error); else resolve(value);
    };
    requests.add(request);
    request.on('error', () => finish(new Error('Джерело тимчасово недоступне.')));
    request.on('close', () => finish(new Error('З’єднання з джерелом закрито.')));
    request.end();
  });
}

export class KubernetesProvider {
  readonly #requests = new Set<ClientRequest>();
  readonly #credentialReads = new Set<AbortController>();
  #closed = false;
  #operation: Promise<InfrastructureSnapshot> | undefined;
  #cached: InfrastructureSnapshot | undefined;
  #cacheAt = -Infinity;
  #pods: Cached<AdminPod[]> | undefined;
  #samples: Cached<RawMetric[]> | undefined;
  #hpa: Cached<AdminHpa> | undefined;
  #deployment: Cached<NonNullable<InfrastructureSnapshot['deployment']>> | undefined;
  constructor(private readonly config: AdminConfig, private readonly transport?: KubernetesTransport,
    private readonly monotonicNow: () => number = () => performance.now()) {}

  close(): void {
    this.#closed = true; this.transport?.close();
    for (const controller of this.#credentialReads) controller.abort(); this.#credentialReads.clear();
    for (const request of this.#requests) request.destroy(); this.#requests.clear();
  }
  async read(): Promise<InfrastructureSnapshot> {
    if (this.#closed) throw new Error('Джерело зупинено.');
    if (!this.config.enabled) {
      const source: AdminSource = { status: 'disabled', observedAt: null, cacheAgeMs: null, message: 'Джерело Kubernetes вимкнено поза кластером; CPU/RAM невідомі.' };
      return { kubernetes: { ...source }, metrics: { ...source }, pods: [], samples: [], hpa: null, deployment: null };
    }
    if (this.#cached && this.monotonicNow() - this.#cacheAt < ADMIN_LIMITS.cacheMs) return this.#age(this.#cached);
    if (!this.#operation) {
      const operation = this.#refresh(); this.#operation = operation;
      void operation.finally(() => { if (this.#operation === operation) this.#operation = undefined; }).catch(() => undefined);
    }
    return this.#operation;
  }
  #age(value: InfrastructureSnapshot): InfrastructureSnapshot {
    const age = Math.max(0, this.monotonicNow() - this.#cacheAt);
    return { ...value, kubernetes: { ...value.kubernetes, cacheAgeMs: value.kubernetes.cacheAgeMs === null ? null : value.kubernetes.cacheAgeMs + age },
      metrics: { ...value.metrics, cacheAgeMs: value.metrics.cacheAgeMs === null ? null : value.metrics.cacheAgeMs + age } };
  }
  async #request(path: string): Promise<unknown> {
    if (this.#closed) throw new Error('Джерело зупинено.');
    if (this.transport) return this.transport.request(path);
    // Read the current projected token for every refresh. Neither token nor CA
    // ever crosses the DTO boundary, and the server hostname is fixed.
    const started = performance.now(), controller = new AbortController();
    this.#credentialReads.add(controller);
    const timer = setTimeout(() => controller.abort(), ADMIN_LIMITS.providerMs);
    try {
      const [token, ca] = await Promise.all([
        readFile('/var/run/secrets/courier-route/token', { encoding: 'utf8', signal: controller.signal }),
        readFile('/var/run/secrets/courier-route/ca.crt', { signal: controller.signal }),
      ]);
      if (this.#closed || controller.signal.aborted || !token.trim() || token.length > 16_384 || ca.length > 131_072) throw new Error('Облікові дані джерела недоступні.');
      return await readKubernetesResponse(path, token, ca, this.#requests, https.request,
        Math.max(1, ADMIN_LIMITS.providerMs - (performance.now() - started)));
    } finally { clearTimeout(timer); this.#credentialReads.delete(controller); }
  }
  async #refresh(): Promise<InfrastructureSnapshot> {
    const namespace = encodeURIComponent(this.config.namespace!);
    const selector = encodeURIComponent(`app.kubernetes.io/name=courier-route-app,app.kubernetes.io/component=app,${OWNER}=${this.config.ownerId}`);
    const [pods, metrics, hpa, deployment] = await Promise.allSettled([
      this.#request(`/api/v1/namespaces/${namespace}/pods?labelSelector=${selector}&limit=${ADMIN_LIMITS.maxPods}`).then((value) => {
        if (object(object(value).metadata ?? {}).continue) throw new Error('Неповний список pod.'); return parsePods(value, this.config);
      }),
      this.#request(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods?labelSelector=${selector}`).then((value) => parseMetrics(value, this.config)),
      this.#request(`/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers/app`).then((value) => parseHpa(value, this.config)),
      this.#request(`/apis/apps/v1/namespaces/${namespace}/deployments/app`).then((value) => {
        const row = object(value); metadata(row.metadata, this.config, 'app'); const status = object(row.status ?? {});
        return { replicas: number(status.replicas, 0), readyReplicas: number(status.readyReplicas, 0), availableReplicas: number(status.availableReplicas, 0) };
      }),
    ]);
    if (this.#closed) throw new Error('Джерело зупинено.');
    const now = new Date().toISOString(), monotonic = this.monotonicNow();
    if (pods.status === 'fulfilled') this.#pods = { value: pods.value, observedAt: now, monotonic };
    if (metrics.status === 'fulfilled') this.#samples = { value: metrics.value, observedAt: now, monotonic };
    if (hpa.status === 'fulfilled') this.#hpa = { value: hpa.value, observedAt: now, monotonic };
    if (deployment.status === 'fulfilled') this.#deployment = { value: deployment.value, observedAt: now, monotonic };
    const source = (success: boolean, cached: Cached<unknown> | undefined, partial = false): AdminSource => ({
      status: success ? partial ? 'partial' : 'ok' : cached ? 'stale' : 'unavailable',
      observedAt: cached?.observedAt ?? null, cacheAgeMs: cached ? Math.max(0, monotonic - cached.monotonic) : null,
      message: success && !partial ? null : 'Джерело тимчасово недоступне або відмовило в читанні; останні дані можуть бути неактуальними.',
    });
    const value: InfrastructureSnapshot = {
      kubernetes: source(pods.status === 'fulfilled', this.#pods, hpa.status === 'rejected' || deployment.status === 'rejected'),
      metrics: source(metrics.status === 'fulfilled', this.#samples), pods: this.#pods?.value ?? [], samples: this.#samples?.value ?? [],
      hpa: this.#hpa?.value ?? null, deployment: this.#deployment?.value ?? null,
    };
    this.#cached = value; this.#cacheAt = monotonic; return value;
  }
}
