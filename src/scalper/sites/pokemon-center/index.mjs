import { pollForAvailability } from './detect.mjs';
import { checkoutProduct } from './checkout.mjs';
import { isLiveMode } from '../../dry-run.mjs';
import { createPokemonCenterApi } from './api.mjs';
import { config } from './config.mjs';

export async function runLane({ drop, account, sessionManager, http, api, browser, dryRun, clock, signal, env = process.env, mode = drop?.type ?? 'surprise', onDetection, detector = pollForAvailability, checkout = checkoutProduct } = {}) {
  if (!drop || !account || !sessionManager) throw new Error('Pokémon Center lane requires drop, account, and sessionManager');
  const session = await sessionManager.ensure(account);
  let prewarmError;
  const browserReady = isLiveMode(env) && browser?.prewarm
    ? browser.prewarm({ site: 'pokemon-center', product: drop, account, session, live: true }).catch((error) => { prewarmError = error; })
    : Promise.resolve();
  const detection = await detector({ http, productUrl: drop.pollUrls?.['pokemon-center'] ?? drop.productUrls?.['pokemon-center'], mode, dropTimeMs: Date.parse(drop.time), clock, signal });
  if (detection.status === 'expired') return { status: 'expired', reason: detection.reason ?? 'watcher-expired' };
  if (!detection.available && detection.status && detection.status !== 'not-in-stock') return { status: detection.status, reason: detection.reason };
  if (!detection.available) return { status: 'missed', reason: 'not-available' };
  await browserReady;
  if (prewarmError) throw prewarmError;
  if (onDetection) return onDetection({ detection, account, session, api, browser, dryRun, env, detectedAt: detection.detectedAt, amount: drop.price });
  return checkout({ product: drop, account, session, api, browser, dryRun, env, detectedAt: detection.detectedAt, amount: drop.price });
}

export function createLane(dependencies = {}) {
  const laneDependencies = {
    ...dependencies,
    api: dependencies.api ?? (dependencies.http?.request
      ? createPokemonCenterApi({ http: dependencies.http, endpoints: config.endpoints })
      : undefined),
  };
  let mode = 'scheduled';
  const scheduledRuns = new Map();
  return {
    warmup: async (input) => {
      if (!scheduledRuns.has(input.drop.id)) scheduledRuns.set(input.drop.id, runLane({ ...laneDependencies, ...input, mode: 'scheduled' }));
      scheduledRuns.get(input.drop.id).catch(() => {});
      return { status: 'warmed' };
    },
    fullThrottle: async () => { mode = 'scheduled'; return { status: 'full-throttle' }; },
    run: (input) => scheduledRuns.get(input.drop.id) ?? runLane({ ...laneDependencies, ...input, mode }),
    watch: (input) => runLane({ ...laneDependencies, ...input, mode: 'surprise' }),
    checkout: (input) => checkoutProduct({ ...laneDependencies, product: input.drop, ...input }),
  };
}
