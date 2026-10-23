import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const chromePath = process.env.COURIER_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class Protocol {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data));
      if (!value.id) { for (const listener of this.listeners) listener(value); return; }
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error('Browser protocol rejected a command.'));
      else pending.resolve(value.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser protocol command deadline.')); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed.')); }
    this.pending.clear();
    this.socket.close();
  }
}

function launchChrome(args, environment) {
  const child = spawn(chromePath, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
  return { child, closed };
}

async function stopChrome(browser) {
  if (!browser) return;
  if (browser.child.exitCode === null && browser.child.signalCode === null) browser.child.kill('SIGTERM');
  if (!await Promise.race([browser.closed.then(() => true), delay(5_000, false, { ref: false })])) {
    browser.child.kill('SIGKILL');
    await browser.closed;
    throw new Error('Temporary Chrome exceeded its shutdown deadline.');
  }
}

/** Normal TLS validation is mandatory before granting an isolated leaf-SPKI
 * exception to Chrome. No user trust store or global certificate bypass changes. */
async function verifiedLeaf(origin, ca) {
  const url = new URL('/api/health', origin);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca, servername: 'localhost', family: 4, agent: false, minVersion: 'TLSv1.2', timeout: 10_000 }, (response) => {
      response.once('error', () => reject(new Error('TLS response interrupted.')));
      try {
        assert.equal(response.statusCode, 200);
        assert.equal(response.socket.authorized, true);
        const protocol = response.socket.getProtocol();
        const peer = response.socket.getPeerCertificate();
        const certificate = new X509Certificate(peer.raw);
        assert.equal(certificate.checkHost('localhost'), 'localhost');
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) response.destroy(new Error('Health reply exceeds its bound.'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const health = JSON.parse(Buffer.concat(chunks).toString());
            assert.equal(health.status, 'ok');
            assert.equal(response.headers['x-instance-id'], health.instanceId);
            const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
            resolve({ spki, protocol, hostname: 'localhost' });
          } catch (error) { reject(error); }
        });
      } catch (error) { response.destroy(); reject(error); }
    });
    request.once('timeout', () => request.destroy(new Error('TLS validation deadline.')));
    request.once('error', reject);
  });
}

function heavyCoordinates() {
  let generator = 42;
  return Array.from({ length: 500 }, () => {
    generator = (Math.imul(generator, 1664525) + 1013904223) >>> 0;
    const x = generator / 0x1_0000_0000 * 2000 - 1000;
    generator = (Math.imul(generator, 1664525) + 1013904223) >>> 0;
    return `${x} ${generator / 0x1_0000_0000 * 2000 - 1000}`;
  }).join('\n');
}

/** Uses only the parent's disposable deployment. The parent owns namespace/PVC
 * cleanup; this function always closes its fresh Chrome and removes its profile. */
export async function runDeploymentBrowser({ deployment }) {
  assert.match(deployment.namespace, /^courier-route-test-[a-z0-9-]+$/u);
  assert.match(deployment.ownerId, /^[0-9a-f-]{36}$/u);
  assert.equal(new URL(deployment.httpsOrigin).protocol, 'https:');
  assert.equal(new URL(deployment.httpsOrigin).hostname, 'localhost');
  await deployment.assertOwned();
  const output = join(root, '.local/deployment-tests', deployment.ownerId, 'browser');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const startedAt = performance.now();
  const deadline = startedAt + 120_000;
  const username = `tls_browser_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  const checks = [];
  const requests = [];
  const exceptions = [];
  const resourceFailures = [];
  const mixedContent = [];
  const screenshots = [];
  const diagnostics = {};
  let step = 'TLS trust';
  let browser;
  let profile;
  let cdp;
  let sessionId;
  const origin = deployment.httpsOrigin;
  const command = (method, params = {}) => cdp.send(method, params, sessionId);
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error('Browser evaluation failed.');
    return result.result.value;
  }
  async function until(probe, label, timeout = 12_000) {
    const end = Math.min(deadline, performance.now() + timeout);
    while (performance.now() < end) { if (await probe()) return; await delay(25); }
    throw new Error(`Timeout: ${label}`);
  }
  const waitFor = (expression, label, timeout) => until(() => evaluate(expression), label, timeout);
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const visible = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`);
  async function click(selector) {
    await waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`, `enabled ${selector}`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function fill(values) {
    await evaluate(`(() => { for (const [selector, value] of Object.entries(${JSON.stringify(values)})) {
      const field = document.querySelector(selector); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
    } })()`);
  }
  const status = (value) => waitFor(`document.querySelector('#job-detail-status')?.dataset.status === ${JSON.stringify(value)}`, `job ${value}`);
  const selectedId = () => text('#job-reference');
  const createCount = () => requests.filter((item) => item.method === 'POST' && item.path === '/api/jobs').length;
  async function create(values) {
    const previous = await selectedId();
    if (values) await fill(values);
    await click('#route-submit');
    await waitFor(`document.querySelector('#job-reference')?.textContent && document.querySelector('#job-reference').textContent !== ${JSON.stringify(previous)}`, 'accepted UI job');
    await waitFor(`!document.querySelector('#route-submit').disabled`, 'create response complete');
    return selectedId();
  }
  async function choose(id) {
    const selector = JSON.stringify(`Маршрут · ${id.slice(0, 8)}`);
    await waitFor(`Array.from(document.querySelectorAll('#active-jobs button,#history-jobs button')).some((button) => button.querySelector('.job-item-reference')?.textContent === ${selector})`, 'listed job');
    await evaluate(`Array.from(document.querySelectorAll('#active-jobs button,#history-jobs button')).find((button) => button.querySelector('.job-item-reference')?.textContent === ${selector}).click()`);
    await waitFor(`document.querySelector('#job-reference')?.textContent === ${JSON.stringify(id)} && !document.querySelector('#job-detail-content').hidden`, 'selected saved job');
  }
  async function screenshot(name, selector) {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(output, name);
    await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 });
    screenshots.push(path);
  }
  async function readJob(id) {
    return evaluate(`(async () => {
      const response = await fetch('/api/jobs/' + ${JSON.stringify(id)}, { credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Job read failed'); const job = await response.json();
      return { status:job.status, executedBy:job.executedBy, completed:job.progress.completedIterations, queue:job.queue ?? null };
    })()`);
  }
  const passed = (name, details = {}) => checks.push({ name, status: 'pass', ...details });
  try {
    const tls = await verifiedLeaf(origin, await readFile(deployment.caPath));
    passed('normal TLS client verifies project CA, localhost hostname and real health header', { protocol: tls.protocol });
    profile = await mkdtemp(join(output, 'profile-'));
    const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot']
      .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
    browser = launchChrome(['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-sync', '--disable-extensions', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${tls.spki}`, 'about:blank'], environment);
    let debugging;
    await until(async () => {
      try { debugging = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return debugging.length === 2; }
      catch { return false; }
    }, 'fresh isolated Chrome');
    const socket = new WebSocket(`ws://127.0.0.1:${debugging[0]}${debugging[1]}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Browser protocol connection deadline.'));
      }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Browser protocol connection failed.'));
      }, { once: true });
    });
    cdp = new Protocol(socket);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    cdp.listeners.add((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Runtime.exceptionThrown') exceptions.push('Uncaught browser exception');
      if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') exceptions.push('Application console error');
      if (event.method === 'Network.requestWillBeSent') {
        let url;
        try { url = new URL(event.params.request.url); } catch { return; }
        if (url.protocol === 'http:') mixedContent.push({ type: event.params.type, path: url.pathname });
        if (url.origin === origin) requests.push({ requestId: event.params.requestId,
          method: event.params.request.method, path: url.pathname, type: event.params.type });
      }
      if (event.method === 'Network.responseReceived') {
        const found = requests.findLast((item) => item.requestId === event.params.requestId);
        if (found) { found.status = event.params.response.status; found.handler = event.params.response.headers['X-Instance-Id'] ?? event.params.response.headers['x-instance-id']; }
        if (['Script', 'Stylesheet'].includes(event.params.type) && event.params.response.status >= 400) resourceFailures.push(event.params.type);
      }
      if (event.method === 'Network.loadingFailed') {
        const found = requests.findLast((item) => item.requestId === event.params.requestId);
        if (found && ['Script', 'Stylesheet'].includes(found.type)) resourceFailures.push(found.type);
      }
    });
    await Promise.all([command('Page.enable'), command('Runtime.enable'), command('Network.enable')]);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: origin });
    step = 'HTTPS registration and login';
    await waitFor(`!document.querySelector('#auth-fields')?.disabled`, 'auth page');
    assert.equal(await evaluate('location.protocol'), 'https:');
    await click('#register-mode');
    await fill({ '#username': username, '#password': password });
    await click('#auth-submit');
    await waitFor(`document.querySelector('#auth-message')?.textContent.includes('Обліковий запис створено')`, 'registration');
    assert.equal(await visible('#jobs-workspace'), false);
    await fill({ '#password': password });
    await click('#auth-submit');
    await waitFor(`!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled`, 'login and limits');
    const sessions = await evaluate(`(async () => { const rows=[]; for(let i=0;i<4;i++) {
      const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
      const value=await response.json(); rows.push({status:response.status,id:value.user?.id,handler:response.headers.get('x-instance-id')});
    } return rows; })()`);
    assert.ok(sessions.every((item) => item.status === 200 && item.id === sessions[0].id));
    assert.equal(new Set(sessions.map((item) => item.handler)).size, 2);
    await screenshot('desktop-top.png', '.intro');
    passed('real HTTPS registration/login and one browser session served by both backends');

    step = 'square and saved result';
    await click('#fill-square');
    const squareId = await create();
    await status('completed');
    assert.equal(await text('#job-result-length'), '4');
    assert.equal(await text('#job-seed'), '0');
    assert.equal(await evaluate(`document.querySelectorAll('#route-diagram circle').length`), 3);
    const savedPath = await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`);
    const points = savedPath.split(' ').map((entry) => entry.split(',').map(Number));
    assert.equal(points.length, 5);
    assert.deepEqual(points[0], points[4]);
    assert.equal(Math.abs(points[1][0] - points[0][0]), Math.abs(points[2][1] - points[1][1]));
    await screenshot('desktop-result.png', '.detail-panel');
    await fill({ '#delivery-points': '-7.5 4\n1 2' });
    assert.equal(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), savedPath);
    const beforeReload = createCount();
    await command('Page.reload', { ignoreCache: true });
    await status('completed');
    assert.equal(await selectedId(), squareId);
    assert.equal(createCount(), beforeReload);
    passed('HTTPS square seed zero, closed SVG, saved input independent of draft and reload without POST');

    step = 'client validation';
    const beforeInvalid = createCount();
    await fill({ '#delivery-points': '1 2\n3 4 5' });
    await click('#route-submit');
    await waitFor(`!document.querySelector('#route-draft-error').hidden`, 'invalid line');
    assert.match(await text('#route-draft-error'), /2/u);
    assert.equal(createCount(), beforeInvalid);
    passed('invalid coordinate row rejected without a network POST');

    step = 'first real browser worker';
    const heavy = { '#warehouse-x': '0', '#warehouse-y': '0', '#delivery-points': heavyCoordinates(), '#route-iterations': '200000000', '#route-seed': '42' };
    const heavyOne = await create(heavy);
    await until(async () => {
      const job = await readJob(heavyOne);
      return job.status === 'running' && job.completed > 0;
    }, 'first actual running worker');
    step = 'second real browser worker';
    const heavyTwo = await create(heavy);
    await until(async () => {
      const job = await readJob(heavyTwo);
      return job.status === 'running' && job.completed > 0;
    }, 'second actual running worker');
    step = 'real queued browser ETA';
    const waiting = await create(heavy);
    await status('queued');
    await until(async () => {
      const job = await readJob(waiting);
      diagnostics.queue = job;
      return job.status === 'queued' && job.queue && Number.isSafeInteger(job.queue.estimatedWaitMs)
        && job.queue.estimatedWaitMs >= 0 && job.queue.executorCount === 2;
    }, 'numeric queue estimate while both workers are busy');
    const states = await deployment.sql(`SELECT id, status, instance_id FROM jobs WHERE id=ANY($1::uuid[])`, [[heavyOne, heavyTwo]]);
    diagnostics.running = states;
    assert.ok(states.every((item) => item.status === 'running'));
    assert.equal(new Set(states.map((item) => item.instance_id)).size, 2);
    await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(`document.querySelector('#job-queue-estimate').textContent.includes('Орієнтовно')`, 'queue time');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await screenshot('mobile-queue.png', '#job-queue');
    step = 'browser quota and preserved input';
    const beforeRejected = createCount();
    await click('#route-submit');
    await waitFor(`document.querySelector('#jobs-action-message').classList.contains('error')`, 'quota response');
    assert.ok(requests.some((item) => item.method === 'POST' && item.path === '/api/jobs' && item.status === 429));
    assert.equal(createCount(), beforeRejected + 1);
    assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), heavy['#delivery-points']);
    assert.equal(await evaluate(`document.querySelector('#route-iterations').value`), '200000000');
    await screenshot('mobile-quota.png', '#jobs-action-message');
    passed('two real worker jobs, third queued with numeric ETA, quota 429 and preserved input');

    step = 'actual progress and cancellation';
    await choose(heavyOne);
    await status('running');
    const firstProgress = await readJob(heavyOne);
    assert.ok(firstProgress.completed > 0);
    const caption = await text('#job-detail-iterations');
    await evaluate(`(() => { const field=document.querySelector('#delivery-points'); field.focus(); field.setSelectionRange(5,5); })()`);
    await waitFor(`document.querySelector('#job-detail-status').dataset.status === 'running' && document.querySelector('#job-detail-iterations').textContent !== ${JSON.stringify(caption)}`, 'real progress update', 6_000);
    assert.equal(await evaluate('document.activeElement.id'), 'delivery-points');
    assert.equal(await evaluate(`document.querySelector('#delivery-points').selectionStart`), 5);
    assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), heavy['#delivery-points']);
    let laterProgress;
    await until(async () => {
      laterProgress = await readJob(heavyOne);
      return laterProgress.status === 'running' && laterProgress.completed > firstProgress.completed;
    }, 'a later persisted real counter', 6_000);
    assert.equal(await visible('#job-result'), false);
    assert.equal(await visible('#job-queue'), false);
    await screenshot('mobile-running.png', '.detail-panel');
    await click('#job-detail-cancel');
    await status('cancelled');
    assert.ok(requests.some((item) => item.method === 'POST' && item.path === `/api/jobs/${heavyOne}/cancel` && item.status === 202));
    assert.equal(await visible('#job-result'), false);
    for (const id of [heavyTwo, waiting]) {
      await click('#jobs-refresh');
      await choose(id);
      const actual = await readJob(id);
      if (actual.status === 'running' || actual.status === 'queued') {
        await click('#job-detail-cancel');
        await status('cancelled');
      }
    }
    passed('saved progress increases while input focus is stable; real cancel confirms terminal and clears ETA');

    step = 'new job, historical result and responsive keyboard';
    await click('#fill-square');
    const next = await create();
    await status('completed');
    assert.equal(await text('#job-result-length'), '4');
    await screenshot('mobile-square.png', '.detail-panel');
    await choose(squareId);
    await status('completed');
    assert.equal(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), savedPath);
    await fill({ '#delivery-points': '-12.5 7' });
    assert.equal(await evaluate(`document.querySelector('#route-diagram polyline').getAttribute('points')`), savedPath);
    await evaluate(`document.querySelector('#warehouse-x').focus()`);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('document.activeElement.id'), 'warehouse-y');
    assert.notEqual(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'none');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await screenshot('mobile-form.png', '.route-form-panel');
    const beforeSecondReload = createCount();
    await command('Page.reload', { ignoreCache: true });
    await status('completed');
    assert.equal(await selectedId(), next);
    assert.equal(createCount(), beforeSecondReload);
    passed('next task completes after cancel; saved history, reload, keyboard focus and 360px layout work');

    step = 'HTTPS logout';
    await click('#logout');
    await waitFor(`document.querySelector('#jobs-workspace').hidden && !document.querySelector('#auth-fields').disabled`, 'logout');
    assert.equal(await evaluate(`document.querySelector('#delivery-points').value`), '');
    assert.equal(await evaluate(`document.querySelectorAll('#route-diagram svg,#active-jobs li,#history-jobs li').length`), 0);
    const privateStatus = await evaluate(`(async()=>{const r=await fetch('/api/jobs',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});return r.status;})()`);
    assert.equal(privateStatus, 401);
    passed('HTTPS logout clears private state and the shared session is rejected');
    assert.equal(exceptions.length, 0);
    assert.equal(resourceFailures.length, 0);
    assert.equal(mixedContent.length, 0);
    passed('no application console exceptions, failed JS/CSS or HTTP mixed content');
    const rows = await deployment.sql(`SELECT COUNT(*)::integer AS count FROM jobs WHERE user_id=(SELECT id FROM users WHERE normalized_username=$1)`, [username]);
    const summary = { status: 'pass', browser: 'local Google Chrome headless via native CDP',
      tlsTrust: 'Normal CA/hostname verification before isolated leaf-SPKI Chrome exception; no user trust-store changes.',
      viewports: ['1280x900', '360x900'], namespace: deployment.namespace, origin, checks, screenshots,
      realJobs: rows[0].count, consoleErrors: exceptions.length, failedStaticResources: resourceFailures.length,
      mixedContentRequests: mixedContent.length, elapsedMs: Math.round(performance.now() - startedAt),
      handlers: [...new Set(requests.map((item) => item.handler).filter(Boolean))],
      trace: requests.filter((item) => item.path.startsWith('/api/')).map(({ method, path, status: responseStatus, handler }) => ({ method, path, status: responseStatus, handler })),
    };
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  } catch (error) {
    await writeFile(join(output, 'failure-summary.json'), JSON.stringify({ status: 'failed', step,
      location: String(error?.stack ?? '').split('\n').find((line) => /check-deployment-browser\.mjs:\d+/u.test(line))?.trim(),
      diagnostics,
      completedChecks: checks.map((item) => item.name), consoleErrors: exceptions.length,
      failedStaticResources: resourceFailures.length, mixedContentRequests: mixedContent.length,
      trace: requests.slice(-30).map(({ method, path, status: responseStatus, handler }) => ({ method, path, status: responseStatus, handler })),
    }, null, 2), { mode: 0o600 }).catch(() => {});
    throw new Error(`Deployment browser check failed at: ${step}`);
  } finally {
    try { cdp?.close(); } finally {
      try { await stopChrome(browser); } finally { if (profile) await rm(profile, { recursive: true, force: true }); }
    }
  }
}
