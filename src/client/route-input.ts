import type { RouteInput, RouteLimits } from "../shared/route.js";

export interface RouteDraft {
  warehouseX: string;
  warehouseY: string;
  points: string;
  iterations: string;
  seed: string;
}

export type RouteDraftResult =
  | { ok: true; input: RouteInput }
  | {
      ok: false;
      message: string;
      field: keyof RouteDraft;
      line?: number;
    };

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_TEXT_LENGTH = 256 * 1024;

function coordinate(text: string, maximum: number): number | null {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
}

function integer(
  text: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

/** Count first, then construct only the bounded number of delivery objects. */
export function parseRouteDraft(
  draft: RouteDraft,
  limits: RouteLimits,
): RouteDraftResult {
  if (
    !Number.isSafeInteger(limits.maxPoints) ||
    limits.maxPoints < 1 ||
    limits.maxPoints > 2_000 ||
    !Number.isSafeInteger(limits.maxIterations) ||
    limits.maxIterations < 1 ||
    limits.maxIterations > 200_000_000 ||
    !Number.isFinite(limits.maxCoordinate) ||
    limits.maxCoordinate <= 0 ||
    limits.maxCoordinate > 1_000_000
  ) {
    return {
      ok: false,
      field: "points",
      message: "Спочатку завантажте коректні серверні ліміти.",
    };
  }
  const x = coordinate(draft.warehouseX, limits.maxCoordinate);
  const y = coordinate(draft.warehouseY, limits.maxCoordinate);
  if (x === null || y === null)
    return {
      ok: false,
      field: x === null ? "warehouseX" : "warehouseY",
      message: `Координати складу мають бути скінченними числами від −${limits.maxCoordinate} до ${limits.maxCoordinate}.`,
    };
  if (draft.points.length > MAX_TEXT_LENGTH)
    return {
      ok: false,
      field: "points",
      message: "Текст доставок завеликий. Скоротіть його до 262144 символів.",
    };
  let count = 0;
  // Do not split the entire text into an unbounded array.
  for (let start = 0; start <= draft.points.length; ) {
    const end = draft.points.indexOf("\n", start);
    const line = draft.points.slice(start, end === -1 ? undefined : end).trim();
    if (line && ++count > limits.maxPoints)
      return {
        ok: false,
        field: "points",
        message: `Дозволено щонайбільше ${limits.maxPoints} доставок.`,
      };
    if (end === -1) break;
    start = end + 1;
  }
  if (count === 0)
    return {
      ok: false,
      field: "points",
      message: "Введіть щонайменше одну доставку.",
    };
  const points: RouteInput["points"] = [];
  let lineNumber = 0;
  for (let start = 0; start <= draft.points.length; ) {
    const end = draft.points.indexOf("\n", start);
    const line = draft.points.slice(start, end === -1 ? undefined : end).trim();
    lineNumber++;
    if (line) {
      const parts = /^([^\t ]+)[\t ]+([^\t ]+)$/.exec(line);
      const pointX = parts
        ? coordinate(parts[1] ?? "", limits.maxCoordinate)
        : null;
      const pointY = parts
        ? coordinate(parts[2] ?? "", limits.maxCoordinate)
        : null;
      if (pointX === null || pointY === null)
        return {
          ok: false,
          field: "points",
          line: lineNumber,
          message: `Рядок ${lineNumber}: потрібні рівно два скінченні числа «x y» у межах ±${limits.maxCoordinate}, з десятковою крапкою.`,
        };
      points.push({ x: pointX, y: pointY });
    }
    if (end === -1) break;
    start = end + 1;
  }
  const iterations = integer(draft.iterations, 1, limits.maxIterations);
  if (iterations === null)
    return {
      ok: false,
      field: "iterations",
      message: `Кількість ітерацій має бути цілим числом від 1 до ${limits.maxIterations}.`,
    };
  const input: RouteInput = { warehouse: { x, y }, points, iterations };
  if (draft.seed.trim() !== "") {
    const seed = integer(draft.seed, 0, 4_294_967_295);
    if (seed === null)
      return {
        ok: false,
        field: "seed",
        message: "Seed має бути цілим числом від 0 до 4294967295 або порожнім.",
      };
    input.seed = seed;
  }
  return { ok: true, input };
}
