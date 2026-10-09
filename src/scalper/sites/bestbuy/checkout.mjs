import { isLiveMode } from '../../dry-run.mjs';
import { config } from './config.mjs';

export async function checkoutProduct({ product, account, session, amount, detectedAt, env = process.env, dryRun, browser, taskId, onProgress, beforeCommit } = {}) {
  const live = isLiveMode(env);
  if (!live) {
    if (!dryRun?.execute) throw new Error('Paper checkout requires the dry-run harness');
    return dryRun.execute({ site: config.id, product, account, amount, detectedAt });
  }
  if (!browser?.checkout) throw new Error('No measured Best Buy browser checkout adapter is configured');
  return browser.checkout({ site: config.id, live: true, product, account, session, taskId, onProgress, beforeCommit, ...config.browser });
}

export function createCheckout(dependencies) { return (input) => checkoutProduct({ ...dependencies, ...input }); }
