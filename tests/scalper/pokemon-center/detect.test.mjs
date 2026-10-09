import test from 'node:test';
import assert from 'node:assert/strict';
import { isAvailable, pollingDelayMs, pollForAvailability } from '../../../src/scalper/sites/pokemon-center/detect.mjs';

test('Pokémon Center detects an enabled add-to-cart response', () => {
  assert.equal(isAvailable({ availability: 'IN_STOCK', addToCartEnabled: true }), true);
  assert.equal(isAvailable({ bodyJson: { availability: 'IN_STOCK', addToCartEnabled: true } }), true);
});

test('Pokémon Center does not treat a merely existing product as in stock', () => {
  assert.equal(isAvailable({ availability: 'OUT_OF_STOCK', addToCartEnabled: false, name: 'ETB' }), false);
});

test('Pokémon Center polling uses jittered pre-drop, T-0, and surprise cadence', async () => {
  assert.ok(pollingDelayMs({ mode: 'scheduled', untilDropMs: 60_000, random: () => 0.5 }) >= 1_800);
  assert.equal(pollingDelayMs({ mode: 'scheduled', untilDropMs: 0, random: () => 0.5 }), 200);
  assert.equal(pollingDelayMs({ mode: 'surprise', random: () => 0.5 }), 5_000);
  let calls = 0;
  const result = await pollForAvailability({
    http: { get: async () => (++calls === 2 ? { availability: 'IN_STOCK', addToCartEnabled: true } : { availability: 'OUT_OF_STOCK' }) },
    productUrl: 'https://example.test/p', sleep: async () => {}, maxPolls: 2,
  });
  assert.equal(result.available, true);
  assert.equal(calls, 2);
});
