import test from 'node:test';
import assert from 'node:assert/strict';
import { PurchaseTaskStore } from '../../src/scalper/task-state.mjs';

function memoryStorage(initial) {
  let value = initial;
  return {
    async readText() {
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async writeText(_path, next) { value = next; },
    inspect: () => value,
  };
}

test('purchase tasks persist ordered state transitions and suppress a duplicate key', async () => {
  let now = 100;
  const storage = memoryStorage();
  const tasks = new PurchaseTaskStore({ storage, path: 'tasks.json', now: () => now, id: () => 'task-1' });
  const first = await tasks.ensure({ key: 'drop-1:bestbuy', site: 'bestbuy', product: 'drop-1' });
  assert.equal(first.created, true);
  now += 1;
  const authorized = await tasks.transition('task-1', 'authorized', { details: { amount: 20 } });
  assert.equal(authorized.revision, 2);
  now += 1;
  await tasks.transition('task-1', 'submitting');
  now += 1;
  await tasks.transition('task-1', 'confirming');
  now += 1;
  const purchased = await tasks.transition('task-1', 'purchased', { details: { orderId: 'o-1' } });
  assert.equal(purchased.state, 'purchased');
  assert.deepEqual(purchased.events.map((event) => event.state), ['detected', 'authorized', 'submitting', 'confirming', 'purchased']);
  const duplicate = await tasks.ensure({ key: 'drop-1:bestbuy', site: 'bestbuy', product: 'drop-1' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, 'task-1');
});

test('invalid or stale transitions fail instead of corrupting task state', async () => {
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), id: () => 'task-1' });
  const { task } = await tasks.ensure({ key: 'k', site: 'target', product: 'p' });
  await assert.rejects(tasks.transition(task.id, 'confirming'), /invalid.*detected.*confirming/i);
  await assert.rejects(tasks.transition(task.id, 'authorized', { expectedRevision: 99 }), (error) => error.code === 'SCALPER_TASK_REVISION_CONFLICT');
  await tasks.transition(task.id, 'blocked');
  await assert.rejects(tasks.transition(task.id, 'authorized'), /terminal/i);
});

test('task event details redact credentials before reaching durable storage', async () => {
  const storage = memoryStorage();
  const tasks = new PurchaseTaskStore({ storage, id: () => 'task-1' });
  const { task } = await tasks.ensure({
    key: 'k', site: 'target', product: 'p',
    details: { account: { id: 'a1', password: 'never-write-this', cardNumber: '4111', nested: { token: 'secret' } } },
  });
  assert.equal(task.events[0].details.account.password, '[redacted]');
  assert.equal(task.events[0].details.account.cardNumber, '[redacted]');
  assert.doesNotMatch(storage.inspect(), /never-write-this|4111|secret/);
});

test('stale in-flight work becomes uncertain while fresh work remains recoverable', async () => {
  let now = 1_000;
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), now: () => now, id: () => 'task-1' });
  await tasks.ensure({ key: 'k', site: 'bestbuy', product: 'p' });
  await tasks.transition('task-1', 'authorized');
  await tasks.transition('task-1', 'submitting');
  now += 10_000;
  assert.equal((await tasks.markInterrupted({ olderThanMs: 5_000 }))[0].state, 'uncertain');
  assert.equal((await tasks.recoverable()).length, 0);
});

test('uncertain tasks require an explicit reconciliation operation', async () => {
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), id: () => 'task-1', now: () => 100 });
  await tasks.ensure({ key: 'k', site: 'bestbuy', product: 'p' });
  await tasks.transition('task-1', 'authorized');
  await tasks.transition('task-1', 'uncertain');
  await assert.rejects(tasks.transition('task-1', 'purchased'), /terminal/i);
  assert.equal((await tasks.reconcile('task-1', 'purchased', { orderId: 'o1' })).state, 'purchased');
  await assert.rejects(tasks.reconcile('task-1', 'failed'), /only an uncertain/i);
});

test('a pre-commit retry is explicit and may restart browser progress', async () => {
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), id: () => 'task-1', now: () => 100 });
  await tasks.ensure({ key: 'k', site: 'bestbuy', product: 'p' });
  await tasks.transition('task-1', 'authorized');
  await tasks.transition('task-1', 'launching');
  await tasks.transition('task-1', 'navigating');
  await tasks.transition('task-1', 'retrying', { details: { completedAttempt: 1, nextAttempt: 2 } });
  await tasks.transition('task-1', 'launching');
  await tasks.transition('task-1', 'navigating');
  const purchased = await tasks.transition('task-1', 'purchased');
  assert.deepEqual(purchased.events.map((event) => event.state), [
    'detected', 'authorized', 'launching', 'navigating', 'retrying', 'launching', 'navigating', 'purchased',
  ]);
});

test('a purchased task cannot be retried', async () => {
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), id: () => 'task-1', now: () => 100 });
  await tasks.ensure({ key: 'k', site: 'bestbuy', product: 'p' });
  await tasks.transition('task-1', 'authorized');
  await tasks.transition('task-1', 'purchased');
  await assert.rejects(tasks.transition('task-1', 'retrying'), /terminal/i);
});
