import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpTransport } from './transports/http.mjs';
import { openWarmedBrowserTransport } from './transports/browser-http.mjs';
import { createStateStore } from './state-store.mjs';
import { createTrafficGovernor } from './rate-limit.mjs';
import { config as pokemonCenterConfig } from './sites/pokemon-center/config.mjs';
import { config as bestBuyConfig } from './sites/bestbuy/config.mjs';
import { config as targetConfig } from './sites/target/config.mjs';
import { config as tcgplayerConfig } from './sites/tcgplayer/config.mjs';
import { loadEnvFile } from './env.mjs';
import { importProductEndpoints } from './product-endpoints.mjs';
import { SITE_HOME_URLS } from './browser-session.mjs';
import { abortableDelay } from './timing.mjs';

export const SITE_CONFIGS = Object.freeze({
  'pokemon-center': pokemonCenterConfig,
  bestbuy: bestBuyConfig,
  target: targetConfig,
  tcgplayer: tcgplayerConfig,
});

function pathValue(value, path) {
  if (!path || !/^[A-Za-z0-9_.\[\]-]+$/.test(path)) throw new Error(`Unsafe or missing inventory field path: ${path ?? ''}`);
  // Support dot-separated keys and array indices: offers[0].availability
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((current, key) => current?.[key], value);
}

function exactCondition(body, condition) {
  const actual = pathValue(body, condition?.path);
  if (actual === undefined) throw new Error(`Measured inventory response is missing ${condition.path}`);
  if (Object.hasOwn(condition, 'equals')) return actual === condition.equals;
  if (Array.isArray(condition?.oneOf)) return condition.oneOf.includes(actual);
  if (condition?.positive === true) return Number(actual) > 0;
  throw new Error(`Inventory condition for ${condition?.path ?? 'unknown'} needs equals, oneOf, or positive`);
}

function optionalField(body, fields, name, transform = (value) => value) {
  const path = fields?.[name];
  if (!path) return undefined;
  const value = pathValue(body, path);
  return value === undefined || value === null ? undefined : transform(value);
}

export function parseMeasuredInventory(response, endpoint, { now = Date.now } = {}) {
  if (Number(response?.status) !== 200) throw new Error(`Inventory scan requires HTTP 200, received ${response?.status ?? 'unknown'}`);
  const body = response.bodyJson;
  if (!body || typeof body !== 'object') throw new Error('Measured inventory response must be structured JSON');
  const contract = endpoint?.metadata?.contract;
  if (!contract?.availableWhen?.length) {
    const error = new Error('Measured endpoint metadata needs contract.availableWhen; no availability shape will be guessed');
    error.code = 'SCALPER_INVENTORY_CONTRACT_UNMEASURED';
    throw error;
  }
  const available = contract.availableWhen.every((condition) => exactCondition(body, condition));
  const fields = contract.fields ?? {};
  const quantity = optionalField(body, fields, 'quantity', Number);
  const rawPrice = optionalField(body, fields, 'priceCents', Number);
  // Prefer the measured unit. The legacy heuristic remains for older contracts,
  // but cannot distinguish an exact-dollar price (for example $130.00) from cents.
  const priceCents = rawPrice === undefined ? undefined
    : contract.priceUnit === 'dollars' ? Math.round(rawPrice * 100)
      : contract.priceUnit === 'cents' ? rawPrice
        : Number.isInteger(rawPrice) ? rawPrice : Math.round(rawPrice * 100);
  if (quantity !== undefined && (!Number.isFinite(quantity) || quantity < 0)) throw new Error('Measured inventory quantity is invalid');
  if (priceCents !== undefined && (!Number.isSafeInteger(priceCents) || priceCents < 0)) throw new Error('Measured inventory priceCents is invalid');
  const observedAt = now();
  const seller = optionalField(body, fields, 'seller', String);
  const policy = endpoint?.metadata?.policy ?? {};
  const maxPriceCents = Number(policy.maxPriceCents);
  const hasPriceCap = Number.isSafeInteger(maxPriceCents) && maxPriceCents >= 0;
  const withinPriceCap = hasPriceCap ? priceCents !== undefined && priceCents <= maxPriceCents : undefined;
  const expectedSeller = policy.sellerEquals;
  const retailSeller = expectedSeller ? seller !== undefined && seller === expectedSeller : undefined;
  const actionable = available
    && (withinPriceCap ?? true)
    && (retailSeller ?? true);
  return {
    productId: endpoint.productId,
    site: endpoint.site,
    source: 'direct-measured-endpoint',
    pollUrl: endpoint.pollUrl,
    observedAt,
    endpointMeasuredAt: endpoint.measuredAt,
    httpStatus: response.status,
    available,
    actionable,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(priceCents !== undefined ? { priceCents } : {}),
    ...(hasPriceCap ? { maxPriceCents, withinPriceCap } : {}),
    ...(expectedSeller ? { retailSeller } : {}),
    ...(['sku', 'seller', 'fulfillment'].flatMap((name) => {
      if (name === 'seller' && seller !== undefined) return [[name, seller]];
      const value = optionalField(body, fields, name, String);
      return value === undefined ? [] : [[name, value]];
    }).reduce((output, [name, value]) => ({ ...output, [name]: value }), {})),
    bodySha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    confidence: endpoint.measuredAt ? 'measured-direct' : 'unversioned-direct',
  };
}

export class InventorySampleStore {
  constructor({ dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper', maxSamples = 500 } = {}) {
    this.dataDir = dataDir;
    this.maxSamples = maxSamples;
  }

  path(site) { return join(this.dataDir, 'detection-samples', `${site}.json`); }

  async read(site) {
    try { return JSON.parse(await readFile(this.path(site), 'utf8')); } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, real: true, site, samples: [] };
      throw error;
    }
  }

  async append(observation, { real = true } = {}) {
    const current = await this.read(observation.site);
    const value = {
      version: 1,
      real: current.real !== false && real,
      site: observation.site,
      updatedAt: observation.observedAt,
      samples: [...(current.samples ?? []), observation].slice(-this.maxSamples),
    };
    const path = this.path(observation.site);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return observation;
  }
}

export class InventoryScanner {
  constructor({
    productEndpoints, httpForSite, samples = new InventorySampleStore(), events,
    now = Date.now, real = true, sleep = abortableDelay, maxGovernanceWaitMs = 30_000,
  } = {}) {
    if (!productEndpoints?.list || !productEndpoints?.get) throw new Error('Inventory scanner requires the measured product endpoint store');
    if (typeof httpForSite !== 'function') throw new Error('Inventory scanner requires a per-site HTTP provider');
    Object.assign(this, { productEndpoints, httpForSite, samples, events, now, real, sleep, maxGovernanceWaitMs });
    this.httpCache = new Map();
  }

  #http(site) {
    if (!this.httpCache.has(site)) this.httpCache.set(site, this.httpForSite(site));
    return this.httpCache.get(site);
  }

  async scan({ productId, site, signal } = {}) {
    const endpoint = await this.productEndpoints.get(productId, site);
    if (!endpoint) {
      const error = new Error(`No measured inventory endpoint for ${site}/${productId}`);
      error.code = 'SCALPER_ENDPOINT_UNMEASURED';
      throw error;
    }
    const startedAt = this.now();
    const response = await this.#http(site).get(endpoint.pollUrl, { signal });
    const observation = {
      ...parseMeasuredInventory(response, endpoint, { now: this.now }),
      latencyMs: Math.max(0, this.now() - startedAt),
    };
    await this.samples.append(observation, { real: this.real });
    await this.events?.record?.('inventory-observation', {
      productId, site, available: observation.available, actionable: observation.actionable,
      quantity: observation.quantity, priceCents: observation.priceCents,
      maxPriceCents: observation.maxPriceCents, withinPriceCap: observation.withinPriceCap,
      retailSeller: observation.retailSeller, latencyMs: observation.latencyMs,
    });
    return observation;
  }

  async scanAll({ site, signal } = {}) {
    const endpoints = await this.productEndpoints.list({ site });
    const observations = [];
    const errors = [];
    // Sequential by design: all products share the retailer token bucket.
    for (const endpoint of endpoints) {
      try {
        let waitedMs = 0;
        while (true) {
          try {
            observations.push(await this.scan({ ...endpoint, signal }));
            break;
          } catch (error) {
            const retryAfterMs = Math.max(1, Number(error?.retryAfterMs) || 1);
            if (error?.code !== 'SCALPER_RATE_LIMITED' || waitedMs + retryAfterMs > this.maxGovernanceWaitMs) throw error;
            await this.sleep(retryAfterMs, { signal });
            waitedMs += retryAfterMs;
          }
        }
      } catch (error) {
        errors.push({ productId: endpoint.productId, site: endpoint.site, code: error.code, message: error.message });
      }
    }
    return { observations, errors };
  }
}

export async function scanInventoryWithConfiguredTransport({
  site,
  accountId = 'default',
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  productEndpoints,
  samples = new InventorySampleStore({ dataDir }),
  events,
  now = Date.now,
  real = true,
  siteConfigs = SITE_CONFIGS,
  bareHttp = createHttpTransport(),
  governor = createTrafficGovernor({ policies: Object.fromEntries(
    Object.entries(siteConfigs).map(([retailer, config]) => [retailer, config.polling]),
  ) }),
  openBrowserTransport = openWarmedBrowserTransport,
} = {}) {
  if (!siteConfigs[site]) throw new Error(`Unsupported inventory scan site: ${site ?? 'missing'}`);
  let warmed;
  try {
    if (siteConfigs[site].wafGated === true) {
      warmed = await openBrowserTransport({
        site,
        accountId,
        dataDir,
        warmUrl: SITE_HOME_URLS[site],
      });
    }
    const scanner = new InventoryScanner({
      productEndpoints,
      httpForSite: (retailer) => governor.httpFor(
        retailer,
        retailer === site && warmed ? warmed.transport : bareHttp,
      ),
      samples,
      events,
      now,
      real,
    });
    return await scanner.scanAll({ site });
  } finally {
    await warmed?.context?.close?.();
  }
}

export async function runInventoryScanCli({
  env = process.env,
  site = process.argv[2],
  accountId = env.SCALPER_INVENTORY_ACCOUNT_ID || process.argv[3] || 'default',
} = {}) {
  await loadEnvFile({ env });
  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  const state = createStateStore({ path: join(dataDir, 'scalper.db'), dataDir });
  await importProductEndpoints({
    store: state.productEndpoints,
    path: env.SCALPER_PRODUCT_ENDPOINTS_PATH || 'config/scalper-product-endpoints.json',
  });
  try {
    return await scanInventoryWithConfiguredTransport({
      site,
      accountId,
      dataDir,
      productEndpoints: state.productEndpoints,
      samples: new InventorySampleStore({ dataDir }),
    });
  } finally {
    state.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await runInventoryScanCli(), null, 2));
}
