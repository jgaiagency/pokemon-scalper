const RETAIL_HOSTS = Object.freeze({
  amazon: ['amazon.com'],
  bestbuy: ['bestbuy.com'],
  costco: ['costco.com'],
  dsg: ['dickssportinggoods.com'],
  gamestop: ['gamestop.com'],
  macys: ['macys.com'],
  'pokemon-center': ['pokemoncenter.com'],
  samsclub: ['samsclub.com'],
  target: ['target.com'],
  tcgplayer: ['tcgplayer.com'],
  walmart: ['walmart.com'],
});

function hostnameMatches(hostname, expected) {
  return hostname === expected || hostname.endsWith(`.${expected}`);
}

export function isRetailerUrl(value, site) {
  const expected = RETAIL_HOSTS[site] ?? [];
  if (!expected.length) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return expected.some((domain) => hostnameMatches(hostname, domain));
  } catch {
    return false;
  }
}

function reject(metrics, site, reason) {
  metrics?.increment?.('discord_retail_policy', { outcome: 'suppressed', reason, site: site ?? 'unknown' });
  return null;
}

// Runs after short-link resolution. Product alerts fail closed unless their
// destination belongs to the retailer named by the signal. Schedule and stock
// commentary can still pass without a link because they are informational.
export function createRetailUrlPolicy({ metrics } = {}) {
  return (parsed) => {
    if (!parsed) return null;
    if (parsed.signal) {
      let signal = parsed.signal;
      if (signal.products) {
        const products = signal.products.filter((product) => isRetailerUrl(product.url, signal.site));
        if (!products.length) return reject(metrics, signal.site, 'invalid-product-url');
        if (products.length !== signal.products.length) {
          metrics?.increment?.('discord_retail_policy', {
            outcome: 'filtered-products', site: signal.site ?? 'unknown',
          }, signal.products.length - products.length);
        }
        signal = { ...signal, products };
      }
      if (['restock', 'draw', 'queue', 'queue-live'].includes(signal.kind)
        && !isRetailerUrl(signal.url, signal.site)) {
        return reject(metrics, signal.site, 'invalid-retailer-url');
      }
      metrics?.increment?.('discord_retail_policy', { outcome: 'accepted', site: signal.site ?? 'unknown' });
      return { ...parsed, signal };
    }

    if (parsed.productUrls) {
      const entries = Object.entries(parsed.productUrls);
      if (entries.some(([site, url]) => !isRetailerUrl(url, site))) {
        return reject(metrics, parsed.sites?.[0], 'invalid-retailer-url');
      }
    }
    metrics?.increment?.('discord_retail_policy', { outcome: 'accepted', site: parsed.sites?.[0] ?? 'unknown' });
    return parsed;
  };
}

export { RETAIL_HOSTS };
