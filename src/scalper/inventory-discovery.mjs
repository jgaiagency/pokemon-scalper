import { InventoryScanner } from './inventory-scanner.mjs';

class ConfiguredProductEndpointStore {
  constructor(endpoints = []) {
    this.endpoints = endpoints;
  }

  async get(productId, site) {
    return this.endpoints.find((endpoint) => endpoint.productId === productId && endpoint.site === site) ?? null;
  }

  async list({ site } = {}) {
    return this.endpoints.filter((endpoint) => !site || endpoint.site === site);
  }
}

export class MeasuredInventoryDiscoverySource {
  constructor({ id, site, productIds, endpoints = [], products = [], httpForSite, samples, events, now = Date.now, sleep } = {}) {
    if (!id || !site) throw new Error('Measured inventory discovery source requires id and site');
    if (typeof httpForSite !== 'function') throw new Error('Measured inventory discovery source requires a per-site HTTP provider');
    const productById = new Map(products.map((product) => [product.id, product]));
    const selectedIds = Array.isArray(productIds) ? new Set(productIds) : null;
    this.endpoints = endpoints.filter((endpoint) => endpoint.site === site
      && productById.has(endpoint.productId)
      && (!selectedIds || selectedIds.has(endpoint.productId)));
    if (!this.endpoints.length) throw new Error(`Measured inventory discovery source has no watchlisted ${site} endpoints`);
    this.id = id;
    this.site = site;
    this.retailOnly = true;
    this.watchlistOnly = true;
    this.productById = productById;
    this.endpointByProduct = new Map(this.endpoints.map((endpoint) => [endpoint.productId, endpoint]));
    this.scanner = new InventoryScanner({
      productEndpoints: new ConfiguredProductEndpointStore(this.endpoints),
      httpForSite,
      samples,
      events,
      now,
      ...(sleep ? { sleep } : {}),
    });
  }

  async capture({ signal } = {}) {
    const result = await this.scanner.scanAll({ site: this.site, signal });
    if (result.errors.length) {
      const error = new Error(`Measured ${this.site} inventory discovery was incomplete: ${result.errors.map((item) => `${item.productId}: ${item.code ?? item.message}`).join(', ')}`);
      error.code = 'SCALPER_INVENTORY_PARTIAL';
      error.details = result.errors;
      throw error;
    }
    return result.observations.map((observation) => {
      const product = this.productById.get(observation.productId);
      const endpoint = this.endpointByProduct.get(observation.productId);
      const sku = observation.sku ? String(observation.sku) : null;
      const availableState = observation.available ? 'IN_STOCK' : 'OUT_OF_STOCK';
      return {
        site: this.site,
        id: sku ? `${this.site}-${sku}` : `${this.site}-${observation.productId}`,
        ...(sku ? { sku } : {}),
        productId: observation.productId,
        product,
        name: product.name,
        url: endpoint.pollUrl,
        price: observation.priceCents === undefined ? null : observation.priceCents / 100,
        priceCap: observation.maxPriceCents === undefined ? null : observation.maxPriceCents / 100,
        state: availableState,
        states: [availableState],
        actionable: observation.actionable,
        fulfillment: observation.fulfillment ?? (observation.available ? 'available' : 'unavailable'),
        retailSeller: observation.retailSeller ?? false,
        seller: observation.seller,
        withinPriceCap: observation.withinPriceCap ?? false,
        onWatchlist: true,
        verified: true,
        observedAt: observation.observedAt,
        endpointMeasuredAt: observation.endpointMeasuredAt,
        confidence: observation.confidence,
        source: observation.source,
      };
    });
  }
}

export function createMeasuredInventoryDiscoverySource(options) {
  return new MeasuredInventoryDiscoverySource(options);
}
