import test from 'node:test';
import assert from 'node:assert/strict';
import { isAvailable, pollingDelayMs, pollForAvailability } from '../../../src/scalper/sites/tcgplayer/detect.mjs';

test('TCGPlayer detects a positive listing quantity', () => {
  assert.equal(isAvailable({ listings: [{ quantity: 2 }] }), true);
  assert.equal(isAvailable({ bodyJson: { listings: [{ quantity: 2 }] } }), true);
});

test('TCGPlayer does not detect empty or zero-quantity listings', () => {
  assert.equal(isAvailable({ listings: [{ quantity: 0 }] }), false);
  assert.equal(isAvailable({ listings: [] }), false);
});

test('TCGPlayer polls surprise listings every jittered five seconds', async () => {
  assert.equal(pollingDelayMs({ mode: 'surprise', random: () => 0.5 }), 5_000);
  let calls = 0;
  const result = await pollForAvailability({ http: { get: async () => ({ listings: [{ quantity: ++calls === 2 ? 1 : 0 }] }) }, productUrl: 'x', sleep: async () => {}, maxPolls: 2 });
  assert.equal(result.available, true);
});
