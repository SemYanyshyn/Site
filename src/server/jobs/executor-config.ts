export interface ExecutorConfig {
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
}

export interface ExecutorPodMetadata {
  podUid: string | null;
  podName: string | null;
  podNamespace: string | null;
}

/** Downward API identity is optional on a host, and must be complete in a pod. */
export function readExecutorPodMetadata(env: NodeJS.ProcessEnv = process.env): ExecutorPodMetadata {
  const values = [env.POD_UID, env.POD_NAME, env.POD_NAMESPACE];
  if (values.every((value) => value === undefined)) return { podUid: null, podName: null, podNamespace: null };
  const [podUid, podName, podNamespace] = values;
  if (!podUid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(podUid)
    || !podName || podName.length > 253 || !podName.split('.').every((part) => part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
    || !podNamespace || podNamespace.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(podNamespace)) {
    throw new ExecutorConfigurationError('POD_UID, POD_NAME і POD_NAMESPACE мають містити повну коректну ідентичність Downward API або бути відсутніми поза Kubernetes.');
  }
  return { podUid: podUid.toLowerCase(), podName, podNamespace };
}

export const DEFAULT_EXECUTOR_CONFIG: Readonly<ExecutorConfig> = Object.freeze({
  heartbeatIntervalMs: 1_000,
  leaseTtlMs: 15_000,
});

export class ExecutorConfigurationError extends Error {
  readonly code = 'invalid_executor_config';
}

export function validateExecutorConfig(config: ExecutorConfig): ExecutorConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !Number.isSafeInteger(config.heartbeatIntervalMs) || config.heartbeatIntervalMs < 100 || config.heartbeatIntervalMs > 5_000
    || !Number.isSafeInteger(config.leaseTtlMs) || config.leaseTtlMs > 60_000
    || config.leaseTtlMs < 3 * config.heartbeatIntervalMs + 6_000) {
    throw new ExecutorConfigurationError('Інтервал heartbeat має бути цілим від 100 до 5000 мс, TTL — не менше 3 інтервалів + 6000 мс і не більше 60000 мс.');
  }
  return { heartbeatIntervalMs: config.heartbeatIntervalMs, leaseTtlMs: config.leaseTtlMs };
}

export function readExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const integer = (key: string, fallback: number): number => {
    const value = env[key];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new ExecutorConfigurationError(`${key} має бути цілим додатним десятковим числом.`);
    return Number(value);
  };
  return validateExecutorConfig({
    heartbeatIntervalMs: integer('EXECUTOR_HEARTBEAT_INTERVAL_MS', DEFAULT_EXECUTOR_CONFIG.heartbeatIntervalMs),
    leaseTtlMs: integer('EXECUTOR_LEASE_TTL_MS', DEFAULT_EXECUTOR_CONFIG.leaseTtlMs),
  });
}
