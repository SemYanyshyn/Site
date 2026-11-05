// Тут описую спільний формат адміністративних даних, який розуміють backend і frontend
// Передаю лише публічні поля для огляду, без токенів, паролів і внутрішніх об’єктів Kubernetes
// Інтерфейси зникають після компіляції, тому отриманий JSON додатково перевіряю під час роботи

import type { JobFailureReason, JobStatus } from './jobs.js';
import type { RouteProgress } from './route.js';

// Розрізняю справні, часткові, застарілі, недоступні й вимкнені джерела
// Так відсутність метрик не виглядатиме як нульове навантаження
export type AdminSourceStatus = 'ok' | 'partial' | 'stale' | 'unavailable' | 'disabled';
// Для кожного джерела зберігаю статус, час спостереження та вік кешу
// null означає, що значення невідоме, а не що воно дорівнює нулю
export interface AdminSource {
  status: AdminSourceStatus;
  observedAt: string | null;
  cacheAgeMs: number | null;
  message: string | null;
}
// Збираю кількість задач окремо для кожного стану
export interface AdminCounts { queued: number; running: number; completed: number; cancelled: number; failed: number }
// Описую серверний процес із його UUID, pod і строком чинності heartbeat
// Один процес має один обчислювальний слот, fresh показує свіжість реєстрації, busy — зайнятість
// Масив runningJobIds дозволяє показати фактичні зв’язки з бази й помітити неузгодженість
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
// Зберігаю CPU в ядрах, пам’ять у байтах, час і тривалість вікна вимірювання
// Прапорцем stale явно позначаю застарілі показники
export interface AdminMetric {
  timestamp: string;
  window: string;
  cpuCores: number;
  memoryBytes: number;
  stale: boolean;
}
// Описую стан pod Kubernetes і його app-контейнера
// requests — запитані ресурси для планування, limits — верхні обмеження контейнера
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
// До pod додаю зіставленого виконавця й метрики, якщо їх вдалося підтвердити
// Наявність pod сама по собі ще не підтверджує зареєстрований серверний процес
export interface AdminServer extends AdminPod {
  executor: AdminExecutor | null;
  metric: AdminMetric | null;
  mapping: 'matched' | 'unregistered';
}
// Залишаю незiставленого виконавця видимим і пояснюю причину
// Наприклад, він запущений поза Kubernetes або належить попередньому процесу контейнера
export interface AdminUnmatchedExecutor extends AdminExecutor {
  reason: 'outside-kubernetes' | 'missing-pod' | 'previous-process' | 'metadata-mismatch';
}
// Описую автомасштабування HPA: мінімум, максимум, поточні та бажані репліки
// conditions передають стан контролера, цей тип сам нічого не масштабує
export interface AdminHpa {
  minReplicas: number;
  maxReplicas: number;
  currentReplicas: number;
  desiredReplicas: number;
  conditions: { type: string; status: string; reason: string }[];
}
// Збираю відповідь огляду в чотири частини: база, інфраструктура, підсумок і сервери
// Невідомі показники лишаю null, а неповне охоплення метрик показую окремими лічильниками
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
// Описую задачу для адміністратора з власником, прогресом і виконавцем
// Координати, пароль і приватний claim token сюди не включаю
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
// Повертаю сторінку задач разом із загальною кількістю та часом знімка бази
export interface AdminJobsResponse {
  jobs: AdminJob[];
  total: number;
  limit: number;
  offset: number;
  snapshotAt: string;
}
// Описую дозволені фільтри списку, active об’єднує queued і running
// Знак питання означає необов’язкове поле, його відсутність не є порожнім рядком
export interface AdminJobsOptions {
  limit: number;
  offset: number;
  status?: JobStatus | 'active';
  executedBy?: string;
}

// На кожній межі окремо перевіряю дозволені поля, а тут узгоджую спільні правила для окремих значень
// UUID перевіряю за форматом, сам по собі цей збіг ще не дає прав доступу
export const ADMIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Під час роботи перевіряю, що значення є об’єктом, а не null або масивом
// Це лише базова перевірка, конкретні поля кожен обробник перевіряє окремо
export function adminRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Перевіряю рядковий час на довжину й можливість прочитати його через Date.parse
// Ця функція не вимагає одного конкретного формату ISO
export function adminTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
