import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, access, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PublicDemoError, probeReadiness } from './public-demo-core.mjs';
import { pinggyOrigin, parsePinggyAnnouncement, ownedSshDemoProcess, configureSshDemo, sshDemoStatus } from './ssh-demo-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local/ssh-demo');
const script = join(root, 'scripts/ssh-demo-worker.mjs');
const statePath = join(directory, 'state.json');
const lockPath = join(directory, 'operation.lock');
const execute = promisify(execFile);
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const options = { timeout: 3_000, maxBuffer: 16_384 };
    const [started, command] = await Promise.all([execute('ps', ['-p', String(pid), '-o', 'lstart='], options), execute('ps', ['-p', String(pid), '-o', 'command='], options)]);
    return { started: started.stdout.trim(), command: command.stdout.trim() };
  } catch { return null; }
}
async function running(record) { return ownedSshDemoProcess(record, await identity(record?.pid)); }
async function save(record) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...record, url: pinggyOrigin(record.url) }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, statePath);
}
async function announcement(record) {
  if (!/^[0-9a-f-]{36}$/u.test(record?.sessionId ?? '')) return null;
  const current = await readJson(join(directory, 'sessions', record.sessionId + '.status.json'));
  return current?.pid === record.pid && current.sessionId === record.sessionId
    && current.proof?.source === 'ssh://free.pinggy.io:443'
    && parsePinggyAnnouncement(current.proof.text) === current.url ? current : null;
}
async function stop(record) {
  if (!await running(record)) return;
  try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (!await running(record)) return; await delay(150); }
  throw new PublicDemoError('SSH worker не завершився за 10 секунд; перевірте .local/ssh-demo/worker.log.');
}
async function acquireLock() {
  const previous = await readJson(lockPath);
  if (previous && !await identity(previous.pid)) {
    // Прибираю лише власний покинутий lock, якщо вміст не змінився під час перевірки.
    if (JSON.stringify(await readJson(lockPath)) === JSON.stringify(previous)) await rm(lockPath, { force: true });
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
}
async function deploy(origin) {
  const log = openSync(join(directory, 'deployment.log'), 'w', 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ['scripts/deploy-local.mjs', 'up'], { cwd: root,
        env: { ...process.env, COURIER_ADDITIONAL_APP_ORIGINS: origin }, stdio: ['ignore', log, log] });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new PublicDemoError('Deployment перевищив 15 хвилин.')); }, 900_000);
      child.once('error', () => { clearTimeout(timer); reject(new PublicDemoError('Не вдалося запустити deployment.')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? accept() : reject(new PublicDemoError('Deployment не пройшов; перевірте .local/ssh-demo/deployment.log.')); });
    });
  } finally { closeSync(log); }
}

export async function main(command = 'status') {
  await mkdir(join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  let locked = false;
  let active;
  let startedHere = false;
  let child;
  try {
    let previous = await readJson(statePath);
    if (command === 'status') {
      console.log(JSON.stringify(await sshDemoStatus(previous, { isRunning: () => running(previous), announcement: () => announcement(previous) }), null, 2));
      return;
    }
    assert.ok(['start', 'stop'].includes(command), 'Команди: demo:ssh, demo:ssh:status, demo:ssh:stop.');
    await acquireLock(); locked = true;
    previous = await readJson(statePath);
    if (command === 'stop') {
      await stop(previous);
      if (previous) await save({ ...previous, phase: 'stopped' });
      console.log('SSH-тунель і локальний адаптер зупинено. Kubernetes і дані збережено.');
      return;
    }
    assert.equal(process.versions.node.split('.')[0], '24', 'Потрібен Node.js 24 і npm 11.');
    if (await running(previous)) active = { ...previous };
    else {
      const cluster = await readJson(join(root, '.local/deploy/cluster.json'));
      assert.equal(cluster?.cluster, 'courier-route'); assert.equal(cluster.context, 'kind-courier-route');
      assert.ok(Number.isInteger(cluster.httpsPort) && cluster.httpsPort >= 1024 && cluster.httpsPort <= 65535);
      const ca = await readFile(join(root, '.local/deploy/tls/ca.crt'));
      if (!(await probeReadiness(`https://localhost:${cluster.httpsPort}`, { ca })).ready) throw new PublicDemoError('Локальна HTTPS readiness не готова; перевірте npm run deploy:status.');
      // Окремий ключ лише для безкоштовного Pinggy; особисті ключі та SSH agent не використовуються.
      const keyPath = join(directory, 'id_ed25519');
      try { await access(keyPath); } catch {
        await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { timeout: 10_000, maxBuffer: 16_384 });
      }
      await chmod(keyPath, 0o600);
      const sessionId = randomUUID();
      await writeFile(join(directory, 'sessions', sessionId + '.config.json'), JSON.stringify({ httpsPort: cluster.httpsPort }), { mode: 0o600 });
      const log = openSync(join(directory, 'worker.log'), 'w', 0o600);
      try { child = spawn(process.execPath, [script, 'worker', sessionId], { cwd: root, detached: true, stdio: ['ignore', log, log] }); }
      finally { closeSync(log); }
      await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
      child.unref();
      const current = await identity(child.pid);
      if (!current?.started) throw new PublicDemoError('SSH worker завершився до запуску; перевірте .local/ssh-demo/worker.log.');
      active = { sessionId, pid: child.pid, started: current.started, binary: process.execPath, script,
        url: null, phase: 'starting', configured: false };
      startedHere = true; await save(active);
    }
    const deadline = Date.now() + 30_000;
    let current;
    while (Date.now() < deadline) {
      if (!await running(active)) throw new PublicDemoError('SSH-тунель завершився до отримання адреси; перевірте .local/ssh-demo/tunnel.log.');
      current = await announcement(active);
      if (current?.url) break;
      await delay(200);
    }
    if (!current?.url) throw new PublicDemoError('Pinggy не надав підтверджену адресу за 30 секунд.');
    if (active.url !== current.url) { active.url = current.url; active.configured = false; }
    active.expiresAt = current.expiresAt;
    console.log('Pinggy призначив адресу; перевіряю публічну readiness перед узгодженням точного Origin.');
    console.log(JSON.stringify(await configureSshDemo(active, { isRunning: () => running(active), announcement: () => announcement(active), deploy, save }), null, 2));
  } catch (error) {
    if (startedHere) await stop(active).catch(() => undefined);
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (active) await save({ ...active, phase: 'failed' }).catch(() => undefined);
    console.error(error?.code === 'EEXIST' ? 'Інша операція SSH demo ще виконується.' : error instanceof PublicDemoError || error instanceof assert.AssertionError
      ? error.message.split('\n')[0] : 'Не вдалося налаштувати SSH demo; перевірте .local/ssh-demo/worker.log та tunnel.log.');
    process.exitCode = 1;
  } finally { if (locked) await rm(lockPath, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv[2]);
