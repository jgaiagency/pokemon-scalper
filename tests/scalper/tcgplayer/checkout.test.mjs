import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutProduct } from '../../../src/scalper/sites/tcgplayer/checkout.mjs';

test('TCGPlayer live checkout delegates to the injected browser interface', async () => {
  const options = [];
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '1' }, product: { id: 'p1' }, account: { id: 'a1' }, browser: { checkout: async (value) => { options.push(value); return { orderId: 'o1' }; } } });
  assert.equal(result.orderId, 'o1');
  assert.equal(options[0].channel, 'chrome');
  assert.equal(options[0].headless, false);
});

test('TCGPlayer paper checkout cannot invoke the browser', async () => {
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '0' }, dryRun: { execute: async () => ({ status: 'paper-confirmed' }) }, browser: { checkout: async () => { throw new Error('must not run'); } } });
  assert.equal(result.status, 'paper-confirmed');
});
