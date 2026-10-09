import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutProduct } from '../../../src/scalper/sites/pokemon-center/checkout.mjs';

const address = { line1: '1 Main', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' };
const product = {
  id: 'p1', sku: 'SKU-1', seller: 'Pokémon Center', purchaseQuantity: 1,
  maxTotalCents: 7_000, fulfillment: 'shipping', shippingExpected: true, taxExpected: true,
};
const account = { id: 'a1', address };
const cart = {
  cartId: 'cart-1', items: [{ sku: 'SKU-1', productId: 'p1', seller: 'Pokémon Center', quantity: 1 }],
  totalCents: 6_499, shippingCents: 500, taxCents: 400, address, fulfillment: 'shipping',
};

function attestableApi(api) {
  return { getCart: async () => structuredClone(cart), ...api };
}

test('Pokémon Center live checkout is API-first', async () => {
  const steps = [];
  const result = await checkoutProduct({ env: { SCALPER_LIVE: '1' }, product, account, api: attestableApi({
    addToCart: async () => steps.push('cart'), submitOrder: async () => { steps.push('order'); return { orderId: 'o1' }; },
  }), browser: { checkout: async () => { throw new Error('unused'); } } });
  assert.deepEqual(steps, ['cart', 'order']);
  assert.equal(result.orderId, 'o1');
});

test('Pokémon Center falls back to the injectable browser and paper mode calls neither', async () => {
  let browserCalls = 0;
  const fallback = await checkoutProduct({ env: { SCALPER_LIVE: '1' }, product, account,
    api: { addToCart: async () => { throw new Error('WAF'); } }, browser: { checkout: async () => { browserCalls += 1; return { orderId: 'browser-1' }; } },
  });
  assert.equal(fallback.orderId, 'browser-1');
  const paper = await checkoutProduct({ env: { SCALPER_LIVE: 'true' }, product, account, dryRun: { execute: async () => ({ status: 'paper-confirmed' }) } });
  assert.equal(paper.status, 'paper-confirmed');
  assert.equal(browserCalls, 1);
});

test('Pokémon Center never falls back to a second transport after API submission starts', async () => {
  let browserCalls = 0;
  await assert.rejects(checkoutProduct({
    env: { SCALPER_LIVE: '1' }, product, account,
    api: attestableApi({ addToCart: async () => ({ id: 'cart-1' }), submitOrder: async () => { throw new Error('connection reset'); } }),
    browser: { checkout: async () => { browserCalls += 1; return { orderId: 'duplicate' }; } },
  }), (error) => error.code === 'SCALPER_ORDER_STATUS_UNCERTAIN');
  assert.equal(browserCalls, 0);
});

test('Pokémon Center treats a post-submit response without an order ID as uncertain', async () => {
  let submissions = 0;
  await assert.rejects(checkoutProduct({
    env: { SCALPER_LIVE: '1' }, product, account,
    api: attestableApi({
      addToCart: async () => ({ id: 'cart-1' }),
      submitOrder: async () => { submissions += 1; return { status: 'accepted' }; },
    }),
  }), (error) => error.code === 'SCALPER_ORDER_STATUS_UNCERTAIN');
  assert.equal(submissions, 1);
});

test('Pokémon Center attests the fetched cart and never submits a defective cart', async () => {
  let submissions = 0;
  const result = await checkoutProduct({
    env: { SCALPER_LIVE: '1' },
    product: {
      id: 'p1', sku: 'SKU-1', seller: 'Pokémon Center', purchaseQuantity: 1, maxTotalCents: 7000,
      fulfillment: 'shipping',
    },
    account: { id: 'a1', address: { line1: '1 Main', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' } },
    api: {
      addToCart: async () => ({ cartId: 'cart-1', items: [] }),
      getCart: async () => ({
        items: [{ sku: 'STALE', productId: 'other', seller: 'Marketplace', quantity: 1 }],
        totalCents: 8000, shippingCents: 0, taxCents: 0,
        address: { line1: 'Wrong' }, fulfillment: 'pickup',
      }),
      submitOrder: async () => { submissions += 1; return { orderId: 'should-not-happen' }; },
    },
  });
  assert.equal(result.status, 'safety-blocked');
  assert.equal(result.reason, 'cart-attestation');
  assert.ok(result.defects.length > 0);
  assert.equal(submissions, 0);
});
