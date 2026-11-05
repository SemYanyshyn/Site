import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedTunnelProcess } from './public-origins.mjs';
import { PublicDemoError, quickTunnelOrigin, quickTunnelFailure, waitForQuickTunnelUrl,
  probeReadiness, publicDemoStatus, configurePublicDemo } from './public-demo-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, '.local/public-demo');
const statePath = join(directory, 'state.json');
const logPath = join(directory, 'tunnel.log');
const binary = join(root, '.local/tools/cloudflared');
const execute = promisify(execFile);
async function state() {
  try {
    const value = JSON.parse(await readFile(statePath, 'utf8'));
    return { ...value, url: quickTunnelOrigin(value.url) };
  } catch { return null; }
}
async function readLog() { return readFile(logPath, 'utf8').catch(() => ''); }
async function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    const options = { timeout: 3_000, maxBuffer: 16_384 };
    const [started, command] = await Promise.all([
      execute('ps', ['-p', String(pid), '-o', 'lstart='], options),
      execute('ps', ['-p', String(pid), '-o', 'command='], options),
    ]);
    return { started: started.stdout.trim(), command: command.stdout.trim() };
  } catch { return null; }
}
async function save(value) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...value, url: quickTunnelOrigin(value.url) }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, statePath);
}
async function isRunning(value) { return ownedTunnelProcess(value, await identity(value?.pid)); }
async function stop(value) {
  if (!await isRunning(value)) return false;
  try { process.kill(value.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!await isRunning(value)) return true;
    await delay(100);
  }
  throw new PublicDemoError('Тунель не завершився; перевірте власний PID у .local/public-demo/state.json.');
}
async function deploy(origin) {
  const log = openSync(join(directory, 'deployment.log'), 'w', 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ['scripts/deploy-local.mjs', 'up'], { cwd: root,
        env: { ...process.env, COURIER_ADDITIONAL_APP_ORIGINS: origin }, stdio: ['ignore', log, log] });
      const timer = setTimeout(() => {
        child.kill('SIGTERM'); reject(new PublicDemoError('Локальне розгортання перевищило 15 хвилин.'));
      }, 900_000);
      child.once('error', () => { clearTimeout(timer); reject(new PublicDemoError('Не вдалося запустити штатне розгортання.')); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? accept() : reject(new PublicDemoError('Штатне розгортання не пройшло; перевірте .local/public-demo/deployment.log.'));
      });
    });
  } finally { closeSync(log); }
}

export async function main(command = 'status') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let locked = false;
  let startedHere;
  let active;
  let child;
  try {
    if (command === 'status') {
      const value = await state();
      console.log(JSON.stringify(await publicDemoStatus(value, { isRunning: () => isRunning(value), readLog }), null, 2));
      return;
    }
    assert.ok(['start', 'stop'].includes(command), 'Використайте demo:public, demo:public:status або demo:public:stop.');
    await writeFile(join(directory, 'operation.lock'), String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true;
    const previous = await state();
    if (command === 'stop') {
      await stop(previous);
      if (previous) await save({ ...previous, phase: 'stopped', readiness: { ready: false, reason: 'stopped', checkedAt: null } });
      console.log('Публічний тунель зупинено. Локальний Kubernetes і дані збережено.');
      return;
    }
    if (await isRunning(previous)) {
      // Старий ready сам по собі нічого не доводить: configurePublicDemo робить новий HTTPS-запит.
      active = { ...previous, configured: previous.configured === true || previous.phase === 'ready' };
    } else {
      assert.equal(process.versions.node.split('.')[0], '24', 'Потрібен Node.js 24 і npm 11.');
      await access(binary);
      const cluster = JSON.parse(await readFile(join(root, '.local/deploy/cluster.json'), 'utf8'));
      assert.equal(cluster.cluster, 'courier-route'); assert.equal(cluster.context, 'kind-courier-route');
      const port = cluster.httpsPort;
      assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
      const caPath = join(root, '.local/deploy/tls/ca.crt');
      const local = await probeReadiness(`https://localhost:${port}`, { ca: await readFile(caPath) });
      if (!local.ready) throw new PublicDemoError('Локальна HTTPS /api/ready не готова; спочатку перевірте npm run deploy:status.');
      const configPath = join(directory, 'quick-tunnel.yml');
      await writeFile(configPath, '{}\n', { mode: 0o600 });
      const log = openSync(logPath, 'w', 0o600);
      const args = ['--config', configPath, '--no-autoupdate', 'tunnel', '--loglevel', 'info', '--no-tls-verify=false', '--url', `https://localhost:${port}`,
        '--http-host-header', 'localhost', '--origin-server-name', 'localhost', '--origin-ca-pool', caPath, '--protocol', 'http2'];
      try {
        child = spawn(binary, args, { cwd: root, detached: true, stdio: ['ignore', log, log],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NO_TLS_VERIFY: 'false', TUNNEL_LOGLEVEL: 'info' } });
      } finally { closeSync(log); }
      await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
      child.unref();
      const processIdentity = await identity(child.pid);
      if (!processIdentity?.started) throw quickTunnelFailure(await readLog())
        ?? new PublicDemoError('cloudflared завершився до отримання адреси Quick Tunnel.');
      active = startedHere = { pid: child.pid, binary: resolve(binary), started: processIdentity.started,
        url: null, phase: 'starting', configured: false };
      await save(active);
      active.url = await waitForQuickTunnelUrl({ readLog, isRunning: () => child.exitCode === null && child.signalCode === null });
    }
    console.log('Адресу створеного тунелю отримано; перевіряю публічну readiness перед зміною Origin.');
    const result = await configurePublicDemo(active, { readLog, isRunning: () => isRunning(active), deploy, save });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (startedHere) await stop(startedHere).catch(() => undefined);
    else if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (active) await save({ ...active, phase: startedHere ? 'failed' : 'unavailable',
      readiness: { ready: false, reason: 'start_failed', checkedAt: new Date().toISOString() } }).catch(() => undefined);
    console.error(error?.code === 'EEXIST' ? 'Інша операція публічного demo ще виконується.'
      : error?.code === 'ENOENT' ? 'Потрібні локальний deploy і .local/tools/cloudflared; інструкція — docs/github-pages.md.'
        : error instanceof PublicDemoError ? error.message
          : error instanceof assert.AssertionError ? error.message.split('\n')[0]
            : 'Не вдалося налаштувати публічне demo; перевірте приватні локальні журнали.');
    process.exitCode = 1;
  } finally { if (locked) await rm(join(directory, 'operation.lock'), { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv[2]);
