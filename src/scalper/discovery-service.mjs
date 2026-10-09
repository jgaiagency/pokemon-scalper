import { fileURLToPath } from 'node:url';
import { runAutonomousDiscoveryCycle } from './discovery-cycle.mjs';
import { loadEnvFile } from './env.mjs';
import { abortableDelay } from './timing.mjs';
import { createHttpTransport } from './transports/http.mjs';

export async function serveDiscovery({
  env = process.env,
  runCycle = runAutonomousDiscoveryCycle,
  http = createHttpTransport(),
  sleep = abortableDelay,
  now = Date.now,
  signal,
  logger = console,
  maxCycles = Infinity,
} = {}) {
  const configuredInterval = Number(env.SCALPER_DISCOVERY_INTERVAL_MS || 15_000);
  const baseIntervalMs = Number.isFinite(configuredInterval) ? Math.max(1_000, configuredInterval) : 15_000;
  const maxBackoffMs = Math.max(baseIntervalMs, Number(env.SCALPER_DISCOVERY_MAX_BACKOFF_MS || 5 * 60_000));
  let failures = 0;
  let cycles = 0;
  while (!signal?.aborted && cycles < maxCycles) {
    const startedAt = now();
    try {
      const result = await runCycle({ env, http });
      cycles += 1;
      failures = result.errors?.length ? Math.min(failures + 1, 8) : 0;
      logger.log?.(JSON.stringify({
        timestamp: now(), type: 'discovery-service-cycle', durationMs: Math.max(0, now() - startedAt),
        sources: result.sources, items: result.items, actionable: result.actionable,
        transitions: result.alerts?.length ?? 0, executions: result.executions?.length ?? 0,
        errors: result.errors ?? [],
      }));
    } catch (error) {
      cycles += 1;
      failures = Math.min(failures + 1, 8);
      logger.error?.(JSON.stringify({ timestamp: now(), type: 'discovery-service-error', error: error.message, code: error.code }));
    }
    if (signal?.aborted || cycles >= maxCycles) break;
    const backoff = failures ? Math.min(maxBackoffMs, baseIntervalMs * (2 ** failures)) : baseIntervalMs;
    const elapsed = Math.max(0, now() - startedAt);
    await sleep(Math.max(1, backoff - elapsed), { signal });
  }
  return { status: signal?.aborted ? 'stopped' : 'complete', cycles, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Discovery service stopped'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await serveDiscovery({ signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}
