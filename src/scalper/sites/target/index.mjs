import { pollForAvailability } from './detect.mjs';
import { checkoutProduct } from './checkout.mjs';
import { isLiveMode } from '../../dry-run.mjs';

export async function runLane({ drop, account, sessionManager, http, browser, dryRun, clock, signal, env = process.env, mode = drop?.type ?? 'surprise', onDetection, detector = pollForAvailability, checkout = checkoutProduct } = {}) {
  if (!drop || !account || !sessionManager) throw new Error('Target lane requires drop, account, and sessionManager');
  const session = await sessionManager.ensure(account);
  let prewarmError;
  const browserReady = isLiveMode(env) && browser?.prewarm
    ? browser.prewarm({ site: 'target', product: drop, account, session, live: true }).catch((error) => { prewarmError = error; })
    : Promise.resolve();
  const detection = await detector({ http, productUrl: drop.pollUrls?.target ?? drop.productUrls?.target, mode, dropTimeMs: Date.parse(drop.time), clock, signal });
  if (detection.status === 'expired') return { status: 'expired', reason: detection.reason ?? 'watcher-expired' };
  if (!detection.available && detection.status && detection.status !== 'not-in-stock') return { status: detection.status, reason: detection.reason };
  if (!detection.available) return { status: 'missed', reason: 'not-available' };
  await browserReady;
  if (prewarmError) throw prewarmError;
  if (onDetection) return onDetection({ detection, account, session, browser, dryRun, env, detectedAt: detection.detectedAt, amount: drop.price });
  return checkout({ product: drop, account, session, browser, dryRun, env, detectedAt: detection.detectedAt, amount: drop.price });
}

export function createLane(dependencies = {}) {
  const scheduledRuns = new Map();
  return {
    warmup: async (input) => {
      if (!scheduledRuns.has(input.drop.id)) scheduledRuns.set(input.drop.id, runLane({ ...dependencies, ...input, mode: 'scheduled' }));
      scheduledRuns.get(input.drop.id).catch(() => {});
      return { status: 'warmed' };
    },
    fullThrottle: async () => ({ status: 'full-throttle' }),
    run: (input) => scheduledRuns.get(input.drop.id) ?? runLane({ ...dependencies, ...input, mode: 'scheduled' }),
    watch: (input) => runLane({ ...dependencies, ...input, mode: 'surprise' }),
    checkout: (input) => checkoutProduct({ ...dependencies, product: input.drop, ...input }),
  };
}
