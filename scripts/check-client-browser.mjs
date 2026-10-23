import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertSafeTestDatabase } from '../tests/database-safety.ts';

// This is a real-browser check against the built application, not a DOM mock.
// Chrome, all credentials, the profile and schema belong only to this run.
const root = fileURLToPath(new URL('../', import.meta.url));
const chromePath = process.env.COURIER_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const output = join(root, '.local/browser-block05');
const schema = `courier_test_browser_${randomUUID().replaceAll('-', '')}`;
const username = `browser_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
const checks = [];
const network = [];
const exceptions = [];
const staticFailures = [];
const workerEvents = [];
const startedAt = performance.now();
let step = 'setup';
let control;
let pool;
let schemaCreated = false;
let renamed = false;
let profile;
let chrome;
let server;
let vite;
let cdp;
let sessionId;
let origin;
let devOrigin;

function diagnosticMessage(value) {
  return String(value ?? '').split('\n')[0].replaceAll(password, '[redacted]')
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[redacted database address]').slice(0, 240);
}

async function until(probe, description, timeout = 12_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await probe()) return;
    await delay(25);
  }
  throw new Error(`Timeout: ${description}`);
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve) => listener.close(resolve));
  return address.port;
}

function managed(executable, args, options) {
  const child = spawn(executable, args, options);
  child.stdout?.resume();
  child.stderr?.resume();
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve({ code: -1 }));
    child.once('exit', (code) => resolve({ code }));
  });
  return { child, closed, events: [] };
}

async function stop(value) {
  if (!value) return;
  if (value.child.exitCode === null && value.child.signalCode === null) value.child.kill('SIGTERM');
  const result = await Promise.race([value.closed, delay(6500, null, { ref: false })]);
  if (!result) { value.child.kill('SIGKILL'); await value.closed; throw new Error('Temporary process did not stop'); }
}

async function ipc(type) {
  const requestId = randomUUID();
  server.child.send({ type, requestId });
  await until(() => server.events.some((event) => event.requestId === requestId), 'dispatcher acknowledgement');
  assert.notEqual(server.events.find((event) => event.requestId === requestId)?.type, 'harness_error');
}

class Protocol {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Browser protocol error: ${message.error.code}`));
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
  }
  send(method, params = {}, targetSession) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timeout: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }));
    });
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed')); }
    this.pending.clear();
    this.socket.close();
  }
}

function command(method, params = {}) { return cdp.send(method, params, sessionId); }
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed');
  return result.result.value;
}
function visible(selector) { return evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`); }
function text(selector) { return evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`); }
async function waitFor(expression, description, timeout) { await until(() => evaluate(expression), description, timeout); }
async function click(selector) {
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`, `enabled ${selector}`);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function fill(values) {
  await evaluate(`(() => { for (const [selector, value] of Object.entries(${JSON.stringify(values)})) {
    const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
  } })()`);
}
async function status(expected) { await waitFor(`document.querySelector('#job-detail-status')?.dataset.status === ${JSON.stringify(expected)}`, `job ${expected}`); }
async function selectedId() { return text('#job-reference'); }
async function create(values) {
  const old = await selectedId();
  if (values) await fill(values);
  await click('#route-submit');
  await waitFor(`document.querySelector('#job-reference')?.textContent && document.querySelector('#job-reference').textContent !== ${JSON.stringify(old)}`, 'accepted UI job');
  await waitFor(`!document.querySelector('#route-submit').disabled`, 'submit completed');
  return selectedId();
}
async function cancelSelected() { await click('#job-detail-cancel'); await status('cancelled'); }
async function screenshot(name) {
  const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(output, name), Buffer.from(image.data, 'base64'), { mode: 0o600 });
}
function passed(name, details = {}) { checks.push({ name, status: 'pass', ...details }); }
function createCount() { return network.filter((item) => item.method === 'POST' && item.path === '/api/jobs').length; }

try {
  const target = await assertSafeTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const testUrl = new URL(process.env.TEST_DATABASE_URL);
  control = new pg.Pool({ connectionString: testUrl.href, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const { rows: [actual] } = await control.query('SELECT current_database() AS database, inet_server_port() AS port, inet_server_addr()::text AS address, rolsuper AS superuser FROM pg_roles WHERE rolname=current_user');
  assert.ok(actual && actual.database === target.database && actual.port === Number(testUrl.port || 5432));
  if (/^(127\.|localhost$|\[::1\]$)/.test(testUrl.hostname)) assert.ok(actual.address === '::1' || actual.address.startsWith('127.'));
  assert.equal(actual.superuser, false);
  await control.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  testUrl.searchParams.set('options', `-c search_path=${schema}`);
  pool = new pg.Pool({ connectionString: testUrl.href, max: 2, connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const { migrate } = await import('../dist/server/db/migrate.js');
  await migrate(pool);
  const port = await freePort();
  const vitePort = await freePort();
  origin = `http://127.0.0.1:${port}`;
  devOrigin = `http://127.0.0.1:${vitePort}`;
  server = managed(process.execPath, ['--import', 'tsx', 'tests/fixtures/jobs-http-harness.ts'], {
    cwd: root, env: {
      ...process.env, DATABASE_URL: testUrl.href, NODE_ENV: 'production', PORT: String(port), APP_ORIGINS: `${origin},${devOrigin}`,
      COOKIE_SECURE: 'false', SESSION_TTL_SECONDS: '3600', ROUTE_MAX_POINTS: '500', ROUTE_MAX_ITERATIONS: '200000000',
      ROUTE_TIMEOUT_MS: '30000', JOBS_MAX_ACTIVE_PER_USER: '3', JOBS_MAX_OUTSTANDING: '100', JOBS_POLL_INTERVAL_MS: '40',
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  server.child.on('message', (event) => {
    server.events.push(event);
    if (event.type === 'worker_created' || event.type === 'worker_exit') workerEvents.push(event);
  });
  await until(() => server.events.some((event) => event.type === 'ready'), 'production listener');
  await mkdir(output, { recursive: true });
  profile = await mkdtemp(join(tmpdir(), 'courier-browser-'));
  const browserEnvironment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot']
    .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
  chrome = managed(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { env: browserEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  let debugging;
  await until(async () => {
    try { debugging = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return debugging.length === 2; } catch { return false; }
  }, 'fresh Chrome profile');
  const socket = new WebSocket(`ws://127.0.0.1:${debugging[0]}${debugging[1]}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  cdp = new Protocol(socket);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  cdp.listeners.add((event) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === 'Runtime.exceptionThrown') exceptions.push(diagnosticMessage(
      event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text));
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') exceptions.push('Console error');
    if (event.method === 'Network.requestWillBeSent') {
      const url = new URL(event.params.request.url);
      if (url.origin === origin || url.origin === devOrigin) network.push({ requestId: event.params.requestId,
        method: event.params.request.method, path: url.pathname, origin: url.origin });
    }
    if (event.method === 'Network.responseReceived') {
      const found = network.findLast((entry) => entry.requestId === event.params.requestId);
      if (found) found.status = event.params.response.status;
      if (['Script', 'Stylesheet'].includes(event.params.type) && event.params.response.status >= 400) staticFailures.push(event.params.type);
    }
  });
  await Promise.all([command('Page.enable'), command('Runtime.enable'), command('Network.enable')]);
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: origin });
  step = 'registration and login';
  await waitFor(`!document.querySelector('#auth-fields')?.disabled`, 'initial auth');
  await click('#register-mode');
  await fill({ '#username': username, '#password': password });
  await click('#auth-submit');
  await waitFor(`document.querySelector('#auth-message')?.textContent.includes('Обліковий запис створено')`, 'registration');
  assert.equal(await visible('#jobs-workspace'), false);
  await fill({ '#password': password });
  await click('#auth-submit');
  await waitFor(`!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled`, 'authenticated limits');
  assert.match(await text('#route-limits-message'), /500/u);
  await evaluate('scrollTo(0, 0)');
  await screenshot('desktop-top.png');
  passed('register then login and load actual limits');

  step = 'invalid input';
  const beforeInvalid = createCount();
  await fill({ '#delivery-points': '1 2\n3 4 5' });
  await click('#route-submit');
  await waitFor(`!document.querySelector('#route-draft-error').hidden`, 'client parser error');
  assert.match(await text('#route-draft-error'), /2/u);
  assert.equal(await evaluate(`document.activeElement.id`), 'delivery-points');
  assert.equal(createCount(), beforeInvalid);
  passed('invalid line rejected locally without POST');

  step = 'saved square result';
  await click('#fill-square');
  const squareId = await create();
  await status('queued');
  await ipc('resume');
  await status('completed');
  assert.equal(await text('#job-result-length'), '4');
  assert.equal(await text('#job-seed'), '0');
  assert.equal(await evaluate(`document.querySelectorAll('#route-diagram circle').length`), 3);
  const squarePath = await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`);
  const squarePoints = squarePath.split(' ').map((point) => point.split(',').map(Number));
  assert.equal(squarePoints.length, 5);
  assert.deepEqual(squarePoints[0], squarePoints[4]);
  assert.equal(Math.abs(squarePoints[1][0] - squarePoints[0][0]), Math.abs(squarePoints[2][1] - squarePoints[1][1]));
  await evaluate(`document.querySelector('.detail-panel').scrollIntoView({block:'start'})`);
  await screenshot('desktop-result.png');
  await fill({ '#delivery-points': '999 999' });
  assert.equal(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), squarePath);
  const beforeReload = createCount();
  await command('Page.reload', { ignoreCache: true });
  await status('completed');
  assert.equal(await selectedId(), squareId);
  assert.equal(createCount(), beforeReload);
  passed('square result, seed zero, exact closed SVG and immutable saved input');
  passed('reload restores session/history without POST');

  step = 'trivial and coincident results';
  await create({ '#warehouse-x': '0', '#warehouse-y': '0', '#delivery-points': '3 4', '#route-iterations': '123', '#route-seed': '' });
  await status('completed');
  assert.equal(await text('#job-result-length'), '10');
  assert.match(await text('#job-termination'), /0 ітерацій/u);
  assert.ok(Number.isInteger(Number(await text('#job-seed'))));
  await create({ '#warehouse-x': '-1.25', '#warehouse-y': '0.5', '#delivery-points': '-1.25 0.5\n-1.25 0.5\n-1.25 0.5', '#route-seed': '0' });
  await status('completed');
  assert.equal(await text('#job-result-length'), '0');
  assert.equal(await evaluate(`document.querySelectorAll('#route-diagram circle').length`), 3);
  assert.doesNotMatch(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), /NaN|Infinity/u);
  passed('trivial automatic seed and coincident deliveries preserve zero iterations and finite SVG');

  step = 'mobile and keyboard';
  await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
  await evaluate(`document.querySelector('#warehouse-x').focus()`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate(`document.activeElement.id`), 'warehouse-y');
  assert.ok(await evaluate(`getComputedStyle(document.activeElement).outlineStyle !== 'none'`));
  await evaluate(`document.querySelector('.detail-panel').scrollIntoView({block:'start'})`);
  await screenshot('mobile-result.png');
  passed('360px layout has no horizontal overflow and keyboard focus remains visible', { viewport: '360x900' });

  step = 'real pending search and cancel';
  let generator = 42;
  const heavyPoints = Array.from({ length: 500 }, () => {
    generator = (Math.imul(generator, 1664525) + 1013904223) >>> 0;
    const x = generator / 0x1_0000_0000 * 2000 - 1000;
    generator = (Math.imul(generator, 1664525) + 1013904223) >>> 0;
    const y = generator / 0x1_0000_0000 * 2000 - 1000;
    return `${x} ${y}`;
  }).join('\n');
  const heavyId = await create({ '#warehouse-x': '0', '#warehouse-y': '0', '#delivery-points': heavyPoints, '#route-iterations': '200000000', '#route-seed': '42' });
  await waitFor(`document.querySelector('#job-detail-status').dataset.status === 'running' && document.querySelector('#job-detail-progress').value > 0`, 'actual running progress');
  const firstProgress = await evaluate(`document.querySelector('#job-detail-progress').value`);
  assert.ok(firstProgress > 0 && firstProgress < 100);
  assert.equal(await visible('#job-result'), false);
  await fill({ '#delivery-points': '7 8\n9 10' });
  await evaluate(`(() => { const field = document.querySelector('#delivery-points'); field.focus(); field.setSelectionRange(2, 2); })()`);
  await waitFor(`document.querySelector('#job-detail-progress').value > ${firstProgress}`, 'next persisted worker progress');
  assert.equal(await evaluate(`document.activeElement.id`), 'delivery-points');
  assert.equal(await evaluate(`document.querySelector('#delivery-points').selectionStart`), 2);
  assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), '7 8\n9 10');
  const health = await evaluate(`(async () => { const start = performance.now(); const response = await fetch('/api/health'); return { status: response.status, elapsedMs: performance.now() - start }; })()`);
  assert.equal(health.status, 200);
  await click('#job-detail-cancel');
  await status('cancelled');
  assert.equal(await visible('#job-result'), false);
  assert.ok(workerEvents.some((event) => event.type === 'worker_created' && event.jobId === heavyId && event.threadId > 0));
  assert.ok(workerEvents.some((event) => event.type === 'worker_exit' && event.jobId === heavyId && event.threadId === -1));
  assert.ok(network.some((entry) => entry.path === `/api/jobs/${heavyId}/cancel` && entry.status === 202));
  await click('#fill-square');
  await create();
  await status('completed');
  passed('real worker progress, responsive draft focus, HTTP, physical cancel and next job', { healthMs: Math.round(health.elapsedMs * 100) / 100 });

  step = 'queued quota and cancellation';
  await ipc('pause');
  const queued = [];
  for (let index = 0; index < 3; index++) { queued.push(await create()); await status('queued'); }
  const beforeQuota = Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count);
  await click('#route-submit');
  await waitFor(`document.querySelector('#jobs-action-message').classList.contains('error') && !document.querySelector('#route-submit').disabled`, 'quota refusal');
  assert.ok(network.some((entry) => entry.path === '/api/jobs' && entry.status === 429));
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count), beforeQuota);
  assert.equal(await evaluate(`document.querySelectorAll('#active-jobs li').length`), 3);
  await evaluate(`document.querySelector('#active-title').scrollIntoView({block:'start'})`);
  await screenshot('mobile-queue.png');
  for (const id of [...queued].reverse()) {
    if (await selectedId() !== id) {
      await evaluate(`(() => { const item = [...document.querySelectorAll('#active-jobs .job-item')].find((button) => button.textContent.includes(${JSON.stringify(id.slice(0, 8))})); item.click(); })()`);
      await waitFor(`document.querySelector('#job-reference').textContent === ${JSON.stringify(id)}`, 'queued selection');
    }
    await cancelSelected();
  }
  passed('three real queued jobs, 429 quota and confirmed queued cancellation');

  step = 'paginated real history';
  while (Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count) < 21) {
    await create();
    await status('queued');
    await cancelSelected();
  }
  await click('#history-next');
  await waitFor(`document.querySelector('#history-page').textContent.includes('2') && document.querySelector('#history-jobs').getAttribute('aria-busy') === 'false'`, 'second history page');
  assert.ok(await evaluate(`document.querySelectorAll('#history-jobs li').length > 0 && document.querySelectorAll('#history-jobs li').length <= 20`));
  await evaluate(`(() => { const item = [...document.querySelectorAll('#history-jobs .job-item')].find((button) => button.textContent.includes(${JSON.stringify(squareId.slice(0, 8))})); item.click(); })()`);
  await waitFor(`document.querySelector('#job-reference').textContent === ${JSON.stringify(squareId)}`, 'historical square selection');
  await status('completed');
  await fill({ '#delivery-points': '123 456' });
  await click('#jobs-refresh');
  await waitFor(`document.querySelector('#history-jobs').getAttribute('aria-busy') === 'false'`, 'history refresh');
  assert.match(await text('#history-page'), /2/u);
  assert.equal(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), squarePath);
  assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), '123 456');
  await evaluate(`document.querySelector('.detail-panel').scrollIntoView({block:'start'})`);
  await screenshot('mobile-square.png');
  await evaluate(`document.querySelector('.route-form-panel').scrollIntoView({block:'start'})`);
  await screenshot('mobile-form.png');
  passed('21 genuine saved jobs, page two and historical saved result independent of draft');

  step = 'real test database outage and recovery';
  const historyCount = await evaluate(`document.querySelectorAll('#history-jobs li').length`);
  await pool.query('ALTER TABLE jobs RENAME TO jobs_browser_unavailable');
  renamed = true;
  await click('#jobs-refresh');
  await waitFor(`document.querySelector('#history-message').classList.contains('error')`, 'database 503 state');
  assert.equal(await evaluate(`document.querySelectorAll('#history-jobs li').length`), historyCount);
  assert.equal(await visible('#jobs-workspace'), true);
  assert.equal(await text('#job-result-length'), '4');
  await pool.query('ALTER TABLE jobs_browser_unavailable RENAME TO jobs');
  renamed = false;
  await click('#jobs-refresh');
  await waitFor(`!document.querySelector('#history-message').classList.contains('error') && document.querySelector('#history-jobs').getAttribute('aria-busy') === 'false'`, 'database restored');
  passed('real 503 preserves private data and recovers after restoring only the random test table');

  step = 'unknown POST network failure';
  await click('#fill-square');
  const beforeOffline = createCount();
  const beforeOfflineRows = Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count);
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await click('#route-submit');
  await waitFor(`document.querySelector('#jobs-action-message').textContent.includes('Запит міг бути прийнятий')`, 'uncertain create warning');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('#jobs-refresh');
  await waitFor(`document.querySelector('#history-jobs').getAttribute('aria-busy') === 'false'`, 'safe history reread');
  assert.equal(createCount(), beforeOffline + 1);
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count), beforeOfflineRows);
  passed('real browser offline POST gives acceptance-unknown warning and no automatic retry');

  step = 'expired session and logout';
  await pool.query('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE normalized_username=$1)', [username]);
  await click('#jobs-refresh');
  await waitFor(`document.querySelector('#jobs-workspace').hidden && !document.querySelector('#auth-fields').disabled`, '401 session clear');
  assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), '');
  assert.equal(await evaluate(`document.querySelectorAll('#route-diagram svg,#active-jobs li,#history-jobs li').length`), 0);
  await fill({ '#username': username, '#password': password });
  await click('#auth-submit');
  await waitFor(`!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled`, 'login after expiration');
  await click('#logout');
  await waitFor(`document.querySelector('#jobs-workspace').hidden && !document.querySelector('#auth-fields').disabled`, 'logout');
  assert.equal(await evaluate(`document.querySelectorAll('#route-diagram svg,#active-jobs li,#history-jobs li').length`), 0);
  assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), '');
  passed('real 401 and successful logout clear private form, lists, result and requests');

  step = 'Vite browser and real proxy';
  // Vite receives only the backend port and ordinary process environment keys;
  // its proxy reaches the same isolated production process and test schema.
  vite = managed(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: root, env: { ...browserEnvironment, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await until(async () => {
    try { return (await fetch(devOrigin, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { return false; }
  }, 'temporary Vite listener');
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: devOrigin });
  await waitFor(`!document.querySelector('#auth-fields')?.disabled`, 'dev initial auth');
  const beforeDev = createCount();
  await fill({ '#username': username, '#password': password });
  await click('#auth-submit');
  await waitFor(`!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled
    && document.querySelectorAll('#history-jobs li').length === 20`, 'dev login and saved history');
  const endpointStatuses = await evaluate(`(async () => {
    const statuses = [];
    for (const path of ['/api/health', '/api/ready', '/api/does-not-exist']) {
      const response = await fetch(path, { cache: 'no-store' }); statuses.push(response.status);
    }
    return statuses;
  })()`);
  assert.deepEqual(endpointStatuses, [200, 200, 404]);
  for (const asset of ['/main.ts', '/styles.css']) assert.ok(network.some((entry) => entry.origin === devOrigin && entry.path === asset && entry.status === 200));
  await command('Page.reload', { ignoreCache: true });
  await waitFor(`!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled
    && document.querySelectorAll('#history-jobs li').length === 20`, 'dev session restored');
  assert.equal(createCount(), beforeDev);
  passed('real Vite HTML/TS/CSS and same-origin proxy login, reload, saved history, health/ready/API404 without new jobs');
  assert.equal(exceptions.length, 0);
  assert.equal(staticFailures.length, 0);
  passed('no uncaught console exceptions or failed JavaScript/CSS resources');
  const summary = {
    status: 'pass', browser: 'local Google Chrome headless via native CDP', viewports: ['1280x900', '360x900'],
    checks, realJobs: Number((await pool.query('SELECT count(*) AS count FROM jobs')).rows[0].count),
    consoleErrors: exceptions.length, failedStaticResources: staticFailures.length,
    screenshots: ['desktop-top.png', 'desktop-result.png', 'mobile-form.png', 'mobile-result.png', 'mobile-square.png', 'mobile-queue.png'].map((name) => join(output, name)),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.info(JSON.stringify(summary));
} catch (error) {
  try {
    const page = cdp && sessionId ? await evaluate(`({ path: location.pathname, title: document.title,
      auth: document.querySelector('#auth-message')?.textContent ?? '', hasForm: Boolean(document.querySelector('#auth-form')),
      fieldsDisabled: document.querySelector('#auth-fields')?.disabled ?? null })`) : null;
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'failure-diagnostic.json'), JSON.stringify({ step, page, exceptions,
      staticFailures, recentResources: network.slice(-35).map(({ method, path, status }) => ({ method, path, status })) }, null, 2), { mode: 0o600 });
  } catch { /* Diagnostics must not prevent bounded cleanup. */ }
  // Deliberately avoid raw protocol, HTTP, auth or PostgreSQL error objects.
  console.error(JSON.stringify({ status: 'failed', step, reason: error instanceof assert.AssertionError ? 'assertion failed' : error instanceof Error && error.message.startsWith('Timeout:') ? error.message : 'check or environment failure', checksCompleted: checks.length }));
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  try { if (renamed) await pool.query('ALTER TABLE jobs_browser_unavailable RENAME TO jobs'); } catch { cleanupFailed = true; }
  try { cdp?.close(); } catch { cleanupFailed = true; }
  try { await stop(chrome); } catch { cleanupFailed = true; }
  try { await stop(vite); } catch { cleanupFailed = true; }
  try { await stop(server); } catch { cleanupFailed = true; }
  try { await pool?.end(); } catch { cleanupFailed = true; }
  try { if (schemaCreated) await control.query(`DROP SCHEMA "${schema}" CASCADE`); } catch { cleanupFailed = true; }
  try { await control?.end(); } catch { cleanupFailed = true; }
  try { if (profile) await rm(profile, { recursive: true, force: true }); } catch { cleanupFailed = true; }
  if (cleanupFailed) { console.error('Browser verification cleanup failed.'); process.exitCode = 1; }
}
