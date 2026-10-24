import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AdminJobsResponse, AdminOverview } from '../src/shared/admin.js';
import { readQueueSnapshot } from '../src/server/jobs/queue-snapshot.js';
import { assertSafeTestDatabase } from './database-safety.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = `courier_test_admin_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(24).toString('base64url');
const origin = 'http://127.0.0.1:5173';
interface Managed { child: ChildProcess; closed: Promise<number | null> }
interface App extends Managed { url: string; instanceId: string }
interface Account { id: string; username: string; cookie: string }
const children = new Set<Managed>();
let control: pg.Pool | undefined;
let pool: pg.Pool;
let schemaCreated = false;
let databaseUrl: string;
let appA: App;
let appB: App;
let admin: Account;
let user: Account;
const fixtureIds: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
function launch(args: string[], overrides: NodeJS.ProcessEnv = {}, ipc = false): Managed {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl,
    ADMIN_KUBERNETES_ENABLED: 'false', NODE_ENV: 'production', HOST: '127.0.0.1', APP_ORIGINS: origin,
    COOKIE_SECURE: 'false', SESSION_TTL_SECONDS: '3600', ...overrides },
  stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  child.stdout?.resume(); child.stderr?.resume();
  const closed = new Promise<number | null>((resolve) => { child.once('error', () => resolve(-1)); child.once('exit', resolve); });
  const managed = { child, closed }; children.add(managed); return managed;
}
async function run(args: string[]): Promise<void> {
  const managed = launch(args); const result = await Promise.race([managed.closed, delay(15_000, -2, { ref: false })]);
  assert.equal(result, 0, 'Own operator subprocess must finish successfully.'); children.delete(managed);
}
async function start(extra: NodeJS.ProcessEnv = {}): Promise<App> {
  const port = await freePort();
  const managed = launch(['--import', 'tsx', 'tests/fixtures/jobs-http-harness.ts'], { PORT: String(port), ...extra }, true);
  const info = await new Promise<{ port: number; instanceId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Admin HTTP fixture did not start.')), 12_000);
    managed.child.on('message', (value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'ready' && 'port' in value && 'instanceId' in value) {
        clearTimeout(timer); resolve(value as { port: number; instanceId: string });
      }
    });
  });
  return Object.assign(managed, { url: `http://127.0.0.1:${info.port}`, instanceId: info.instanceId });
}
async function stop(managed: Managed): Promise<void> {
  if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill('SIGTERM');
  const result = await Promise.race([managed.closed.then((code) => ({ code })), delay(7_000, null, { ref: false })]);
  if (!result) { managed.child.kill('SIGKILL'); await managed.closed; assert.fail('Admin fixture exceeded bounded shutdown.'); }
  children.delete(managed); assert.equal(result.code, 0);
}
function get(app: App, path: string, account?: Account, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.url}${path}`, { headers: { ...(account ? { Cookie: account.cookie } : {}), ...extra }, signal: AbortSignal.timeout(10_000) });
}
function post(app: App, path: string, body: unknown, account?: Account): Promise<Response> {
  return fetch(`${app.url}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    ...(account ? { Cookie: account.cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}
async function account(username: string): Promise<Account> {
  const spoof = await post(appA, '/api/auth/register', { username, password, role: 'admin' });
  assert.equal(spoof.status, 400, 'Unknown public role input must be rejected without creating an administrator.');
  const registration = await post(appA, '/api/auth/register', { username, password });
  assert.equal(registration.status, 201);
  const value = await registration.json() as { user: { id: string; role: string } }; assert.equal(value.user.role, 'user');
  const login = await post(appB, '/api/auth/login', { username, password }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  return { id: value.user.id, username, cookie };
}
function noPrivate(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(/(?:password|hash|cookie|token|secret|credential|^claim$|^input$|^result$|^env$)/i.test(key), false,
      'Admin projection must never include private fields.'); noPrivate(child);
  }
}

describe('Real PostgreSQL admin reads and fresh roles across independent HTTP handlers', { concurrency: false }, () => {
  before(async () => {
    const safe = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const value = process.env.TEST_DATABASE_URL; assert.ok(value);
    control = new pg.Pool({ connectionString: value, max: 2, connectionTimeoutMillis: 2000, query_timeout: 3000 });
    const row = (await control.query<{ database: string; port: number; host: string; superuser: boolean }>(`SELECT current_database() AS database,
      inet_server_port() AS port, inet_server_addr()::text AS host, rolsuper AS superuser FROM pg_roles WHERE rolname=current_user`)).rows[0];
    const url = new URL(value);
    assert.ok(row && row.database === safe.database && row.port === Number(url.port || 5432));
    if (/^(127\.|localhost$|\[::1\]$)/.test(url.hostname)) assert.ok(row.host === '::1' || row.host.startsWith('127.'));
    assert.equal(row.superuser, false);
    await control.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    url.searchParams.set('options', `-c search_path=${schema}`); databaseUrl = url.href;
    const actualPool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 2000, query_timeout: 3000, statement_timeout: 2500 });
    // PostgreSQL constraint details can include a complete row. Test failures
    // must not print stored session hashes or arbitrary auth data.
    pool = new Proxy(actualPool, { get(target, key, receiver) {
      if (key === 'query') return async (...args: unknown[]) => {
        try { return await Reflect.apply(target.query, target, args); }
        catch { throw new Error('Не вдалося виконати SQL тестової admin-фікстури; приватні деталі приховано.'); }
      };
      return Reflect.get(target, key, receiver);
    } });
    await run(['dist/server/db/migrate.js']);
    [appA, appB] = await Promise.all([start(), start()]);
    [admin, user] = await Promise.all([account('admin_fixture'), account('normal_fixture')]);
    await run(['dist/server/admin-role.js', '--username', admin.username, '--role', 'admin']);
  });
  after(async () => {
    const cleanup = await Promise.allSettled([...children].map(stop));
    await pool?.end(); if (schemaCreated) await control?.query(`DROP SCHEMA "${schema}" CASCADE`); await control?.end();
    assert.ok(cleanup.every((result) => result.status === 'fulfilled'), 'All own HTTP/worker/pool/IPC resources must stop.');
  });

  test('every endpoint gates current persisted role before shared reads; registration/header/query cannot elevate', async () => {
    assert.notEqual(appA.instanceId, appB.instanceId);
    for (const app of [appA, appB]) {
      for (const path of ['/api/admin/overview', '/api/admin/jobs']) {
        const anonymous = await get(app, path); assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('cache-control'), 'no-store'); noPrivate(await anonymous.json());
        const denied = await get(app, path, user, { 'X-Role': 'admin', 'X-Admin': 'true' });
        assert.equal(denied.status, 403); assert.equal(denied.headers.get('cache-control'), 'no-store'); noPrivate(await denied.json());
        const allowed = await get(app, path, admin); assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('x-instance-id'), app.instanceId);
        assert.equal(allowed.headers.get('cache-control'), 'no-store'); noPrivate(await allowed.json());
      }
      assert.equal((await get(app, '/api/admin/overview?role=admin', user)).status, 403);
    }
  });

  test('same-time jobs have stable pages/counts, both owners, strict filters and safe scalar-only projection', async () => {
    const stamp = new Date('2026-01-02T03:04:05Z');
    for (let index = 0; index < 25; index++) {
      const id = randomUUID(); fixtureIds.push(id);
      await pool.query(`INSERT INTO jobs(id,user_id,input,total_iterations,status,created_at,finished_at,cancel_requested_at)
        VALUES($1,$2,$3,1,'cancelled',$4,$4,$4)`, [id, index % 2 ? admin.id : user.id,
        { warehouse: { x: 0, y: 0 }, points: [{ x: 11, y: 12 }], iterations: 1, seed: 0 }, stamp]);
    }
    const a = await (await get(appA, '/api/admin/jobs?limit=20', admin)).json() as AdminJobsResponse;
    const b = await (await get(appB, '/api/admin/jobs?limit=20&offset=20', admin)).json() as AdminJobsResponse;
    assert.equal(a.total, 25); assert.equal(b.total, 25); assert.equal(a.jobs.length, 20); assert.equal(b.jobs.length, 5);
    const ids = [...a.jobs, ...b.jobs].map((job) => job.id);
    assert.deepEqual(ids, [...fixtureIds].sort().reverse()); assert.equal(new Set(ids).size, 25);
    assert.equal(new Set(a.jobs.map((job) => job.owner.id)).size, 2); noPrivate(a); noPrivate(b);
    const again = await (await get(appB, '/api/admin/jobs?limit=20', admin)).json() as AdminJobsResponse;
    assert.deepEqual(again.jobs, a.jobs);
    assert.equal((await (await get(appA, '/api/admin/jobs?status=active', admin)).json() as AdminJobsResponse).total, 0);
    assert.equal((await (await get(appA, `/api/jobs/${fixtureIds[0]}`, admin)).json() as { code: string }).code, 'JOB_NOT_FOUND');
    for (const query of ['limit=51', 'limit=1&limit=2', 'offset=-1', 'limit=1e2', 'status=nope', 'executedBy=oops', 'namespace=other']) {
      const response = await get(appA, `/api/admin/jobs?${query}`, admin); assert.equal(response.status, 400); noPrivate(await response.json());
    }
  });

  test('monitoring ignores admission lock, count/page share one MVCC snapshot and host metrics remain unknown', async () => {
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN; SELECT pg_advisory_xact_lock(18024,4)');
      const began = performance.now(); const response = await get(appA, '/api/admin/overview', admin); assert.equal(response.status, 200);
      const body = await response.json() as AdminOverview;
      assert.ok(performance.now() - began < 1500, 'Read must not wait on job admission.');
      assert.equal(body.database.counts.cancelled, 25); assert.equal(body.infrastructure.kubernetes.status, 'disabled');
      assert.equal(body.summary.pods, null); assert.equal(body.summary.cpuCores, null); assert.equal(body.summary.memoryBytes, null);
      noPrivate(body);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });

  test('same-pod restart leases contribute one ETA slot and committed old running stays busy until real terminal', async () => {
    const podUid = randomUUID(), old = randomUUID(), current = randomUUID(), target = randomUUID(), running = randomUUID();
    await pool.query(`INSERT INTO executor_registry(instance_id,started_at,last_seen_at,expires_at,accepting_claims,busy,pod_uid,pod_name,pod_namespace)
      VALUES($1,clock_timestamp()-interval '2 seconds',clock_timestamp(),clock_timestamp()+interval '30 seconds',true,false,$3,'app-test','test-ns'),
      ($2,clock_timestamp()-interval '1 second',clock_timestamp(),clock_timestamp()+interval '30 seconds',true,false,$3,'app-test','test-ns')`, [old, current, podUid]);
    const input = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 1 }], iterations: 100, seed: 0 };
    await pool.query('INSERT INTO jobs(id,user_id,input,total_iterations) VALUES($1,$2,$3,100)', [target, admin.id, input]);
    await pool.query(`INSERT INTO jobs(id,user_id,input,total_iterations,status,progress_stage,completed_iterations,progress_percent,
      started_at,instance_id,claim_token,timeout_ms,lost_after,cancel_requested_at)
      VALUES($1,$2,$3,100,'running','searching',10,10,clock_timestamp(),$4,$5,30000,clock_timestamp()+interval '90 seconds',clock_timestamp())`,
    [running, admin.id, input, old, randomUUID()]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const stamp = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      const queue = await readQueueSnapshot(client, target, stamp.toISOString(), 30000); assert.equal(queue.executorCount, 1);
      await client.query('COMMIT');
    } finally { client.release(); }
    const body = await (await get(appA, '/api/admin/overview', admin)).json() as AdminOverview;
    assert.equal(body.database.queueExecutorCount, 1);
    assert.ok(body.unmatchedExecutors.find((entry) => entry.instanceId === old)?.busy);
    assert.equal((await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [running])).rows[0]!.status, 'running');
    await pool.query('DELETE FROM jobs WHERE id=ANY($1::uuid[])', [[target, running]]);
    await pool.query('DELETE FROM executor_registry WHERE instance_id=ANY($1::uuid[])', [[old, current]]);
  });

  test('warm snapshot never bypasses cross-handler role demotion; promotion, logout and expiry use the same cookie authority', async () => {
    assert.equal((await get(appA, '/api/admin/overview', admin)).status, 200);
    assert.equal((await get(appB, '/api/admin/overview', admin)).status, 200);
    await run(['dist/server/admin-role.js', '--username', admin.username, '--role', 'user']);
    for (const app of [appA, appB]) for (const path of ['/api/admin/overview', '/api/admin/jobs']) assert.equal((await get(app, path, admin)).status, 403);
    await run(['dist/server/admin-role.js', '--username', admin.username, '--role', 'admin']);
    assert.equal((await get(appB, '/api/admin/jobs', admin)).status, 200);
    assert.equal((await post(appB, '/api/auth/logout', {}, admin)).status, 204);
    assert.equal((await get(appA, '/api/admin/jobs', admin)).status, 401);
    const login = await post(appA, '/api/auth/login', { username: admin.username, password });
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); admin.cookie = cookie;
    await pool.query('UPDATE sessions SET created_at=clock_timestamp()-interval \'2 seconds\', expires_at=clock_timestamp()-interval \'1 second\' WHERE user_id=$1', [admin.id]);
    assert.equal((await get(appB, '/api/admin/overview', admin)).status, 401);
  });

  test('persisted history survives actual HTTP restart and authenticated DB errors produce safe 503', async () => {
    const login = await post(appA, '/api/auth/login', { username: admin.username, password });
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); admin.cookie = cookie;
    await stop(appB); appB = await start();
    assert.equal((await (await get(appB, '/api/admin/jobs', admin)).json() as AdminJobsResponse).total, 25);
    const wrong = new URL(databaseUrl); wrong.port = String(await freePort());
    const down = await start({ DATABASE_URL: wrong.href });
    try {
      const began = performance.now(); const response = await get(down, '/api/admin/overview', admin);
      assert.equal(response.status, 503); assert.ok(performance.now() - began < 8000); noPrivate(await response.json());
      assert.equal((await get(down, '/api/health')).status, 200);
    } finally { await stop(down); }
  });
});
