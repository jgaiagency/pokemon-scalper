import test from 'node:test';
import assert from 'node:assert/strict';
import { PurchaseLedger, SafetyPolicy } from '../../src/scalper/safety.mjs';
import { memoryStorage } from './helpers.mjs';

test('live safety policy enforces kill switch, price, quantity, order, and daily limits', async () => {
  const storage = memoryStorage();
  const ledger = new PurchaseLedger({ storage, path: '/ledger.json', now: () => Date.parse('2026-10-01T12:00:00Z'), id: () => 'r1' });
  const baseEnv = {
    SCALPER_LIVE: '1', SCALPER_MAX_ORDER_USD: '100', SCALPER_MAX_DAILY_SPEND_USD: '150', SCALPER_MAX_QUANTITY: '2',
    SCALPER_ALLOW_UNSCORED: '1',
  };
  const policy = new SafetyPolicy({ env: baseEnv, ledger, killSwitchExists: async () => false, now: () => Date.parse('2026-10-01T12:00:00Z') });
  assert.equal((await policy.authorize({ amount: 40, quantity: 2 })).allowed, true);
  assert.equal((await policy.authorize({ amount: undefined, quantity: 1 })).reason, 'price-unknown');
  assert.equal((await policy.authorize({ amount: null, quantity: 1 })).reason, 'price-unknown');
  assert.equal((await policy.authorize({ amount: 40, quantity: 3 })).reason, 'quantity-limit');
  assert.equal((await policy.authorize({ amount: 60, quantity: 2 })).reason, 'order-limit');

  const reservation = await ledger.reserve({ key: 'old', site: 'target', product: 'old', amount: 90, quantity: 1 });
  await ledger.complete(reservation.reservation.id, { status: 'purchased' });
  assert.equal((await policy.authorize({ amount: 70, quantity: 1 })).reason, 'daily-limit');

  const killed = new SafetyPolicy({ env: { ...baseEnv, SCALPER_KILL_SWITCH: '1' }, ledger, killSwitchExists: async () => false });
  assert.equal((await killed.authorize({ amount: 1, quantity: 1 })).reason, 'kill-switch');
});

test('paper mode remains usable without live spend configuration', async () => {
  const policy = new SafetyPolicy({ env: { SCALPER_LIVE: '0', SCALPER_KILL_SWITCH: '1' } });
  assert.deepEqual(await policy.authorize({}), { allowed: true, live: false, reason: 'paper-mode' });
});

test('live mode fails closed when mandatory spend limits were not configured', async () => {
  const policy = new SafetyPolicy({ env: { SCALPER_LIVE: '1' }, killSwitchExists: async () => false });
  const decision = await policy.authorize({ amount: 1, quantity: 1 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'safety-unconfigured');
  assert.deepEqual(decision.missing.sort(), ['SCALPER_MAX_DAILY_SPEND_USD', 'SCALPER_MAX_ORDER_USD', 'SCALPER_MAX_QUANTITY'].sort());
});

test('commit recheck observes a kill switch created after initial authorization', async () => {
  let killed = false;
  const policy = new SafetyPolicy({
    env: {
      SCALPER_LIVE: '1', SCALPER_MAX_ORDER_USD: '100', SCALPER_MAX_DAILY_SPEND_USD: '150',
      SCALPER_MAX_QUANTITY: '1', SCALPER_ALLOW_UNSCORED: '1',
    },
    killSwitchExists: async () => killed,
  });
  assert.equal((await policy.authorize({ amount: 20, quantity: 1 })).allowed, true);
  killed = true;
  assert.deepEqual(await policy.recheckAtCommit({ amount: 20, quantity: 1 }), {
    allowed: false, live: true, reason: 'kill-switch',
  });
});

test('profitability gate blocks an ineligible fresh score', async () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const policy = new SafetyPolicy({
    env: {
      SCALPER_LIVE: '1', SCALPER_MAX_ORDER_USD: '100', SCALPER_MAX_DAILY_SPEND_USD: '150', SCALPER_MAX_QUANTITY: '1',
    },
    now: () => now,
    killSwitchExists: async () => false,
    observations: async () => [{ productId: 'loss', source: 'sold', kind: 'completed-sale', price: 40, sampleSize: 3, at: now }],
    scorer: () => ({ eligible: false, risks: ['profit-below-threshold'] }),
  });
  const decision = await policy.authorize({ drop: { id: 'loss', name: 'Loss' }, amount: 50, quantity: 1 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'profitability');
});

test('profitability gate allows an eligible score with fresh evidence', async () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const evidence = [{ productId: 'winner', source: 'sold', kind: 'completed-sale', price: 90, sampleSize: 4, at: now }];
  const policy = new SafetyPolicy({
    env: {
      SCALPER_LIVE: '1', SCALPER_MAX_ORDER_USD: '100', SCALPER_MAX_DAILY_SPEND_USD: '150', SCALPER_MAX_QUANTITY: '1',
    },
    now: () => now,
    killSwitchExists: async () => false,
    observations: async () => evidence,
    scorer: (_product, received) => ({ eligible: received.length === 1, score: 80, evidence: received }),
  });
  const decision = await policy.authorize({ drop: { id: 'winner', name: 'Winner' }, amount: 50, quantity: 1 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.profitability.eligible, true);
});

test('purchase ledger prevents restart-time duplicate purchases and records spend', async () => {
  const storage = memoryStorage();
  const options = { storage, path: '/ledger.json', now: () => Date.parse('2026-10-01T12:00:00Z') };
  const first = new PurchaseLedger({ ...options, id: () => 'reservation-1' });
  const reserved = await first.reserve({ key: 'drop:target', site: 'target', product: 'drop', amount: 55, quantity: 1 });
  assert.equal(reserved.ok, true);

  const afterRestart = new PurchaseLedger({ ...options, id: () => 'reservation-2' });
  assert.deepEqual(await afterRestart.reserve({ key: 'drop:target', site: 'target', product: 'drop', amount: 55, quantity: 1 }), {
    ok: false, reason: 'already-reserved', record: reserved.reservation,
  });
  await afterRestart.complete('reservation-1', { status: 'purchased', orderId: 'o1' });
  assert.equal(await afterRestart.spentSince(Date.parse('2026-10-01T00:00:00Z')), 55);
  assert.equal((await afterRestart.reserve({ key: 'drop:target', site: 'target', product: 'drop', amount: 55, quantity: 1 })).reason, 'already-purchased');
});

test('purchase ledger atomically prevents concurrent reservations from exceeding the daily budget', async () => {
  const ledger = new PurchaseLedger({
    storage: memoryStorage(), path: '/ledger.json', now: () => Date.parse('2026-10-01T12:00:00Z'),
    id: (() => { let value = 0; return () => `r${++value}`; })(),
  });
  const dayStart = Date.parse('2026-10-01T00:00:00Z');
  const results = await Promise.all([
    ledger.reserve({ key: 'a', amount: 100, quantity: 1, dayStart, dailyLimit: 150 }),
    ledger.reserve({ key: 'b', amount: 100, quantity: 1, dayStart, dailyLimit: 150 }),
  ]);
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
  assert.equal(results[1].reason, 'daily-limit');
});

test('an operator can release a verified abandoned reservation and retry it', async () => {
  const ledger = new PurchaseLedger({ storage: memoryStorage(), path: '/ledger.json', now: () => 100, id: () => 'r1' });
  await ledger.reserve({ key: 'drop', amount: 20 });
  const released = await ledger.release('r1', { reason: 'verified-no-order' });
  assert.equal(released.status, 'released');
  assert.equal((await ledger.reserve({ key: 'drop', amount: 20 })).ok, true);
});

test('an uncertain order counts toward spend and suppresses a duplicate until reconciled', async () => {
  const ledger = new PurchaseLedger({ storage: memoryStorage(), path: '/ledger.json', now: () => 100, id: () => 'r1' });
  await ledger.reserve({ key: 'drop', amount: 40, quantity: 1 });
  await ledger.uncertain('r1', { reason: 'confirmation-timeout' });
  assert.equal(await ledger.spentSince(0), 40);
  const duplicate = await ledger.reserve({ key: 'drop', amount: 40, quantity: 1 });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'order-uncertain');
});
