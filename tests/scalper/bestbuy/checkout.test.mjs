import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutProduct } from '../../../src/scalper/sites/bestbuy/checkout.mjs';

test('Best Buy live checkout uses persistent real Chrome settings', async () => {
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '1' }, browser: { checkout: async (options) => ({ orderId: options.preserveCookies && options.channel === 'chrome' ? 'o1' : null }) } });
  assert.equal(result.orderId, 'o1');
});

test('Best Buy paper checkout has no browser side effect', async () => {
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '0' }, dryRun: { execute: async () => ({ status: 'paper-confirmed' }) } });
  assert.equal(result.status, 'paper-confirmed');
});
