import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { PublicUser } from '../src/shared/auth.js';
import { assertSafeTestDatabase } from './database-safety.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serverFile = fileURLToPath(new URL('../dist/server/index.js', import.meta.url));
const migrationFile = fileURLToPath(new URL('../dist/server/db/migrate.js', import.meta.url));
const schema = `courier_test_${randomUUID().replaceAll('-', '')}`;
const fixturePassword = 'Тестовий пароль для кур’єра 😀';
let viteOrigin: string;
let vitePort: number;

interface ManagedProcess {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  group: boolean;
}

interface RunningServer extends ManagedProcess {
  origin: string;
  instanceId: string;
}

const processes = new Set<ManagedProcess>();
let controlPool: pg.Pool | undefined;
let pool: pg.Pool;
let isolatedDatabaseUrl: string;
let schemaCreated = false;
let appA: RunningServer;
let appB: RunningServer;
let portA: number;
let portB: number;
let allowedOrigins: string;

function manage(command: string, args: string[], env: NodeJS.ProcessEnv, group = false, cwd = projectRoot): ManagedProcess {
  const child = spawn(command, args, {
    cwd, env, detached: group, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Drain logs without printing request bodies, credentials or token values on failures.
  child.stdout?.resume();
  child.stderr?.resume();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', () => resolve({ code: -1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const managed = { child, closed, group };
  processes.add(managed);
  return managed;
}

async function stop(managed: ManagedProcess, requireCleanExit = false): Promise<void> {
  if (managed.child.exitCode === null && managed.child.signalCode === null) {
    try {
      if (managed.group && managed.child.pid) process.kill(-managed.child.pid, 'SIGTERM');
      else managed.child.kill('SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const result = await Promise.race([managed.closed, delay(7000, undefined, { ref: false }).then(() => undefined)]);
  if (!result) {
    if (managed.group && managed.child.pid) process.kill(-managed.child.pid, 'SIGKILL');
    else managed.child.kill('SIGKILL');
    await managed.closed;
    assert.fail('Temporary process did not stop within seven seconds.');
  }
  processes.delete(managed);
  if (requireCleanExit) assert.equal(result.code, 0, 'HTTP server must gracefully close HTTP and its database pool.');
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function appEnvironment(port: number, databaseUrl = isolatedDatabaseUrl, secure = false): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    APP_ORIGINS: allowedOrigins,
    SESSION_TTL_SECONDS: '3600',
    COOKIE_SECURE: String(secure),
  };
}

async function waitForHttp(origin: string, managed: ManagedProcess): Promise<Response> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    assert.ok(managed.child.exitCode === null && managed.child.signalCode === null,
      'Temporary server exited before its health endpoint became available.');
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response;
    } catch {
      // Startup polling does not introduce an application delay or fake progress.
    }
    await delay(50);
  }
  assert.fail('Temporary server did not become available within twelve seconds.');
}

async function startServer(port: number, databaseUrl = isolatedDatabaseUrl, secure = false, cwd = projectRoot): Promise<RunningServer> {
  const managed = manage(process.execPath, [serverFile], appEnvironment(port, databaseUrl, secure), false, cwd);
  const origin = `http://127.0.0.1:${port}`;
  const response = await waitForHttp(origin, managed);
  const body = await response.json() as Record<string, unknown>;
  assert.ok(body.status === 'ok' && typeof body.instanceId === 'string', 'Health must keep the block 1 contract.');
  return Object.assign(managed, { origin, instanceId: body.instanceId });
}

async function runMigration(): Promise<void> {
  const managed = manage(process.execPath, [migrationFile], appEnvironment(portA));
  const result = await Promise.race([managed.closed, delay(15000, undefined, { ref: false }).then(() => undefined)]);
  assert.ok(result, 'Migration runner must finish within fifteen seconds.');
  processes.delete(managed);
  assert.equal(result.code, 0, 'Migration runner must finish successfully against the isolated real test schema.');
}

interface RequestOptions {
  cookie?: string;
  origin?: string | null;
  contentType?: string;
  rawBody?: string;
}

async function post(origin: string, path: string, body: unknown = {}, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  headers.set('Content-Type', options.contentType ?? 'application/json');
  const requestOrigin = options.origin === undefined ? `http://127.0.0.1:${portA}` : options.origin;
  if (requestOrigin !== null) headers.set('Origin', requestOrigin);
  if (options.cookie) headers.set('Cookie', options.cookie);
  return fetch(`${origin}${path}`, {
    method: 'POST', headers, body: options.rawBody ?? JSON.stringify(body), signal: AbortSignal.timeout(12000),
  });
}

function me(origin: string, cookie?: string): Promise<Response> {
  return fetch(`${origin}/api/auth/me`, {
    headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(8000),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'Successful login must issue an HttpOnly session cookie.');
  const cookie = header.split(';')[0];
  assert.ok(cookie && cookie.startsWith('courier_session='), 'Session cookie must use the configured name.');
  return cookie;
}

function tokenFrom(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

function tokenHash(cookie: string): string {
  return createHash('sha256').update(tokenFrom(cookie)).digest('hex');
}

async function userFrom(response: Response, expectedStatus: number): Promise<PublicUser> {
  assert.equal(response.status, expectedStatus);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['user'], 'Public response must not expose session or password material.');
  assert.ok(typeof body.user === 'object' && body.user !== null);
  const user = body.user as Record<string, unknown>;
  assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'id', 'role', 'username']);
  assert.ok(typeof user.id === 'string' && /^[0-9a-f-]{36}$/i.test(user.id));
  assert.ok(typeof user.username === 'string');
  assert.equal(user.role, 'user', 'Public registration must always assign the user role.');
  assert.ok(typeof user.createdAt === 'string' && Number.isFinite(Date.parse(user.createdAt)));
  return user as unknown as PublicUser;
}

async function errorFrom(response: Response, expectedStatus: number): Promise<{ code: string; message: string }> {
  assert.equal(response.status, expectedStatus);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.ok(typeof body.code === 'string' && body.code.length > 0);
  assert.ok(typeof body.message === 'string' && /[а-яіїєґ]/i.test(body.message));
  assert.ok(!/postgres(?:ql)?:\/\/|password_hash|token_hash|\n\s+at /i.test(body.message),
    'Public errors must not expose connection strings, hashes or stack traces.');
  return body as { code: string; message: string };
}

async function login(origin = appA.origin, cookie?: string, username = 'block_user', password = fixturePassword): Promise<Response> {
  return post(origin, '/api/auth/login', { username, password }, cookie ? { cookie } : {});
}

describe('PostgreSQL authentication across independent HTTP processes', { concurrency: false }, () => {
  before(async () => {
    const target = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
    const testUrl = process.env.TEST_DATABASE_URL;
    assert.ok(testUrl);
    controlPool = new pg.Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    const identity = await controlPool.query<{ database: string; superuser: boolean }>(
      'SELECT current_database() AS database, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(identity.rows[0]?.database, target.database, 'Connected database must match the validated test database.');
    assert.equal(identity.rows[0]?.superuser, false, 'Application/test connections must use a dedicated non-superuser role.');
    await controlPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const url = new URL(testUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    isolatedDatabaseUrl = url.href;
    pool = new pg.Pool({ connectionString: isolatedDatabaseUrl, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
    portA = await unusedPort();
    do { portB = await unusedPort(); } while (portB === portA);
    do { vitePort = await unusedPort(); } while (vitePort === portA || vitePort === portB);
    viteOrigin = `http://127.0.0.1:${vitePort}`;
    allowedOrigins = [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`, viteOrigin].join(',');
  });

  after(async () => {
    let cleanupFailures = 0;
    const stopped = await Promise.allSettled([...processes].map((managed) =>
      stop(managed, managed === appA || managed === appB)));
    cleanupFailures += stopped.filter(({ status }) => status === 'rejected').length;
    if (pool) {
      try { await pool.end(); } catch { cleanupFailures += 1; }
    }
    if (controlPool) {
      // Only the generated schema in the validated, explicitly named test database is removed.
      try {
        if (schemaCreated) await controlPool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } catch {
        cleanupFailures += 1;
      } finally {
        try { await controlPool.end(); } catch { cleanupFailures += 1; }
      }
    }
    // Finish all cleanup before failing, and keep raw pg/child errors out of TAP output.
    assert.equal(cleanupFailures, 0, 'Temporary servers must exit cleanly and all test resources must be released.');
  });

  test('01: readiness rejects an empty schema; clean, repeated and concurrent migrations preserve data', async () => {
    const unprepared = await startServer(portA);
    await errorFrom(await fetch(`${unprepared.origin}/api/ready`), 503);
    await stop(unprepared, true);
    await Promise.all([runMigration(), runMigration()]);
    const versions = await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    assert.ok(versions.rowCount && versions.rowCount >= 1, 'Migration versions must be recorded.');
    assert.equal(new Set(versions.rows.map(({ version }) => version)).size, versions.rowCount);
    assert.ok(versions.rows.every(({ checksum }) => /^[0-9a-f]{64}$/.test(checksum)));
    const tables = await pool.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema],
    );
    for (const name of ['users', 'sessions', 'jobs', 'executor_registry', 'schema_migrations']) {
      assert.ok(tables.rows.some(({ table_name }) => table_name === name), `Migration must create ${name}.`);
    }
    appA = await startServer(portA);
    appB = await startServer(portB, isolatedDatabaseUrl, false, tmpdir());
    const sentinel = await userFrom(await post(appA.origin, '/api/auth/register', {
      username: 'migration_kept', password: fixturePassword,
    }), 201);
    await Promise.all([runMigration(), runMigration()]);
    const retained = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [sentinel.id]);
    assert.equal(retained.rows[0]?.id, sentinel.id, 'Rerunning migrations must preserve registered users.');
    const repeated = await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations ORDER BY version');
    assert.deepEqual(repeated.rows, versions.rows, 'Repeated and concurrent runners must not duplicate versions.');
    assert.equal((await fetch(`${appA.origin}/api/ready`)).status, 200);
    assert.equal((await fetch(`${appB.origin}/api/ready`)).status, 200);
  });

  test('02: registration stores scrypt, no automatic session, and concurrent case variants cannot duplicate users', async () => {
    const response = await post(appA.origin, '/api/auth/register', { username: '  BLOCK_User  ', password: fixturePassword });
    const user = await userFrom(response, 201);
    assert.equal(user.username, 'block_user');
    assert.ok(response.headers.get('set-cookie') === null, 'Registration must not log in automatically.');
    assert.equal((await me(appA.origin)).status, 401);
    const stored = await pool.query<{ password_hash: string; normalized_username: string; role: string }>(
      'SELECT password_hash, normalized_username, role FROM users WHERE id = $1', [user.id],
    );
    const row = stored.rows[0];
    assert.ok(row);
    assert.ok(row.password_hash.startsWith('scrypt$v1$') && !row.password_hash.includes(fixturePassword),
      'Database must contain an scrypt hash, never the plaintext password.');
    assert.equal(row.normalized_username, 'block_user');
    assert.equal(row.role, 'user');
    const simultaneous = await Promise.all(['Race_User', 'rACE_uSER'].map((username) =>
      post(appA.origin, '/api/auth/register', { username, password: fixturePassword })));
    assert.deepEqual(simultaneous.map(({ status }) => status).sort(), [201, 409]);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text FROM users WHERE normalized_username = 'race_user'");
    assert.equal(count.rows[0]?.count, '1');
    const rejected = simultaneous.find(({ status }) => status === 409);
    assert.ok(rejected);
    await errorFrom(rejected, 409);
  });

  test('03: valid credentials log in; wrong password and unknown username return the same 401 without sessions', async () => {
    const valid = await login(appA.origin, undefined, '  BLOCK_USER  ');
    await userFrom(valid, 200);
    cookieFrom(valid);
    const beforeCount = await pool.query<{ count: string }>('SELECT count(*)::text FROM sessions');
    const wrong = await login(appA.origin, undefined, 'block_user', `${fixturePassword}x`);
    const missing = await login(appA.origin, undefined, 'unknown_user');
    const wrongError = await errorFrom(wrong, 401);
    const missingError = await errorFrom(missing, 401);
    assert.deepEqual(wrongError, missingError, 'Authentication failure must not disclose whether a username exists.');
    assert.ok(wrong.headers.get('set-cookie') === null, 'Wrong-password response must not issue a cookie.');
    assert.ok(missing.headers.get('set-cookie') === null, 'Unknown-user response must not issue a cookie.');
    const afterCount = await pool.query<{ count: string }>('SELECT count(*)::text FROM sessions');
    assert.equal(afterCount.rows[0]?.count, beforeCount.rows[0]?.count);
  });

  test('04: missing, forged and expired sessions return 401 and current-user responses are not cached', async () => {
    await errorFrom(await me(appA.origin), 401);
    await errorFrom(await me(appA.origin, `courier_session=${randomBytes(32).toString('base64url')}`), 401);
    const response = await login();
    const cookie = cookieFrom(response);
    const valid = await me(appA.origin, cookie);
    await userFrom(valid, 200);
    assert.match(valid.headers.get('cache-control') ?? '', /no-store/);
    await pool.query(
      "UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE token_hash = $1",
      [tokenHash(cookie)],
    );
    await errorFrom(await me(appA.origin, cookie), 401);
  });

  test('05: a saved account and live session survive a complete HTTP-process restart', async () => {
    const response = await login();
    const user = await userFrom(response, 200);
    const cookie = cookieFrom(response);
    const previousId = appA.instanceId;
    await stop(appA, true);
    appA = await startServer(portA);
    assert.notEqual(appA.instanceId, previousId);
    const restored = await userFrom(await me(appA.origin, cookie), 200);
    assert.equal(restored.id, user.id);
    await userFrom(await login(), 200);
  });

  test('06: login A → current user B → logout B → unauthorized A proves shared PostgreSQL sessions', async (context) => {
    assert.notEqual(appA.child.pid, appB.child.pid);
    assert.notEqual(appA.instanceId, appB.instanceId);
    const response = await login();
    const userA = await userFrom(response, 200);
    const cookie = cookieFrom(response);
    const userB = await userFrom(await me(appB.origin, cookie), 200);
    assert.equal(userB.id, userA.id);
    const logout = await post(appB.origin, '/api/auth/logout', {}, { cookie });
    assert.equal(logout.status, 204);
    await errorFrom(await me(appA.origin, cookie), 401);
    context.diagnostic(`Процеси A=${appA.instanceId}, B=${appB.instanceId}: вхід A → /me B 200 → вихід B 204 → /me A 401.`);
  });

  test('07: successful re-login rotates the token and revokes the supplied old session; only hashes are persisted', async () => {
    const initial = await login();
    const oldCookie = cookieFrom(initial);
    const renewed = await login(appA.origin, oldCookie);
    await userFrom(renewed, 200);
    const newCookie = cookieFrom(renewed);
    assert.ok(newCookie !== oldCookie, 'A successful login must issue a different random token.');
    assert.ok(Buffer.from(tokenFrom(newCookie), 'base64url').length >= 32, 'Session tokens need at least 32 random bytes.');
    await errorFrom(await me(appA.origin, oldCookie), 401);
    await userFrom(await me(appA.origin, newCookie), 200);
    const stored = await pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE token_hash = ANY($1::text[])', [[tokenHash(oldCookie), tokenHash(newCookie)]],
    );
    assert.equal(stored.rowCount, 1);
    assert.ok(stored.rows[0]?.token_hash === tokenHash(newCookie), 'Only the SHA-256 hash of the current token may remain.');
    assert.ok(stored.rows[0]?.token_hash !== tokenFrom(newCookie), 'Raw session tokens must not be stored.');
  });

  test('08: cookie creation and clearing preserve attributes, expiry and optional Secure', async () => {
    const response = await login();
    const cookie = cookieFrom(response);
    const header = response.headers.get('set-cookie') ?? '';
    for (const attribute of [/;\s*Path=\//i, /;\s*HttpOnly/i, /;\s*SameSite=Lax/i, /;\s*Max-Age=3600(?:;|$)/i]) {
      assert.ok(attribute.test(header), 'Session cookie must include all required attributes.');
    }
    assert.ok(!/;\s*(?:Secure|Domain)(?:[;=]|$)/i.test(header), 'Local HTTP cookie must omit Secure and Domain.');
    const expiry = header.match(/;\s*Expires=([^;]+)/i)?.[1];
    assert.ok(expiry && Math.abs(Date.parse(expiry) - Date.now() - 3600_000) < 5000,
      'Cookie Expires and Max-Age must agree with the session lifetime.');
    const logout = await post(appA.origin, '/api/auth/logout', {}, { cookie });
    assert.equal(logout.status, 204);
    const cleared = logout.headers.get('set-cookie') ?? '';
    assert.ok(/^courier_session=;/.test(cleared), 'Logout must clear the same session cookie.');
    for (const attribute of [/;\s*Path=\//i, /;\s*HttpOnly/i, /;\s*SameSite=Lax/i, /;\s*Max-Age=0(?:;|$)/i]) {
      assert.ok(attribute.test(cleared), 'Cleared cookie must preserve its security attributes and scope.');
    }
    const clearedExpiry = cleared.match(/;\s*Expires=([^;]+)/i)?.[1];
    assert.ok(clearedExpiry && Date.parse(clearedExpiry) <= Date.now());
    assert.equal((await post(appA.origin, '/api/auth/logout')).status, 204);
    const secureServer = await startServer(await unusedPort(), isolatedDatabaseUrl, true);
    try {
      const secureLogin = await login(secureServer.origin);
      await userFrom(secureLogin, 200);
      assert.ok(/;\s*Secure(?:;|$)/i.test(secureLogin.headers.get('set-cookie') ?? ''), 'COOKIE_SECURE must enable Secure.');
      const secureLogout = await post(secureServer.origin, '/api/auth/logout', {}, { cookie: cookieFrom(secureLogin) });
      assert.equal(secureLogout.status, 204);
      assert.ok(/;\s*Secure(?:;|$)/i.test(secureLogout.headers.get('set-cookie') ?? ''), 'Logout must retain configured Secure.');
    } finally {
      await stop(secureServer, true);
    }
  });

  test('09: validation, role injection, malformed JSON, body limits and content type have predictable errors', async () => {
    for (const body of [
      {}, [], { username: 'ab', password: fixturePassword }, { username: 'user.name', password: fixturePassword },
      { username: 'Kelvin', password: fixturePassword },
      { username: 123, password: fixturePassword }, { username: 'usr', password: 123 },
      { username: 'usr', password: 'short' }, { username: 'usr', password: fixturePassword, role: 'admin' },
      { username: 'usr', password: fixturePassword, extra: 'value' },
    ]) {
      await errorFrom(await post(appA.origin, '/api/auth/register', body), 400);
    }
    await errorFrom(await post(appA.origin, '/api/auth/register', {}, { rawBody: '{"username":' }), 400);
    await errorFrom(await post(appA.origin, '/api/auth/register', {}, {
      rawBody: JSON.stringify({ username: 'oversized_user', password: 'x'.repeat(17000) }),
    }), 413);
    await errorFrom(await post(appA.origin, '/api/auth/register', {}, { contentType: 'text/plain' }), 415);
    const admins = await pool.query<{ count: string }>("SELECT count(*)::text FROM users WHERE role = 'admin'");
    assert.equal(admins.rows[0]?.count, '0', 'Public requests must never create an administrator.');
  });

  test('10: exact allowed Origins are enforced, including real Vite proxy requests', async () => {
    for (const origin of [null, 'null', 'https://foreign.example', `${appA.origin}.attacker.example`]) {
      await errorFrom(await post(appA.origin, '/api/auth/login', {
        username: 'block_user', password: fixturePassword,
      }, { origin }), 403);
      await errorFrom(await post(appA.origin, '/api/auth/logout', {}, { origin }), 403);
    }
    await userFrom(await login(), 200);
    const vite = manage('npm', ['run', 'dev:client', '--', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'],
      { ...appEnvironment(portA), NODE_ENV: 'development' }, true);
    try {
      const proxyHealth = await waitForHttp(viteOrigin, vite);
      const proxyBody = await proxyHealth.json() as Record<string, unknown>;
      assert.equal(proxyBody.instanceId, appA.instanceId, 'Vite must proxy to the actual HTTP process A.');
      const html = await fetch(viteOrigin);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /lang="uk"/);
      for (const resource of ['/main.ts', '/styles.css', '/api.ts']) {
        const response = await fetch(`${viteOrigin}${resource}`);
        assert.equal(response.status, 200);
        const source = await response.text();
        assert.ok(source.length > 0);
        if (resource === '/api.ts') {
          assert.match(response.headers.get('content-type') ?? '', /javascript/);
          assert.match(source, /class ApiClient/);
        }
      }
      const response = await post(viteOrigin, '/api/auth/login', {
        username: 'block_user', password: fixturePassword,
      }, { origin: viteOrigin });
      const user = await userFrom(response, 200);
      assert.equal((await userFrom(await me(viteOrigin, cookieFrom(response)), 200)).id, user.id);
      await errorFrom(await post(viteOrigin, '/api/auth/logout', {}, { origin: 'https://foreign.example' }), 403);
    } finally {
      await stop(vite);
    }
  });

  test('11: an unavailable separate database destination keeps liveness but rejects readiness and authentication', async () => {
    const unavailableUrl = new URL(isolatedDatabaseUrl);
    unavailableUrl.hostname = '127.0.0.1';
    unavailableUrl.port = String(await unusedPort());
    const unavailable = await startServer(await unusedPort(), unavailableUrl.href);
    try {
      const started = Date.now();
      await errorFrom(await fetch(`${unavailable.origin}/api/ready`, { signal: AbortSignal.timeout(8000) }), 503);
      assert.ok(Date.now() - started < 7000, 'Readiness must use a finite short database timeout.');
      await errorFrom(await login(unavailable.origin), 503);
      await errorFrom(await post(unavailable.origin, '/api/auth/register', {
        username: 'db_unavailable', password: fixturePassword,
      }), 503);
      await errorFrom(await me(unavailable.origin, `courier_session=${randomBytes(32).toString('base64url')}`), 503);
      assert.equal((await fetch(`${unavailable.origin}/api/health`)).status, 200);
    } finally {
      await stop(unavailable, true);
    }
  });

  test('12: Unicode passwords preserve spaces and exact sequences, enforce code point limits and retain user role', async () => {
    const username = 'unicode_password';
    const password = '  Навчальний café пароль 😀  ';
    const registration = await post(appA.origin, '/api/auth/register', { username, password });
    const user = await userFrom(registration, 201);
    assert.equal(user.role, 'user');
    await userFrom(await login(appA.origin, undefined, username, password), 200);
    for (const incorrect of [password.trim(), password.normalize('NFD'), `${password}x`]) {
      await errorFrom(await login(appA.origin, undefined, username, incorrect), 401);
    }
    const maximumPassword = '😀'.repeat(128);
    await userFrom(await post(appA.origin, '/api/auth/register', {
      username: 'unicode_maximum', password: maximumPassword,
    }), 201);
    await userFrom(await login(appA.origin, undefined, 'unicode_maximum', maximumPassword), 200);
    for (const length of [14, 129]) {
      await errorFrom(await post(appA.origin, '/api/auth/register', {
        username: 'unicode_invalid', password: '😀'.repeat(length),
      }), 400);
    }
    const stored = await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [user.id]);
    assert.equal(stored.rows[0]?.role, 'user');
  });

  test('production resources, API fallbacks and process-stable health remain valid after authentication changes', async () => {
    const html = await fetch(`${appB.origin}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    const text = await html.text();
    assert.match(text, /lang="uk"/);
    const assets = [...text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map((match) => match[1]);
    assert.ok(assets.length >= 2, 'Built HTML must reference real JavaScript and CSS assets.');
    for (const asset of assets) {
      const response = await fetch(`${appB.origin}${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', asset?.endsWith('.css') ? /text\/css/ : /javascript/);
      assert.ok((await response.text()).length > 0);
    }
    for (const path of ['/api/not-found', '/api', '/missing-page']) {
      assert.equal((await fetch(`${appB.origin}${path}`)).status, 404);
    }
    const repeated = await fetch(`${appB.origin}/api/health`);
    assert.equal((await repeated.json() as Record<string, unknown>).instanceId, appB.instanceId);
  });
});
