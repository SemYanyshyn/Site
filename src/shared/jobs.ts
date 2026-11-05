// Тут описую спільні дані збережених задач і прогнозу черги для API та інтерфейсу
// Не плутаю задачу в PostgreSQL з окремим запуском worker, задача має власну історію станів

import type { NormalizedRouteInput, RouteLimits, RouteOutcome, RouteProgress, RouteResult } from './route.js';

// Розрізняю очікування queued, виконання running і три кінцеві стани
// completed має результат, cancelled означає скасування, failed містить причину збою
export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
// Перелічую відомі причини помилки, щоб frontend не вгадував їх із тексту повідомлення
export type JobFailureReason = 'timeout' | 'worker_error' | 'server_shutdown' | 'database_unavailable' | 'invalid_input' | 'worker_lost';
// Розширюю результат worker інфраструктурними причинами завершення збереженої задачі
export type JobTerminal = RouteOutcome | { status: 'failed'; reason: JobFailureReason; message: string };

// Для історії повертаю короткі дані без координат і великого результату
// Час передаю рядками, null означає, що подія ще не відбулась
// executedBy називає серверний процес, cancelRequested позначає запит, а не вже завершену зупинку
export interface JobSummary {
  id: string;
  status: JobStatus;
  progress: RouteProgress;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  executedBy: string | null;
  error?: { reason: JobFailureReason; message: string };
}

// До короткого опису додаю перевірений вхід і необов’язкові результат та прогноз черги
// Наявність result очікую для completed, а queue — для queued, ці умови перевіряю додатково під час роботи
export interface JobDetails extends JobSummary {
  input: NormalizedRouteInput;
  result?: RouteResult;
  queue?: JobQueueInfo;
}

// Задаю спільні верхні межі знімка черги, щоб перевірки на сервері та в браузері збігалися
// Object.freeze захищає цей об’єкт констант від зміни під час роботи
export const QUEUE_LIMITS = Object.freeze({
  maxQueuedAhead: 10_000,
  maxExecutors: 10_000,
  maxWaitMs: 1_400_140_000,
});

// estimatedWaitMs оцінює час до старту без власної тривалості обчислення
// null означає відсутній прогноз, calculatedAt дозволяє визначити його вік
// У basis розрізняю виміряну оцінку, таймаут, змішану основу або недоступність
export interface JobQueueInfo {
  estimatedWaitMs: number | null;
  calculatedAt: string;
  queuedAhead: number;
  executorCount: number;
  basis: 'measured' | 'mixed' | 'timeout' | 'unavailable';
}

// Повертаю одну сторінку історії з її limit та offset, без вигаданого загального total
export interface JobListResponse {
  jobs: JobSummary[];
  limit: number;
  offset: number;
}

// Передаю frontend фактичні серверні межі маршруту й активних задач користувача
// Навіть якщо браузер їх перевірив, backend повторно перевіряє вхід і місткість черги
export interface JobLimitsResponse {
  route: RouteLimits;
  maxActivePerUser: number;
}
