import type { JobQueueInfo } from '../shared/jobs.js';

export interface QueueDisplay {
  estimate: string;
  explanation: string;
  context: string;
}

/** Display the server snapshot; there is deliberately no client countdown. */
export function queueDisplay(queue: JobQueueInfo | undefined): QueueDisplay {
  if (!queue) return { estimate: 'Оцінюємо час очікування…', explanation: '', context: '' };
  const wait = queue.estimatedWaitMs;
  const estimate = wait === null ? 'Наразі немає доступної оцінки часу очікування.'
    : wait === 0 ? 'Очікуємо призначення вільному виконавцю.'
      : wait < 1_000 ? 'Орієнтовно менше секунди до початку.'
        : wait < 60_000 ? `Орієнтовно ${Math.ceil(wait / 1_000).toLocaleString('uk-UA')} с до початку.`
          : `Орієнтовно ${Math.ceil(wait / 60_000).toLocaleString('uk-UA')} хв до початку.`;
  const basis = queue.basis === 'timeout' ? 'Попередня оцінка за серверною межею часу.'
    : queue.basis === 'mixed' ? 'Оцінка за виміряною роботою та серверною межею часу.'
      : queue.basis === 'measured' ? 'Оцінка за поточним станом і даними роботи.'
        : queue.executorCount === 0 ? 'Немає доступного виконавця, який приймає нові задачі.'
          : 'Даних про доступність виконавців недостатньо для прогнозу.';
  return {
    estimate,
    explanation: `${basis} Оцінка може змінюватися.`,
    context: `Задач перед вашою в черзі: ${queue.queuedAhead.toLocaleString('uk-UA')}. Виконавців: ${queue.executorCount.toLocaleString('uk-UA')}. Оновлено ${new Date(queue.calculatedAt).toLocaleTimeString('uk-UA')}.`,
  };
}
