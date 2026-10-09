import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT INTO schema_version (id, version) VALUES (1, ${SCHEMA_VERSION})
  ON CONFLICT(id) DO UPDATE SET version = excluded.version;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  site TEXT NOT NULL,
  product TEXT NOT NULL,
  drop_id TEXT,
  account TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  at INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS task_events_task_at ON task_events(task_id, at, id);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  site TEXT,
  product TEXT,
  account TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL,
  order_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_active_key
  ON reservations(key) WHERE status IN ('reserved', 'purchased', 'uncertain');
CREATE INDEX IF NOT EXISTS reservations_status_updated ON reservations(status, updated_at);

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  sites_json TEXT NOT NULL,
  type TEXT NOT NULL,
  price_cents INTEGER,
  purchase_quantity INTEGER,
  status TEXT,
  source TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  site TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolution_json TEXT
);
CREATE INDEX IF NOT EXISTS challenges_status_expires ON challenges(status, expires_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  product TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS seen_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS seen_messages_channel_at ON seen_messages(channel_id, at);

CREATE TABLE IF NOT EXISTS product_endpoints (
  product_id TEXT NOT NULL,
  site TEXT NOT NULL,
  poll_url TEXT NOT NULL,
  measured_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(product_id, site)
);
`;

export class ScalperDatabase {
  #connection;
  #ownsConnection;
  #transactionDepth = 0;

  constructor({ path = 'data/scalper/scalper.db', driver, Database = DatabaseSync } = {}) {
    this.path = path;
    if (driver) {
      this.#connection = driver;
      this.#ownsConnection = false;
    } else {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.#connection = new Database(path);
      this.#ownsConnection = true;
      if (path !== ':memory:') chmodSync(path, 0o600);
    }
    this.#connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.#connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.#connection.exec(SCHEMA);
  }

  prepare(sql) {
    return this.#connection.prepare(sql);
  }

  exec(sql) {
    return this.#connection.exec(sql);
  }

  transaction(operation) {
    if (this.#transactionDepth > 0) return operation(this);
    this.#connection.exec('BEGIN IMMEDIATE');
    this.#transactionDepth += 1;
    try {
      const result = operation(this);
      if (result && typeof result.then === 'function') {
        throw new TypeError('SQLite transaction callbacks must be synchronous');
      }
      this.#connection.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#connection.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  close() {
    if (this.#ownsConnection) this.#connection.close();
  }
}

export function openScalperDatabase(options) {
  return new ScalperDatabase(options);
}
