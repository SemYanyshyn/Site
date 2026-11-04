import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startHttpsBridge, sshArguments, parsePinggyAnnouncement } from './ssh-demo-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function worker(sessionId) {
  if (!/^[0-9a-f-]{36}$/u.test(sessionId ?? '')) throw new Error('Invalid session');
  const directory = join(root, '.local/ssh-demo');
  const base = join(directory, 'sessions', sessionId);
  const config = JSON.parse(await readFile(base + '.config.json', 'utf8'));
  const bridge = await startHttpsBridge({ port: config.httpsPort, ca: await readFile(join(root, '.local/deploy/tls/ca.crt')) });
  const raw = createWriteStream(join(directory, 'tunnel.log'), { flags: 'w', mode: 0o600 });
  const meta = { sessionId, pid: process.pid, adapterPort: bridge.port, url: null, phase: 'connecting' };
  let writes = Promise.resolve();
  const save = () => {
    const value = JSON.stringify(meta, null, 2) + '\n';
    writes = writes.then(async () => {
      await writeFile(base + '.status.tmp', value, { mode: 0o600 });
      await rename(base + '.status.tmp', base + '.status.json');
    });
    return writes;
  };
  const ssh = spawn('/usr/bin/ssh', sshArguments(bridge.port, join(directory, 'known_hosts'), join(directory, 'id_ed25519')), {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
  });
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    if (ssh.exitCode === null && ssh.signalCode === null) {
      ssh.kill('SIGTERM');
      await Promise.race([once(ssh, 'close').catch(() => undefined), delay(3_000)]);
      if (ssh.exitCode === null && ssh.signalCode === null) ssh.kill('SIGKILL');
    }
    await bridge.close();
    meta.phase = code === 0 ? 'stopped' : 'failed';
    await save().catch(() => undefined);
    raw.end();
    process.exit(code);
  };
  let buffer = '';
  ssh.stdout.on('data', chunk => {
    raw.write(chunk);
    if (meta.url) return;
    buffer += chunk.toString('utf8');
    if (buffer.length > 131_072) { void shutdown(1); return; }
    const url = parsePinggyAnnouncement(buffer);
    if (url) {
      meta.url = url;
      meta.proof = { source: 'ssh://free.pinggy.io:443', text: buffer };
      meta.expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      meta.phase = 'forwarding';
      void save().catch(() => shutdown(1));
    }
  });
  ssh.stderr.on('data', chunk => raw.write(chunk));
  ssh.once('error', () => { void shutdown(1); });
  ssh.once('close', () => { void shutdown(stopping ? 0 : 1); });
  process.once('SIGTERM', () => { void shutdown(0); });
  process.once('SIGINT', () => { void shutdown(0); });
  await save();
}

if (process.argv[2] === 'worker' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await worker(process.argv[3]).catch(() => { console.error('Не вдалося запустити SSH worker; перевірте локальну readiness та приватні журнали.'); process.exitCode = 1; });
}
