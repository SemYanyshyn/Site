import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { JobDetails, JobListResponse } from '../src/shared/jobs.js';
import { JobsRepository } from '../src/server/jobs/repository.js';
import { calculateRoute } from '../src/server/route/algorithm.js';
import { assertSafeTestDatabase } from './database-safety.js';
import { quickRouteInput, routeInput } from './fixtures/route-input.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const harness = fileURLToPath(new URL('./fixtures/jobs-http-harness.ts', import.meta.url));
const migration = fileURLToPath(new URL('../dist/server/db/migrate.js', import.meta.url));
const schema = `courier_test_jobs_${randomUUID().replaceAll('-', '')}`;
const password = 'Окремий тестовий пароль кур’єра 😀';
const origin = 'http://127.0.0.1:5173';
const heavy = () => routeInput(500, 200_000_000, 42);
interface Event {
  type: string;
  jobId?: string;
  instanceId?: string;
  requestId?: string;
  threadId?: number;
  activeWorkers?: number;
  busy?: boolean;
  dispatcherBusy?: boolean;
  status?: string;
  receivedAt: number;
}
interface Managed {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  events: Event[];
}
interface App extends Managed { url: string; instanceId: string }
interface User { id: string; cookie: string }
const children = new Set<Managed>();
let control: pg.Pool | undefined;
let pool: pg.Pool;
let databaseUrl: string;
let schemaCreated = false;
let initialized = false;
let appA: App;
let appB: App;
let users: User[];

function child(args: string[], env: NodeJS.ProcessEnv): Managed {
  const processChild = spawn(process.execPath, args, {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  processChild.stdout?.resume();
  processChild.stderr?.resume();
  const events: Event[] = [];
  processChild.on('message', (value: unknown) => {
    if (typeof value === 'object' && value !== null && 'type' in value) {
      events.push({ ...value, receivedAt: performance.now() } as Event);
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    processChild.once('error', () => resolve({ code: -1, signal: null }));
    processChild.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const result = { child: processChild, closed, events };
  children.add(result);
  return result;
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, NODE_ENV: 'production', PORT: '3000', DATABASE_URL: databaseUrl,
    APP_ORIGINS: origin, SESSION_TTL_SECONDS: '3600', COOKIE_SECURE: 'false',
    ROUTE_MAX_POINTS: '500', ROUTE_MAX_ITERATIONS: '200000000', ROUTE_TIMEOUT_MS: '30000',
    JOBS_MAX_ACTIVE_PER_USER: '3', JOBS_MAX_OUTSTANDING: '4', JOBS_POLL_INTERVAL_MS: '40',
    JOBS_WORKER_LOST_GRACE_MS: '250', ...overrides,
  };
}

async function eventually<T>(probe: () => Promise<T> | T, predicate: (value: T) => boolean,
  message: string, timeoutMs = 10000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await probe();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.fail(message);
}

async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}

async function start(overrides: NodeJS.ProcessEnv = {}): Promise<App> {
  const managed = child(['--import', 'tsx', harness], environment({ PORT: String(await port()), ...overrides }));
  const ready = await eventually(() => managed.events.find((event) => event.type === 'ready'),
    (event) => event !== undefined, 'Built production HTTP harness must start.');
  assert.ok(ready && typeof ready.instanceId === 'string');
  const readyValue = ready as Event & { port: number };
  return Object.assign(managed, { url: `http://127.0.0.1:${readyValue.port}`, instanceId: ready.instanceId });
}

async function command(app: App, type: string): Promise<Event> {
  const requestId = randomUUID();
  assert.ok(app.child.connected, 'Private harness IPC must remain connected.');
  app.child.send({ type, requestId });
  const event = await eventually(() => app.events.find((value) => value.requestId === requestId),
    (value) => value !== undefined, 'Private dispatcher control must acknowledge.');
  assert.ok(event && event.type !== 'harness_error', 'Private dispatcher command failed.');
  return event;
}

async function stop(managed: Managed, signal: NodeJS.Signals = 'SIGTERM', clean = true): Promise<void> {
  if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill(signal);
  const result = await Promise.race([managed.closed, delay(6500, undefined, { ref: false }).then(() => undefined)]);
  if (!result) {
    managed.child.kill('SIGKILL');
    await managed.closed;
    children.delete(managed);
    assert.fail('Temporary production server must stop within 6.5 seconds.');
  }
  children.delete(managed);
  if (clean) assert.equal(result.code, 0, 'Production shutdown must close worker, dispatcher, HTTP and Pool.');
}

async function migrate(): Promise<void> {
  const managed = child([migration], environment());
  // Migration CLI does not use IPC, so do not keep a test-only channel alive.
  managed.child.disconnect();
  const result = await Promise.race([managed.closed, delay(15000, undefined, { ref: false }).then(() => undefined)]);
  assert.ok(result, 'Built migration runner must finish.');
  children.delete(managed);
  assert.equal(result.code, 0, 'Built migration runner must apply SQL successfully.');
}

async function post(app: App, path: string, body: unknown, user?: User,
  options: { raw?: string; contentType?: string; origin?: string } = {}): Promise<Response> {
  return fetch(`${app.url}${path}`, {
    method: 'POST', headers: {
      Origin: options.origin ?? origin, 'Content-Type': options.contentType ?? 'application/json',
      ...(user ? { Cookie: user.cookie } : {}),
    }, body: options.raw ?? JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
}

function get(app: App, path: string, user?: User): Promise<Response> {
  return fetch(`${app.url}${path}`, { headers: user ? { Cookie: user.cookie } : {},
    signal: AbortSignal.timeout(10000) });
}

async function error(response: Response, status: number): Promise<{ code: string; message: string }> {
  assert.equal(response.status, status);
  const value = await response.json() as Record<string, unknown>;
  assert.ok(Object.keys(value).sort().join(',') === 'code,message');
  assert.ok(typeof value.code === 'string' && typeof value.message === 'string' && /[а-яіїєґ]/i.test(value.message));
  assert.ok(!/postgres(?:ql)?:\/\/|password_hash|token_hash|\n\s+at /i.test(String(value.message)));
  return value as { code: string; message: string };
}

async function create(app: App, user = users[0]!, input: unknown = quickRouteInput()): Promise<JobDetails> {
  const response = await post(app, '/api/jobs', input, user);
  assert.equal(response.status, 202, 'Accepted jobs must commit before returning 202.');
  const details = await response.json() as JobDetails;
  assert.equal(response.headers.get('location'), `/api/jobs/${details.id}`);
  assert.equal(details.status, 'queued');
  assert.equal(details.progress.percent, 0);
  assert.ok(!('claimToken' in details) && !('claim_token' in details));
  return details;
}

async function details(app: App, id: string, user = users[0]!): Promise<JobDetails> {
  const response = await get(app, `/api/jobs/${id}`, user);
  assert.equal(response.status, 200);
  return await response.json() as JobDetails;
}

async function terminal(app: App, id: string, user = users[0]!, timeoutMs = 12000): Promise<JobDetails> {
  return eventually(() => details(app, id, user), (value) => !['queued', 'running'].includes(value.status),
    'Accepted job must reach a persisted terminal state.', timeoutMs);
}

async function searching(app: App, id: string, user = users[0]!): Promise<JobDetails> {
  return eventually(() => details(app, id, user), (value) => value.status === 'running' && value.progress.completedIterations > 0,
    'Real worker must enter persisted pending search before observation.');
}

async function registerUser(index: number): Promise<User> {
  const username = `jobs_user_${index}`;
  const response = await post(appA, '/api/auth/register', { username, password });
  assert.equal(response.status, 201);
  const { user } = await response.json() as { user: { id: string } };
  const login = await post(appA, '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.ok(cookie.startsWith('courier_session='));
  return { id: user.id, cookie };
}

function events(app: App, type: string, id: string): Event[] {
  return app.events.filter((value) => value.type === type && value.jobId === id);
}

async function pair(overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  if (appA && children.has(appA)) await stop(appA);
  if (appB && children.has(appB)) await stop(appB);
  await pool.query('DELETE FROM jobs');
  [appA, appB] = await Promise.all([start(overrides), start(overrides)]);
}

describe('Durable PostgreSQL jobs across independent production HTTP processes', { concurrency: false }, () => {
  before(async () => {
    try {
      const target = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
      const testUrl = process.env.TEST_DATABASE_URL;
      assert.ok(testUrl);
      control = new pg.Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
      const connected = await control.query<{ database: string; port: number; address: string; superuser: boolean }>(
        'SELECT current_database() AS database, inet_server_port() AS port, inet_server_addr()::text AS address, rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
      const actual = connected.rows[0];
      const expected = new URL(testUrl);
      assert.ok(actual && actual.database === target.database && actual.port === Number(expected.port || 5432),
        'Actual PostgreSQL host/port/database must match the guarded test target.');
      if (/^(127\.|localhost$|\[::1\]$)/.test(expected.hostname)) {
        assert.ok(actual.address === '::1' || actual.address.startsWith('127.'), 'Loopback target must connect to loopback.');
      }
      assert.equal(actual.superuser, false, 'Test role must not be a PostgreSQL superuser.');
      await control.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      expected.searchParams.set('options', `-c search_path=${schema}`);
      databaseUrl = expected.href;
      pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    } catch {
      throw new Error('Jobs integration setup blocked: guarded separate PostgreSQL test database is required.');
    }
  });

  beforeEach(async () => { if (initialized) await pair(); });

  after(async () => {
    const stopped = await Promise.allSettled([...children].map((value) => stop(value)));
    let failures = stopped.filter((value) => value.status === 'rejected').length;
    try { await pool?.end(); } catch { failures += 1; }
    if (control) {
      try { if (schemaCreated) await control.query(`DROP SCHEMA "${schema}" CASCADE`); } catch { failures += 1; }
      try { await control.end(); } catch { failures += 1; }
    }
    assert.equal(failures, 0, 'All temporary HTTP processes, workers, Pools and random test schemas must be cleaned.');
  });

  test('01: built, repeated and concurrent migrations preserve 001 users and live sessions', async () => {
    appA = await start();
    assert.equal((await get(appA, '/api/health')).status, 200);
    await error(await get(appA, '/api/ready'), 503);
    await stop(appA);
    const sql = await readFile(new URL('../migrations/001_auth.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await pool.query(sql);
    await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)', ['001_auth', checksum]);
    const keptUser = randomUUID();
    const session = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO users(id,username,normalized_username,password_hash) VALUES ($1,'migration_jobs','migration_jobs','unusable_test_hash')", [keptUser]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [createHash('sha256').update(session).digest('hex'), keptUser]);
    appA = await start();
    await error(await get(appA, '/api/ready'), 503);
    await stop(appA);
    await Promise.all([migrate(), migrate()]);
    const applied = await pool.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version');
    assert.deepEqual(applied.rows.map((row) => row.version), ['001_auth', '002_jobs', '003_executor_registry', '004_executor_metadata']);
    assert.equal(applied.rows[0]?.checksum, checksum);
    const builtSql = await readFile(new URL('../dist/migrations/002_jobs.sql', import.meta.url), 'utf8');
    assert.equal(builtSql, await readFile(new URL('../migrations/002_jobs.sql', import.meta.url), 'utf8'));
    await Promise.all([migrate(), migrate()]);
    const repeated = await pool.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version');
    assert.deepEqual(repeated.rows, applied.rows);
    [appA, appB] = await Promise.all([start(), start()]);
    assert.equal((await get(appA, '/api/ready')).status, 200);
    assert.equal((await get(appB, '/api/ready')).status, 200);
    const retained = await get(appB, '/api/auth/me', { id: keptUser, cookie: `courier_session=${session}` });
    assert.equal(retained.status, 200);
    assert.equal(((await retained.json()) as { user: { id: string } }).user.id, keptUser);
    users = [];
    for (let index = 0; index < 4; index += 1) users.push(await registerUser(index));
    initialized = true;
  });

  test('02: all job APIs require sessions; exact Origin, JSON and body limits remain distinct', async () => {
    for (const path of ['/api/jobs', '/api/jobs/limits', `/api/jobs/${randomUUID()}`]) await error(await get(appA, path), 401);
    await error(await post(appA, '/api/jobs', quickRouteInput()), 401);
    await error(await post(appA, `/api/jobs/${randomUUID()}/cancel`, {}), 401);
    await error(await post(appA, '/api/jobs', quickRouteInput(), users[0], { origin: 'http://127.0.0.1:5173.evil.example' }), 403);
    await error(await post(appA, '/api/jobs', quickRouteInput(), users[0], { contentType: 'text/plain' }), 415);
    await error(await post(appA, '/api/jobs', {}, users[0], { raw: '{' }), 400);
    await error(await post(appA, '/api/jobs', {}, users[0], { raw: JSON.stringify({ padding: 'x'.repeat(256 * 1024) }) }), 413);
    await error(await post(appA, '/api/auth/login', {}, undefined, { raw: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }) }), 413);
    assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
  });

  test('03: safe limits and runtime validation reject extra fields and oversized work before INSERT/start', async () => {
    const response = await get(appB, '/api/jobs/limits', users[0]);
    assert.equal(response.status, 200);
    const limits = await response.json() as { route: { maxPoints: number; maxIterations: number; timeoutMs: number }; maxActivePerUser: number };
    assert.equal(limits.route.maxPoints, 500);
    assert.equal(limits.route.maxIterations, 200_000_000);
    assert.equal(limits.route.timeoutMs, 30_000);
    assert.equal(limits.maxActivePerUser, 3);
    assert.ok(!JSON.stringify(limits).match(/claim|postgres|password|token/i));
    for (const key of ['userId', 'status', 'claim', 'claimToken', 'instanceId', 'timeout', 'result']) {
      await error(await post(appA, '/api/jobs', { ...quickRouteInput(), [key]: users[1]!.id }, users[0]), 400);
    }
    for (const input of [routeInput(501), { ...quickRouteInput(), iterations: 200_000_001 },
      { ...quickRouteInput(), points: [] }, { ...quickRouteInput(), warehouse: { x: 1_000_001, y: 0 } }]) {
      await error(await post(appB, '/api/jobs', input, users[0]), 400);
    }
    assert.equal((await pool.query('SELECT id FROM jobs')).rowCount, 0);
    assert.equal([...appA.events, ...appB.events].filter((value) => value.type === 'worker_created').length, 0);
  });

  test('04: ownership, compact stable pagination and validated active queries use persisted rows only', async () => {
    const one = await create(appA);
    const two = await create(appB);
    const foreign = await create(appB, users[1]);
    await pool.query("UPDATE jobs SET created_at='2026-10-23T00:00:00Z'");
    const unknown = randomUUID();
    const denied = await error(await get(appB, `/api/jobs/${one.id}`, users[1]), 404);
    assert.deepEqual(await error(await get(appB, `/api/jobs/${unknown}`, users[1]), 404), denied);
    assert.deepEqual(await error(await post(appB, `/api/jobs/${one.id}/cancel`, {}, users[1]), 404), denied);
    await error(await get(appA, '/api/jobs/not-uuid', users[0]), 400);
    await error(await post(appA, '/api/jobs/not-uuid/cancel', {}, users[0]), 400);
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=1&limit=2', 'offset=-1', 'offset=1000001', 'status=bogus', 'sort=asc']) {
      await error(await get(appA, `/api/jobs?${query}`, users[0]), 400);
    }
    const list = await (await get(appA, '/api/jobs?status=active&limit=1&offset=0', users[0])).json() as JobListResponse;
    const next = await (await get(appB, '/api/jobs?status=active&limit=1&offset=1', users[0])).json() as JobListResponse;
    assert.equal(list.jobs.length, 1);
    assert.equal(next.jobs.length, 1);
    assert.equal(list.limit, 1);
    assert.equal(list.offset, 0);
    assert.ok(list.jobs[0]!.id !== next.jobs[0]!.id);
    assert.deepEqual(new Set([list.jobs[0]!.id, next.jobs[0]!.id]), new Set([one.id, two.id]));
    assert.deepEqual([list.jobs[0]!.id, next.jobs[0]!.id], [one.id, two.id].sort().reverse(),
      'Equal creation timestamps must still use deterministic UUID tie ordering.');
    for (const summary of [...list.jobs, ...next.jobs]) assert.ok(!('input' in summary) && !('result' in summary));
    assert.ok(![...list.jobs, ...next.jobs].some((value) => value.id === foreign.id));
    const repeated = await (await get(appB, '/api/jobs?status=active&limit=1&offset=0', users[0])).json() as JobListResponse;
    assert.equal(repeated.jobs[0]!.id, list.jobs[0]!.id);
    await error(await post(appA, `/api/jobs/${one.id}/cancel`, { extra: true }, users[0]), 400);
  });

  test('05: concurrent A/B admission commits at most the shared per-user active quota', async () => {
    const replies = await Promise.all(Array.from({ length: 10 }, (_, index) => post(index % 2 ? appA : appB, '/api/jobs', quickRouteInput(), users[0])));
    assert.equal(replies.filter((value) => value.status === 202).length, 3);
    const rejected = replies.filter((value) => value.status !== 202);
    const codes = new Set<string>();
    for (const reply of rejected) codes.add((await error(reply, 429)).code);
    assert.equal(codes.size, 1);
    const rows = await pool.query<{ status: string }>('SELECT status FROM jobs WHERE user_id=$1', [users[0]!.id]);
    assert.equal(rows.rowCount, 3);
    assert.ok(rows.rows.every((value) => value.status === 'queued'), 'Paused dispatchers exclude completion from the quota measurement.');
    assert.equal([...appA.events, ...appB.events].filter((value) => value.type === 'started').length, 0);
  });

  test('06: concurrent different users share one atomic global outstanding quota', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, index) => post(index % 2 ? appA : appB, '/api/jobs', quickRouteInput(), users[index % 4])));
    assert.equal(replies.filter((value) => value.status === 202).length, 4);
    const codes = new Set<string>();
    for (const reply of replies.filter((value) => value.status !== 202)) codes.add((await error(reply, 503)).code);
    assert.equal(codes.size, 1);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs WHERE status IN ('queued','running')");
    assert.equal(count.rows[0]?.count, '4');
    assert.equal([...appA.events, ...appB.events].filter((value) => value.type === 'started').length, 0);
  });

  test('07: queued cancel is terminal and never starts a worker; finished history frees quota', async () => {
    const job = await create(appA);
    const cancelled = await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal(cancelled.status, 200);
    const state = await cancelled.json() as JobDetails;
    assert.equal(state.status, 'cancelled');
    assert.ok(state.finishedAt && !state.result);
    const repeated = await post(appA, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as JobDetails).status, 'cancelled');
    await Promise.all([command(appA, 'resume'), command(appB, 'resume')]);
    const next = await create(appA);
    assert.equal((await terminal(appB, next.id)).status, 'completed');
    assert.equal(events(appA, 'started', job.id).length + events(appB, 'started', job.id).length, 0);
    const active = await (await get(appB, '/api/jobs?status=active', users[0])).json() as JobListResponse;
    assert.equal(active.jobs.length, 0);
    const history = await (await get(appB, '/api/jobs', users[0])).json() as JobListResponse;
    assert.equal(history.jobs.length, 2);
  });

  test('08: simultaneous claims start exactly one real worker; normalized seed and completed result persist', async (context) => {
    const input = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 10_000, seed: 0 };
    const job = await create(appA, users[0], input);
    const committed = await pool.query<{ input: { seed: number }; status: string }>('SELECT input,status FROM jobs WHERE id=$1', [job.id]);
    assert.equal(committed.rows[0]?.input.seed, 0);
    assert.equal(committed.rows[0]?.status, 'queued');
    await Promise.all([command(appA, 'resume'), command(appB, 'resume')]);
    const final = await terminal(appB, job.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.result?.length, 4);
    assert.equal(final.result?.seed, 0);
    assert.equal(final.progress.percent, 100);
    assert.ok(final.finishedAt && final.startedAt);
    const claims = events(appA, 'claimed', job.id).length + events(appB, 'claimed', job.id).length;
    const starts = events(appA, 'started', job.id).length + events(appB, 'started', job.id).length;
    assert.equal(claims, 1);
    assert.equal(starts, 1);
    const owner = events(appA, 'started', job.id).length ? appA : appB;
    assert.equal(final.executedBy, owner.instanceId);
    assert.ok(events(owner, 'started', job.id)[0]!.threadId! > 0);
    assert.equal(events(owner, 'worker_exit', job.id)[0]?.threadId, -1);
    const randomSeedInput = { ...quickRouteInput() } as Partial<ReturnType<typeof quickRouteInput>>;
    delete randomSeedInput.seed;
    const next = await create(appA, users[0], randomSeedInput);
    assert.ok(Number.isSafeInteger(next.input.seed) && next.input.seed >= 0 && next.input.seed <= 0xffff_ffff);
    const trivial = await terminal(appB, next.id);
    assert.equal(trivial.result?.terminationReason, 'trivial_input');
    assert.equal(trivial.result?.iterationsCompleted, 0);
    assert.equal(trivial.result?.length, 10);
    context.diagnostic(`Одна задача ${job.id}: claims=${claims}, starts=${starts}; виконавець=${owner.instanceId}; справжній worker завершився з threadId=-1.`);
  });

  test('09: two processes compute real heavy jobs simultaneously, persist monotonic progress and keep HTTP responsive', async (context) => {
    const one = await create(appA, users[0], heavy());
    const two = await create(appB, users[1], heavy());
    await Promise.all([command(appA, 'resume'), command(appB, 'resume')]);
    await searching(appB, one.id);
    await searching(appA, two.id, users[1]);
    assert.notEqual((await details(appA, one.id)).executedBy, (await details(appA, two.id, users[1])).executedBy);
    const snapshotA = await command(appA, 'snapshot');
    const snapshotB = await command(appB, 'snapshot');
    assert.equal(snapshotA.activeWorkers, 1);
    assert.equal(snapshotB.activeWorkers, 1);
    const counts: number[] = [];
    const latencies: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const startedAt = performance.now();
      assert.equal((await get(appB, '/api/health')).status, 200);
      latencies.push(Math.round((performance.now() - startedAt) * 100) / 100);
      const state = await details(appB, one.id);
      assert.equal(state.status, 'running');
      assert.ok(state.progress.percent < 100);
      counts.push(state.progress.completedIterations);
      await delay(75);
    }
    assert.ok(counts.every((value, index) => index === 0 || value >= counts[index - 1]!));
    assert.ok(counts.at(-1)! > counts[0]!);
    for (const app of [appA, appB]) assert.ok(app.events.filter((value) => value.type === 'worker_created').every((value) => value.activeWorkers === 1));
    await post(appB, `/api/jobs/${one.id}/cancel`, {}, users[0]);
    await post(appA, `/api/jobs/${two.id}/cancel`, {}, users[1]);
    await Promise.all([terminal(appA, one.id), terminal(appB, two.id, users[1])]);
    context.diagnostic(`Процеси A=${appA.instanceId}, B=${appB.instanceId}; одночасні jobs=${one.id},${two.id}; max workers/process=1; збережені лічильники=${counts.join(',')}; HTTP ms=${latencies.join(',')}.`);
  });

  test('10: cancellation through B physically stops worker A before cancelled commit and admits the next job', async (context) => {
    const job = await create(appB, users[0], heavy());
    const next = await create(appB);
    await command(appA, 'resume');
    await searching(appB, job.id);
    const response = await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal(response.status, 202);
    const requested = await response.json() as JobDetails;
    assert.equal(requested.status, 'running');
    assert.equal(requested.cancelRequested, true);
    const final = await terminal(appB, job.id);
    assert.equal(final.status, 'cancelled');
    assert.ok(!final.result && final.progress.percent < 100);
    await terminal(appB, next.id);
    const stopped = events(appA, 'worker_stopped', job.id)[0];
    const actualExit = events(appA, 'worker_exit', job.id)[0];
    const settled = events(appA, 'settled', job.id)[0];
    assert.ok(stopped && actualExit && settled);
    assert.equal(actualExit.threadId, -1);
    assert.ok(actualExit.receivedAt <= settled.receivedAt && stopped.receivedAt <= settled.receivedAt);
    assert.equal((await post(appA, `/api/jobs/${job.id}/cancel`, {}, users[0])).status, 200);
    context.diagnostic(`Cancel B → worker A: job=${job.id}, actual exit threadId=${actualExit.threadId}; terminal commit після exit; наступна задача ${next.id} виконана.`);
  });

  test('11: SQL constraints reject inconsistent states and indexes cover queue/history/active/deadline', async () => {
    const job = await create(appA);
    for (const assignment of ["status='unknown'", 'progress_percent=100', 'completed_iterations=9999',
      "result='{}'::jsonb", "finished_at=clock_timestamp()", "progress_stage='searching'"] ) {
      await assert.rejects(pool.query(`UPDATE jobs SET ${assignment} WHERE id=$1`, [job.id]),
        (value: unknown) => typeof value === 'object' && value !== null && 'code' in value && value.code === '23514');
    }
    const indexes = await pool.query<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2', [schema, 'jobs']);
    assert.ok(indexes.rows.some((value) => /WHERE \(status = 'queued'/.test(value.indexdef)));
    assert.ok(indexes.rows.some((value) => /user_id, created_at DESC, id DESC/.test(value.indexdef)));
    assert.ok(indexes.rows.some((value) => /lost_after/.test(value.indexdef)));
  });

  test('12: wrong/stale claims and late progress cannot alter a terminal row or clear accepted cancel', async () => {
    const job = await create(appA, users[0], routeInput(4, 1000, 0));
    const repository = new JobsRepository(pool);
    const claim = await repository.claim(appA.instanceId, 30_000, 250);
    assert.ok(claim && claim.id === job.id);
    const wrong = { ...claim, claimToken: randomUUID() };
    const progress = { stage: 'searching' as const, completedIterations: 500, totalIterations: 1000, percent: 50 };
    assert.equal(await repository.saveProgress(wrong, progress), false);
    assert.equal(await repository.finish(wrong, { status: 'failed', reason: 'worker_error', message: 'Не записувати.' }), false);
    assert.equal(await repository.saveProgress(claim, progress), true);
    const cancel = await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal(cancel.status, 202);
    assert.equal(await repository.saveProgress(claim, { ...progress, completedIterations: 750, percent: 75 }), true);
    assert.equal((await details(appA, job.id)).cancelRequested, true);
    const result = calculateRoute(claim.input);
    assert.equal(await repository.finish(claim, { status: 'completed', result }), true);
    const final = await details(appB, job.id);
    assert.equal(final.status, 'cancelled', 'Accepted cancel must override an in-flight completed proposal.');
    assert.ok(!final.result);
    assert.equal(await repository.saveProgress(claim, { ...progress, completedIterations: 1000, percent: 99.999 }), false);
    assert.equal(await repository.finish(claim, { status: 'completed', result }), false);
    assert.deepEqual(await details(appA, job.id), final);
  });

  test('13: queued claim/cancel and finish/cancel races have one consistent terminal outcome', async () => {
    const repository = new JobsRepository(pool);
    for (let index = 0; index < 5; index += 1) {
      const job = await create(appA);
      const [claim, cancel] = await Promise.all([
        repository.claim(appA.instanceId, 30000, 250), repository.cancel(users[0]!.id, job.id),
      ]);
      assert.ok(cancel);
      if (claim) {
        assert.equal(claim.id, job.id);
        assert.equal(cancel.status, 'running');
        assert.equal(cancel.cancelRequested, true);
        await repository.finish(claim, { status: 'completed', result: calculateRoute(claim.input) });
      }
      assert.equal((await details(appB, job.id)).status, 'cancelled');
    }
    const job = await create(appA);
    const claim = await repository.claim(appA.instanceId, 30000, 250);
    assert.ok(claim);
    const proposed = { status: 'completed' as const, result: calculateRoute(claim.input) };
    const [, response] = await Promise.all([
      repository.finish(claim, proposed), post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]),
    ]);
    const acceptedCancel = await response.json() as JobDetails;
    const final = await details(appA, job.id);
    if (response.status === 202) assert.equal(final.status, 'cancelled');
    else {
      assert.equal(response.status, 200);
      assert.ok(acceptedCancel.status === 'completed' || acceptedCancel.status === 'cancelled');
      assert.equal(final.status, acceptedCancel.status);
    }
    const repeated = await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), final);
  });

  test('14: actual timeout stops the thread, persists failed/timeout and runs the next queued job', async () => {
    await pair({ ROUTE_TIMEOUT_MS: '1000' });
    const job = await create(appA, users[0], heavy());
    const next = await create(appA);
    await command(appA, 'resume');
    await searching(appB, job.id);
    const final = await terminal(appB, job.id);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.reason, 'timeout');
    assert.ok(!final.result && final.progress.percent < 100);
    assert.equal(events(appA, 'worker_exit', job.id)[0]?.threadId, -1);
    assert.equal((await terminal(appB, next.id)).status, 'completed');
    assert.equal((await get(appA, '/api/health')).status, 200);
  });

  test('15: controlled actual worker crash persists worker_error; HTTP and the shared slot recover', async () => {
    const job = await create(appA);
    const next = await create(appB);
    await command(appA, 'crash_next');
    await command(appA, 'resume');
    const failed = await terminal(appB, job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.reason, 'worker_error');
    assert.equal(events(appA, 'worker_exit', job.id)[0]?.threadId, -1);
    assert.equal((await terminal(appB, next.id)).status, 'completed');
    assert.equal((await get(appA, '/api/health')).status, 200);
  });

  test('16: SQL unavailability returns 503, physically stops active work and recovers queued work', async () => {
    const job = await create(appA, users[0], heavy());
    const next = await create(appA);
    await command(appA, 'resume');
    await searching(appB, job.id);
    let renamed = false;
    try {
      // Failure is scoped to this random test schema. No PostgreSQL cluster,
      // working database, role or other test schema is stopped or changed.
      await pool.query('ALTER TABLE jobs RENAME TO jobs_unavailable');
      renamed = true;
      assert.equal((await get(appB, '/api/health')).status, 200);
      await error(await get(appB, '/api/ready'), 503);
      await error(await get(appB, '/api/jobs', users[0]), 503);
      await error(await post(appB, '/api/jobs', quickRouteInput(), users[0]), 503);
      await eventually(() => events(appA, 'worker_exit', job.id)[0], (event) => event?.threadId === -1,
        'Coordinator must physically terminate its worker when SQL control fails.');
      const snapshot = await command(appA, 'snapshot');
      assert.equal(snapshot.activeWorkers, 0);
      assert.equal(snapshot.dispatcherBusy, true, 'Claim reservation must remain until terminal persistence recovers.');
    } finally {
      if (renamed) await pool.query('ALTER TABLE jobs_unavailable RENAME TO jobs');
    }
    const final = await terminal(appB, job.id);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.reason, 'database_unavailable');
    assert.ok(!final.result);
    assert.equal((await terminal(appB, next.id)).status, 'completed');
    assert.equal((await get(appA, '/api/ready')).status, 200);
  });

  test('17: unavailable PostgreSQL endpoint keeps liveness but returns 503 for readiness and dependent API', async () => {
    const inaccessible = new URL(databaseUrl);
    inaccessible.port = '1';
    const app = await start({ DATABASE_URL: inaccessible.href });
    try {
      assert.equal((await get(app, '/api/health')).status, 200);
      await error(await get(app, '/api/ready'), 503);
      await error(await get(app, '/api/jobs', users[0]), 503);
      await error(await get(app, `/api/jobs/${randomUUID()}`, users[0]), 503);
      await error(await post(app, '/api/jobs', quickRouteInput(), users[0]), 503);
    } finally { await stop(app); }
  });

  test('18: forced process death becomes worker_lost only after deadline and never restarts that job', async (context) => {
    await pair({ ROUTE_TIMEOUT_MS: '2500' });
    const lost = await create(appA, users[0], heavy());
    await command(appA, 'resume');
    await searching(appB, lost.id);
    const deadline = await pool.query<{ lost_after: Date; started_at: Date; timeout_ms: number }>('SELECT lost_after,started_at,timeout_ms FROM jobs WHERE id=$1', [lost.id]);
    assert.ok(deadline.rows[0]);
    await stop(appA, 'SIGKILL', false);
    const stillRunning = await details(appB, lost.id);
    assert.equal(stillRunning.status, 'running');
    // This is test observation of the recorded production deadline, with no
    // sleep or artificial slowdown in the route algorithm itself.
    await delay(Math.max(0, deadline.rows[0].lost_after.getTime() - Date.now() - 1200));
    const alive = await create(appB, users[1], heavy());
    await command(appB, 'resume');
    await searching(appB, alive.id, users[1]);
    const final = await terminal(appB, lost.id);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.reason, 'worker_lost');
    assert.ok(Date.parse(final.finishedAt!) >= deadline.rows[0].lost_after.getTime());
    assert.equal((await details(appB, alive.id, users[1])).status, 'running', 'An unexpired live job on B must not be called lost.');
    assert.equal(events(appB, 'claimed', lost.id).length + events(appB, 'started', lost.id).length, 0);
    assert.equal(events(appA, 'started', lost.id).length, 1);
    await post(appB, `/api/jobs/${alive.id}/cancel`, {}, users[1]);
    await terminal(appB, alive.id, users[1]);
    const stored = deadline.rows[0];
    assert.equal(stored.timeout_ms, 2500);
    const effectiveGrace = stored.lost_after.getTime() - stored.started_at.getTime() - stored.timeout_ms;
    assert.ok(effectiveGrace >= 21_080, 'Persisted recovery must cover polling and bounded database work, not only the small configured grace.');
    context.diagnostic(`SIGKILL A=${appA.instanceId}, lost job=${lost.id}; збережений deadline timeout=${stored.timeout_ms}ms + effective grace≈${effectiveGrace}ms; B=${appB.instanceId} відновив worker_lost, не повторив start; жива ${alive.id} залишалась running.`);
  });

  test('19: completed history, normalized input, progress, result and live session survive full HTTP restart', async () => {
    const job = await create(appA, users[0], routeInput(20, 100000, 0));
    await command(appA, 'resume');
    const saved = await terminal(appB, job.id);
    assert.equal(saved.status, 'completed');
    const previousA = appA.instanceId;
    const previousB = appB.instanceId;
    await Promise.all([stop(appA), stop(appB)]);
    [appA, appB] = await Promise.all([start(), start()]);
    assert.notEqual(appA.instanceId, previousA);
    assert.notEqual(appB.instanceId, previousB);
    assert.equal((await get(appB, '/api/auth/me', users[0])).status, 200);
    assert.deepEqual(await details(appA, job.id), saved);
    assert.deepEqual(await details(appB, job.id), saved);
    const history = await (await get(appB, '/api/jobs', users[0])).json() as JobListResponse;
    assert.equal(history.jobs[0]?.id, job.id);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test(`20/${signal}: active shutdown stops worker/dispatcher/HTTP/Pool and persists its honest cause`, async (context) => {
      const job = await create(appA, users[0], heavy());
      await command(appA, 'resume');
      await searching(appB, job.id);
      if (signal === 'SIGTERM') {
        const cancellation = await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
        assert.equal(cancellation.status, 202);
      }
      const startTime = performance.now();
      await stop(appA, signal);
      const elapsed = performance.now() - startTime;
      assert.ok(elapsed < 5000);
      const final = await terminal(appB, job.id);
      if (signal === 'SIGINT') {
        assert.equal(final.status, 'failed');
        assert.equal(final.error?.reason, 'server_shutdown');
      } else assert.equal(final.status, 'cancelled');
      assert.equal(events(appA, 'worker_exit', job.id)[0]?.threadId, -1);
      const stopped = appA.events.find((event) => event.type === 'stopped');
      assert.ok(stopped && stopped.activeWorkers === 0 && stopped.busy === false);
      await assert.rejects(fetch(`${appA.url}/api/health`, { signal: AbortSignal.timeout(300) }));
      context.diagnostic(`${signal}: actual worker exit, HTTP/dispatcher/Pool stop ${elapsed.toFixed(2)}ms; persisted ${final.status}${final.error ? `/${final.error.reason}` : ''}.`);
    });
  }

  test('21: disconnecting an accepted HTTP client does not cancel its durable real computation', async () => {
    await command(appA, 'resume');
    const body = JSON.stringify(routeInput(300, 100_000_000, 0));
    const id = await new Promise<string>((resolve, reject) => {
      let accepted = false;
      const outgoing = httpRequest(`${appB.url}/api/jobs`, { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json', Cookie: users[0]!.cookie,
        'Content-Length': String(Buffer.byteLength(body)), Connection: 'close',
      } }, (incoming) => {
        if (incoming.statusCode !== 202 || !incoming.headers.location) {
          incoming.resume();
          reject(new Error('Durable job must be accepted before client disconnection.'));
          return;
        }
        accepted = true;
        resolve(incoming.headers.location.split('/').at(-1)!);
        incoming.destroy();
        outgoing.destroy();
      });
      outgoing.on('error', () => { if (!accepted) reject(new Error('Acceptance request failed before commit.')); });
      outgoing.end(body);
    });
    const pending = await details(appB, id);
    assert.ok(pending.status === 'queued' || pending.status === 'running');
    const final = await terminal(appB, id);
    assert.equal(final.status, 'completed');
    assert.equal(final.result?.iterationsCompleted, 100_000_000);
    assert.equal(final.cancelRequested, false);
    assert.equal(events(appA, 'started', id).length, 1);
  });

  test('22: unavailable terminal SQL during shutdown stays bounded and is recovered by worker_lost', async (context) => {
    await pair({ ROUTE_TIMEOUT_MS: '2000' });
    const job = await create(appA, users[0], heavy());
    await command(appA, 'resume');
    await searching(appB, job.id);
    const deadline = await pool.query<{ lost_after: Date; started_at: Date; timeout_ms: number }>('SELECT lost_after,started_at,timeout_ms FROM jobs WHERE id=$1', [job.id]);
    assert.ok(deadline.rows[0]);
    let renamed = false;
    let elapsed = 0;
    try {
      await pool.query('ALTER TABLE jobs RENAME TO jobs_unavailable');
      renamed = true;
      const startedAt = performance.now();
      await stop(appA, 'SIGTERM');
      elapsed = performance.now() - startedAt;
      assert.ok(elapsed < 5000);
      assert.equal(events(appA, 'worker_exit', job.id)[0]?.threadId, -1);
    } finally {
      if (renamed) await pool.query('ALTER TABLE jobs_unavailable RENAME TO jobs');
    }
    const final = await terminal(appB, job.id, users[0], 25000);
    assert.equal(final.status, 'failed');
    assert.equal(final.error?.reason, 'worker_lost', 'A failed shutdown write must retain a deadline-recoverable running row.');
    assert.ok(Date.parse(final.finishedAt!) >= deadline.rows[0].lost_after.getTime());
    assert.equal(events(appB, 'started', job.id).length, 0);
    const stored = deadline.rows[0];
    assert.equal(stored.timeout_ms, 2000);
    const effectiveGrace = stored.lost_after.getTime() - stored.started_at.getTime() - stored.timeout_ms;
    assert.ok(effectiveGrace >= 21_080, 'Shutdown recovery must retain its actual polling and database safety allowance.');
    context.diagnostic(`SIGTERM за відмови SQL: ${elapsed.toFixed(2)}ms, actual worker exit; відновлений через timeout=${stored.timeout_ms}ms + effective grace≈${effectiveGrace}ms як worker_lost без повторного start.`);
  });

  test('23: blocked progress storage keeps only one SQL write in flight while HTTP remains available', async () => {
    const job = await create(appA, users[0], heavy());
    await command(appA, 'resume');
    await searching(appB, job.id);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE', [job.id]);
      const writes = async (): Promise<number> => {
        const state = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND datname=current_database() AND application_name='courier-route'
            AND state='active' AND query LIKE '%UPDATE jobs SET progress_stage%'`);
        return Number(state.rows[0]?.count);
      };
      assert.equal(await eventually(writes, (count) => count > 0, 'Real progress SQL must wait on the held test row lock.'), 1);
      for (let index = 0; index < 4; index += 1) {
        await delay(100);
        assert.equal(await writes(), 1, 'Progress callbacks must replace their pending snapshot rather than launch more SQL.');
        assert.equal((await get(appB, '/api/health')).status, 200);
        const snapshot = await details(appB, job.id);
        assert.equal(snapshot.status, 'running');
        assert.ok(snapshot.progress.percent < 100);
      }
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    await post(appB, `/api/jobs/${job.id}/cancel`, {}, users[0]);
    assert.equal((await terminal(appB, job.id)).status, 'cancelled');
  });
});
