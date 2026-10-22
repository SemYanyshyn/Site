/** Small reproducible fixture generator; these are conditional planar coordinates. */
export function routeInput(pointCount = 180, iterations = 50_000_000, seed = 0) {
  let state = 0x51a7c0de;
  const coordinate = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0x1_0000_0000) * 2_000 - 1_000;
  };
  return {
    warehouse: { x: 0, y: 0 },
    points: Array.from({ length: pointCount }, () => ({ x: coordinate(), y: coordinate() })),
    iterations,
    seed,
  };
}

export const quickRouteInput = () => ({
  warehouse: { x: 0, y: 0 }, points: [{ x: 3, y: 4 }], iterations: 10, seed: 0,
});
