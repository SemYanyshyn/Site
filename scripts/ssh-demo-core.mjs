import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { probeReadiness, PublicDemoError } from './public-demo-core.mjs';

export function pinggyOrigin(value) {
  return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.run\.pinggy-free\.link$/u.test(value) ? value : null;
}

export function parsePinggyAnnouncement(text) {
  if (typeof text !== 'string') return null;
  const lines = text.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u).map(line => line.trim());
  if (!text.endsWith('\n')) lines.pop();
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] !== 'You are not authenticated.' || !/^Your tunnel will expire in 60 minutes\.(?: .*)?$/u.test(lines[i + 1])) continue;
    for (const line of lines.slice(i + 2, i + 5)) {
      if (!line.startsWith('https://')) break;
      const url = pinggyOrigin(line);
      if (url) return url;
    }
  }
  return null;
}

export function ownedSshDemoProcess(record, identity) {
  return Number.isInteger(record?.pid) && record.pid > 1 && /^[0-9a-f-]{36}$/u.test(record.sessionId ?? '')
    && typeof record.started === 'string' && record.started.length > 0 && identity?.started === record.started
    && typeof record.binary === 'string' && typeof record.script === 'string'
    && identity.command === `${record.binary} ${record.script} worker ${record.sessionId}`;
}

export function sshArguments(port, knownHosts, keyPath) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new PublicDemoError('Некоректний порт локального адаптера.');
  if (typeof keyPath !== 'string' || !keyPath.startsWith('/')) throw new PublicDemoError('Потрібен окремий локальний SSH-ключ.');
  return ['-T', '-F', '/dev/null', '-p', '443',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UpdateHostKeys=no', '-i', keyPath, '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'PubkeyAuthentication=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PreferredAuthentications=publickey', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-R', `0:127.0.0.1:${port}`, 'free.pinggy.io', 'x:https', 'x:passpreflight'];
}

function endToEndHeaders(headers) {
  const result = { ...headers };
  for (const field of String(headers.connection ?? '').split(',')) delete result[field.trim().toLowerCase()];
  for (const field of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete result[field];
  return result;
}

export async function startHttpsBridge({ port, ca, timeoutMs = 30_000 }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !ca) throw new PublicDemoError('Потрібні локальний HTTPS-порт та CA.');
  const requests = new Set();
  const server = createServer((incoming, outgoing) => {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) { outgoing.writeHead(400).end(); return; }
    const headers = { ...endToEndHeaders(incoming.headers), host: 'localhost' };
    const upstream = httpsRequest({ hostname: 'localhost', port, path: incoming.url, method: incoming.method,
      headers, ca, servername: 'localhost', rejectUnauthorized: true }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
      response.on('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    requests.add(upstream);
    const timer = setTimeout(() => upstream.destroy(new Error('upstream deadline')), timeoutMs);
    const finish = () => { clearTimeout(timer); requests.delete(upstream); };
    upstream.on('close', finish);
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"code":"LOCAL_HTTPS_UNAVAILABLE"}');
      else outgoing.destroy();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = timeoutMs;
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return { port: server.address().port, close: async () => {
    for (const request of requests) request.destroy();
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
  } };
}

export async function sshDemoStatus(record, { isRunning, announcement, probe = probeReadiness, now = Date.now }) {
  const running = await isRunning();
  const base = { provider: 'pinggy', running, ready: false, url: null,
    phase: running ? 'unavailable' : record?.expiresAt && now() >= Date.parse(record.expiresAt) ? 'expired' : record?.phase === 'failed' ? 'failed' : 'stopped',
    expiresAt: record?.expiresAt ?? null, checkedAt: new Date(now()).toISOString() };
  if (!running) return base;
  const current = await announcement();
  if (!pinggyOrigin(record?.url) || current?.sessionId !== record.sessionId || current?.url !== record.url) return { ...base, phase: 'address_unverified' };
  const readiness = await probe(record.url, { originHeader: record.url });
  const stillRunning = await isRunning();
  const ready = readiness.ready && stillRunning;
  return { ...base, running: stillRunning, ready, url: ready ? record.url : null,
    phase: ready ? 'ready' : 'unavailable', readiness, checkedAt: new Date(now()).toISOString() };
}

export async function configureSshDemo(record, { isRunning, announcement, deploy, save,
  probe = probeReadiness, timeoutMs = 30_000, now = Date.now, sleep = delay }) {
  const current = await announcement();
  if (!pinggyOrigin(record.url) || current?.sessionId !== record.sessionId || current?.url !== record.url) {
    throw new PublicDemoError('Pinggy не підтвердив адресу цього тунелю; deployment не запускався.');
  }
  const wait = async (withOrigin) => {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (!await isRunning()) throw new PublicDemoError('SSH-тунель завершився до перевірки доступності.');
      const result = await probe(record.url, { timeoutMs: Math.min(5_000, Math.max(1, deadline - now())), ...(withOrigin ? { originHeader: record.url } : {}) });
      if (result.ready && await isRunning()) return result;
      await sleep(Math.min(1_000, Math.max(0, deadline - now())));
    }
    throw new PublicDemoError('Публічна readiness Pinggy не підтверджена за 30 секунд; перевірте .local/ssh-demo/tunnel.log.');
  };
  record.phase = 'verifying'; await save(record);
  await wait(false);
  if (record.configured) {
    const origin = await probe(record.url, { originHeader: record.url });
    if (origin.httpStatus === 403 || origin.reason === 'origin_not_allowed') record.configured = false;
    else record.readiness = origin.ready ? origin : await wait(true);
  }
  if (!record.configured) {
    record.phase = 'configuring'; await save(record);
    await deploy(record.url);
    record.configured = true;
    record.readiness = await wait(true);
  }
  if (!await isRunning()) throw new PublicDemoError('SSH-тунель завершився після розгортання.');
  record.phase = 'ready'; await save(record);
  return { provider: 'pinggy', running: true, ready: true, url: record.url, phase: 'ready', expiresAt: record.expiresAt, readiness: record.readiness };
}
