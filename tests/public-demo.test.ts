import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Native executable helper is intentionally independent of TypeScript/runtime dependencies.
import { deploymentAppOrigins, ownedTunnelProcess } from '../scripts/public-origins.mjs';

test('public demo adds exact HTTPS origins while always retaining the original local deployment', () => {
  const local = 'https://localhost:8443';
  assert.equal(deploymentAppOrigins(local, undefined), local);
  assert.equal(deploymentAppOrigins(local, ''), local);
  assert.equal(deploymentAppOrigins(local, 'https://route.example.test,https://route.example.test/'), `${local},https://route.example.test`);
});
test('public demo rejects wildcards, non-HTTPS, paths and secrets without reflecting their values', () => {
  for (const value of ['*', 'http://example.test', 'https://*.example.test', 'https://user:private-sentinel@example.test',
    'https://example.test/path', 'https://example.test?token=private-sentinel', 'https://localhost', 'https://example.test,']) {
    assert.throws(() => deploymentAppOrigins('https://localhost:8443', value), (error: unknown) => error instanceof Error && !error.message.includes('private-sentinel'));
  }
});
test('stop guard refuses reused PIDs, other executables and different process start times', () => {
  const record = { pid: 1234, binary: '/owned/tools/cloudflared', started: 'Mon Nov 2 12:00:00 2026' };
  const identity = { started: record.started, command: '/owned/tools/cloudflared tunnel --url https://localhost:8443' };
  assert.equal(ownedTunnelProcess(record, identity), true);
  for (const changed of [null, { ...identity, started: 'different time' }, { ...identity, command: 'unrelated process' }]) assert.equal(ownedTunnelProcess(record, changed), false);
  assert.equal(ownedTunnelProcess({ ...record, pid: 1 }, identity), false);
});
