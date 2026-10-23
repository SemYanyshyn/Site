import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { JobDetails } from '../src/shared/jobs.js';
import type { RouteInput } from '../src/shared/route.js';
import { calculateRoute } from '../src/server/route/algorithm.js';
import { readQueueSnapshot } from '../src/server/jobs/queue-snapshot.js';
import { assertSafeTestDatabase } from './database-safety.js';
import { quickRouteInput, routeInput } from './fixtures/route-input.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const harness = fileURLToPath(new URL('./fixtures/jobs-http-harness.ts', import.meta.url));
const migration = fileURLToPath(new URL('../dist/server/db/migrate.js', import.meta.url));
const schema = `courier_test_queue_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://127.0.0.1:5173';
const password = randomBytes(24).toString('base64url');
interface Event { type: string; jobId?: string; instanceId?: string; requestId?: string; port?: number;
  threadId?: number; activeWorkers?: number; receivedAt: number }
interface Managed { child: ChildProcess; closed: Promise<number | null>; events: Event[] }
interface App extends Managed { url: string; instanceId: string }
interface User { id: string; cookie: string }
interface RegistryRow { instance_id: string; accepting_claims: boolean; busy: boolean; current_job_id: string | null;
  fresh: boolean; age_ms: number; started_at: Date; last_seen_at: Date; expires_at: Date }
const children = new Set<Managed>();
let control: pg.Pool | undefined;
let pool: pg.Pool;
let databaseUrl: string;
let schemaCreated = false;
let initialized = false;
let appA: App;
let appB: App;
let users: User[] = [];

async function eventually<T>(probe: () => Promise<T> | T, predicate: (value: T) => boolean, description: string, timeout = 12_000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await probe();
    if (predicate(value)) return value;
    await delay(20);
  }
  assert.fail(description);
}
async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'production', PORT: '3000', APP_ORIGINS: origin,
    COOKIE_SECURE: 'false', SESSION_TTL_SECONDS: '3600', ROUTE_MAX_POINTS: '500', ROUTE_MAX_ITERATIONS: '200000000',
    ROUTE_TIMEOUT_MS: '30000', JOBS_MAX_ACTIVE_PER_USER: '3', JOBS_MAX_OUTSTANDING: '100', JOBS_POLL_INTERVAL_MS: '40',
    EXECUTOR_HEARTBEAT_INTERVAL_MS: '100', EXECUTOR_LEASE_TTL_MS: '6300', ...overrides };
}
function launch(args: string[], overrides: NodeJS.ProcessEnv = {}, ipc = true): Managed {
  const child = spawn(process.execPath, args, { cwd: root, env: environment(overrides),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  child.stdout?.resume();
  child.stderr?.resume();
  const events: Event[] = [];
  child.on('message', (value: unknown) => {
    if (value && typeof value === 'object' && 'type' in value) events.push({ ...value, receivedAt: performance.now() } as Event);
  });
  const closed = new Promise<number | null>((resolve) => { child.once('error', () => resolve(-1)); child.once('exit', resolve); });
  const managed = { child, closed, events };
  children.add(managed);
  return managed;
}
async function start(overrides: NodeJS.ProcessEnv = {}): Promise<App> {
  const managed = launch(['--import', 'tsx', harness], { PORT: String(await port()), ...overrides });
  const ready = await eventually(() => managed.events.find((event) => event.type === 'ready'), Boolean, 'Production queue harness must start.');
  assert.ok(ready?.port && ready.instanceId);
  return Object.assign(managed, { url: `http://127.0.0.1:${ready.port}`, instanceId: ready.instanceId });
}
async function command(app: App, type: string): Promise<void> {
  const requestId = randomUUID();
  app.child.send({ type, requestId });
  const result = await eventually(() => app.events.find((event) => event.requestId === requestId), Boolean, 'Private IPC must acknowledge.');
  assert.ok(result && result.type !== 'harness_error');
}
async function stop(managed: Managed, signal: NodeJS.Signals = 'SIGTERM', clean = true): Promise<void> {
  if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill(signal);
  const result = await Promise.race([managed.closed.then((code) => ({ code })), delay(6500, null, { ref: false })]);
  if (!result) { managed.child.kill('SIGKILL'); await managed.closed; assert.fail('Temporary process exceeded bounded shutdown.'); }
  children.delete(managed);
  if (clean) assert.equal(result.code, 0, 'Worker, heartbeat, dispatcher, HTTP and Pool must close cleanly.');
}
async function migrate(): Promise<void> {
  const managed = launch([migration], {}, false);
  const result = await Promise.race([managed.closed, delay(15_000, -2, { ref: false })]);
  assert.equal(result, 0, 'Built migration runner must complete successfully.');
  children.delete(managed);
}
function get(app: App, path: string, user?: User): Promise<Response> {
  return fetch(`${app.url}${path}`, { headers: user ? { Cookie: user.cookie } : {}, signal: AbortSignal.timeout(10_000) });
}
function post(app: App, path: string, body: unknown, user?: User): Promise<Response> {
  return fetch(`${app.url}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    ...(user ? { Cookie: user.cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
}
async function details(app: App, id: string, user = users[0]!): Promise<JobDetails> {
  const response = await get(app, `/api/jobs/${id}`, user);
  assert.equal(response.status, 200);
  return await response.json() as JobDetails;
}
async function create(app: App, input: RouteInput = quickRouteInput(), user = users[0]!): Promise<JobDetails> {
  const response = await post(app, '/api/jobs', input, user);
  assert.equal(response.status, 202);
  const value = await response.json() as JobDetails;
  assert.equal(value.status, 'queued');
  return value;
}
async function searching(app: App, id: string, user = users[0]!): Promise<JobDetails> {
  return eventually(() => details(app, id, user), (value) => value.status === 'running' && value.progress.completedIterations > 0,
    'A real worker must enter persisted search.');
}
async function terminal(app: App, id: string, user = users[0]!, timeout = 12_000): Promise<JobDetails> {
  return eventually(() => details(app, id, user), (value) => !['queued', 'running'].includes(value.status), 'Job must become terminal.', timeout);
}
async function cancel(app: App, id: string, user = users[0]!): Promise<JobDetails> {
  const response = await post(app, `/api/jobs/${id}/cancel`, {}, user);
  assert.ok([200, 202].includes(response.status));
  return await response.json() as JobDetails;
}
async function registry(): Promise<RegistryRow[]> {
  return (await pool.query<RegistryRow>(`SELECT instance_id,accepting_claims,busy,current_job_id,started_at,last_seen_at,expires_at,
    expires_at>clock_timestamp() AS fresh,extract(epoch FROM (clock_timestamp()-last_seen_at))*1000 AS age_ms FROM executor_registry`)).rows;
}
async function register(index: number): Promise<User> {
  const username = `queue_user_${index}`;
  const registered = await post(appA, '/api/auth/register', { username, password });
  assert.equal(registered.status, 201);
  const value = await registered.json() as { user: { id: string } };
  const login = await post(appA, '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { id: value.user.id, cookie };
}
async function pair(overrides: NodeJS.ProcessEnv = {}): Promise<void> {
  for (const child of [...children]) await stop(child);
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM executor_registry');
  [appA, appB] = await Promise.all([start(overrides), start(overrides)]);
  await eventually(registry, (rows) => rows.length === 2 && rows.every((row) => row.fresh), 'Both real processes must register.');
}
function jobEvents(type: string, id: string): Event[] {
  return [appA, appB].flatMap((app) => app.events.filter((event) => event.type === type && event.jobId === id));
}
function queueOf(job: JobDetails) {
  assert.equal(job.status, 'queued');
  assert.ok(job.queue);
  assert.ok(Number.isFinite(Date.parse(job.queue.calculatedAt)));
  return job.queue;
}

describe('Shared real executor capacity and queued ETA across independent processes', { concurrency: false }, () => {
  before(async () => {
    const target = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const value = process.env.TEST_DATABASE_URL;
    assert.ok(value);
    control = new pg.Pool({ connectionString: value, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    const { rows: [actual] } = await control.query<{ database: string; port: number; address: string; superuser: boolean }>(
      'SELECT current_database() AS database,inet_server_port() AS port,inet_server_addr()::text AS address,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
    const expected = new URL(value);
    assert.ok(actual && actual.database === target.database && actual.port === Number(expected.port || 5432));
    if (/^(127\.|localhost$|\[::1\]$)/.test(expected.hostname)) assert.ok(actual.address === '::1' || actual.address.startsWith('127.'));
    assert.equal(actual.superuser, false);
    await control.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    expected.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = expected.href;
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  });
  beforeEach(async () => { if (initialized) await pair(); });
  after(async () => {
    const stopped = await Promise.allSettled([...children].map((child) => stop(child)));
    let failed = stopped.filter((result) => result.status === 'rejected').length;
    try { await pool?.end(); } catch { failed++; }
    try { if (schemaCreated) await control?.query(`DROP SCHEMA "${schema}" CASCADE`); } catch { failed++; }
    try { await control?.end(); } catch { failed++; }
    assert.equal(failed, 0, 'All own processes, workers, registry timers, pools and random schema must be cleaned.');
  });

  test('01: 001→002→003 preserves an existing account/session/job/result and repeated concurrent migrations', async () => {
    for (const version of ['001_auth', '002_jobs']) {
      const sql = await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), 'utf8');
      if (version === '001_auth') await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, createHash('sha256').update(sql).digest('hex')]);
    }
    const userId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const input = { ...quickRouteInput(), seed: 0 };
    const result = calculateRoute(input);
    const jobId = randomUUID();
    await pool.query("INSERT INTO users(id,username,normalized_username,password_hash) VALUES($1,'queue_migration','queue_migration','unusable_fixture_hash')", [userId]);
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [createHash('sha256').update(token).digest('hex'), userId]);
    await pool.query(`INSERT INTO jobs(id,user_id,input,status,progress_stage,completed_iterations,total_iterations,progress_percent,
      started_at,finished_at,instance_id,claim_token,timeout_ms,lost_after,result) VALUES($1,$2,$3,'completed','finishing',$4,$4,100,
      now()-interval '2 seconds',now()-interval '1 second',$5,$6,30000,now()+interval '1 minute',$7)`,
    [jobId, userId, input, input.iterations, randomUUID(), randomUUID(), result]);
    appA = await start();
    assert.equal((await get(appA, '/api/ready')).status, 503);
    await stop(appA);
    await Promise.all([migrate(), migrate()]);
    const versions = await pool.query<{ version: string; checksum: string }>('SELECT version,checksum FROM schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map((row) => row.version), ['001_auth', '002_jobs', '003_executor_registry']);
    assert.equal(await readFile(new URL('../dist/migrations/003_executor_registry.sql', import.meta.url), 'utf8'),
      await readFile(new URL('../migrations/003_executor_registry.sql', import.meta.url), 'utf8'));
    await Promise.all([migrate(), migrate()]);
    assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows, versions.rows);
    [appA, appB] = await Promise.all([start(), start()]);
    const retained = { id: userId, cookie: `courier_session=${token}` };
    assert.equal((await get(appB, '/api/auth/me', retained)).status, 200);
    const kept = await details(appB, jobId, retained);
    assert.deepEqual(kept.input, input);
    assert.deepEqual(kept.result, result);
    assert.equal(kept.queue, undefined);
    assert.equal((await get(appA, '/api/ready')).status, 200);
    for (let index = 0; index < 4; index++) users.push(await register(index));
    initialized = true;
  });

  test('02: two actual paused processes are fresh but supply no ETA capacity; queued remains accepted', async () => {
    assert.notEqual(appA.instanceId, appB.instanceId);
    const rows = await registry();
    assert.deepEqual(new Set(rows.map((row) => row.instance_id)), new Set([appA.instanceId, appB.instanceId]));
    assert.ok(rows.every((row) => row.fresh && !row.accepting_claims && !row.busy && row.current_job_id === null));
    const job = await create(appA);
    for (const app of [appA, appB]) {
      const detail = await details(app, job.id);
      const queue = queueOf(detail);
      assert.equal(queue.executorCount, 0);
      assert.equal(queue.estimatedWaitMs, null);
      assert.equal(queue.basis, 'unavailable');
    }
    assert.equal(jobEvents('worker_created', job.id).length, 0);
    assert.equal((await get(appA, '/api/health')).status, 200);
    assert.equal((await get(appA, '/api/ready')).status, 200);
  });

  test('03: resume/pause and graceful stop update real accepting capacity without reviving stopping leases', async () => {
    await command(appA, 'resume');
    await command(appB, 'resume');
    await eventually(registry, (rows) => rows.filter((row) => row.fresh && row.accepting_claims).length === 2, 'Resume must expose two actual slots.');
    await command(appB, 'pause');
    await eventually(registry, (rows) => rows.find((row) => row.instance_id === appB.instanceId)?.accepting_claims === false, 'Pause removes future capacity.');
    const started = performance.now();
    await stop(appA);
    assert.ok(performance.now() - started < 5000);
    const stopped = (await registry()).find((row) => row.instance_id === appA.instanceId);
    assert.ok(!stopped || !stopped.accepting_claims);
    await command(appB, 'tick');
    assert.ok((await registry()).every((row) => !row.accepting_claims));
  });

  test('04: two real busy workers admit third queued with finite A/B ETA; physical cancel starts it exactly once', async (t) => {
    await command(appA, 'resume');
    const first = await create(appA, routeInput(500, 200_000_000, 42));
    const firstRunning = await searching(appB, first.id);
    await command(appB, 'resume');
    const second = await create(appB, routeInput(500, 200_000_000, 43));
    const secondRunning = await searching(appA, second.id);
    assert.notEqual(firstRunning.executedBy, secondRunning.executedBy);
    assert.deepEqual(new Set([firstRunning.executedBy, secondRunning.executedBy]), new Set([appA.instanceId, appB.instanceId]));
    await eventually(registry, (rows) => rows.filter((row) => row.fresh && row.accepting_claims && row.busy
      && (row.current_job_id === first.id || row.current_job_id === second.id)).length === 2,
    'PostgreSQL must confirm two actual fresh busy slots and the correct current job IDs.');
    const third = await create(appA, routeInput(500, 200_000_000, 44), users[1]);
    const predictions = [];
    for (const app of [appA, appB, appA]) {
      const value = await details(app, third.id, users[1]);
      const queue = queueOf(value);
      assert.equal(queue.executorCount, 2);
      assert.equal(queue.queuedAhead, 0);
      assert.ok(queue.estimatedWaitMs !== null && Number.isSafeInteger(queue.estimatedWaitMs) && queue.estimatedWaitMs > 0);
      predictions.push({ ...queue });
      assert.equal(jobEvents('worker_created', third.id).length, 0);
    }
    assert.equal((await get(appB, '/api/health')).status, 200);
    const cancellation = await cancel(appB, first.id);
    assert.equal(cancellation.status, 'running');
    assert.equal(cancellation.cancelRequested, true);
    await terminal(appA, first.id);
    const started = await searching(appB, third.id, users[1]);
    assert.equal(started.queue, undefined);
    assert.equal(jobEvents('worker_created', third.id).length, 1);
    assert.equal(jobEvents('claimed', third.id).length, 1);
    const stopped = jobEvents('worker_exit', first.id)[0];
    const began = jobEvents('started', third.id)[0];
    assert.ok(stopped && began && stopped.threadId === -1 && stopped.receivedAt <= began.receivedAt);
    assert.ok(started.startedAt);
    t.diagnostic(JSON.stringify({ scenario: 'two_busy_cancel_release', instances: [appA.instanceId, appB.instanceId],
      jobs: [first.id, second.id, third.id], predictions: predictions.map((value) => ({ ...value,
        actualRemainingWaitMs: Date.parse(started.startedAt!) - Date.parse(value.calculatedAt) })),
      actualQueueWaitMs: Date.parse(started.startedAt) - Date.parse(started.createdAt) }));
    await cancel(appA, second.id);
    await cancel(appA, third.id, users[1]);
    await Promise.all([terminal(appA, second.id), terminal(appA, third.id, users[1])]);
  });

  test('05: foreign queued predecessors affect only aggregates and cancellation changes queuedAhead without leakage', async () => {
    await command(appA, 'resume');
    await command(appB, 'resume');
    const first = await create(appA, routeInput(500, 200_000_000, 45));
    const second = await create(appB, routeInput(500, 200_000_000, 46));
    await Promise.all([searching(appA, first.id), searching(appB, second.id)]);
    const foreignInput = { ...routeInput(100, 1_000_000, 42), warehouse: { x: 789123.125, y: -456789.75 } };
    const predecessor = await create(appA, foreignInput, users[1]);
    const target = await create(appB, quickRouteInput(), users[2]);
    const own = await details(appA, target.id, users[2]);
    assert.equal(queueOf(own).queuedAhead, 1);
    const serialized = JSON.stringify(own);
    for (const privateValue of [predecessor.id, users[1]!.id, '789123.125', '-456789.75', 'claim_token', 'claimToken', 'last_seen_at', 'accepting_claims']) assert.ok(!serialized.includes(privateValue));
    assert.equal((await get(appA, `/api/jobs/${predecessor.id}`, users[2])).status, 404);
    assert.equal((await post(appB, `/api/jobs/${predecessor.id}/cancel`, {}, users[2])).status, 404);
    assert.equal((await cancel(appB, predecessor.id, users[1])).status, 'cancelled');
    assert.equal(queueOf(await details(appB, target.id, users[2])).queuedAhead, 0);
    await cancel(appA, first.id);
    await cancel(appB, second.id);
    await terminal(appA, target.id, users[2]);
  });

  test('06: natural worker completion yields measured samples and several honest predicted/actual queue waits', async (t) => {
    await command(appA, 'resume');
    await command(appB, 'resume');
    const heavyA = await create(appA, routeInput(500, 200_000_000, 42));
    const heavyB = await create(appB, routeInput(500, 200_000_000, 43));
    await Promise.all([searching(appA, heavyA.id), searching(appB, heavyB.id)]);
    const target = await create(appA, routeInput(100, 1_000_000, 44), users[1]);
    const estimates = [];
    for (let index = 0; index < 3; index++) {
      const value = queueOf(await details(index % 2 ? appA : appB, target.id, users[1]));
      estimates.push({ ...value });
      // Test observation interval only; production algorithm has no delay.
      await delay(100);
    }
    const completed = await terminal(appB, target.id, users[1], 18_000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.queue, undefined);
    assert.ok(completed.startedAt);
    t.diagnostic(JSON.stringify({ scenario: 'natural_completion', predictions: estimates.map((value) => ({ ...value,
      actualRemainingWaitMs: Date.parse(completed.startedAt!) - Date.parse(value.calculatedAt) })),
      actualQueueWaitMs: Date.parse(completed.startedAt) - Date.parse(completed.createdAt) }));
    await terminal(appA, heavyA.id);
    await terminal(appB, heavyB.id);
    await command(appA, 'pause');
    await command(appB, 'pause');
    const waiting = await create(appA, routeInput(500, 1_000_000, 45));
    assert.equal(queueOf(await details(appA, waiting.id)).basis, 'unavailable');
  });

  test('07: many competing detail reads remain internally coherent through claim and never duplicate worker start', async () => {
    const waiting = await create(appA, routeInput(500, 50_000_000, 42));
    await command(appA, 'resume');
    await command(appB, 'resume');
    const replies = await Promise.all(Array.from({ length: 30 }, (_, index) => details(index % 2 ? appA : appB, waiting.id)));
    for (const reply of replies) {
      if (reply.status === 'queued') assert.ok(reply.queue);
      else assert.equal(reply.queue, undefined);
    }
    await terminal(appA, waiting.id);
    assert.equal(jobEvents('claimed', waiting.id).length, 1);
    assert.equal(jobEvents('worker_created', waiting.id).length, 1);
  });

  test('08: registry SQL loss fails API predictably, stops real worker and restores registration before next claim', async () => {
    await command(appA, 'resume');
    const active = await create(appA, routeInput(500, 200_000_000, 42));
    await searching(appB, active.id);
    const waiting = await create(appB, quickRouteInput(), users[1]);
    await pool.query('ALTER TABLE executor_registry RENAME TO executor_registry_unavailable');
    try {
      const failed = await get(appB, `/api/jobs/${waiting.id}`, users[1]);
      assert.equal(failed.status, 503);
      assert.equal((await get(appA, '/api/health')).status, 200);
      assert.equal((await get(appA, '/api/ready')).status, 503);
      await eventually(() => jobEvents('worker_exit', active.id), (events) => events.some((event) => event.threadId === -1), 'Registry SQL failure must stop its physical worker.');
      assert.equal(jobEvents('worker_created', waiting.id).length, 0);
    } finally { await pool.query('ALTER TABLE executor_registry_unavailable RENAME TO executor_registry'); }
    const stopped = await terminal(appB, active.id);
    assert.equal(stopped.status, 'failed');
    assert.equal(stopped.error?.reason, 'database_unavailable');
    await eventually(registry, (rows) => rows.some((row) => row.instance_id === appA.instanceId && row.accepting_claims && row.fresh && Number(row.age_ms) < 1000), 'Actual heartbeat must recover.');
    assert.equal((await terminal(appA, waiting.id, users[1])).status, 'completed');
  });

  test('09: SIGKILL capacity expires by real TTL while the orphan waits its separate persisted lost_after', async (t) => {
    await stop(appA);
    appA = await start({ ROUTE_TIMEOUT_MS: '1500' });
    await command(appA, 'resume');
    const active = await create(appA, routeInput(500, 200_000_000, 42));
    await searching(appB, active.id);
    const waiting = await create(appB, quickRouteInput(), users[1]);
    const oldId = appA.instanceId;
    const killedAt = performance.now();
    await stop(appA, 'SIGKILL', false);
    await eventually(registry, (rows) => rows.find((row) => row.instance_id === oldId)?.fresh === false, 'A killed executor must expire by its genuine DB lease TTL.', 9000);
    const stillRunning = await details(appB, active.id);
    assert.equal(stillRunning.status, 'running', 'Lease expiry must not shorten persisted job recovery grace.');
    const noCapacity = queueOf(await details(appB, waiting.id, users[1]));
    assert.equal(noCapacity.executorCount, 0);
    assert.equal(noCapacity.estimatedWaitMs, null);
    appA = await start();
    assert.notEqual(appA.instanceId, oldId);
    await command(appA, 'resume');
    assert.equal((await terminal(appB, waiting.id, users[1])).status, 'completed');
    const recovered = await terminal(appB, active.id, users[0], 25_000);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error?.reason, 'worker_lost');
    assert.equal(appA.events.filter((event) => event.type === 'started' && event.jobId === active.id).length, 0);
    t.diagnostic(JSON.stringify({ scenario: 'lease_vs_lost_after', expiredInstance: oldId, replacementInstance: appA.instanceId,
      elapsedUntilRecoveryMs: Math.round(performance.now() - killedAt) }));
  });

  test('10: blocked real heartbeat SQL never overlaps and a late update cannot revive graceful stopping', async () => {
    await command(appA, 'resume');
    await command(appB, 'resume');
    const lock = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE executor_registry IN ACCESS EXCLUSIVE MODE');
      const blocked = () => pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='courier-route' AND wait_event_type='Lock'
          AND query ILIKE '%executor_registry%'`);
      await eventually(blocked, (result) => Number(result.rows[0]?.count) === 2,
        'Exactly one real heartbeat query from each process must wait for the registry lock.');
      await delay(350);
      assert.equal(Number((await blocked()).rows[0]?.count), 2, 'Further heartbeat intervals must not issue overlapping SQL.');
      assert.equal((await get(appB, '/api/health')).status, 200);
      const closing = stop(appA);
      await delay(100);
      await lock.query('COMMIT');
      await closing;
      const stopped = (await registry()).find((row) => row.instance_id === appA.instanceId);
      assert.ok(!stopped || !stopped.accepting_claims, 'A heartbeat issued before shutdown must not publish ready afterwards.');
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }
  });

  test('11: snapshot reads all fifty-one predecessors using four scalar SQL reads without the admission lock', async (t) => {
    await pair({ JOBS_MAX_ACTIVE_PER_USER: '100' });
    for (let index = 0; index < 51; index++) await create(index % 2 ? appA : appB);
    const target = await create(appA);
    const lock = await pool.connect();
    const reader = await pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock($1,$2)', [18024, 4]);
      const started = performance.now();
      const detail = await details(appB, target.id);
      assert.equal(queueOf(detail).queuedAhead, 51);
      assert.ok(performance.now() - started < 1500, 'Reading an ETA must not wait for the held admission lock.');
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows: [time] } = await reader.query<{ calculated_at: Date }>('SELECT clock_timestamp() AS calculated_at');
      assert.ok(time);
      const statements: string[] = [];
      const observed = new Proxy(reader, {
        get(targetClient, property, receiver) {
          if (property === 'query') return (...args: unknown[]) => {
            const first = args[0];
            const text = typeof first === 'string' ? first
              : first && typeof first === 'object' && 'text' in first && typeof first.text === 'string' ? first.text : '';
            statements.push(text);
            return Reflect.apply(targetClient.query, targetClient, args);
          };
          return Reflect.get(targetClient, property, receiver);
        },
      });
      const value = await readQueueSnapshot(observed, target.id, time.calculated_at.toISOString(), 30_000);
      assert.equal(value.queuedAhead, 51);
      assert.equal(statements.length, 4, 'Snapshot SQL count must remain constant rather than N+1 per predecessor.');
      assert.ok(statements.every((statement) => /\bLIMIT\b/u.test(statement)));
      assert.ok(statements.filter((statement) => /FROM jobs/u.test(statement)).every((statement) => /jsonb_array_length/u.test(statement)));
      assert.ok(statements.every((statement) => !/SELECT\s+(?:j\.)?input\b/u.test(statement)));
      await reader.query('COMMIT');
      t.diagnostic(`actual_scalar_snapshot_queries=${statements.length}; queued_predecessors=${value.queuedAhead}`);
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await lock.query('ROLLBACK').catch(() => undefined);
      reader.release();
      lock.release();
    }
  });

  test('12: actual nontrivial occupied-slot duration trains the same-size queued work model', async (t) => {
    await command(appA, 'resume');
    const training = await create(appA, routeInput(500, 5_000_000, 42));
    const completed = await terminal(appA, training.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.terminationReason, 'budget_exhausted');
    const measured = await pool.query<{ duration_ms: string }>('SELECT (extract(epoch FROM(finished_at-started_at))*1000)::text AS duration_ms FROM jobs WHERE id=$1', [training.id]);
    assert.ok(Number(measured.rows[0]?.duration_ms) > 0);
    const active = await create(appA, routeInput(500, 200_000_000, 43));
    await searching(appB, active.id);
    const predecessor = await create(appB, routeInput(500, 1_000_000, 44), users[1]);
    const target = await create(appB, quickRouteInput(), users[2]);
    const queue = queueOf(await details(appB, target.id, users[2]));
    assert.equal(queue.queuedAhead, 1);
    assert.equal(queue.basis, 'measured', 'The same-size predecessor must use an actual completed slot-duration sample rather than timeout fallback.');
    assert.ok(queue.estimatedWaitMs !== null && Number.isFinite(queue.estimatedWaitMs));
    t.diagnostic(JSON.stringify({ scenario: 'learned_from_real_completed', sampleSlotDurationMs: Number(measured.rows[0]?.duration_ms), queue }));
    await cancel(appA, active.id);
    await Promise.all([terminal(appB, predecessor.id, users[1]), terminal(appB, target.id, users[2])]);
  });
});
