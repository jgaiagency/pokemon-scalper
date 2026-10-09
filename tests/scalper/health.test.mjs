import test from 'node:test';
import assert from 'node:assert/strict';
import { runHealthCheck } from '../../src/scalper/health.mjs';

test('health reports clock, sessions, account configuration, and recent drops', async () => {
  const report = await runHealthCheck({
    clock: { driftMs: () => 12, isSynchronized: () => true },
    accounts: { allAccounts: async () => [{ id: 'a1', email: 'buyer@example.com' }], loadSession: async () => ({ expiresAt: 2_000 }) },
    calendar: { allDrops: async () => [{ id: 'd1', time: new Date(900).toISOString(), status: 'purchased' }] },
    now: () => 1_000,
  });
  assert.equal(report.ok, true);
  assert.equal(report.clock.driftMs, 12);
  assert.equal(report.sessions.valid, 1);
  assert.equal(report.recentDrops.length, 1);
});

test('health is not OK when drift is excessive or an account lacks a valid session', async () => {
  const report = await runHealthCheck({
    clock: { driftMs: () => 150, isSynchronized: () => true },
    accounts: { allAccounts: async () => [{ id: 'a1', email: '' }], loadSession: async () => null },
    calendar: { allDrops: async () => [] }, now: () => 1_000,
  });
  assert.equal(report.ok, false);
  assert.equal(report.accounts.configured, 0);
  assert.equal(report.sessions.invalid, 1);
});

test('health includes operational metrics and durable purchase-ledger state when wired', async () => {
  const report = await runHealthCheck({
    clock: { driftMs: () => 0, isSynchronized: () => true },
    accounts: { allAccounts: async () => [], loadSession: async () => null },
    calendar: { allDrops: async () => [] },
    metrics: { snapshot: () => ({ counters: [{ name: 'checkout_attempts', value: 1 }] }) },
    ledger: { records: async () => [{ status: 'reserved' }, { status: 'purchased' }, { status: 'failed' }] },
    now: () => 100,
  });
  assert.equal(report.metrics.counters[0].name, 'checkout_attempts');
  assert.deepEqual(report.purchaseLedger, { total: 3, reserved: 1, purchased: 1, failed: 1, uncertain: 0 });
});

test('paper health distinguishes operational readiness from live account readiness', async () => {
  const dependencies = {
    clock: { driftMs: () => 0, isSynchronized: () => true },
    accounts: { allAccounts: async () => [{ id: 'a1', email: 'replace-me@example.com' }], loadSession: async () => null },
    calendar: { allDrops: async () => [] },
  };
  const paper = await runHealthCheck({ ...dependencies, env: { SCALPER_LIVE: '0' } });
  const live = await runHealthCheck({ ...dependencies, env: { SCALPER_LIVE: '1' } });
  assert.equal(paper.ok, true);
  assert.equal(paper.liveReady, false);
  assert.equal(live.ok, false);
});
