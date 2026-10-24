import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertOwnedDeployment, deploymentOrigin, requestDeployment, safeTrace, secureSessionCookie, verifiedCrossCancellation } from './check-deployment.mjs';
import { assertObjectOwner } from './deployment-autoscale.mjs';

const APP_SELECTOR = 'app.kubernetes.io/name=courier-route-app,app.kubernetes.io/component=app';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const activeStatuses = new Set(['queued', 'running']);
const privateValues = new Set();
let phase = 'preflight and isolated HPA deployment';

/** Kubernetes CPU quantities are cores, including n/u/m subunits. */
export function parseCpuCores(value) {
  assert.equal(typeof value, 'string', 'CPU usage must be an actual Kubernetes quantity.');
  const match = /^(\d+(?:\.\d+)?|\.\d+)(n|u|m|(?:[eE][+-]?\d+)?)$/u.exec(value);
  assert.ok(match, 'Invalid CPU quantity.');
  const suffix = match[2];
  const factor = ({ n: 1e-9, u: 1e-6, m: 1e-3, '': 1 })[suffix] ?? 10 ** Number(suffix.slice(1));
  const result = Number(match[1]) * factor;
  assert.ok(Number.isFinite(result) && result >= 0 && result <= 1_000_000, 'CPU quantity is outside finite bounds.');
  return result;
}

export function parseMemoryBytes(value) {
  assert.equal(typeof value, 'string', 'Memory usage must be an actual Kubernetes quantity.');
  const match = /^(\d+(?:\.\d+)?|\.\d+)(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E|(?:[eE][+-]?\d+)?)$/u.exec(value);
  assert.ok(match, 'Invalid memory quantity.');
  const suffix = match[2];
  const binary = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei'].indexOf(suffix);
  const decimal = ['k', 'M', 'G', 'T', 'P', 'E'].indexOf(suffix === 'K' ? 'k' : suffix);
  const factor = binary >= 0 ? 1024 ** (binary + 1) : decimal >= 0 ? 1000 ** (decimal + 1)
    : suffix ? 10 ** Number(suffix.slice(1)) : 1;
  const result = Number(match[1]) * factor;
  assert.ok(Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER, 'Memory quantity is outside finite bounds.');
  return result;
}

/** Fixed upper limits are part of the executable, rather than unbounded env overrides. */
export function autoscaleBudget(overrides = {}) {
  const config = { users: 3, maxActive: 9, maxAccepted: 200, feedMs: 120_000, deadlineMs: 720_000, pollMs: 2000, ...overrides };
  assert.equal(config.users, 3, 'Use exactly three normal owners.');
  assert.ok(Number.isSafeInteger(config.maxActive) && config.maxActive >= 6 && config.maxActive <= 9);
  assert.ok(Number.isSafeInteger(config.maxAccepted) && config.maxAccepted >= 12 && config.maxAccepted <= 200);
  assert.ok(Number.isSafeInteger(config.feedMs) && config.feedMs >= 120_000 && config.feedMs <= 180_000);
  assert.ok(Number.isSafeInteger(config.deadlineMs) && config.deadlineMs >= config.feedMs + 240_000 && config.deadlineMs <= 780_000);
  assert.ok(Number.isSafeInteger(config.pollMs) && config.pollMs >= 1000 && config.pollMs <= 5000);
  return Object.freeze(config);
}

/** A desired replica is never counted as a ready worker. */
export function summarizePods(pods, slices, image, instances = new Map()) {
  const imageIds = new Set();
  const result = pods.map((pod) => {
    const container = pod.spec?.containers?.find((item) => item.name === 'app');
    assert.equal(container?.image, image, 'All observed app pods must use the one compiled image.');
    const status = pod.status?.containerStatuses?.find((item) => item.name === 'app');
    assert.equal(status?.restartCount ?? 0, 0, 'A normal HPA app container must not restart or survive an unnoticed OOM.');
    const ready = pod.status?.conditions?.some((item) => item.type === 'Ready' && item.status === 'True') === true;
    if (ready) {
      assert.ok(status?.ready && status.imageID?.includes('sha256:'));
      imageIds.add(status.imageID);
    }
    return { name: pod.metadata.name, uid: pod.metadata.uid, ready, terminating: !!pod.metadata.deletionTimestamp,
      instanceId: instances.get(pod.metadata.uid) ?? null, imageID: status?.imageID ?? null, restarts: status?.restartCount ?? 0 };
  });
  assert.equal(new Set(result.map((pod) => pod.uid)).size, result.length, 'Pod identities must be distinct.');
  assert.ok(imageIds.size <= 1, 'Actual app image digests must agree.');
  assert.ok(result.filter((pod) => !pod.terminating).length <= 4, 'There must never be a fifth nonterminating app pod.');
  const endpointUids = [...new Set(slices.flatMap((slice) => slice.endpoints ?? [])
    .filter((endpoint) => endpoint.conditions?.ready === true && endpoint.conditions?.terminating !== true)
    .map((endpoint) => endpoint.targetRef?.uid))];
  assert.ok(endpointUids.every((uid) => result.some((pod) => pod.uid === uid)), 'An endpoint must identify an actual observed app pod.');
  return { pods: result, ready: result.filter((pod) => pod.ready && !pod.terminating).length,
    terminating: result.filter((pod) => pod.terminating).length, endpointUids };
}

export function assertScaleSnapshot(snapshot, expected) {
  assert.ok([2, 4].includes(expected));
  assert.equal(snapshot.hpa.min, 2);
  assert.equal(snapshot.hpa.max, 4);
  assert.equal(snapshot.hpa.current, expected);
  assert.equal(snapshot.hpa.desired, expected);
  assert.equal(snapshot.deployment.desired, expected);
  assert.equal(snapshot.ready, expected);
  assert.equal(snapshot.terminating, 0);
  assert.equal(snapshot.pods.length, expected, 'Terminal cleanup requires actual physical pod exit.');
  assert.equal(snapshot.endpointUids.length, expected);
  assert.deepEqual(new Set(snapshot.endpointUids), new Set(snapshot.pods.map((pod) => pod.uid)));
  assert.equal(snapshot.registry.length, expected);
  assert.equal(new Set(snapshot.pods.map((pod) => pod.instanceId)).size, expected);
  assert.ok(snapshot.pods.every((pod) => UUID.test(pod.instanceId ?? '')));
  assert.deepEqual(new Set(snapshot.registry.map((row) => row.instance_id)), new Set(snapshot.pods.map((pod) => pod.instanceId)));
  for (const type of ['AbleToScale', 'ScalingActive']) assert.ok(snapshot.hpa.conditions.some((item) => item.type === type && item.status === 'True'));
  assert.equal(snapshot.metrics.length, expected, 'Every ready app container needs a real fresh CPU/RAM sample.');
  assert.ok(snapshot.metrics.every((metric) => metric.fresh && metric.window && Number.isFinite(metric.cpuCores) && Number.isFinite(metric.memoryBytes)));
}

/** Both additional pods need their own observed positive work and completed result. */
export function proveExpandedWork(initialUids, pods, observations, completed) {
  const additions = pods.filter((pod) => !initialUids.has(pod.uid));
  assert.equal(additions.length, 2);
  return additions.map((pod) => {
    assert.ok(UUID.test(pod.instanceId ?? ''));
    const work = observations.find((row) => row.executedBy === pod.instanceId && row.completedIterations > 0
      && completed.some((done) => done.id === row.id && done.status === 'completed' && done.executedBy === pod.instanceId));
    assert.ok(work, 'Every additional real process must progress and complete the same committed job.');
    return { pod: pod.name, uid: pod.uid, instanceId: pod.instanceId, jobId: work.id, observedIterations: work.completedIterations };
  });
}

export function validateCompletedRoute(detail) {
  assert.equal(detail.status, 'completed');
  assert.ok(UUID.test(detail.executedBy));
  const { input, result } = detail;
  assert.equal(result.seed, input.seed);
  assert.equal(result.iterationsRequested, input.iterations);
  assert.equal(result.iterationsCompleted, input.iterations);
  assert.equal(result.order.length, input.points.length + 2);
  assert.equal(result.order[0], 0);
  assert.equal(result.order.at(-1), 0);
  assert.deepEqual([...result.order.slice(1, -1)].sort((a, b) => a - b), input.points.map((_value, index) => index + 1));
  const coordinates = [input.warehouse, ...input.points];
  const length = result.order.slice(1).reduce((sum, index, offset) => {
    const before = coordinates[result.order[offset]];
    return sum + Math.hypot(coordinates[index].x - before.x, coordinates[index].y - before.y);
  }, 0);
  assert.ok(Number.isFinite(result.length) && Math.abs(length - result.length) <= Math.max(1, length) * 1e-10);
  assert.ok(result.length <= result.initialLength + Math.max(1, result.initialLength) * 1e-10);
  assert.equal(detail.progress.percent, 100);
}

/** Read-only reconciliation never repeats the uncertain mutation. */
export async function reconcileCancellation(id, read, pause, maxReads = 18) {
  assert.ok(UUID.test(id) && Number.isInteger(maxReads) && maxReads >= 1 && maxReads <= 18);
  for (let attempt = 0; attempt < maxReads; attempt++) {
    const job = await read(id);
    if (job) {
      assert.equal(job.id, id);
      assert.notEqual(job.status, 'failed', 'An uncertain cancellation cannot conceal a failed worker.');
      if (job.status === 'cancelled' || job.status === 'completed') return job;
    }
    if (attempt + 1 < maxReads) await pause(2000);
  }
  throw new Error('The uncertain cancellation could not be reconciled within its bounded read budget.');
}

function safeFailure(error) {
  let message = String(error?.message ?? 'Autoscaling verification failed.').split('\n')[0];
  for (const value of privateValues) if (value) message = message.replaceAll(value, '[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/\S+/giu, '[redacted database address]');
  return { message: message.slice(0, 240), ...(/^[A-Z_]+$/u.test(error?.code ?? '') ? { code: error.code } : {}),
    ...(typeof error?.actual === 'number' && typeof error?.expected === 'number'
    ? { actual: error.actual, expected: error.expected } : {}), location: String(error?.stack ?? '').split('\n')
    .find((line) => /check-autoscale\.mjs:\d+/u.test(line))?.trim() };
}

function heavyInput(seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000 * 2000 - 1000; };
  return { warehouse: { x: 0, y: 0 }, points: Array.from({ length: 500 }, () => ({ x: next(), y: next() })), iterations: 200_000_000, seed };
}

const squareInput = { warehouse: { x: 0, y: 0 }, points: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], iterations: 10_000, seed: 0 };

async function allRequests(requests) {
  const outcomes = await Promise.allSettled(requests);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map((outcome) => outcome.value);
}

async function runAutoscaleWithinBudget(budget, deadlineEpochMs, withoutDeploymentDeadline) {
  const started = performance.now();
  const deadline = started + Math.max(0, deadlineEpochMs - Date.now());
  const ownerId = randomUUID();
  const namespace = `courier-route-test-hpa-${randomBytes(5).toString('hex')}`;
  const directory = new URL(`../.local/autoscale-tests/${ownerId}/`, import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const summary = { ownerId, namespace, budget, deadlineEpochMs, checks: [], traces: [], timeline: [], phaseTimes: {}, cleanupCompleted: false };
  let deployment;
  let observer;
  let adminObserver;
  let failure;
  const checkDeadline = () => assert.ok(performance.now() < deadline, 'The finite overall autoscaling deadline expired.');
  const pause = async (milliseconds) => {
    checkDeadline();
    await delay(Math.min(milliseconds, Math.max(1, deadlineEpochMs - Date.now())));
    checkDeadline();
  };
  const accepted = new Map();
  const users = [];
  const instances = new Map();
  const progressObservations = new Map();
  const queueObservations = [];
  let latest;
  let lastPrinted = 0;
  const save = () => writeFile(new URL('summary.json', directory), JSON.stringify(summary, null, 2), { mode: 0o600 });
  try {
    const { provisionTestDeployment, assignDeploymentRole } = await import('./deploy-local.mjs');
    deployment = await provisionTestDeployment({ namespace, ownerId, autoscaling: true });
    assert.equal(deployment.autoscaling, true, 'A static regression namespace cannot prove HPA.');
    Object.assign(summary, { context: deployment.context, image: deployment.image, httpsOrigin: deployment.httpsOrigin });
    const ca = await readFile(deployment.caPath);
    const origin = deploymentOrigin(deployment.httpsOrigin, 'https:');
    const invoke = async (action, path, options = {}) => {
      checkDeadline();
      const before = performance.now();
      summary.lastRequest = { action, method: options.method ?? 'GET', path, startedElapsedMs: Math.round(before - started) };
      let response;
      try { response = await requestDeployment(origin, ca, { path, ...options,
        timeoutMs: Math.max(1, Math.min(10_000, deadlineEpochMs - Date.now())) }); }
      catch (error) {
        (summary.transportFailures ??= []).push({ ...summary.lastRequest, code: error.code ?? 'TRANSPORT_FAILURE',
          elapsedMs: Math.round(performance.now() - before) });
        throw error;
      }
      summary.traces.push(safeTrace({ action, handler: response.handler, status: response.status,
        jobId: UUID.test(response.value?.id ?? '') ? response.value.id : undefined,
        executedBy: response.value?.executedBy ?? undefined, jobStatus: response.value?.status,
        elapsedMs: Math.round(performance.now() - before) }));
      if (path.startsWith('/api/')) assert.ok(response.handler || [502, 503, 504].includes(response.status), 'Actual API process UUID is required.');
      return response;
    };
    const owned = async () => {
      await deployment.assertOwned();
      assertOwnedDeployment(deployment, await deployment.kubectl(['get', 'namespace', namespace, '-o', 'json'], { json: true }));
    };
    await owned();
    await deployment.sql(`CREATE TABLE autoscale_claim_audit(job_id uuid NOT NULL,instance_id uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE FUNCTION autoscale_record_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.status='queued' AND NEW.status='running' THEN INSERT INTO autoscale_claim_audit(job_id,instance_id) VALUES(NEW.id,NEW.instance_id); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER autoscale_record_claim AFTER UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION autoscale_record_claim();`);
    const jobsAndRegistry = async () => {
      const [row] = await deployment.sql(`SELECT
        COALESCE((SELECT json_agg(json_build_object('id',id,'status',status,'executedBy',instance_id,
          'completedIterations',completed_iterations,'totalIterations',total_iterations,'percent',progress_percent,
          'startedAt',started_at,'finishedAt',finished_at,'failureReason',failure_reason,
          'resultValid',CASE WHEN status='completed' THEN
            (result->>'iterationsCompleted')::bigint=total_iterations AND (result->>'iterationsRequested')::bigint=total_iterations
            AND (result->>'seed')::bigint=(input->>'seed')::bigint
            AND jsonb_array_length(result->'order')=jsonb_array_length(input->'points')+2 ELSE NULL END)
          ORDER BY created_at,id) FROM jobs),'[]'::json) AS jobs,
        COALESCE((SELECT json_agg(json_build_object('instance_id',instance_id,'busy',busy,'current_job_id',current_job_id,
          'last_seen_at',last_seen_at,'expires_at',expires_at)) FROM executor_registry
          WHERE accepting_claims AND expires_at>clock_timestamp()),'[]'::json) AS registry`);
      assert.ok(row.jobs.length <= budget.maxAccepted, 'The accepted job budget was exceeded.');
      assert.ok(row.jobs.filter((job) => activeStatuses.has(job.status)).length <= budget.maxActive, 'The active job budget was exceeded.');
      for (const job of row.jobs) {
        assert.notEqual(job.status, 'failed', `A real normal job failed: ${job.failureReason ?? 'unknown reason'}.`);
        if (job.status === 'cancelled') assert.ok(accepted.get(job.id)?.intentionalCancel, 'A normal job was unexpectedly cancelled.');
        if (job.status === 'completed') assert.equal(job.resultValid, true, 'Every completed job must retain full iteration/seed/order metadata.');
        if (job.status === 'running' && job.completedIterations > 0) progressObservations.set(`${job.executedBy}:${job.id}`, job);
      }
      const running = row.jobs.filter((job) => job.status === 'running');
      assert.equal(new Set(running.map((job) => job.executedBy)).size, running.length, 'Each real executor may own at most one running job.');
      return row;
    };
    const snapshot = async () => {
      checkDeadline();
      const [podList, endpointList, hpa, app, metrics, state] = await allRequests([
        deployment.kubectl(['get', 'pods', '-l', APP_SELECTOR, '-o', 'json'], { json: true }),
        deployment.kubectl(['get', 'endpointslices', '-l', 'kubernetes.io/service-name=app', '-o', 'json'], { json: true }),
        deployment.kubectl(['get', 'hpa', 'app', '-o', 'json'], { json: true }),
        deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true }),
        deployment.metrics(), jobsAndRegistry(),
      ]);
      assertObjectOwner(hpa, { namespace, ownerId, kind: 'HorizontalPodAutoscaler', name: 'app' });
      assertObjectOwner(app, { namespace, ownerId, kind: 'Deployment', name: 'app' });
      for (const pod of podList.items) {
        assert.equal(pod.metadata.labels['courier-route.local/owner-id'], ownerId);
        if (!instances.has(pod.metadata.uid) && !pod.metadata.deletionTimestamp && pod.status.conditions?.some((item) => item.type === 'Ready' && item.status === 'True')) {
          const value = JSON.parse(await deployment.kubectl(['exec', pod.metadata.name, '-c', 'app', '--', 'node', '--input-type=module', '-e',
            `const response=await fetch('http://127.0.0.1:3000/api/health');const value=await response.json();console.log(JSON.stringify({instanceId:value.instanceId}));`], { timeoutMs: 15_000 }));
          assert.ok(UUID.test(value.instanceId));
          instances.set(pod.metadata.uid, value.instanceId);
        }
      }
      const capacity = summarizePods(podList.items, endpointList.items, deployment.image, instances);
      const at = Date.now();
      const podMetrics = (metrics.pods.items ?? []).filter((item) => capacity.pods.some((pod) => pod.name === item.metadata.name && pod.ready && !pod.terminating)).map((item) => {
        const usage = item.containers.find((container) => container.name === 'app')?.usage;
        assert.ok(usage, 'App container CPU and RAM are required.');
        return { pod: item.metadata.name, uid: capacity.pods.find((pod) => pod.name === item.metadata.name)?.uid,
          timestamp: item.timestamp, window: item.window,
          cpuCores: parseCpuCores(usage.cpu), memoryBytes: parseMemoryBytes(usage.memory),
          fresh: Number.isFinite(Date.parse(item.timestamp)) && at - Date.parse(item.timestamp) >= -5000 && at - Date.parse(item.timestamp) < 90_000 };
      });
      const value = { observedAt: new Date(at).toISOString(), elapsedMs: Math.round(performance.now() - started), ...capacity,
        deployment: { desired: app.spec.replicas, replicas: app.status.replicas ?? 0, ready: app.status.readyReplicas ?? 0,
          generation: app.metadata.generation, observedGeneration: app.status.observedGeneration, terminating: app.status.terminatingReplicas ?? 0 },
        hpa: { min: hpa.spec.minReplicas, max: hpa.spec.maxReplicas, current: hpa.status.currentReplicas, desired: hpa.status.desiredReplicas,
          cpuUtilization: hpa.status.currentMetrics?.find((item) => item.type === 'Resource' && item.resource.name === 'cpu')?.resource.current.averageUtilization ?? null,
          conditions: (hpa.status.conditions ?? []).map(({ type, status, reason, lastTransitionTime }) => ({ type, status, reason, lastTransitionTime })) },
        metrics: podMetrics, nodeMetrics: (metrics.nodes.items ?? []).map((item) => ({ node: item.metadata.name,
          timestamp: item.timestamp, window: item.window, cpuCores: parseCpuCores(item.usage.cpu), memoryBytes: parseMemoryBytes(item.usage.memory) })),
        metricsApiAvailable: metrics.apiService.status?.conditions?.some((item) => item.type === 'Available' && item.status === 'True') === true,
        registry: state.registry, jobs: state.jobs,
        counts: Object.fromEntries(['queued', 'running', 'completed', 'cancelled', 'failed'].map((status) => [status, state.jobs.filter((job) => job.status === status).length])) };
      assert.ok(value.hpa.desired <= 4 && value.deployment.desired <= 4, 'HPA upper cap must stay four.');
      summary.timeline.push(value);
      latest = value;
      if (performance.now() - lastPrinted >= 15_000) {
        lastPrinted = performance.now();
        console.log(JSON.stringify({ phase, elapsedMs: value.elapsedMs, desired: value.hpa.desired, ready: value.ready,
          terminating: value.terminating, executors: value.registry.length, cpuUtilization: value.hpa.cpuUtilization,
          accepted: accepted.size, ...value.counts }));
        await save();
      }
      return value;
    };
    const eventually = async (probe, predicate, name, timeoutMs = 60_000) => {
      const end = Math.min(deadline, performance.now() + timeoutMs);
      while (performance.now() < end) {
        const value = await probe();
        if (await predicate(value)) return value;
        await pause(budget.pollMs);
      }
      throw new Error(`Timeout: ${name}.`);
    };
    const coherent = (value, count) => { try { assertScaleSnapshot(value, count); return value.metricsApiAvailable; } catch { return false; } };
    phase = 'baseline: real metrics and two independent executors';
    const initial = await eventually(snapshot, (value) => coherent(value, 2), 'two real ready metric-bearing executors', 90_000);
    const initialUids = new Set(initial.pods.map((pod) => pod.uid));
    summary.initial = initial;
    const liveHpa = await deployment.kubectl(['get', 'hpa', 'app', '-o', 'json'], { json: true });
    assert.deepEqual(liveHpa.spec.metrics, [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }]);
    assert.equal(liveHpa.spec.behavior.scaleDown.stabilizationWindowSeconds, 180);
    assert.equal(liveHpa.spec.behavior.scaleUp.stabilizationWindowSeconds, 0);
    assert.deepEqual(liveHpa.spec.behavior.scaleUp.policies, [{ type: 'Pods', value: 2, periodSeconds: 30 }]);
    assert.deepEqual(liveHpa.spec.behavior.scaleDown.policies, [{ type: 'Pods', value: 1, periodSeconds: 30 }]);
    const actualConfig = await deployment.kubectl(['get', 'configmap', 'app-config', '-o', 'json'], { json: true });
    assert.equal(actualConfig.data.JOBS_MAX_OUTSTANDING, '100');
    assert.equal(actualConfig.data.JOBS_MAX_ACTIVE_PER_USER, '3');
    const actualApp = await deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
    const resources = actualApp.spec.template.spec.containers.find((item) => item.name === 'app').resources;
    assert.deepEqual(resources.requests, { cpu: '250m', memory: '128Mi' });
    assert.deepEqual(resources.limits, { cpu: '1', memory: '384Mi' });
    assert.equal(actualApp.spec.strategy.rollingUpdate.maxSurge, 0);
    summary.resources = resources;
    summary.globalOutstandingLimit = Number(actualConfig.data.JOBS_MAX_OUTSTANDING);
    summary.hpaSpec = liveHpa.spec;
    summary.checks.push('real Metrics API timestamps/window, two ready pod/endpoint/UUIDs and HPA 2..4 CPU 70%');

    for (let index = 0; index < budget.users; index++) {
      const username = `hpa_${randomBytes(7).toString('hex')}`;
      const password = randomBytes(24).toString('base64url');
      privateValues.add(username); privateValues.add(password);
      assert.equal((await invoke('register normal load owner', '/api/auth/register', { method: 'POST', body: { username, password }, headers: { Origin: origin.origin } })).status, 201);
      const login = await invoke('login normal load owner', '/api/auth/login', { method: 'POST', body: { username, password }, headers: { Origin: origin.origin } });
      assert.equal(login.status, 200);
      const cookie = secureSessionCookie(login.headers); privateValues.add(cookie); privateValues.add(cookie.slice(cookie.indexOf('=') + 1));
      users.push({ username, password, cookie });
    }
    const { startAutoscaleBrowser } = await import('./check-autoscale-browser.mjs');
    observer = await startAutoscaleBrowser({ deployment, credentials: { username: users[0].username, password: users[0].password }, deadlineEpochMs });
    // A distinct fourth account only reads monitoring. The three ordinary
    // owners, admission quotas and accepted-job/work budgets stay unchanged.
    const adminCredentials = { username: `hpa_admin_${randomBytes(6).toString('hex')}`, password: randomBytes(24).toString('base64url') };
    privateValues.add(adminCredentials.username); privateValues.add(adminCredentials.password);
    assert.equal((await invoke('register monitoring observer', '/api/auth/register', { method: 'POST', body: adminCredentials,
      headers: { Origin: origin.origin } })).status, 201);
    await assignDeploymentRole({ namespace, ownerId, username: adminCredentials.username, role: 'admin' });
    const { startAdminBrowser } = await import('./check-admin-browser.mjs');
    adminObserver = await startAdminBrowser({ deployment, credentials: adminCredentials, deadlineEpochMs });
    summary.adminObservations = [await adminObserver.observe({ phase: 'baseline', expectedInstanceIds: initial.pods.map((pod) => pod.instanceId) })];
    const limits = await invoke('unchanged production limits', '/api/jobs/limits', { cookie: users[0].cookie });
    assert.equal(limits.status, 200); assert.equal(limits.value.maxActivePerUser, 3);
    assert.equal(limits.value.route.maxPoints, 500); assert.equal(limits.value.route.maxIterations, 200_000_000); assert.equal(limits.value.route.timeoutMs, 30_000);
    const create = async (owner, input = heavyInput(1000 + accepted.size), intentionalCancel = false) => {
      assert.ok(accepted.size < budget.maxAccepted, 'No submission may exceed the accepted budget.');
      // This POST has no retry path. A transport-uncertain mutation fails the run.
      const response = await invoke('submit one real route job', '/api/jobs', { method: 'POST', body: input, cookie: users[owner].cookie, headers: { Origin: origin.origin } });
      assert.equal(response.status, 202, 'An expected admission must be acknowledged exactly once.');
      assert.equal(response.value.status, 'queued'); assert.ok(UUID.test(response.value.id));
      assert.ok(!accepted.has(response.value.id));
      accepted.set(response.value.id, { owner, intentionalCancel, seed: input.seed });
      return response.value.id;
    };
    const detail = async (id) => {
      const owner = accepted.get(id)?.owner ?? 0;
      const response = await invoke('read real job detail', `/api/jobs/${id}`, { cookie: users[owner].cookie });
      assert.equal(response.status, 200); return response.value;
    };
    const getPair = (value) => {
      const jobs = value.jobs.filter((job) => accepted.get(job.id)?.owner === 0);
      return { queued: jobs.findLast((job) => job.status === 'queued'), running: jobs.filter((job) => job.status === 'running'
        && job.completedIterations > 0 && job.completedIterations < job.totalIterations / 2)
        .sort((a, b) => a.completedIterations / a.totalIterations - b.completedIterations / b.totalIterations)[0] };
    };
    const handlers = new Set();
    const observeHandlers = async (expected) => {
      for (let attempt = 0; attempt < 16 && !expected.every((id) => handlers.has(id)); attempt++) {
        const response = await invoke('same session actual HTTPS handler', '/api/auth/me', { cookie: users[0].cookie });
        assert.equal(response.status, 200); assert.ok(UUID.test(response.handler)); handlers.add(response.handler);
      }
      return expected.every((id) => handlers.has(id));
    };
    const feedStarted = performance.now();
    summary.phaseTimes.feedStartedMs = Math.round(feedStarted - started);
    phase = 'bounded real route load: automatic 2→4';
    // Admission locking sees four concurrent normal requests for the same owner.
    const first = await allRequests(Array.from({ length: 4 }, (_, index) => invoke('parallel personal quota proof', '/api/jobs', {
      method: 'POST', body: heavyInput(500 + index), cookie: users[0].cookie, headers: { Origin: origin.origin } })));
    assert.equal(first.filter((response) => response.status === 202).length, 3);
    assert.equal(first.filter((response) => response.status === 429 && response.value.code === 'USER_ACTIVE_LIMIT').length, 1);
    for (const response of first.filter((value) => value.status === 202)) accepted.set(response.value.id, { owner: 0, intentionalCancel: false, seed: response.value.input?.seed });
    summary.checks.push('parallel personal quota remains atomic: three accepted and one 429, normal production global quota unchanged');
    let baselineObserved = false;
    let expandedObserved = false;
    let expanded;
    let repeatProof;
    let cancelProof;
    const cancellationAttempts = [];
    let ownershipProof = false;
    const fill = async (value) => {
      const plannedJobs = value.jobs.map((job) => ({ ...job }));
      for (let round = 0; round < 3; round++) for (let owner = 0; owner < users.length; owner++) {
        if (performance.now() - feedStarted >= budget.feedMs || accepted.size >= budget.maxAccepted - 2) return;
        const active = plannedJobs.filter((job) => activeStatuses.has(job.status));
        const ownedActive = active.filter((job) => accepted.get(job.id)?.owner === owner);
        if (active.length >= budget.maxActive || ownedActive.length >= 3) continue;
        const id = await create(owner);
        plannedJobs.push({ id, status: 'queued' });
      }
    };
    while (performance.now() - feedStarted < budget.feedMs && accepted.size < budget.maxAccepted - 2) {
      let value = await snapshot();
      const pair = getPair(value);
      if (!baselineObserved && coherent(value, 2) && pair.queued && pair.running) {
        const queued = await detail(pair.queued.id);
        if (queued.status === 'queued' && queued.queue.executorCount === 2 && Number.isFinite(queued.queue.estimatedWaitMs)) {
          summary.baselineQueue = queued.queue;
          queueObservations.push({ phase: 'baseline', jobId: pair.queued.id, queue: queued.queue });
          (summary.browserObservations ??= []).push(await observer.observe({ phase: 'baseline', queuedJobId: pair.queued.id, runningJobId: pair.running.id,
            expectedExecutorCount: 2, expectedInstanceIds: value.pods.map((pod) => pod.instanceId) }));
          baselineObserved = true;
        }
      }
      if (coherent(value, 4)) {
        const running = value.jobs.filter((job) => job.status === 'running' && job.completedIterations > 0);
        if (running.length === 4 && new Set(running.map((job) => job.executedBy)).size === 4 && pair.queued && pair.running) {
          const queued = await detail(pair.queued.id);
          if (queued.status === 'queued' && queued.queue.executorCount === 4 && Number.isFinite(queued.queue.estimatedWaitMs)) {
            expanded ??= structuredClone(value);
            summary.expandedQueue ??= queued.queue;
            if (!queueObservations.some((item) => item.phase === 'expanded')) {
              queueObservations.push({ phase: 'expanded', jobId: pair.queued.id, queue: queued.queue });
            }
            summary.fourSlots ??= running;
            if (!expandedObserved) {
              summary.phaseTimes.fourReadyBusyMs = value.elapsedMs;
              (summary.browserObservations ??= []).push(await observer.observe({ phase: 'expanded', queuedJobId: pair.queued.id, runningJobId: pair.running.id,
                expectedExecutorCount: 4, expectedInstanceIds: value.pods.map((pod) => pod.instanceId) }));
              const adminExpanded = await adminObserver.observe({ phase: 'expanded', expectedInstanceIds: value.pods.map((pod) => pod.instanceId) });
              assert.ok(adminExpanded.owners.length >= 2, 'The admin must observe jobs belonging to multiple real load owners.');
              assert.equal(adminExpanded.summary.pods, 4);
              summary.adminObservations.push(adminExpanded);
              expandedObserved = true;
            }
            await observeHandlers(value.pods.map((pod) => pod.instanceId));
            if (!repeatProof) {
              await owned();
              const before = await deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
              const uids = value.pods.map((pod) => pod.uid).sort();
              await deployment.repeatDeploy();
              const after = await deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
              summary.repeatDiagnostics = { before: { generation: before.metadata.generation, replicas: before.spec.replicas,
                revision: before.metadata.annotations['deployment.kubernetes.io/revision'],
                templateDigest: createHash('sha256').update(JSON.stringify(before.spec.template)).digest('hex') },
              after: { generation: after.metadata.generation, replicas: after.spec.replicas,
                revision: after.metadata.annotations['deployment.kubernetes.io/revision'],
                templateDigest: createHash('sha256').update(JSON.stringify(after.spec.template)).digest('hex') },
              annotationKeysChanged: [...new Set([...Object.keys(before.metadata.annotations), ...Object.keys(after.metadata.annotations)])]
                .filter((key) => before.metadata.annotations[key] !== after.metadata.annotations[key]) };
              assert.equal(after.spec.replicas, 4); assert.equal(after.metadata.generation, before.metadata.generation);
              assert.deepEqual(after.spec.template, before.spec.template);
              const afterPods = await deployment.kubectl(['get', 'pods', '-l', APP_SELECTOR, '-o', 'json'], { json: true });
              assert.deepEqual(afterPods.items.map((pod) => pod.metadata.uid).sort(), uids, 'Repeat deploy at four must preserve every busy process.');
              const prior = JSON.parse(after.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']);
              assert.equal(Object.hasOwn(prior.spec, 'replicas'), false, 'HPA replica ownership must be handed off in the old apply annotation.');
              repeatProof = { elapsedMs: Math.round(performance.now() - started), generation: after.metadata.generation, uids, replicas: after.spec.replicas };
            }
            if (!ownershipProof) {
              const victim = running.find((job) => accepted.get(job.id)?.owner !== 0);
              assert.ok(victim);
              const foreign = await allRequests([
                invoke('foreign detail stays hidden under four workers', `/api/jobs/${victim.id}`, { cookie: users[0].cookie }),
                invoke('foreign cancellation stays hidden under four workers', `/api/jobs/${victim.id}/cancel`, { method: 'POST', body: {}, cookie: users[0].cookie, headers: { Origin: origin.origin } }),
              ]);
              assert.ok(foreign.every((response) => response.status === 404)); ownershipProof = true;
            }
          }
        }
      }
      if (expandedObserved && !cancelProof && cancellationAttempts.length < 6) {
        // Observe fresh early running work after slow browser/deploy operations.
        // Different candidates are separate deliberate cancellations, never a
        // retry of a mutation with an unknown result.
        const state = await jobsAndRegistry();
        const candidate = state.jobs.find((job) => job.status === 'running' && accepted.get(job.id)?.owner !== 0
          && !accepted.get(job.id)?.intentionalCancel && job.completedIterations > 0 && job.completedIterations < job.totalIterations / 2);
        if (candidate) {
          const victim = await detail(candidate.id);
          if (victim.status === 'running' && victim.progress.completedIterations < victim.progress.totalIterations * 0.75) {
            accepted.get(victim.id).intentionalCancel = true;
            let response;
            try { response = await invoke('cross-handler owner cancels real worker under HPA load', `/api/jobs/${victim.id}/cancel`, {
              method: 'POST', body: {}, cookie: users[accepted.get(victim.id).owner].cookie, headers: { Origin: origin.origin } }); }
            catch (error) {
              if (error.message !== 'Deployment transport request failed.') throw error;
              const terminal = await reconcileCancellation(victim.id, async (id) => {
                try {
                  const observed = await invoke('read-only reconcile uncertain cancel', `/api/jobs/${id}`, { cookie: users[accepted.get(id).owner].cookie });
                  if ([502, 503, 504].includes(observed.status)) return null;
                  assert.equal(observed.status, 200); return observed.value;
                } catch (readError) { if (readError.message === 'Deployment transport request failed.') return null; throw readError; }
              }, pause);
              await snapshot(); // Restarts/OOM/failed jobs remain fatal.
              const processes = await deployment.kubectl(['get', 'pods', '-l', 'app.kubernetes.io/part-of=courier-route', '-o', 'json'], { json: true });
              assert.ok(processes.items.every((pod) => (pod.status.containerStatuses ?? []).every((item) => item.restartCount === 0)), 'A reset must not conceal any restarted app, Traefik or database.');
              const events = await deployment.kubectl(['get', 'events', '-o', 'json'], { json: true });
              (summary.uncertainCancellations ??= []).push({ jobId: victim.id, deliveryUncertain: true, code: error.code,
                outcome: terminal.status, executedBy: terminal.executedBy, forwarding: deployment.forwardingInfo?.(),
                pods: processes.items.map((pod) => ({ name: pod.metadata.name, uid: pod.metadata.uid, phase: pod.status.phase,
                  containers: (pod.status.containerStatuses ?? []).map((item) => ({ name: item.name, restarts: item.restartCount, ready: item.ready })) })),
                events: events.items.map((item) => ({ reason: item.reason, type: item.type, count: item.count,
                  object: { kind: item.involvedObject?.kind, name: item.involvedObject?.name }, lastTimestamp: item.lastTimestamp })) });
              if (terminal.status === 'completed') accepted.get(victim.id).intentionalCancel = false;
              cancellationAttempts.push({ jobId: victim.id, deliveryUncertain: true, transportCode: error.code,
                status: terminal.status, acceptedStatus: null, handler: null, executedBy: terminal.executedBy });
              response = null;
            }
            if (response) {
              assert.ok([200, 202].includes(response.status));
              const terminal = await eventually(() => detail(victim.id), (job) => ['completed', 'cancelled', 'failed'].includes(job.status), 'real worker cancellation terminal', 35_000);
              assert.equal(terminal.status, 'cancelled');
              const record = { jobId: victim.id, handler: response.handler, executedBy: victim.executedBy, status: terminal.status, acceptedStatus: response.status };
              cancellationAttempts.push(record);
              if (verifiedCrossCancellation(victim, response, { value: terminal })) cancelProof = record;
            }
          }
        }
      }
      // Refresh the active rows after browser/redeploy observations, then bounded backfill.
      if (performance.now() - feedStarted < budget.feedMs) { value = await jobsAndRegistry(); await fill(value); }
      await pause(budget.pollMs);
    }
    summary.phaseTimes.feedStoppedMs = Math.round(performance.now() - started);
    summary.actualFeedMs = Math.round(performance.now() - feedStarted);
    assert.ok(baselineObserved && expandedObserved, 'Both real browser observations must occur in the same 2→4 load run.');
    assert.ok(expanded && repeatProof && cancelProof && ownershipProof, 'Four busy workers, no-reset repeat, owner isolation and cancellation are all required.');
    assert.ok(expanded.pods.every((pod) => handlers.has(pod.instanceId)), 'The same HTTPS session must reach every one of four real handlers.');
    summary.metricSamples = expanded.pods.map((pod) => {
      const samples = summary.timeline.flatMap((item) => item.metrics).filter((metric) => metric.uid === pod.uid && metric.fresh);
      const timestamps = [...new Set(samples.map((metric) => metric.timestamp))].sort();
      assert.ok(timestamps.length >= 2, 'Each initial and added pod needs at least two advancing real metric timestamps.');
      const peakCpuCores = Math.max(...samples.map((metric) => metric.cpuCores));
      assert.ok(peakCpuCores > 0.175, 'Real route work must raise each app container above the 70% of 250m target.');
      return { pod: pod.name, uid: pod.uid, firstTimestamp: timestamps[0], lastTimestamp: timestamps.at(-1), distinctSamples: timestamps.length, peakCpuCores };
    });
    summary.expanded = expanded; summary.repeatAtFour = repeatProof; summary.cancel = cancelProof; summary.cancellationAttempts = cancellationAttempts; summary.handlers = [...handlers];
    summary.checks.push('HPA alone expanded to four real busy workers, shared queued ETA=4 and same session reached every handler');
    summary.checks.push('repeat deploy at four preserved all pod UIDs/template/generation and HPA owns replicas');
    summary.checks.push('parallel foreign detail/cancel remained 404; a different real handler acknowledged running cancel and the worker persisted cancelled');

    phase = 'feed stopped: finish acknowledged jobs, then actual 180-second HPA cooldown';
    const allTerminal = await eventually(snapshot, (value) => value.counts.queued === 0 && value.counts.running === 0, 'all accepted real jobs finish normally', 90_000);
    summary.phaseTimes.allTerminalMs = allTerminal.elapsedMs;
    assert.equal(allTerminal.jobs.length, accepted.size);
    const normal = allTerminal.jobs.filter((job) => !accepted.get(job.id).intentionalCancel);
    assert.ok(normal.every((job) => job.status === 'completed'));
    // Reuse this same bounded run to prove both initial servers did concurrent
    // real work which later completed. Health-handler rotation alone is weaker.
    const initialPair = summary.timeline.find((item) => initial.pods.every((pod) => item.jobs.some((job) =>
      job.executedBy === pod.instanceId && job.status === 'running' && job.completedIterations > 0
      && normal.some((done) => done.id === job.id && done.executedBy === pod.instanceId))));
    assert.ok(initialPair, 'Both initial processes must have simultaneous positive work with their own later completed results.');
    summary.initialExecutors = [];
    for (const pod of initial.pods) {
      const observed = initialPair.jobs.find((job) => job.executedBy === pod.instanceId && job.status === 'running'
        && job.completedIterations > 0 && normal.some((done) => done.id === job.id && done.executedBy === pod.instanceId));
      assert.ok(observed);
      const completed = await detail(observed.id); validateCompletedRoute(completed);
      summary.initialExecutors.push({ pod: pod.name, uid: pod.uid, instanceId: pod.instanceId, jobId: observed.id,
        observedAt: initialPair.observedAt, observedIterations: observed.completedIterations,
        status: completed.status, iterationsCompleted: completed.result.iterationsCompleted,
        routeLength: completed.result.length, resultChecked: true });
    }
    summary.queueWaits = queueObservations.map(({ phase: observedPhase, jobId, queue }) => {
      const job = allTerminal.jobs.find((item) => item.id === jobId);
      assert.ok(job?.startedAt, 'An observed queued job must actually start in this run.');
      const actualWaitMs = Date.parse(job.startedAt) - Date.parse(queue.calculatedAt);
      assert.ok(Number.isFinite(actualWaitMs) && actualWaitMs >= 0);
      return { phase: observedPhase, jobId, ...queue, startedAt: job.startedAt, actualWaitMs,
        context: 'Real bounded load; other jobs can finish or be intentionally cancelled and HPA adds capacity. ETA is time until start, not a countdown.' };
    });
    const additions = proveExpandedWork(initialUids, expanded.pods, [...progressObservations.values()], allTerminal.jobs);
    for (const item of additions) validateCompletedRoute(await detail(item.jobId));
    summary.additionalExecutors = additions;
    const audit = await deployment.sql('SELECT job_id,count(*)::integer AS claims,min(instance_id::text) AS instance_id FROM autoscale_claim_audit GROUP BY job_id ORDER BY job_id');
    assert.ok(audit.every((row) => row.claims === 1), 'Each claimed job must have exactly one committed queued→running transition.');
    assert.ok(audit.every((row) => accepted.has(row.job_id)
      && allTerminal.jobs.some((job) => job.id === row.job_id && job.executedBy === row.instance_id)),
    'Every audited claim must match the actual persisted executor of its own acknowledged job.');
    assert.equal(audit.length, allTerminal.jobs.filter((job) => job.executedBy).length);
    summary.claimAudit = { claimedJobs: audit.length, maximumClaims: Math.max(...audit.map((row) => row.claims)), normalCompleted: normal.length, intentionalCancelled: allTerminal.counts.cancelled };
    summary.checks.push('each added C/D process progressed and completed a valid route; one slot/process and exactly one committed claim per executed job');
    const down = await eventually(snapshot, (value) => coherent(value, 2) && value.counts.queued === 0 && value.counts.running === 0, 'automatic four→two after physical exit/endpoint removal/registry exclusion', 300_000);
    summary.downscaled = down; summary.phaseTimes.twoAgainMs = down.elapsedMs;
    assert.ok(summary.timeline.some((item) => item.hpa.desired > 2));
    assert.ok(summary.timeline.every((item) => item.hpa.desired <= 4 && item.pods.filter((pod) => !pod.terminating).length <= 4));
    summary.checks.push('finite feed stopped; all normal jobs completed before automatic four→two with two physical pods/endpoints/executors');
    summary.adminObservations.push(await adminObserver.observe({ phase: 'returned', expectedInstanceIds: down.pods.map((pod) => pod.instanceId) }));
    summary.adminPagination = await adminObserver.pagination();
    summary.adminBrowser = await adminObserver.finish();
    await adminObserver.cleanup(); adminObserver = undefined;
    summary.checks.push('one unchanged admin session observed actual A/B→C/D→two, current CPU/RAM, all-owner jobs and pagination without submitting load');
    const resultJobId = normal.findLast((job) => accepted.get(job.id).owner === 0)?.id;
    assert.ok(resultJobId);
    summary.browser = await observer.finish({ resultJobId, expectedInstanceIds: down.pods.map((pod) => pod.instanceId) });
    assert.ok(UUID.test(summary.browser.newJobId));
    accepted.set(summary.browser.newJobId, { owner: 0, intentionalCancel: false, seed: 0 });
    const browserSquare = await detail(summary.browser.newJobId); validateCompletedRoute(browserSquare); assert.equal(browserSquare.result.length, 4);

    phase = 'negative own-HPA missing-container CPU metric and recovery';
    await owned();
    const beforeMetric = await deployment.kubectl(['get', 'hpa', 'app', '-o', 'json'], { json: true });
    assertObjectOwner(beforeMetric, { namespace, ownerId, kind: 'HorizontalPodAutoscaler', name: 'app' });
    const badMetric = [{ type: 'ContainerResource', containerResource: { name: 'cpu', container: 'intentionally-absent-test-container',
      target: { type: 'Utilization', averageUtilization: 70 } } }];
    try {
      await deployment.kubectl(['patch', 'hpa', 'app', '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/spec/metrics', value: badMetric }])]);
      const unavailable = await eventually(() => deployment.kubectl(['get', 'hpa', 'app', '-o', 'json'], { json: true }),
        (value) => value.status.conditions?.some((item) => item.type === 'ScalingActive' && item.status === 'False' && /FailedGet/u.test(item.reason)), 'honest missing metric HPA condition', 60_000);
      const app = await deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
      assert.equal(app.spec.replicas, 2);
      summary.missingMetric = { conditions: unavailable.status.conditions.map(({ type, status, reason }) => ({ type, status, reason })), replicas: app.spec.replicas };
    } finally {
      await owned();
      await deployment.kubectl(['patch', 'hpa', 'app', '--type=json', '-p', JSON.stringify([{ op: 'replace', path: '/spec/metrics', value: beforeMetric.spec.metrics }])]);
    }
    await eventually(snapshot, (value) => coherent(value, 2) && Number.isFinite(value.hpa.cpuUtilization), 'real CPU metrics recover without touching global add-on', 60_000);
    summary.checks.push('only own HPA metric was deliberately misconfigured; ScalingActive=False reported missing CPU, replicas stayed two and real metrics recovered');

    phase = 'explicit own stop/start preserves PVC, CA, session and saved results';
    await observer.cleanup(); observer = undefined;
    const savedResult = await detail(resultJobId);
    const pvcBefore = await deployment.kubectl(['get', 'pvc', '-o', 'json'], { json: true });
    const caBefore = createHash('sha256').update(await readFile(deployment.caPath)).digest('hex');
    await deployment.stop();
    const stoppedHpa = await deployment.kubectl(['get', 'hpa', 'app', '--ignore-not-found', '-o', 'json']);
    assert.equal(stoppedHpa.trim(), '');
    const stopped = await deployment.kubectl(['get', 'pods', '-l', 'app.kubernetes.io/part-of=courier-route', '-o', 'json'], { json: true });
    assert.equal(stopped.items.filter((pod) => ['app', 'database', 'ingress'].includes(pod.metadata.labels['app.kubernetes.io/component'])).length, 0);
    await pause(5000);
    const stableStop = await deployment.kubectl(['get', 'deployment', 'app', '-o', 'json'], { json: true });
    assert.equal(stableStop.spec.replicas, 0, 'Deleted own HPA must not resurrect explicitly stopped app.');
    await deployment.start();
    const restarted = await eventually(snapshot, (value) => coherent(value, 2), 'explicit restart restores baseline two with active HPA', 90_000);
    const pvcAfter = await deployment.kubectl(['get', 'pvc', '-o', 'json'], { json: true });
    assert.deepEqual(pvcAfter.items.map((item) => item.metadata.uid).sort(), pvcBefore.items.map((item) => item.metadata.uid).sort());
    assert.equal(createHash('sha256').update(await readFile(deployment.caPath)).digest('hex'), caBefore);
    assert.equal((await invoke('same session after explicit stop/start', '/api/auth/me', { cookie: users[0].cookie })).status, 200);
    const preserved = await detail(resultJobId); assert.deepEqual(preserved.result, savedResult.result);
    const finalId = await create(0, squareInput);
    const finalSquare = await eventually(() => detail(finalId), (job) => job.status === 'completed', 'new square after explicit restart', 15_000);
    validateCompletedRoute(finalSquare); assert.equal(finalSquare.result.length, 4);
    summary.restart = { elapsedMs: restarted.elapsedMs, pvcUids: pvcAfter.items.map((item) => item.metadata.uid), caPreserved: true,
      sessionPreserved: true, resultJobId, newJobId: finalId, replicas: restarted.ready };
    summary.checks.push('explicit stop removed own HPA before zero; restart retained PVC/CA/credentials/session/results and a new HTTPS square completed');
    const events = await deployment.kubectl(['get', 'events', '--field-selector', 'involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name=app', '-o', 'json'], { json: true });
    summary.hpaEvents = events.items.map((item) => ({ reason: item.reason, type: item.type, count: item.count,
      firstTimestamp: item.firstTimestamp, lastTimestamp: item.lastTimestamp, message: String(item.message ?? '').slice(0, 240) }));
    summary.acceptedJobs = accepted.size;
    assert.ok(summary.acceptedJobs <= budget.maxAccepted);
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.status = 'failed'; summary.failure = { phase, ...safeFailure(error) };
    if (latest) summary.lastObservation = latest;
    if (deployment && Date.now() < deadlineEpochMs) {
      // Capture only public process fields and owned job state before cleanup
      // removes the evidence. No logs, inputs, results or claim tokens.
      const diagnostics = await Promise.allSettled([
        deployment.kubectl(['get', 'pods', '-l', 'app.kubernetes.io/part-of=courier-route', '-o', 'json'], { json: true, timeoutMs: 10_000 }),
        deployment.sql(`SELECT id,status,instance_id,completed_iterations,total_iterations,
          cancel_requested_at IS NOT NULL AS cancel_requested,failure_reason FROM jobs ORDER BY created_at,id LIMIT 200`),
        deployment.kubectl(['get', 'events', '-o', 'json'], { json: true, timeoutMs: 10_000 }),
      ]);
      if (diagnostics[0].status === 'fulfilled') summary.failurePods = diagnostics[0].value.items.map((pod) => ({
        name: pod.metadata.name, uid: pod.metadata.uid, terminating: !!pod.metadata.deletionTimestamp, phase: pod.status.phase,
        ready: pod.status.conditions?.some((item) => item.type === 'Ready' && item.status === 'True') === true,
        containers: (pod.status.containerStatuses ?? []).map((item) => ({ name: item.name, restarts: item.restartCount,
          ready: item.ready, lastTermination: item.lastState?.terminated ? { reason: item.lastState.terminated.reason,
            exitCode: item.lastState.terminated.exitCode, finishedAt: item.lastState.terminated.finishedAt } : null })) }));
      if (diagnostics[1].status === 'fulfilled') summary.failureJobs = diagnostics[1].value;
      if (diagnostics[2].status === 'fulfilled') summary.failureEvents = diagnostics[2].value.items.map((item) => ({
        reason: item.reason, type: item.type, count: item.count, lastTimestamp: item.lastTimestamp,
        object: { kind: item.involvedObject?.kind, name: item.involvedObject?.name } }));
      summary.failureForwarding = deployment.forwardingInfo?.();
    }
  } finally {
    summary.workElapsedMs = Math.round(performance.now() - started);
    const cleanupStarted = performance.now();
    await withoutDeploymentDeadline(async () => {
      try { if (observer) await observer.cleanup(); }
      catch (error) { failure ??= error; summary.browserCleanupFailure = safeFailure(error); }
      try { if (adminObserver) await adminObserver.cleanup(); }
      catch (error) { failure ??= error; summary.adminBrowserCleanupFailure = safeFailure(error); }
      try {
        if (deployment) { await deployment.assertOwned(); await deployment.cleanup(); summary.cleanupCompleted = true; }
        else summary.provisionCleanupManagedByHelper = true;
      }
      catch (error) { failure ??= error; summary.cleanupFailure = safeFailure(error); }
    });
    summary.cleanupElapsedMs = Math.round(performance.now() - cleanupStarted);
    summary.elapsedMs = Math.round(performance.now() - started);
    if (failure) summary.status = 'failed';
    await save();
  }
  if (failure) {
    console.error(JSON.stringify({ status: 'failed', phase: summary.failure?.phase ?? phase, failure: summary.failure ?? safeFailure(failure),
      elapsedMs: summary.elapsedMs, cleanupCompleted: summary.cleanupCompleted, summary: `.local/autoscale-tests/${ownerId}/summary.json` }));
    throw new Error('Actual HPA acceptance failed; the safe summary identifies its phase.');
  }
  console.log(JSON.stringify({ status: 'passed', checks: summary.checks.length, browserObservations: summary.browser.observations.length,
    acceptedJobs: summary.acceptedJobs, elapsedMs: summary.elapsedMs, cleanupCompleted: summary.cleanupCompleted,
    summary: `.local/autoscale-tests/${ownerId}/summary.json` }));
  return summary;
}

export async function runAutoscale() {
  const budget = autoscaleBudget();
  const deadlineEpochMs = Date.now() + budget.deadlineMs;
  const { withDeploymentDeadline, withoutDeploymentDeadline } = await import('./deployment-command.mjs');
  return withDeploymentDeadline(deadlineEpochMs,
    () => runAutoscaleWithinBudget(budget, deadlineEpochMs, withoutDeploymentDeadline));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAutoscale().catch(() => { process.exitCode = 1; });
}
