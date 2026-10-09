const TCGPLAYER_TOKEN_URL = 'https://api.tcgplayer.com/token';
const TCGPLAYER_MARKET_URL = 'https://api.tcgplayer.com/pricing/marketprices';
const TCGPLAYER_CATALOG_URL = 'https://api.tcgplayer.com/catalog/products';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

function requireHttp(http) {
  if (!http?.request || !http?.get) throw new Error('Market source requires an injected HTTP transport');
}

function assertSuccess(response, label) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.bodyJson ?? JSON.parse(response.body);
}

function tokenCache({ requestToken, now }) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt > now()) return cached.value;
    const token = await requestToken();
    cached = {
      value: token.access_token,
      expiresAt: now() + Math.max(0, Number(token.expires_in ?? 3600) * 1_000 - 60_000),
    };
    if (!cached.value) throw new Error('Market source token response did not include access_token');
    return cached.value;
  };
}

export function createTcgplayerMarketSource({ http, publicKey, privateKey, accessToken, now = Date.now } = {}) {
  requireHttp(http);
  if (!publicKey || !privateKey) throw new Error('TCGplayer market source requires publicKey and privateKey');
  const getToken = tokenCache({
    now,
    requestToken: async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: publicKey,
        client_secret: privateKey,
        ...(accessToken ? { access_token: accessToken } : {}),
      }).toString();
      return assertSuccess(await http.request({
        method: 'POST', url: TCGPLAYER_TOKEN_URL,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      }), 'TCGplayer token request');
    },
  });
  return {
    id: 'tcgplayer',
    async quote(product) {
      const tcgplayer = product.sources?.tcgplayer;
      if (!tcgplayer?.skuId && !tcgplayer?.productId) return null;
      const bearer = await getToken();
      let skuId = tcgplayer.skuId;
      if (!skuId) {
        const catalog = assertSuccess(await http.get(`${TCGPLAYER_CATALOG_URL}/${encodeURIComponent(tcgplayer.productId)}/skus`, {
          headers: { accept: 'application/json', authorization: `bearer ${bearer}` },
        }), 'TCGplayer product SKU lookup');
        const matches = (catalog.results ?? []).filter((sku) => (
          (tcgplayer.languageId === undefined || Number(sku.languageId) === Number(tcgplayer.languageId))
          && (tcgplayer.conditionId === undefined || Number(sku.conditionId) === Number(tcgplayer.conditionId))
        ));
        if (matches.length !== 1) throw new Error(`TCGplayer product ${tcgplayer.productId} resolved to ${matches.length} matching SKUs; configure skuId explicitly`);
        skuId = matches[0].skuId;
      }
      const payload = assertSuccess(await http.get(`${TCGPLAYER_MARKET_URL}/${encodeURIComponent(skuId)}`, {
        headers: { accept: 'application/json', authorization: `bearer ${bearer}` },
      }), 'TCGplayer market price');
      const result = payload.results?.[0];
      if (!result || !Number.isFinite(Number(result.price)) || Number(result.price) <= 0) return null;
      return {
        kind: 'market-price', price: Number(result.price), at: now(), confidence: 0.8,
        metadata: {
          skuId: Number(result.productConditionId ?? skuId),
          productId: Number(tcgplayer.productId) || null,
          lowestRange: Number(result.lowestRange) || null,
          highestRange: Number(result.highestRange) || null,
        },
      };
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createEbayBrowseSource({ http, clientId, clientSecret, marketplaceId = 'EBAY_US', now = Date.now } = {}) {
  requireHttp(http);
  if (!clientId || !clientSecret) throw new Error('eBay market source requires clientId and clientSecret');
  const getToken = tokenCache({
    now,
    requestToken: async () => assertSuccess(await http.request({
      method: 'POST', url: EBAY_TOKEN_URL,
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }).toString(),
    }), 'eBay token request'),
  });
  return {
    id: 'ebay',
    async quote(product) {
      const ebay = product.sources?.ebay;
      if (!ebay?.query) return null;
      const bearer = await getToken();
      const query = new URLSearchParams({
        q: ebay.query,
        limit: String(Math.min(200, Math.max(1, Number(ebay.limit) || 50))),
        filter: 'conditions:{NEW},buyingOptions:{FIXED_PRICE}',
        ...(ebay.categoryId ? { category_ids: String(ebay.categoryId) } : {}),
      });
      const payload = assertSuccess(await http.get(`${EBAY_BROWSE_URL}?${query}`, {
        headers: {
          authorization: `Bearer ${bearer}`,
          'x-ebay-c-marketplace-id': marketplaceId,
          accept: 'application/json',
        },
      }), 'eBay Browse search');
      const totals = (payload.itemSummaries ?? []).map((item) => {
        const price = Number(item.price?.value);
        const shipping = Number(item.shippingOptions?.[0]?.shippingCost?.value ?? 0);
        return price + shipping;
      }).filter((value) => Number.isFinite(value) && value > 0);
      if (!totals.length) return null;
      return {
        kind: 'active-listing', price: median(totals), at: now(), confidence: 0.35,
        sampleSize: totals.length,
        metadata: {
          query: ebay.query,
          totalMatches: Number(payload.total) || totals.length,
          lowest: Math.min(...totals),
          highest: Math.max(...totals),
        },
      };
    },
  };
}
