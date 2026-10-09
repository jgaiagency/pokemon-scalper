import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InventorySampleStore,
  InventoryScanner,
  parseMeasuredInventory,
  scanInventoryWithConfiguredTransport,
} from '../../src/scalper/inventory-scanner.mjs';

const endpoint = {
  productId: 'pc-etb', site: 'pokemon-center', pollUrl: 'https://www.pokemoncenter.com/api/measured-etb', measuredAt: 100,
  metadata: { contract: {
    availableWhen: [{ path: 'availability', equals: 'IN_STOCK' }, { path: 'addToCartEnabled', equals: true }],
    fields: { quantity: 'inventory.quantity', priceCents: 'price.cents', sku: 'sku', seller: 'seller', fulfillment: 'fulfillment' },
  } },
};

test('a measured direct endpoint yields richer inventory than a Discord ping', () => {
  const observation = parseMeasuredInventory({ status: 200, bodyJson: {
    availability: 'IN_STOCK', addToCartEnabled: true, inventory: { quantity: 7 }, price: { cents: 5999 },
    sku: 'SKU-1', seller: 'Pokémon Center', fulfillment: 'shipping',
  } }, endpoint, { now: () => 200 });
  assert.equal(observation.available, true);
  assert.equal(observation.quantity, 7);
  assert.equal(observation.priceCents, 5999);
  assert.equal(observation.seller, 'Pokémon Center');
  assert.equal(observation.source, 'direct-measured-endpoint');
  assert.equal(observation.confidence, 'measured-direct');
});

test('inventory parsing fails closed without a measured response contract', () => {
  assert.throws(() => parseMeasuredInventory({ status: 200, bodyJson: { available: true } }, {
    productId: 'p1', site: 'target', pollUrl: 'https://www.target.com/api/p1', metadata: {},
  }), (error) => error.code === 'SCALPER_INVENTORY_CONTRACT_UNMEASURED');
});

test('measured inventory enforces explicit dollar units, price caps, and first-party seller policy', () => {
  const bestBuyEndpoint = {
    productId: 'bb-spc', site: 'bestbuy', pollUrl: 'https://www.bestbuy.com/product/example/123', measuredAt: 100,
    metadata: {
      contract: {
        availableWhen: [{ path: 'offers[0].availability', equals: 'https://schema.org/InStock' }],
        priceUnit: 'dollars',
        fields: { priceCents: 'offers[0].price', seller: 'offers[0].seller.name' },
      },
      policy: { maxPriceCents: 13000, sellerEquals: 'Best Buy' },
    },
  };
  const response = (price, seller = 'Best Buy') => ({ status: 200, bodyJson: {
    offers: [{ availability: 'https://schema.org/InStock', price, seller: { name: seller } }],
  } });

  const atCap = parseMeasuredInventory(response(130), bestBuyEndpoint);
  assert.equal(atCap.priceCents, 13000);
  assert.equal(atCap.withinPriceCap, true);
  assert.equal(atCap.retailSeller, true);
  assert.equal(atCap.actionable, true);

  const overpriced = parseMeasuredInventory(response(130.01), bestBuyEndpoint);
  assert.equal(overpriced.withinPriceCap, false);
  assert.equal(overpriced.actionable, false);

  const marketplace = parseMeasuredInventory(response(89.99, 'Marketplace Seller'), bestBuyEndpoint);
  assert.equal(marketplace.retailSeller, false);
  assert.equal(marketplace.actionable, false);
});

test('measured inventory with a hard cap fails closed when price is absent', () => {
  const cappedEndpoint = {
    ...endpoint,
    metadata: {
      ...endpoint.metadata,
      policy: { maxPriceCents: 6000 },
    },
  };
  const observation = parseMeasuredInventory({ status: 200, bodyJson: {
    availability: 'IN_STOCK', addToCartEnabled: true, inventory: { quantity: 1 },
  } }, cappedEndpoint);
  assert.equal(observation.withinPriceCap, false);
  assert.equal(observation.actionable, false);
});

test('scanner stores bounded private detection samples and distinguishes unavailable stock', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'inventory-scanner-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1_000;
  const samples = new InventorySampleStore({ dataDir, maxSamples: 2 });
  const scanner = new InventoryScanner({
    productEndpoints: { get: async () => endpoint, list: async () => [endpoint] },
    httpForSite: () => ({ get: async () => ({ status: 200, bodyJson: {
      availability: 'OUT_OF_STOCK', addToCartEnabled: false, inventory: { quantity: 0 }, price: { cents: 5999 },
      sku: 'SKU-1', seller: 'Pokémon Center', fulfillment: 'shipping',
    } }) }),
    samples, now: () => now++, real: false,
  });
  const result = await scanner.scan({ productId: endpoint.productId, site: endpoint.site });
  assert.equal(result.available, false);
  assert.equal(result.quantity, 0);
  const path = samples.path(endpoint.site);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).real, false);
});

function inventoryWiringHarness(site) {
  const endpoints = [
    { ...endpoint, productId: 'p1', site },
    { ...endpoint, productId: 'p2', site },
  ];
  const calls = { opened: 0, warmedGets: 0, bareGets: 0, closed: 0, governed: [] };
  const response = { status: 200, bodyJson: {
    availability: 'OUT_OF_STOCK', addToCartEnabled: false, inventory: { quantity: 0 }, price: { cents: 5999 },
  } };
  const warmedTransport = { get: async () => { calls.warmedGets += 1; return response; } };
  const bareHttp = { get: async () => { calls.bareGets += 1; return response; } };
  return {
    calls,
    options: {
      site,
      productEndpoints: {
        list: async () => endpoints,
        get: async (productId) => endpoints.find((item) => item.productId === productId),
      },
      samples: { append: async () => {} },
      siteConfigs: {
        [site]: { wafGated: site === 'pokemon-center', polling: { maxRequestsPerSecond: 5 } },
      },
      bareHttp,
      governor: {
        httpFor(retailer, transport) { calls.governed.push({ retailer, transport }); return transport; },
      },
      openBrowserTransport: async () => {
        calls.opened += 1;
        return { transport: warmedTransport, context: { close: async () => { calls.closed += 1; } } };
      },
    },
  };
}

test('WAF-gated site polls through the warmed context, not bare fetch', async () => {
  const h = inventoryWiringHarness('pokemon-center');
  const result = await scanInventoryWithConfiguredTransport(h.options);
  assert.equal(result.observations.length, 2);
  assert.equal(h.calls.opened, 1, 'one warmed context per site run');
  assert.equal(h.calls.warmedGets, 2, 'the shared warmed transport serves every product');
  assert.equal(h.calls.bareGets, 0);
  assert.equal(h.calls.governed.length, 1, 'the scanner caches the governed site transport');
  assert.equal(h.calls.closed, 1, 'the warmed context closes in finally');
});

test('non-WAF inventory scan never opens a browser transport', async () => {
  const h = inventoryWiringHarness('bestbuy');
  const result = await scanInventoryWithConfiguredTransport(h.options);
  assert.equal(result.observations.length, 2);
  assert.equal(h.calls.opened, 0);
  assert.equal(h.calls.warmedGets, 0);
  assert.equal(h.calls.bareGets, 2);
  assert.equal(h.calls.closed, 0);
});

test('multi-product scans wait for the shared local request budget instead of dropping endpoints', async () => {
  const endpoints = [
    { ...endpoint, productId: 'p1' },
    { ...endpoint, productId: 'p2' },
  ];
  let calls = 0;
  const waits = [];
  const scanner = new InventoryScanner({
    productEndpoints: {
      list: async () => endpoints,
      get: async (productId) => endpoints.find((item) => item.productId === productId),
    },
    httpForSite: () => ({ get: async () => {
      calls += 1;
      if (calls === 2) {
        const error = new Error('local budget exhausted');
        error.code = 'SCALPER_RATE_LIMITED';
        error.retryAfterMs = 25;
        throw error;
      }
      return { status: 200, bodyJson: {
        availability: 'OUT_OF_STOCK', addToCartEnabled: false, inventory: { quantity: 0 }, price: { cents: 5999 },
      } };
    } }),
    samples: { append: async () => {} },
    sleep: async (ms) => { waits.push(ms); },
  });
  const result = await scanner.scanAll({ site: 'pokemon-center' });
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(waits, [25]);
  assert.equal(calls, 3);
});

test('WAF-gated inventory scan closes its warmed context when scan setup fails', async () => {
  const h = inventoryWiringHarness('pokemon-center');
  h.options.productEndpoints.list = async () => { throw new Error('endpoint store unavailable'); };
  await assert.rejects(scanInventoryWithConfiguredTransport(h.options), /endpoint store unavailable/);
  assert.equal(h.calls.opened, 1);
  assert.equal(h.calls.closed, 1);
});
