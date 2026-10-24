import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Protocol, launchChrome, stopChrome, verifiedLeaf } from './check-deployment-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = /^[0-9a-f-]{36}$/u;

/** A fourth account observes the SAME load cycle without submitting any job.
 * The parent owns the disposable namespace and the absolute work deadline. */
export async function startAdminBrowser({ deployment, credentials, deadlineEpochMs = Date.now() + 720_000 }) {
  assert.match(deployment.namespace, /^courier-route-test-[a-z0-9-]+$/u);
  assert.match(deployment.ownerId, uuid);
  assert.ok(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > Date.now());
  const output = join(root, '.local/admin-tests', deployment.ownerId, 'browser');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const abort = new AbortController();
  let browser, profile, cdp, socket, sessionId, cleanupPromise;
  let closed = false, phase = 'login';
  const observations = [], screenshots = [], trace = [], requests = new Map();
  let consoleErrors = 0, failedStaticResources = 0, mixedContentRequests = 0;
  const expire = () => { abort.abort(); browser?.child.kill('SIGKILL'); void cleanup().catch(() => {}); };
  const timer = setTimeout(expire, deadlineEpochMs - Date.now());
  function ensure() { assert.ok(!closed && Date.now() < deadlineEpochMs && !abort.signal.aborted, 'Admin observer work deadline.'); }
  const command = (method, params = {}) => { ensure(); return cdp.send(method, params, sessionId); };
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, 'Admin browser evaluation failed.');
    return result.result.value;
  }
  async function until(probe, label, ms = 20_000) {
    const end = Math.min(deadlineEpochMs, Date.now() + ms);
    while (Date.now() < end) {
      ensure(); if (await probe()) return;
      await delay(40, undefined, { signal: abort.signal });
    }
    throw new Error(`Admin browser deadline: ${label}`);
  }
  const waitFor = (expression, label, ms) => until(() => evaluate(expression), label, ms);
  async function click(selector) {
    await waitFor(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`, 'control');
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function screenshot(name, selector) {
    if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const png = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    ensure(); const path = join(output, name);
    await writeFile(path, Buffer.from(png.data, 'base64'), { mode: 0o600, signal: abort.signal });
    screenshots.push(path); return path;
  }
  async function api(path) {
    assert.ok(path.startsWith('/api/'));
    return evaluate(`(async()=>{const r=await fetch(${JSON.stringify(path)},{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(9000)});return{status:r.status,handler:r.headers.get('x-instance-id'),value:await r.json()};})()`);
  }
  async function healthy() {
    assert.equal(await evaluate('location.protocol'), 'https:');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Admin page must fit viewport.');
    assert.equal(consoleErrors, 0); assert.equal(failedStaticResources, 0); assert.equal(mixedContentRequests, 0);
    assert.equal(trace.filter(x => x.method === 'POST' && x.path === '/api/jobs').length, 0, 'Admin observer cannot create load.');
  }
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    closed = true; clearTimeout(timer); abort.abort();
    cleanupPromise = (async () => {
      try { socket?.close(); cdp?.close(); } finally {
        try { await stopChrome(browser); } finally { if (profile) await rm(profile, { recursive: true, force: true }); }
      }
    })();
    return cleanupPromise;
  }
  try {
    await deployment.assertOwned(); ensure();
    const tls = await verifiedLeaf(deployment.httpsOrigin, await readFile(deployment.caPath), { signal: abort.signal });
    profile = await mkdtemp(join(output, 'profile-')); ensure();
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(k => typeof process.env[k] === 'string').map(k => [k, process.env[k]]));
    browser = launchChrome(['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-extensions',
      ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, `--ignore-certificate-errors-spki-list=${tls.spki}`, 'about:blank'], env);
    let debugging;
    await until(async () => { try { debugging = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return debugging.length === 2; } catch { return false; } }, 'Chrome startup');
    socket = new WebSocket(`ws://127.0.0.1:${debugging[0]}${debugging[1]}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Admin browser socket deadline.')); }, 10_000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Admin browser socket unavailable.')); }, { once: true });
    }); ensure(); cdp = new Protocol(socket); socket = undefined;
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await command('Target.attachToTarget', { targetId, flatten: true }));
    cdp.listeners.add(event => {
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') consoleErrors++;
      if (event.method === 'Network.requestWillBeSent') {
        let url; try { url = new URL(event.params.request.url); } catch { return; }
        if (url.protocol === 'http:') mixedContentRequests++;
        if (url.origin !== deployment.httpsOrigin) return;
        if (requests.size >= 5000) requests.delete(requests.keys().next().value);
        requests.set(event.params.requestId, { method: event.params.request.method, path: url.pathname, type: event.params.type });
      }
      if (event.method === 'Network.responseReceived') {
        const found = requests.get(event.params.requestId);
        if (found?.path.startsWith('/api/')) {
          if (trace.length >= 5000) trace.shift();
          trace.push({ phase, ...found, status: event.params.response.status,
            handler: event.params.response.headers['X-Instance-Id'] ?? event.params.response.headers['x-instance-id'] ?? null });
        }
        if (['Script', 'Stylesheet'].includes(event.params.type) && event.params.response.status >= 400) failedStaticResources++;
      }
      if (event.method === 'Network.loadingFailed' && ['Script', 'Stylesheet'].includes(requests.get(event.params.requestId)?.type)) failedStaticResources++;
    });
    await Promise.all([command('Page.enable'), command('Runtime.enable'), command('Network.enable')]);
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: deployment.httpsOrigin });
    await waitFor(`document.querySelector('#auth-fields') && !document.querySelector('#auth-fields').disabled`, 'login form');
    await evaluate(`(()=>{for(const [s,v] of Object.entries(${JSON.stringify({ '#username': credentials.username, '#password': credentials.password })})){const e=document.querySelector(s);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await click('#auth-submit');
    await waitFor(`!document.querySelector('#jobs-workspace').hidden`, 'authenticated owner workspace');
    const me = await api('/api/auth/me'); assert.equal(me.status, 200);
    if (me.value.user.role === 'user') {
      assert.equal(await evaluate(`document.querySelector('#admin-open').hidden`), true);
      assert.equal((await api('/api/admin/overview')).status, 403);
      assert.equal(await evaluate(`document.querySelector('#admin-summary').children.length + document.querySelector('#admin-jobs').children.length`), 0);
      await healthy();
    } else {
      assert.equal(me.value.user.role, 'admin'); await click('#admin-open');
      await waitFor(`!document.querySelector('#admin-workspace').hidden && document.querySelector('#admin-summary').children.length>0`, 'admin snapshot');
    }
    const userId = me.value.user.id;
    return {
      evaluate, click, waitFor, api, screenshot, cleanup, reload: () => command('Page.reload'),
      async diagnostics() {
        const state = await evaluate(`({hidden:document.hidden,panelHidden:document.querySelector('#admin-workspace')?.hidden,filter:document.querySelector('#admin-status-filter')?.value,
          overviewMessage:document.querySelector('#admin-message')?.textContent,jobsMessage:document.querySelector('#admin-jobs-message')?.textContent,
          jobs:Array.from(document.querySelectorAll('#admin-jobs [data-job-id]')).map(e=>({id:e.dataset.jobId,status:e.dataset.status})),
          servers:Array.from(document.querySelectorAll('#admin-servers [data-instance-id]')).map(e=>({uid:e.dataset.podUid,id:e.dataset.instanceId,text:e.textContent.slice(0,4000)}))})`);
        const path = await screenshot('failure-state.png', '#admin-jobs-title');
        return { phase, state, screenshot: path, trace: trace.slice(-40) };
      },
      async observe({ phase: nextPhase, expectedInstanceIds, expectedPods = expectedInstanceIds?.length, width = nextPhase === 'expanded' ? 360 : 1280 }) {
        phase = nextPhase;
        await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        let overview;
        await until(async () => {
          const reply = await api('/api/admin/overview'); assert.equal(reply.status, 200); overview = reply.value;
          return overview.servers.length === expectedPods && overview.summary.readyPods === expectedPods && overview.summary.confirmedExecutors === expectedPods
            && overview.servers.every(p => p.executor && (!expectedInstanceIds || expectedInstanceIds.includes(p.executor.instanceId)) && p.metric && !p.metric.stale);
        }, 'physical pods/processes and fresh metric mapping', 45_000);
        await waitFor(`document.querySelectorAll('#admin-servers [data-pod-uid]').length===${expectedPods} && ${JSON.stringify(overview.servers.map(p => p.executor.instanceId))}.every(id=>Array.from(document.querySelectorAll('#admin-servers [data-instance-id]')).some(e=>e.dataset.instanceId===id)) && !document.querySelector('#admin-servers').textContent.includes('Немає придатного sample') && !document.querySelector('#admin-servers').textContent.includes('ЗАСТАРІЛА')`, 'automatic server list with actual fresh metrics', 15_000);
        const handlers = new Set();
        for (let i = 0; i < 40 && (!expectedInstanceIds || expectedInstanceIds.some(id => !handlers.has(id))); i++) {
          const response = await api('/api/auth/me'); assert.equal(response.status, 200); assert.equal(response.value.user.id, userId); assert.equal(response.value.user.role, 'admin'); handlers.add(response.handler);
          if (!expectedInstanceIds && handlers.size >= expectedPods) break;
        }
        if (expectedInstanceIds) assert.ok(expectedInstanceIds.every(id => handlers.has(id)));
        await healthy();
        const phaseScreenshots = [await screenshot(`${phase}-servers-${width}.png`, '#admin-servers')];
        const jobs = await api('/api/admin/jobs'); assert.equal(jobs.status, 200);
        phaseScreenshots.push(await screenshot(`${phase}-jobs-${width}.png`, '#admin-jobs-title'));
        if (nextPhase === 'expanded') {
          const baseline = observations.find(observation => observation.phase === 'baseline');
          assert.ok(baseline, 'Capture the actual baseline process identities before expansion.');
          const oldInstances = new Set(baseline.servers.map(server => server.executor.instanceId));
          const added = overview.servers.filter(server => !oldInstances.has(server.executor.instanceId)).sort((left, right) => left.name.localeCompare(right.name));
          assert.equal(added.length, 2, 'Both actual additional process cards need their own screenshot.');
          for (const [index, server] of added.entries()) {
            const selector = `#admin-servers [data-instance-id="${server.executor.instanceId}"]`;
            await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);
            phaseScreenshots.push(await screenshot(`expanded-executor-${String.fromCharCode(67 + index)}.png`));
          }
        }
        const result = { phase, width, handlers: [...handlers], summary: overview.summary, sources: overview.infrastructure,
          servers: overview.servers, owners: [...new Set(jobs.value.jobs.map(j => j.owner.username))], totalJobs: jobs.value.total, screenshots: phaseScreenshots };
        observations.push(result); return result;
      },
      async partial() {
        phase = 'metrics-forbidden';
        await waitFor(`['stale','unavailable','partial'].includes(document.querySelector('#admin-source-status .admin-source:last-child')?.dataset.state)`, 'metrics source failure shown', 15_000);
        const reply = await api('/api/admin/overview'); assert.equal(reply.status, 200); assert.notEqual(reply.value.infrastructure.metrics.status, 'ok');
        assert.equal((await api('/api/auth/me')).value.user.role, 'admin');
        await screenshot('partial-metrics.png', '#admin-source-status'); await healthy(); return reply.value.infrastructure;
      },
      async pagination() {
        phase = 'jobs-filter-pagination';
        await click('#admin-refresh');
        await waitFor(`document.querySelectorAll('#admin-jobs [data-job-id]').length===20`, 'first full page');
        const first = await evaluate(`Array.from(document.querySelectorAll('#admin-jobs [data-job-id]')).map(e=>e.dataset.jobId)`);
        await click('#admin-next'); await waitFor(`document.querySelector('#admin-page').textContent.includes('Сторінка 2') && document.querySelector('#admin-jobs-message').textContent.includes('Snapshot PostgreSQL:') && document.querySelectorAll('#admin-jobs [data-job-id]').length>0`, 'second page');
        const second = await evaluate(`Array.from(document.querySelectorAll('#admin-jobs [data-job-id]')).map(e=>e.dataset.jobId)`);
        assert.ok(second.length > 0 && second.every(id => !first.includes(id)));
        await evaluate(`document.querySelector('#admin-status-filter').focus();document.querySelector('#admin-status-filter').value='completed';document.querySelector('#admin-status-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
        await waitFor(`document.querySelector('#admin-page').textContent.includes('Сторінка 1') && document.querySelector('#admin-jobs-message').textContent.includes('Snapshot PostgreSQL:') && document.querySelectorAll('#admin-jobs [data-job-id]').length>0 && Array.from(document.querySelectorAll('#admin-jobs [data-status]')).every(e=>e.dataset.status==='completed')`, 'filter resets page');
        assert.equal(await evaluate(`document.activeElement.id`), 'admin-status-filter');
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        assert.ok(['admin-prev', 'admin-next'].includes(await evaluate('document.activeElement.id')));
        await screenshot('jobs-filter-desktop.png', '#admin-jobs-title');
        await command('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
        await healthy(); await screenshot('jobs-filter-360.png', '#admin-jobs-title');
        await evaluate(`document.querySelector('#admin-status-filter').value='';document.querySelector('#admin-status-filter').dispatchEvent(new Event('change',{bubbles:true}))`);
        await waitFor(`document.querySelector('#admin-status-filter').value==='' && document.querySelector('#admin-jobs-message').textContent.includes('Snapshot PostgreSQL:') && document.querySelectorAll('#admin-jobs [data-job-id]').length===20`, 'unfiltered page settled before next real task');
        return { firstPage: first.length, secondPage: second.length, overlap: 0, keyboard: true };
      },
      async forbidden() {
        phase = 'human-role-revoked';
        await click('#admin-refresh');
        await waitFor(`document.querySelector('#admin-workspace').hidden && document.querySelector('#admin-open').hidden && document.querySelector('#admin-summary').children.length===0 && document.querySelector('#admin-jobs').children.length===0`, '403 clears all private data');
        assert.equal((await api('/api/admin/overview')).status, 403); return { status: 403, privateCleared: true };
      },
      async logout() {
        phase = 'logout'; await click('#logout');
        await waitFor(`document.querySelector('#user-state').hidden && document.querySelector('#admin-workspace').hidden && document.querySelector('#admin-jobs').children.length===0 && document.querySelector('#admin-summary').children.length===0`, 'logout clears private data');
        assert.equal((await api('/api/admin/overview')).status, 401); return { status: 401, privateCleared: true };
      },
      async lateLogout() {
        phase = 'logout-with-paused-successful-overview';
        // Pause one genuine 200 response after its server authorization/read,
        // keeping its payload untouched. Logout must fence and abort this read.
        let paused, cancelled = false;
        const listener = event => {
          if (event.sessionId !== sessionId) return;
          if (event.method === 'Fetch.requestPaused' && event.params.responseStatusCode === 200
            && new URL(event.params.request.url).pathname === '/api/admin/overview') paused ??= event.params;
          if (paused?.networkId && event.method === 'Network.loadingFailed' && event.params.requestId === paused.networkId) cancelled = event.params.canceled === true;
        };
        cdp.listeners.add(listener);
        try {
          await command('Fetch.enable', { patterns: [{ urlPattern: `${deployment.httpsOrigin}/api/admin/overview`, requestStage: 'Response' }] });
          await click('#admin-refresh'); await until(async () => !!paused, 'actual successful overview paused');
          assert.equal(await evaluate(`document.querySelector('#admin-summary').children.length>0`), true);
          await click('#logout');
          await waitFor(`document.querySelector('#user-state').hidden && document.querySelector('#admin-workspace').hidden && document.querySelector('#admin-summary').children.length===0 && document.querySelector('#admin-jobs').children.length===0`, 'logout clears while response remains paused');
          let resumed = false;
          try { await command('Fetch.continueResponse', { requestId: paused.requestId }); resumed = true; }
          catch { await until(async () => cancelled, 'vanished interception corresponds to physically aborted fetch', 2_000); }
          await command('Fetch.disable');
          await delay(150, undefined, { signal: abort.signal });
          assert.equal(await evaluate(`document.querySelector('#admin-summary').children.length + document.querySelector('#admin-jobs').children.length`), 0);
          assert.equal((await api('/api/admin/overview')).status, 401);
          return { actualPausedStatus: 200, originalResponseResumed: resumed, requestPhysicallyCancelled: cancelled, privateCleared: true, statusAfterLogout: 401 };
        } finally {
          cdp.listeners.delete(listener); await command('Fetch.disable').catch(() => {});
        }
      },
      async finish() {
        await healthy();
        assert.equal(trace.filter(x => x.method === 'POST' && x.path === '/api/auth/login').length, 1);
        const result = { observations, screenshots, consoleErrors, failedStaticResources, mixedContentRequests, trace };
        await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
        return result;
      },
    };
  } catch (error) {
    await writeFile(join(output, 'failure.json'), JSON.stringify({ phase, consoleErrors, failedStaticResources, mixedContentRequests,
      trace: trace.slice(-40), screenshots, location: String(error?.stack ?? '').split('\n').find(s => /check-admin-browser\.mjs:\d+/u.test(s))?.trim() }, null, 2), { mode: 0o600 }).catch(() => {});
    await cleanup(); throw new Error(`Admin browser failed during ${phase}.`);
  }
}
