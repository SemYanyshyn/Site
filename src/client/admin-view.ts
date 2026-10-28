import type {
  AdminExecutor,
  AdminJob,
  AdminMetric,
  AdminOverview,
  AdminServer,
  AdminSource,
  AdminSourceStatus,
} from "../shared/admin.js";
import type { JobFailureReason, JobStatus } from "../shared/jobs.js";
import type { AdminState } from "./admin-controller.js";

interface Actions {
  open(): void;
  close(): void;
  refresh(): void;
  status(value: JobStatus | "active" | undefined): void;
  page(offset: number): void;
}
const stateLabels: Record<JobStatus, string> = {
  queued: "У черзі",
  running: "Обчислюється",
  completed: "Завершено",
  cancelled: "Скасовано",
  failed: "Помилка",
};
const sourceLabels: Record<AdminSourceStatus, string> = {
  ok: "Доступне",
  partial: "Неповні дані",
  stale: "Застарілі дані",
  unavailable: "Недоступне",
  disabled: "Не налаштоване",
};
const failures: Record<JobFailureReason, string> = {
  timeout: "Час виконання вичерпано",
  worker_error: "Помилка обчислення",
  server_shutdown: "Зупинка сервера",
  database_unavailable: "Втрачено зв’язок із БД",
  invalid_input: "Некоректний вхід",
  worker_lost: "Втрачено виконавця",
};
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function date(value: string | null): string {
  return value
    ? new Date(value).toLocaleString("uk-UA", {
        dateStyle: "short",
        timeStyle: "medium",
      })
    : "Невідомо";
}
function count(value: number | null): string {
  return value === null ? "Невідомо" : String(value);
}
function cpu(value: number | null): string {
  return value === null
    ? "Невідомо"
    : `${(value * 1_000).toLocaleString("uk-UA", { maximumFractionDigits: 2 })} мCPU`;
}
function memory(value: number | null): string {
  return value === null
    ? "Невідомо"
    : `${(value / 1_048_576).toLocaleString("uk-UA", { maximumFractionDigits: 2 })} MiB`;
}
function pair(
  list: HTMLDListElement,
  label: string,
  value: string,
  identifier = false,
): void {
  const row = element("div");
  row.append(
    element("dt", label),
    element("dd", value, identifier ? "admin-identifier" : undefined),
  );
  list.append(row);
}
function sourceCard(label: string, source: AdminSource): HTMLElement {
  const node = element("div", undefined, "admin-source");
  node.dataset.state = source.status;
  node.append(
    element("strong", `${label}: ${sourceLabels[source.status]}`),
    element(
      "p",
      `Спостереження: ${date(source.observedAt)}. Вік кешу: ${source.cacheAgeMs === null ? "невідомо" : `${Math.round(source.cacheAgeMs)} мс`}.`,
    ),
  );
  if (source.message) node.append(element("p", source.message));
  return node;
}
function slot(executor: AdminExecutor | null): string {
  if (!executor) return "Виконавця ще не зареєстровано";
  if (!executor.fresh) return "Недоступний: lease прострочено";
  if (!executor.acceptingClaims)
    return executor.busy
      ? "Зайнятий; нові задачі не приймає"
      : "Нові задачі не приймає";
  return executor.busy
    ? "Зайнятий: обчислення або фіналізація"
    : "Вільний слот";
}
function metricRows(
  list: HTMLDListElement,
  metric: AdminMetric | null,
  request: number | null,
): void {
  pair(list, "CPU контейнера app", cpu(metric?.cpuCores ?? null));
  pair(
    list,
    "RAM контейнера app (working set)",
    memory(metric?.memoryBytes ?? null),
  );
  pair(
    list,
    "CPU від request",
    metric && request !== null && request > 0
      ? `${((metric.cpuCores / request) * 100).toLocaleString("uk-UA", { maximumFractionDigits: 1 })}%`
      : "Невідомо",
  );
}
function serverCard(server: AdminServer): HTMLElement {
  const node = element("article", undefined, "admin-server-card");
  node.dataset.podUid = server.uid;
  node.dataset.instanceId = server.executor?.instanceId ?? "";
  const heading = element("div", undefined, "admin-card-heading");
  const status = element(
    "span",
    server.terminating ? "Завершується" : server.ready ? "Ready" : "Не Ready",
    "status-badge",
  );
  status.dataset.state = server.terminating
    ? "terminating"
    : server.ready
      ? "ready"
      : "not-ready";
  heading.append(
    element("h4", server.name, "admin-identifier"),
    status,
  );
  node.append(heading);
  const section = (title: string): HTMLDListElement => {
    const group = element("section", undefined, "admin-server-section");
    const list = element("dl", undefined, "admin-details");
    group.append(element("h5", title, "admin-server-section-title"), list);
    node.append(group);
    return list;
  };
  const identity = section("Ідентифікація");
  pair(
    identity,
    "Pod namespace / UID",
    `${server.namespace} / ${server.uid}`,
    true,
  );
  pair(
    identity,
    "Process UUID",
    server.executor?.instanceId ?? "Немає зіставлення",
    true,
  );
  const availability = section("Стан і обчислення");
  pair(
    availability,
    "Фаза / перезапуски контейнера",
    `${server.phase} / ${server.restarts}`,
  );
  pair(availability, "Обчислювальний слот", slot(server.executor));
  pair(
    availability,
    "Поточна задача / running",
    server.executor
      ? [
          ...new Set([
            ...(server.executor.currentJobId
              ? [server.executor.currentJobId]
              : []),
            ...server.executor.runningJobIds,
          ]),
        ].join(", ") || "Немає"
      : "Невідомо",
    true,
  );
  const resources = section("CPU та пам’ять");
  metricRows(resources, server.metric, server.requests.cpuCores);
  pair(
    resources,
    "Request: CPU / RAM",
    `${cpu(server.requests.cpuCores)} / ${memory(server.requests.memoryBytes)}`,
  );
  pair(
    resources,
    "Limit: CPU / RAM",
    `${cpu(server.limits.cpuCores)} / ${memory(server.limits.memoryBytes)}`,
  );
  const times = section("Часові дані");
  pair(
    times,
    "Pod створено / контейнер запущено",
    `${date(server.createdAt)} / ${date(server.containerStartedAt)}`,
  );
  pair(
    times,
    "Lease: останній heartbeat / чинний до",
    server.executor
      ? `${date(server.executor.lastSeenAt)} / ${date(server.executor.expiresAt)}`
      : "Невідомо",
  );
  const metric = server.metric;
  pair(
    times,
    "Метрика: час / вікно",
    metric
      ? `${date(metric.timestamp)} / ${metric.window}${metric.stale ? " · ЗАСТАРІЛА" : ""}`
      : "Немає придатного sample для цього процесу",
  );
  return node;
}
function jobCard(job: AdminJob): HTMLElement {
  const node = element("li", undefined, "admin-job-card");
  node.dataset.jobId = job.id;
  node.dataset.status = job.status;
  node.dataset.owner = job.owner.username;
  const heading = element("div", undefined, "admin-card-heading");
  heading.append(
    element("strong", job.owner.username, "admin-identifier"),
    element("span", stateLabels[job.status], "status-badge"),
  );
  node.append(heading);
  node.append(
    element("p", `Задача ${job.id}`, "admin-identifier admin-job-id"),
  );
  const progress = element("progress");
  progress.max = 100;
  progress.value = job.progress.percent;
  progress.setAttribute("aria-label", `Прогрес задачі ${job.id}`);
  node.append(progress);
  const stage =
    job.progress.stage === "preparing"
      ? "Підготовка"
      : job.progress.stage === "searching"
        ? "Пошук"
        : "Фіналізація";
  node.append(
    element(
      "p",
      `${stage} · ${job.progress.percent.toLocaleString("uk-UA", { maximumFractionDigits: 2 })}% · ${job.progress.completedIterations.toLocaleString("uk-UA")} / ${job.progress.totalIterations.toLocaleString("uk-UA")} ітерацій`,
      "progress-caption",
    ),
  );
  const list = element("dl", undefined, "admin-details");
  pair(list, "Власник UUID", job.owner.id, true);
  pair(
    list,
    "Виконавець (executedBy)",
    job.executedBy ?? "Ще не призначено",
    true,
  );
  pair(
    list,
    "Створено / оновлено",
    `${date(job.createdAt)} / ${date(job.updatedAt)}`,
  );
  pair(
    list,
    "Початок / завершення",
    `${date(job.startedAt)} / ${date(job.finishedAt)}`,
  );
  pair(
    list,
    "Скасування",
    job.cancelRequested
      ? "Запитано; слот звільняється після підтвердженої зупинки"
      : "Не запитано",
  );
  if (job.failureReason)
    pair(list, "Причина помилки", failures[job.failureReason]);
  node.append(list);
  return node;
}

/** Static controls survive every render, preserving keyboard focus and selection. */
export function createAdminView(actions: Actions): {
  render(state: AdminState): void;
  clearPrivate(): void;
  destroy(): void;
} {
  const find = <T extends Element>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Відсутній елемент: ${selector}`);
    return node;
  };
  const nav = find<HTMLElement>("#workspace-navigation"),
    routes = find<HTMLButtonElement>("#admin-close"),
    admin = find<HTMLButtonElement>("#admin-open");
  const panel = find<HTMLElement>("#admin-workspace"),
    owner = find<HTMLElement>("#jobs-workspace");
  const refresh = find<HTMLButtonElement>("#admin-refresh"),
    message = find<HTMLElement>("#admin-message"),
    summary = find<HTMLElement>("#admin-summary");
  const sources = find<HTMLElement>("#admin-source-status"),
    hpa = find<HTMLElement>("#admin-hpa"),
    servers = find<HTMLElement>("#admin-servers"),
    unmatched = find<HTMLElement>("#admin-unmatched");
  const filter = find<HTMLSelectElement>("#admin-status-filter"),
    jobs = find<HTMLOListElement>("#admin-jobs"),
    jobsMessage = find<HTMLElement>("#admin-jobs-message");
  const prev = find<HTMLButtonElement>("#admin-prev"),
    next = find<HTMLButtonElement>("#admin-next"),
    page = find<HTMLElement>("#admin-page");
  const events = new AbortController();
  let state: AdminState | null = null;
  admin.addEventListener("click", actions.open, { signal: events.signal });
  routes.addEventListener("click", actions.close, { signal: events.signal });
  refresh.addEventListener("click", actions.refresh, { signal: events.signal });
  filter.addEventListener(
    "change",
    () =>
      actions.status(
        filter.value === ""
          ? undefined
          : (filter.value as JobStatus | "active"),
      ),
    { signal: events.signal },
  );
  prev.addEventListener(
    "click",
    () => {
      if (state && prev.getAttribute("aria-disabled") !== "true")
        actions.page(state.query.offset - 20);
    },
    { signal: events.signal },
  );
  next.addEventListener(
    "click",
    () => {
      if (state && next.getAttribute("aria-disabled") !== "true")
        actions.page(state.query.offset + 20);
    },
    { signal: events.signal },
  );
  function clearPrivate(): void {
    summary.replaceChildren();
    sources.replaceChildren();
    hpa.replaceChildren();
    servers.replaceChildren();
    unmatched.replaceChildren();
    jobs.replaceChildren();
    message.textContent = "";
    jobsMessage.textContent = "";
    page.textContent = "";
    filter.value = "";
  }
  function overview(snapshot: AdminOverview): void {
    const data = snapshot.summary,
      counts = snapshot.database.counts;
    const cards: Array<[string, string]> = [
      [
        "App pod / Ready / terminating",
        `${count(data.pods)} / ${count(data.readyPods)} / ${count(data.terminatingPods)}`,
      ],
      [
        "Зіставлені процеси / зайняті",
        `${data.confirmedExecutors} / ${data.busyExecutors}`,
      ],
      [
        "Доступні виконавці черги (DB)",
        `${snapshot.database.queueExecutorCount} · зайняті ${snapshot.database.busyExecutorCount}`,
      ],
      ["Задачі: queued / running", `${counts.queued} / ${counts.running}`],
      [
        "Задачі: completed / cancelled / failed",
        `${counts.completed} / ${counts.cancelled} / ${counts.failed}`,
      ],
      [
        "Сума придатних app samples",
        `${cpu(data.cpuCores)} · ${memory(data.memoryBytes)}`,
      ],
      [
        "Покриття метрик",
        `${data.metricCoverage} / ${count(data.metricPodCount)} app pod`,
      ],
      ["PostgreSQL snapshot", date(snapshot.database.observedAt)],
    ];
    summary.replaceChildren(
      ...cards.map(([label, value]) => {
        const card = element("div", undefined, "admin-stat");
        card.append(element("dt", label), element("dd", value));
        return card;
      }),
    );
    sources.replaceChildren(
      sourceCard("Kubernetes", snapshot.infrastructure.kubernetes),
      sourceCard("Metrics API", snapshot.infrastructure.metrics),
    );
    const autoscaling = snapshot.infrastructure.hpa;
    hpa.textContent = autoscaling
      ? `HPA: min ${autoscaling.minReplicas}, max ${autoscaling.maxReplicas}; поточні ${autoscaling.currentReplicas}, бажані ${autoscaling.desiredReplicas}. ${autoscaling.conditions.map((item) => `${item.type}: ${item.status} (${item.reason})`).join("; ")}`
      : "HPA: дані недоступні. Бажана кількість не є кількістю Ready або вільних слотів.";
    servers.replaceChildren(...snapshot.servers.map(serverCard));
    if (!snapshot.servers.length)
      servers.append(
        element(
          "p",
          snapshot.infrastructure.kubernetes.status === "ok"
            ? "Поточних app pod немає."
            : "Список фізичних app pod недоступний; це не підтверджує відсутність серверів.",
          "list-message",
        ),
      );
    const reasons = {
      "outside-kubernetes": "Поза Kubernetes / немає pod metadata",
      "missing-pod": "Pod не підтверджено",
      "previous-process": "Попередній процес того самого pod",
      "metadata-mismatch": "Metadata не збігаються",
    };
    const note = element(
      "p",
      `Незіставлені записи не додають фізичних серверів. Недавнє недоступне вікно: ${snapshot.database.registryRecentWindowSeconds} с, до ${snapshot.database.registryRecentLimit} записів.${snapshot.database.registryRecentTruncated ? " Межу недавньої історії досягнуто; перелік неповний." : ""}`,
      "quiet-note",
    );
    unmatched.replaceChildren(
      note,
      ...snapshot.unmatchedExecutors.map((item) => {
        const row = element("article", undefined, "admin-unmatched-row");
        row.dataset.instanceId = item.instanceId;
        row.append(
          element("strong", reasons[item.reason]),
          element(
            "p",
            `${item.instanceId} · ${slot(item)}`,
            "admin-identifier",
          ),
          element(
            "p",
            `Heartbeat ${date(item.lastSeenAt)}; lease до ${date(item.expiresAt)}.`,
            "quiet-note",
          ),
        );
        return row;
      }),
    );
  }
  function render(value: AdminState): void {
    state = value;
    nav.hidden = !value.allowed;
    admin.hidden = !value.allowed;
    admin.setAttribute("aria-pressed", String(value.open));
    routes.setAttribute("aria-pressed", String(!value.open));
    panel.hidden = !value.allowed || !value.open;
    if (value.allowed) owner.hidden = value.open;
    panel.setAttribute(
      "aria-busy",
      String(value.overviewLoading || value.jobsLoading),
    );
    if (!value.allowed || !value.open) {
      clearPrivate();
      return;
    }
    if (filter.value !== (value.query.status ?? ""))
      filter.value = value.query.status ?? "";
    message.textContent = value.overviewError
      ? `${value.overviewError} Останній snapshot не є актуальним.`
      : !value.overview
        ? "Завантажуємо стан серверів…"
        : value.overviewLoading
          ? "Оновлюємо snapshot; показано попередні дані."
          : !value.visible
            ? "Вкладка прихована: автоматичне оновлення призупинено."
            : "Автооновлення кожні 5 с, поки панель і вкладка відкриті. Знімки джерел отримані в різний час.";
    message.dataset.state = value.overviewError ? "error" : "info";
    if (value.overview) overview(value.overview);
    jobs.replaceChildren(...(value.jobs?.jobs ?? []).map(jobCard));
    jobsMessage.textContent = value.jobsError
      ? `${value.jobsError} Показана сторінка може бути застарілою.`
      : value.jobsLoading
        ? "Оновлюємо сторінку задач…"
        : value.jobs
          ? `${value.jobs.total} задач за фільтром. Snapshot PostgreSQL: ${date(value.jobs.snapshotAt)}.${value.jobs.jobs.length ? "" : " Список порожній."}`
          : "Завантажуємо задачі…";
    jobsMessage.classList.toggle("error", Boolean(value.jobsError));
    page.textContent = `Сторінка ${value.query.offset / 20 + 1}${value.jobs ? ` · ${value.query.offset + 1}–${value.query.offset + value.jobs.jobs.length} із ${value.jobs.total}` : ""}`;
    if (value.jobs?.total === 0) page.textContent = "Сторінка 1 · немає задач";
    prev.setAttribute("aria-disabled", String(value.query.offset === 0));
    next.setAttribute(
      "aria-disabled",
      String(
        !value.jobs ||
          value.query.offset + value.jobs.jobs.length >= value.jobs.total ||
          value.query.offset >= 1_000_000,
      ),
    );
  }
  return {
    render,
    clearPrivate,
    destroy: () => {
      events.abort();
      clearPrivate();
    },
  };
}
