import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const discovery = await readJson('../../config/scalper-discovery.json');
const watchlist = await readJson('../../config/scalper-watchlist.json');
const endpoints = await readJson('../../config/scalper-product-endpoints.json');

const suppliedProducts = [
  ['target', 'target-1010892069', '30th-tin', 40],
  ['target', 'target-1010892076', '30th-etb', 80],
  ['target', 'target-95120834', 'ah-booster-bundle', 40],
  ['target', 'target-94886127', 'me-booster-display', 200],
  ['target', 'target-95082118', 'ah-etb', 75],
  ['target', 'target-1012055696', 'pe-super-premium', 150],
  ['bestbuy', 'bestbuy-6639109', 'me-booster-display', 200],
  ['bestbuy', 'bestbuy-6621081', 'pe-super-premium', 130],
  ['bestbuy', 'bestbuy-6606082', 'pe-etb', 60],
  ['bestbuy', 'bestbuy-6645341', 'phantasmal-flames-booster-display', 190],
];

test('the supplied first-party product URLs retain their exact retailer price ceilings', () => {
  for (const [site, id, productId, maxPrice] of suppliedProducts) {
    const configured = discovery.products.find((product) => product.site === site && product.id === id);
    assert.ok(configured, `${site}/${id}`);
    assert.equal(configured.productId, productId, `${site}/${id} product mapping`);
    assert.equal(configured.maxPrice, maxPrice, `${site}/${id} price ceiling`);
    assert.match(configured.url, site === 'target' ? /^https:\/\/www\.target\.com\// : /^https:\/\/www\.bestbuy\.com\//);

    const product = watchlist.products.find((candidate) => candidate.id === productId);
    assert.equal(product?.maxPriceBySite?.[site], maxPrice, `${productId}/${site} watchlist ceiling`);
  }
});

test('each supplied Best Buy product has a measured first-party endpoint policy', () => {
  for (const [site, , productId, maxPrice] of suppliedProducts.filter(([site]) => site === 'bestbuy')) {
    const endpoint = endpoints.endpoints.find((candidate) => candidate.site === site && candidate.productId === productId);
    assert.ok(endpoint, `${site}/${productId}`);
    assert.equal(endpoint.metadata.contract.priceUnit, 'dollars');
    assert.equal(endpoint.metadata.policy.maxPriceCents, maxPrice * 100);
    assert.equal(endpoint.metadata.policy.sellerEquals, 'Best Buy');
  }
});
