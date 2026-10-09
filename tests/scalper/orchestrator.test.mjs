import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../../src/scalper/orchestrator.mjs';
import { PurchaseTaskStore } from '../../src/scalper/task-state.mjs';
import { memoryStorage } from './helpers.mjs';

test('scheduled drops warm up at T-5m, accelerate at T-30s, and run at T-0', async () => {
  let now = 1_000_000;
  const drop = { id: 'p1', sites: ['target'], type: 'scheduled', time: new Date(now + 299_000).toISOString() };
  const events = [];
  const lane = {
    warmup: async () => events.push('warmup'),
    fullThrottle: async () => events.push('full'),
    run: async () => { events.push('run'); return { status: 'purchased' }; },
  };
  const orchestrator = new Orchestrator({ calendar: { allDrops: async () => [drop], markResult: async () => {} }, lanes: { target: lane }, clock: { now: () => now } });
  await orchestrator.tick();
  now += 270_000;
  await orchestrator.tick();
  now += 30_000;
  await orchestrator.tick();
  assert.deepEqual(events, ['warmup', 'full', 'run']);
});

test('checkout retries once, serializes a site, and suppresses a duplicate product', async () => {
  let attempts = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const lane = { checkout: async () => {
    attempts += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (attempts === 1) { concurrent -= 1; throw new Error('transient'); }
    await gate;
    concurrent -= 1;
    return { status: 'purchased' };
  } };
  const orchestrator = new Orchestrator({ lanes: { target: lane }, calendar: { markResult: async () => {} } });
  const first = orchestrator.handleDetection({ site: 'target', drop: { id: 'same' } });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await orchestrator.handleDetection({ site: 'target', drop: { id: 'same' } });
  release();
  assert.deepEqual(duplicate, { status: 'duplicate-suppressed' });
  assert.equal((await first).status, 'purchased');
  assert.equal(attempts, 2);
  assert.equal(maxConcurrent, 1);
});

test('regression: a continuous surprise watcher never blocks later orchestrator ticks', async () => {
  const never = new Promise(() => {});
  const drop = { id: 'surprise', sites: ['target'], type: 'surprise', time: new Date(1_000).toISOString() };
  const orchestrator = new Orchestrator({
    calendar: { allDrops: async () => [drop] }, lanes: { target: { watch: async () => never } }, clock: { now: () => 1_000 },
  });
  const outcome = await Promise.race([
    orchestrator.tick().then(() => 'tick-complete'),
    new Promise((resolve) => setImmediate(() => resolve('blocked'))),
  ]);
  assert.equal(outcome, 'tick-complete');
});

test('regression: an alert outage after purchase never retries and double-buys', async () => {
  let checkouts = 0;
  const orchestrator = new Orchestrator({
    calendar: { markResult: async () => {} },
    lanes: { target: { checkout: async () => { checkouts += 1; return { status: 'purchased', orderId: 'o1' }; } } },
    alerts: { dropDetected: async () => {}, purchaseConfirmed: async () => { throw new Error('webhook down'); } },
    logger: { warn() {}, error() {} },
  });
  const result = await orchestrator.handleDetection({ site: 'target', drop: { id: 'one-order-only' } });
  assert.equal(result.status, 'purchased');
  assert.equal(checkouts, 1);
});

test('detection alert delivery never blocks the checkout critical path', async () => {
  let checkedOut = false;
  const orchestrator = new Orchestrator({
    calendar: { markResult: async () => {} },
    alerts: { dropDetected: async () => new Promise(() => {}) },
    lanes: { target: { checkout: async () => { checkedOut = true; return { status: 'paper-confirmed' }; } } },
  });
  const result = await Promise.race([
    orchestrator.handleDetection({ site: 'target', drop: { id: 'fast-alert-path' } }),
    new Promise((resolve) => setImmediate(() => resolve({ status: 'blocked' }))),
  ]);
  assert.equal(result.status, 'paper-confirmed');
  assert.equal(checkedOut, true);
});

test('safety denial blocks checkout and a durable reservation suppresses a restart duplicate', async () => {
  let checkouts = 0;
  const records = new Map();
  const ledger = {
    async reserve(input) {
      if (records.has(input.key)) return { ok: false, reason: 'already-reserved', record: records.get(input.key) };
      const reservation = { id: 'r1', ...input, status: 'reserved' };
      records.set(input.key, reservation);
      return { ok: true, reservation };
    },
    async complete() {},
    async fail() {},
  };
  const blocked = new Orchestrator({
    lanes: { target: { checkout: async () => { checkouts += 1; } } },
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: false, reason: 'kill-switch' }) },
  });
  assert.equal((await blocked.handleDetection({ site: 'target', drop: { id: 'safe', price: 20 } })).status, 'safety-blocked');
  assert.equal(checkouts, 0);

  const dependencies = {
    lanes: {
      target: { checkout: async () => { checkouts += 1; return { status: 'purchased' }; } },
      bestbuy: { checkout: async () => { checkouts += 1; return { status: 'purchased' }; } },
    },
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: true, total: 20, quantity: 1 }) },
    ledger,
  };
  const first = new Orchestrator(dependencies);
  assert.equal((await first.handleDetection({ site: 'target', drop: { id: 'durable', price: 20 } })).status, 'purchased');
  const restarted = new Orchestrator(dependencies);
  assert.equal((await restarted.handleDetection({ site: 'bestbuy', drop: { id: 'durable', price: 20 } })).status, 'duplicate-suppressed');
  assert.equal(checkouts, 1);
});

test('failed surprise watchers restart with bounded backoff and shutdown aborts active work', async () => {
  let now = 1_000;
  let starts = 0;
  let observedSignal;
  const drop = { id: 'surprise-retry', sites: ['target'], type: 'surprise', time: new Date(now).toISOString() };
  const lane = {
    watch: async ({ signal }) => {
      starts += 1;
      observedSignal = signal;
      if (starts === 1) throw new Error('temporary watcher failure');
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true }));
    },
  };
  const orchestrator = new Orchestrator({
    calendar: { allDrops: async () => [drop] }, lanes: { target: lane }, clock: { now: () => now },
    watchBackoff: () => 500, logger: { error() {}, warn() {} },
  });
  await orchestrator.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await orchestrator.tick();
  assert.equal(starts, 1);
  now += 500;
  await orchestrator.tick();
  assert.equal(starts, 2);
  assert.equal(observedSignal.aborted, false);
  await orchestrator.stop();
  assert.equal(observedSignal.aborted, true);
});

test('observed stock quantity never becomes the requested purchase quantity', async () => {
  let authorized;
  const orchestrator = new Orchestrator({
    calendar: { markResult: async () => {} },
    lanes: { target: { checkout: async () => ({ status: 'paper-confirmed' }) } },
    safety: { authorize: async (input) => { authorized = input; return { allowed: true, live: false }; } },
  });
  await orchestrator.handleDetection({ site: 'target', drop: { id: 'inventory-count', quantity: 99, price: 20 } });
  assert.equal(authorized.quantity, 1);
});

test('checkout progress is journaled as a durable purchase task', async () => {
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), path: '/tasks.json', id: () => 'task-1', now: () => 100 });
  const orchestrator = new Orchestrator({
    tasks,
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: false }) },
    lanes: { target: { checkout: async ({ taskId, onProgress }) => {
      assert.equal(taskId, 'task-1');
      await onProgress({ state: 'launching' });
      await onProgress({ state: 'navigating' });
      await onProgress({ state: 'carting' });
      await onProgress({ state: 'submitting' });
      await onProgress({ state: 'confirming' });
      return { status: 'purchased', orderId: 'o-1' };
    } } },
  });
  assert.equal((await orchestrator.handleDetection({ site: 'target', drop: { id: 'durable-task', price: 20 } })).status, 'purchased');
  const task = await tasks.get('task-1');
  assert.equal(task.state, 'purchased');
  assert.deepEqual(task.events.map((event) => event.state), [
    'detected', 'authorized', 'launching', 'navigating', 'carting', 'submitting', 'confirming', 'purchased',
  ]);
});

test('an uncertain order is never retried and remains reserved for operator reconciliation', async () => {
  let attempts = 0;
  let uncertainReservation;
  let uncertainAlert;
  const error = Object.assign(new Error('confirmation missing'), { code: 'SCALPER_ORDER_STATUS_UNCERTAIN' });
  const orchestrator = new Orchestrator({
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: true }) },
    ledger: {
      reserve: async () => ({ ok: true, reservation: { id: 'r1' } }),
      uncertain: async (id, details) => { uncertainReservation = { id, details }; },
    },
    alerts: { dropDetected: async () => {}, purchaseUncertain: async (details) => { uncertainAlert = details; } },
    lanes: { bestbuy: { checkout: async () => { attempts += 1; throw error; } } },
  });
  const result = await orchestrator.handleDetection({ site: 'bestbuy', drop: { id: 'uncertain-drop', price: 20 } });
  assert.equal(result.status, 'uncertain');
  assert.equal(attempts, 1);
  assert.equal(uncertainReservation.id, 'r1');
  assert.equal(uncertainAlert.product, 'uncertain-drop');
});

test('a checkout may restart durable browser progress after a pre-commit failure', async () => {
  let attempts = 0;
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), path: '/tasks.json', id: () => 'task-retry', now: () => 100 });
  const orchestrator = new Orchestrator({
    tasks,
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: false }) },
    lanes: { target: { checkout: async ({ onProgress }) => {
      attempts += 1;
      await onProgress({ state: 'launching' });
      await onProgress({ state: 'navigating' });
      if (attempts === 1) throw new Error('temporary navigation failure');
      return { status: 'paper-confirmed' };
    } } },
  });
  assert.equal((await orchestrator.handleDetection({ site: 'target', drop: { id: 'retry-progress', price: 20 } })).status, 'paper-confirmed');
  assert.equal(attempts, 2);
  assert.deepEqual((await tasks.get('task-retry')).events.map((event) => event.state), [
    'detected', 'authorized', 'launching', 'navigating', 'retrying', 'launching', 'navigating', 'paper-confirmed',
  ]);
});

test('safety is checked again immediately before commit and fails closed', async () => {
  let authorizations = 0;
  let commitChecks = 0;
  let commits = 0;
  let failedReservation;
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), path: '/tasks.json', id: () => 'task-safe', now: () => 100 });
  const orchestrator = new Orchestrator({
    tasks,
    calendar: { markResult: async () => {} },
    safety: {
      authorize: async () => {
        authorizations += 1;
        return { allowed: true, live: true, dayStart: 0, dailyLimit: 100 };
      },
      recheckAtCommit: async () => {
        commitChecks += 1;
        return { allowed: false, live: true, reason: 'kill-switch' };
      },
    },
    ledger: {
      reserve: async () => ({ ok: true, reservation: { id: 'r-safe' } }),
      fail: async (id, details) => { failedReservation = { id, details }; },
    },
    lanes: { target: { checkout: async ({ beforeCommit, onProgress }) => {
      await onProgress({ state: 'launching' });
      await beforeCommit({ step: 'place-order' });
      commits += 1;
      return { status: 'purchased' };
    } } },
  });
  const result = await orchestrator.handleDetection({ site: 'target', drop: { id: 'precommit-stop', price: 20 } });
  assert.deepEqual({ status: result.status, reason: result.reason, phase: result.phase }, {
    status: 'safety-blocked', reason: 'kill-switch', phase: 'precommit',
  });
  assert.equal(authorizations, 1);
  assert.equal(commitChecks, 1);
  assert.equal(commits, 0);
  assert.equal(failedReservation.id, 'r-safe');
  assert.equal((await tasks.get('task-safe')).state, 'blocked');
});

test('a lane cart-attestation block is never finalized as a purchase', async () => {
  let completed = 0;
  let failedReservation;
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), path: '/tasks.json', id: () => 'task-attest', now: () => 100 });
  const orchestrator = new Orchestrator({
    tasks,
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: true }) },
    ledger: {
      reserve: async () => ({ ok: true, reservation: { id: 'r-attest' } }),
      complete: async () => { completed += 1; },
      fail: async (id, details) => { failedReservation = { id, details }; },
    },
    lanes: { 'pokemon-center': { checkout: async () => ({
      status: 'safety-blocked', reason: 'cart-attestation', defects: [{ name: 'sku' }],
    }) } },
  });
  const result = await orchestrator.handleDetection({ site: 'pokemon-center', drop: { id: 'wrong-cart', price: 20 } });
  assert.equal(result.status, 'safety-blocked');
  assert.equal(completed, 0);
  assert.equal(failedReservation.id, 'r-attest');
  assert.equal((await tasks.get('task-attest')).state, 'blocked');
});

test('a generic failure after submission begins is uncertain and is never retried', async () => {
  let attempts = 0;
  const orchestrator = new Orchestrator({
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: true }) },
    ledger: {
      reserve: async () => ({ ok: true, reservation: { id: 'r-submit' } }),
      uncertain: async () => {},
    },
    lanes: { bestbuy: { checkout: async ({ onProgress }) => {
      attempts += 1;
      await onProgress({ state: 'submitting' });
      throw new Error('socket closed');
    } } },
  });
  const result = await orchestrator.handleDetection({ site: 'bestbuy', drop: { id: 'submit-failed', price: 20 } });
  assert.equal(result.status, 'uncertain');
  assert.equal(attempts, 1);
});

test('a ledger finalization failure cannot be reported as a confirmed purchase', async () => {
  let uncertainReservation;
  const tasks = new PurchaseTaskStore({ storage: memoryStorage(), path: '/tasks.json', id: () => 'task-ledger', now: () => 100 });
  const orchestrator = new Orchestrator({
    tasks,
    calendar: { markResult: async () => {} },
    safety: { authorize: async () => ({ allowed: true, live: true }) },
    ledger: {
      reserve: async () => ({ ok: true, reservation: { id: 'r-ledger' } }),
      complete: async () => { throw new Error('disk full'); },
      uncertain: async (id, details) => { uncertainReservation = { id, details }; },
    },
    logger: { warn() {}, error() {} },
    lanes: { bestbuy: { checkout: async () => ({ status: 'purchased', orderId: 'o-ledger' }) } },
  });
  const result = await orchestrator.handleDetection({ site: 'bestbuy', drop: { id: 'ledger-failed', price: 20 } });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.orderId, 'o-ledger');
  assert.equal(uncertainReservation.id, 'r-ledger');
  assert.equal((await tasks.get('task-ledger')).state, 'uncertain');
});
