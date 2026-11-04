import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

export class PublicDemoError extends Error {}

export function quickTunnelOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(value)) return null;
  const label = new URL(value).hostname.split('.')[0];
  return ['api', 'www', 'docs', 'developers'].includes(label) ? null : value;
}

// Беру адресу тільки з наступного рядка успішного банера cloudflared, а не з довільного URL у журналі.
export function parseQuickTunnelUrl(text) {
  const lines = text.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u);
  const body = (line) => line?.match(/^(?:\S+\s+INF\s+)?\|\s*(.*?)\s*\|\s*$/u)?.[1];
  for (let index = 0; index < lines.length - 1; index++) {
    if (body(lines[index]) !== 'Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):') continue;
    const origin = quickTunnelOrigin(body(lines[index + 1]));
    if (origin) return origin;
  }
  return null;
}

export function quickTunnelFailure(text) {
  const failure = text.split(/\r?\n/u).find((line) => /failed to request quick Tunnel/iu.test(line));
  if (!failure) return null;
  return new PublicDemoError(/deadline|timed?\s*out|timeout/iu.test(failure)
    ? 'Cloudflare не створив Quick Tunnel: таймаут звернення до API. Перевірте мережевий доступ до api.trycloudflare.com; локальний застосунок не змінено.'
    : 'Не вдалося створити Quick Tunnel через API Cloudflare. Перевірте приватний журнал .local/public-demo/tunnel.log; локальний застосунок не змінено.');
}

export async function waitForQuickTunnelUrl({ readLog, isRunning, timeoutMs = 30_000, pollMs = 200, now = Date.now, sleep = delay }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const text = await readLog();
    const failure = quickTunnelFailure(text);
    if (failure) throw failure;
    if (!await isRunning()) throw new PublicDemoError('cloudflared завершився до отримання адреси Quick Tunnel. Перевірте .local/public-demo/tunnel.log.');
    const origin = parseQuickTunnelUrl(text);
    if (origin) return origin;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new PublicDemoError('Cloudflare не підтвердив створення Quick Tunnel протягом 30 секунд; адресу демо не отримано.');
}

// Таймер діє до кінця тіла відповіді, зокрема при завислому DNS, TLS або незавершеному JSON.
export function probeReadiness(origin, { timeoutMs = 5_000, ca, originHeader, request = httpsRequest, now = Date.now } = {}) {
  return new Promise((resolve) => {
    let req;
    let response;
    let settled = false;
    const finish = (ready, reason, httpStatus = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ready, reason, httpStatus, checkedAt: new Date(now()).toISOString() });
      response?.destroy();
      req?.destroy();
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    try {
      const target = new URL('/api/ready', origin);
      if (target.protocol !== 'https:') { finish(false, 'invalid_url'); return; }
      req = request(target, { method: 'GET', ...(ca ? { ca } : {}),
        ...(originHeader ? { headers: { Origin: originHeader } } : {}), rejectUnauthorized: true }, (incoming) => {
        response = incoming;
        if (incoming.statusCode !== 200) { finish(false, 'http_error', incoming.statusCode); return; }
        if (originHeader && (incoming.headers['access-control-allow-origin'] !== originHeader
          || incoming.headers['access-control-allow-credentials'] !== 'true')) {
          finish(false, 'origin_not_allowed', incoming.statusCode); return;
        }
        let size = 0;
        const chunks = [];
        incoming.on('error', () => finish(false, 'network_error', incoming.statusCode));
        incoming.on('aborted', () => finish(false, 'network_error', incoming.statusCode));
        incoming.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > 8_192) { finish(false, 'invalid_response', incoming.statusCode); return; }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('end', () => {
          try {
            const ready = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.status === 'ready';
            finish(ready, ready ? 'ready' : 'invalid_response', incoming.statusCode);
          } catch { finish(false, 'invalid_response', incoming.statusCode); }
        });
      });
      req.on('error', () => finish(false, 'network_error'));
      req.end();
    } catch { finish(false, 'network_error'); }
  });
}

export async function publicDemoStatus(record, { isRunning, readLog, probe = probeReadiness, now = Date.now }) {
  const running = await isRunning();
  const base = { running, ready: false, url: null, phase: 'stopped', recordedPhase: record?.phase ?? null,
    checkedAt: new Date(now()).toISOString(), readiness: { ready: false, reason: 'not_running', checkedAt: null, httpStatus: null } };
  if (!running) return { ...base, phase: record?.phase === 'failed' ? 'failed' : 'stopped' };
  if (!quickTunnelOrigin(record?.url) || parseQuickTunnelUrl(await readLog()) !== record.url) {
    return { ...base, phase: 'invalid_url', readiness: { ...base.readiness, reason: 'unverified_url' } };
  }
  const readiness = await probe(record.url, { originHeader: record.url });
  // Повторно звіряю процес після HTTP: він міг завершитися під час запиту.
  const stillRunning = await isRunning();
  const ready = stillRunning && readiness.ready;
  return { ...base, running: stillRunning, ready, url: ready ? record.url : null, phase: ready ? 'ready' : 'unavailable',
    checkedAt: new Date(now()).toISOString(), readiness: stillRunning ? readiness : { ...readiness, ready: false, reason: 'not_running' } };
}

async function awaitPublicReadiness(record, { isRunning, probe, timeoutMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    if (!await isRunning()) throw new PublicDemoError('cloudflared завершився до підтвердження публічної readiness.');
    last = await probe(record.url, { timeoutMs: Math.min(5_000, Math.max(1, deadline - now())) });
    if (last.ready && await isRunning()) return last;
    await sleep(Math.min(1_000, Math.max(0, deadline - now())));
  }
  throw new PublicDemoError(`Публічна /api/ready не підтверджена протягом 30 секунд (${last?.reason ?? 'timeout'}). Перевірте мережу та .local/public-demo/tunnel.log.`);
}

export async function configurePublicDemo(record, {
  readLog, isRunning, deploy, save, probe = probeReadiness, timeoutMs = 30_000, now = Date.now, sleep = delay,
}) {
  // До будь-якого deploy перевіряю походження URL, живий процес та справжню публічну readiness.
  if (!quickTunnelOrigin(record.url) || parseQuickTunnelUrl(await readLog()) !== record.url) {
    throw new PublicDemoError('Немає підтвердженої адреси створеного Quick Tunnel; deployment і Origins не змінено.');
  }
  const dependencies = { isRunning, probe, timeoutMs, now, sleep };
  record.phase = 'verifying';
  record.readiness = { ready: false, reason: 'checking', checkedAt: null, httpStatus: null };
  await save(record);
  record.readiness = await awaitPublicReadiness(record, dependencies);
  const originDependencies = { ...dependencies, probe: (url, options) => probe(url, { ...options, originHeader: url }) };
  if (record.configured) {
    const originCheck = await probe(record.url, { timeoutMs: 5_000, originHeader: record.url });
    // Після окремого deploy:local старий allowlist міг бути скинутий; тоді відновлюю його штатно.
    if (originCheck.httpStatus === 403 || originCheck.reason === 'origin_not_allowed') record.configured = false;
    else record.readiness = originCheck.ready ? originCheck : await awaitPublicReadiness(record, originDependencies);
  }
  if (!record.configured) {
    record.phase = 'configuring'; await save(record);
    await deploy(record.url);
    record.configured = true;
    record.readiness = await awaitPublicReadiness(record, originDependencies);
  }
  if (!await isRunning()) throw new PublicDemoError('cloudflared завершився до підтвердження публічної readiness.');
  record.phase = 'ready'; await save(record);
  return { running: true, ready: true, url: record.url, phase: 'ready', checkedAt: record.readiness.checkedAt, readiness: record.readiness };
}
