import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DropCalendar } from './drop-calendar.mjs';

function fileStorage() {
  return {
    async appendText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, value, 'utf8');
    },
  };
}

export function isLiveMode(env = process.env) {
  return env.SCALPER_LIVE === '1';
}

export class DryRunHarness {
  #storage;
  #orderLogPath;
  #env;
  #now;

  constructor({ storage = fileStorage(), orderLogPath, env = process.env, now = Date.now } = {}) {
    this.#storage = storage;
    this.#orderLogPath = orderLogPath ?? join(env.SCALPER_DATA_DIR || 'data/scalper', 'paper-orders.jsonl');
    this.#env = env;
    this.#now = now;
  }

  isLive() {
    return isLiveMode(this.#env);
  }

  async runPipeline({ detect, ...order } = {}) {
    if (typeof detect !== 'function') throw new Error('Dry-run pipeline requires an injected detector');
    const detection = await detect();
    if (!detection?.available) return { status: 'not-detected', detection };
    return this.execute({ ...order, detectedAt: detection.detectedAt ?? this.#now() });
  }

  async execute({ site, product, account, amount, detectedAt, liveCheckout } = {}) {
    if (this.isLive()) {
      if (typeof liveCheckout !== 'function') throw new Error('Live mode requires an explicit liveCheckout function');
      return liveCheckout();
    }
    if (!site || !product || !account) throw new Error('Paper orders require site, product, and account');
    const timestamp = this.#now();
    const order = {
      timestamp,
      site,
      product: typeof product === 'string' ? product : product.id ?? product.name,
      account: typeof account === 'string' ? account : account.id,
      simulatedLatencyMs: Math.max(0, timestamp - (detectedAt ?? timestamp)),
      wouldHavePaid: Number(amount ?? 0),
      status: 'paper-confirmed',
    };
    await this.#storage.appendText(this.#orderLogPath, `${JSON.stringify(order)}\n`);
    return { status: 'paper-confirmed', order };
  }
}

export function createDryRunHarness(options) {
  return new DryRunHarness(options);
}

export async function runConfiguredDryRun({ calendar = new DropCalendar(), env = process.env, dryRun = new DryRunHarness({ env }), orchestrator } = {}) {
  if (isLiveMode(env)) throw new Error('scalper:dry refuses to run while SCALPER_LIVE=1');
  const drops = await calendar.allDrops();
  const drop = drops.find((item) => !['purchased', 'cancelled'].includes(item.status));
  if (!drop) return { status: 'no-configured-drops' };
  if (orchestrator?.runDrop) return orchestrator.runDrop(drop);
  const site = drop.sites[0];
  const account = { id: `paper-${site}` };
  return dryRun.execute({ site, product: drop, account, amount: drop.price ?? 0, detectedAt: Date.now() });
}
