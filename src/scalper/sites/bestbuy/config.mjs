export const config = Object.freeze({
  id: 'bestbuy',
  baseUrl: 'https://www.bestbuy.com/',
  // MEASURED 2026-10-03: NOT WAF-walled for a fresh profile (home + product
  // model API return 200). Product availability API confirmed:
  //   GET /api/tcfb/model.json?paths=[["shop","scds","v2","product",<sku>]]&method=get
  // returns 200 JSON (empty atom for unknown skus). Cart API: /pcn-api/basket.
  // Search/category pages 404 for this profile (geo/A-B), so discovery must use
  // the model API with a known in-stock SKU. See docs/MEASUREMENT-LOG.md.
  waf: 'Light (measured 2026-10-03: no challenge on fresh profile; model.json + pcn-api/basket return 200)',
  polling: Object.freeze({ preDropMs: 1_000, fullThrottleMs: 200, surpriseMs: 5_000, maxRequestsPerSecond: 1, maxWatcherMs: 30 * 60_000 }),
  endpoints: Object.freeze({
    // MEASURED 2026-10-03: product availability API (returns 200 JSON).
    // The <sku> must be a real in-stock product ID; unknown skus return an
    // empty atom. Response schema (purchasable / buttonState / price) still
    // needs capture against a known in-stock TCG SKU — see docs/MEASUREMENT-LOG.md.
    product: 'https://www.bestbuy.com/api/tcfb/model.json?paths=%5B%5B%22shop%22%2C%22scds%22%2C%22v2%22%2C%22product%22%2C{sku}%5D%5D&method=get',
    // TODO(measure): Add-to-cart URL and SKU request/response shapes.
    addToCart: null,
    // TODO(measure): Checkout/payment/order calls and confirmation shape.
    checkout: null,
  }),
  selectors: Object.freeze({
    // TODO(measure): Visible Chrome add-to-cart, checkout, 3DS, and confirmation selectors.
    addToCart: null, checkout: null, placeOrder: null, confirmation: null,
  }),
  browser: Object.freeze({ channel: 'chrome', headless: false, preserveCookies: true }),
  // TODO(measure): Akamai challenge behavior and stock-to-confirmation latency. Never clear ak_bmsc cookies.
});

export default config;
