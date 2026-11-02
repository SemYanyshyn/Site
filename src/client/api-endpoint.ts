/// <reference types="vite/client" />
import { normalizeApiBase } from '../shared/public-api.js';

export type ApiFetch = (path: string, init: RequestInit) => Promise<Response>;

/** Only address/cookie policy changes; callers retain their aborts, deadlines and error handling. */
export function createApiFetch(baseUrl?: string, fetcher: ApiFetch = (path, init) => fetch(path, init)): ApiFetch {
  const base = normalizeApiBase(baseUrl);
  return (path, init) => {
    // A caller cannot accidentally send session credentials to an arbitrary URL.
    if (!/^\/api(?:\/|\?)[^#]*$/u.test(path) || path.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|\?|$)/u.test(path)) {
      throw new Error('Некоректний шлях API.');
    }
    return fetcher(`${base}${path}`, { ...init, credentials: base ? 'include' : 'same-origin' });
  };
}

// Vite replaces this public setting at build time; Node tests use the local default.
export const apiFetch = createApiFetch(import.meta.env?.VITE_API_BASE_URL);
