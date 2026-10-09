export const config = Object.freeze({
  id: 'tcgplayer',
  baseUrl: 'https://www.tcgplayer.com/',
  apiBaseUrl: 'https://api.tcgplayer.com/',
  waf: 'Light/unknown (verify during measurement)',
  polling: Object.freeze({ preDropMs: 2_000, fullThrottleMs: 200, surpriseMs: 5_000, catalogMs: 30_000, maxRequestsPerSecond: 1, maxWatcherMs: 30 * 60_000 }),
  endpoints: Object.freeze({
    catalogProduct: '/catalog/products/{productIds}',
    storeInventory: '/stores/{storeKey}/inventory',
    // TODO(measure): Buyer add-to-cart request URL and expected listing/SKU payload.
    addToCart: null,
    // TODO(measure): Browser checkout steps and confirmation response shape.
    checkout: null,
  }),
  selectors: Object.freeze({
    // TODO(measure): Product listing, cart, checkout, place-order, and confirmation selectors.
    listing: null, addToCart: null, checkout: null, placeOrder: null, confirmation: null,
  }),
  browser: Object.freeze({ channel: 'chrome', headless: false, preserveCookies: true }),
  // TODO(measure): API limits and stock-to-confirmation latency.
});

export default config;
