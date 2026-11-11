import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { pinggyOrigin, parsePinggyAnnouncement, ownedSshDemoProcess, sshArguments, startHttpsBridge, sshDemoStatus, configureSshDemo } from '../scripts/ssh-demo-core.mjs';

const url = 'https://a1b2c3d4e5.run.pinggy-free.link';
const sessionId = '12345678-1234-1234-1234-123456789abc';
const banner = (origin = url): string => `You are not authenticated.\nYour tunnel will expire in 60 minutes. Upgrade to Pinggy Pro. https://dashboard.pinggy.io\nhttps://legacy.free.pinggy.net\n${origin}\n`;
const ready = { ready: true, reason: 'ready', httpStatus: 200, checkedAt: '2026-11-04T21:00:00Z' };
const unavailable = { ...ready, ready: false, reason: 'timeout', httpStatus: null };
function clock() { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; }

test('Pinggy accepts only the assigned free HTTPS URL after its actual SSH session banner', () => {
  assert.equal(pinggyOrigin(url), url);
  assert.equal(parsePinggyAnnouncement(banner()), url);
  for (const value of [url, `Error: ${url}`, banner().replace('You are not authenticated.', 'Error:'),
    banner().replace('will expire in 60', 'failed after 60'), banner('https://dashboard.pinggy.io'),
    banner('https://attacker.test'), banner(url + '/path'), banner().trimEnd()]) assert.equal(parsePinggyAnnouncement(value), null);
  for (const value of ['https://a.lhr.life', 'http://a.run.pinggy-free.link', 'https://a.run.pinggy-free.link/path',
    'https://a.run.pinggy-free.link?token=private-sentinel', 'https://user:private-sentinel@a.run.pinggy-free.link',
    'https://a.run.pinggy-free.link:443', 'https://a.run.pinggy-free.link.attacker.test']) assert.equal(pinggyOrigin(value), null);
});

test('SSH uses an isolated TOFU known_hosts and never personal keys or disabled host verification', () => {
  const args = sshArguments(12345, '/private/known_hosts', '/private/dedicated_key');
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(args.includes('UserKnownHostsFile=/private/known_hosts'));
  assert.ok(args.includes('/private/dedicated_key')); assert.ok(args.includes('IdentitiesOnly=yes')); assert.ok(args.includes('IdentityAgent=none'));
  assert.ok(args.includes('PubkeyAuthentication=yes')); assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('0:127.0.0.1:12345')); assert.ok(args.includes('free.pinggy.io'));
  assert.ok(!args.includes('StrictHostKeyChecking=no'));
  assert.throws(() => sshArguments(22, '/private/known_hosts'));
});

test('stop ownership guard refuses reused PIDs, changed start times, other scripts and sessions', () => {
  const record = { pid: 1234, sessionId, started: 'start', binary: '/node', script: '/project/scripts/ssh-demo-worker.mjs' };
  const identity = { started: 'start', command: `${record.binary} ${record.script} worker ${sessionId}` };
  assert.equal(ownedSshDemoProcess(record, identity), true);
  for (const changed of [null, { ...identity, started: 'other' }, { ...identity, command: 'unrelated' },
    { ...identity, command: identity.command + ' another-session' }]) assert.equal(ownedSshDemoProcess(record, changed), false);
  assert.equal(ownedSshDemoProcess({ ...record, pid: 1 }, identity), false);
});

test('SSH status rechecks stale readiness and hides dead, changed or unreachable URLs', async () => {
  const record = { sessionId, url, phase: 'ready' };
  for (const alive of [true, false]) {
    const result = await sshDemoStatus(record, { isRunning: async () => alive, announcement: async () => ({ sessionId, url }), probe: async () => unavailable });
    assert.equal(result.running, alive); assert.equal(result.ready, false); assert.equal(result.url, null);
  }
  const changed = await sshDemoStatus(record, { isRunning: async () => true, announcement: async () => ({ sessionId, url: 'https://new.run.pinggy-free.link' }),
    probe: async () => assert.fail('changed address must not be probed') });
  assert.equal(changed.phase, 'address_unverified'); assert.equal(changed.url, null);
  const fresh = await sshDemoStatus(record, { isRunning: async () => true, announcement: async () => ({ sessionId, url }),
    probe: async (_url: string, options: { originHeader: string }) => { assert.equal(options.originHeader, url); return ready; } });
  assert.equal(fresh.ready, true); assert.equal(fresh.url, url);
});

test('SSH status checks process exit during the public request', async () => {
  let calls = 0;
  const result = await sshDemoStatus({ sessionId, url }, { isRunning: async () => ++calls === 1,
    announcement: async () => ({ sessionId, url }), probe: async () => ready });
  assert.equal(result.ready, false); assert.equal(result.running, false); assert.equal(result.url, null);
});

test('SSH start does not deploy before an assigned address, live process and public readiness', async () => {
  await assert.rejects(configureSshDemo({ sessionId, url: 'https://api.pinggy.io' }, { announcement: async () => ({ sessionId, url }),
    deploy: async () => assert.fail('unverified deployment') }), /не підтвердив/u);
  for (const alive of [true, false]) await assert.rejects(configureSshDemo({ sessionId, url }, {
    announcement: async () => ({ sessionId, url }), isRunning: async () => alive, probe: async () => unavailable,
    save: async () => {}, deploy: async () => assert.fail('unreachable deployment'), timeoutMs: 25, ...clock(),
  }), /readiness|завершився/u);
});

test('SSH start and repeat preserve exact Origin, avoid redundant deploy, and restore a reset allowlist', async () => {
  for (const configured of [true, false]) {
    const events: string[] = [];
    const result = await configureSshDemo({ sessionId, url, configured }, { announcement: async () => ({ sessionId, url }), isRunning: async () => true,
      probe: async (_url: string, options: { originHeader?: string }) => { events.push(options.originHeader ? 'origin' : 'ready'); return ready; },
      deploy: async (value: string) => { assert.equal(value, url); events.push('deploy'); }, save: async () => {},
    });
    assert.equal(result.ready, true); assert.deepEqual(events, configured ? ['ready', 'origin'] : ['ready', 'deploy', 'origin']);
  }
  let deployed = false;
  const result = await configureSshDemo({ sessionId, url, configured: true }, { announcement: async () => ({ sessionId, url }), isRunning: async () => true,
    probe: async (_url: string, options: { originHeader?: string }) => options.originHeader && !deployed ? { ...unavailable, httpStatus: 403 } : ready,
    deploy: async () => { deployed = true; }, save: async () => {},
  });
  assert.equal(deployed, true); assert.equal(result.ready, true);
});

let directory: string;
let cert: Buffer;
let key: Buffer;
let wrongCert: Buffer;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'courier-ssh-tls-'));
  for (const name of ['local', 'other']) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(directory, name + '.key'), '-out', join(directory, name + '.crt')], { stdio: 'ignore' });
  cert = await readFile(join(directory, 'local.crt')); key = await readFile(join(directory, 'local.key')); wrongCert = await readFile(join(directory, 'other.crt'));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('loopback bridge reaches actual HTTPS, preserves Origin/cookies/body, overrides Host and strips hop headers', async () => {
  const server = createServer({ cert, key }, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['fixture=session; Secure; HttpOnly; SameSite=Lax'] });
    response.end(JSON.stringify({ headers: request.headers, path: request.url, body: Buffer.concat(chunks).toString() }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const bridge: { port: number; close: () => Promise<void> } = await startHttpsBridge({ port: address.port, ca: cert });
  try {
    const response: Response = await fetch(`http://127.0.0.1:${bridge.port}/api/jobs?x=1`, { method: 'POST', headers: {
      Origin: url, Cookie: 'fixture=request', Host: 'public.lhr.life', 'Content-Type': 'application/json', 'Proxy-Authorization': 'fixture-only',
    }, body: '{"sample":true}' });
    assert.equal(response.status, 200);
    const body = await response.json() as { headers: Record<string, string>; path: string; body: string };
    assert.equal(body.headers['proxy-authorization'], undefined); assert.equal(body.headers.host, 'localhost'); assert.equal(body.headers.origin, url); assert.equal(body.headers.cookie, 'fixture=request');
    assert.equal(body.path, '/api/jobs?x=1'); assert.equal(body.body, '{"sample":true}');
    assert.match(response.headers.get('set-cookie') ?? '', /Secure; HttpOnly; SameSite=Lax/);
  } finally { await bridge.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('loopback bridge rejects an untrusted upstream certificate and has a hard request timeout', async () => {
  const server = createServer({ cert, key }, () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    for (const ca of [wrongCert, cert]) {
      const bridge: { port: number; close: () => Promise<void> } = await startHttpsBridge({ port: address.port, ca, timeoutMs: 40 });
      try {
        const response: Response = await fetch(`http://127.0.0.1:${bridge.port}/api/ready`);
        assert.equal(response.status, 502); assert.deepEqual(await response.json(), { code: 'LOCAL_HTTPS_UNAVAILABLE' });
      } finally { await bridge.close(); }
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('expired free sessions never expose a historical ready URL', async () => {
  const result = await sshDemoStatus({ sessionId, url, phase: 'ready', expiresAt: '2026-01-01T00:00:00Z' }, {
    isRunning: async () => false, now: () => Date.parse('2026-11-04T21:00:00Z'),
    announcement: async () => assert.fail('dead session must not be queried'),
  });
  assert.equal(result.phase, 'expired'); assert.equal(result.ready, false); assert.equal(result.url, null);
});
