import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  Protocol,
  launchChrome,
  stopChrome,
  verifiedLeaf,
} from "./check-deployment-browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Observes the parent's real load run. It never scales workloads or submits
 * load; finish creates exactly one small UI job after the real downscale. */
export async function startAutoscaleBrowser({
  deployment,
  credentials,
  deadlineEpochMs,
}) {
  const startedAt = performance.now();
  const startedEpochMs = Date.now();
  if (deadlineEpochMs !== undefined)
    assert.ok(
      Number.isSafeInteger(deadlineEpochMs),
      "Use an absolute work deadline in milliseconds.",
    );
  const workDeadlineEpochMs = Math.min(
    deadlineEpochMs ?? startedEpochMs + 720_000,
    startedEpochMs + 720_000,
  );
  assert.ok(
    workDeadlineEpochMs > startedEpochMs,
    "The autoscaling browser work deadline has already expired.",
  );
  assert.match(deployment.namespace, /^courier-route-test-[a-z0-9-]+$/u);
  assert.match(deployment.ownerId, uuid);
  assert.equal(new URL(deployment.httpsOrigin).protocol, "https:");
  assert.equal(new URL(deployment.httpsOrigin).hostname, "localhost");
  const output = join(
    root,
    ".local/autoscale-tests",
    deployment.ownerId,
    "browser",
  );
  const origin = deployment.httpsOrigin;
  const workController = new AbortController();
  const requests = new Map();
  const trace = [];
  const screenshots = [];
  const observations = [];
  let consoleErrors = 0;
  let failedStaticResources = 0;
  let mixedContentRequests = 0;
  let browser;
  let profile;
  let profileCreation;
  let cdp;
  let openingSocket;
  let sessionId;
  let userId;
  let phase = "start";
  let closed = false;
  let finished = false;
  let expired = false;
  let cleanupPromise;
  let workTimer;

  function expire() {
    if (expired || closed) return;
    expired = true;
    workController.abort(
      new Error("Autoscaling browser work deadline expired."),
    );
    // Stop the isolated process itself; closing CDP alone would leave page
    // polling and an in-flight browser fetch alive beyond the work budget.
    browser?.child.kill("SIGKILL");
    void cleanup().catch(() => {});
  }
  function ensureWork() {
    if (Date.now() >= workDeadlineEpochMs) expire();
    if (expired) throw new Error("Autoscaling browser work deadline expired.");
    if (closed) throw new Error("Autoscaling browser has been closed.");
  }
  function remainingMs(cap) {
    ensureWork();
    return Math.max(1, Math.min(cap, workDeadlineEpochMs - Date.now()));
  }
  const command = (method, params = {}) => {
    ensureWork();
    return cdp.send(method, params, sessionId);
  };
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error("Autoscaling browser evaluation failed.");
    return result.result.value;
  }
  async function until(probe, label, timeoutMs = 10_000) {
    const end = Date.now() + remainingMs(timeoutMs);
    while (Date.now() < end) {
      ensureWork();
      if (await probe()) {
        ensureWork();
        return;
      }
      await delay(Math.min(25, remainingMs(25)), undefined, {
        signal: workController.signal,
      });
    }
    ensureWork();
    throw new Error(`Autoscaling browser deadline: ${label}`);
  }
  const waitFor = (expression, label, timeoutMs) =>
    until(() => evaluate(expression), label, timeoutMs);
  const text = (selector) =>
    evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
    );
  const createCount = () =>
    trace.filter((item) => item.method === "POST" && item.path === "/api/jobs")
      .length;
  const loginCount = () =>
    trace.filter(
      (item) => item.method === "POST" && item.path === "/api/auth/login",
    ).length;
  async function click(selector) {
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`,
      "enabled control",
    );
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).click()`,
    );
  }
  async function fill(values) {
    await evaluate(`(() => {for(const [selector,value] of Object.entries(${JSON.stringify(values)})) {
      const field=document.querySelector(selector); field.value=value; field.dispatchEvent(new Event('input',{bubbles:true}));
    }})()`);
  }
  async function screenshot(name, selector) {
    if (selector)
      await evaluate(
        `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
      );
    const captured = await command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const path = join(output, name);
    ensureWork();
    await writeFile(path, Buffer.from(captured.data, "base64"), {
      mode: 0o600,
      signal: workController.signal,
    });
    ensureWork();
    screenshots.push(path);
  }
  async function choose(id) {
    assert.match(id, uuid);
    await click("#jobs-refresh");
    const label = JSON.stringify(`Маршрут · ${id.slice(0, 8)}`);
    await waitFor(
      `Array.from(document.querySelectorAll('#active-jobs button,#history-jobs button')).some(button=>button.querySelector('.job-item-reference')?.textContent===${label})`,
      "saved job listed",
    );
    await evaluate(
      `Array.from(document.querySelectorAll('#active-jobs button,#history-jobs button')).find(button=>button.querySelector('.job-item-reference')?.textContent===${label}).click()`,
    );
    await waitFor(
      `document.querySelector('#job-reference')?.textContent===${JSON.stringify(id)} && !document.querySelector('#job-detail-content').hidden`,
      "saved job selected",
    );
  }
  async function readJob(id) {
    assert.match(id, uuid);
    const job = await evaluate(`(async()=>{
      const response=await fetch('/api/jobs/'+${JSON.stringify(id)},{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(${remainingMs(10_000)})});
      if(!response.ok)throw new Error('Own job unavailable'); const value=await response.json();
      return {id:value.id,status:value.status,handler:response.headers.get('x-instance-id'),executedBy:value.executedBy,
        completed:value.progress.completedIterations,total:value.progress.totalIterations,queue:value.queue??null,
        pointCount:value.input.points.length,resultLength:value.result?.length,seed:value.input.seed};
    })()`);
    assert.match(job.handler, uuid);
    return job;
  }
  async function collectSessionHandlers(expectedIds) {
    assert.ok(
      Array.isArray(expectedIds) && [2, 4].includes(expectedIds.length),
    );
    assert.equal(new Set(expectedIds).size, expectedIds.length);
    for (const id of expectedIds) assert.match(id, uuid);
    const seen = new Set();
    let reads = 0;
    await until(async () => {
      assert.ok(
        ++reads <= 40,
        "Bounded session reads must reach every expected backend.",
      );
      const session = await evaluate(`(async()=>{
        const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(${remainingMs(10_000)})});
        const value=await response.json();return {status:response.status,userId:value.user?.id,handler:response.headers.get('x-instance-id')};
      })()`);
      assert.equal(session.status, 200);
      assert.equal(session.userId, userId);
      assert.match(session.handler, uuid);
      assert.ok(
        expectedIds.includes(session.handler),
        "Only current ready backends may serve the stable phase.",
      );
      seen.add(session.handler);
      return expectedIds.every((id) => seen.has(id));
    }, "one session served by every ready backend");
    return [...seen];
  }
  async function assertHealthyPage() {
    assert.equal(await evaluate("location.protocol"), "https:");
    assert.equal(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      true,
    );
    assert.equal(
      await evaluate(`document.querySelector('#jobs-workspace').hidden`),
      false,
    );
    assert.equal(
      loginCount(),
      1,
      "The browser must retain its original session through the entire scale cycle.",
    );
    assert.equal(consoleErrors, 0);
    assert.equal(failedStaticResources, 0);
    assert.equal(mixedContentRequests, 0);
  }
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    closed = true;
    clearTimeout(workTimer);
    if (!workController.signal.aborted)
      workController.abort(new Error("Autoscaling browser closed."));
    cleanupPromise = (async () => {
      try {
        openingSocket?.close();
        cdp?.close();
      } finally {
        try {
          await stopChrome(browser);
        } finally {
          const finalProfile =
            profile ?? (await profileCreation?.catch(() => undefined));
          if (finalProfile)
            await rm(finalProfile, { recursive: true, force: true });
        }
      }
    })();
    return cleanupPromise;
  }
  async function failed(error) {
    await writeFile(
      join(output, "failure-summary.json"),
      JSON.stringify(
        {
          status: "failed",
          phase,
          location: String(error?.stack ?? "")
            .split("\n")
            .find((line) => /check-autoscale-browser\.mjs:\d+/u.test(line))
            ?.trim(),
          deadlineExpired: expired,
          observations,
          consoleErrors,
          failedStaticResources,
          mixedContentRequests,
          trace: trace.slice(-40),
          screenshots,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    ).catch(() => {});
    await cleanup();
    throw new Error(`Autoscaling browser check failed during ${phase}.`);
  }

  workTimer = setTimeout(expire, Math.max(1, workDeadlineEpochMs - Date.now()));
  try {
    ensureWork();
    await deployment.assertOwned();
    ensureWork();
    await mkdir(output, { recursive: true, mode: 0o700 });
    ensureWork();
    await chmod(output, 0o700);
    ensureWork();
    const ca = await readFile(deployment.caPath, {
      signal: workController.signal,
    });
    ensureWork();
    const tls = await verifiedLeaf(origin, ca, {
      signal: workController.signal,
    });
    ensureWork();
    profileCreation = mkdtemp(join(output, "profile-"));
    profile = await profileCreation;
    ensureWork();
    const environment = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "SystemRoot"]
        .filter((key) => typeof process.env[key] === "string")
        .map((key) => [key, process.env[key]]),
    );
    browser = launchChrome(
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        `--ignore-certificate-errors-spki-list=${tls.spki}`,
        "about:blank",
      ],
      environment,
    );
    let debugging;
    await until(async () => {
      try {
        debugging = (
          await readFile(join(profile, "DevToolsActivePort"), "utf8")
        )
          .trim()
          .split("\n");
        return debugging.length === 2;
      } catch {
        return false;
      }
    }, "isolated Chrome startup");
    ensureWork();
    const socket = new WebSocket(
      `ws://127.0.0.1:${debugging[0]}${debugging[1]}`,
    );
    openingSocket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        workController.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => {
        socket.close();
        done(new Error("Browser connection work deadline."));
      };
      const timer = setTimeout(() => {
        socket.close();
        done(new Error("Browser connection deadline."));
      }, remainingMs(10_000));
      workController.signal.addEventListener("abort", aborted, { once: true });
      socket.addEventListener("open", () => done(), { once: true });
      socket.addEventListener(
        "error",
        () => done(new Error("Browser connection failed.")),
        { once: true },
      );
    });
    ensureWork();
    cdp = new Protocol(socket);
    openingSocket = undefined;
    const { targetId } = await command("Target.createTarget", {
      url: "about:blank",
    });
    ({ sessionId } = await command("Target.attachToTarget", {
      targetId,
      flatten: true,
    }));
    cdp.listeners.add((event) => {
      if (event.sessionId !== sessionId) return;
      if (
        event.method === "Runtime.exceptionThrown" ||
        (event.method === "Runtime.consoleAPICalled" &&
          event.params.type === "error")
      )
        consoleErrors++;
      if (event.method === "Network.requestWillBeSent") {
        let url;
        try {
          url = new URL(event.params.request.url);
        } catch {
          return;
        }
        if (url.protocol === "http:") mixedContentRequests++;
        if (url.origin !== origin) return;
        if (requests.size >= 5000)
          requests.delete(requests.keys().next().value);
        requests.set(event.params.requestId, {
          method: event.params.request.method,
          path: url.pathname,
          type: event.params.type,
        });
      }
      if (event.method === "Network.responseReceived") {
        const found = requests.get(event.params.requestId);
        if (found?.path.startsWith("/api/")) {
          if (trace.length >= 5000) trace.shift();
          trace.push({
            phase,
            method: found.method,
            path: found.path,
            status: event.params.response.status,
            handler:
              event.params.response.headers["X-Instance-Id"] ??
              event.params.response.headers["x-instance-id"],
          });
        }
        if (
          ["Script", "Stylesheet"].includes(event.params.type) &&
          event.params.response.status >= 400
        )
          failedStaticResources++;
      }
      if (
        event.method === "Network.loadingFailed" &&
        ["Script", "Stylesheet"].includes(
          requests.get(event.params.requestId)?.type,
        )
      )
        failedStaticResources++;
    });
    await Promise.all([
      command("Page.enable"),
      command("Runtime.enable"),
      command("Network.enable"),
    ]);
    await command("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await command("Page.navigate", { url: origin });
    await waitFor(
      `document.querySelector('#auth-fields') && !document.querySelector('#auth-fields').disabled`,
      "login form",
    );
    await fill({
      "#username": credentials.username,
      "#password": credentials.password,
    });
    await click("#auth-submit");
    await waitFor(
      `!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled`,
      "login and limits",
    );
    const session = await evaluate(
      `(async()=>{const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(${remainingMs(10_000)})});const value=await response.json();return{status:response.status,userId:value.user?.id};})()`,
    );
    assert.equal(session.status, 200);
    assert.match(session.userId, uuid);
    userId = session.userId;
    await assertHealthyPage();
    observations.push({
      phase: "login",
      status: "pass",
      protocol: tls.protocol,
    });
  } catch (error) {
    try {
      await failed(error);
    } finally {
      await cleanup();
    }
  }

  return {
    async observe({
      phase: nextPhase,
      queuedJobId,
      runningJobId,
      expectedExecutorCount,
      expectedInstanceIds,
    }) {
      try {
        assert.equal(closed, false);
        assert.equal(finished, false);
        assert.ok(nextPhase === "baseline" || nextPhase === "expanded");
        assert.equal(expectedExecutorCount, nextPhase === "baseline" ? 2 : 4);
        assert.equal(expectedInstanceIds.length, expectedExecutorCount);
        phase = nextPhase;
        await command("Emulation.setDeviceMetricsOverride", {
          width: nextPhase === "baseline" ? 1280 : 360,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await choose(queuedJobId);
        let queued;
        await until(async () => {
          queued = await readJob(queuedJobId);
          return (
            queued.status === "queued" &&
            queued.queue?.executorCount === expectedExecutorCount &&
            Number.isSafeInteger(queued.queue.estimatedWaitMs) &&
            queued.queue.estimatedWaitMs >= 0
          );
        }, "coherent real queued estimate");
        await waitFor(
          `document.querySelector('#job-detail-status').dataset.status==='queued'
          && !document.querySelector('#job-queue').hidden
          && document.querySelector('#job-queue-context').textContent.includes(${JSON.stringify(`Виконавців: ${expectedExecutorCount}.`)})`,
          "queue shown with actual executor count",
        );
        await screenshot(`${nextPhase}-queue.png`, "#job-queue");
        await choose(runningJobId);
        let running;
        await until(async () => {
          running = await readJob(runningJobId);
          return running.status === "running" && running.completed > 0;
        }, "actual persisted running progress");
        assert.ok(expectedInstanceIds.includes(running.executedBy));
        await waitFor(
          `document.querySelector('#job-detail-status').dataset.status==='running'
          && document.querySelector('#job-queue').hidden && document.querySelector('#job-result').hidden`,
          "running progress without stale ETA or result",
        );
        await screenshot(`${nextPhase}-running.png`, ".detail-panel");
        const handlers = await collectSessionHandlers(expectedInstanceIds);
        await assertHealthyPage();
        assert.equal(
          createCount(),
          0,
          "Observing the load must never create another job.",
        );
        const record = {
          phase: nextPhase,
          status: "pass",
          queuedJobId,
          runningJobId,
          handlers,
          queue: queued.queue,
          completedIterations: running.completed,
          totalIterations: running.total,
          executedBy: running.executedBy,
          viewport: nextPhase === "baseline" ? "1280x900" : "360x900",
        };
        observations.push(record);
        return record;
      } catch (error) {
        return failed(error);
      }
    },
    async finish({ resultJobId, expectedInstanceIds }) {
      try {
        assert.equal(closed, false);
        assert.equal(finished, false);
        phase = "returned-to-two";
        assert.equal(expectedInstanceIds.length, 2);
        const handlers = await collectSessionHandlers(expectedInstanceIds);
        await command("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await choose(resultJobId);
        const saved = await readJob(resultJobId);
        assert.equal(saved.status, "completed");
        assert.equal(saved.queue, null);
        await waitFor(
          `document.querySelector('#job-detail-status').dataset.status==='completed' && Boolean(document.querySelector('#route-diagram polyline'))`,
          "saved completed SVG after downscale",
        );
        assert.equal(
          await evaluate(
            `document.querySelectorAll('#route-diagram circle').length`,
          ),
          saved.pointCount,
        );
        const savedPath = await evaluate(
          `document.querySelector('#route-diagram polyline').getAttribute('points')`,
        );
        await fill({ "#delivery-points": "-12.5 7" });
        assert.equal(
          await evaluate(
            `document.querySelector('#route-diagram polyline').getAttribute('points')`,
          ),
          savedPath,
        );
        await screenshot("after-downscale-history.png", ".detail-panel");
        const beforeReload = createCount();
        await command("Page.reload", { ignoreCache: true });
        await waitFor(
          `!document.querySelector('#jobs-workspace').hidden && !document.querySelector('#route-submit').disabled`,
          "same session after reload",
        );
        await choose(resultJobId);
        await waitFor(
          `Boolean(document.querySelector('#route-diagram polyline'))`,
          "saved SVG after reload",
        );
        assert.equal(
          await evaluate(
            `document.querySelector('#route-diagram polyline').getAttribute('points')`,
          ),
          savedPath,
        );
        assert.equal(createCount(), beforeReload);
        await click("#fill-square");
        await click("#route-submit");
        await waitFor(
          `document.querySelector('#job-reference').textContent!==${JSON.stringify(resultJobId)} && document.querySelector('#job-detail-status').dataset.status==='completed'`,
          "new UI square after downscale",
        );
        const newJobId = await text("#job-reference");
        const square = await readJob(newJobId);
        assert.equal(square.status, "completed");
        assert.equal(square.resultLength, 4);
        assert.equal(square.seed, 0);
        assert.equal(await text("#job-result-length"), "4");
        assert.equal(createCount(), beforeReload + 1);
        await command("Emulation.setDeviceMetricsOverride", {
          width: 360,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await screenshot("after-downscale-square.png", ".detail-panel");
        const squarePath = await evaluate(
          `document.querySelector('#route-diagram polyline').getAttribute('points')`,
        );
        await command("Page.reload", { ignoreCache: true });
        await waitFor(
          `document.querySelector('#job-reference')?.textContent===${JSON.stringify(newJobId)} && Boolean(document.querySelector('#route-diagram polyline'))`,
          "new saved UI job after reload",
        );
        assert.equal(
          await evaluate(
            `document.querySelector('#route-diagram polyline').getAttribute('points')`,
          ),
          squarePath,
        );
        assert.equal(createCount(), beforeReload + 1);
        await evaluate(`document.querySelector('#warehouse-x').focus()`);
        await command("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        await command("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Tab",
          code: "Tab",
          windowsVirtualKeyCode: 9,
        });
        assert.equal(
          await evaluate("document.activeElement.id"),
          "warehouse-y",
        );
        assert.notEqual(
          await evaluate(
            "getComputedStyle(document.activeElement).outlineStyle",
          ),
          "none",
        );
        await screenshot("after-downscale-form.png", ".route-form-panel");
        await assertHealthyPage();
        observations.push({
          phase,
          status: "pass",
          handlers,
          resultJobId,
          newJobId,
          preservedHistory: true,
          reloadWithoutPost: true,
          oneNewCompletedSquare: true,
        });
        finished = true;
        const summary = {
          status: "pass",
          browser: "local Google Chrome headless via native CDP",
          namespace: deployment.namespace,
          origin,
          viewports: ["1280x900", "360x900"],
          observations,
          screenshots,
          loginRequests: loginCount(),
          newJobId,
          createdJobs: createCount(),
          consoleErrors,
          failedStaticResources,
          mixedContentRequests,
          elapsedMs: Math.round(performance.now() - startedAt),
          workDeadlineEpochMs,
          trace,
        };
        ensureWork();
        await writeFile(
          join(output, "summary.json"),
          JSON.stringify(summary, null, 2),
          { mode: 0o600, signal: workController.signal },
        );
        ensureWork();
        return summary;
      } catch (error) {
        return failed(error);
      }
    },
    cleanup,
  };
}
