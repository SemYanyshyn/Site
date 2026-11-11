import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentAppOrigins, ownedTunnelProcess } from '../scripts/public-origins.mjs';

test('public demo adds exact HTTPS origins while always retaining the original local deployment', () => {
  const local = 'https://localhost:8443';
  assert.equal(deploymentAppOrigins(local, undefined), local);
  assert.equal(deploymentAppOrigins(local, ''), local);
  assert.equal(deploymentAppOrigins(local, 'https://route.example.test,https://route.example.test/'), `${local},https://route.example.test`);
});
test('public demo rejects wildcards, non-HTTPS, paths and secrets without reflecting their values', () => {
  for (const value of ['*', 'http://example.test', 'https://*.example.test', 'https://user:private-sentinel@example.test',
    'https://example.test/path', 'https://example.test?token=private-sentinel', 'https://localhost', 'https://example.test,']) {
    assert.throws(() => deploymentAppOrigins('https://localhost:8443', value), (error: unknown) => error instanceof Error && !error.message.includes('private-sentinel'));
  }
});
test('stop guard refuses reused PIDs, other executables and different process start times', () => {
  const record = { pid: 1234, binary: '/owned/tools/cloudflared', started: 'Mon Nov 2 12:00:00 2026' };
  const identity = { started: record.started, command: '/owned/tools/cloudflared tunnel --url https://localhost:8443' };
  assert.equal(ownedTunnelProcess(record, identity), true);
  for (const changed of [null, { ...identity, started: 'different time' }, { ...identity, command: 'unrelated process' }]) assert.equal(ownedTunnelProcess(record, changed), false);
  assert.equal(ownedTunnelProcess({ ...record, pid: 1 }, identity), false);
});

import { parseQuickTunnelUrl, quickTunnelOrigin, quickTunnelFailure, waitForQuickTunnelUrl, probeReadiness, publicDemoStatus, configurePublicDemo } from '../scripts/public-demo-core.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const tunnelUrl = 'https://courier-route-demo-example.trycloudflare.com';
const banner = (url = tunnelUrl): string => [
  '2026-11-04T20:50:28Z INF +--------------------------------------------------------------------------------------------+',
  '2026-11-04T20:50:28Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  `2026-11-04T20:50:28Z INF |  ${url}                                    |`,
  '2026-11-04T20:50:28Z INF +--------------------------------------------------------------------------------------------+',
].join('\n');
const apiTimeout = 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded (Client.Timeout exceeded while awaiting headers)';
const ready = { ready: true, reason: 'ready', checkedAt: '2026-11-04T21:00:00.000Z', httpStatus: 200 };
const unavailable = { ...ready, ready: false, reason: 'timeout', httpStatus: null };
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
}

test('Quick Tunnel address comes only from its successful cloudflared banner', () => {
  assert.equal(parseQuickTunnelUrl(banner()), tunnelUrl);
  assert.equal(parseQuickTunnelUrl(banner().replaceAll('\n', '\r\n')), tunnelUrl);
  for (const text of [apiTimeout, `ERR ${tunnelUrl}`, `INF Documentation: ${tunnelUrl}`, tunnelUrl,
    banner('https://api.trycloudflare.com'), banner('https://docs.trycloudflare.com'),
    banner(tunnelUrl + '/path'), banner(tunnelUrl + '?token=private-sentinel'),
    banner().replace('INF |  https', 'ERR |  https'),
    banner().replace('created!', 'not created!'), banner().replace('INF |  Your', 'ERR |  Your')]) {
    assert.equal(parseQuickTunnelUrl(text), null);
  }
});

test('Quick Tunnel origins exclude service hosts, credentials, ports and lookalike domains', () => {
  assert.equal(quickTunnelOrigin(tunnelUrl), tunnelUrl);
  for (const url of ['https://api.trycloudflare.com', 'https://www.trycloudflare.com',
    'https://api.trycloudflare.com/tunnel', 'http://a.trycloudflare.com',
    'https://a.trycloudflare.com.attacker.test', 'https://a.trycloudflare.com:443',
    'https://user:private-sentinel@a.trycloudflare.com', null]) assert.equal(quickTunnelOrigin(url), null);
});

test('Quick Tunnel creation timeout is a safe specific error and never a demo URL', async () => {
  assert.match(quickTunnelFailure(apiTimeout).message, /таймаут/u);
  await assert.rejects(waitForQuickTunnelUrl({ readLog: async () => apiTimeout, isRunning: async () => true }),
    (error: unknown) => error instanceof Error && /таймаут/u.test(error.message) && !error.message.includes('https://api.'));
  assert.equal(quickTunnelFailure('unrelated info'), null);
});

test('Quick Tunnel rejects process exit before its URL, including a banner from an exited process', async () => {
  for (const log of ['', banner()]) await assert.rejects(waitForQuickTunnelUrl({
    readLog: async () => log, isRunning: async () => false,
  }), /завершився/u);
});

test('Quick Tunnel waits for a complete success message and has a bounded creation deadline', async () => {
  let reads = 0;
  assert.equal(await waitForQuickTunnelUrl({ readLog: async () => ++reads === 1 ? 'Requesting new quick Tunnel...' : banner(),
    isRunning: async () => true, ...fakeClock() }), tunnelUrl);
  await assert.rejects(waitForQuickTunnelUrl({ readLog: async () => 'Requesting...', isRunning: async () => true,
    timeoutMs: 25, pollMs: 10, ...fakeClock() }), /не підтвердив/u);
});

test('status never treats historical ready or an alive process as current public readiness', async () => {
  const record = { url: tunnelUrl, phase: 'ready', readiness: ready };
  let probes = 0;
  const dependencies = { readLog: async () => banner(), probe: async () => { probes++; return unavailable; }, ...fakeClock() };
  const stopped = await publicDemoStatus(record, { ...dependencies, isRunning: async () => false });
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.ready, false); assert.equal(stopped.url, null); assert.equal(probes, 0);
  const alive = await publicDemoStatus(record, { ...dependencies, isRunning: async () => true });
  assert.equal(alive.running, true); assert.equal(alive.ready, false); assert.equal(alive.phase, 'unavailable');
  assert.equal(alive.url, null); assert.equal(alive.readiness.reason, 'timeout'); assert.equal(probes, 1);
  assert.notEqual(alive.checkedAt, ready.checkedAt);
});

test('status refuses legacy API URLs and URLs without a success banner before any network request', async () => {
  for (const [url, log] of [['https://api.trycloudflare.com', apiTimeout], [tunnelUrl, '']]) {
    const result = await publicDemoStatus({ url, phase: 'ready' }, { isRunning: async () => true,
      readLog: async () => log, probe: async () => assert.fail('unverified URL must not be fetched') });
    assert.equal(result.running, true); assert.equal(result.ready, false); assert.equal(result.url, null);
    assert.equal(result.phase, 'invalid_url');
  }
});

test('status publishes a URL only after a fresh successful probe and a second process check', async () => {
  for (const stillRunning of [true, false]) {
    let checks = 0;
    const result = await publicDemoStatus({ url: tunnelUrl, phase: 'failed' }, {
      readLog: async () => banner(), isRunning: async () => ++checks === 1 || stillRunning, probe: async () => ready,
    });
    assert.equal(result.ready, stillRunning); assert.equal(result.running, stillRunning);
    assert.equal(result.url, stillRunning ? tunnelUrl : null); assert.equal(checks, 2);
  }
});

test('start cannot deploy or change Origins for an API URL or an unverified candidate', async () => {
  for (const [url, log] of [['https://api.trycloudflare.com', apiTimeout], [tunnelUrl, '']]) {
    await assert.rejects(configurePublicDemo({ url }, { readLog: async () => log, isRunning: async () => true,
      probe: async () => assert.fail('must not probe'), deploy: async () => assert.fail('must not deploy'),
      save: async () => assert.fail('must not save invalid URL') }), /Origins не змінено/u);
  }
});

test('start verifies public readiness before deployment and checks it again afterwards', async () => {
  const events: string[] = [];
  const record = { url: tunnelUrl, phase: 'starting', configured: false };
  const result = await configurePublicDemo(record, { readLog: async () => banner(), isRunning: async () => true,
    probe: async () => { events.push('probe'); return ready; },
    deploy: async (url: string) => { assert.equal(url, tunnelUrl); events.push('deploy'); }, save: async () => {},
  });
  assert.deepEqual(events, ['probe', 'deploy', 'probe']); assert.equal(result.ready, true);
  assert.equal(record.configured, true); assert.equal(record.phase, 'ready');
});

test('repeated start rechecks stale ready, skips duplicate deployment, and fails with a deadline if unreachable', async () => {
  for (const reachable of [true, false]) {
    let probes = 0;
    const record = { url: tunnelUrl, phase: 'ready', configured: true, readiness: ready };
    const run = configurePublicDemo(record, { readLog: async () => banner(), isRunning: async () => true,
      probe: async () => { probes++; return reachable ? ready : unavailable; }, timeoutMs: 25, ...fakeClock(),
      deploy: async () => assert.fail('repeat start must not redeploy configured tunnel'), save: async () => {},
    });
    if (reachable) { assert.equal((await run).ready, true); assert.equal(probes, 2); }
    else { await assert.rejects(run, /не підтверджена/u); assert.equal(record.phase, 'verifying'); assert.equal(probes, 1); }
  }
});

function fakeRequest(mode: 'ready' | 'wrong' | 'redirect' | 'headers-hang' | 'body-hang' | 'large' | 'tls-error') {
  const observed = { destroyed: false, rejectUnauthorized: false, ca: undefined as unknown };
  const request = (_url: URL, options: { rejectUnauthorized: boolean; ca?: unknown }, callback: (incoming: PassThrough & { statusCode: number }) => void) => {
    observed.rejectUnauthorized = options.rejectUnauthorized; observed.ca = options.ca;
    const req = Object.assign(new EventEmitter(), { destroy: () => { observed.destroyed = true; }, end: () => queueMicrotask(() => {
      if (mode === 'tls-error') { req.emit('error', new Error('private-sentinel')); return; }
      if (mode === 'headers-hang') return;
      const response = Object.assign(new PassThrough(), { statusCode: mode === 'redirect' ? 302 : 200 });
      callback(response);
      if (mode === 'body-hang') return;
      response.end(mode === 'large' ? 'x'.repeat(8193) : JSON.stringify({ status: mode === 'ready' ? 'ready' : 'unknown' }));
    }) });
    return req;
  };
  return { request, observed };
}

test('HTTPS readiness enforces TLS, validates JSON and status, and does not follow redirects', async () => {
  for (const mode of ['ready', 'wrong', 'redirect', 'large', 'tls-error'] as const) {
    const fixture = fakeRequest(mode);
    const result = await probeReadiness(tunnelUrl, { request: fixture.request, timeoutMs: 100 });
    assert.equal(result.ready, mode === 'ready'); assert.equal(fixture.observed.rejectUnauthorized, true);
    assert.equal(fixture.observed.ca, undefined); assert.equal(fixture.observed.destroyed, true);
    assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
  const local = fakeRequest('ready');
  await probeReadiness('https://localhost:8443', { request: local.request, ca: 'test-ca' });
  assert.equal(local.observed.ca, 'test-ca'); assert.equal(local.observed.rejectUnauthorized, true);
});

test('HTTPS readiness deadlines include stalled headers and an unfinished response body', async () => {
  for (const mode of ['headers-hang', 'body-hang'] as const) {
    const fixture = fakeRequest(mode);
    const result = await probeReadiness(tunnelUrl, { request: fixture.request, timeoutMs: 25 });
    assert.equal(result.ready, false); assert.equal(result.reason, 'timeout'); assert.equal(fixture.observed.destroyed, true);
  }
});

test('repeated start restores a reset exact Origin only after fresh public readiness', async () => {
  const events: string[] = [];
  const record = { url: tunnelUrl, phase: 'ready', configured: true };
  let deployed = false;
  const result = await configurePublicDemo(record, { readLog: async () => banner(), isRunning: async () => true,
    probe: async (_url: string, options: { originHeader?: string }) => {
      events.push(options.originHeader ? 'origin' : 'public');
      return options.originHeader && !deployed ? { ...unavailable, httpStatus: 403 } : ready;
    }, deploy: async (url: string) => { assert.equal(url, tunnelUrl); events.push('deploy'); deployed = true; }, save: async () => {},
  });
  assert.deepEqual(events, ['public', 'origin', 'deploy', 'origin']);
  assert.equal(result.ready, true);
});
