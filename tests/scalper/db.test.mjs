import test from 'node:test';
import assert from 'node:assert/strict';
import { openScalperDatabase, SCHEMA_VERSION } from '../../src/scalper/db.mjs';

test('SQLite schema is versioned and a failed transaction leaves no partial rows', () => {
  const database = openScalperDatabase({ path: ':memory:' });
  try {
    assert.equal(database.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
    assert.throws(() => database.transaction(() => {
      database.prepare(`INSERT INTO tasks
        (id, key, site, product, state, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('t1', 'k1', 'target', 'p1', 'detected', 1, 100, 100);
      throw new Error('injected crash');
    }), /injected crash/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  } finally {
    database.close();
  }
});

test('SQLite stores money as integer cents and enforces active reservation uniqueness', () => {
  const database = openScalperDatabase({ path: ':memory:' });
  try {
    const insert = database.prepare(`INSERT INTO reservations
      (id, key, site, product, amount_cents, quantity, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('r1', 'drop-1', 'target', 'p1', 1099, 1, 'reserved', 100, 100);
    assert.equal(database.prepare('SELECT amount_cents FROM reservations WHERE id = ?').get('r1').amount_cents, 1099);
    assert.throws(() => insert.run('r2', 'drop-1', 'target', 'p1', 1099, 1, 'reserved', 101, 101), /unique/i);
    database.prepare('UPDATE reservations SET status = ? WHERE id = ?').run('released', 'r1');
    assert.doesNotThrow(() => insert.run('r3', 'drop-1', 'target', 'p1', 1099, 1, 'reserved', 102, 102));
  } finally {
    database.close();
  }
});
