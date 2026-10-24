import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { checkServerIdentity } from 'node:tls';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const APP_SELECTOR = 'app.kubernetes.io/name=courier-route-app,app.kubernetes.io/component=app';
const PG_SELECTOR = 'app.kubernetes.io/name=courier-route-postgres';
const TRACE_KEYS = ['action', 'handler', 'jobId', 'executedBy', 'status', 'jobStatus', 'failureReason', 'elapsedMs'];
const hidden = new Set();
let phase = 'preflight/provision';
let activeProof;

function redactFailure(error) {
  let message = String(error?.message ?? 'Actual deployment check failed.').split('\n')[0];
  for (const value of hidden) if (value) message = message.replaceAll(value, '[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[redacted database address]');
  return { message: message.slice(0, 240), location: String(error?.stack ?? '').split('\n')
    .find((line) => /check-deployment\.mjs:\d+/u.test(line))?.trim() };
}

/** Faults are permitted only in the unique namespace made by this test run. */
export function assertOwnedDeployment(target, namespace) {
  assert.ok(target && typeof target.namespace === 'string' && /^courier-route-test-[a-z0-9-]+$/u.test(target.namespace));
  assert.ok(typeof target.ownerId === 'string' && UUID.test(target.ownerId));
  assert.ok(typeof target.context === 'string' && target.context.length > 0);
  assert.ok(typeof target.kubeconfig === 'string' && target.kubeconfig.startsWith('/'));
  assert.equal(namespace?.metadata?.name, target.namespace);
  assert.equal(namespace?.metadata?.labels?.['app.kubernetes.io/managed-by'], 'courier-route-local');
  assert.equal(namespace?.metadata?.labels?.['courier-route.local/owner-id'], target.ownerId);
}

export function assertReadyReplicas(pods, endpoints, expectedImage) {
  assert.equal(pods.length, 2, 'Exactly two real app pods are required.');
  const uids = new Set();
  const imageIds = new Set();
  for (const pod of pods) {
    assert.ok(typeof pod.metadata?.uid === 'string');
    uids.add(pod.metadata.uid);
    assert.ok(pod.status?.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True'));
    const container = pod.spec?.containers?.find((value) => value.name === 'app');
    assert.ok(container);
    assert.equal(container.image, expectedImage);
    const running = pod.status.containerStatuses?.find((value) => value.name === 'app');
    assert.ok(running?.ready && typeof running.imageID === 'string' && running.imageID.includes('sha256:'));
    imageIds.add(running.imageID);
  }
  assert.equal(uids.size, 2);
  assert.equal(imageIds.size, 1, 'Both actual running containers must use the same image digest.');
  const readyAddresses = new Set(endpoints.flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready === true).flatMap((endpoint) => endpoint.addresses ?? []));
  assert.equal(readyAddresses.size, 2, 'The actual Service EndpointSlices must contain two ready addresses.');
  const endpointPods = new Set(endpoints.flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready === true).map((endpoint) => endpoint.targetRef?.uid));
  assert.deepEqual(endpointPods, uids, 'Ready Service endpoints must refer to those exact two owned app pods.');
}

export function secureSessionCookie(headers) {
  const values = headers['set-cookie'];
  assert.ok(Array.isArray(values) && values.length > 0);
  const session = values.find((value) => value.startsWith('courier_session='));
  assert.ok(session);
  hidden.add(session);
  hidden.add(session.split(';')[0]);
  hidden.add(session.split(';')[0].slice('courier_session='.length));
  assert.match(session, /;\s*Secure(?:;|$)/iu);
  assert.match(session, /;\s*HttpOnly(?:;|$)/iu);
  assert.match(session, /;\s*SameSite=Lax(?:;|$)/iu);
  assert.match(session, /;\s*Path=\/(?:;|$)/iu);
  assert.doesNotMatch(session, /;\s*Domain=/iu);
  const cookie = session.split(';')[0];
  assert.ok(cookie && cookie !== 'courier_session=');
  return cookie;
}

export function safeTrace(entry) {
  return Object.fromEntries(TRACE_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
}

export function verifiedCrossCancellation(victim, response, terminal) {
  return UUID.test(victim.executedBy ?? '') && response.status === 202
    && UUID.test(response.handler ?? '') && response.handler !== victim.executedBy
    && response.value?.id === victim.id && response.value?.status === 'running' && response.value?.cancelRequested === true
    && terminal.value?.id === victim.id && terminal.value?.status === 'cancelled';
}

export function deploymentOrigin(value, protocol) {
  const url = new URL(value);
  assert.equal(url.protocol, protocol);
  assert.ok(url.hostname === 'localhost' || url.hostname.endsWith('.localhost'));
  assert.ok(url.port && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password);
  return url;
}

/** A new connection per request makes actual LB handler tracing observable.
 * POST is issued exactly once; retry decisions belong to safe GET observers. */
export function requestDeployment(origin, ca, { path = '/', method = 'GET', body, cookie, headers = {}, wrongHostname = false, timeoutMs = 10_000, signal } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10_000, 'A bounded HTTP request deadline is required.');
  if (typeof body?.password === 'string') hidden.add(body.password);
  if (cookie) { hidden.add(cookie); hidden.add(cookie.slice(cookie.indexOf('=') + 1)); }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callback(value);
    };
    const fail = (error) => settle(reject, Object.assign(new Error('Deployment transport request failed.'), { code: error?.code ?? 'TRANSPORT_FAILURE' }));
    const url = new URL(path, origin);
    assert.equal(url.origin, new URL(origin).origin);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method, agent: false, timeout: timeoutMs, ...(signal ? { signal } : {}),
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
      ...(url.protocol === 'https:' ? { ca, rejectUnauthorized: true,
        ...(wrongHostname ? { checkServerIdentity: (_hostname, certificate) => checkServerIdentity('invalid.courier.localhost', certificate) } : {}) } : {}),
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...headers },
    }, (response) => {
      // A socket reset after the headers is an IncomingMessage error, rather
      // than necessarily a ClientRequest error. Handle both before body data.
      response.once('error', fail);
      response.once('aborted', () => fail({ code: 'ECONNRESET' }));
      const certificate = url.protocol === 'https:' ? response.socket?.getPeerCertificate()?.raw : undefined;
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { request.destroy(new Error('response limit')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try { value = JSON.parse(text); } catch { value = null; }
        const handler = response.headers['x-instance-id'];
        settle(resolve, { status: response.statusCode, headers: response.headers, value, text,
          handler: typeof handler === 'string' && UUID.test(handler) ? handler : null,
          certificate });
      });
    });
    // Socket inactivity alone does not bound a slowly streaming response.
    // This timer terminates the actual request rather than abandoning a race.
    timer = setTimeout(() => request.destroy(Object.assign(new Error('request deadline'), { code: 'ETIMEDOUT' })), timeoutMs);
    timer.unref();
    request.once('timeout', () => request.destroy(new Error('request deadline')));
    request.once('error', fail);
    request.end(data);
  });
}

async function eventually(probe, predicate, description, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await probe();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timeout: ${description}`);
}

export async function verifyDeployment(environment) {
  phase = 'TLS, container and shared HTTPS API';
  const httpsUrl = deploymentOrigin(environment.httpsOrigin, 'https:');
  const httpUrl = deploymentOrigin(environment.httpOrigin, 'http:');
  const ca = await readFile(environment.caPath);
  const traces = [];
  const checks = [];
  activeProof = { traces, checks };
  const invoke = async (action, path, options = {}) => {
    const started = performance.now();
    const result = await requestDeployment(httpsUrl, ca, { path, ...options });
    traces.push(safeTrace({ action, handler: result.handler, status: result.status,
      ...(result.value?.id && UUID.test(result.value.id) ? { jobId: result.value.id } : {}),
      ...(result.value?.executedBy ? { executedBy: result.value.executedBy } : {}),
      ...(['queued', 'running', 'completed', 'cancelled', 'failed'].includes(result.value?.status) ? { jobStatus: result.value.status } : {}),
      ...(result.value?.error?.reason ? { failureReason: result.value.error.reason } : {}), elapsedMs: Math.round(performance.now() - started) }));
    const faultConvergence = phase !== 'TLS, container and shared HTTPS API' && [502, 503, 504].includes(result.status);
    if (path.startsWith('/api/')) assert.ok(result.handler || result.status === 503 || faultConvergence,
      `API response ${result.status} is missing its real process UUID.`);
    return result;
  };
  const owned = async () => {
    const namespace = await environment.kubectl(['get', 'namespace', environment.namespace, '-o', 'json'], { json: true });
    assertOwnedDeployment(environment, namespace);
    await environment.assertOwned();
  };
  const pods = () => environment.kubectl(['get', 'pods', '-l', APP_SELECTOR, '-o', 'json'], { json: true }).then((value) => value.items);
  const execApp = async (pod, source) => JSON.parse(await environment.kubectl([
    'exec', pod, '-c', 'app', '--', 'node', '--input-type=module', '-e', source,
  ], { timeoutMs: 15_000 }));
  const podForInstance = async (instanceId) => {
    for (const pod of await pods()) {
      const value = await execApp(pod.metadata.name, `const response=await fetch('http://127.0.0.1:3000/api/health');console.log(JSON.stringify(await response.json()));`);
      if (value.instanceId === instanceId) return pod;
    }
    throw new Error('A live owned pod must match the actual instance UUID.');
  };
  const waitReplicas = async () => eventually(async () => {
    try {
      const values = await pods();
      const endpoints = await environment.kubectl(['get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'], { json: true });
      assertReadyReplicas(values, endpoints.items, environment.image);
      return values;
    } catch { return null; }
  }, Boolean, 'two Ready replacement replicas', 120_000);
  const observeBoth = async (path, cookie, expected = 200) => {
    const seen = new Set();
    await eventually(async () => {
      let response;
      try { response = await invoke('observe both handlers', path, { cookie }); }
      catch (error) {
        if (phase !== 'TLS, container and shared HTTPS API' && error?.message === 'Deployment transport request failed.') return seen;
        throw error;
      }
      if ([502, 503, 504].includes(response.status)) return seen;
      assert.equal(response.status, expected);
      if (response.handler) seen.add(response.handler);
      return seen;
    }, (value) => value.size === 2, 'both actual load-balanced handlers');
    return seen;
  };
  const detail = async (id, cookie) => {
    const response = await invoke('read job', `/api/jobs/${id}`, { cookie });
    assert.equal(response.status, 200);
    return response;
  };
  const terminal = (id, cookie, timeout = 45_000) => eventually(() => detail(id, cookie),
    (response) => ['completed', 'failed', 'cancelled'].includes(response.value.status), 'persisted terminal job', timeout);
  const searching = (id, cookie) => eventually(() => detail(id, cookie),
    (response) => response.value.status === 'running' && response.value.progress.completedIterations > 0, 'real pending search', 25_000);
  const create = async (input, cookie) => {
    const response = await invoke('create job', '/api/jobs', { method: 'POST', body: input, cookie, headers: { Origin: httpsUrl.origin } });
    assert.equal(response.status, 202);
    assert.equal(response.value.status, 'queued');
    return response;
  };
  const cancel = (id, cookie) => invoke('cancel job', `/api/jobs/${id}/cancel`, { method: 'POST', body: {}, cookie, headers: { Origin: httpsUrl.origin } });
  const square = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 10_000, seed: 0 };
  const heavy = (seed) => {
    let state = seed >>> 0;
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000 * 2000 - 1000; };
    return { warehouse: { x: 0, y: 0 }, points: Array.from({ length: 500 }, () => ({ x: next(), y: next() })), iterations: 200_000_000, seed };
  };

  await owned();
  await waitReplicas();
  await environment.sql(`CREATE TABLE deployment_claim_audit(job_id uuid NOT NULL,instance_id uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE FUNCTION deployment_record_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.status='queued' AND NEW.status='running' THEN INSERT INTO deployment_claim_audit(job_id,instance_id) VALUES(NEW.id,NEW.instance_id); END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER deployment_record_claim AFTER UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION deployment_record_claim();`);
  const handlers = new Set();
  await eventually(async () => {
    const response = await invoke('health', '/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.value.instanceId, response.handler);
    handlers.add(response.handler);
    return handlers;
  }, (value) => value.size === 2, 'two independently running UUID handlers');
  const trusted = await requestDeployment(httpsUrl, ca, { path: '/api/health' });
  assert.ok(trusted.certificate);
  const certificate = new X509Certificate(trusted.certificate);
  assert.ok(certificate.checkHost(httpsUrl.hostname));
  assert.ok(Date.parse(certificate.validTo) > Date.now());
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  await assert.rejects(requestDeployment(httpsUrl, []), (error) => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_SIGNATURE_FAILURE'].includes(error.code));
  await assert.rejects(requestDeployment(httpsUrl, ca, { wrongHostname: true }), (error) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  const redirect = await requestDeployment(httpUrl, undefined, { path: '/api/auth/me' });
  assert.ok([301, 302, 307, 308].includes(redirect.status));
  assert.equal(new URL(redirect.headers.location).origin, httpsUrl.origin);
  checks.push('two real Ready endpoints, trusted TLS, wrong CA/hostname rejected and correct HTTP redirect');

  for (const pod of await pods()) {
    const runtime = await execApp(pod.metadata.name, `import {existsSync} from 'node:fs';
      console.log(JSON.stringify({uid:process.getuid(),source:existsSync('/app/src'),tsx:existsSync('/app/node_modules/tsx'),
      typescript:existsSync('/app/node_modules/typescript'),vite:existsSync('/app/node_modules/vite'),
      server:existsSync('/app/dist/server/index.js'),worker:existsSync('/app/dist/server/route/worker.js'),
      migrations:existsSync('/app/dist/migrations/003_executor_registry.sql')&&existsSync('/app/dist/migrations/004_executor_metadata.sql')&&existsSync('/app/dist/server/admin-role.js')}));`);
    assert.notEqual(runtime.uid, 0);
    assert.deepEqual(runtime, { uid: runtime.uid, source: false, tsx: false, typescript: false, vite: false, server: true, worker: true, migrations: true });
  }
  const cli = await execApp((await pods())[0].metadata.name, `import{spawnSync}from'node:child_process';const r=spawnSync(process.execPath,['/app/dist/server/route/cli.js'],{cwd:'/tmp',env:{},encoding:'utf8'});let v;try{v=JSON.parse(r.stdout)}catch{}console.log(JSON.stringify({exit:r.status,status:v?.status,length:v?.result?.length,seed:v?.result?.seed}));`);
  assert.deepEqual(cli, { exit: 0, status: 'completed', length: 4, seed: 0 });
  checks.push('both production containers are nonroot and include compiled runtime without source/dev tools');
  const page = await requestDeployment(httpsUrl, ca);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="route-form"/u);
  const assets = [...new Set(page.text.match(/\/assets\/[^"\s<>]+\.(?:js|css)/gu) ?? [])];
  assert.ok(assets.some((asset) => asset.endsWith('.js')) && assets.some((asset) => asset.endsWith('.css')));
  for (const asset of assets) {
    const resource = await requestDeployment(httpsUrl, ca, { path: asset });
    assert.equal(resource.status, 200);
    assert.doesNotMatch(resource.text, /postgres(?:ql)?:\/\/[^\s"']+/iu);
  }
  const username = `deploy_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('base64url');
  const registered = await invoke('register', '/api/auth/register', { method: 'POST', body: { username, password }, headers: { Origin: httpsUrl.origin } });
  assert.equal(registered.status, 201);
  const login = await invoke('login', '/api/auth/login', { method: 'POST', body: { username, password }, headers: { Origin: httpsUrl.origin } });
  assert.equal(login.status, 200);
  const cookie = secureSessionCookie(login.headers);
  await observeBoth('/api/auth/me', cookie);
  const otherUsername = `other_${randomBytes(6).toString('hex')}`;
  assert.equal((await invoke('register second owner', '/api/auth/register', { method: 'POST', body: { username: otherUsername, password }, headers: { Origin: httpsUrl.origin } })).status, 201);
  const otherLogin = await invoke('login second owner', '/api/auth/login', { method: 'POST', body: { username: otherUsername, password }, headers: { Origin: httpsUrl.origin } });
  const otherCookie = secureSessionCookie(otherLogin.headers);
  const invalidOrigin = await invoke('reject foreign origin', '/api/jobs', { method: 'POST', body: square, cookie,
    headers: { Origin: 'https://invalid.localhost', 'X-Forwarded-Host': httpsUrl.host, 'X-Forwarded-Proto': 'https' } });
  assert.equal(invalidOrigin.status, 403);
  checks.push('one Secure HttpOnly host-only session works on both handlers and forged forwarded headers cannot bypass Origin');

  const first = await create(heavy(42), cookie);
  const firstRunning = await searching(first.value.id, cookie);
  const second = await create(heavy(43), cookie);
  const secondRunning = await searching(second.value.id, cookie);
  assert.notEqual(firstRunning.value.executedBy, secondRunning.value.executedBy);
  assert.deepEqual(new Set([firstRunning.value.executedBy, secondRunning.value.executedBy]), handlers);
  const third = await create(heavy(44), cookie);
  const queuedHandlers = new Set();
  const queuePredictions = [];
  await eventually(async () => {
    const response = await detail(third.value.id, cookie);
    assert.equal(response.value.status, 'queued');
    assert.equal(response.value.queue.executorCount, 2);
    assert.ok(Number.isSafeInteger(response.value.queue.estimatedWaitMs) && response.value.queue.estimatedWaitMs > 0);
    queuedHandlers.add(response.handler);
    queuePredictions.push(response.value.queue);
    return queuedHandlers;
  }, (value) => value.size === 2, 'both handlers serve one queued ETA');
  assert.equal((await invoke('health while two busy', '/api/health')).status, 200);
  const slots = await environment.sql(`SELECT instance_id,busy,current_job_id FROM executor_registry WHERE accepting_claims AND expires_at>clock_timestamp()`);
  assert.equal(slots.length, 2);
  assert.ok(slots.every((slot) => slot.busy));
  assert.deepEqual(new Set(slots.map((slot) => slot.current_job_id)), new Set([first.value.id, second.value.id]));
  const busyEndpoints = await environment.kubectl(['get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'], { json: true });
  assertReadyReplicas(await pods(), busyEndpoints.items, environment.image);
  const fourth = await create(heavy(45), otherCookie);
  const systemFull = await invoke('reject full shared system queue', '/api/jobs', { method: 'POST', body: square, cookie: otherCookie, headers: { Origin: httpsUrl.origin } });
  assert.equal(systemFull.status, 503);
  assert.equal(systemFull.value.code, 'SYSTEM_OUTSTANDING_LIMIT');
  const personalFull = await invoke('reject personal active quota', '/api/jobs', { method: 'POST', body: square, cookie, headers: { Origin: httpsUrl.origin } });
  assert.equal(personalFull.status, 429);
  assert.equal(personalFull.value.code, 'USER_ACTIVE_LIMIT');
  assert.equal((await cancel(fourth.value.id, otherCookie)).value.status, 'cancelled');
  let crossCancel;
  for (const victim of [firstRunning.value, secondRunning.value]) {
    assert.equal((await detail(victim.id, cookie)).value.status, 'running');
    const response = await cancel(victim.id, cookie);
    assert.ok([200, 202].includes(response.status));
    const outcome = await terminal(victim.id, cookie);
    assert.equal(outcome.value.status, 'cancelled');
    if (verifiedCrossCancellation(victim, response, outcome)) crossCancel = safeTrace({ action: 'cross-process cancel', handler: response.handler,
      executedBy: victim.executedBy, jobId: victim.id, status: response.status, jobStatus: outcome.value.status });
  }
  const thirdRunning = await searching(third.value.id, cookie);
  assert.equal(thirdRunning.value.queue, undefined);
  const queueStart = { jobId: third.value.id, executedBy: thirdRunning.value.executedBy,
    startedAt: thirdRunning.value.startedAt, predictions: queuePredictions.map((prediction) => {
      const actualWaitMs = Date.parse(thirdRunning.value.startedAt) - Date.parse(prediction.calculatedAt);
      assert.ok(Number.isFinite(actualWaitMs) && actualWaitMs >= 0);
      return { ...prediction, actualWaitMs };
    }), context: 'The initial workers were intentionally cancelled; the queued target started after the physical slot release.' };
  const thirdClaims = await environment.sql('SELECT instance_id FROM deployment_claim_audit WHERE job_id=$1', [third.value.id]);
  assert.equal(thirdClaims.length, 1, 'A real database trigger must observe exactly one committed queued→running claim.');
  assert.equal(thirdClaims[0].instance_id, thirdRunning.value.executedBy);
  for (let attempt = 0; !crossCancel && attempt < 4; attempt++) {
    // A bounded separate scenario is permitted when the first safe cancel
    // happened to hit the worker's own handler; never retry a failed POST.
    const extra = await create(heavy(70 + attempt), cookie);
    const active = await searching(extra.value.id, cookie);
    const response = await cancel(extra.value.id, cookie);
    assert.ok([200, 202].includes(response.status));
    const outcome = await terminal(extra.value.id, cookie);
    assert.equal(outcome.value.status, 'cancelled');
    if (verifiedCrossCancellation(active.value, response, outcome)) crossCancel = safeTrace({ action: 'cross-process cancel',
      handler: response.handler, executedBy: active.value.executedBy, jobId: active.value.id, status: response.status, jobStatus: outcome.value.status });
  }
  assert.ok(crossCancel, 'At least one real cancellation must be handled by a different process.');
  await cancel(third.value.id, cookie);
  await terminal(third.value.id, cookie);
  checks.push('two real workers, accepted third queued with ETA through both handlers, cross-process physical cancel and released slot');

  const resultJob = await create(square, cookie);
  const result = await terminal(resultJob.value.id, cookie);
  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.result.length, 4);
  assert.equal(result.value.result.seed, 0);
  await observeBoth(`/api/jobs/${resultJob.value.id}`, cookie);
  assert.equal((await invoke('reject foreign detail', `/api/jobs/${resultJob.value.id}`, { cookie: otherCookie })).status, 404);
  assert.equal((await cancel(resultJob.value.id, otherCookie)).status, 404);
  checks.push('saved square result survives handler changes and a second owner cannot read/cancel it');
  const beforeRace = Number((await environment.sql('SELECT count(*)::text AS count FROM jobs'))[0].count);
  const quotaRace = await Promise.all([61, 62, 63, 64].map((seed) => invoke('concurrent quota admission', '/api/jobs', {
    method: 'POST', body: heavy(seed), cookie, headers: { Origin: httpsUrl.origin },
  })));
  assert.deepEqual(quotaRace.map((response) => response.status).sort(), [202, 202, 202, 429]);
  assert.equal(quotaRace.find((response) => response.status === 429).value.code, 'USER_ACTIVE_LIMIT');
  assert.equal(new Set(quotaRace.map((response) => response.handler)).size, 2);
  assert.equal(Number((await environment.sql('SELECT count(*)::text AS count FROM jobs'))[0].count), beforeRace + 3);
  const admitted = quotaRace.filter((response) => response.status === 202);
  await Promise.all(admitted.map((response) => cancel(response.value.id, cookie)));
  await Promise.all(admitted.map((response) => terminal(response.value.id, cookie)));
  checks.push('parallel admission across both TLS handlers respects shared personal and bounded system quotas without extra records');

  return { checks, traces, crossCancel, queuePredictions, queueStart, instanceIds: [...handlers], resultJobId: resultJob.value.id,
    cookie, loginHandler: login.handler, ca, spki, invoke, create, searching, terminal, cancel, detail, heavy, square,
    pods, podForInstance, waitReplicas, owned, execApp, observeBoth };
}

export async function verifyDeploymentFaults(environment, proof) {
  phase = 'owned graceful busy pod replacement';
  const { checks, traces, cookie, invoke, create, searching, terminal, heavy, square, pods, podForInstance,
    waitReplicas, owned, execApp, observeBoth, resultJobId } = proof;
  const faultEvidence = [];
  activeProof.faultEvidence = faultEvidence;
  const resilientDetail = async (id) => {
    try {
      const response = await invoke('safe convergence read', `/api/jobs/${id}`, { cookie });
      if ([502, 503, 504].includes(response.status)) return null;
      assert.equal(response.status, 200);
      return response;
    } catch (error) {
      if (error?.message === 'Deployment transport request failed.') {
        traces.push({ action: 'transient safe GET transport failure', status: 0 });
        return null;
      }
      throw error;
    }
  };
  const waitTerminal = (id, timeout = 90_000) => eventually(() => resilientDetail(id),
    (response) => response && ['completed', 'cancelled', 'failed'].includes(response.value.status), 'terminal after owned fault', timeout);
  await owned();
  const graceful = await create(heavy(51), cookie);
  const gracefulRunning = await searching(graceful.value.id, cookie);
  const gracefulPod = await podForInstance(gracefulRunning.value.executedBy);
  const gracefulStart = performance.now();
  await owned();
  await environment.kubectl(['delete', 'pod', gracefulPod.metadata.name, '--grace-period=10', '--wait=false'], { timeoutMs: 15_000 });
  const stopped = await waitTerminal(graceful.value.id);
  assert.equal(stopped.value.status, 'failed');
  assert.equal(stopped.value.error.reason, 'server_shutdown');
  const registry = await environment.sql('SELECT accepting_claims FROM executor_registry WHERE instance_id=$1', [gracefulRunning.value.executedBy]);
  assert.ok(registry.length === 0 || registry.every((row) => !row.accepting_claims));
  const replacements = await waitReplicas();
  assert.ok(replacements.every((pod) => pod.metadata.uid !== gracefulPod.metadata.uid));
  const freshHandlers = await observeBoth('/api/auth/me', cookie);
  assert.ok(!freshHandlers.has(gracefulRunning.value.executedBy));
  faultEvidence.push({ scenario: 'graceful busy pod replacement', oldInstance: gracefulRunning.value.executedBy,
    jobId: graceful.value.id, outcome: stopped.value.error.reason, elapsedMs: Math.round(performance.now() - gracefulStart), replacementInstances: [...freshHandlers] });
  checks.push('graceful busy pod SIGTERM persists server_shutdown and Deployment replaces it without losing the session');

  phase = 'owned abrupt pod loss, TTL and persisted deadline';
  const killed = await create(heavy(52), cookie);
  const killedRunning = await searching(killed.value.id, cookie);
  const killedPod = await podForInstance(killedRunning.value.executedBy);
  const oldRestartCount = killedPod.status.containerStatuses.find((container) => container.name === 'app').restartCount;
  const deadlines = await environment.sql('SELECT j.lost_after,r.expires_at,clock_timestamp() AS observed_at FROM jobs j JOIN executor_registry r ON r.instance_id=j.instance_id WHERE j.id=$1', [killed.value.id]);
  assert.equal(deadlines.length, 1);
  await owned();
  const killedAt = performance.now();
  // Direct task SIGKILL comes from the verified kind node runtime. CRI
  // StopContainer / zero-grace delete may still send SIGTERM first, which
  // would exercise graceful shutdown rather than the intended crash case.
  assert.equal(typeof environment.killAppProcess, 'function');
  await environment.killAppProcess(killedPod.metadata.name);
  await eventually(pods, (values) => values.find((pod) => pod.metadata.uid === killedPod.metadata.uid)?.status.containerStatuses
    ?.find((container) => container.name === 'app')?.restartCount > oldRestartCount, 'actual directly killed container restart', 90_000);
  await waitReplicas();
  const restartHandlers = await observeBoth('/api/auth/me', cookie);
  assert.ok(!restartHandlers.has(killedRunning.value.executedBy));
  await eventually(() => environment.sql('SELECT expires_at<=clock_timestamp() AS expired FROM executor_registry WHERE instance_id=$1', [killedRunning.value.executedBy]),
    (rows) => rows.length === 1 && rows[0].expired, 'genuine DB lease expiry', 70_000);
  const orphan = await resilientDetail(killed.value.id);
  assert.ok(orphan && orphan.value.status === 'running', 'TTL alone must not shorten the persisted lost_after.');
  assert.equal(orphan.value.executedBy, killedRunning.value.executedBy);
  const lost = await waitTerminal(killed.value.id, 90_000);
  assert.equal(lost.value.status, 'failed');
  assert.equal(lost.value.error.reason, 'worker_lost');
  assert.equal(lost.value.executedBy, killedRunning.value.executedBy);
  assert.equal(lost.value.startedAt, killedRunning.value.startedAt);
  assert.ok(Number.isFinite(Date.parse(lost.value.finishedAt)) && Date.parse(lost.value.finishedAt) >= Date.parse(deadlines[0].lost_after),
    'Lost work must become terminal only after the exact persisted database deadline.');
  assert.equal((await environment.sql('SELECT job_id FROM deployment_claim_audit WHERE job_id=$1', [killed.value.id])).length, 1);
  faultEvidence.push({ scenario: 'abrupt process loss', oldInstance: killedRunning.value.executedBy, jobId: killed.value.id,
    persistedLostAfter: deadlines[0].lost_after, leaseExpiresAt: deadlines[0].expires_at,
    outcome: lost.value.error.reason, elapsedMs: Math.round(performance.now() - killedAt), replacementInstances: [...restartHandlers] });
  checks.push('SIGKILL restarts the container; stale capacity expires at TTL and the original job becomes worker_lost only after lost_after');

  phase = 'own PostgreSQL PVC restart and public 503';
  const volumes = await environment.kubectl(['get', 'pvc', '-o', 'json'], { json: true });
  const volumeIds = volumes.items.map((volume) => volume.metadata.uid).sort();
  assert.ok(volumeIds.length > 0);
  const before = await resilientDetail(resultJobId);
  assert.ok(before?.value.result);
  await owned();
  const pgRestartAt = performance.now();
  await environment.kubectl(['scale', 'statefulset', 'postgres', '--replicas=0'], { timeoutMs: 15_000 });
  await eventually(() => environment.kubectl(['get', 'pods', '-l', PG_SELECTOR, '-o', 'json'], { json: true }),
    (value) => value.items.length === 0, 'own PostgreSQL stop with PVC retained', 90_000);
  const publicUnavailable = await eventually(async () => {
    try { return await requestDeployment(environment.httpsOrigin, proof.ca, { path: '/api/health' }); }
    catch { return null; }
  }, (response) => response?.status === 503 && response.handler === null, 'public Traefik 503 with no Ready app endpoints', 45_000);
  traces.push({ action: 'intentional public Traefik no-Ready-endpoint response', status: publicUnavailable.status, handler: null });
  const localStatuses = [];
  for (const pod of await pods()) {
    const statuses = await execApp(pod.metadata.name, `const statuses=[];for(const path of ['/api/health','/api/ready']){const r=await fetch('http://127.0.0.1:3000'+path);statuses.push(r.status)}console.log(JSON.stringify(statuses));`);
    assert.deepEqual(statuses, [200, 503]);
    localStatuses.push(statuses);
  }
  await owned();
  await environment.kubectl(['scale', 'statefulset', 'postgres', '--replicas=1'], { timeoutMs: 15_000 });
  await waitReplicas();
  const afterVolumes = await environment.kubectl(['get', 'pvc', '-o', 'json'], { json: true });
  assert.deepEqual(afterVolumes.items.map((volume) => volume.metadata.uid).sort(), volumeIds);
  await observeBoth('/api/auth/me', cookie);
  const after = await resilientDetail(resultJobId);
  assert.deepEqual(after.value.result, before.value.result);
  const afterRestartJob = await create(square, cookie);
  assert.equal((await terminal(afterRestartJob.value.id, cookie)).value.status, 'completed');
  faultEvidence.push({ scenario: 'own PostgreSQL stop/restart on same PVC', elapsedMs: Math.round(performance.now() - pgRestartAt),
    retainedPvcCount: volumeIds.length, resultJobId, publicStatus: publicUnavailable.status, localHealthReadyStatuses: localStatuses });
  checks.push('PostgreSQL PVC restart preserves accounts/sessions/results; no Ready endpoints yields public 503 while local health stays 200');

  phase = 'cross-handler logout and shared revocation';
  // Safely observe routing before the single logout mutation. No retry
  // middleware repeats logout or any other POST during a transport failure.
  const currentHandlers = await observeBoth('/api/auth/me', cookie);
  if (currentHandlers.has(proof.loginHandler)) await eventually(async () => invoke('observe handler before logout', '/api/auth/me', { cookie }),
    (response) => response.status === 200 && response.handler === proof.loginHandler, 'handler before cross-process logout');
  const logout = await invoke('logout', '/api/auth/logout', { method: 'POST', body: {}, cookie,
    headers: { Origin: new URL(environment.httpsOrigin).origin } });
  assert.equal(logout.status, 204);
  assert.notEqual(logout.handler, proof.loginHandler);
  const removal = logout.headers['set-cookie']?.find((value) => value.startsWith('courier_session='));
  assert.ok(removal && /courier_session=;/u.test(removal) && /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/iu.test(removal));
  assert.match(removal, /;\s*Secure(?:;|$)/iu);
  assert.match(removal, /;\s*HttpOnly(?:;|$)/iu);
  await observeBoth('/api/auth/me', cookie, 401);
  await observeBoth('/api/jobs', cookie, 401);
  checks.push('logout on a different handler revokes the same session on both pods and clears the secure cookie');
  return { checks, traces, faultEvidence };
}

export async function runDeployment() {
  const startedAt = performance.now();
  let environment;
  let summary;
  try {
    // Provisioning is deliberately delegated to the same reviewed local helper
    // as deploy:local; it must return a NEW owned test namespace and resources.
    const { provisionTestDeployment } = await import('./deploy-local.mjs');
    environment = await provisionTestDeployment({ ownerId: randomUUID(), namespace: `courier-route-test-${randomBytes(5).toString('hex')}`, autoscaling: false });
    const result = await verifyDeployment(environment);
    console.info(JSON.stringify({ status: 'progress', phase: 'HTTPS API and container checks passed', checks: result.checks.length }));
    const faults = await verifyDeploymentFaults(environment, result);
    console.info(JSON.stringify({ status: 'progress', phase: 'owned fault and persistence checks passed', checks: result.checks.length }));
    phase = 'real HTTPS Chrome';
    const { runDeploymentBrowser } = await import('./check-deployment-browser.mjs');
    const browser = await runDeploymentBrowser({ deployment: environment });
    summary = { status: 'pass', namespace: environment.namespace, context: environment.context, image: environment.image,
      httpsOrigin: environment.httpsOrigin, httpOrigin: environment.httpOrigin,
      checks: result.checks, traces: result.traces, faultEvidence: faults.faultEvidence,
      browser, instanceIds: result.instanceIds, crossCancel: result.crossCancel,
      queuePredictions: result.queuePredictions, queueStart: result.queueStart };
  } catch (error) {
    if (environment) {
      const directory = new URL(`../.local/deployment-tests/${environment.ownerId}/`, import.meta.url);
      await mkdir(directory, { recursive: true });
      await writeFile(new URL('failure.json', directory), JSON.stringify({ phase, reason: redactFailure(error),
        checks: activeProof?.checks ?? [], traces: activeProof?.traces ?? [], faultEvidence: activeProof?.faultEvidence ?? [] }, null, 2), { mode: 0o600 });
    }
    console.error(JSON.stringify({ status: error?.code === 'DEPLOYMENT_BLOCKED' ? 'blocked' : 'failed',
      phase, reason: error?.code === 'DEPLOYMENT_BLOCKED' ? 'Local container/Kubernetes prerequisite is unavailable.' : redactFailure(error) }));
    process.exitCode = error?.code === 'DEPLOYMENT_BLOCKED' ? 2 : 1;
  } finally {
    if (environment) await environment.cleanup().catch(() => { console.error('Owned deployment cleanup failed.'); process.exitCode = 1; });
  }
  if (summary && !process.exitCode) {
    summary.cleanupCompleted = true;
    summary.elapsedMs = Math.round(performance.now() - startedAt);
    summary.convergenceGatewayFailures = summary.traces.filter((item) => item.handler === null && [502, 503, 504].includes(item.status)
      && !item.action.startsWith('intentional public')).length;
    const directory = new URL(`../.local/deployment-tests/${environment.ownerId}/`, import.meta.url);
    await mkdir(directory, { recursive: true });
    const reportPath = new URL('summary.json', directory);
    await writeFile(reportPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ ...summary, traces: undefined, browser: { ...summary.browser, trace: undefined }, tracePath: reportPath.pathname }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDeployment();
