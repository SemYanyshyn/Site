// Тут задаю місткість черги, особистий ліміт задач і частоту її перевірки
// Active означає queued або running, а outstanding охоплює всі ще незавершені задачі

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

// Перевіряю цілі числа й дозволені межі, перш ніж ці значення потраплять до диспетчера
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

/* У резерв відновлення закладаю claim і commit до 6 с, два записи прогресу до 5 с кожен
 * Також враховую фінальний запис до 5 с і проміжки між перевірками черги
 * Узгоджую ці межі з createDatabasePool, якщо колись змінюватиму його таймаути */
// Обчислюю реальний додатковий запас після таймауту worker перед worker_lost
// Враховую очікування SQL і polling, щоб не оголосити живу задачу втраченою завчасно
export function effectiveWorkerLostGraceMs(config: JobsConfig): number {
  const validated = validateJobsConfig(config);
  return Math.max(validated.workerLostGraceMs, 2 * validated.pollIntervalMs + 21_000);
}

// Читаю JOBS-параметри із середовища, для відсутніх беру погоджені початкові значення
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
