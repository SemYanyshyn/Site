import { readFile } from "node:fs/promises";
import https from "node:https";

export function parseStatusArguments(args) {
  if (args.length === 0) return { verbose: false };
  if (args.length === 1 && args[0] === "--verbose") return { verbose: true };
  throw new Error("Використання: npm run deploy:status [-- --verbose]");
}

function readError(error) {
  const message = String(error?.message ?? "");
  if (/forbidden|\b403\b/iu.test(message)) return "немає дозволу на читання";
  if (/not.?found|\b404\b/iu.test(message)) return "джерело відсутнє";
  if (/deadline|timeout|timed out/iu.test(message))
    return "перевищено час очікування";
  if (/ENOENT/u.test(message)) return "kubectl не знайдено";
  if (error instanceof SyntaxError) return "некоректна відповідь Kubernetes";
  return "Kubernetes API недоступний або відмовив у читанні";
}

function reason(value) {
  return /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(value ?? "")
    ? value
    : "помилка контейнера";
}
function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function number(value) {
  return value.toLocaleString("uk-UA", { maximumFractionDigits: 2 });
}
function display(value) {
  return count(value) ?? "невідомо";
}
function items(source) {
  return Array.isArray(source.value?.items) ? source.value.items : [];
}

function podState(pod, containerName) {
  if (pod.metadata?.deletionTimestamp)
    return { ready: false, text: "завершується" };
  const containers = [
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.containerStatuses ?? []),
  ];
  const waiting = containers.find((container) => container.state?.waiting);
  if (waiting)
    return {
      ready: false,
      text: `не готова (${reason(waiting.state.waiting.reason)})`,
    };
  const container = containers.find((value) => value.name === containerName);
  const terminated = container?.state?.terminated;
  if (terminated)
    return { ready: false, text: `не готова (${reason(terminated.reason)})` };
  if (pod.status?.phase !== "Running")
    return {
      ready: false,
      text: `не готова (${reason(pod.status?.phase ?? "Unknown")})`,
    };
  const ready =
    container?.ready === true &&
    container.state?.running &&
    pod.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
  return {
    ready: Boolean(ready),
    text: ready ? "готова" : "не готова (NotReady)",
  };
}

function quantity(input, memory = false) {
  if (typeof input !== "string") return null;
  const match = /^(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)([A-Za-z]*)$/u.exec(input);
  if (!match) return null;
  const units = memory
    ? {
        "": 1,
        k: 1e3,
        M: 1e6,
        G: 1e9,
        T: 1e12,
        P: 1e15,
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
        Pi: 1024 ** 5,
      }
    : { "": 1, n: 1e-9, u: 1e-6, m: 1e-3 };
  const value = Number(match[1]) * units[match[2]];
  return Number.isFinite(value) &&
    value >= 0 &&
    value <= (memory ? Number.MAX_SAFE_INTEGER : 1e6)
    ? value
    : null;
}

function windowMs(input) {
  if (typeof input !== "string" || input.length > 40) return null;
  const parts = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/gu)];
  if (!parts.length || parts.map((part) => part[0]).join("") !== input)
    return null;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const value = parts.reduce(
    (sum, part) => sum + Number(part[1]) * units[part[2]],
    0,
  );
  return Number.isFinite(value) && value > 0 && value <= 3600000 ? value : null;
}

/** A bounded GET only: normal CA/hostname verification, no forwarding/setup/retry. */
export async function probeDemoReady(origin, caPath, timeoutMs = 3000) {
  let ca;
  try {
    ca = await readFile(caPath);
  } catch {
    return { ok: false, message: "не перевірено: локальна CA недоступна" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, message });
    };
    const request = https.get(
      new URL("/api/ready", origin),
      { ca, family: 4, agent: false },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4096) {
            finish(false, "некоректна відповідь readiness");
            request.destroy();
          } else chunks.push(chunk);
        });
        response.once("error", () => finish(false, "з'єднання перервано"));
        response.once("end", () => {
          if (response.statusCode !== 200)
            return finish(false, `недоступне (HTTP ${response.statusCode})`);
          const instance = response.headers["x-instance-id"];
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const valid =
              body.status === "ready" &&
              typeof instance === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
                instance,
              );
            finish(
              valid,
              valid
                ? "доступне (HTTPS readiness 200)"
                : "некоректна відповідь readiness",
            );
          } catch {
            finish(false, "некоректна відповідь readiness");
          }
        });
      },
    );
    request.once("error", (error) => {
      const tls = /CERT|TLS|VERIFY|SELF_SIGNED/u.test(error.code ?? "");
      finish(
        false,
        tls
          ? "недоступне: помилка перевірки TLS"
          : "недоступне: помилка з'єднання",
      );
    });
    timer = setTimeout(() => {
      finish(false, "недоступне: перевищено час очікування");
      request.destroy();
    }, timeoutMs);
  });
}

/** Read each source independently so a metrics/API failure cannot hide pod state. */
export async function collectDeploymentStatus({
  kubectl,
  metricsKubectl,
  origin,
  caPath,
  now = Date.now(),
  probe = probeDemoReady,
  ownerId,
}) {
  const read = async (client, args) => {
    try {
      const output = await client(args, { timeoutMs: 5000 });
      const value = output.trim() ? JSON.parse(output) : null;
      if (value !== null && (typeof value !== "object" || Array.isArray(value)))
        throw new SyntaxError();
      return { value };
    } catch (error) {
      return { error: readError(error) };
    }
  };
  const [resources, metricsWorkload, metricsService, metrics, demo] =
    await Promise.all([
      read(kubectl, ["get", "deployment,statefulset,pod,hpa", "-o", "json"]),
      read(metricsKubectl, ["get", "deployment,pod", "-o", "json"]),
      read(kubectl, [
        "get",
        "apiservice",
        "v1beta1.metrics.k8s.io",
        "--ignore-not-found",
        "-o",
        "json",
      ]),
      read(kubectl, [
        "get",
        "--raw",
        "/apis/metrics.k8s.io/v1beta1/namespaces/courier-route/pods",
      ]),
      Promise.resolve()
        .then(() => probe(origin, caPath))
        .catch(() => ({ ok: false, message: "перевірка HTTPS не вдалася" })),
    ]);
  const lines = ["Courier Route"];
  let ok = true;
  const owned = (object) =>
    !ownerId ||
    (object.metadata?.labels?.["courier-route.local/owner-id"] === ownerId &&
      object.metadata?.labels?.["app.kubernetes.io/managed-by"] ===
        "courier-route-local");
  const all = items(resources);
  const podsFor = (source, component) =>
    items(source).filter(
      (item) =>
        item.kind === "Pod" &&
        item.metadata?.labels?.["app.kubernetes.io/component"] === component &&
        owned(item),
    );
  const component = (label, source, kind, name, podComponent, container) => {
    const workload = items(source).find(
      (item) => item.kind === kind && item.metadata?.name === name,
    );
    const pods = podsFor(source, podComponent);
    if (source.error) {
      ok = false;
      lines.push(`${label}: стан невідомий — ${source.error}`);
      return pods;
    }
    if (!workload) {
      ok = false;
      lines.push(`${label}: відсутній ${kind}`);
      return pods;
    }
    if (!owned(workload)) {
      ok = false;
      lines.push(`${label}: належність проєкту не підтверджена`);
      return pods;
    }
    const desired = count(workload.spec?.replicas);
    const states = pods.map((pod) => podState(pod, container));
    const ready = states.filter((state) => state.ready).length;
    const problems = [
      ...new Set(
        states.filter((state) => !state.ready).map((state) => state.text),
      ),
    ];
    const observed = count(workload.status?.observedGeneration);
    if (
      count(workload.metadata?.generation) !== null &&
      (observed === null || observed < workload.metadata.generation)
    )
      problems.push("оновлення ще не підтверджено");
    if (desired === 0) problems.push("зупинено");
    else if (pods.length === 0) problems.push("pod відсутні");
    if (desired === null || desired === 0 || ready < desired || problems.length)
      ok = false;
    lines.push(
      `${label}: ${ready}/${display(desired)} готових${problems.length ? ` — ${problems.join("; ")}` : ""}`,
    );
    return pods;
  };
  const appPods = component(
    "Застосунок",
    resources,
    "Deployment",
    "app",
    "app",
    "app",
  );
  component(
    "Traefik",
    resources,
    "Deployment",
    "traefik",
    "ingress",
    "traefik",
  );
  component(
    "PostgreSQL",
    resources,
    "StatefulSet",
    "postgres",
    "database",
    "postgres",
  );

  const hpa = all.find(
    (item) =>
      item.kind === "HorizontalPodAutoscaler" && item.metadata?.name === "app",
  );
  if (resources.error || !hpa || !owned(hpa)) {
    ok = false;
    lines.push(
      `HPA: ${resources.error ? `стан невідомий — ${resources.error}` : !hpa ? "відсутній" : "належність проєкту не підтверджена"}`,
    );
  } else {
    const target = hpa.spec?.metrics?.find(
      (metric) => (metric.resource ?? metric.containerResource)?.name === "cpu",
    );
    const current = hpa.status?.currentMetrics?.find(
      (metric) => (metric.resource ?? metric.containerResource)?.name === "cpu",
    );
    const inactive = hpa.status?.conditions?.find(
      (condition) =>
        ["ScalingActive", "AbleToScale"].includes(condition.type) &&
        condition.status !== "True",
    );
    const cpu = (current?.resource ?? current?.containerResource)?.current
      ?.averageUtilization;
    const targetCpu = (target?.resource ?? target?.containerResource)?.target
      ?.averageUtilization;
    const currentText =
      !inactive && count(cpu) !== null ? `${cpu}%` : "невідомо";
    const bounds = [
      hpa.status?.currentReplicas,
      hpa.spec?.minReplicas,
      hpa.spec?.maxReplicas,
    ];
    if (
      currentText === "невідомо" ||
      count(targetCpu) === null ||
      bounds.some((value) => count(value) === null)
    )
      ok = false;
    lines.push(
      `HPA: поточні копії ${display(bounds[0])}; мін/макс ${display(bounds[1])}/${display(bounds[2])}; CPU ${currentText}, ціль ${count(targetCpu) === null ? "невідомо" : `${targetCpu}%`}${inactive ? ` — ${reason(inactive.reason)}` : ""}`,
    );
  }

  const apiAvailable = metricsService.value?.status?.conditions?.some(
    (condition) =>
      condition.type === "Available" && condition.status === "True",
  );
  const metricsDeployment = items(metricsWorkload).find(
    (item) =>
      item.kind === "Deployment" && item.metadata?.name === "metrics-server",
  );
  const metricsPods = podsFor(metricsWorkload, "metrics");
  const metricsReady = metricsPods.filter(
    (pod) => podState(pod, "metrics-server").ready,
  ).length;
  const desiredMetrics = count(metricsDeployment?.spec?.replicas);
  const metricsProblems = [];
  if (metricsWorkload.error) metricsProblems.push(metricsWorkload.error);
  else if (!metricsDeployment) metricsProblems.push("Deployment відсутній");
  else if (!owned(metricsDeployment))
    metricsProblems.push("належність проєкту не підтверджена");
  else if (
    desiredMetrics === null ||
    desiredMetrics === 0 ||
    metricsReady < desiredMetrics
  )
    metricsProblems.push(`${metricsReady}/${display(desiredMetrics)} готових`);
  for (const state of metricsPods.map((pod) =>
    podState(pod, "metrics-server"),
  )) {
    if (!state.ready && !metricsProblems.includes(state.text))
      metricsProblems.push(state.text);
  }
  if (
    count(metricsDeployment?.metadata?.generation) !== null &&
    (count(metricsDeployment?.status?.observedGeneration) === null ||
      metricsDeployment.status.observedGeneration <
        metricsDeployment.metadata.generation)
  ) {
    metricsProblems.push("оновлення ще не підтверджено");
  }
  if (metricsService.error) metricsProblems.push(metricsService.error);
  else if (!metricsService.value) metricsProblems.push("APIService відсутній");
  else if (!apiAvailable) metricsProblems.push("Metrics API недоступний");
  if (metrics.error) metricsProblems.push(metrics.error);
  if (metricsProblems.length) ok = false;
  lines.push(
    `Metrics Server: ${metricsProblems.length ? metricsProblems.join("; ") : "доступний (Metrics API Available)"}`,
  );

  lines.push("Копії застосунку (CPU / RAM контейнера app):");
  if (!appPods.length)
    lines.push(resources.error ? "  стан невідомий" : "  pod відсутні");
  for (const pod of appPods.sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name),
  )) {
    const state = podState(pod, "app");
    const metric = items(metrics).find(
      (item) =>
        item.metadata?.name === pod.metadata.name &&
        item.metadata?.namespace === pod.metadata.namespace,
    );
    const usage = metric?.containers?.find(
      (container) => container.name === "app",
    )?.usage;
    const timestamp = Date.parse(metric?.timestamp);
    const window = windowMs(metric?.window);
    const started = Date.parse(
      pod.status?.containerStatuses?.find(
        (container) => container.name === "app",
      )?.state?.running?.startedAt ?? pod.metadata?.creationTimestamp,
    );
    const age = now - timestamp;
    let issue = metrics.error;
    if (!issue && !metric) issue = "зразок відсутній";
    if (
      !issue &&
      (!Number.isFinite(timestamp) ||
        !Number.isFinite(started) ||
        window === null ||
        timestamp - window < started ||
        age > 45000 ||
        age < -5000)
    )
      issue = "застарілий або непридатний зразок";
    const cpu = quantity(usage?.cpu);
    const memory = quantity(usage?.memory, true);
    if (!issue && (cpu === null || memory === null))
      issue = "некоректні CPU/RAM";
    if (
      !issue &&
      !pod.status?.containerStatuses?.find(
        (container) => container.name === "app",
      )?.state?.running
    )
      issue = "контейнер не працює";
    if (issue) ok = false;
    const values = issue
      ? `CPU/RAM недоступні — ${issue}`
      : `CPU ${number(cpu * 1000)} mCPU; RAM ${number(memory / 1024 ** 2)} MiB`;
    lines.push(`  ${pod.metadata.name}: ${state.text}; ${values}`);
  }
  if (!demo.ok) ok = false;
  lines.push(`Демо: ${origin}/ — ${demo.message}`);
  return { text: lines.join("\n"), ok };
}
