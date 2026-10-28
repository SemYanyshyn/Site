import { QUEUE_LIMITS } from '../../shared/jobs.js';
import type { JobQueueInfo } from '../../shared/jobs.js';
import type { RouteProgress } from '../../shared/route.js';

export interface QueueExecutor {
  instanceId: string;
  expiresAt: string;
  acceptingClaims: boolean;
  busy: boolean;
  currentJobId: string | null;
}

export interface QueueRunningJob {
  id: string;
  instanceId: string;
  startedAt: string;
  timeoutMs: number;
  stage: RouteProgress['stage'];
  completedIterations: number;
  totalIterations: number;
  cancelRequested: boolean;
  pointCount: number;
}

export interface QueueQueuedJob { pointCount: number; iterations: number }

export interface QueueDurationSample extends QueueQueuedJob {
  durationMs: number;
  iterationsCompleted: number;
  terminationReason: string;
  status: 'completed' | 'failed' | 'cancelled';
}

export interface QueueSnapshot {
  calculatedAt: string;
  executors: QueueExecutor[];
  running: QueueRunningJob[];
  queuedAhead: QueueQueuedJob[];
  samples: QueueDurationSample[];
}

export interface QueueEstimateOptions {
  timeoutMs: number;
  handoffMs?: number;
  finalizationMs?: number;
}

export const QUEUE_MODEL = Object.freeze({
  handoffMs: 250,
  finalizationMs: 500,
  maxSamples: 200,
  maxSampleDurationMs: 180_000,
});

function integer(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validWork(job: QueueQueuedJob): boolean {
  return integer(job.pointCount, 1, 2_000) && integer(job.iterations, 1, 200_000_000);
}

// filter лишає тільки повністю завершені нетривіальні пошуки з коректним часом для оцінки швидкості
function measuredSamples(samples: QueueDurationSample[]): QueueDurationSample[] {
  return samples.filter((sample) => sample.status === 'completed' && sample.terminationReason === 'budget_exhausted'
    && validWork(sample) && sample.pointCount > 2 && sample.iterationsCompleted === sample.iterations
    && Number.isFinite(sample.durationMs) && sample.durationMs > 0 && sample.durationMs <= QUEUE_MODEL.maxSampleDurationMs);
}

function cost(job: QueueQueuedJob): number { return job.iterations + job.pointCount * job.pointCount; }

// min heap тримає зверху слот який звільниться найраніше без сортування всіх слотів для кожної задачі
class SlotHeap {
  private readonly values: number[];
  constructor(values: number[]) {
    this.values = values;
    for (let index = Math.floor(values.length / 2) - 1; index >= 0; index--) this.down(index);
  }
  get first(): number { return this.values[0]!; }
  replaceFirst(value: number): void { this.values[0] = value; this.down(0); }
  private down(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.values.length) return;
      const right = left + 1;
      const child = right < this.values.length && this.values[right]! < this.values[left]! ? right : left;
      if (this.values[index]! <= this.values[child]!) return;
      [this.values[index], this.values[child]] = [this.values[child]!, this.values[index]!];
      index = child;
    }
  }
}

// оцінюю час до старту цієї задачі без її власної тривалості і без обіцянки точного часу
// беру зайнятість слота finished_at - started_at і медіанну швидкість задач близького розміру
export function estimateQueue(snapshot: QueueSnapshot, options: QueueEstimateOptions): JobQueueInfo {
  const handoffMs = options.handoffMs ?? QUEUE_MODEL.handoffMs;
  const finalizationMs = options.finalizationMs ?? QUEUE_MODEL.finalizationMs;
  if (!integer(options.timeoutMs, 1, 120_000) || !integer(handoffMs, 0, 10_000) || !integer(finalizationMs, 0, 10_000)
    || snapshot.executors.length > QUEUE_LIMITS.maxExecutors || snapshot.running.length > 10_000
    || snapshot.queuedAhead.length > QUEUE_LIMITS.maxQueuedAhead || snapshot.samples.length > QUEUE_MODEL.maxSamples) {
    throw new RangeError('Знімок або налаштування оцінки черги перевищує межі.');
  }
  const now = Date.parse(snapshot.calculatedAt);
  if (!Number.isFinite(now)) throw new RangeError('Некоректний час знімка черги.');
  // враховую лише виконавців які приймають задачі й мають чинний TTL на час знімка БД
  const executors = snapshot.executors.filter((executor) => executor.acceptingClaims
    && Number.isFinite(Date.parse(executor.expiresAt)) && Date.parse(executor.expiresAt) > now);
  const result: JobQueueInfo = {
    estimatedWaitMs: null, calculatedAt: snapshot.calculatedAt,
    queuedAhead: snapshot.queuedAhead.length, executorCount: executors.length, basis: 'unavailable',
  };
  if (executors.length === 0) return result;
  if (new Set(executors.map((executor) => executor.instanceId)).size !== executors.length
    || snapshot.queuedAhead.some((job) => !validWork(job))) return result;

  const history = measuredSamples(snapshot.samples);
  const buckets = new Map<number, number[]>();
  for (const sample of history) {
    const bucket = Math.floor(Math.log2(sample.pointCount));
    const rates = buckets.get(bucket) ?? [];
    rates.push(sample.durationMs / cost(sample));
    buckets.set(bucket, rates);
  }
  const medianRates = new Map<number, number>();
  for (const [bucket, rates] of buckets) {
    rates.sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    medianRates.set(bucket, rates.length % 2 === 0 ? (rates[middle - 1]! + rates[middle]!) / 2 : rates[middle]!);
  }
  let usedMeasured = false;
  let usedTimeout = false;
  function duration(job: QueueQueuedJob): number {
    const median = medianRates.get(Math.floor(Math.log2(job.pointCount)));
    if (median === undefined) { usedTimeout = true; return options.timeoutMs + handoffMs + finalizationMs; }
    usedMeasured = true;
    return Math.max(1, Math.min(options.timeoutMs, median * cost(job))) + handoffMs + finalizationMs;
  }

  const runningByExecutor = new Map<string, QueueRunningJob[]>();
  for (const job of snapshot.running) {
    const rows = runningByExecutor.get(job.instanceId);
    if (rows) rows.push(job); else runningByExecutor.set(job.instanceId, [job]);
  }
  const slots: number[] = [];
  for (const executor of executors) {
    const jobs = runningByExecutor.get(executor.instanceId) ?? [];
    if (jobs.length > 1) return result;
    const job = jobs[0];
    if (!job) {
      // A claim/finalization/direct CLI-style run still owns this slot even
      // when no matching running row is visible. Do not invent an idle slot.
      if (executor.busy || executor.currentJobId !== null) return result;
      slots.push(handoffMs);
      continue;
    }
    if (executor.currentJobId !== null && executor.currentJobId !== job.id) return result;
    const startedAt = Date.parse(job.startedAt);
    if (!Number.isFinite(startedAt) || startedAt > now || !integer(job.timeoutMs, 1, 120_000)
      || !integer(job.totalIterations, 1, 200_000_000) || !integer(job.completedIterations, 0, job.totalIterations)
      || !integer(job.pointCount, 1, 2_000) || !['preparing', 'searching', 'finishing'].includes(job.stage)) return result;
    const elapsed = now - startedAt;
    const timeoutRemaining = Math.max(0, job.timeoutMs - elapsed);
    let remaining: number;
    if (job.stage === 'searching' && job.completedIterations > 0 && elapsed > 0) {
      usedMeasured = true;
      remaining = Math.min(timeoutRemaining, elapsed * (job.totalIterations - job.completedIterations) / job.completedIterations);
    } else if (job.stage === 'finishing') {
      usedMeasured = true;
      remaining = 0;
    } else {
      usedTimeout = true;
      remaining = timeoutRemaining;
    }
    // cancelRequested and all completed iterations do not imply physical exit
    // or an agreed terminal. A busy slot always retains a positive allowance.
    slots.push(Math.max(1, remaining + finalizationMs));
  }
  // по черзі додаю задачі попереду до найраніше вільного слота і так отримую очікування цільової
  const heap = new SlotHeap(slots);
  for (const job of snapshot.queuedAhead) heap.replaceFirst(Math.min(QUEUE_LIMITS.maxWaitMs, heap.first + duration(job)));
  result.estimatedWaitMs = Math.min(QUEUE_LIMITS.maxWaitMs, Math.max(0, Math.ceil(heap.first)));
  result.basis = usedTimeout ? usedMeasured ? 'mixed' : 'timeout' : 'measured';
  return result;
}
