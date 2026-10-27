import type { JobDetails, JobStatus, JobSummary } from "../shared/jobs.js";
import type { JobsState } from "./jobs-controller.js";
import type { RouteDraft } from "./route-input.js";
import { formatProgress, projectRoute } from "./route-geometry.js";
import { queueDisplay } from "./queue-display.js";

export interface JobsViewActions {
  submit(draft: RouteDraft): void;
  selectJob(id: string): void;
  cancel(id: string): void;
  historyPage(offset: number): void;
  retryLimits(): void;
  refresh(): void;
}

export interface JobsView {
  render(state: JobsState): void;
  clearPrivate(): void;
  showDraftError(message: string, field?: keyof RouteDraft): void;
}

const statusLabels: Record<JobStatus, string> = {
  queued: "У черзі",
  running: "Обчислюється",
  completed: "Завершено",
  cancelled: "Скасовано",
  failed: "Помилка",
};
const stageLabels = {
  preparing: "Підготовка маршруту",
  searching: "Пошук коротшого маршруту",
  finishing: "Збереження результату",
};
const failureLabels = {
  timeout:
    "Досягнуто серверної межі часу. Спробуйте менший бюджет або менше доставок.",
  worker_error: "Обчислення завершилося помилкою. Можна створити нову задачу.",
  server_shutdown:
    "Сервер зупинився під час обчислення. Можна створити нову задачу.",
  database_unavailable:
    "Обчислення перерване через тимчасову недоступність збереження даних.",
  invalid_input: "Збережені дані задачі не пройшли перевірку.",
  worker_lost:
    "Втрачено зв’язок з обчисленням. Задачу не запускали повторно автоматично.",
};

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не знайдено елемент інтерфейсу: ${selector}`);
  return element;
}

function number(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString("uk-UA", { maximumFractionDigits });
}

function distance(value: number): string {
  return value !== 0 && Math.abs(value) < 0.000001
    ? value.toLocaleString("uk-UA", {
        notation: "scientific",
        maximumFractionDigits: 8,
      })
    : number(value, 8);
}

function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function date(value: string): string {
  return new Date(value).toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface JobListItem {
  item: HTMLLIElement;
  button: HTMLButtonElement;
  created: HTMLSpanElement;
  reference: HTMLSpanElement;
  badge: HTMLElement;
  progress: HTMLSpanElement;
}

export function createJobsView(actions: JobsViewActions): JobsView {
  const workspace = requireElement<HTMLElement>("#jobs-workspace");
  const form = requireElement<HTMLFormElement>("#route-form");
  const fields: Record<
    keyof RouteDraft,
    HTMLInputElement | HTMLTextAreaElement
  > = {
    warehouseX: requireElement<HTMLInputElement>("#warehouse-x"),
    warehouseY: requireElement<HTMLInputElement>("#warehouse-y"),
    points: requireElement<HTMLTextAreaElement>("#delivery-points"),
    iterations: requireElement<HTMLInputElement>("#route-iterations"),
    seed: requireElement<HTMLInputElement>("#route-seed"),
  };
  const submit = requireElement<HTMLButtonElement>("#route-submit");
  const limitsBox = requireElement<HTMLElement>("#route-limits");
  const limitsMessage = requireElement<HTMLElement>("#route-limits-message");
  const limitsRetry = requireElement<HTMLButtonElement>("#route-limits-retry");
  const draftError = requireElement<HTMLElement>("#route-draft-error");
  const actionMessage = requireElement<HTMLElement>("#jobs-action-message");
  const detailContent = requireElement<HTMLElement>("#job-detail-content");
  const detailMessage = requireElement<HTMLElement>("#job-detail-message");
  const detailRetry = requireElement<HTMLButtonElement>("#job-detail-retry");
  const detailPanel = requireElement<HTMLElement>(".detail-panel");
  const detailStatus = requireElement<HTMLElement>("#job-detail-status");
  const detailStage = requireElement<HTMLElement>("#job-detail-stage");
  const queueBox = requireElement<HTMLElement>("#job-queue");
  const queueStale = requireElement<HTMLElement>("#job-queue-stale");
  const detailProgress = requireElement<HTMLProgressElement>(
    "#job-detail-progress",
  );
  const detailIterations = requireElement<HTMLElement>(
    "#job-detail-iterations",
  );
  const detailCancel = requireElement<HTMLButtonElement>("#job-detail-cancel");
  const cancelNote = requireElement<HTMLElement>("#job-detail-cancel-note");
  const detailError = requireElement<HTMLElement>("#job-detail-error");
  const result = requireElement<HTMLElement>("#job-result");
  const diagram = requireElement<HTMLElement>("#route-diagram");
  const activeList = requireElement<HTMLUListElement>("#active-jobs");
  const historyList = requireElement<HTMLUListElement>("#history-jobs");
  const activeMessage = requireElement<HTMLElement>("#active-message");
  const historyMessage = requireElement<HTMLElement>("#history-message");
  const historyPrevious = requireElement<HTMLButtonElement>("#history-prev");
  const historyNext = requireElement<HTMLButtonElement>("#history-next");
  const maps = new Map<HTMLUListElement, Map<string, JobListItem>>([
    [activeList, new Map()],
    [historyList, new Map()],
  ]);
  let currentState: JobsState | null = null;
  let initializedIterations = false;
  let inputFingerprint = "";
  let resultFingerprint = "";

  const text = (id: string, value: string): void => {
    setText(requireElement<HTMLElement>(`#${id}`), value);
  };
  const clearQueue = (): void => {
    queueBox.hidden = true;
    queueBox.removeAttribute("data-stale");
    queueStale.hidden = true;
    for (const id of [
      "job-queue-estimate",
      "job-queue-explanation",
      "job-queue-context",
    ])
      text(id, "");
  };
  const clearDraftError = (): void => {
    draftError.textContent = "";
    draftError.hidden = true;
    for (const field of Object.values(fields))
      field.removeAttribute("aria-invalid");
  };
  const draft = (): RouteDraft => ({
    warehouseX: fields.warehouseX.value,
    warehouseY: fields.warehouseY.value,
    points: fields.points.value,
    iterations: fields.iterations.value,
    seed: fields.seed.value,
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    clearDraftError();
    actions.submit(draft());
  });
  for (const field of Object.values(fields))
    field.addEventListener("input", clearDraftError);
  fields.iterations.addEventListener("input", () => {
    initializedIterations = true;
  });
  limitsRetry.addEventListener("click", actions.retryLimits);
  requireElement<HTMLButtonElement>("#jobs-refresh").addEventListener(
    "click",
    actions.refresh,
  );
  requireElement<HTMLButtonElement>("#fill-square").addEventListener(
    "click",
    () => {
      fields.warehouseX.value = "0";
      fields.warehouseY.value = "0";
      fields.points.value = "1 0\n1 1\n0 1";
      fields.seed.value = "0";
      if (currentState?.limits) {
        fields.iterations.value = String(
          Math.min(10_000, currentState.limits.route.maxIterations),
        );
        initializedIterations = true;
      }
      clearDraftError();
    },
  );
  detailCancel.addEventListener("click", () => {
    if (currentState?.selectedId && !detailCancel.disabled)
      actions.cancel(currentState.selectedId);
  });
  detailRetry.addEventListener("click", () => {
    if (currentState?.selectedId) actions.selectJob(currentState.selectedId);
  });
  historyPrevious.addEventListener("click", () => {
    if (currentState && !historyPrevious.disabled)
      actions.historyPage(Math.max(0, currentState.historyOffset - 20));
  });
  historyNext.addEventListener("click", () => {
    if (currentState && !historyNext.disabled)
      actions.historyPage(currentState.historyOffset + 20);
  });
  detailStatus.setAttribute("role", "status");
  detailStatus.setAttribute("aria-live", "polite");

  function renderList(
    list: HTMLUListElement,
    jobs: JobSummary[],
    selectedId: string | null,
  ): void {
    const entries = maps.get(list)!;
    const wanted = new Set(jobs.map((job) => job.id));
    for (const [id, entry] of entries) {
      if (!wanted.has(id)) {
        entry.item.remove();
        entries.delete(id);
      }
    }
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!;
      let entry = entries.get(job.id);
      if (!entry) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "job-item";
        button.setAttribute("aria-controls", "job-detail-content");
        const copy = document.createElement("span");
        copy.className = "job-item-copy";
        const created = document.createElement("span");
        created.className = "job-item-date";
        const reference = document.createElement("span");
        reference.className = "job-item-reference";
        copy.append(created, reference);
        const status = document.createElement("span");
        status.className = "job-item-state";
        const badge = document.createElement("strong");
        badge.className = "status-badge";
        const progress = document.createElement("span");
        progress.className = "job-item-progress";
        status.append(badge, progress);
        button.append(copy, status);
        button.addEventListener("click", () => actions.selectJob(job.id));
        item.append(button);
        entry = { item, button, created, reference, badge, progress };
        entries.set(job.id, entry);
      }
      entry.created.textContent = date(job.createdAt);
      entry.reference.textContent = `Маршрут · ${job.id.slice(0, 8)}`;
      entry.badge.textContent = statusLabels[job.status];
      entry.badge.dataset.status = job.status;
      entry.progress.textContent =
        job.cancelRequested && job.status === "running"
          ? "Очікуємо скасування"
          : formatProgress(job.progress.percent, job.status);
      entry.button.setAttribute("aria-pressed", String(job.id === selectedId));
      entry.button.setAttribute(
        "aria-label",
        `Маршрут від ${date(job.createdAt)}. ${statusLabels[job.status]}. Відкрити деталі.`,
      );
      if (list.children[index] !== entry.item)
        list.insertBefore(entry.item, list.children[index] ?? null);
    }
  }

  function clearResult(): void {
    result.hidden = true;
    resultFingerprint = "";
    diagram.replaceChildren();
    for (const id of [
      "job-result-length",
      "job-route-order",
      "job-initial-length",
      "job-result-iterations",
      "job-elapsed",
      "job-termination",
    ])
      text(id, "");
    requireElement<HTMLElement>("#job-result-length").removeAttribute("title");
  }

  function renderResult(job: JobDetails): void {
    if (job.status !== "completed" || !job.result) {
      clearResult();
      return;
    }
    const fingerprint = JSON.stringify([job.id, job.input, job.result]);
    if (fingerprint === resultFingerprint) {
      result.hidden = false;
      return;
    }
    clearResult();
    try {
      const projection = projectRoute(job.input, job.result.order);
      const namespace = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(namespace, "svg");
      svg.setAttribute(
        "viewBox",
        `0 0 ${projection.width} ${projection.height}`,
      );
      svg.setAttribute("role", "img");
      svg.setAttribute(
        "aria-labelledby",
        "route-svg-title route-svg-description",
      );
      const title = document.createElementNS(namespace, "title");
      title.id = "route-svg-title";
      title.textContent = "Схема збереженого маршруту";
      const description = document.createElementNS(namespace, "desc");
      description.id = "route-svg-description";
      description.textContent = `Склад позначено квадратом. ${job.input.points.length} точок доставки. Лінія проходить у збереженому порядку й повертається на склад. Текстовий порядок наведено під схемою.`;
      const line = document.createElementNS(namespace, "polyline");
      line.setAttribute("points", projection.path);
      line.setAttribute("class", "route-line");
      svg.append(title, description, line);
      for (const point of projection.points.filter(
        (point) => point.index !== 0,
      )) {
        const marker = document.createElementNS(namespace, "circle");
        marker.setAttribute("cx", String(point.x));
        marker.setAttribute("cy", String(point.y));
        marker.setAttribute("r", job.input.points.length > 100 ? "3" : "5");
        marker.setAttribute("class", "delivery-marker");
        const markerTitle = document.createElementNS(namespace, "title");
        const coordinate = job.input.points[point.index - 1]!;
        markerTitle.textContent = `Доставка ${point.index}: (${coordinate.x}; ${coordinate.y})`;
        marker.append(markerTitle);
        svg.append(marker);
        if (job.input.points.length <= 40) {
          const label = document.createElementNS(namespace, "text");
          const labelToLeft =
            point.x > projection.width - projection.padding - 30;
          label.setAttribute("x", String(point.x + (labelToLeft ? -10 : 10)));
          label.setAttribute("y", String(point.y - 10));
          label.setAttribute("text-anchor", labelToLeft ? "end" : "start");
          label.setAttribute("class", "point-label");
          label.textContent = String(point.index);
          svg.append(label);
        }
      }
      const warehouse = projection.points[0]!;
      const marker = document.createElementNS(namespace, "rect");
      marker.setAttribute("x", String(warehouse.x - 7));
      marker.setAttribute("y", String(warehouse.y - 7));
      marker.setAttribute("width", "14");
      marker.setAttribute("height", "14");
      marker.setAttribute("rx", "2");
      marker.setAttribute("class", "warehouse-marker");
      const warehouseTitle = document.createElementNS(namespace, "title");
      warehouseTitle.textContent = `Склад: (${job.input.warehouse.x}; ${job.input.warehouse.y})`;
      marker.append(warehouseTitle);
      svg.append(marker);
      diagram.replaceChildren(svg);
      text("job-result-length", distance(job.result.length));
      requireElement<HTMLElement>("#job-result-length").title = String(
        job.result.length,
      );
      text("job-initial-length", distance(job.result.initialLength));
      text(
        "job-route-order",
        `Порядок: ${job.result.order.map((index) => (index === 0 ? "Склад" : String(index))).join(" → ")}`,
      );
      text(
        "job-result-iterations",
        `${number(job.result.iterationsCompleted)} із ${number(job.result.iterationsRequested)}`,
      );
      text("job-elapsed", `${number(job.result.elapsedMs, 3)} мс`);
      text(
        "job-termination",
        job.result.terminationReason === "trivial_input"
          ? "Для однієї або двох доставок пошук не потрібен: виконано 0 ітерацій."
          : job.result.terminationReason === "zero_length"
            ? "Усі точки збігаються: довжина 0, виконано 0 ітерацій."
            : "Виконано заданий бюджет ітерацій.",
      );
      resultFingerprint = fingerprint;
      result.hidden = false;
    } catch {
      detailError.hidden = false;
      detailError.textContent =
        "Збережений маршрут не вдалося відобразити. Повторіть читання деталей.";
      detailRetry.hidden = false;
    }
  }

  function renderDetail(state: JobsState): void {
    const job = state.detail?.id === state.selectedId ? state.detail : null;
    detailPanel.setAttribute("aria-busy", String(state.detailLoading));
    detailPanel.dataset.state = state.detailLoading ? "loading" : "ready";
    detailRetry.hidden = !state.detailError || state.detailLoading;
    detailMessage.classList.toggle("error", Boolean(state.detailError));
    if (!state.selectedId || !job) {
      clearQueue();
      detailContent.hidden = true;
      detailMessage.hidden = false;
      setText(
        detailMessage,
        state.detailError ||
          (state.detailLoading
            ? "Завантажуємо збережену задачу…"
            : "Виберіть задачу зі списку або запустіть новий маршрут."),
      );
      clearResult();
      inputFingerprint = "";
      return;
    }
    detailContent.hidden = false;
    detailMessage.hidden = !state.detailError;
    setText(detailMessage, state.detailError);
    setText(detailStatus, statusLabels[job.status]);
    detailStatus.dataset.status = job.status;
    setText(
      detailStage,
      job.status === "queued"
        ? "Очікує на вільний обчислювальний процес."
        : job.status === "running"
          ? stageLabels[job.progress.stage]
          : job.status === "completed"
            ? "Пошук завершено, результат збережено."
            : job.status === "cancelled"
              ? "Виконання зупинено. Можна запустити нову задачу."
              : "Обчислення завершилося без результату.",
    );
    if (job.status === "queued") {
      const display = queueDisplay(job.queue);
      queueBox.hidden = false;
      queueBox.dataset.stale = String(Boolean(state.detailError));
      queueStale.hidden = !state.detailError;
      text("job-queue-estimate", display.estimate);
      text("job-queue-explanation", display.explanation);
      text("job-queue-context", display.context);
    } else clearQueue();
    const percent = Number.isFinite(job.progress.percent)
      ? Math.max(
          0,
          Math.min(
            job.progress.percent,
            job.status === "completed" ? 100 : 99.9,
          ),
        )
      : 0;
    detailProgress.value = percent;
    detailProgress.setAttribute(
      "aria-valuetext",
      formatProgress(job.progress.percent, job.status),
    );
    setText(
      detailIterations,
      `${formatProgress(job.progress.percent, job.status)} · ${number(job.progress.completedIterations)} із ${number(job.progress.totalIterations)} ітерацій`,
    );
    detailCancel.hidden = job.status !== "queued" && job.status !== "running";
    detailCancel.disabled = state.cancellingId !== null || job.cancelRequested;
    setText(
      detailCancel,
      state.cancellingId === job.id
        ? "Надсилаємо запит…"
        : state.cancellingId !== null
          ? "Очікуємо попереднього запиту…"
          : job.cancelRequested
            ? "Скасування запитано"
            : "Скасувати задачу",
    );
    cancelNote.hidden = !job.cancelRequested || job.status !== "running";
    detailError.hidden = job.status !== "failed";
    detailError.textContent = job.error ? failureLabels[job.error.reason] : "";
    text("job-created", date(job.createdAt));
    text("job-point-count", number(job.input.points.length));
    text("job-seed", String(job.input.seed));
    text("job-budget", number(job.input.iterations));
    text("job-reference", job.id);
    const fingerprint = JSON.stringify([job.id, job.input]);
    if (fingerprint !== inputFingerprint) {
      const saved = requireElement<HTMLDetailsElement>("#saved-input");
      saved.open = false;
      text(
        "saved-warehouse",
        `Склад: X = ${job.input.warehouse.x}; Y = ${job.input.warehouse.y}`,
      );
      const points = requireElement<HTMLOListElement>("#saved-deliveries");
      points.replaceChildren(
        ...job.input.points.map((point) => {
          const item = document.createElement("li");
          item.textContent = `X = ${point.x}; Y = ${point.y}`;
          return item;
        }),
      );
      inputFingerprint = fingerprint;
    }
    renderResult(job);
  }

  function clearPrivate(): void {
    workspace.hidden = true;
    currentState = null;
    initializedIterations = false;
    inputFingerprint = "";
    fields.warehouseX.value = "0";
    fields.warehouseY.value = "0";
    fields.points.value = "";
    fields.iterations.value = "";
    fields.seed.value = "";
    clearDraftError();
    clearResult();
    clearQueue();
    detailContent.hidden = true;
    detailMessage.textContent =
      "Виберіть задачу зі списку або запустіть новий маршрут.";
    detailMessage.hidden = false;
    detailMessage.classList.remove("error");
    detailRetry.hidden = true;
    detailError.textContent = "";
    detailError.hidden = true;
    detailProgress.value = 0;
    detailProgress.removeAttribute("aria-valuetext");
    limitsMessage.textContent = "Завантажуємо серверні ліміти…";
    text("saved-warehouse", "");
    requireElement<HTMLOListElement>("#saved-deliveries").replaceChildren();
    for (const id of [
      "job-created",
      "job-point-count",
      "job-seed",
      "job-budget",
      "job-reference",
      "job-detail-status",
      "job-detail-stage",
      "job-detail-iterations",
      "active-message",
      "history-message",
      "active-count",
      "history-page",
    ])
      text(id, "");
    for (const [list, entries] of maps) {
      list.replaceChildren();
      entries.clear();
    }
    actionMessage.textContent = "";
    actionMessage.hidden = true;
    submit.disabled = true;
  }

  return {
    clearPrivate,
    showDraftError(message, field) {
      clearDraftError();
      draftError.textContent = message;
      draftError.hidden = false;
      if (field) {
        fields[field].setAttribute("aria-invalid", "true");
        fields[field].focus();
      }
    },
    render(state) {
      if (!state.authenticated) {
        clearPrivate();
        return;
      }
      currentState = state;
      workspace.hidden = false;
      if (state.limits && !initializedIterations) {
        fields.iterations.value = String(
          Math.min(1_000_000, state.limits.route.maxIterations),
        );
        initializedIterations = true;
      }
      limitsBox.dataset.state = state.limitsError
        ? "error"
        : state.limitsLoading
          ? "loading"
          : "ready";
      setText(
        limitsMessage,
        state.limitsError ||
          (state.limitsLoading
            ? "Завантажуємо серверні ліміти…"
            : state.limits
              ? `До ${number(state.limits.route.maxPoints)} доставок; координати від −${number(state.limits.route.maxCoordinate)} до ${number(state.limits.route.maxCoordinate)}. До ${number(state.limits.route.maxIterations)} ітерацій. Серверна межа часу: ${number(state.limits.route.timeoutMs / 1000, 3)} с. Одночасно до ${number(state.limits.maxActivePerUser)} ваших активних задач; збережена історія до цієї квоти не входить.`
              : "Ліміти ще не отримано. Повторіть завантаження."),
      );
      limitsRetry.hidden =
        state.limitsLoading || Boolean(state.limits && !state.limitsError);
      submit.disabled =
        state.submitting ||
        !state.limits ||
        state.limitsLoading ||
        Boolean(state.limitsError);
      setText(
        submit,
        state.submitting ? "Надсилаємо задачу…" : "Знайти маршрут ↗",
      );
      actionMessage.hidden = !state.actionMessage && !state.actionError;
      setText(actionMessage, state.actionError || state.actionMessage);
      actionMessage.classList.toggle("error", Boolean(state.actionError));
      activeList.setAttribute("aria-busy", String(state.activeLoading));
      historyList.setAttribute("aria-busy", String(state.historyLoading));
      activeMessage.classList.toggle("error", Boolean(state.activeError));
      historyMessage.classList.toggle("error", Boolean(state.historyError));
      setText(
        activeMessage,
        state.activeError
          ? `${state.activeError} Натисніть «Оновити задачі».`
          : state.activeLoading && state.active.length === 0
            ? "Завантажуємо активні задачі…"
            : state.active.length === 0
              ? "Немає активних задач. Можна створити новий маршрут."
              : "",
      );
      setText(
        historyMessage,
        state.historyError
          ? `${state.historyError} Натисніть «Оновити задачі».`
          : state.historyLoading && state.history.length === 0
            ? "Завантажуємо історію…"
            : state.history.length === 0
              ? state.historyOffset === 0
                ? "Історія поки порожня. Тут зберігатимуться ваші задачі."
                : "На цій сторінці задач немає. Поверніться до попередньої."
              : "",
      );
      text(
        "active-count",
        `${number(state.active.length)}${state.limits ? ` / ${number(state.limits.maxActivePerUser)}` : ""}`,
      );
      renderList(activeList, state.active, state.selectedId);
      renderList(historyList, state.history, state.selectedId);
      historyPrevious.disabled =
        state.historyLoading || state.historyOffset === 0;
      historyNext.disabled =
        state.historyLoading ||
        !state.historyHasNext ||
        state.historyOffset >= 1_000_000;
      text(
        "history-page",
        `Сторінка ${number(Math.floor(state.historyOffset / 20) + 1)}`,
      );
      renderDetail(state);
    },
  };
}
