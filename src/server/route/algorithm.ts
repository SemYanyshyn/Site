import { performance } from "node:perf_hooks";
// import type потрібен лише typescript і зникає з готового JavaScript
import type {
  Coordinate,
  NormalizedRouteInput,
  RouteProgress,
  RouteResult,
} from "../../shared/route.js";
// пишу .js бо після збирання Node запускає саме JavaScript файли з такими шляхами
import { createRandom } from "./random.js";

const PROGRESS_INTERVAL_MS = 150;
const EXACT_LENGTH_INTERVAL = 32_768;
const ACCEPTED_LENGTH_INTERVAL = 2_048;

// додаю довжини всіх переходів замкненого маршруту за готовою таблицею
// readonly забороняє змінювати масив через цей параметр у TS але не заморожує його в JavaScript
function routeLength(
  order: readonly number[],
  distances: Float64Array,
  size: number,
): number {
  let sum = 0;
  let correction = 0;
  for (let index = 1; index < order.length; index += 1) {
    // ! каже typescript що елемент існує але не перевіряє це під час виконання
    const edge = distances[order[index - 1]! * size + order[index]!]!;
    const next = sum + edge;
    // накопичую втрачені при додаванні дрібні частини щоб зменшити похибку округлення
    correction += Math.abs(sum) >= edge ? sum - next + edge : edge - next + sum;
    sum = next;
  }
  return sum + correction;
}

// рахую відстані один раз щоб не повторювати це на кожній ітерації пошуку
function buildDistances(coordinates: readonly Coordinate[]): Float64Array {
  const size = coordinates.length;
  // Float64Array зберігає числа подвійної точності а клітинка [рядок][стовпець] лежить за рядок * size + стовпець
  const distances = new Float64Array(size * size);
  for (let left = 0; left < size; left += 1) {
    const a = coordinates[left]!;
    for (let right = left + 1; right < size; right += 1) {
      const b = coordinates[right]!;
      // hypot рахує евклідову відстань sqrt(dx² + dy²) між двома точками
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      distances[left * size + right] = distance;
      distances[right * size + left] = distance;
    }
  }
  return distances;
}

// від поточної точки щоразу беру найближчу ще не відвідану доставку
function nearestNeighbor(distances: Float64Array, size: number): number[] {
  // Uint8Array тут зберігає прапорці 0 або 1 а індекс 0 у маршруті означає склад
  const visited = new Uint8Array(size);
  const order = [0];
  visited[0] = 1;
  let current = 0;
  for (let position = 1; position < size; position += 1) {
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = 1; candidate < size; candidate += 1) {
      const distance = distances[current * size + candidate]!;
      // строге < залишає перший менший індекс доставки якщо відстані однакові
      if (visited[candidate] === 0 && distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    order.push(closest);
    visited[closest] = 1;
    current = closest;
  }
  order.push(0);
  return order;
}

// з перевіреного входу будую початковий маршрут і наближено покращую його через 2-opt
export function calculateRoute(
  input: NormalizedRouteInput,
  onProgress?: (progress: RouteProgress) => void,
): RouteResult {
  // performance.now дає монотонний час для тривалості а не календарну дату
  const started = performance.now();
  const totalIterations = input.iterations;
  let completedIterations = 0;
  let lastProgress = started;
  const progress = (stage: RouteProgress["stage"]): void => {
    // ?. викликає необов'язковий callback лише коли він є а 100% підтвердить executor після виходу worker
    onProgress?.({
      stage,
      completedIterations,
      totalIterations,
      percent: Math.min(99.9, (completedIterations / totalIterations) * 100),
    });
  };
  progress("preparing");

  // spread ... збирає новий масив зі складу й доставок але самі об'єкти точок не копіює
  const coordinates = [input.warehouse, ...input.points];
  const size = coordinates.length;
  const count = input.points.length;
  const distances = buildDistances(coordinates);
  const current = nearestNeighbor(distances, size);
  // slice копіює масив індексів щоб зміни current не змінили initialOrder або best
  // initialOrder лишається початковим а best зберігає найкраще знайдене за весь пошук
  const initialOrder = current.slice();
  const initialLength = routeLength(current, distances, size);
  let currentLength = initialLength;
  let best = current.slice();
  let bestLength = initialLength;
  let terminationReason: RouteResult["terminationReason"] = "budget_exhausted";

  // для нульової довжини або максимум двох доставок покращувати порядок ітераціями не потрібно
  if (initialLength === 0) {
    terminationReason = "zero_length";
  } else if (count <= 2) {
    terminationReason = "trivial_input";
  } else {
    // seed дозволяє повторити ті самі випадкові кроки для того самого входу
    const random = createRandom(input.seed);
    // температура керує шансом прийняти погіршення і поступово спадає до нижньої межі
    // Number.MIN_VALUE не дає їй стати нулем навіть для дуже малих координат
    let temperature = Math.max((initialLength / size) * 0.25, Number.MIN_VALUE);
    const finalTemperature = Math.max(temperature * 0.0001, Number.MIN_VALUE);
    const cooling = Math.exp(
      Math.log(finalTemperature / temperature) / totalIterations,
    );
    let acceptedSinceExact = 0;
    progress("searching");

    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      // вибираю дві різні позиції доставок а склад на кінцях не рухаю
      let left = 1 + Math.floor(random() * count);
      let right = 1 + Math.floor(random() * (count - 1));
      if (right >= left) right += 1;
      if (left > right) [left, right] = [right, left];
      // переворот усіх доставок лише розвернув би той самий замкнений маршрут
      if (left === 1 && right === count) right -= 1;

      const before = current[left - 1]!;
      const first = current[left]!;
      const last = current[right]!;
      const after = current[right + 1]!;
      // delta це зміна довжини для 2-opt за двома новими й двома старими граничними ребрами
      const delta =
        distances[before * size + last]! +
        distances[first * size + after]! -
        distances[before * size + first]! -
        distances[last * size + after]!;
      // коротший варіант приймаю завжди а довший іноді щоб вийти з локального мінімуму
      if (delta <= 0 || random() < Math.exp(-delta / temperature)) {
        // міняю місцями краї ділянки до середини і так перевертаю порядок доставок
        for (let start = left, end = right; start < end; start += 1, end -= 1) {
          const value = current[start]!;
          current[start] = current[end]!;
          current[end] = value;
        }
        currentLength += delta;
        acceptedSinceExact += 1;
        // перед новим best і після серії прийнятих змін перевіряю повну довжину замість суми delta
        if (
          currentLength < bestLength ||
          acceptedSinceExact >= ACCEPTED_LENGTH_INTERVAL
        ) {
          currentLength = routeLength(current, distances, size);
          acceptedSinceExact = 0;
          if (currentLength < bestLength) {
            bestLength = currentLength;
            best = current.slice();
          }
        }
      }

      completedIterations = iteration + 1;
      temperature = Math.max(finalTemperature, temperature * cooling);
      // додатково перераховую довжину через фіксовану кількість ітерацій щоб прибрати накопичену похибку
      if (completedIterations % EXACT_LENGTH_INTERVAL === 0) {
        currentLength = routeLength(current, distances, size);
        acceptedSinceExact = 0;
        if (currentLength < bestLength) {
          bestLength = currentLength;
          best = current.slice();
        }
      }
      // раз на 1024 ітерації перевіряю час і надсилаю фактичний лічильник без удаваного прогресу
      if ((completedIterations & 1_023) === 0) {
        const now = performance.now();
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          progress("searching");
          lastProgress = now;
        }
      }
    }
    // остання повна перевірка враховує зміни після попереднього перерахунку
    currentLength = routeLength(current, distances, size);
    if (currentLength < bestLength) best = current.slice();
  }

  progress("finishing");
  return {
    order: best,
    length: routeLength(best, distances, size),
    initialLength,
    initialOrder,
    seed: input.seed,
    iterationsRequested: totalIterations,
    iterationsCompleted: completedIterations,
    elapsedMs: performance.now() - started,
    approximate: true,
    terminationReason,
  };
}
