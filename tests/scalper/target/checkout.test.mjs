import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutProduct } from '../../../src/scalper/sites/target/checkout.mjs';

test('Target live checkout uses an injected visible system-Chrome browser', async () => {
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '1' }, browser: { checkout: async (options) => ({ orderId: options.headless === false && options.channel === 'chrome' ? 'o1' : null }) } });
  assert.equal(result.orderId, 'o1');
});

test('Target paper checkout does not require DataDome or browser transports', async () => {
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '0' }, dryRun: { execute: async () => ({ status: 'paper-confirmed' }) } });
  assert.equal(result.status, 'paper-confirmed');
});
