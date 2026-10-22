import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeTestDatabase } from './database-safety.js';

test('test database guard requires explicit independent test destinations', async () => {
  const application = 'postgresql://app@127.0.0.1:5432/courier_route';
  await assert.rejects(assertSafeTestDatabase(undefined, application));
  await assert.rejects(assertSafeTestDatabase('postgresql://app@127.0.0.1/courier_route', application));
  await assert.rejects(assertSafeTestDatabase('postgresql://app@127.0.0.1/courier_route_test', undefined));
  await assertSafeTestDatabase('postgresql://app@127.0.0.1:5432/courier_route_test', application);
});

test('test database guard compares parsed host, port and database, including local aliases', async () => {
  const application = 'postgresql://app@127.0.0.1:5432/courier_route_test';
  for (const target of [
    'postgresql://other@localhost/courier_route_test',
    'postgres://other@127.0.0.1:5432/courier_route_%74est?sslmode=disable',
    'postgresql://other@[::1]:5432/courier_route_test',
  ]) {
    await assert.rejects(assertSafeTestDatabase(target, application));
  }
  await assertSafeTestDatabase('postgresql://app@localhost:5433/courier_route_test', application);
});

test('test database guard rejects URL overrides that would change the pg destination', async () => {
  const application = 'postgresql://app@127.0.0.1/courier_route';
  for (const override of ['host', 'hostaddr', 'port', 'database', 'dbname', 'service']) {
    await assert.rejects(assertSafeTestDatabase(
      `postgresql://app@127.0.0.1/courier_route_test?${override}=other`, application,
    ));
  }
});
