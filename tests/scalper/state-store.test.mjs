import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScalperDatabase } from '../../src/scalper/db.mjs';
import { createStateStore, migrateLegacyState } from '../../src/scalper/state-store.mjs';

test('reserve plus task authorization is atomic and completion updates both records', async () => {
  const database = openScalperDatabase({ path: ':memory:' });
  const state = createStateStore({ database, now: () => 100, id: (() => { let value = 0; return () => `id-${++value}`; })() });
  try {
    const { task } = await state.tasks.ensure({ key: 'task-key', site: 'target', product: 'p1' });
    await assert.rejects(state.reserveForTask({
      taskId: task.id, key: 'reservation-key', site: 'target', product: 'p1', amount: 10.99, quantity: 1,
      afterReserve: () => { throw new Error('injected crash'); },
    }), /injected crash/);
    assert.equal((await state.ledger.records()).length, 0);
    assert.equal((await state.tasks.get(task.id)).state, 'detected');

    const reserved = await state.reserveForTask({
      taskId: task.id, key: 'reservation-key', site: 'target', product: 'p1', amount: 10.99, quantity: 1,
    });
    assert.equal(reserved.ok, true);
    assert.equal(database.prepare('SELECT amount_cents FROM reservations').get().amount_cents, 1099);
    assert.equal((await state.tasks.get(task.id)).state, 'authorized');

    await state.completePurchase({ taskId: task.id, reservationId: reserved.reservation.id, orderId: 'order-1' });
    assert.equal((await state.ledger.records())[0].status, 'purchased');
    assert.equal((await state.tasks.get(task.id)).state, 'purchased');
  } finally {
    database.close();
  }
});

test('a second process cannot transition a live leased task and stale leases can be taken over', async () => {
  let now = 100;
  const database = openScalperDatabase({ path: ':memory:' });
  const first = createStateStore({ database, now: () => now, id: () => 'task-1' });
  const second = createStateStore({ database, now: () => now, id: () => 'unused' });
  try {
    const { task } = await first.tasks.ensure({ key: 'k', site: 'bestbuy', product: 'p' });
    await first.tasks.acquireLease(task.id, { owner: 'process-a', ttlMs: 50 });
    await assert.rejects(second.tasks.transition(task.id, 'authorized', { leaseOwner: 'process-b' }), (error) => error.code === 'SCALPER_TASK_LEASED');
    await first.tasks.transition(task.id, 'authorized', { leaseOwner: 'process-a' });
    now = 200;
    assert.equal((await second.tasks.acquireLease(task.id, { owner: 'process-b', ttlMs: 50 })).leaseOwner, 'process-b');
  } finally {
    database.close();
  }
});

test('a purchased reservation rejects the same key as already-purchased', async () => {
  const database = openScalperDatabase({ path: ':memory:' });
  const state = createStateStore({ database, now: () => 100, id: (() => { let value = 0; return () => `id-${++value}`; })() });
  try {
    const first = await state.ledger.reserve({ key: 'drop', site: 'target', product: 'p', amount: 20, quantity: 1 });
    await state.ledger.complete(first.reservation.id, { orderId: 'o1' });
    assert.equal((await state.ledger.reserve({ key: 'drop', site: 'target', product: 'p', amount: 20, quantity: 1 })).reason, 'already-purchased');
  } finally {
    database.close();
  }
});

test('Discord message claims are durable and measured product endpoints map to poll URLs', async () => {
  let now = 100;
  const database = openScalperDatabase({ path: ':memory:' });
  const state = createStateStore({ database, now: () => now });
  try {
    assert.equal(await state.seenMessages.claim({ messageId: 'm1', channelId: 'c1' }), true);
    assert.equal(await state.seenMessages.claim({ messageId: 'm1', channelId: 'c1' }), false);
    assert.deepEqual(await state.seenMessages.latest('c1'), { messageId: 'm1', channelId: 'c1', at: 100 });

    now = 200;
    await state.productEndpoints.set({
      productId: 'pc-etb', site: 'pokemon-center', pollUrl: 'https://www.pokemoncenter.com/api/measured-etb',
      metadata: { responseContract: 'availability-v1' },
    });
    const mapped = await state.productEndpoints.forDrop({ id: 'pc-etb', sites: ['pokemon-center'], productUrls: { 'pokemon-center': 'https://www.pokemoncenter.com/product/etb' } });
    assert.deepEqual(mapped.missingSites, []);
    assert.equal(mapped.drop.pollUrls['pokemon-center'], 'https://www.pokemoncenter.com/api/measured-etb');
    await assert.rejects(state.productEndpoints.set({
      productId: 'pc-etb', site: 'pokemon-center', pollUrl: 'https://pokemoncenter.com.evil.example/api',
    }), /not allowlisted/);
  } finally {
    database.close();
  }
});

test('legacy JSON migration is idempotent and writes a marker only after commit', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pokemon-scalper-migrate-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const database = openScalperDatabase({ path: join(dataDir, 'scalper.db') });
  const paths = {
    ledger: join(dataDir, 'purchase-ledger.json'),
    tasks: join(dataDir, 'purchase-tasks.json'),
    drops: join(dataDir, 'drops.json'),
    challenges: join(dataDir, 'challenges.json'),
    marker: join(dataDir, 'scalper.db.migrated'),
  };
  await writeFile(paths.ledger, JSON.stringify({ records: [{ id: 'r1', key: 'rk', site: 'target', product: 'p', amount: 12.34, quantity: 1, status: 'purchased', createdAt: 1, updatedAt: 2 }] }));
  await writeFile(paths.tasks, JSON.stringify({ version: 1, tasks: [{ id: 't1', key: 'tk', site: 'target', product: 'p', state: 'purchased', revision: 2, createdAt: 1, updatedAt: 2, events: [{ state: 'detected', at: 1, details: {} }, { state: 'purchased', at: 2, details: { orderId: 'o1' } }] }] }));
  await writeFile(paths.drops, JSON.stringify({ drops: [{ id: 'd1', name: 'Drop', sites: ['target'], type: 'surprise', time: '2026-10-02T12:00:00.000Z', price: 12.34 }] }));
  await writeFile(paths.challenges, JSON.stringify({ version: 1, challenges: [{ id: 'c1', taskId: 't1', site: 'target', kind: '3ds', status: 'expired', createdAt: 1, updatedAt: 2, expiresAt: 2 }] }));
  try {
    assert.equal((await migrateLegacyState({ database, paths })).migrated, true);
    assert.equal((await migrateLegacyState({ database, paths })).migrated, false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 2);
    assert.equal(database.prepare('SELECT amount_cents FROM reservations').get().amount_cents, 1234);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM drops').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM challenges').get().count, 1);
    assert.match(await readFile(paths.marker, 'utf8'), /"schemaVersion"/);
  } finally {
    database.close();
  }
});
