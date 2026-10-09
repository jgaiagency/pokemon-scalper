import test from 'node:test';
import assert from 'node:assert/strict';
import { isAvailable, pollingDelayMs, pollForAvailability } from '../../../src/scalper/sites/target/detect.mjs';

test('Target detects positive available-to-promise inventory', () => {
  assert.equal(isAvailable({ availableToPromise: 3, fulfillment: { shipping: 'AVAILABLE' } }), true);
  assert.equal(isAvailable({ bodyJson: { availableToPromise: 3, fulfillment: { shipping: 'AVAILABLE' } } }), true);
});

test('Target does not treat notify-me metadata as availability', () => {
  assert.equal(isAvailable({ availableToPromise: 0, fulfillment: { shipping: 'UNAVAILABLE' }, notifyMe: true }), false);
});

test('Target surprise polling uses jittered five-second cadence', async () => {
  assert.equal(pollingDelayMs({ mode: 'surprise', random: () => 0.5 }), 5_000);
  const result = await pollForAvailability({ http: { get: async () => ({ availableToPromise: 1, fulfillment: { shipping: 'AVAILABLE' } }) }, productUrl: 'x', maxPolls: 1 });
  assert.equal(result.available, true);
});
