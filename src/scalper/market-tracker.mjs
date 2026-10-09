import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rankProducts } from './market-score.mjs';

const KINDS = new Set(['completed-sale', 'market-price', 'active-listing', 'appraisal']);

function fileStorage() {
  return {
    readText: (path) => readFile(path, 'utf8'),
    async appendText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, value, 'utf8');
    },
  };
}

export function validateMarketObservation(value) {
  if (!value?.productId || !value?.source) throw new Error('Market observation requires productId and source');
  if (!KINDS.has(value.kind)) throw new Error(`Unsupported market observation kind: ${value.kind}`);
  if (!Number.isFinite(Number(value.price)) || Number(value.price) <= 0) throw new Error('Market observation price must be positive');
  if (!Number.isFinite(Number(value.at))) throw new Error('Market observation at must be an epoch timestamp');
  if (value.confidence !== undefined && (!Number.isFinite(Number(value.confidence)) || Number(value.confidence) < 0 || Number(value.confidence) > 1)) {
    throw new Error('Market observation confidence must be between 0 and 1');
  }
  if (value.sampleSize !== undefined && (!Number.isFinite(Number(value.sampleSize)) || Number(value.sampleSize) <= 0)) {
    throw new Error('Market observation sampleSize must be positive');
  }
  return {
    ...structuredClone(value),
    price: Number(value.price), at: Number(value.at),
    ...(value.confidence === undefined ? {} : { confidence: Number(value.confidence) }),
    ...(value.sampleSize === undefined ? {} : { sampleSize: Number(value.sampleSize) }),
  };
}

export class MarketObservationStore {
  #mutation = Promise.resolve();

  constructor({ storage = fileStorage(), path = 'data/scalper/market-observations.jsonl' } = {}) {
    this.storage = storage;
    this.path = path;
  }

  append(value) {
    const run = this.#mutation.then(async () => {
      const observation = validateMarketObservation(value);
      await this.storage.appendText(this.path, `${JSON.stringify(observation)}\n`);
      return observation;
    });
    this.#mutation = run.catch(() => {});
    return run;
  }

  async all() {
    let source;
    try { source = await this.storage.readText(this.path); } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return source.split(/\r?\n/).filter(Boolean).map((line) => validateMarketObservation(JSON.parse(line)));
  }
}

export function validateMarketConfig(config) {
  if (config?.version !== 1 || !Array.isArray(config.products) || !config.defaults) {
    throw new Error('Market config must contain version 1, defaults, and products');
  }
  const ids = new Set();
  for (const product of config.products) {
    if (!product?.id || !product?.name) throw new Error('Every market product requires id and name');
    if (ids.has(product.id)) throw new Error(`Duplicate market product id: ${product.id}`);
    ids.add(product.id);
  }
  return structuredClone(config);
}

export class MarketTracker {
  constructor({ config, store = new MarketObservationStore(), sources = [], now = Date.now, logger = console } = {}) {
    this.config = validateMarketConfig(config);
    this.store = store;
    this.sources = sources;
    this.now = now;
    this.logger = logger;
  }

  async capture() {
    const observations = [];
    const errors = [];
    for (const product of this.config.products) {
      for (const source of this.sources) {
        try {
          const quoted = await source.quote(product);
          const values = Array.isArray(quoted) ? quoted : quoted ? [quoted] : [];
          for (const value of values) {
            const observation = await this.store.append({
              ...value,
              productId: product.id,
              source: value.source ?? source.id,
              at: value.at ?? this.now(),
            });
            observations.push(observation);
          }
        } catch (error) {
          const failure = { productId: product.id, source: source.id, error: error.message };
          errors.push(failure);
          this.logger?.warn?.('Market source failed', failure);
        }
      }
    }
    return { capturedAt: this.now(), observations, errors };
  }

  async rank() {
    return rankProducts(this.config.products, await this.store.all(), this.config.defaults, this.now());
  }
}

export async function loadMarketConfig({ path = 'config/scalper-market.json', readText = (value) => readFile(value, 'utf8') } = {}) {
  return validateMarketConfig(JSON.parse(await readText(path)));
}
