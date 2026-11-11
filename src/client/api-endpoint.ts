import { normalizeApiBase } from '../shared/public-api.js';

export type ApiFetch = (path: string, init: RequestInit) => Promise<Response>;

export function createApiFetch(baseUrl?: string, fetcher: ApiFetch = (path, init) => fetch(path, init)): ApiFetch {
  const base = normalizeApiBase(baseUrl);
  return (path, init) => {
    if (!/^\/api(?:\/|\?)[^#]*$/u.test(path) || path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|\?|$)/u.test(path)) {
      throw new Error('Некоректний шлях API.');
    }
    return fetcher(`${base}${path}`, { ...init, credentials: base ? 'include' : 'same-origin' });
  };
}

export const apiFetch = createApiFetch(import.meta.env?.VITE_API_BASE_URL);
