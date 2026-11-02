import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedTunnelProcess } from './public-origins.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local/public-demo');
const statePath = join(directory, 'state.json');
const logPath = join(directory, 'tunnel.log');
const binary = join(root, '.local/tools/cloudflared');
const execute = promisify(execFile);
async function state() { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; } }
async function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const options = { timeout: 3_000, maxBuffer: 16_384 };
    const started = (await execute('ps', ['-p', String(pid), '-o', 'lstart='], options)).stdout.trim();
    const command = (await execute('ps', ['-p', String(pid), '-o', 'command='], options)).stdout.trim();
    return { started, command };
  } catch { return null; }
}
async function save(value) { await writeFile(statePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
async function stop(value) {
  if (!ownedTunnelProcess(value, await identity(value?.pid))) return false;
  process.kill(value.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!ownedTunnelProcess(value, await identity(value.pid))) return true;
    await delay(100);
  }
  throw new Error('Тунель не завершився; перевірте власний PID у .local/public-demo/state.json.');
}

await mkdir(directory, { recursive: true, mode: 0o700 });
const command = process.argv[2] ?? 'status';
let locked = false;
let startedHere;
try {
  if (command === 'status') {
    const value = await state();
    console.log(JSON.stringify({ running: ownedTunnelProcess(value, await identity(value?.pid)), url: value?.url ?? null, phase: value?.phase ?? 'stopped' }, null, 2));
  } else {
    assert.ok(['start', 'stop'].includes(command), 'Використайте demo:public, demo:public:status або demo:public:stop.');
    await writeFile(join(directory, 'operation.lock'), String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true;
    const previous = await state();
    if (command === 'stop') {
      await stop(previous);
      if (previous) await save({ ...previous, phase: 'stopped' });
      console.log('Публічний тунель зупинено. Локальний Kubernetes і дані збережено.');
    } else if (ownedTunnelProcess(previous, await identity(previous?.pid))) {
      console.log(JSON.stringify({ running: true, url: previous.url, phase: previous.phase }, null, 2));
    } else {
      assert.equal(process.versions.node.split('.')[0], '24', 'Потрібен Node.js 24 і npm 11.');
      await access(binary);
      const cluster = JSON.parse(await readFile(join(root, '.local/deploy/cluster.json'), 'utf8'));
      assert.equal(cluster.cluster, 'courier-route'); assert.equal(cluster.context, 'kind-courier-route');
      const port = cluster.httpsPort;
      assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
      const configPath = join(directory, 'quick-tunnel.yml');
      await writeFile(configPath, '{}\n', { mode: 0o600 });
      const log = openSync(logPath, 'w', 0o600);
      const args = ['--config', configPath, '--no-autoupdate', 'tunnel', '--loglevel', 'info', '--no-tls-verify=false', '--url', `https://localhost:${port}`,
        '--http-host-header', 'localhost', '--origin-server-name', 'localhost', '--origin-ca-pool', join(root, '.local/deploy/tls/ca.crt'), '--protocol', 'http2'];
      let child;
      try { child = spawn(binary, args, { cwd: root, detached: true, stdio: ['ignore', log, log],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_TLS_VERIFY: 'false', TUNNEL_LOGLEVEL: 'info' } }); }
      finally { closeSync(log); }
      await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
      child.unref();
      const processIdentity = await identity(child.pid);
      assert.ok(processIdentity?.started);
      startedHere = { pid: child.pid, binary: resolve(binary), started: processIdentity.started, url: null, phase: 'starting' };
      await save(startedHere);
      for (let attempt = 0; attempt < 150; attempt++) {
        const text = await readFile(logPath, 'utf8');
        const url = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u)?.[0];
        if (url) { startedHere.url = url; break; }
        assert.ok(ownedTunnelProcess(startedHere, await identity(child.pid)), 'Тунель завершився до видачі адреси.');
        await delay(200);
      }
      assert.ok(startedHere.url, 'Cloudflare не надав адресу протягом 30 секунд.');
      startedHere.phase = 'configuring'; await save(startedHere);
      console.log('Тунель створено; узгоджую точний Origin і штатне локальне розгортання.');
      const deployLog = openSync(join(directory, 'deployment.log'), 'w', 0o600);
      try {
        await new Promise((accept, reject) => {
          const deploy = spawn(process.execPath, ['scripts/deploy-local.mjs', 'up'], { cwd: root,
            env: { ...process.env, COURIER_ADDITIONAL_APP_ORIGINS: startedHere.url }, stdio: ['ignore', deployLog, deployLog] });
          const timer = setTimeout(() => { deploy.kill('SIGTERM'); reject(new Error('Локальне розгортання перевищило 15 хвилин.')); }, 900_000);
          deploy.once('error', () => { clearTimeout(timer); reject(new Error('Не вдалося запустити штатне розгортання.')); });
          deploy.once('exit', (code) => { clearTimeout(timer); code === 0 ? accept() : reject(new Error('Штатне розгортання не пройшло; перевірте .local/public-demo/deployment.log.')); });
        });
      } finally { closeSync(deployLog); }
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const response = await fetch(`${startedHere.url}/api/ready`, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
          assert.equal(response.status, 200); assert.equal((await response.json()).status, 'ready');
          startedHere.phase = 'ready'; break;
        } catch { await delay(1_000); }
      }
      assert.equal(startedHere.phase, 'ready', 'Публічний readiness ще не підтверджений.');
      await save(startedHere);
      console.log(JSON.stringify({ running: true, url: startedHere.url, phase: startedHere.phase }, null, 2));
    }
  }
} catch (error) {
  if (startedHere) { await stop(startedHere).catch(() => undefined); await save({ ...startedHere, phase: 'failed' }).catch(() => undefined); }
  console.error(error?.code === 'EEXIST' ? 'Інша операція публічного demo ще виконується.'
    : error?.code === 'ENOENT' ? 'Потрібні локальний deploy і .local/tools/cloudflared; інструкція — docs/github-pages.md.'
      : error instanceof assert.AssertionError ? error.message.split('\n')[0]
        : 'Не вдалося налаштувати публічне demo; перевірте приватні локальні журнали.');
  process.exitCode = 1;
} finally { if (locked) await rm(join(directory, 'operation.lock'), { force: true }); }
