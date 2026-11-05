// Тут описую спільний формат координат, входу, прогресу та результату пошуку
// Ці інтерфейси потрібні TypeScript, але самі не запускають алгоритм і не перевіряють JSON

// Описую точку на умовній площині, x і y не означають GPS-координати
export interface Coordinate {
  x: number;
  y: number;
}

// На вхід передаю склад, доставки та бюджет ітерацій, seed можу не вказувати
// Seed дозволяє відтворити псевдовипадкові кроки того самого пошуку
export interface RouteInput {
  warehouse: Coordinate;
  points: Coordinate[];
  iterations: number;
  seed?: number;
}

// Після серверної перевірки seed уже обов’язковий, за його відсутності сервер генерує значення
// extends зберігає поля RouteInput, але уточнює обов’язковість seed
export interface NormalizedRouteInput extends RouteInput {
  seed: number;
}

// Обмежую кількість доставок, ітерації, час у мілісекундах і модуль координат
// Ці межі застосовую до створення worker, щоб не витрачати ресурси на завеликий вхід
export interface RouteLimits {
  maxPoints: number;
  maxIterations: number;
  timeoutMs: number;
  maxCoordinate: number;
}

// Зберігаю найкращий знайдений маршрут і його порівняння з початковим
// У масиві order індекс 0 означає склад, а 1..N — доставки з масиву points
// Маршрут починається й закінчується нулем, довжина задана в умовних одиницях
export interface RouteResult {
  order: number[];
  length: number;
  initialLength: number;
  // Зберігаю точний початковий маршрут найближчого сусіда, щоб порівняти його з результатом
  // Необов’язковість залишаю для старих результатів, у яких цього поля ще не було
  initialOrder?: number[];
  seed: number;
  // Розрізняю замовлені й фактично виконані ітерації, вони можуть відрізнятися на тривіальному вході
  iterationsRequested: number;
  iterationsCompleted: number;
  elapsedMs: number;
  // Фіксую саме true, бо результат наближений і не доводить глобальну оптимальність
  approximate: true;
  // Пояснюю звичайне завершення пошуку: вичерпав бюджет, мав до двох доставок або нульову довжину
  terminationReason: 'budget_exhausted' | 'trivial_input' | 'zero_length';
}

// Передаю фактичний етап і кількість виконаних ітерацій, а не удаваний прогрес
// 100 відсотків сервер підтверджує тільки після перевіреного результату й виходу worker
export interface RouteProgress {
  stage: 'preparing' | 'searching' | 'finishing';
  completedIterations: number;
  totalIterations: number;
  percent: number;
}

// Розрізняю завершення потоку за полем status, щоб знати, які інші поля можна читати
// Результат доступний тільки для completed, reason і message — тільки для failed
export type RouteOutcome =
  | { status: 'completed'; result: RouteResult }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: 'timeout' | 'worker_error'; message: string };
