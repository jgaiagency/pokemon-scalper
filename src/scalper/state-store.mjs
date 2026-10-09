import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { openScalperDatabase, SCHEMA_VERSION } from './db.mjs';
import { isRetailerUrl } from './retail-url-policy.mjs';

export const SQLITE_TASK_STATES = Object.freeze([
  'queued', 'detected', 'authorized', 'launching', 'navigating', 'carting', 'checkout',
  'awaiting-human', 'resuming', 'retrying', 'submitting', 'confirming', 'purchased',
  'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled',
]);

export const SQLITE_TERMINAL_TASK_STATES = new Set([
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

const json = (value, fallback = {}) => {
  if (value === null || value === undefined || value === '') return structuredClone(fallback);
  try { return JSON.parse(value); } catch { return structuredClone(fallback); }
};
const dollarsToCents = (value) => Math.round((Number(value) || 0) * 100);
const centsToDollars = (value) => Number(value) / 100;

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

function taskFromRow(database, row) {
  if (!row) return null;
  const events = database.prepare('SELECT state, at, details_json FROM task_events WHERE task_id = ? ORDER BY id').all(row.id)
    .map((event) => ({ state: event.state, at: Number(event.at), details: json(event.details_json) }));
  return {
    id: row.id, key: row.key, site: row.site, product: row.product,
    dropId: row.drop_id ?? row.product,
    ...(row.account ? { account: row.account } : {}),
    state: row.state, revision: Number(row.revision),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), events,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner, leaseExpiresAt: Number(row.lease_expires_at) } : {}),
  };
}

function reservationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, key: row.key, site: row.site, product: row.product,
    ...(row.account ? { account: row.account } : {}),
    amount: centsToDollars(row.amount_cents), quantity: Number(row.quantity), status: row.status,
    ...(row.order_id ? { orderId: row.order_id } : {}),
    ...json(row.details_json),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function assertTaskState(state) {
  if (!SQLITE_TASK_STATES.includes(state)) throw new Error(`Unsupported purchase task state: ${state}`);
}

function transitionTaskSync(database, id, state, { expectedRevision, details = {}, leaseOwner, now }) {
  assertTaskState(state);
  const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) throw new Error(`Unknown purchase task: ${id}`);
  if (expectedRevision !== undefined && Number(task.revision) !== expectedRevision) {
    const error = new Error(`Purchase task revision conflict: expected ${expectedRevision}, received ${task.revision}`);
    error.code = 'SCALPER_TASK_REVISION_CONFLICT';
    throw error;
  }
  if (task.lease_owner && Number(task.lease_expires_at) > now && task.lease_owner !== leaseOwner) {
    const error = new Error(`Purchase task ${id} is leased by another process`);
    error.code = 'SCALPER_TASK_LEASED';
    throw error;
  }
  if (task.state === state) return taskFromRow(database, task);
  if (SQLITE_TERMINAL_TASK_STATES.has(task.state)) throw new Error(`Purchase task ${id} is terminal in state ${task.state}`);
  if (!(TRANSITIONS[task.state] ?? new Set()).has(state)) throw new Error(`Invalid purchase task transition: ${task.state} -> ${state}`);
  database.prepare('UPDATE tasks SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(state, now, id);
  database.prepare('INSERT INTO task_events (task_id, state, at, details_json) VALUES (?, ?, ?, ?)')
    .run(id, state, now, JSON.stringify(redactSensitive(details)));
  return taskFromRow(database, database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

function reserveSync(database, input, now, id) {
  if (!input.key) throw new Error('Purchase reservation key is required');
  const existing = database.prepare(`SELECT * FROM reservations
    WHERE key = ? AND status IN ('reserved', 'purchased', 'uncertain') ORDER BY updated_at DESC LIMIT 1`).get(input.key);
  if (existing) return {
    ok: false,
    reason: existing.status === 'purchased' ? 'already-purchased' : existing.status === 'uncertain' ? 'order-uncertain' : 'already-reserved',
    record: reservationFromRow(existing),
  };
  const amountCents = dollarsToCents(input.amount);
  const quantity = Number(input.quantity) || 1;
  const committed = database.prepare(`SELECT COALESCE(SUM(amount_cents * quantity), 0) AS cents FROM reservations
    WHERE status IN ('reserved', 'purchased', 'uncertain') AND updated_at >= ?`).get(input.dayStart ?? 0).cents;
  const requestedCents = amountCents * quantity;
  const dailyLimitCents = Number.isFinite(input.dailyLimit) ? dollarsToCents(input.dailyLimit) : Infinity;
  if (Number(committed) + requestedCents > dailyLimitCents) {
    return { ok: false, reason: 'daily-limit', committed: centsToDollars(committed), requested: centsToDollars(requestedCents), limit: input.dailyLimit };
  }
  const reservation = {
    id: id(), key: input.key, site: input.site, product: input.product,
    account: input.account?.id ?? input.account, amountCents, quantity,
  };
  database.prepare(`INSERT INTO reservations
    (id, key, site, product, account, amount_cents, quantity, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
    .run(reservation.id, reservation.key, reservation.site ?? null, reservation.product ?? null, reservation.account ?? null,
      reservation.amountCents, reservation.quantity, now, now);
  return { ok: true, reservation: reservationFromRow(database.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id)) };
}

function finishReservationSync(database, id, status, details, now) {
  const existing = database.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  if (!existing) throw new Error(`Unknown purchase reservation: ${id}`);
  const orderId = details.orderId ?? existing.order_id ?? null;
  const merged = { ...json(existing.details_json), ...details };
  delete merged.orderId;
  delete merged.status;
  database.prepare('UPDATE reservations SET status = ?, order_id = ?, details_json = ?, updated_at = ? WHERE id = ?')
    .run(status, orderId, JSON.stringify(merged), now, id);
  return reservationFromRow(database.prepare('SELECT * FROM reservations WHERE id = ?').get(id));
}

export class SqlitePurchaseLedger {
  constructor({ database, now = Date.now, id = randomUUID } = {}) {
    if (!database) throw new Error('SqlitePurchaseLedger requires a database');
    this.database = database;
    this.now = now;
    this.id = id;
  }

  async reserve(input = {}) {
    return this.database.transaction(() => reserveSync(this.database, input, this.now(), this.id));
  }

  async #finish(id, status, details = {}) {
    return this.database.transaction(() => finishReservationSync(this.database, id, status, details, this.now()));
  }

  complete(id, details = {}) { return this.#finish(id, 'purchased', details); }
  fail(id, details = {}) { return this.#finish(id, 'failed', details); }
  uncertain(id, details = {}) { return this.#finish(id, 'uncertain', details); }

  async release(id, details = {}) {
    return this.database.transaction(() => {
      const record = this.database.prepare('SELECT status FROM reservations WHERE id = ?').get(id);
      if (!record) throw new Error(`Unknown purchase reservation: ${id}`);
      if (!['reserved', 'uncertain'].includes(record.status)) throw new Error(`Only reserved or uncertain purchases can be released; ${id} is ${record.status}`);
      return finishReservationSync(this.database, id, 'released', details, this.now());
    });
  }

  async spentSince(timestamp) {
    const row = this.database.prepare(`SELECT COALESCE(SUM(amount_cents * quantity), 0) AS cents FROM reservations
      WHERE status IN ('purchased', 'uncertain') AND updated_at >= ?`).get(timestamp);
    return centsToDollars(row.cents);
  }

  async records() {
    return this.database.prepare('SELECT * FROM reservations ORDER BY created_at, id').all().map(reservationFromRow);
  }
}

export class SqlitePurchaseTaskStore {
  constructor({ database, now = Date.now, id = randomUUID } = {}) {
    if (!database) throw new Error('SqlitePurchaseTaskStore requires a database');
    this.database = database;
    this.now = now;
    this.id = id;
  }

  async get(id) {
    return taskFromRow(this.database, this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  async list({ states, site, limit = 200 } = {}) {
    const clauses = [];
    const parameters = [];
    if (states?.length) {
      clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
      parameters.push(...states);
    }
    if (site) { clauses.push('site = ?'); parameters.push(site); }
    parameters.push(limit);
    const rows = this.database.prepare(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at DESC LIMIT ?`).all(...parameters);
    return rows.map((row) => taskFromRow(this.database, row));
  }

  recoverable() {
    return this.list({ states: SQLITE_TASK_STATES.filter((state) => !SQLITE_TERMINAL_TASK_STATES.has(state)) });
  }

  async ensure({ key, site, product, dropId = product, account, state = 'detected', details = {} } = {}) {
    if (!key || !site || !product) throw new Error('Purchase task requires key, site, and product');
    assertTaskState(state);
    return this.database.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM tasks WHERE key = ?').get(key);
      if (existing) return { created: false, task: taskFromRow(this.database, existing) };
      const timestamp = this.now();
      const id = this.id();
      this.database.prepare(`INSERT INTO tasks
        (id, key, site, product, drop_id, account, state, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, key, site, product, dropId, account?.id ?? account ?? null, state, timestamp, timestamp);
      this.database.prepare('INSERT INTO task_events (task_id, state, at, details_json) VALUES (?, ?, ?, ?)')
        .run(id, state, timestamp, JSON.stringify(redactSensitive(details)));
      return { created: true, task: taskFromRow(this.database, this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id)) };
    });
  }

  async transition(id, state, options = {}) {
    return this.database.transaction(() => transitionTaskSync(this.database, id, state, { ...options, now: this.now() }));
  }

  async reconcile(id, outcome, details = {}) {
    if (!['purchased', 'failed'].includes(outcome)) throw new Error('Task reconciliation outcome must be purchased or failed');
    return this.database.transaction(() => {
      const task = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw new Error(`Unknown purchase task: ${id}`);
      if (task.state !== 'uncertain') throw new Error(`Only an uncertain purchase task can be reconciled; ${id} is ${task.state}`);
      const timestamp = this.now();
      this.database.prepare('UPDATE tasks SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(outcome, timestamp, id);
      this.database.prepare('INSERT INTO task_events (task_id, state, at, details_json) VALUES (?, ?, ?, ?)')
        .run(id, outcome, timestamp, JSON.stringify(redactSensitive({ ...details, reconciled: true })));
      return taskFromRow(this.database, this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    });
  }

  async markInterrupted({ olderThanMs = 5 * 60_000 } = {}) {
    const cutoff = this.now() - olderThanMs;
    const candidates = (await this.recoverable()).filter((task) => EXECUTION_STATES.has(task.state) && task.updatedAt <= cutoff);
    const updated = [];
    for (const task of candidates) updated.push(await this.transition(task.id, 'uncertain', {
      expectedRevision: task.revision, details: { reason: 'process-interrupted' },
    }));
    return updated;
  }

  async acquireLease(id, { owner, ttlMs = 60_000 } = {}) {
    if (!owner) throw new Error('Task lease owner is required');
    return this.database.transaction(() => {
      const timestamp = this.now();
      const task = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw new Error(`Unknown purchase task: ${id}`);
      if (task.lease_owner && Number(task.lease_expires_at) > timestamp && task.lease_owner !== owner) {
        const error = new Error(`Purchase task ${id} is leased by another process`);
        error.code = 'SCALPER_TASK_LEASED';
        throw error;
      }
      this.database.prepare('UPDATE tasks SET lease_owner = ?, lease_expires_at = ? WHERE id = ?').run(owner, timestamp + ttlMs, id);
      return taskFromRow(this.database, this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    });
  }

  async releaseLease(id, { owner } = {}) {
    return this.database.transaction(() => {
      const task = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw new Error(`Unknown purchase task: ${id}`);
      if (task.lease_owner && owner && task.lease_owner !== owner) {
        const error = new Error(`Purchase task ${id} is leased by another process`);
        error.code = 'SCALPER_TASK_LEASED';
        throw error;
      }
      this.database.prepare('UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?').run(id);
      return taskFromRow(this.database, this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    });
  }
}

export class SqliteDropCalendar {
  constructor({ database, now = Date.now, validate = (drop) => structuredClone(drop) } = {}) {
    if (!database) throw new Error('SqliteDropCalendar requires a database');
    this.database = database;
    this.now = now;
    this.validate = validate;
  }

  async allDrops() {
    return this.database.prepare('SELECT payload_json FROM drops ORDER BY time, id').all().map((row) => json(row.payload_json));
  }

  async upcomingDrops(withinMs) {
    if (!Number.isFinite(withinMs) || withinMs < 0) throw new RangeError('withinMs must be non-negative');
    const timestamp = this.now();
    return (await this.allDrops()).filter((drop) => !['purchased', 'paper-confirmed', 'missed', 'cancelled'].includes(drop.status)
      && Date.parse(drop.time) >= timestamp && Date.parse(drop.time) <= timestamp + withinMs);
  }

  async dropById(id) {
    const row = this.database.prepare('SELECT payload_json FROM drops WHERE id = ?').get(id);
    return row ? json(row.payload_json) : null;
  }

  async upsertDrop(value) {
    const drop = this.validate(value);
    return this.database.transaction(() => {
      const timestamp = this.now();
      const previous = this.database.prepare('SELECT payload_json, created_at FROM drops WHERE id = ?').get(drop.id);
      const merged = previous ? { ...json(previous.payload_json), ...drop } : drop;
      this.database.prepare(`INSERT INTO drops
        (id, time, sites_json, type, price_cents, purchase_quantity, status, source, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET time=excluded.time, sites_json=excluded.sites_json, type=excluded.type,
          price_cents=excluded.price_cents, purchase_quantity=excluded.purchase_quantity, status=excluded.status,
          source=excluded.source, payload_json=excluded.payload_json, updated_at=excluded.updated_at`)
        .run(merged.id, merged.time, JSON.stringify(merged.sites), merged.type,
          merged.price === undefined ? null : dollarsToCents(merged.price), merged.purchaseQuantity ?? null,
          merged.status ?? null, merged.source ?? null, JSON.stringify(merged), previous?.created_at ?? timestamp, timestamp);
      return structuredClone(merged);
    });
  }

  async markResult(id, status, details = {}) {
    const current = await this.dropById(id);
    if (!current) throw new Error(`Unknown drop: ${id}`);
    return this.upsertDrop({ ...current, ...details, status, updatedAt: new Date(this.now()).toISOString() });
  }
}

export class SqliteSeenMessageStore {
  constructor({ database, now = Date.now, maxRows = 50_000 } = {}) {
    if (!database) throw new Error('SqliteSeenMessageStore requires a database');
    Object.assign(this, { database, now, maxRows });
  }

  async claim({ messageId, channelId, at } = {}) {
    if (!messageId || !channelId) throw new Error('Seen message claim requires messageId and channelId');
    return this.database.transaction(() => {
      const result = this.database.prepare(`INSERT INTO seen_messages (message_id, channel_id, at)
        VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING`).run(messageId, channelId, at ?? this.now());
      if (Number(result.changes) === 0) return false;
      const count = Number(this.database.prepare('SELECT COUNT(*) AS count FROM seen_messages').get().count);
      if (count > this.maxRows) {
        this.database.prepare(`DELETE FROM seen_messages WHERE message_id IN (
          SELECT message_id FROM seen_messages ORDER BY at, message_id LIMIT ?
        )`).run(count - this.maxRows);
      }
      return true;
    });
  }

  async has(messageId) {
    return Boolean(this.database.prepare('SELECT 1 FROM seen_messages WHERE message_id = ?').get(messageId));
  }

  async latest(channelId) {
    const row = this.database.prepare(`SELECT message_id, channel_id, at FROM seen_messages
      WHERE channel_id = ? ORDER BY at DESC, message_id DESC LIMIT 1`).get(channelId);
    return row ? { messageId: row.message_id, channelId: row.channel_id, at: Number(row.at) } : null;
  }
}

export class SqliteProductEndpointStore {
  constructor({ database, now = Date.now } = {}) {
    if (!database) throw new Error('SqliteProductEndpointStore requires a database');
    Object.assign(this, { database, now });
  }

  async set({ productId, site, pollUrl, measuredAt = this.now(), metadata = {} } = {}) {
    if (!productId || !site || !pollUrl) throw new Error('Product endpoint requires productId, site, and pollUrl');
    const url = new URL(pollUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Product poll endpoint must be an HTTPS URL without credentials');
    if (!isRetailerUrl(url.href, site)) throw new Error(`Product poll endpoint is not allowlisted for ${site}`);
    this.database.prepare(`INSERT INTO product_endpoints
      (product_id, site, poll_url, measured_at, metadata_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(product_id, site) DO UPDATE SET poll_url=excluded.poll_url,
        measured_at=excluded.measured_at, metadata_json=excluded.metadata_json`)
      .run(productId, site, url.href, measuredAt, JSON.stringify(metadata));
    return this.get(productId, site);
  }

  async get(productId, site) {
    const row = this.database.prepare(`SELECT product_id, site, poll_url, measured_at, metadata_json
      FROM product_endpoints WHERE product_id = ? AND site = ?`).get(productId, site);
    return row ? {
      productId: row.product_id, site: row.site, pollUrl: row.poll_url,
      measuredAt: row.measured_at === null ? null : Number(row.measured_at), metadata: json(row.metadata_json),
    } : null;
  }

  async list({ site } = {}) {
    const rows = site
      ? this.database.prepare(`SELECT product_id, site, poll_url, measured_at, metadata_json
        FROM product_endpoints WHERE site = ? ORDER BY product_id`).all(site)
      : this.database.prepare(`SELECT product_id, site, poll_url, measured_at, metadata_json
        FROM product_endpoints ORDER BY site, product_id`).all();
    return rows.map((row) => ({
      productId: row.product_id, site: row.site, pollUrl: row.poll_url,
      measuredAt: row.measured_at === null ? null : Number(row.measured_at), metadata: json(row.metadata_json),
    }));
  }

  async forDrop(drop) {
    const productId = drop?.productId ?? drop?.product?.id ?? drop?.id;
    const endpoints = await Promise.all((drop?.sites ?? []).map((site) => this.get(productId, site)));
    const missingSites = (drop?.sites ?? []).filter((_site, index) => !endpoints[index]);
    return {
      drop: {
        ...drop,
        pollUrls: {
          ...(drop?.pollUrls ?? {}),
          ...Object.fromEntries(endpoints.filter(Boolean).map((endpoint) => [endpoint.site, endpoint.pollUrl])),
        },
      },
      missingSites,
    };
  }
}

export class SqliteHumanChallengeBroker {
  #waiters = new Map();

  constructor({ database, alerts, now = Date.now, id = randomUUID, schedule = setTimeout, cancelSchedule = clearTimeout, logger = console } = {}) {
    if (!database) throw new Error('SqliteHumanChallengeBroker requires a database');
    Object.assign(this, { database, alerts, now, id, schedule, cancelSchedule, logger });
  }

  #row(value) {
    return value ? {
      id: value.id, taskId: value.task_id, site: value.site, kind: value.kind, status: value.status,
      ...(value.message ? { message: value.message } : {}), ...(value.url ? { url: value.url } : {}),
      createdAt: Number(value.created_at), updatedAt: Number(value.updated_at), expiresAt: Number(value.expires_at),
      ...(value.resolution_json ? { resolution: json(value.resolution_json) } : {}),
    } : null;
  }

  async list({ status, limit = 100 } = {}) {
    const rows = status
      ? this.database.prepare('SELECT * FROM challenges WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.database.prepare('SELECT * FROM challenges ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map((row) => this.#row(row));
  }

  async get(id) { return this.#row(this.database.prepare('SELECT * FROM challenges WHERE id = ?').get(id)); }

  async request({ taskId, site, kind = 'verification', message, url, timeoutMs = 10 * 60_000 } = {}) {
    if (!taskId || !site) throw new Error('Human challenge requires taskId and site');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Human challenge timeout must be positive');
    const challenge = this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM challenges WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(taskId);
      if (existing) return this.#row(existing);
      const createdAt = this.now();
      const id = this.id();
      this.database.prepare(`INSERT INTO challenges
        (id, task_id, site, kind, status, message, url, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
        .run(id, taskId, site, kind, String(message || `Complete ${kind} in the open Chrome window`).slice(0, 500),
          url ? String(url).slice(0, 2_000) : null, createdAt, createdAt, createdAt + timeoutMs);
      return this.#row(this.database.prepare('SELECT * FROM challenges WHERE id = ?').get(id));
    });
    const active = this.#waiters.get(challenge.id);
    if (active) return active.promise;
    try { await this.alerts?.challengeRequired?.(challenge); } catch (error) { this.logger?.warn?.('Challenge alert delivery failed', error); }
    const waiter = {};
    const promise = new Promise((resolve, reject) => {
      const timeout = this.schedule(async () => {
        this.#waiters.delete(challenge.id);
        try { await this.#finish(challenge.id, 'expired', { actor: 'timeout' }); } finally {
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

  async #finish(id, status, details = {}) {
    return this.database.transaction(() => {
      const challenge = this.database.prepare('SELECT * FROM challenges WHERE id = ?').get(id);
      if (!challenge) throw new Error(`Unknown human challenge: ${id}`);
      if (challenge.status !== 'pending') return this.#row(challenge);
      const resolution = { actor: String(details.actor ?? 'operator').slice(0, 100), ...(details.note ? { note: String(details.note).slice(0, 500) } : {}) };
      this.database.prepare('UPDATE challenges SET status = ?, updated_at = ?, resolution_json = ? WHERE id = ?')
        .run(status, this.now(), JSON.stringify(resolution), id);
      return this.#row(this.database.prepare('SELECT * FROM challenges WHERE id = ?').get(id));
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
    this.cancelSchedule(waiter.timeout);
    waiter.resolve(challenge);
    return challenge;
  }

  async cancel(id, details = {}) {
    const waiter = this.#waiters.get(id);
    const challenge = await this.#finish(id, 'cancelled', details);
    if (waiter) {
      this.#waiters.delete(id);
      this.cancelSchedule(waiter.timeout);
      const error = new Error(`Human challenge ${id} was cancelled`);
      error.code = 'SCALPER_CHALLENGE_CANCELLED';
      waiter.reject(error);
    }
    return challenge;
  }

  async expireInactive() {
    const pending = await this.list({ status: 'pending' });
    const expired = [];
    for (const challenge of pending) if (!this.#waiters.has(challenge.id)) {
      expired.push(await this.#finish(challenge.id, 'expired', { actor: 'process-restart' }));
    }
    return expired;
  }
}

export class SqliteStateStore {
  constructor({ database, path, dataDir = 'data/scalper', now = Date.now, id = randomUUID, validateDrop } = {}) {
    this.ownsDatabase = !database;
    this.database = database ?? openScalperDatabase({ path: path ?? join(dataDir, 'scalper.db') });
    this.now = now;
    this.id = id;
    this.ledger = new SqlitePurchaseLedger({ database: this.database, now, id });
    this.tasks = new SqlitePurchaseTaskStore({ database: this.database, now, id });
    this.calendar = new SqliteDropCalendar({ database: this.database, now, validate: validateDrop });
    this.seenMessages = new SqliteSeenMessageStore({ database: this.database, now });
    this.productEndpoints = new SqliteProductEndpointStore({ database: this.database, now });
  }

  createChallengeBroker(options = {}) {
    return new SqliteHumanChallengeBroker({ database: this.database, now: this.now, id: this.id, ...options });
  }

  async reserveForTask({ taskId, leaseOwner, afterReserve, ...reservation } = {}) {
    return this.database.transaction(() => {
      const result = reserveSync(this.database, reservation, this.now(), this.id);
      if (!result.ok) return result;
      afterReserve?.(result.reservation);
      const task = transitionTaskSync(this.database, taskId, 'authorized', {
        now: this.now(), leaseOwner,
        details: { reservationId: result.reservation.id, amount: reservation.amount, quantity: reservation.quantity },
      });
      return { ...result, task };
    });
  }

  async completePurchase({ taskId, reservationId, orderId, status = 'purchased', details = {}, leaseOwner } = {}) {
    return this.database.transaction(() => {
      const reservation = finishReservationSync(this.database, reservationId, 'purchased', { ...details, orderId, status }, this.now());
      const task = transitionTaskSync(this.database, taskId, status === 'paper-confirmed' ? 'paper-confirmed' : 'purchased', {
        now: this.now(), leaseOwner, details: { ...details, orderId },
      });
      return { reservation, task };
    });
  }

  close() { if (this.ownsDatabase) this.database.close(); }
}

export function createStateStore(options) { return new SqliteStateStore(options); }

async function readJson(path, fallback) {
  if (!path) return fallback;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function migrateLegacyState({ database, paths, now = Date.now } = {}) {
  if (!database) throw new Error('Legacy migration requires a database');
  const marker = paths?.marker;
  if (marker) {
    try { await readFile(marker, 'utf8'); return { migrated: false, reason: 'marker-exists' }; } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const [ledger, tasks, drops, challenges] = await Promise.all([
    readJson(paths?.ledger, { records: [] }), readJson(paths?.tasks, { tasks: [] }),
    readJson(paths?.drops, { drops: [] }), readJson(paths?.challenges, { challenges: [] }),
  ]);
  database.transaction(() => {
    for (const task of tasks.tasks ?? []) {
      database.prepare(`INSERT OR IGNORE INTO tasks
        (id, key, site, product, drop_id, account, state, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, task.key, task.site, task.product, task.dropId ?? task.product, task.account ?? null,
          task.state, task.revision ?? 1, task.createdAt ?? now(), task.updatedAt ?? task.createdAt ?? now());
      const eventCount = database.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(task.id).count;
      if (!eventCount) for (const event of task.events ?? []) {
        database.prepare('INSERT INTO task_events (task_id, state, at, details_json) VALUES (?, ?, ?, ?)')
          .run(task.id, event.state, event.at ?? task.createdAt ?? now(), JSON.stringify(redactSensitive(event.details ?? {})));
      }
    }
    for (const record of ledger.records ?? []) {
      database.prepare(`INSERT OR IGNORE INTO reservations
        (id, key, site, product, account, amount_cents, quantity, status, order_id, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.key, record.site ?? null, record.product ?? null, record.account ?? null,
          dollarsToCents(record.amount), record.quantity ?? 1, record.status, record.orderId ?? null, '{}',
          record.createdAt ?? now(), record.updatedAt ?? record.createdAt ?? now());
    }
    for (const drop of drops.drops ?? []) {
      const timestamp = now();
      database.prepare(`INSERT OR IGNORE INTO drops
        (id, time, sites_json, type, price_cents, purchase_quantity, status, source, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(drop.id, drop.time, JSON.stringify(drop.sites ?? []), drop.type,
          drop.price === undefined ? null : dollarsToCents(drop.price), drop.purchaseQuantity ?? null,
          drop.status ?? null, drop.source ?? null, JSON.stringify(drop), drop.createdAt ?? timestamp, drop.updatedAt ?? timestamp);
    }
    for (const challenge of challenges.challenges ?? []) {
      database.prepare(`INSERT OR IGNORE INTO challenges
        (id, task_id, site, kind, status, message, url, created_at, updated_at, expires_at, resolution_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(challenge.id, challenge.taskId ?? null, challenge.site, challenge.kind, challenge.status,
          challenge.message ?? null, challenge.url ?? null, challenge.createdAt ?? now(),
          challenge.updatedAt ?? challenge.createdAt ?? now(), challenge.expiresAt ?? now(),
          challenge.resolution ? JSON.stringify(challenge.resolution) : null);
    }
  });
  if (marker) {
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    await writeFile(marker, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, migratedAt: now() }, null, 2)}\n`, { mode: 0o600 });
  }
  return {
    migrated: true,
    counts: {
      tasks: tasks.tasks?.length ?? 0, reservations: ledger.records?.length ?? 0,
      drops: drops.drops?.length ?? 0, challenges: challenges.challenges?.length ?? 0,
    },
  };
}
