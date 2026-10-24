import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { databaseUnavailable } from '../auth/errors.js';

/** Abort destroys an acquired pg socket, including a query in flight. A late
 * acquisition is immediately released; it can never issue SQL after timeout. */
export async function adminRead<T>(pool: Pool, deadline: number, signal: AbortSignal,
  operation: (query: <R extends QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  let released = false;
  const release = (destroy: boolean): void => {
    if (client && !released) { released = true; client.release(destroy); }
  };
  const abort = (): void => release(true);
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted || !Number.isFinite(deadline) || performance.now() >= deadline) throw databaseUnavailable();
    client = await new Promise<PoolClient>((resolve, reject) => {
      const canceled = (): void => reject(databaseUnavailable());
      signal.addEventListener('abort', canceled, { once: true });
      void pool.connect().then((acquired) => {
        signal.removeEventListener('abort', canceled);
        if (signal.aborted || performance.now() >= deadline) { acquired.release(true); reject(databaseUnavailable()); }
        else resolve(acquired);
      }, () => { signal.removeEventListener('abort', canceled); reject(databaseUnavailable()); });
    });
    if (signal.aborted || performance.now() >= deadline) throw databaseUnavailable();
    const value = await operation(async <R extends QueryResultRow>(text: string, values?: unknown[]) => {
      const remaining = Math.floor(deadline - performance.now());
      if (signal.aborted || released || remaining < 1) throw databaseUnavailable();
      try {
        const options = { text, ...(values === undefined ? {} : { values }), query_timeout: Math.min(1_000, remaining) };
        return await client!.query<R>(options);
      } catch { release(true); throw databaseUnavailable(); }
    });
    if (signal.aborted || performance.now() >= deadline) throw databaseUnavailable();
    return value;
  } catch { release(true); throw databaseUnavailable(); }
  finally { signal.removeEventListener('abort', abort); release(false); }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(databaseUnavailable());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(databaseUnavailable());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
