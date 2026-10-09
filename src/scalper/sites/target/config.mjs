export const config = Object.freeze({
  id: 'target',
  baseUrl: 'https://www.target.com/',
  waf: 'DataDome (likely; verify datadome cookie and x-datadome header)',
  polling: Object.freeze({ preDropMs: 1_000, fullThrottleMs: 200, surpriseMs: 5_000, maxRequestsPerSecond: 1, maxWatcherMs: 30 * 60_000 }),
  endpoints: Object.freeze({
    // TODO(measure): Product JSON URL. Expected response includes availableToPromise and fulfillment.shipping.
    product: null,
    // TODO(measure): Add-to-cart URL and TCIN/request shape.
    addToCart: null,
    // TODO(measure): Checkout/payment/order calls and confirmation response shape.
    checkout: null,
  }),
  selectors: Object.freeze({
    // TODO(measure): Visible Chrome add-to-cart, checkout, 3DS, challenge, and confirmation selectors.
    addToCart: null, checkout: null, placeOrder: null, challenge: null, confirmation: null,
  }),
  browser: Object.freeze({ channel: 'chrome', headless: false, preserveCookies: true }),
  // TODO(measure): DataDome challenge shape/duration and stock-to-confirmation latency. Preserve all device state.
});

export default config;
