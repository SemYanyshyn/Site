/// <reference types="vite/client" />
// Тут визначаю адресу API та правила передавання cookie для всіх клієнтських запитів.
import { normalizeApiBase } from '../shared/public-api.js';

export type ApiFetch = (path: string, init: RequestInit) => Promise<Response>;

// Збираю спільний спосіб звернення до API; окремі запити задають свої таймаути й обробку помилок.
export function createApiFetch(baseUrl?: string, fetcher: ApiFetch = (path, init) => fetch(path, init)): ApiFetch {
  const base = normalizeApiBase(baseUrl);
  return (path, init) => {
    // Дозволяю тільки шляхи /api/..., щоб cookie сесії потрапляли до потрібного API.
    if (!/^\/api(?:\/|\?)[^#]*$/u.test(path) || path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|\?|$)/u.test(path)) {
      throw new Error('Некоректний шлях API.');
    }
    return fetcher(`${base}${path}`, { ...init, credentials: base ? 'include' : 'same-origin' });
  };
}

// Беру публічну адресу API з налаштування Vite; порожнє значення залишає API на адресі цього сайту.
export const apiFetch = createApiFetch(import.meta.env?.VITE_API_BASE_URL);
