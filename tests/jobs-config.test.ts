import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveWorkerLostGraceMs, JobsConfigurationError, readJobsConfig } from '../src/server/jobs/config.js';

test('jobs configuration has bounded defaults without database credentials', () => {
  assert.deepEqual(readJobsConfig({}), {
    maxActivePerUser: 3, maxOutstanding: 100, pollIntervalMs: 250, workerLostGraceMs: 5_000,
  });
  assert.deepEqual(readJobsConfig({
    JOBS_MAX_ACTIVE_PER_USER: '100', JOBS_MAX_OUTSTANDING: '10000',
    JOBS_POLL_INTERVAL_MS: '5000', JOBS_WORKER_LOST_GRACE_MS: '30000',
  }), { maxActivePerUser: 100, maxOutstanding: 10_000, pollIntervalMs: 5_000, workerLostGraceMs: 30_000 });
});

test('invalid job settings cannot remove admission or polling resource bounds', () => {
  for (const name of ['JOBS_MAX_ACTIVE_PER_USER', 'JOBS_MAX_OUTSTANDING', 'JOBS_POLL_INTERVAL_MS', 'JOBS_WORKER_LOST_GRACE_MS']) {
    for (const value of ['', ' ', '0', '-1', '1.5', 'Infinity', 'NaN', '1e3', '9007199254740992']) {
      assert.throws(() => readJobsConfig({ [name]: value }), JobsConfigurationError);
    }
  }
  for (const [name, value] of [
    ['JOBS_MAX_ACTIVE_PER_USER', '101'], ['JOBS_MAX_OUTSTANDING', '10001'],
    ['JOBS_POLL_INTERVAL_MS', '24'], ['JOBS_POLL_INTERVAL_MS', '5001'],
    ['JOBS_WORKER_LOST_GRACE_MS', '99'], ['JOBS_WORKER_LOST_GRACE_MS', '30001'],
  ]) assert.throws(() => readJobsConfig({ [name!]: value! }), JobsConfigurationError);
});

test('loss recovery waits for polling and bounded database work even with a small configured grace', () => {
  assert.equal(effectiveWorkerLostGraceMs(readJobsConfig({})), 21_500);
  assert.equal(effectiveWorkerLostGraceMs(readJobsConfig({
    JOBS_POLL_INTERVAL_MS: '5000', JOBS_WORKER_LOST_GRACE_MS: '100',
  })), 31_000, 'A long polling interval must not reap a physically stopped worker before its terminal write.');
  assert.equal(effectiveWorkerLostGraceMs(readJobsConfig({
    JOBS_POLL_INTERVAL_MS: '40', JOBS_WORKER_LOST_GRACE_MS: '250',
  })), 21_080);
  assert.equal(effectiveWorkerLostGraceMs(readJobsConfig({ JOBS_WORKER_LOST_GRACE_MS: '30000' })), 30_000);
});
