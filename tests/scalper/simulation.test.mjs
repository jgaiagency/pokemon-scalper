import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulationSuite } from '../../src/scalper/simulation.mjs';

test('simulation suite proves success and failure behavior without accounts, cards, or external mutations', async () => {
  const report = await runSimulationSuite();
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, {
    passed: 7,
    failed: 0,
    total: 7,
    realAccountsUsed: 0,
    realCardsUsed: 0,
    externalMutations: 0,
  });
  assert.deepEqual(report.scenarios.map((scenario) => scenario.name), [
    'discord-to-target-paper-order',
    'all-retailer-paper-checkouts',
    'out-of-stock-fails-closed',
    'duplicate-suppression',
    'kill-switch-fails-closed',
    'invalid-and-noisy-signals-are-rejected',
    'alert-outage-does-not-repeat-order',
  ]);
  assert.equal(report.scenarios.every((scenario) => scenario.ok), true);
});
