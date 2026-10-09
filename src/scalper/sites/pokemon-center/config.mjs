export const config = Object.freeze({
  id: 'pokemon-center',
  baseUrl: 'https://www.pokemoncenter.com/',
  wafGated: true,
  // MEASURED 2026-10-03: Imperva Incapsula (not Cloudflare). Fresh profile gets
  // 403 + /_Incapsula_Resource challenge iframe; challenge sets visid_incap +
  // incap_ses cookies but product pages STILL 403 on the next request — the
  // trusted session is necessary but not sufficient. See docs/MEASUREMENT-LOG.md.
  waf: 'Imperva Incapsula (measured 2026-10-03: 403 + _Incapsula_Resource challenge; visid_incap/incap_ses set but product page still 403s)',
  polling: Object.freeze({ preDropMs: 2_000, fullThrottleMs: 200, surpriseMs: 5_000, maxRequestsPerSecond: 5, maxWatcherMs: 30 * 60_000 }),
  endpoints: Object.freeze({
    // TODO(measure): First-party availability request and response mapping.
    checkAvailability: null,
    // TODO(measure): First-party add-to-cart request and response mapping.
    addToCart: null,
    // TODO(measure): First-party cart read request and response mapping.
    getCart: null,
    // TODO(measure): First-party final order request and response mapping.
    submitOrder: null,
    // TODO(measure): First-party order-history request and response mapping.
    getOrder: null,
  }),
  selectors: Object.freeze({
    // TODO(measure): Visible Chrome selectors for fallback add-to-cart, checkout, 3DS, and confirmation.
    addToCart: null, checkout: null, placeOrder: null, confirmation: null,
  }),
  browser: Object.freeze({ channel: 'chrome', headless: false, preserveCookies: true }),
  // TODO(measure): Confirm WAF and stock-to-confirmation latency; add only observed countermeasures.
});

export default config;
