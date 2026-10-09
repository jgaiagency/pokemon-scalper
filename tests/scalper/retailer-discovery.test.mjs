import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BestBuySearchSource,
  DiscoveryCatalogStore,
  RetailerDiscoveryTracker,
  TargetSearchSource,
  createTargetSearchUrl,
  parseBestBuySearchHtml,
  parseTargetSearchJson,
} from '../../src/scalper/retailer-discovery.mjs';

const TEST_TARGET_KEY = 'test-public-client-key';

function bestBuyFixture(buttonState = 'SOLD_OUT', price = 26.99, sellerClassification = '1P') {
  return `<html><script>(window[Symbol.for("ApolloSSRDataTransport")] ??= []).push({"optional":undefined,"events":[{"value":{"data":{"search":{"documents":[{"product":{"skuId":"123","name":{"short":"Pokémon - 30th Celebration Booster Bundle"},"seller":{"classification":"${sellerClassification}"},"fulfillmentOptions":{"buttonStates":[{"buttonState":"${buttonState}"}]}},"price":{"customerPrice":${price}},"pdpUrl":"https://www.bestbuy.com/product/example/sku/123"},{"product":{"skuId":"999","name":{"short":"Unrelated Headphones"},"seller":{"classification":"1P"},"fulfillmentOptions":{"buttonStates":[{"buttonState":"ADD_TO_CART"}]}},"price":{"customerPrice":10},"pdpUrl":"https://www.bestbuy.com/product/other/sku/999"}]}}}}]});</script></html>`;
}

test('Best Buy discovery parses Apollo search data and filters configured products', () => {
  const items = parseBestBuySearchHtml(bestBuyFixture('IN_STORE_ONLY'), { include: ['30th Celebration'] });
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    site: 'bestbuy', id: 'bestbuy-123', sku: '123',
    name: 'Pokémon - 30th Celebration Booster Bundle',
    url: 'https://www.bestbuy.com/product/example/sku/123',
    price: 26.99,
    state: 'IN_STORE_ONLY', states: ['IN_STORE_ONLY'],
    sellerClassification: '1P', retailSeller: true, withinPriceCap: true,
    actionable: true, fulfillment: 'in-store',
  });
});

test('Best Buy discovery fails closed for marketplace offers and prices above the ceiling', () => {
  const [marketplace] = parseBestBuySearchHtml(bestBuyFixture('ADD_TO_CART', 26.99, '3P'), { include: ['30th Celebration'] });
  assert.equal(marketplace.retailSeller, false);
  assert.equal(marketplace.actionable, false);

  const [overpriced] = parseBestBuySearchHtml(bestBuyFixture('ADD_TO_CART', 99.99), {
    include: ['30th Celebration'], maxPrice: 40,
  });
  assert.equal(overpriced.withinPriceCap, false);
  assert.equal(overpriced.actionable, false);
});

test('Best Buy discovery can retain in-store inventory without treating it as online actionable', () => {
  const [item] = parseBestBuySearchHtml(bestBuyFixture('IN_STORE_ONLY'), {
    include: ['30th Celebration'], onlineOnly: true,
  });
  assert.equal(item.fulfillment, 'in-store');
  assert.equal(item.retailSeller, true);
  assert.equal(item.actionable, false);
});

test('Best Buy discovery excludes accessories from product searches', () => {
  const html = bestBuyFixture('ADD_TO_CART').replace(
    'Pokémon - 30th Celebration Booster Bundle',
    'Premium Acrylic Display Case for Pokémon 30th Celebration Booster Bundle',
  );
  assert.deepEqual(parseBestBuySearchHtml(html, {
    include: ['30th Celebration'],
    exclude: ['Display Case', 'Acrylic'],
  }), []);
});

test('Best Buy source fails closed when a response loses structured products', async () => {
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test', include: ['30th Celebration'],
    http: { get: async () => ({ status: 200, body: '<html>challenge</html>' }) },
  });
  await assert.rejects(source.capture(), (error) => error.code === 'SCALPER_DISCOVERY_EMPTY');
});

test('Best Buy source can accept a verified structured search with zero policy matches', async () => {
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test', include: ['Does Not Exist'], allowEmpty: true,
    http: { get: async () => ({ status: 200, body: bestBuyFixture('ADD_TO_CART') }) },
  });
  assert.deepEqual(await source.capture(), []);
});

test('Best Buy source requires a watchlist match when configured', async () => {
  const body = bestBuyFixture('ADD_TO_CART');
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test', include: ['30th Celebration'],
    watchlistOnly: true,
    productMatcher: () => null,
    http: { get: async () => ({ status: 200, body }) },
  });
  const [item] = await source.capture();
  assert.equal(item.retailSeller, true);
  assert.equal(item.onWatchlist, false);
  assert.equal(item.actionable, false);
});

test('Best Buy verifies only policy-eligible candidates and fails closed on verification errors', async () => {
  let requests = 0;
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test/search', include: ['30th Celebration'],
    onlineOnly: true, retailOnly: true, watchlistOnly: true,
    productMatcher: () => ({ id: '30th-bundle' }),
    http: { get: async () => {
      requests += 1;
      return requests === 1 ? { status: 200, body: bestBuyFixture('ADD_TO_CART') } : { status: 503, body: '' };
    } },
  });
  const [item] = await source.capture();
  assert.equal(requests, 2);
  assert.equal(item.verified, false);
  assert.equal(item.actionable, false);
});

test('Best Buy enforces a matched product retailer cap before product-page verification', async () => {
  let requests = 0;
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test/search', include: ['30th Celebration'],
    onlineOnly: true, retailOnly: true, watchlistOnly: true,
    productMatcher: () => ({ id: '30th-bundle', maxPriceBySite: { bestbuy: 25 } }),
    http: { get: async () => {
      requests += 1;
      return { status: 200, body: bestBuyFixture('ADD_TO_CART', 26.99) };
    } },
  });
  const [item] = await source.capture();
  assert.equal(requests, 1);
  assert.equal(item.priceCap, 25);
  assert.equal(item.withinPriceCap, false);
  assert.equal(item.actionable, false);
  assert.equal(item.verificationSkipped, 'not-search-actionable');
});

test('Best Buy rechecks the matched product retailer cap against the verified price', async () => {
  let requests = 0;
  const source = new BestBuySearchSource({
    id: 'bb', url: 'https://example.test/search', include: ['30th Celebration'],
    onlineOnly: true, retailOnly: true, watchlistOnly: true,
    productMatcher: () => ({ id: '30th-bundle', maxPriceBySite: { bestbuy: 30 } }),
    http: { get: async () => {
      requests += 1;
      return {
        status: 200,
        body: requests === 1
          ? bestBuyFixture('ADD_TO_CART', 26.99)
          : bestBuyFixture('ADD_TO_CART', 39.99),
      };
    } },
  });
  const [item] = await source.capture();
  assert.equal(requests, 2);
  assert.equal(item.price, 39.99);
  assert.equal(item.priceCap, 30);
  assert.equal(item.withinPriceCap, false);
  assert.equal(item.actionable, false);
  assert.equal(item.verified, true);
});

test('finite price caps fail closed when structured price is missing', () => {
  const html = bestBuyFixture('ADD_TO_CART', 26.99).replace('"customerPrice":26.99', '"customerPrice":null');
  const [item] = parseBestBuySearchHtml(html, { include: ['30th Celebration'], maxPrice: 40 });
  assert.equal(item.price, null);
  assert.equal(item.withinPriceCap, false);
  assert.equal(item.actionable, false);
});

test('discovery alerts only on actionable transitions and price drops', async () => {
  let items = parseBestBuySearchHtml(bestBuyFixture(), { include: ['30th Celebration'] });
  let state = { version: 1, sources: {} };
  const sent = [];
  const tracker = new RetailerDiscoveryTracker({
    sources: [{ id: 'bb', site: 'bestbuy', capture: async () => items }],
    store: { load: async () => state, save: async (value) => { state = value; } },
    alerts: { dropDetected: async (details) => sent.push(details) },
    now: () => 100,
  });

  const primed = await tracker.capture();
  assert.equal(primed.alerts.length, 0);

  items = parseBestBuySearchHtml(bestBuyFixture('ADD_TO_CART'), { include: ['30th Celebration'] });
  const available = await tracker.capture();
  assert.equal(available.alerts.length, 1);
  assert.equal(sent[0].sku, '123');

  const unchanged = await tracker.capture();
  assert.equal(unchanged.alerts.length, 0);

  items = parseBestBuySearchHtml(bestBuyFixture('ADD_TO_CART', 24.99), { include: ['30th Celebration'] });
  const cheaper = await tracker.capture();
  assert.equal(cheaper.alerts.length, 1);
});

test('discovery can intentionally notify current actionable inventory on first capture', async () => {
  const items = parseBestBuySearchHtml(bestBuyFixture('IN_STORE_ONLY'), { include: ['30th Celebration'] });
  const sent = [];
  const tracker = new RetailerDiscoveryTracker({
    sources: [{ id: 'bb', site: 'bestbuy', capture: async () => items }],
    store: { load: async () => ({ version: 1, sources: {} }), save: async () => {} },
    alerts: { dropDetected: async (details) => sent.push(details) },
  });
  const result = await tracker.capture({ notifyCurrent: true });
  assert.equal(result.alerts.length, 1);
  assert.equal(sent.length, 1);
});

test('discovery delegates actionable transitions to the paper execution seam', async () => {
  const items = parseBestBuySearchHtml(bestBuyFixture('ADD_TO_CART'), { include: ['30th Celebration'] });
  const executed = [];
  const tracker = new RetailerDiscoveryTracker({
    sources: [{ id: 'bb', site: 'bestbuy', capture: async () => items }],
    store: { load: async () => ({ version: 1, sources: {} }), save: async () => {} },
    onActionable: async (item) => { executed.push(item); return { status: 'paper-confirmed' }; },
  });
  const result = await tracker.capture({ notifyCurrent: true });
  assert.equal(executed[0].sourceId, 'bb');
  assert.equal(result.executions[0].status, 'paper-confirmed');
});

test('independent retailer sources capture concurrently', async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const source = (id) => ({ id, site: 'bestbuy', capture: async () => { started.push(id); await gate; return []; } });
  const tracker = new RetailerDiscoveryTracker({
    sources: [source('one'), source('two')],
    store: { load: async () => ({ version: 1, sources: {} }), save: async () => {} },
  });
  const pending = tracker.capture();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['one', 'two']);
  release();
  assert.equal((await pending).sources, 2);
});

test('discovery catalog retains configured real URLs without treating unmeasured products as actionable', async () => {
  let document;
  const store = new DiscoveryCatalogStore({
    path: '/catalog.json',
    configuredProducts: [{ site: 'target', id: 'target-1', name: 'Target ETB', url: 'https://www.target.com/p/-/A-1', actionable: true }],
  });
  // Replace only the filesystem method for this focused policy assertion.
  store.path = `/tmp/scalper-catalog-${process.pid}-${Date.now()}.json`;
  await store.save({ capturedAt: 100, sources: {} });
  document = JSON.parse(await (await import('node:fs/promises')).readFile(store.path, 'utf8'));
  assert.equal(document.products[0].observed, false);
  assert.equal(document.products[0].actionable, false);
});

function targetFixture() {
  return {
    layout: { zones: [{ modules: [{ module_data: { items: [{
      __typename: 'ProductListing',
      tcin: '987',
      accessibility_text: 'Pokemon 30th Celebration Booster Bundle',
      click_interactions: [{ __typename: 'Navigation', url: '/p/example/-/A-987' }],
      sections: {
        CONTENT: { content: [{ price_and_promo_element: { rows: [{ text: { contents: [{ insert: { text: '$26.99' } }] } }] } }] },
        ACTION_FOOTER: { content: [{ call_to_action: { __typename: 'DefaultAddToCart', product_title: '30th Celebration Booster Bundle', purchase_limit: 2 } }] },
      },
    }] } }] }] },
  };
}

test('Target discovery parses public search products and enforces the configured price cap', () => {
  const [item] = parseTargetSearchJson(targetFixture(), { include: ['30th Celebration'], maxPrice: 30 });
  assert.deepEqual(item, {
    site: 'target', id: 'target-987', tcin: '987',
    name: 'Pokemon 30th Celebration Booster Bundle',
    url: 'https://www.target.com/p/example/-/A-987',
    price: 26.99,
    state: 'DefaultAddToCart', states: ['DefaultAddToCart'],
    actionable: true, fulfillment: 'online', purchaseLimit: 2, withinPriceCap: true,
  });
  assert.equal(parseTargetSearchJson(targetFixture(), { include: ['30th Celebration'], maxPrice: 20 })[0].actionable, false);
});

test('Target source uses a generated visitor id and fails closed on empty structured results', async () => {
  let requestedUrl;
  const source = new TargetSearchSource({
    id: 'target', query: 'pokemon 30th celebration', include: ['30th Celebration'],
    apiKey: TEST_TARGET_KEY,
    visitorIdFactory: () => 'A'.repeat(32),
    http: { get: async (url) => { requestedUrl = url; return { status: 200, bodyJson: {} }; } },
  });
  await assert.rejects(source.capture(), (error) => error.code === 'SCALPER_DISCOVERY_EMPTY');
  assert.equal(new URL(requestedUrl).searchParams.get('visitor_id'), 'A'.repeat(32));
  assert.equal(new URL(createTargetSearchUrl({ query: 'pokemon cards', apiKey: TEST_TARGET_KEY, visitorId: 'B'.repeat(32) })).searchParams.get('keyword'), 'pokemon cards');
  assert.throws(
    () => createTargetSearchUrl({ query: 'pokemon cards' }),
    /locally configured public client key/,
  );
});

test('Target source can monitor a not-yet-listed exact product without hiding malformed responses', async () => {
  const source = new TargetSearchSource({
    id: 'target', query: 'future product', include: ['Future Product'], allowEmpty: true,
    apiKey: TEST_TARGET_KEY,
    visitorIdFactory: () => 'C'.repeat(32),
    http: { get: async () => ({ status: 200, bodyJson: { layout: { zones: [] } } }) },
  });
  assert.deepEqual(await source.capture(), []);

  const malformed = new TargetSearchSource({
    id: 'target', query: 'future product', include: ['Future Product'], allowEmpty: true,
    apiKey: TEST_TARGET_KEY,
    visitorIdFactory: () => 'D'.repeat(32),
    http: { get: async () => ({ status: 200, bodyJson: {} }) },
  });
  await assert.rejects(malformed.capture(), (error) => error.code === 'SCALPER_DISCOVERY_EMPTY');
});

test('Target source applies the matched product retailer cap', async () => {
  const source = new TargetSearchSource({
    id: 'target', query: 'pokemon 30th celebration', include: ['30th Celebration'],
    apiKey: TEST_TARGET_KEY,
    watchlistOnly: true,
    productMatcher: () => ({ id: '30th-bundle', maxPriceBySite: { target: 25 } }),
    visitorIdFactory: () => 'E'.repeat(32),
    http: { get: async () => ({ status: 200, bodyJson: targetFixture() }) },
  });
  const [item] = await source.capture();
  assert.equal(item.productId, '30th-bundle');
  assert.equal(item.priceCap, 25);
  assert.equal(item.withinPriceCap, false);
  assert.equal(item.actionable, false);
});

test('discovery fail-closes legacy stored items when a retail/watchlist source cannot refresh', async () => {
  let saved;
  const tracker = new RetailerDiscoveryTracker({
    sources: [{
      id: 'bb', site: 'bestbuy', retailOnly: true, watchlistOnly: true, maxPrice: 100,
      capture: async () => { throw new Error('offline'); },
    }],
    store: {
      load: async () => ({ version: 1, sources: { bb: { items: [{ id: 'legacy', price: 20, actionable: true }] } } }),
      save: async (value) => { saved = value; },
    },
  });
  await tracker.capture();
  assert.equal(saved.sources.bb.items[0].actionable, false);
  assert.equal(saved.sources.bb.items[0].policyStale, true);
});
