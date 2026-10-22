import { readFile } from 'node:fs/promises';
import { RouteExecutor } from './executor.js';
import { readRouteConfig } from './config.js';

let executor: RouteExecutor | undefined;
const cancel = (): void => { void executor?.cancel(); };
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  executor = new RouteExecutor(readRouteConfig());
  const filename = process.argv[2];
  if (process.argv.length > 3) throw new Error('Використання: npm run route:demo -- examples/route-small.json');
  const content = filename
    ? await readFile(filename, 'utf8')
    : await readFile(new URL(
      import.meta.url.endsWith('.ts') ? '../../../examples/route-small.json' : '../../examples/route-small.json',
      import.meta.url,
    ), 'utf8');
  const input: unknown = JSON.parse(content);
  const run = executor.start(input, (progress) => {
    console.error(JSON.stringify({ stage: progress.stage, percent: progress.percent, completedIterations: progress.completedIterations, totalIterations: progress.totalIterations }));
  });
  const outcome = await run.result;
  console.info(JSON.stringify(outcome, null, 2));
  if (outcome.status !== 'completed') process.exitCode = outcome.status === 'cancelled' ? 2 : 1;
} catch (error) {
  if (error instanceof SyntaxError) console.error('Вхідний файл має містити коректний JSON маршруту.');
  else if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && error.code.startsWith('E')) {
    console.error('Не вдалося прочитати вхідний файл маршруту. Перевірте шлях і доступ.');
  } else console.error(error instanceof Error ? error.message : 'Не вдалося виконати розрахунок маршруту.');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  await executor?.shutdown();
}
