// Тут запускаю зовнішні команди Docker і Kubernetes з обмеженим часом та обсягом виводу
// Не залишаю зміну ресурсів працювати непомітно після завершення очікування скрипта

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

// Через AsyncLocalStorage передаю дедлайн вкладеним асинхронним викликам без змінної глобального поточного запиту
const deadlines = new AsyncLocalStorage();

// Окремим кодом позначаю вичерпання спільного дедлайну, щоб відрізнити його від звичайної помилки команди
export class DeploymentDeadlineError extends Error {
  constructor() {
    super("The absolute deployment command deadline expired.");
    this.code = "DEPLOYMENT_DEADLINE";
  }
}

// Передаю дедлайн вкладеним helper через асинхронний контекст
// Вкладена операція може лише скоротити батьківський дедлайн, а не продовжити його
export function withDeploymentDeadline(deadlineEpochMs, work) {
  assert.ok(
    Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > 0,
    "A finite absolute command deadline is required.",
  );
  assert.equal(typeof work, "function");
  const inherited = deadlines.getStore();
  return deadlines.run(
    inherited === undefined
      ? deadlineEpochMs
      : Math.min(inherited, deadlineEpochMs),
    work,
  );
}

// Дозволяю явно виконати cleanup навіть після вичерпання бюджету перевірки
export function withoutDeploymentDeadline(work) {
  assert.equal(typeof work, "function");
  return deadlines.run(undefined, work);
}

// Зупиняю й цикли очікування, коли часу для нової команди вже немає
export function assertDeploymentDeadline() {
  const deadline = deadlines.getStore();
  if (deadline !== undefined && Date.now() >= deadline)
    throw new DeploymentDeadlineError();
}

// При таймауті зупиняю реальний дочірній процес і чекаю close замість покинути Promise
// Після завершення дедлайну нову команду не запускаю
export function runDeploymentCommand(
  command,
  args,
  {
    input,
    timeoutMs = 120_000,
    env = process.env,
    cwd,
    inherit = false,
    redact = () => "",
  } = {},
) {
  const absoluteDeadline = deadlines.getStore();
  const remaining =
    absoluteDeadline === undefined ? Infinity : absoluteDeadline - Date.now();
  if (remaining <= 0) return Promise.reject(new DeploymentDeadlineError());
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
  );
  // Для дочірньої команди беру менше з її таймауту та залишку спільного часу
  const effectiveTimeout = Math.max(1, Math.min(timeoutMs, remaining));
  const absoluteLimited = remaining <= timeoutMs;
  return new Promise((resolve, reject) => {
    // Запускаю програму з масивом аргументів без додаткового shell, stdin і вивід тримаю під контролем
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    const errors = [];
    let bytes = 0;
    let expired = false;
    let overflow = false;
    let startError;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, effectiveTimeout);
    // Обмежую сумарний stdout і stderr, щоб команда не заповнила пам’ять нескінченним журналом
    const collect = (target, chunk, stream) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      } else target.push(chunk);
      if (inherit) stream.write(chunk);
    };
    child.stdout.on("data", (chunk) => collect(output, chunk, process.stdout));
    child.stderr.on("data", (chunk) => collect(errors, chunk, process.stderr));
    child.once("error", (error) => {
      startError = error;
    });
    // Завершую Promise після фактичного закриття дочірнього процесу, прибираю таймер і перевіряю результат
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired && absoluteLimited) reject(new DeploymentDeadlineError());
      else if (startError)
        reject(new Error(`${command}: ${startError.code ?? "start failed"}`));
      else if (code !== 0 || expired || overflow)
        reject(
          new Error(
            `${command}: ${expired ? "deadline" : overflow ? "output limit" : `exit ${code}`} ${redact(Buffer.concat(errors).toString())}`,
          ),
        );
      else resolve(Buffer.concat(output).toString());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
