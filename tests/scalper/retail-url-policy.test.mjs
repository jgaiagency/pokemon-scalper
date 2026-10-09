import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailUrlPolicy, isRetailerUrl } from '../../src/scalper/retail-url-policy.mjs';

test('retailer URL policy accepts exact retailer domains and rejects lookalikes and marketplaces', () => {
  assert.equal(isRetailerUrl('https://www.target.com/p/item/-/A-1', 'target'), true);
  assert.equal(isRetailerUrl('https://target.com.evil.example/item', 'target'), false);
  assert.equal(isRetailerUrl('http://www.target.com/p/item/-/A-1', 'target'), false);
  assert.equal(isRetailerUrl('https://user:secret@www.target.com/p/item/-/A-1', 'target'), false);
  assert.equal(isRetailerUrl('https://ebay.com/item/1', 'target'), false);
  assert.equal(isRetailerUrl('https://ebay.com/item/1', 'ebay'), false);
});

test('retailer URL policy fails product signals closed when resolution did not reach the named retailer', () => {
  const policy = createRetailUrlPolicy();
  assert.equal(policy({
    signal: { kind: 'restock', site: 'target', url: 'https://buff.ly/unresolved' },
  }), null);
  assert.equal(policy({
    signal: { kind: 'restock', site: 'target', url: 'https://www.target.com/p/item' },
  }).signal.site, 'target');
});

test('retailer URL policy removes invalid official product links and keeps valid ones', () => {
  const policy = createRetailUrlPolicy();
  const parsed = policy({
    signal: {
      kind: 'products-live', site: 'pokemon-center', products: [
        { label: 'ETB', url: 'https://www.pokemoncenter.com/product/1' },
        { label: 'listing', url: 'https://www.ebay.com/item/2' },
      ],
    },
  });
  assert.deepEqual(parsed.signal.products.map((product) => product.label), ['ETB']);
});
