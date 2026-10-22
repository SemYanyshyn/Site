import { performance } from 'node:perf_hooks';
import { RouteExecutor } from './executor.js';
import { readRouteConfig } from './config.js';
import { generateRouteInput } from './examples.js';

let executor: RouteExecutor | undefined;
try {
  const limits = readRouteConfig();
  executor = new RouteExecutor(limits);
  const cases = [
    { name: 'small', points: 4, iterations: 10_000, seed: 0 },
    { name: 'medium', points: 100, iterations: 1_000_000, seed: 42 },
    // Exercise the explicitly configured server budget, without raising it.
    { name: 'heavy', points: 500, iterations: limits.maxIterations, seed: 42 },
  ] as const;
  for (const scenario of cases) {
    let progressEvents = 0;
    let completedIterations = 0;
    const rssStartBytes = process.memoryUsage.rss();
    let rssPeakBytes = rssStartBytes;
    // Monitoring only: this timer never delays or simulates the search.
    const sampler = setInterval(() => { rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss()); }, 50);
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    try {
      const run = executor.start(generateRouteInput(scenario.points, scenario.iterations, scenario.seed), (progress) => {
        progressEvents++;
        completedIterations = progress.completedIterations;
        rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
      });
      const outcome = await run.result;
      const wallMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuStart);
      rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage.rss());
      console.info(JSON.stringify({
        ...scenario,
        status: outcome.status,
        reason: outcome.status === 'failed' ? outcome.reason : undefined,
        iterationsCompleted: outcome.status === 'completed' ? outcome.result.iterationsCompleted : completedIterations,
        elapsedMs: outcome.status === 'completed' ? outcome.result.elapsedMs : undefined,
        wallMs,
        processCpuUserMs: cpu.user / 1000,
        processCpuSystemMs: cpu.system / 1000,
        initialLength: outcome.status === 'completed' ? outcome.result.initialLength : undefined,
        bestLength: outcome.status === 'completed' ? outcome.result.length : undefined,
        progressEvents,
        rssStartBytes,
        rssPeakBytes,
        memoryScope: 'whole_process_rss_sampled_every_50ms',
        cpuScope: 'whole_process_all_threads',
      }));
      if (outcome.status !== 'completed') process.exitCode = 1;
    } finally {
      clearInterval(sampler);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не вдалося виконати виміри маршруту.');
  process.exitCode = 1;
} finally {
  await executor?.shutdown();
}
