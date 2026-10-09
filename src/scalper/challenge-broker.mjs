import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SqliteHumanChallengeBroker } from './state-store.mjs';

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

function clone(challenge) {
  return structuredClone(challenge);
}

export class HumanChallengeBroker {
  #storage;
  #path;
  #alerts;
  #now;
  #id;
  #schedule;
  #cancelSchedule;
  #logger;
  #mutation = Promise.resolve();
  #waiters = new Map();

  constructor(options = {}) {
    if (options.database) return new SqliteHumanChallengeBroker(options);
    const {
      storage = fileStorage(), path = 'data/scalper/challenges.json', alerts, now = Date.now,
      id = randomUUID, schedule = setTimeout, cancelSchedule = clearTimeout, logger = console,
    } = options;
    this.#storage = storage;
    this.#path = path;
    this.#alerts = alerts;
    this.#now = now;
    this.#id = id;
    this.#schedule = schedule;
    this.#cancelSchedule = cancelSchedule;
    this.#logger = logger;
  }

  async #read() {
    try {
      const document = JSON.parse(await this.#storage.readText(this.#path));
      if (!document || document.version !== 1 || !Array.isArray(document.challenges)) {
        throw new Error('Challenge store must contain version 1 and a challenges array');
      }
      return document;
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, challenges: [] };
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

  async list({ status, limit = 100 } = {}) {
    return structuredClone((await this.#read()).challenges
      .filter((challenge) => !status || challenge.status === status)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit));
  }

  async get(id) {
    const challenge = (await this.#read()).challenges.find((item) => item.id === id);
    return challenge ? clone(challenge) : null;
  }

  async request({ taskId, site, kind = 'verification', message, url, timeoutMs = 10 * 60_000 } = {}) {
    if (!taskId || !site) throw new Error('Human challenge requires taskId and site');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Human challenge timeout must be positive');
    const challenge = await this.#mutate((document) => {
      const existing = [...document.challenges].reverse()
        .find((item) => item.taskId === taskId && item.status === 'pending');
      if (existing) return clone(existing);
      const createdAt = this.#now();
      const next = {
        id: this.#id(), taskId, site, kind,
        message: String(message || `Complete ${kind} in the open Chrome window`).slice(0, 500),
        ...(url ? { url: String(url).slice(0, 2_000) } : {}),
        status: 'pending', createdAt, updatedAt: createdAt,
        expiresAt: createdAt + timeoutMs,
      };
      document.challenges.push(next);
      return clone(next);
    });

    const active = this.#waiters.get(challenge.id);
    if (active) return active.promise;
    try {
      await this.#alerts?.challengeRequired?.(challenge);
    } catch (error) {
      this.#logger?.warn?.('Challenge alert delivery failed', error);
    }

    const waiter = {};
    const promise = new Promise((resolve, reject) => {
      const timeout = this.#schedule(async () => {
        this.#waiters.delete(challenge.id);
        try {
          await this.#finish(challenge.id, 'expired', { actor: 'timeout' });
        } finally {
          const error = new Error(`Human challenge ${challenge.id} expired`);
          error.code = 'SCALPER_CHALLENGE_TIMEOUT';
          reject(error);
        }
      }, timeoutMs);
      timeout?.unref?.();
      Object.assign(waiter, { resolve, reject, timeout });
    });
    waiter.promise = promise;
    this.#waiters.set(challenge.id, waiter);
    return promise;
  }

  #finish(id, status, details = {}) {
    return this.#mutate((document) => {
      const challenge = document.challenges.find((item) => item.id === id);
      if (!challenge) throw new Error(`Unknown human challenge: ${id}`);
      if (challenge.status !== 'pending') return clone(challenge);
      challenge.status = status;
      challenge.updatedAt = this.#now();
      challenge.resolution = {
        actor: String(details.actor ?? 'operator').slice(0, 100),
        ...(details.note ? { note: String(details.note).slice(0, 500) } : {}),
      };
      return clone(challenge);
    });
  }

  async resume(id, details = {}) {
    const waiter = this.#waiters.get(id);
    if (!waiter) {
      const challenge = await this.get(id);
      const error = new Error(challenge?.status === 'pending'
        ? `Human challenge ${id} belongs to an inactive process and cannot be resumed`
        : `Human challenge ${id} is not active`);
      error.code = 'SCALPER_CHALLENGE_NOT_ACTIVE';
      throw error;
    }
    const challenge = await this.#finish(id, 'resumed', details);
    this.#waiters.delete(id);
    this.#cancelSchedule(waiter.timeout);
    waiter.resolve(challenge);
    return challenge;
  }

  async cancel(id, details = {}) {
    const waiter = this.#waiters.get(id);
    const challenge = await this.#finish(id, 'cancelled', details);
    if (waiter) {
      this.#waiters.delete(id);
      this.#cancelSchedule(waiter.timeout);
      const error = new Error(`Human challenge ${id} was cancelled`);
      error.code = 'SCALPER_CHALLENGE_CANCELLED';
      waiter.reject(error);
    }
    return challenge;
  }

  async expireInactive() {
    const pending = await this.list({ status: 'pending' });
    const expired = [];
    for (const challenge of pending) {
      if (!this.#waiters.has(challenge.id)) {
        expired.push(await this.#finish(challenge.id, 'expired', { actor: 'process-restart' }));
      }
    }
    return expired;
  }
}

export function createHumanChallengeBroker(options) {
  return new HumanChallengeBroker(options);
}
