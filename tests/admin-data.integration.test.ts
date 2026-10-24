import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isDatabaseReady } from '../src/server/database.js';
import { REQUIRED_MIGRATIONS } from '../src/server/db/migrate.js';
import { ExecutorRegistry } from '../src/server/jobs/executor-registry.js';
import { calculateRoute } from '../src/server/route/algorithm.js';
import { assertSafeTestDatabase } from './database-safety.js';
import { quickRouteInput } from './fixtures/route-input.js';

const schema = `courier_test_admin_data_${randomBytes(10).toString('hex')}`;
const root = fileURLToPath(new URL('../', import.meta.url));
let pool: pg.Pool;
let control: pg.Pool | undefined;
let databaseUrl: string;
let created = false;
const username = `role_${randomBytes(8).toString('hex')}`;
const accountId = randomUUID();
const jobId = randomUUID();
const oldInstance = randomUUID();

function child(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, args, { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let expired = false; let failed = false;
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGKILL'); }, 15000);
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (Buffer.byteLength(output) > 32768) { failed = true; processChild.kill('SIGKILL'); } };
    processChild.stdout.on('data', collect); processChild.stderr.on('data', collect);
    processChild.once('error', () => { failed = true; });
    processChild.once('close', (code) => {
      clearTimeout(timer);
      if (expired || failed) { reject(new Error('Own bounded role/migration process failed; private output was suppressed.')); return; }
      // Even assertion failures below must never print credentials or a DB URL.
      for (const value of [databaseUrl, new URL(databaseUrl).password]) if (value && output.includes(value)) {
        reject(new Error('CLI output contained a forbidden private value.')); return;
      }
      resolve({ code, output });
    });
  });
}

describe('Additive executor metadata and explicit application-role operator CLI on real PostgreSQL', { concurrency: false }, () => {
  before(async () => {
    const target = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    control = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 2000, query_timeout: 3000 });
    const { rows: [actual] } = await control.query<{ database: string; port: number; address: string; role: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      'SELECT current_database() AS database,inet_server_port() AS port,inet_server_addr()::text AS address,current_user AS role,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    assert.ok(actual && actual.database === target.database && actual.port === Number(url.port || 5432));
    assert.equal(actual.role, decodeURIComponent(url.username));
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) assert.ok(actual.address === '::1' || actual.address.startsWith('127.'));
    assert.equal(actual.rolsuper, false); assert.equal(actual.rolcreatedb, false); assert.equal(actual.rolcreaterole, false);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    url.searchParams.set('options', `-c search_path=${schema}`); databaseUrl = url.href;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 2500 });
  });
  after(async () => {
    await pool?.end();
    try { if (created) await control?.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await control?.end(); }
  });

  test('003→004 compiled concurrent migration preserves account/session/job/result/registry and old writer compatibility', async () => {
    await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const version of REQUIRED_MIGRATIONS.slice(0, 3)) {
      const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
      await pool.query(sql); await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, createHash('sha256').update(sql).digest('hex')]);
    }
    const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const input = quickRouteInput(); const result = calculateRoute(input);
    await pool.query('INSERT INTO users(id,username,normalized_username,password_hash) VALUES($1,$2,$2,$3)', [accountId, username, 'unusable_private_test_fixture']);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [tokenHash, accountId]);
    await pool.query(`INSERT INTO jobs(id,user_id,input,status,progress_stage,completed_iterations,total_iterations,progress_percent,started_at,finished_at,
      instance_id,claim_token,timeout_ms,lost_after,result) VALUES($1,$2,$3,'completed','finishing',$4,$4,100,now()-interval '2 seconds',now()-interval '1 second',$5,$6,30000,now()+interval '1 minute',$7)`,
    [jobId, accountId, input, input.iterations, oldInstance, randomUUID(), result]);
    await pool.query("INSERT INTO executor_registry(instance_id,started_at,last_seen_at,expires_at,accepting_claims,busy,current_job_id) VALUES($1,now(),now(),now()+interval '15 seconds',true,false,NULL)", [oldInstance]);
    const tables = ['users', 'sessions', 'jobs', 'executor_registry'];
    const beforeRows = await Promise.all(tables.map(async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows));
    assert.equal(await isDatabaseReady(pool), false);
    const runs = await Promise.all([child(['dist/server/db/migrate.js']), child(['dist/server/db/migrate.js'])]);
    assert.ok(runs.every((run) => run.code === 0), 'Both bounded compiled runners must complete without exposing private output.');
    const afterRows = await Promise.all(tables.map(async (table) => (await pool.query(`SELECT * FROM ${table}`)).rows));
    assert.ok(beforeRows.slice(0, 3).every((rows, index) => JSON.stringify(rows) === JSON.stringify(afterRows[index])), 'Existing accounts/sessions/jobs/results must remain byte-equivalent.');
    assert.ok(JSON.stringify(afterRows[3]) === JSON.stringify(beforeRows[3]!.map((row) => ({ ...row, pod_uid: null, pod_name: null, pod_namespace: null }))), 'Old registry lease metadata must remain intact with nullable added fields.');
    assert.deepEqual((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((row) => row.version), [...REQUIRED_MIGRATIONS]);
    await pool.query("UPDATE executor_registry SET last_seen_at=clock_timestamp(),expires_at=clock_timestamp()+interval '15 seconds' WHERE instance_id=$1", [oldInstance]);
    assert.equal(await isDatabaseReady(pool), true);
    const repeated = await child(['dist/server/db/migrate.js']); assert.equal(repeated.code, 0); assert.match(repeated.output, /вже застосовані/);
  });

  test('readiness requires the new migration record and actual metadata column shape', async () => {
    assert.equal(await isDatabaseReady(pool), true);
    await pool.query("UPDATE schema_migrations SET version='004_temporarily_missing' WHERE version='004_executor_metadata'");
    try { assert.equal(await isDatabaseReady(pool), false); }
    finally { await pool.query("UPDATE schema_migrations SET version='004_executor_metadata' WHERE version='004_temporarily_missing'"); }
    await pool.query('ALTER TABLE executor_registry RENAME COLUMN pod_uid TO temporarily_missing_uid');
    try { assert.equal(await isDatabaseReady(pool), false); }
    finally { await pool.query('ALTER TABLE executor_registry RENAME COLUMN temporarily_missing_uid TO pod_uid'); }
    assert.equal(await isDatabaseReady(pool), true);
  });

  test('TS and built role CLI promote the explicitly named existing account and repeat idempotently', async () => {
    assert.equal((await pool.query('SELECT role FROM users WHERE id=$1', [accountId])).rows[0].role, 'user');
    const promoted = await child(['--import', 'tsx', 'src/server/admin-role.ts', '--username', username.toUpperCase(), '--role', 'admin']);
    assert.equal(promoted.code, 0); assert.match(promoted.output, /роль admin призначено/);
    assert.equal((await pool.query('SELECT role FROM users WHERE id=$1', [accountId])).rows[0].role, 'admin');
    const repeated = await child(['dist/server/admin-role.js', '--role', 'admin', '--username', username]);
    assert.equal(repeated.code, 0); assert.match(repeated.output, /вже призначена/);
    assert.equal(Number((await pool.query('SELECT count(*) FROM users')).rows[0].count), 1);
  });

  test('unknown or invalid targets never create users; built CLI explicitly demotes its own account', async () => {
    for (const args of [['--username', 'missing_test_account', '--role', 'admin'], ['--username', username, '--role', 'root'],
      ['--username', "x';DROP", '--role', 'admin'], ['--username', username, '--role', 'admin', '--role', 'user']]) {
      const run = await child(['dist/server/admin-role.js', ...args]); assert.equal(run.code, 1);
    }
    assert.equal(Number((await pool.query('SELECT count(*) FROM users')).rows[0].count), 1);
    assert.equal((await pool.query('SELECT role FROM users WHERE id=$1', [accountId])).rows[0].role, 'admin');
    const run = await child(['dist/server/admin-role.js', '--username', username, '--role', 'user']);
    assert.equal(run.code, 0); assert.match(run.output, /роль user призначено/);
    assert.equal((await pool.query('SELECT role FROM users WHERE id=$1', [accountId])).rows[0].role, 'user');
  });

  test('actual heartbeat persists pod/process metadata with the same DB clock and marks shutdown unavailable', async () => {
    const instanceId = randomUUID(); const metadata = { podUid: randomUUID(), podName: 'app-metadata-test', podNamespace: 'courier-route-test-admin' };
    const registry = new ExecutorRegistry(pool, instanceId, { heartbeatIntervalMs: 100, leaseTtlMs: 6300 }, metadata);
    registry.start(() => ({ acceptingClaims: true, busy: true, currentJobId: jobId }), async () => {});
    try {
      assert.equal(await registry.refresh(), true);
      const { rows: [row] } = await pool.query('SELECT instance_id,pod_uid,pod_name,pod_namespace,accepting_claims,busy,current_job_id,last_seen_at<=clock_timestamp() AND expires_at>clock_timestamp() AS fresh FROM executor_registry WHERE instance_id=$1', [instanceId]);
      assert.deepEqual(row, { instance_id: instanceId, pod_uid: metadata.podUid, pod_name: metadata.podName, pod_namespace: metadata.podNamespace, accepting_claims: true, busy: true, current_job_id: jobId, fresh: true });
    } finally { await registry.shutdown(); }
    assert.equal((await pool.query('SELECT accepting_claims FROM executor_registry WHERE instance_id=$1', [instanceId])).rows[0].accepting_claims, false);
  });
});
