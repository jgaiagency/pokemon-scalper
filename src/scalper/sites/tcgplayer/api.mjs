import { config } from './config.mjs';

export class TcgplayerApi {
  constructor({ http, apiKey } = {}) {
    if (!http?.request) throw new Error('TcgplayerApi requires an injected HTTP transport');
    this.http = http;
    this.apiKey = apiKey;
  }
  request(path) {
    return this.http.request({ method: 'GET', url: new URL(path, config.apiBaseUrl).href, headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {} });
  }
  catalogProducts(productIds) {
    // TODO(measure): Confirm authentication and response shape with the operator's API key.
    return this.request(config.endpoints.catalogProduct.replace('{productIds}', productIds.join(',')));
  }
  storeInventory(storeKey) {
    // TODO(measure): Confirm availability fields and actual buyer-visible inventory semantics.
    return this.request(config.endpoints.storeInventory.replace('{storeKey}', encodeURIComponent(storeKey)));
  }
}

export function createApi(options) { return new TcgplayerApi(options); }
