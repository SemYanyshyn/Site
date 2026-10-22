import './styles.css';
import type { HealthResponse } from '../shared/health.js';

const statusElement = document.querySelector<HTMLParagraphElement>('#server-status');
const statusCard = document.querySelector<HTMLDivElement>('.status-card');

if (!statusElement || !statusCard) {
  throw new Error('Не знайдено елементи статусу сервера.');
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    value.status === 'ok' &&
    'instanceId' in value &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0
  );
}

async function checkHealth(status: HTMLParagraphElement, card: HTMLDivElement): Promise<void> {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health: unknown = await response.json();
    if (!isHealthResponse(health)) throw new Error('Некоректна відповідь сервера.');

    status.textContent = 'Сервер доступний';
    card.dataset.state = 'ok';
  } catch {
    status.textContent = 'Сервер недоступний. Перевірте його запуск і оновіть сторінку.';
    card.dataset.state = 'error';
  }
}

void checkHealth(statusElement, statusCard);
