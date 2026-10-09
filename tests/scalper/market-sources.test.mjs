import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEbayBrowseSource,
  createTcgplayerMarketSource,
} from '../../src/scalper/market-sources.mjs';

test('TCGplayer source obtains one bearer token, caches it, and returns official SKU market price', async () => {
  const calls = [];
  const http = {
    request: async (request) => {
      calls.push(request);
      return { status: 200, bodyJson: { access_token: 'bearer', expires_in: 3600 } };
    },
    get: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, bodyJson: { success: true, results: [{ productConditionId: 123, price: 79.99, lowestRange: 70, highestRange: 90 }] } };
    },
  };
  const source = createTcgplayerMarketSource({ http, publicKey: 'public', privateKey: 'private', now: () => 1_000 });
  const product = { id: 'p1', sources: { tcgplayer: { skuId: 123 } } };
  const first = await source.quote(product);
  await source.quote(product);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(first.price, 79.99);
  assert.equal(first.kind, 'market-price');
  assert.equal(first.metadata.skuId, 123);
});

test('eBay Browse source labels active listings honestly and includes shipping in median asking price', async () => {
  const source = createEbayBrowseSource({
    http: {
      request: async () => ({ status: 200, bodyJson: { access_token: 'ebay-token', expires_in: 3600 } }),
      get: async () => ({
        status: 200,
        bodyJson: {
          total: 3,
          itemSummaries: [
            { price: { value: '80' }, shippingOptions: [{ shippingCost: { value: '5' } }] },
            { price: { value: '100' }, shippingOptions: [{ shippingCost: { value: '0' } }] },
            { price: { value: '120' }, shippingOptions: [{ shippingCost: { value: '10' } }] },
          ],
        },
      }),
    },
    clientId: 'id', clientSecret: 'secret', now: () => 2_000,
  });
  const quote = await source.quote({ id: 'p1', sources: { ebay: { query: 'Pokemon sealed ETB' } } });
  assert.equal(quote.price, 100);
  assert.equal(quote.kind, 'active-listing');
  assert.equal(quote.confidence, 0.35);
  assert.equal(quote.sampleSize, 3);
});

test('TCGplayer source resolves an unambiguous product id to its SKU before pricing', async () => {
  const urls = [];
  const source = createTcgplayerMarketSource({
    http: {
      request: async () => ({ status: 200, bodyJson: { access_token: 'token', expires_in: 3600 } }),
      get: async (url) => {
        urls.push(url);
        if (url.includes('/catalog/products/704171/skus')) {
          return { status: 200, bodyJson: { results: [{ skuId: 9001, productId: 704171, languageId: 1, conditionId: 1 }] } };
        }
        return { status: 200, bodyJson: { results: [{ productConditionId: 9001, price: 90 }] } };
      },
    },
    publicKey: 'public', privateKey: 'private', now: () => 1_000,
  });
  const quote = await source.quote({ id: 'bundle', sources: { tcgplayer: { productId: 704171 } } });
  assert.equal(quote.price, 90);
  assert.ok(urls[0].endsWith('/catalog/products/704171/skus'));
  assert.ok(urls[1].endsWith('/pricing/marketprices/9001'));
});
