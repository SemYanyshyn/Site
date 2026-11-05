// Тут перетворюю навчальні JSON-шаблони на конфігурації, які можна передати інструментам
// Коментарі зберігаю як спеціальні _comment-поля, бо стандартний JSON не підтримує //

import { readFile } from 'node:fs/promises';

// Залишаю короткі нотатки в JSON для себе, але не передаю їх kind або Kubernetes
// Рекурсивно прибираю лише _comment та _comment_* у вкладених об’єктах і масивах
// Звичайні значення, labels і реальні параметри ресурсів залишаю незмінними
export function deploymentConfigWithoutNotes(value) {
  if (Array.isArray(value)) return value.map(deploymentConfigWithoutNotes);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/^_comment(?:_|$)/u.test(key))
      .map(([key, item]) => [key, deploymentConfigWithoutNotes(item)]));
  }
  return value;
}

// Читаю тільки вихідні конфігурації deploy; файли стану та секрети читаються окремо
// Читаю JSON із deploy та повертаю вже очищений об’єкт
// Не використовую цей helper для credentials і файлів локального стану
export async function readDeploymentConfig(path) {
  try {
    return deploymentConfigWithoutNotes(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Вихідна конфігурація deploy містить некоректний JSON.');
    throw error;
  }
}
