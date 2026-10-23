import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutorConfigurationError, readExecutorConfig, validateExecutorConfig } from '../src/server/jobs/executor-config.js';

test('executor leases have explicit defaults and validated interval/DB-operation margins', () => {
  assert.deepEqual(readExecutorConfig({}), { heartbeatIntervalMs: 1000, leaseTtlMs: 15_000 });
  assert.deepEqual(readExecutorConfig({ EXECUTOR_HEARTBEAT_INTERVAL_MS: '100', EXECUTOR_LEASE_TTL_MS: '6300' }), { heartbeatIntervalMs: 100, leaseTtlMs: 6300 });
  assert.deepEqual(readExecutorConfig({ EXECUTOR_HEARTBEAT_INTERVAL_MS: '5000', EXECUTOR_LEASE_TTL_MS: '60000' }), { heartbeatIntervalMs: 5000, leaseTtlMs: 60_000 });
  assert.throws(() => readExecutorConfig({ EXECUTOR_HEARTBEAT_INTERVAL_MS: '5000', EXECUTOR_LEASE_TTL_MS: '20999' }), ExecutorConfigurationError);
  assert.deepEqual(readExecutorConfig({ EXECUTOR_HEARTBEAT_INTERVAL_MS: '5000', EXECUTOR_LEASE_TTL_MS: '21000' }), { heartbeatIntervalMs: 5000, leaseTtlMs: 21_000 });
});

test('executor lease configuration rejects missing numeric integrity and hard bounds', () => {
  for (const key of ['EXECUTOR_HEARTBEAT_INTERVAL_MS', 'EXECUTOR_LEASE_TTL_MS']) {
    for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992']) {
      assert.throws(() => readExecutorConfig({ [key]: value }), ExecutorConfigurationError);
    }
  }
  for (const heartbeatIntervalMs of [0, 99, 5001, NaN, Infinity, 1.5]) assert.throws(() => validateExecutorConfig({ heartbeatIntervalMs, leaseTtlMs: 15_000 }), ExecutorConfigurationError);
  for (const leaseTtlMs of [0, 8999, 60_001, NaN, Infinity, 15_000.5]) assert.throws(() => validateExecutorConfig({ heartbeatIntervalMs: 1000, leaseTtlMs }), ExecutorConfigurationError);
});

test('executor lease expiry reserve remains distinct from persisted worker-lost deadline', () => {
  const config = readExecutorConfig({ EXECUTOR_HEARTBEAT_INTERVAL_MS: '100', EXECUTOR_LEASE_TTL_MS: '6300' });
  assert.ok(config.leaseTtlMs >= 3 * config.heartbeatIntervalMs + 6000);
  assert.ok(config.leaseTtlMs < 21_080, 'A stale executor disappears before the independent job loss grace; TTL cannot reap a job itself.');
});
