import type { Coordinate } from "../shared/route.js";

export interface InitialRouteStep {
  step: number;
  from: number;
  to: number;
  distance: number;
  returnsToWarehouse: boolean;
}

// розписую переходи збереженого initialOrder без повторного пошуку найближчого сусіда в UI
export function initialRouteSteps(
  input: { warehouse: Coordinate; points: readonly Coordinate[] },
  order: readonly number[],
): InitialRouteStep[] {
  const coordinates = [input.warehouse, ...input.points];
  if (
    order.length !== coordinates.length + 1 ||
    order[0] !== 0 ||
    order.at(-1) !== 0 ||
    coordinates.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) throw new Error("Некоректний збережений початковий маршрут.");
  const seen = new Set<number>();
  for (const index of order.slice(0, -1)) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= coordinates.length || seen.has(index)) {
      throw new Error("Некоректний індекс збереженого початкового маршруту.");
    }
    seen.add(index);
  }
  return order.slice(1).map((to, index) => {
    const from = order[index]!;
    const a = coordinates[from]!;
    const b = coordinates[to]!;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    if (!Number.isFinite(distance)) throw new Error("Відстань переходу не є скінченною.");
    return { step: index + 1, from, to, distance, returnsToWarehouse: index === order.length - 2 };
  });
}

export function routeSequence(order: readonly number[]): string {
  return order.map((index) => index === 0 ? "Склад" : String(index)).join(" → ");
}
