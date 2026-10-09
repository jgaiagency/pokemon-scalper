import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isLiveMode } from './dry-run.mjs';
import { scoreProduct } from './market-score.mjs';
import { SqlitePurchaseLedger } from './state-store.mjs';

function fileStorage() {
  return {
    readText: (path) => readFile(path, 'utf8'),
    async writeText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

function positiveNumber(value, fallback = Infinity) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class PurchaseLedger {
  #storage;
  #path;
  #now;
  #id;
  #mutation = Promise.resolve();

  constructor(options = {}) {
    if (options.database) return new SqlitePurchaseLedger(options);
    const { storage = fileStorage(), path = 'data/scalper/purchase-ledger.json', now = Date.now, id = randomUUID } = options;
    this.#storage = storage;
    this.#path = path;
    this.#now = now;
    this.#id = id;
  }

  async #read() {
    try {
      const parsed = JSON.parse(await this.#storage.readText(this.#path));
      if (!parsed || !Array.isArray(parsed.records)) throw new Error('Purchase ledger must contain a records array');
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, records: [] };
      throw error;
    }
  }

  #mutate(operation) {
    const run = this.#mutation.then(async () => {
      const data = await this.#read();
      const result = await operation(data);
      await this.#storage.writeText(this.#path, `${JSON.stringify(data, null, 2)}\n`);
      return result;
    });
    this.#mutation = run.catch(() => {});
    return run;
  }

  reserve({ key, site, product, amount = 0, quantity = 1, account, dayStart, dailyLimit = Infinity } = {}) {
    if (!key) return Promise.reject(new Error('Purchase reservation key is required'));
    return this.#mutate((data) => {
      const existing = [...data.records].reverse().find((record) => record.key === key && ['reserved', 'purchased', 'uncertain'].includes(record.status));
      if (existing) return {
        ok: false,
        reason: existing.status === 'purchased' ? 'already-purchased' : existing.status === 'uncertain' ? 'order-uncertain' : 'already-reserved',
        record: structuredClone(existing),
      };
      const committed = data.records
        .filter((record) => ['reserved', 'purchased', 'uncertain'].includes(record.status) && (dayStart === undefined || record.updatedAt >= dayStart))
        .reduce((total, record) => total + record.amount * record.quantity, 0);
      const requested = (Number(amount) || 0) * (Number(quantity) || 1);
      if (committed + requested > dailyLimit) return { ok: false, reason: 'daily-limit', committed, requested, limit: dailyLimit };
      const reservation = {
        id: this.#id(), key, site, product,
        ...((account?.id ?? account) === undefined ? {} : { account: account?.id ?? account }),
        amount: Number(amount) || 0, quantity: Number(quantity) || 1,
        status: 'reserved', createdAt: this.#now(), updatedAt: this.#now(),
      };
      data.records.push(reservation);
      return { ok: true, reservation: structuredClone(reservation) };
    });
  }

  #finish(id, status, details) {
    return this.#mutate((data) => {
      const record = data.records.find((item) => item.id === id);
      if (!record) throw new Error(`Unknown purchase reservation: ${id}`);
      Object.assign(record, details, { status, updatedAt: this.#now() });
      return structuredClone(record);
    });
  }

  complete(id, details = {}) {
    return this.#finish(id, 'purchased', details);
  }

  fail(id, details = {}) {
    return this.#finish(id, 'failed', details);
  }

  uncertain(id, details = {}) {
    return this.#finish(id, 'uncertain', details);
  }

  release(id, details = {}) {
    return this.#mutate((data) => {
      const record = data.records.find((item) => item.id === id);
      if (!record) throw new Error(`Unknown purchase reservation: ${id}`);
      if (!['reserved', 'uncertain'].includes(record.status)) throw new Error(`Only reserved or uncertain purchases can be released; ${id} is ${record.status}`);
      Object.assign(record, details, { status: 'released', updatedAt: this.#now() });
      return structuredClone(record);
    });
  }

  async spentSince(timestamp) {
    const data = await this.#read();
    return data.records
      .filter((record) => ['purchased', 'uncertain'].includes(record.status) && record.updatedAt >= timestamp)
      .reduce((total, record) => total + record.amount * record.quantity, 0);
  }

  async records() {
    return structuredClone((await this.#read()).records);
  }
}

export class SafetyPolicy {
  constructor({
    env = process.env,
    ledger,
    now = Date.now,
    killSwitchPath = join(env.SCALPER_DATA_DIR || 'data/scalper', 'KILL_SWITCH'),
    killSwitchExists = async () => access(killSwitchPath).then(() => true, () => false),
    scorer = scoreProduct,
    observations = [],
    marketDefaults = {},
    marketMaxAgeMs = positiveNumber(env.SCALPER_MARKET_MAX_AGE_MS, 24 * 60 * 60_000),
  } = {}) {
    this.env = env;
    this.ledger = ledger;
    this.now = now;
    this.killSwitchExists = killSwitchExists;
    this.scorer = scorer;
    this.observations = observations;
    this.marketDefaults = marketDefaults;
    this.marketMaxAgeMs = marketMaxAgeMs;
  }

  async #checkProfitability({ drop, product = drop, amount } = {}) {
    const timestamp = this.now();
    const values = typeof this.observations === 'function'
      ? await this.observations({ drop, product, now: timestamp })
      : await this.observations;
    const cutoff = timestamp - this.marketMaxAgeMs;
    const fresh = (Array.isArray(values) ? values : [])
      .filter((observation) => Number.isFinite(Number(observation?.at)) && Number(observation.at) >= cutoff);
    const candidate = {
      ...(product ?? {}),
      id: product?.id ?? drop?.id,
      name: product?.name ?? drop?.name ?? product?.id ?? drop?.id,
      acquisitionPrice: product?.acquisitionPrice ?? drop?.acquisitionPrice ?? amount,
    };
    const score = candidate.id ? await this.scorer(candidate, fresh, this.marketDefaults, timestamp) : null;
    const missingEvidence = !score || score.risks?.includes('missing-market-evidence');
    if (missingEvidence && this.env.SCALPER_ALLOW_UNSCORED === '1') {
      return { allowed: true, profitability: score, profitabilityBypass: 'unscored' };
    }
    if (!score?.eligible) return { allowed: false, live: true, reason: 'profitability', profitability: score };
    return { allowed: true, profitability: score };
  }

  async authorize(input = {}) {
    const { amount, quantity = 1 } = input;
    if (!isLiveMode(this.env)) return { allowed: true, live: false, reason: 'paper-mode' };
    if (this.env.SCALPER_KILL_SWITCH === '1' || await this.killSwitchExists()) {
      return { allowed: false, live: true, reason: 'kill-switch' };
    }
    const required = ['SCALPER_MAX_ORDER_USD', 'SCALPER_MAX_DAILY_SPEND_USD', 'SCALPER_MAX_QUANTITY'];
    const missing = required.filter((key) => !Number.isFinite(Number(this.env[key])) || Number(this.env[key]) <= 0);
    if (missing.length) return { allowed: false, live: true, reason: 'safety-unconfigured', missing };
    const count = Number(quantity);
    const maxQuantity = positiveNumber(this.env.SCALPER_MAX_QUANTITY);
    if (!Number.isFinite(count) || count <= 0) return { allowed: false, live: true, reason: 'quantity-invalid' };
    if (count > maxQuantity) return { allowed: false, live: true, reason: 'quantity-limit', quantity: count, limit: maxQuantity };
    const unitAmount = amount === null || amount === '' || amount === undefined ? NaN : Number(amount);
    if (!Number.isFinite(unitAmount) || unitAmount < 0) {
      if (this.env.SCALPER_ALLOW_UNKNOWN_PRICE !== '1') return { allowed: false, live: true, reason: 'price-unknown' };
    }
    const total = Number.isFinite(unitAmount) ? unitAmount * count : 0;
    const maxOrder = positiveNumber(this.env.SCALPER_MAX_ORDER_USD);
    if (total > maxOrder) return { allowed: false, live: true, reason: 'order-limit', total, limit: maxOrder };
    const maxDaily = positiveNumber(this.env.SCALPER_MAX_DAILY_SPEND_USD);
    const date = new Date(this.now());
    const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const spent = this.ledger ? await this.ledger.spentSince(dayStart) : 0;
    if (spent + total > maxDaily) return { allowed: false, live: true, reason: 'daily-limit', total, spent, limit: maxDaily };
    const profitability = await this.#checkProfitability({ ...input, amount: unitAmount });
    if (!profitability.allowed) return profitability;
    return {
      allowed: true, live: true, total, quantity: count, spent, dayStart, dailyLimit: maxDaily,
      profitability: profitability.profitability,
      ...(profitability.profitabilityBypass ? { profitabilityBypass: profitability.profitabilityBypass } : {}),
    };
  }

  recheckAtCommit(input = {}) {
    return this.authorize(input);
  }
}
