import type { Coordinate } from '../shared/route.js';
import type { JobStatus } from '../shared/jobs.js';

export interface ProjectedPoint {
  index: number;
  x: number;
  y: number;
}

export interface RouteProjection {
  width: number;
  height: number;
  padding: number;
  points: ProjectedPoint[];
  path: string;
  scale: number;
}

// переношу збережені точки у SVG з однаковим масштабом X і Y та номерами 0 для складу і 1..N для доставок
export function projectRoute(
  input: { warehouse: Coordinate; points: readonly Coordinate[] },
  order: readonly number[],
): RouteProjection {
  const width = 800;
  const height = 480;
  const padding = 40;
  const coordinates = [input.warehouse, ...input.points];
  if (coordinates.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('Координати схеми мають бути скінченними числами.');
  }
  if (order.length !== coordinates.length + 1 || order[0] !== 0 || order.at(-1) !== 0) {
    throw new Error('Некоректний порядок маршруту.');
  }
  const seen = new Set<number>();
  for (const index of order.slice(0, -1)) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coordinates.length || seen.has(index)) {
      throw new Error('Некоректний індекс точки маршруту.');
    }
    seen.add(index);
  }
  let minX = coordinates[0]!.x;
  let maxX = minX;
  let minY = coordinates[0]!.y;
  let maxY = minY;
  for (const point of coordinates) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const span = Math.max(spanX, spanY);
  if (!Number.isFinite(span)) throw new Error('Діапазон координат завеликий для схеми.');
  // Normalize first: tiny nonzero spans must not be replaced with 1 or overflow the scale.
  const fit = span === 0 ? 0 : Math.min(
    spanX === 0 ? Infinity : (width - 2 * padding) / (spanX / span),
    spanY === 0 ? Infinity : (height - 2 * padding) / (spanY / span),
  );
  const offsetX = (width - (span === 0 ? 0 : spanX / span * fit)) / 2;
  const offsetY = (height - (span === 0 ? 0 : spanY / span * fit)) / 2;
  const points = coordinates.map((point, index) => ({
    index,
    x: span === 0 ? width / 2 : offsetX + (point.x - minX) / span * fit,
    y: span === 0 ? height / 2 : height - offsetY - (point.y - minY) / span * fit,
  }));
  return {
    width, height, padding, points,
    path: order.map((index) => `${points[index]!.x},${points[index]!.y}`).join(' '),
    scale: span === 0 ? 1 : Math.min(Number.MAX_VALUE, fit / span),
  };
}

/** Truncate pending progress so 99.999 can never look like completed 100. */
export function formatProgress(percent: number, status: JobStatus): string {
  const bounded = Number.isFinite(percent) ? Math.max(0, Math.min(percent, status === 'completed' ? 100 : 99.9)) : 0;
  const displayed = Math.floor(bounded * 10) / 10;
  return `${displayed.toLocaleString('uk-UA', { maximumFractionDigits: 1 })}%`;
}
