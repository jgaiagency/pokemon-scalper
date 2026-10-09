import test from 'node:test';
import assert from 'node:assert/strict';
import { MeasuredInventoryDiscoverySource } from '../../src/scalper/inventory-discovery.mjs';

function endpoint(productId, sku, maxPriceCents) {
  return {
    productId,
    site: 'bestbuy',
    pollUrl: `https://www.bestbuy.com/product/example/${sku}`,
    measuredAt: 100,
    metadata: {
      contract: {
        availableWhen: [{ path: 'offers[0].availability', equals: 'https://schema.org/InStock' }],
        priceUnit: 'dollars',
        fields: { priceCents: 'offers[0].price', sku: 'offers[0].sku', seller: 'offers[0].seller.name' },
      },
      policy: { maxPriceCents, sellerEquals: 'Best Buy' },
    },
  };
}

test('measured inventory discovery emits exact first-party products with per-product caps', async () => {
  const endpoints = [endpoint('p1', '111', 20000), endpoint('p2', '222', 6000)];
  const prices = { 111: 160.99, 222: 69.99 };
  const source = new MeasuredInventoryDiscoverySource({
    id: 'bb-direct', site: 'bestbuy', endpoints,
    products: [{ id: 'p1', name: 'Booster Box' }, { id: 'p2', name: 'ETB' }],
    httpForSite: () => ({ get: async (url) => {
      const sku = url.split('/').at(-1);
      return { status: 200, bodyJson: { offers: [{
        availability: 'https://schema.org/InStock', price: prices[sku], sku, seller: { name: 'Best Buy' },
      }] } };
    } }),
    samples: { append: async () => {} },
  });
  const items = await source.capture();
  assert.equal(items[0].id, 'bestbuy-111');
  assert.equal(items[0].price, 160.99);
  assert.equal(items[0].priceCap, 200);
  assert.equal(items[0].actionable, true);
  assert.equal(items[1].price, 69.99);
  assert.equal(items[1].priceCap, 60);
  assert.equal(items[1].actionable, false);
});

test('measured inventory discovery fails the source closed after a partial capture', async () => {
  const endpoints = [endpoint('p1', '111', 20000), endpoint('p2', '222', 6000)];
  const source = new MeasuredInventoryDiscoverySource({
    id: 'bb-direct', site: 'bestbuy', endpoints,
    products: [{ id: 'p1', name: 'Booster Box' }, { id: 'p2', name: 'ETB' }],
    httpForSite: () => ({ get: async (url) => url.endsWith('/222')
      ? { status: 503, bodyJson: {} }
      : { status: 200, bodyJson: { offers: [{
        availability: 'https://schema.org/InStock', price: 160.99, sku: '111', seller: { name: 'Best Buy' },
      }] } } }),
    samples: { append: async () => {} },
  });
  await assert.rejects(source.capture(), (error) => error.code === 'SCALPER_INVENTORY_PARTIAL');
});
