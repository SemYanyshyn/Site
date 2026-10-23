import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dockerHost = process.env.DOCKER_HOST ?? `unix://${homedir()}/.colima/courier-route/docker.sock`;
const image = process.argv[2] ?? process.env.COURIER_IMAGE ?? 'courier-route:block07-candidate';
assert.match(dockerHost, /^unix:\/\/.+\/\.colima\/courier-route\/docker\.sock$/u, 'Use the isolated courier-route Colima socket explicitly.');
assert.match(image, /^courier-route:[a-z0-9][a-z0-9._-]*$/u, 'Container checks use an explicit local courier-route image tag.');
const versions = JSON.parse(await readFile(new URL('../deploy/versions.json', import.meta.url), 'utf8'));
const owner = randomUUID();
const prefix = `courier-container-${owner.slice(0, 8)}`;
const label = `courier-route.container-test=${owner}`;
const network = `${prefix}-network`;
const postgresName = `${prefix}-postgres`;
const appName = `${prefix}-app`;
const probeName = `${prefix}-probe`;
const directory = resolve(projectRoot, '.local/container-check', owner);
const postgresEnv = resolve(directory, 'postgres.env');
const applicationEnv = resolve(directory, 'application.env');
const containers = new Set();
let createdNetwork = false;
let checks = 0;
const results = [];

function docker(arguments_, { input, timeout = 60_000, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('docker', ['--host', dockerHost, ...arguments_], {
      cwd: projectRoot, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, DOCKER_HOST: dockerHost },
    }, (error, stdout, stderr) => {
      if (error && !allowFailure) {
        // Docker output can include environment/configuration; it stays private.
        reject(new Error(`Docker operation failed: ${arguments_[0]} ${arguments_[1] ?? ''} (exit ${String(error.code ?? 'timeout')}).`));
      } else resolvePromise({ stdout, stderr, code: error?.code ?? 0 });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

async function check(name, operation) {
  const started = performance.now();
  const evidence = await operation();
  results.push({ scenario: name, status: 'pass', elapsedMs: Math.round((performance.now() - started) * 100) / 100, ...evidence });
  checks++;
  console.info(`PASS ${name}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function eventually(read, predicate, description, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; } catch { /* Observe bounded real startup. */ }
    await delay(50);
  }
  throw new Error(description);
}

async function ownedContainer(name) {
  const inspected = await docker(['inspect', '--format', '{{index .Config.Labels "courier-route.container-test"}}', name], { allowFailure: true });
  return inspected.code === 0 && inspected.stdout.trim() === owner;
}

async function runtimeNode(code, { env = false, cwd = '/tmp', name = probeName } = {}) {
  containers.add(name);
  const result = await docker(['run', '--rm', '--name', name, '--label', label,
    ...(env ? ['--network', network, '--env-file', applicationEnv] : []),
    '--workdir', cwd, '--entrypoint', 'node', image, '--input-type=module', '-e', code]);
  containers.delete(name);
  return JSON.parse(result.stdout.trim());
}

async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await check('real-image-runtime-and-production-dependencies', async () => {
    const { stdout } = await docker(['image', 'inspect', image]);
    const [metadata] = JSON.parse(stdout);
    assert.equal(metadata.Config.User, 'node');
    assert.deepEqual(metadata.Config.Entrypoint ?? [], []);
    assert.deepEqual(metadata.Config.Cmd, ['node', '/app/dist/server/index.js']);
    assert.ok(!(metadata.Config.Env ?? []).some((value) => /^(?:DATABASE_URL|TEST_DATABASE_URL|PGPASSWORD|POSTGRES_PASSWORD|VITE_)/u.test(value)));
    const runtime = await runtimeNode(`
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { execFileSync } from 'node:child_process';
      const require = createRequire('/app/package.json');
      assert.equal(process.getuid(), 1000);
      assert.equal(process.cwd(), '/tmp');
      assert.equal(process.version, 'v24.18.0');
      const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
      assert.equal(npm, '11.16.0');
      for (const dependency of ['typescript', 'tsx', 'vite', 'concurrently', '@types/node']) {
        assert.throws(() => require.resolve(dependency));
      }
      assert.ok(require.resolve('pg'));
      for (const file of ['/app/dist/server/index.js', '/app/dist/server/route/worker.js', '/app/dist/server/route/cli.js', '/app/dist/migrations/003_executor_registry.sql', '/app/dist/examples/route-small.json']) assert.ok(existsSync(file));
      assert.equal(existsSync('/app/src'), false);
      assert.equal(existsSync('/app/.env'), false);
      assert.equal(existsSync('/app/scripts'), false);
      const packageData = JSON.parse(readFileSync('/app/package.json', 'utf8'));
      console.log(JSON.stringify({ node:process.version, npm, uid:process.getuid(), cwd:process.cwd(), package:packageData.name }));
    `);
    return { imageId: metadata.Id, imageSizeBytes: metadata.Size, architecture: metadata.Architecture, ...runtime };
  });
  await check('built-cli-from-another-cwd-without-source-or-database', async () => {
    const outcome = await runtimeNode(`
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      const output = execFileSync(process.execPath, ['/app/dist/server/route/cli.js'], { env: {}, encoding: 'utf8', stdio:['ignore','pipe','pipe'] });
      const outcome = JSON.parse(output);
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.result.length, 4);
      assert.equal(outcome.result.seed, 0);
      assert.deepEqual(outcome.result.order, [0,1,2,3,0]);
      console.log(JSON.stringify({ status:outcome.status, length:outcome.result.length, seed:outcome.result.seed }));
    `);
    return { terminalStatus: outcome.status, length: outcome.length, seed: outcome.seed };
  });

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const database = 'courier_container_test';
  const role = 'courier_container';
  const appPassword = randomBytes(32).toString('base64url');
  const adminPassword = randomBytes(32).toString('base64url');
  const databaseUrl = `postgresql://${role}:${encodeURIComponent(appPassword)}@${postgresName}:5432/${database}`;
  await writeFile(postgresEnv, `POSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_DB=${database}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(applicationEnv, `HOST=0.0.0.0\nPORT=3000\nDATABASE_URL=${databaseUrl}\nAPP_ORIGINS=${origin}\nCOOKIE_SECURE=false\nROUTE_MAX_ITERATIONS=200000000\n`, { mode: 0o600, flag: 'wx' });
  createdNetwork = true;
  await docker(['network', 'create', '--label', label, network]);
  containers.add(appName);
  await docker(['run', '--detach', '--name', appName, '--label', label, '--network', network,
    '--env-file', applicationEnv, '--publish', `127.0.0.1:${port}:3000`, image]);
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${origin}${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(10_000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = null; }
    return { status: response.status, headers: response.headers, text, value };
  }
  await check('published-loopback-http-with-database-down-and-no-mounts', async () => {
    const health = await eventually(() => request('/api/health'), (value) => value.status === 200, 'The container did not publish its health endpoint.');
    assert.equal(health.headers.get('x-instance-id'), health.value.instanceId);
    assert.equal((await request('/api/ready')).status, 503);
    assert.equal((await request('/api/not-found')).status, 404);
    const metadata = JSON.parse((await docker(['inspect', appName])).stdout)[0];
    assert.deepEqual(metadata.Mounts, []);
    assert.equal(metadata.HostConfig.PortBindings['3000/tcp'][0].HostIp, '127.0.0.1');
    const pid = await docker(['exec', appName, 'node', '--input-type=module', '-e',
      `import{readFileSync}from'node:fs';console.log(JSON.stringify(readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean)))`]);
    assert.deepEqual(JSON.parse(pid.stdout), ['node', '/app/dist/server/index.js']);
    return { instanceId: health.value.instanceId, readyWhileDatabaseDown: 503, port };
  });
  await check('production-html-javascript-and-css', async () => {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /id="route-form"/u);
    const script = /<script[^>]+src="([^"]+)"/u.exec(page.text)?.[1];
    const stylesheet = /<link[^>]+href="([^"]+\.css)"/u.exec(page.text)?.[1];
    assert.ok(script?.startsWith('/assets/'));
    assert.ok(stylesheet?.startsWith('/assets/'));
    for (const asset of [script, stylesheet]) {
      const response = await request(asset);
      assert.equal(response.status, 200);
      assert.ok(response.text.length > 100);
      assert.doesNotMatch(response.text, /DATABASE_URL|TEST_DATABASE_URL|POSTGRES_PASSWORD/u);
    }
    return { html: 200, javascript: 200, css: 200 };
  });
  containers.add(postgresName);
  await docker(['run', '--detach', '--name', postgresName, '--label', label, '--network', network,
    '--env-file', postgresEnv, '--tmpfs', '/var/lib/postgresql:rw,size=512m', versions.postgres.image], { timeout: 180_000 });
  await eventually(() => docker(['exec', postgresName, 'sh', '-c',
    `test "$(cat /proc/1/comm)" = postgres && psql -qAt -U postgres -d ${database} -c 'SELECT current_database()'`], { allowFailure: true }),
    (value) => value.code === 0 && value.stdout.trim() === database,
    'The isolated PostgreSQL entrypoint did not finish initialization of its real test database.', 90_000);
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  await docker(['exec', '-i', postgresName, 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], {
    input: `SET log_min_error_statement = 'panic';\nCREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(appPassword)};\nALTER DATABASE ${database} OWNER TO ${role};\n`,
  });
  await check('explicit-compiled-migrations-and-nonsuperuser-application-role', async () => {
    const migrationName = `${prefix}-migrate`;
    containers.add(migrationName);
    await docker(['run', '--rm', '--name', migrationName, '--label', label, '--network', network, '--env-file', applicationEnv,
      image, 'node', '/app/dist/server/db/migrate.js']);
    containers.delete(migrationName);
    const identity = await runtimeNode(`
      import assert from 'node:assert/strict';
      import pg from '/app/node_modules/pg/lib/index.js';
      const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
      try {
        const {rows:[row]}=await pool.query("SELECT current_database() AS database,current_user AS role,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user");
        assert.equal(row.database,'courier_container_test');assert.equal(row.role,'courier_container');assert.equal(row.superuser,false);
        const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
        assert.deepEqual(migrations.rows.map(row=>row.version),['001_auth','002_jobs','003_executor_registry']);
        console.log(JSON.stringify({...row,migrations:migrations.rows.length}));
      } finally {await pool.end();}
    `, { env: true });
    await eventually(() => request('/api/ready'), (value) => value.status === 200, 'Readiness did not recover after explicit migrations.');
    return identity;
  });
  let cookie;
  await check('real-authentication-in-the-published-production-container', async () => {
    const credentials = { username: `container_${owner.slice(0, 8)}`, password: randomBytes(24).toString('base64url') };
    assert.equal((await request('/api/auth/register', { method: 'POST', body: credentials })).status, 201);
    const login = await request('/api/auth/login', { method: 'POST', body: credentials });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('courier_session='));
    assert.equal((await request('/api/auth/me', { cookie })).status, 200);
    return { register: 201, login: 200, me: 200 };
  });
  let jobId;
  let instanceId;
  await check('actual-compiled-worker-progress-keeps-http-ready', async () => {
    const points = Array.from({ length: 500 }, (_, index) => ({ x: (index * 619) % 2003 - 1001, y: (index * 887) % 2011 - 1005 }));
    const created = await request('/api/jobs', { method: 'POST', cookie,
      body: { warehouse: { x: 0, y: 0 }, points, iterations: 200_000_000, seed: 42 } });
    assert.equal(created.status, 202);
    jobId = created.value.id;
    assert.match(jobId, /^[0-9a-f-]{36}$/u);
    const searching = await eventually(() => request(`/api/jobs/${jobId}`, { cookie }),
      (value) => value.status === 200 && value.value.status === 'running' && value.value.progress.completedIterations > 0,
      'The real compiled worker did not report actual search progress.', 15_000);
    instanceId = searching.value.executedBy;
    assert.equal(searching.headers.get('x-instance-id'), instanceId);
    assert.equal((await request('/api/health')).status, 200);
    assert.equal((await request('/api/ready')).status, 200);
    const memory = await docker(['exec', appName, 'node', '--input-type=module', '-e',
      `import{readFileSync}from'node:fs';const status=readFileSync('/proc/1/status','utf8');console.log(JSON.stringify({rssKiB:Number(/^VmRSS:\\s+(\\d+)/m.exec(status)?.[1])}))`]);
    const rss = JSON.parse(memory.stdout);
    assert.ok(Number.isSafeInteger(rss.rssKiB) && rss.rssKiB > 0);
    return { jobId, instanceId, completedIterations: searching.value.progress.completedIterations, ...rss };
  });
  await check('sigterm-reaches-node-pid-one-and-persists-server-shutdown', async () => {
    const started = performance.now();
    await docker(['stop', '--time', '5', appName], { timeout: 10_000 });
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 5_000);
    const exited = await docker(['inspect', '--format', '{{.State.ExitCode}}', appName]);
    assert.equal(Number(exited.stdout.trim()), 0);
    const job = await runtimeNode(`
      import assert from 'node:assert/strict';
      import pg from '/app/node_modules/pg/lib/index.js';
      const pool = new pg.Pool({connectionString:process.env.DATABASE_URL});
      try {
        const {rows:[row]}=await pool.query('SELECT id,status,failure_reason,instance_id FROM jobs WHERE id=$1',[${JSON.stringify(jobId)}]);
        assert.equal(row.status,'failed');assert.equal(row.failure_reason,'server_shutdown');
        const {rows:[executor]}=await pool.query('SELECT accepting_claims FROM executor_registry WHERE instance_id=$1',[row.instance_id]);
        assert.equal(executor.accepting_claims,false);
        console.log(JSON.stringify({id:row.id,status:row.status,reason:row.failure_reason,instanceId:row.instance_id}));
      } finally {await pool.end();}
    `, { env: true });
    return { jobId: job.id, jobStatus: job.status, reason: job.reason, instanceId: job.instanceId,
      shutdownMs: Math.round(elapsedMs * 100) / 100, exitCode: 0 };
  });
}

let failure;
try { await main(); } catch (error) { failure = error; }
const cleanupErrors = [];
for (const name of [...containers].reverse()) {
  try { if (await ownedContainer(name)) await docker(['rm', '--force', '--volumes', name], { timeout: 15_000 }); }
  catch { cleanupErrors.push('container'); }
}
if (createdNetwork) {
  try {
    const result = await docker(['network', 'inspect', '--format', '{{index .Labels "courier-route.container-test"}}', network]);
    assert.equal(result.stdout.trim(), owner);
    await docker(['network', 'rm', network]);
  } catch { cleanupErrors.push('network'); }
}
try { await rm(directory, { recursive: true, force: true }); } catch { cleanupErrors.push('private-files'); }
const summary = { image, checks, pass: checks, fail: failure ? 1 : 0, skipped: 0, cleanupErrors: cleanupErrors.length, results };
console.info(JSON.stringify(summary));
if (failure || cleanupErrors.length) {
  console.error(failure instanceof Error ? failure.message : 'Container cleanup failed.');
  process.exitCode = 1;
}
