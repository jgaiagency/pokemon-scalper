import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SqliteDropCalendar } from './state-store.mjs';

export const SUPPORTED_SITES = Object.freeze(['pokemon-center', 'tcgplayer', 'bestbuy', 'target']);
const TERMINAL_STATUSES = new Set(['purchased', 'paper-confirmed', 'missed', 'cancelled']);

function fileStorage() {
  return {
    readText: (path) => readFile(path, 'utf8'),
    async writeText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, value, 'utf8');
      await rename(temporary, path);
    },
  };
}

export function validateDrop(drop) {
  if (!drop || typeof drop !== 'object') throw new TypeError('drop must be an object');
  if (!drop.id || typeof drop.id !== 'string') throw new Error('drop.id is required');
  if (!drop.name || typeof drop.name !== 'string') throw new Error('drop.name is required');
  if (!Array.isArray(drop.sites) || drop.sites.length === 0) throw new Error('drop.sites must not be empty');
  for (const site of drop.sites) {
    if (!SUPPORTED_SITES.includes(site)) throw new Error(`unsupported site: ${site}`);
  }
  if (!['scheduled', 'surprise'].includes(drop.type)) throw new Error('drop.type must be scheduled or surprise');
  if (typeof drop.time !== 'string' || !Number.isFinite(Date.parse(drop.time))) throw new Error('drop.time must be a valid ISO timestamp');
  for (const field of ['productUrls', 'pollUrls', 'checkoutUrls']) {
    if (drop[field] !== undefined && (drop[field] === null || typeof drop[field] !== 'object' || Array.isArray(drop[field]))) {
      throw new Error(`drop.${field} must be an object`);
    }
  }
  if (drop.skus !== undefined && (drop.skus === null || typeof drop.skus !== 'object' || Array.isArray(drop.skus))) {
    throw new Error('drop.skus must be an object');
  }
  return structuredClone(drop);
}

export class DropCalendar {
  #storage;
  #path;
  #now;
  #mutation = Promise.resolve();

  constructor(options = {}) {
    if (options.database) return new SqliteDropCalendar({ ...options, validate: validateDrop });
    const { storage = fileStorage(), path = 'config/scalper-drops.json', now = Date.now } = options;
    this.#storage = storage;
    this.#path = path;
    this.#now = now;
  }

  async #read() {
    let raw;
    try {
      raw = await this.#storage.readText(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { drops: [] };
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.drops)) throw new Error('Drop calendar must contain a drops array');
    return { ...parsed, drops: parsed.drops.map(validateDrop) };
  }

  async allDrops() {
    return (await this.#read()).drops.map((drop) => structuredClone(drop));
  }

  async upcomingDrops(withinMs) {
    if (!Number.isFinite(withinMs) || withinMs < 0) throw new RangeError('withinMs must be non-negative');
    const now = this.#now();
    return (await this.allDrops())
      .filter((drop) => !TERMINAL_STATUSES.has(drop.status) && Date.parse(drop.time) >= now && Date.parse(drop.time) <= now + withinMs)
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }

  async dropById(id) {
    return (await this.allDrops()).find((drop) => drop.id === id) ?? null;
  }

  async #mutate(mutator) {
    const run = this.#mutation.then(async () => {
      const data = await this.#read();
      const result = await mutator(data);
      await this.#storage.writeText(this.#path, `${JSON.stringify(data, null, 2)}\n`);
      return result;
    });
    this.#mutation = run.catch(() => {});
    return run;
  }

  async upsertDrop(value) {
    const drop = validateDrop(value);
    return this.#mutate((data) => {
      const index = data.drops.findIndex((item) => item.id === drop.id);
      if (index === -1) data.drops.push(drop);
      else data.drops[index] = { ...data.drops[index], ...drop };
      return structuredClone(index === -1 ? drop : data.drops[index]);
    });
  }

  async markResult(id, status, details = {}) {
    return this.#mutate((data) => {
      const drop = data.drops.find((item) => item.id === id);
      if (!drop) throw new Error(`Unknown drop: ${id}`);
      Object.assign(drop, details, { status, updatedAt: new Date(this.#now()).toISOString() });
      return structuredClone(drop);
    });
  }
}

export function createDropCalendar(options) {
  return new DropCalendar(options);
}
