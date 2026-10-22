export interface Coordinate {
  x: number;
  y: number;
}

export interface RouteInput {
  warehouse: Coordinate;
  points: Coordinate[];
  iterations: number;
  seed?: number;
}

export interface NormalizedRouteInput extends RouteInput {
  seed: number;
}

export interface RouteLimits {
  maxPoints: number;
  maxIterations: number;
  timeoutMs: number;
  maxCoordinate: number;
}

export interface RouteResult {
  order: number[];
  length: number;
  initialLength: number;
  seed: number;
  iterationsRequested: number;
  iterationsCompleted: number;
  elapsedMs: number;
  approximate: true;
  terminationReason: 'budget_exhausted' | 'trivial_input' | 'zero_length';
}

export interface RouteProgress {
  stage: 'preparing' | 'searching' | 'finishing';
  completedIterations: number;
  totalIterations: number;
  percent: number;
}

export type RouteOutcome =
  | { status: 'completed'; result: RouteResult }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: 'timeout' | 'worker_error'; message: string };
