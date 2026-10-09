import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SqlitePurchaseTaskStore } from './state-store.mjs';

export const TASK_STATES = Object.freeze([
  'queued',
  'detected',
  'authorized',
  'launching',
  'navigating',
  'carting',
  'checkout',
  'awaiting-human',
  'resuming',
  'retrying',
  'submitting',
  'confirming',
  'purchased',
  'paper-confirmed',
  'blocked',
  'failed',
  'uncertain',
  'cancelled',
]);

export const TERMINAL_TASK_STATES = new Set([
  'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled',
]);

const EXECUTION_STATES = new Set([
  'authorized', 'launching', 'navigating', 'carting', 'checkout',
  'awaiting-human', 'resuming', 'retrying', 'submitting', 'confirming',
]);

const TRANSITIONS = Object.freeze({
  queued: new Set(['detected', 'cancelled']),
  detected: new Set(['authorized', 'blocked', 'failed', 'cancelled']),
  authorized: new Set(['launching', 'navigating', 'carting', 'checkout', 'awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  launching: new Set(['navigating', 'carting', 'checkout', 'awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  navigating: new Set(['carting', 'checkout', 'awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  carting: new Set(['checkout', 'awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  checkout: new Set(['awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  'awaiting-human': new Set(['resuming', 'retrying', 'failed', 'cancelled']),
  resuming: new Set(['launching', 'navigating', 'carting', 'checkout', 'awaiting-human', 'retrying', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  retrying: new Set(['launching', 'navigating', 'carting', 'checkout', 'awaiting-human', 'submitting', 'confirming', 'purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']),
  submitting: new Set(['awaiting-human', 'confirming', 'purchased', 'paper-confirmed', 'failed', 'uncertain', 'cancelled']),
  confirming: new Set(['awaiting-human', 'purchased', 'paper-confirmed', 'failed', 'uncertain', 'cancelled']),
});

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

function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSensitive(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/pass(word)?|secret|token|card|cvv|cookie|authorization/i.test(key)) output[key] = '[redacted]';
    else output[key] = redactSensitive(item, seen);
  }
  return output;
}

function validateDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.tasks)) {
    throw new Error('Purchase task store must contain version 1 and a tasks array');
  }
  return value;
}

function validateState(state) {
  if (!TASK_STATES.includes(state)) throw new Error(`Unsupported purchase task state: ${state}`);
}

export class PurchaseTaskStore {
  #storage;
  #path;
  #now;
  #id;
  #mutation = Promise.resolve();

  constructor(options = {}) {
    if (options.database) return new SqlitePurchaseTaskStore(options);
    const {
      storage = fileStorage(), path = 'data/scalper/purchase-tasks.json', now = Date.now, id = randomUUID,
    } = options;
    this.#storage = storage;
    this.#path = path;
    this.#now = now;
    this.#id = id;
  }

  async #read() {
    try {
      return validateDocument(JSON.parse(await this.#storage.readText(this.#path)));
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, tasks: [] };
      throw error;
    }
  }

  #mutate(operation) {
    const run = this.#mutation.then(async () => {
      const document = await this.#read();
      const result = await operation(document);
      await this.#storage.writeText(this.#path, `${JSON.stringify(document, null, 2)}\n`);
      return result;
    });
    this.#mutation = run.catch(() => {});
    return run;
  }

  async get(id) {
    const task = (await this.#read()).tasks.find((item) => item.id === id);
    return task ? structuredClone(task) : null;
  }

  async list({ states, site, limit = 200 } = {}) {
    const allowed = states ? new Set(states) : null;
    return structuredClone((await this.#read()).tasks
      .filter((task) => (!allowed || allowed.has(task.state)) && (!site || task.site === site))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit));
  }

  async recoverable() {
    return this.list({ states: TASK_STATES.filter((state) => !TERMINAL_TASK_STATES.has(state)) });
  }

  ensure({ key, site, product, dropId = product, account, state = 'detected', details = {} } = {}) {
    if (!key || !site || !product) return Promise.reject(new Error('Purchase task requires key, site, and product'));
    validateState(state);
    return this.#mutate((document) => {
      const existing = [...document.tasks].reverse().find((task) => task.key === key);
      if (existing) return { created: false, task: structuredClone(existing) };
      const timestamp = this.#now();
      const task = {
        id: this.#id(),
        key,
        site,
        product,
        dropId,
        ...(account ? { account: account?.id ?? account } : {}),
        state,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        events: [{ state, at: timestamp, details: redactSensitive(details) }],
      };
      document.tasks.push(task);
      return { created: true, task: structuredClone(task) };
    });
  }

  transition(id, state, { expectedRevision, details = {} } = {}) {
    validateState(state);
    return this.#mutate((document) => {
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error(`Unknown purchase task: ${id}`);
      if (expectedRevision !== undefined && task.revision !== expectedRevision) {
        const error = new Error(`Purchase task revision conflict: expected ${expectedRevision}, received ${task.revision}`);
        error.code = 'SCALPER_TASK_REVISION_CONFLICT';
        throw error;
      }
      if (task.state === state) return structuredClone(task);
      if (TERMINAL_TASK_STATES.has(task.state)) {
        throw new Error(`Purchase task ${id} is terminal in state ${task.state}`);
      }
      const allowed = TRANSITIONS[task.state] ?? new Set();
      if (!allowed.has(state)) throw new Error(`Invalid purchase task transition: ${task.state} -> ${state}`);
      const timestamp = this.#now();
      task.state = state;
      task.revision += 1;
      task.updatedAt = timestamp;
      task.events.push({ state, at: timestamp, details: redactSensitive(details) });
      if (task.events.length > 100) task.events.splice(0, task.events.length - 100);
      return structuredClone(task);
    });
  }

  reconcile(id, outcome, details = {}) {
    if (!['purchased', 'failed'].includes(outcome)) return Promise.reject(new Error('Task reconciliation outcome must be purchased or failed'));
    return this.#mutate((document) => {
      const task = document.tasks.find((item) => item.id === id);
      if (!task) throw new Error(`Unknown purchase task: ${id}`);
      if (task.state !== 'uncertain') throw new Error(`Only an uncertain purchase task can be reconciled; ${id} is ${task.state}`);
      const timestamp = this.#now();
      task.state = outcome;
      task.revision += 1;
      task.updatedAt = timestamp;
      task.events.push({ state: outcome, at: timestamp, details: redactSensitive({ ...details, reconciled: true }) });
      return structuredClone(task);
    });
  }

  async markInterrupted({ olderThanMs = 5 * 60_000 } = {}) {
    const cutoff = this.#now() - olderThanMs;
    const candidates = (await this.recoverable())
      .filter((task) => EXECUTION_STATES.has(task.state) && task.updatedAt <= cutoff);
    const updated = [];
    for (const task of candidates) {
      updated.push(await this.transition(task.id, 'uncertain', {
        expectedRevision: task.revision,
        details: { reason: 'process-interrupted' },
      }));
    }
    return updated;
  }
}

export function createPurchaseTaskStore(options) {
  return new PurchaseTaskStore(options);
}
