export interface JobsConfig {
  maxActivePerUser: number;
  maxOutstanding: number;
  pollIntervalMs: number;
  workerLostGraceMs: number;
}

export const DEFAULT_JOBS_CONFIG: Readonly<JobsConfig> = Object.freeze({
  maxActivePerUser: 3,
  maxOutstanding: 100,
  pollIntervalMs: 250,
  workerLostGraceMs: 5_000,
});

const bounds = {
  maxActivePerUser: [1, 100],
  maxOutstanding: [1, 10_000],
  pollIntervalMs: [25, 5_000],
  workerLostGraceMs: [100, 30_000],
} as const;

export class JobsConfigurationError extends Error {
  readonly code = 'invalid_jobs_config';
}

export function validateJobsConfig(config: JobsConfig): JobsConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new JobsConfigurationError('Налаштування задач мають бути об’єктом.');
  }
  for (const key of Object.keys(bounds) as (keyof JobsConfig)[]) {
    const [minimum, maximum] = bounds[key];
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new JobsConfigurationError(`${key} має бути цілим числом від ${minimum} до ${maximum}.`);
    }
  }
  return { ...config };
}

/** Include claim UPDATE/commit (6s), up to two pending progress writes (each
 * 2s acquire + 3s SQL), and terminal persistence (2s acquire + 3s SQL), plus
 * polling margins. These budgets must
 * stay aligned with createDatabasePool if its timeouts change. */
export function effectiveWorkerLostGraceMs(config: JobsConfig): number {
  const validated = validateJobsConfig(config);
  return Math.max(validated.workerLostGraceMs, 2 * validated.pollIntervalMs + 21_000);
}

export function readJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const read = (key: string, fallback: number): number => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new JobsConfigurationError(`${key} має містити додатне ціле десяткове число.`);
    return Number(value);
  };
  return validateJobsConfig({
    maxActivePerUser: read('JOBS_MAX_ACTIVE_PER_USER', DEFAULT_JOBS_CONFIG.maxActivePerUser),
    maxOutstanding: read('JOBS_MAX_OUTSTANDING', DEFAULT_JOBS_CONFIG.maxOutstanding),
    pollIntervalMs: read('JOBS_POLL_INTERVAL_MS', DEFAULT_JOBS_CONFIG.pollIntervalMs),
    workerLostGraceMs: read('JOBS_WORKER_LOST_GRACE_MS', DEFAULT_JOBS_CONFIG.workerLostGraceMs),
  });
}
