import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Pool } from 'pg';
import { HttpError } from '../src/server/auth/errors.js';
import { JobsRepository } from '../src/server/jobs/repository.js';

test('a detail budget consumed before repository entry cannot acquire a connection or issue later SQL', async () => {
  const pool = new Pool({ connectionString: 'postgresql://probe@127.0.0.1:1/courier_queue_test', connectionTimeoutMillis: 20 });
  let acquisitions = 0;
  const observed = new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'connect') return async () => { acquisitions++; throw new Error('Unexpected database acquisition.'); };
      return Reflect.get(target, property, receiver);
    },
  });
  const repository = new JobsRepository(observed);
  try {
    for (const deadline of [performance.now() - 1, NaN, Infinity]) {
      await assert.rejects(repository.getWithQueue('unused-user', 'unused-job', 30_000, deadline), (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 503);
        assert.equal(error.code, 'DATABASE_UNAVAILABLE');
        return true;
      });
    }
    assert.equal(acquisitions, 0);
  } finally { await pool.end(); }
});
