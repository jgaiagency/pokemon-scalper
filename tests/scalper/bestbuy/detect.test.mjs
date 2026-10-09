import test from 'node:test';
import assert from 'node:assert/strict';
import { isAvailable, pollingDelayMs, pollForAvailability } from '../../../src/scalper/sites/bestbuy/detect.mjs';

test('Best Buy detects a purchasable add-to-cart state', () => {
  assert.equal(isAvailable({ purchasable: true, buttonState: 'ADD_TO_CART' }), true);
  assert.equal(isAvailable({ bodyJson: { purchasable: true, buttonState: 'ADD_TO_CART' } }), true);
});

test('Best Buy does not mistake coming-soon or sold-out states for stock', () => {
  assert.equal(isAvailable({ purchasable: false, buttonState: 'COMING_SOON' }), false);
  assert.equal(isAvailable({ purchasable: false, buttonState: 'SOLD_OUT' }), false);
});

test('Best Buy scheduled polling accelerates to 200ms near T-0', async () => {
  assert.equal(pollingDelayMs({ mode: 'scheduled', untilDropMs: 60_000, random: () => 0.5 }), 1_000);
  assert.equal(pollingDelayMs({ mode: 'scheduled', untilDropMs: 30_000, random: () => 0.5 }), 200);
  const result = await pollForAvailability({ http: { get: async () => ({ purchasable: false }) }, productUrl: 'x', sleep: async () => {}, maxPolls: 1 });
  assert.equal(result.available, false);
});
