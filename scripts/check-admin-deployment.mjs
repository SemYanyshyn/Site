import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { requestDeployment, secureSessionCookie } from './check-deployment.mjs';
import { parseCpuCores, parseMemoryBytes } from './check-autoscale.mjs';
import { startAdminBrowser } from './check-admin-browser.mjs';
import { assignDeploymentRole, provisionTestDeployment, withDeploymentDeadline, withoutDeploymentDeadline } from './deploy-local.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const APP_SELECTOR = 'app.kubernetes.io/name=courier-route-app,app.kubernetes.io/component=app';
const ROLE = 'courier-route-monitor';
const square = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 1_000, seed: 0 };

/** No load/scale is added here. The shared HPA driver owns the one full cycle. */
export async function runAdminDeployment() {
  const started = performance.now(), deadlineEpochMs = Date.now() + 600_000, abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineEpochMs - Date.now());
  let deployment, adminBrowser, userBrowser, phase = 'provision', roleRules, latestOverview, summary, cleanupCompleted = false;
  const hidden = new Set(), traces = [], checks = [], evidence = { metrics: [], rbac: [], restart: null };
  const output = new URL(`../.local/admin-tests/${randomUUID()}/`, import.meta.url);
  await mkdir(output, { recursive: true, mode: 0o700 });
  function mark(value) { phase = value; console.info(JSON.stringify({ status: 'progress', phase, elapsedMs: Math.round(performance.now() - started) })); }
  function ensure() { assert.ok(!abort.signal.aborted && Date.now() < deadlineEpochMs, 'Administrator acceptance work deadline.'); }
  async function until(probe, predicate, label, timeoutMs = 45_000) {
    const end = Math.min(deadlineEpochMs, Date.now() + timeoutMs);
    while (Date.now() < end) { ensure(); const value = await probe(); if (predicate(value)) return value; await delay(400, undefined, { signal: abort.signal }); }
    throw new Error(`Administrator acceptance deadline: ${label}`);
  }
  function redact(error) {
    let message = String(error?.message ?? 'Administrator acceptance failed.').split('\n')[0];
    for (const value of hidden) if (value) message = message.replaceAll(value, '[redacted]');
    return { name: String(error?.name ?? 'Error'), message: message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[redacted database address]').slice(0, 240),
      code: typeof error?.code === 'string' ? error.code : null,
      location: String(error?.stack ?? '').split('\n').find(line => /check-admin-(?:deployment|browser)\.mjs:\d+/u.test(line))?.trim() };
  }
  async function diagnostics(reason) {
    let pods = [], registry = [], forwarding = null, browser = null;
    if (adminBrowser) browser = await adminBrowser.diagnostics().catch(() => null);
    if (deployment) {
      await deployment.assertOwned();
      pods = (await deployment.kubectl(['get', 'pods', '-l', APP_SELECTOR, '-o', 'json'], { json: true, timeoutMs: 10_000 })).items.map(pod => ({
        name: pod.metadata.name, uid: pod.metadata.uid, phase: pod.status.phase, terminating: !!pod.metadata.deletionTimestamp,
        ready: pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'),
        app: pod.status.containerStatuses?.filter(container => container.name === 'app').map(container => ({ restartCount: container.restartCount,
          ready: container.ready, runningSince: container.state?.running?.startedAt ?? null, terminationReason: container.lastState?.terminated?.reason ?? null })) }));
      registry = await deployment.sql('SELECT instance_id,pod_uid,pod_name,pod_namespace,started_at,last_seen_at,expires_at,accepting_claims,busy,current_job_id FROM executor_registry ORDER BY started_at DESC LIMIT 20');
      forwarding = deployment.forwardingInfo();
    }
    await writeFile(new URL('failure.json', output), JSON.stringify({ phase, reason: redact(reason), checks, traces, evidence, latestOverview, pods, registry, forwarding, browser }, null, 2), { mode: 0o600 });
  }
  try {
    await withDeploymentDeadline(deadlineEpochMs, async () => {
      deployment = await provisionTestDeployment({ ownerId: randomUUID(), namespace: `courier-route-test-admin-${randomBytes(4).toString('hex')}`, autoscaling: false });
      const ca = await readFile(deployment.caPath);
      const call = async (path, options = {}) => {
        ensure();
        try {
          const reply = await requestDeployment(deployment.httpsOrigin, ca, { path, signal: abort.signal, ...options,
            ...(options.method === 'POST' ? { headers: { Origin: new URL(deployment.httpsOrigin).origin, ...options.headers } } : {}) });
          traces.push({ phase, path: path.split('?')[0], method: options.method ?? 'GET', status: reply.status, handler: reply.handler });
          assert.equal(reply.headers['cache-control'], path.startsWith('/api/admin/') ? 'no-store' : reply.headers['cache-control']);
          return reply;
        } catch (error) {
          traces.push({ phase, path: path.split('?')[0], method: options.method ?? 'GET', status: 0, code: error?.code ?? null });
          // A transport failure is diagnosed before cleanup; POST is never retried.
          await diagnostics(error).catch(() => {}); throw error;
        }
      };
      const api = (path, cookie) => call(path, cookie ? { cookie } : {});
      const overview = async (cookie) => { const reply = await api('/api/admin/overview', cookie); assert.equal(reply.status, 200); latestOverview = reply.value; return reply.value; };
      const user = async (index) => {
        const credentials = { username: `admincheck_${index}_${randomBytes(4).toString('hex')}`, password: `Block09 ${randomBytes(24).toString('base64url')} valid` };
        hidden.add(credentials.password);
        const spoof = await call('/api/auth/register', { method: 'POST', body: { ...credentials, role: 'admin' } }); assert.equal(spoof.status, 400);
        const register = await call('/api/auth/register', { method: 'POST', body: credentials });
        assert.equal(register.status, 201); assert.equal(register.value.user.role, 'user');
        const login = await call('/api/auth/login', { method: 'POST', body: credentials }); assert.equal(login.status, 200);
        const cookie = secureSessionCookie(login.headers); hidden.add(cookie); hidden.add(cookie.slice(cookie.indexOf('=') + 1));
        return { credentials, cookie, user: login.value.user };
      };
      const create = async (owner, input) => { const reply = await call('/api/jobs', { method: 'POST', body: input, cookie: owner.cookie }); assert.equal(reply.status, 202); return reply.value; };
      const terminal = (owner, id) => until(() => api(`/api/jobs/${id}`, owner.cookie), reply => reply.status === 200 && ['completed', 'cancelled', 'failed'].includes(reply.value.status), 'owner terminal', 60_000);
      const both = async (path, cookie, expectedStatus = 200) => {
        const handlers = new Set();
        await until(async () => { const reply = await api(path, cookie); assert.equal(reply.status, expectedStatus); assert.match(reply.handler ?? '', UUID); handlers.add(reply.handler); return handlers; }, set => set.size === 2, 'two independent HTTPS handlers', 20_000);
        return [...handlers];
      };
      const grant = role => assignDeploymentRole({ namespace: deployment.namespace, ownerId: deployment.ownerId, username: adminAccount.credentials.username, role });
      mark('authorization and explicit operator role');
      const [ownerA, ownerB, adminAccount] = await Promise.all([user(1), user(2), user(3)]);
      for (const path of ['/api/admin/overview', '/api/admin/jobs']) { assert.equal((await api(path)).status, 401); await both(path, ownerA.cookie, 403); }
      await grant('admin'); await grant('admin');
      await both('/api/admin/overview', adminAccount.cookie); await both('/api/admin/jobs', adminAccount.cookie);
      assert.equal((await api('/api/auth/me', adminAccount.cookie)).value.user.role, 'admin');
      checks.push('HTTPS shared sessions and explicit role CLI: anonymous401, public user403 on both endpoints/handlers, JSON role spoof rejected400, idempotent admin grant');
      mark('real Chrome normal-user denial and administrator snapshot');
      userBrowser = await startAdminBrowser({ deployment, credentials: ownerA.credentials, deadlineEpochMs });
      assert.equal((await userBrowser.api('/api/admin/jobs')).status, 403); await userBrowser.cleanup(); userBrowser = undefined;
      adminBrowser = await startAdminBrowser({ deployment, credentials: adminAccount.credentials, deadlineEpochMs });
      let first = await until(() => overview(adminAccount.cookie), value => value.servers.length === 2 && value.servers.every(server => server.ready && server.executor?.fresh && server.metric && !server.metric.stale), 'fresh physical two pod metrics', 60_000);
      const instanceIds = first.servers.map(server => server.executor.instanceId);
      assert.equal(new Set(instanceIds).size, 2); assert.equal(new Set(first.servers.map(server => server.uid)).size, 2);
      assert.ok(first.servers.every(server => server.executor.podUid === server.uid && server.executor.podName === server.name && server.executor.podNamespace === deployment.namespace));
      const raw = await deployment.kubectl(['get', '--raw', `/apis/metrics.k8s.io/v1beta1/namespaces/${deployment.namespace}/pods?labelSelector=${encodeURIComponent(APP_SELECTOR)}`], { json: true });
      for (const server of first.servers) {
        const same = raw.items.find(item => item.metadata.name === server.name && item.timestamp === server.metric.timestamp);
        if (same) { const usage = same.containers.find(container => container.name === 'app').usage;
          assert.equal(server.metric.cpuCores, parseCpuCores(usage.cpu)); assert.equal(server.metric.memoryBytes, parseMemoryBytes(usage.memory)); }
        evidence.metrics.push({ podUid: server.uid, podName: server.name, instanceId: server.executor.instanceId, sample: server.metric,
          rawTimestamp: raw.items.find(item => item.metadata.name === server.name)?.timestamp ?? null, exactSampleMatch: !!same });
      }
      assert.ok(evidence.metrics.some(item => item.exactSampleMatch), 'At least one timestamp-identical raw sample must match exactly.');
      const top = await deployment.kubectl(['top', 'pods', '--containers']); assert.ok(first.servers.every(server => top.includes(server.name)));
      await adminBrowser.observe({ phase: 'baseline', expectedInstanceIds: instanceIds, width: 1280 });
      checks.push('real podUID/processUUID mapping and app CPU/RAM timestamp/window match raw Metrics API; kubectl top covers same pod/container; desktop Chrome snapshot');
      mark('real owner computation and bounded monitoring fixtures');
      const resultA = await terminal(ownerA, (await create(ownerA, square)).id); assert.equal(resultA.value.status, 'completed');
      const resultB = await terminal(ownerB, (await create(ownerB, square)).id); assert.equal(resultB.value.status, 'completed');
      assert.equal((await api(`/api/jobs/${resultA.value.id}`, ownerB.cookie)).status, 404);
      const fixtures = Array.from({ length: 26 }, (_, n) => ({ id: randomUUID(), user_id: n % 2 ? ownerA.user.id : ownerB.user.id,
        input: resultA.value.input, result: resultA.value.result, instance_id: resultA.value.executedBy, claim_token: randomUUID() }));
      await deployment.sql(`WITH t AS (SELECT clock_timestamp() AS now), rows AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,user_id uuid,input jsonb,result jsonb,instance_id uuid,claim_token uuid))
        INSERT INTO jobs(id,user_id,input,status,progress_stage,completed_iterations,total_iterations,progress_percent,created_at,updated_at,started_at,finished_at,instance_id,claim_token,timeout_ms,lost_after,result)
        SELECT id,user_id,input,'completed','finishing',1000,1000,100,t.now,t.now,t.now-interval '1 millisecond',t.now,instance_id,claim_token,30000,t.now+interval '60 seconds',result FROM rows CROSS JOIN t`, [JSON.stringify(fixtures)]);
      const page1 = (await api('/api/admin/jobs?limit=20&offset=0', adminAccount.cookie)).value;
      const page2 = (await api('/api/admin/jobs?limit=20&offset=20', adminAccount.cookie)).value;
      assert.equal(page1.total, 28); assert.equal(page2.total, 28); assert.equal(page1.jobs.length, 20); assert.equal(page2.jobs.length, 8);
      assert.ok(page2.jobs.every(job => !page1.jobs.some(first => first.id === job.id)));
      assert.equal(new Set([...page1.jobs, ...page2.jobs].map(job => job.owner.id)).size, 2);
      assert.doesNotMatch(JSON.stringify(page1), /password_hash|token_hash|claim_token|"input"|"result"|DATABASE_URL/u);
      await adminBrowser.pagination();
      const heavy = { warehouse: { x: 0, y: 0 }, points: Array.from({ length: 500 }, (_, n) => ({ x: (n * 619 % 997) - 499, y: (n * 283 % 991) - 495 })), iterations: 200_000_000, seed: 9 };
      const job = await create(ownerA, heavy);
      const busy = await until(() => overview(adminAccount.cookie), value => value.servers.some(server => server.executor?.runningJobIds.includes(job.id) && server.executor.busy), 'committed job in matching busy process', 15_000);
      const process = busy.servers.find(server => server.executor?.runningJobIds.includes(job.id));
      const progressing = await until(() => api(`/api/jobs/${job.id}`, ownerA.cookie), reply => reply.status === 200 && reply.value.status === 'running' && reply.value.progress.completedIterations > 0, 'real positive worker progress', 10_000);
      assert.equal(progressing.value.executedBy, process.executor.instanceId);
      const listed = (await api('/api/admin/jobs?status=running', adminAccount.cookie)).value.jobs.find(item => item.id === job.id);
      assert.equal(listed?.owner.id, ownerA.user.id); assert.equal(listed?.executedBy, process.executor.instanceId); assert.ok(listed.progress.completedIterations > 0);
      assert.equal((await api('/api/health')).status, 200);
      // A real search may finish before the next five-second UI poll. Observe
      // it with the actual manual refresh control while positive progress exists.
      await adminBrowser.click('#admin-refresh');
      await adminBrowser.waitFor(`document.querySelector('#admin-jobs [data-job-id="${job.id}"]')?.dataset.status==='running' && document.querySelector('#admin-servers').textContent.includes(${JSON.stringify(job.id)})`, 'real worker and owner job shown after manual refresh', 10_000);
      await adminBrowser.screenshot('real-job-progress.png', '#admin-jobs-title');
      const baselineCpu = first.servers.find(server => server.executor.instanceId === process.executor.instanceId)?.metric?.cpuCores ?? 0;
      const loaded = await until(() => overview(adminAccount.cookie), value => value.servers.some(server => server.executor?.instanceId === process.executor.instanceId
        && server.metric && !server.metric.stale && Date.parse(server.metric.timestamp) >= Date.parse(progressing.value.startedAt)
        && server.metric.cpuCores > Math.max(.1, baselineCpu + .05)), 'real changed CPU sample from searching app container', 30_000);
      evidence.loadedMetric = loaded.servers.find(server => server.executor?.instanceId === process.executor.instanceId).metric;
      const current = await api(`/api/jobs/${job.id}`, ownerA.cookie); assert.equal(current.status, 200);
      if (current.value.status === 'running') {
        const cancellation = await call(`/api/jobs/${job.id}/cancel`, { method: 'POST', body: {}, cookie: ownerA.cookie }); assert.equal(cancellation.status, 202);
      }
      const ended = await terminal(ownerA, job.id); assert.ok(['completed', 'cancelled'].includes(ended.value.status));
      await until(() => overview(adminAccount.cookie), value => !value.servers.some(server => server.executor?.runningJobIds.includes(job.id) || server.executor?.currentJobId === job.id), 'actual stopped slot clears', 15_000);
      evidence.realJob = { id: job.id, ownerId: ownerA.user.id, executedBy: progressing.value.executedBy, completedIterations: progressing.value.progress.completedIterations, outcome: ended.value.status };
      checks.push('two real owner completed routes, foreign404, 26 bounded terminal fixtures with tied timestamps across stable pages, filter/focus/360 Chrome, real searching worker progress/busy/changed CPU and terminal slot reconciliation');
      mark('actual least-privilege ServiceAccount authorization');
      const identity = `system:serviceaccount:${deployment.namespace}:${ROLE}`;
      // can-i intentionally exits 1 for a genuine "no". Preserve its tiny
      // public answer and exit code, rather than mistaking any child error for denial.
      async function canI(verb, resource, namespace = deployment.namespace) {
        ensure(); await deployment.assertOwned();
        const subresources = { 'pods/exec': ['pods', 'exec'], 'pods/log': ['pods', 'log'], 'deployments/scale': ['deployments.apps', 'scale'] };
        const target = subresources[resource];
        return new Promise((resolve, reject) => {
          const child = spawn('kubectl', ['--kubeconfig', deployment.kubeconfig, '--context', deployment.context, '--namespace', namespace,
            '--request-timeout=8s', 'auth', 'can-i', verb, target?.[0] ?? resource, ...(target ? ['--subresource', target[1]] : []), '--as', identity], { stdio: ['ignore', 'pipe', 'ignore'] });
          let text = '', expired = false;
          const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, Math.max(1, Math.min(10_000, deadlineEpochMs - Date.now())));
          child.stdout.on('data', chunk => { text += chunk.toString(); if (text.length > 4_096) child.kill('SIGKILL'); });
          child.once('error', () => { clearTimeout(timeout); reject(new Error('RBAC probe could not start.')); });
          child.once('close', code => {
            clearTimeout(timeout); const answer = text.trim();
            if (expired || !((code === 0 && answer === 'yes') || (code === 1 && answer === 'no'))) reject(new Error('RBAC probe did not return an explicit bounded yes/no.'));
            else resolve(answer === 'yes');
          });
        });
      }
      const permissions = [ ['get', 'pods', true], ['list', 'pods', true], ['get', 'pods.metrics.k8s.io', true], ['list', 'pods.metrics.k8s.io', true],
        ['get', 'deployments.apps/app', true], ['get', 'horizontalpodautoscalers.autoscaling/app', true], ['get', 'secrets', false], ['create', 'pods/exec', false],
        ['get', 'pods/log', false], ['patch', 'deployments/scale', false], ['delete', 'pods', false] ];
      for (const [verb, resource, expected] of permissions) {
        assert.equal(await canI(verb, resource), expected, `Explicit ${verb} ${resource} authorization must be ${expected ? 'allowed' : 'denied'}.`);
        evidence.rbac.push({ verb, resource, allowed: expected, namespace: deployment.namespace });
      }
      assert.equal(await canI('list', 'pods', 'kube-system'), false); evidence.rbac.push({ verb: 'list', resource: 'pods', allowed: false, namespace: 'kube-system' });
      const allowedPods = await deployment.kubectl(['get', 'pods', '-l', APP_SELECTOR, '--as', identity, '-o', 'json'], { json: true }); assert.equal(allowedPods.items.length, 2);
      const allowedMetrics = await deployment.kubectl(['get', 'pods.metrics.k8s.io', '-l', APP_SELECTOR, '--as', identity, '-o', 'json'], { json: true }); assert.equal(allowedMetrics.items.length, 2);
      checks.push('actual ServiceAccount can-i and safe reads allow own pods/metrics/named Deployment/HPA and deny secrets/exec/logs/scale/delete/other namespace');
      mark('narrow provider metrics403 and recovery');
      const role = await deployment.kubectl(['get', 'role', ROLE, '-o', 'json'], { json: true });
      assert.equal(role.metadata.namespace, deployment.namespace); assert.equal(role.metadata.labels['courier-route.local/owner-id'], deployment.ownerId);
      roleRules = role.rules; await both('/api/admin/overview', adminAccount.cookie);
      const beforeFault = await overview(adminAccount.cookie), faultAt = Date.now();
      await deployment.assertOwned();
      await deployment.kubectl(['patch', 'role', ROLE, '--type=json', '-p', JSON.stringify([{ op: 'test', path: '/rules', value: roleRules }, { op: 'replace', path: '/rules', value: roleRules.filter(rule => !rule.apiGroups.includes('metrics.k8s.io')) }])]);
      const partial = await until(() => overview(adminAccount.cookie), value => value.infrastructure.metrics.status === 'stale' || value.infrastructure.metrics.status === 'unavailable', 'actual provider403 partial response', 25_000);
      assert.ok(Date.parse(partial.infrastructure.metrics.observedAt) <= faultAt, 'Failed refresh must retain the original observation time.');
      evidence.metricsBeforeFault = beforeFault.infrastructure.metrics;
      assert.ok(partial.servers.every(server => server.metric === null || server.metric.stale));
      assert.equal((await api('/api/auth/me', adminAccount.cookie)).value.user.role, 'admin'); assert.equal((await api('/api/jobs', ownerA.cookie)).status, 200); assert.equal((await api('/api/ready')).status, 200);
      evidence.partial = await adminBrowser.partial();
      await deployment.assertOwned(); await deployment.kubectl(['patch', 'role', ROLE, '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/rules', value: roleRules }])]); roleRules = undefined;
      await until(() => overview(adminAccount.cookie), value => value.infrastructure.metrics.status === 'ok' && value.servers.every(server => server.metric && !server.metric.stale), 'restored fresh provider metrics', 35_000);
      checks.push('removing only own metrics rule yields real provider403 partial200/stale original time and Chrome warning without user logout; auth/tasks/readiness continue, restore recovers fresh samples');
      mark('actual container restart retains podUID and changes processUUID');
      first = await overview(adminAccount.cookie); const victim = first.servers[0], oldPod = (await deployment.kubectl(['get', 'pod', victim.name, '-o', 'json'], { json: true }));
      const oldRestarts = oldPod.status.containerStatuses.find(container => container.name === 'app').restartCount;
      await deployment.assertOwned(); await deployment.killAppProcess(victim.name);
      const after = await until(() => overview(adminAccount.cookie), value => value.servers.length === 2 && value.servers.some(server => server.uid === victim.uid && server.ready
        && server.restarts > oldRestarts && server.executor?.instanceId !== victim.executor.instanceId && server.executor?.fresh), 'same pod new actual process', 90_000);
      const replacement = after.servers.find(server => server.uid === victim.uid); assert.ok(replacement.executor);
      assert.equal(after.summary.confirmedExecutors, 2); assert.equal(after.database.queueExecutorCount, 2);
      assert.ok(after.unmatchedExecutors.some(executor => executor.instanceId === victim.executor.instanceId && executor.reason === 'previous-process'));
      assert.ok(replacement.metric === null || Date.parse(replacement.metric.timestamp) >= Date.parse(replacement.executor.startedAt));
      await both('/api/auth/me', adminAccount.cookie); assert.deepEqual((await api(`/api/jobs/${resultA.value.id}`, ownerA.cookie)).value.result, resultA.value.result);
      evidence.restart = { podUid: victim.uid, podName: victim.name, oldInstanceId: victim.executor.instanceId, newInstanceId: replacement.executor.instanceId,
        restarts: replacement.restarts, oldRegistryReason: 'previous-process', metricOnRestart: replacement.metric, queueExecutorCount: after.database.queueExecutorCount };
      await adminBrowser.observe({ phase: 'restarted', expectedInstanceIds: after.servers.map(server => server.executor.instanceId), width: 360 });
      checks.push('real idle SIGKILL/container restart keeps podUID, changes UUID, excludes previous lease from live capacity, rejects old sample and preserves sessions/results');
      mark('warm-cache demotion and private UI removal');
      await both('/api/admin/overview', adminAccount.cookie);
      await grant('user'); await both('/api/admin/overview', adminAccount.cookie, 403); await both('/api/admin/jobs', adminAccount.cookie, 403);
      evidence.demotion = await adminBrowser.forbidden(); assert.equal((await api('/api/jobs', adminAccount.cookie)).status, 200);
      await grant('admin');
      await adminBrowser.reload();
      await adminBrowser.waitFor(`document.querySelector('#admin-open') && !document.querySelector('#admin-open').hidden`, 'explicitly restored administrator role after reload');
      await adminBrowser.click('#admin-open');
      await adminBrowser.waitFor(`!document.querySelector('#admin-workspace').hidden && document.querySelector('#admin-summary').children.length>0`, 'restored monitoring before paused-response logout');
      evidence.logout = await adminBrowser.lateLogout(); assert.equal((await adminBrowser.api('/api/admin/jobs')).status, 401);
      await grant('user');
      checks.push('explicit admin→user revocation defeats warm handler caches and clears private UI; a genuine successful200 overview paused until logout cannot restore private data after the actual fetch is aborted/released');
      const browser = await adminBrowser.finish();
      summary = { status: 'pass', namespace: deployment.namespace, context: deployment.context, image: deployment.image,
        checks, evidence, browser, traces, elapsedMs: Math.round(performance.now() - started), fixtureJobs: 26,
        realCompletedJobs: ended.value.status === 'completed' ? 3 : 2, intentionalCancelledJobs: ended.value.status === 'cancelled' ? 1 : 0 };
    });
  } catch (error) {
    await withoutDeploymentDeadline(() => diagnostics(error)).catch(() => {});
    console.error(JSON.stringify({ status: 'failed', phase, reason: redact(error), diagnostics: new URL('failure.json', output).pathname })); process.exitCode = 1;
  } finally {
    clearTimeout(timer); abort.abort();
    await withoutDeploymentDeadline(async () => {
      if (deployment && roleRules) await deployment.kubectl(['patch', 'role', ROLE, '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/rules', value: roleRules }])], { timeoutMs: 10_000 }).catch(() => {});
      await userBrowser?.cleanup().catch(() => {}); await adminBrowser?.cleanup().catch(() => {});
      if (deployment) { try { await deployment.cleanup(); cleanupCompleted = true; } catch { process.exitCode = 1; console.error('Owned administrator deployment cleanup failed.'); } }
    });
  }
  if (summary && !process.exitCode) {
    summary.cleanupCompleted = cleanupCompleted; await writeFile(new URL('summary.json', output), JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ status: 'pass', checks: checks.length, elapsedMs: summary.elapsedMs, cleanupCompleted, summaryPath: new URL('summary.json', output).pathname }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runAdminDeployment();
