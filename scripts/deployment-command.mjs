import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';

const deadlines = new AsyncLocalStorage();

export class DeploymentDeadlineError extends Error {
  constructor() {
    super('The absolute deployment command deadline expired.');
    this.code = 'DEPLOYMENT_DEADLINE';
  }
}

/** Native async scope propagates through every nested helper without global
 * mutable state. Nesting can shorten a parent's deadline, never extend it. */
export function withDeploymentDeadline(deadlineEpochMs, work) {
  assert.ok(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > 0, 'A finite absolute command deadline is required.');
  assert.equal(typeof work, 'function');
  const inherited = deadlines.getStore();
  return deadlines.run(inherited === undefined ? deadlineEpochMs : Math.min(inherited, deadlineEpochMs), work);
}

/** Cleanup must remain available after the acceptance budget has expired. */
export function withoutDeploymentDeadline(work) {
  assert.equal(typeof work, 'function');
  return deadlines.run(undefined, work);
}

/** Polling loops must also stop when no further child command may start. */
export function assertDeploymentDeadline() {
  const deadline = deadlines.getStore();
  if (deadline !== undefined && Date.now() >= deadline) throw new DeploymentDeadlineError();
}

/** Do not race and abandon a mutation promise: expiry kills the actual child,
 * then settles only after its close event. No command starts after expiry. */
export function runDeploymentCommand(command, args, {
  input, timeoutMs = 120_000, env = process.env, cwd, inherit = false, redact = () => '',
} = {}) {
  const absoluteDeadline = deadlines.getStore();
  const remaining = absoluteDeadline === undefined ? Infinity : absoluteDeadline - Date.now();
  if (remaining <= 0) return Promise.reject(new DeploymentDeadlineError());
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647);
  const effectiveTimeout = Math.max(1, Math.min(timeoutMs, remaining));
  const absoluteLimited = remaining <= timeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let bytes = 0;
    let expired = false;
    let overflow = false;
    let startError;
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, effectiveTimeout);
    const collect = (target, chunk, stream) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else target.push(chunk);
      if (inherit) stream.write(chunk);
    };
    child.stdout.on('data', (chunk) => collect(output, chunk, process.stdout));
    child.stderr.on('data', (chunk) => collect(errors, chunk, process.stderr));
    child.once('error', (error) => { startError = error; });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (expired && absoluteLimited) reject(new DeploymentDeadlineError());
      else if (startError) reject(new Error(`${command}: ${startError.code ?? 'start failed'}`));
      else if (code !== 0 || expired || overflow) reject(new Error(`${command}: ${expired ? 'deadline' : overflow ? 'output limit' : `exit ${code}`} ${redact(Buffer.concat(errors).toString())}`));
      else resolve(Buffer.concat(output).toString());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
