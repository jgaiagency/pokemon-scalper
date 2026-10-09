import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const ACTIONABLE_BEST_BUY_STATES = new Set(['ADD_TO_CART', 'PREORDER', 'IN_STORE_ONLY']);
const BEST_BUY_HEADERS = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 PokemonScalperDiscovery/1.0' };

function numericPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function productPriceCap(product, site, sourceCap = Infinity) {
  const candidates = [
    sourceCap,
    product?.maxPrice,
    product?.maxPriceBySite?.[site],
  ].map(numericPrice).filter((value) => value !== null);
  return candidates.length ? Math.min(...candidates) : Infinity;
}

function isWithinPriceCap(price, cap) {
  if (!Number.isFinite(cap)) return true;
  const parsed = numericPrice(price);
  return parsed !== null && parsed <= cap;
}

function replaceUndefined(source) {
  let output = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      index += 1;
      continue;
    }
    if (source.startsWith('undefined', index)) {
      output += 'null';
      index += 'undefined'.length;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function apolloPayloads(html) {
  const payloads = [];
  const scripts = String(html).matchAll(/<script>([^<]*ApolloSSRDataTransport[\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const source = match[1];
    const start = source.indexOf('.push(');
    const end = source.lastIndexOf(')');
    if (start < 0 || end <= start) continue;
    try {
      payloads.push(JSON.parse(replaceUndefined(source.slice(start + 6, end))));
    } catch {
      // Ignore unrelated or newly shaped scripts. An empty final result fails
      // closed in the source adapter instead of claiming that stock vanished.
    }
  }
  return payloads;
}

function mergeProduct(records, product, wrapper = {}) {
  if (!product?.skuId) return;
  const previous = records.get(String(product.skuId)) ?? {};
  const states = product.fulfillmentOptions?.buttonStates?.map((item) => item.buttonState).filter(Boolean);
  const price = numericPrice(wrapper.price?.customerPrice ?? product.price?.customerPrice ?? product.customerPrice);
  const sellerClassification = product.seller?.classification ?? wrapper.seller?.classification ?? previous.sellerClassification ?? null;
  records.set(String(product.skuId), {
    ...previous,
    sku: String(product.skuId),
    name: product.name?.short ?? product.name?.title ?? previous.name,
    url: wrapper.pdpUrl ?? product.pdpUrl ?? previous.url,
    price: price ?? previous.price,
    states: states?.length ? [...new Set(states)] : previous.states,
    sellerClassification,
  });
}

function collectProducts(value, records) {
  if (!value || typeof value !== 'object') return;
  if (value.product?.skuId) mergeProduct(records, value.product, value);
  if (value.skuId) mergeProduct(records, value, value);
  for (const nested of Object.values(value)) collectProducts(nested, records);
}

export function parseBestBuySearchDocument(html, {
  include = [], exclude = [], maxPrice = Infinity, retailOnly = true, onlineOnly = false,
} = {}) {
  const records = new Map();
  for (const payload of apolloPayloads(html)) collectProducts(payload, records);
  const patterns = include.map((value) => new RegExp(value, 'i'));
  const excludedPatterns = exclude.map((value) => new RegExp(value, 'i'));
  const items = [...records.values()]
    .filter((item) => item.name && item.url && item.states?.length)
    .filter((item) => patterns.every((pattern) => pattern.test(item.name)))
    .filter((item) => excludedPatterns.every((pattern) => !pattern.test(item.name)))
    .map((item) => {
      const states = [...item.states].sort();
      const state = states.join(',');
      const sellerClassification = item.sellerClassification ?? null;
      const retailSeller = sellerClassification === '1P';
      const withinPriceCap = isWithinPriceCap(item.price, productPriceCap(null, 'bestbuy', maxPrice));
      const inventoryActionable = states.some((value) => ACTIONABLE_BEST_BUY_STATES.has(value));
      const fulfillment = states.includes('ADD_TO_CART') || states.includes('PREORDER')
        ? 'online'
        : states.includes('IN_STORE_ONLY') ? 'in-store' : 'unavailable';
      return {
        site: 'bestbuy', id: `bestbuy-${item.sku}`, sku: item.sku,
        name: item.name, url: item.url, price: item.price ?? null,
        state, states,
        sellerClassification,
        retailSeller,
        withinPriceCap,
        actionable: inventoryActionable && withinPriceCap && (!retailOnly || retailSeller)
          && (!onlineOnly || fulfillment === 'online'),
        fulfillment,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.sku.localeCompare(right.sku));
  return { items, structuredProductCount: records.size };
}

export function parseBestBuySearchHtml(html, options = {}) {
  return parseBestBuySearchDocument(html, options).items;
}

export function parseBestBuyProductPage(html, { sku } = {}) {
  const records = new Map();
  for (const payload of apolloPayloads(html)) collectProducts(payload, records);
  const product = sku ? records.get(String(sku)) : null;
  const states = product?.states?.length
    ? [...new Set(product.states)]
    : [...new Set([...html.matchAll(/"buttonState":"(\w+)"/g)].map((m) => m[1]))];
  const actionable = states.some((value) => ACTIONABLE_BEST_BUY_STATES.has(value));
  const priceMatch = product?.price === undefined ? html.match(/"customerPrice":(\d+\.?\d*)/) : null;
  const price = Number.isFinite(product?.price) ? product.price : priceMatch ? Number(priceMatch[1]) : null;
  const sellerClassification = product?.sellerClassification ?? null;
  return {
    states,
    actionable,
    price,
    sellerClassification,
    retailSeller: sellerClassification === '1P',
    fulfillment: states.includes('ADD_TO_CART') || states.includes('PREORDER')
      ? 'online'
      : states.includes('IN_STORE_ONLY') ? 'in-store' : 'unavailable',
  };
}

export class BestBuySearchSource {
  constructor({
    id, url, include, exclude, http, minPrice = 0, maxPrice = Infinity,
    retailOnly = true, onlineOnly = false, watchlistOnly = false, allowEmpty = false, productMatcher,
  } = {}) {
    if (!id || !url) throw new Error('Best Buy discovery source requires id and url');
    if (!http?.get) throw new Error('Best Buy discovery source requires an HTTP transport');
    this.id = id;
    this.site = 'bestbuy';
    this.url = url;
    this.include = include ?? [];
    this.exclude = exclude ?? [];
    this.http = http;
    this.minPrice = minPrice;
    this.maxPrice = maxPrice;
    this.retailOnly = retailOnly;
    this.onlineOnly = onlineOnly;
    this.watchlistOnly = watchlistOnly;
    this.allowEmpty = allowEmpty;
    this.productMatcher = productMatcher;
  }

  async #verifyProduct(item, signal) {
    if (!item.url) return item;
    try {
      const response = await this.http.get(item.url, { signal, headers: BEST_BUY_HEADERS });
      if (response.status >= 400) return { ...item, actionable: false, verified: false, verificationStatus: response.status };
      const verified = parseBestBuyProductPage(response.body, { sku: item.sku });
      const sellerClassification = verified.sellerClassification ?? item.sellerClassification;
      const retailSeller = sellerClassification === '1P';
      const price = verified.price ?? item.price;
      const priceCap = productPriceCap(item.product, this.site, this.maxPrice);
      const withinPriceCap = isWithinPriceCap(price, priceCap);
      const onlineEligible = !this.onlineOnly || verified.fulfillment === 'online';
      return {
        ...item,
        states: verified.states.length ? verified.states : item.states,
        state: verified.states.length ? verified.states.sort().join(',') : item.state,
        actionable: verified.actionable && withinPriceCap && (!this.retailOnly || retailSeller) && onlineEligible,
        fulfillment: verified.fulfillment,
        price,
        priceCap: Number.isFinite(priceCap) ? priceCap : null,
        sellerClassification,
        retailSeller,
        withinPriceCap,
        verified: true,
      };
    } catch {
      return { ...item, actionable: false, verified: false };
    }
  }

  async capture({ signal } = {}) {
    const response = await this.http.get(this.url, { signal, headers: BEST_BUY_HEADERS });
    if (response.status >= 400) throw new Error(`Best Buy discovery returned HTTP ${response.status}`);
    const parsed = parseBestBuySearchDocument(response.body, {
      include: this.include,
      exclude: this.exclude,
      maxPrice: this.maxPrice,
      retailOnly: this.retailOnly,
      onlineOnly: this.onlineOnly,
    });
    let { items } = parsed;
    if (this.minPrice > 0) items = items.filter((item) => !Number.isFinite(item.price) || item.price >= this.minPrice);
    if (!items.length) {
      // A page with other structured products is a valid zero-match search.
      // A challenge/interstitial or an unknown document shape still fails
      // closed so an adapter break cannot masquerade as inventory loss.
      if (this.allowEmpty && parsed.structuredProductCount > 0) return [];
      const error = new Error('Best Buy discovery found no structured matching products; preserving prior state');
      error.code = 'SCALPER_DISCOVERY_EMPTY';
      throw error;
    }
    const classified = items.map((item) => {
      const product = this.productMatcher?.(item.name) ?? null;
      const priceCap = productPriceCap(product, this.site, this.maxPrice);
      const withinPriceCap = isWithinPriceCap(item.price, priceCap);
      return {
        ...item,
        onWatchlist: Boolean(product),
        ...(product ? { productId: product.id, product } : {}),
        priceCap: Number.isFinite(priceCap) ? priceCap : null,
        withinPriceCap,
        actionable: item.actionable && withinPriceCap && (!this.watchlistOnly || Boolean(product)),
      };
    });
    const candidates = classified.filter((item) => item.actionable);
    const verified = new Map((await Promise.all(candidates.map((item) => this.#verifyProduct(item, signal))))
      .map((item) => [item.id, item]));
    return classified.map((item) => verified.get(item.id) ?? {
      ...item,
      actionable: false,
      verificationSkipped: item.onWatchlist === false ? 'off-watchlist' : 'not-search-actionable',
    });
  }
}

function nestedText(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (typeof value.text === 'string') output.push(value.text);
  if (Array.isArray(value)) value.forEach((item) => nestedText(item, output));
  else Object.values(value).forEach((item) => nestedText(item, output));
  return output;
}

function targetListings(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (value.__typename === 'ProductListing' && value.tcin && value.sections) output.push(value);
  if (Array.isArray(value)) value.forEach((item) => targetListings(item, output));
  else Object.values(value).forEach((item) => targetListings(item, output));
  return output;
}

export function parseTargetSearchJson(payload, { include = [], exclude = [], maxPrice = Infinity } = {}) {
  const patterns = include.map((value) => new RegExp(value, 'i'));
  const excludedPatterns = exclude.map((value) => new RegExp(value, 'i'));
  const products = new Map();
  for (const listing of targetListings(payload)) {
    const name = listing.accessibility_text
      ?? listing.sections?.ACTION_FOOTER?.content?.[0]?.call_to_action?.product_title;
    if (!name || !patterns.every((pattern) => pattern.test(name))) continue;
    if (!excludedPatterns.every((pattern) => !pattern.test(name))) continue;
    const navigation = listing.click_interactions?.find((item) => item.__typename === 'Navigation');
    const relativeUrl = navigation?.url;
    if (!relativeUrl) continue;
    const priceText = nestedText(listing.sections?.CONTENT).find((value) => /^\$[\d,.]+$/.test(value.trim()));
    const price = priceText ? Number(priceText.replace(/[$,]/g, '')) : null;
    const callToAction = listing.sections?.ACTION_FOOTER?.content
      ?.map((item) => item.call_to_action).find(Boolean);
    const state = callToAction?.__typename ?? 'NO_ACTION';
    const canAdd = state === 'DefaultAddToCart';
    const withinPriceCap = isWithinPriceCap(price, productPriceCap(null, 'target', maxPrice));
    products.set(String(listing.tcin), {
      site: 'target', id: `target-${listing.tcin}`, tcin: String(listing.tcin),
      name,
      url: new URL(relativeUrl, 'https://www.target.com').href,
      price,
      state,
      states: [state],
      actionable: canAdd && withinPriceCap,
      fulfillment: canAdd ? 'online' : 'unavailable',
      purchaseLimit: Number(callToAction?.purchase_limit) || null,
      withinPriceCap,
    });
  }
  return [...products.values()].sort((left, right) => left.name.localeCompare(right.name) || left.tcin.localeCompare(right.tcin));
}

export function createTargetSearchUrl({ query, apiKey, visitorId } = {}) {
  if (!query) throw new Error('Target discovery search query is required');
  if (!apiKey) throw new Error('Target discovery requires a locally configured public client key');
  const page = `/s/${query}`;
  const params = new URLSearchParams({
    key: apiKey,
    platform: 'WEB',
    privacy_do_not_sell: 'false',
    targeted_advertising_opt_out: 'false',
    device_type: 'DESKTOP',
    sapphire_channel: 'WEB',
    sapphire_page: page,
    channel: 'WEB',
    page,
    visitor_id: visitorId ?? randomBytes(16).toString('hex').toUpperCase(),
    has_pending_inputs: 'false',
    count: '24',
    default_purchasability_filter: 'true',
    include_sponsored: 'false',
    new_search: 'true',
    offset: '0',
    spellcheck: 'true',
    keyword: query,
    is_seo_bot: 'false',
    include_data_source_modules: 'true',
    query_string: `searchTerm=${query.replaceAll(' ', '+')}`,
    timezone: 'America/Chicago',
    country: 'US',
  });
  return `https://cdui-orchestrations.target.com/cdui_orchestrations/v1/pages/slp?${params}`;
}

export class TargetSearchSource {
  constructor({
    id, query, include, exclude, maxPrice, apiKey, allowEmpty = false,
    watchlistOnly = false, productMatcher, http, visitorIdFactory,
  } = {}) {
    if (!id || !query) throw new Error('Target discovery source requires id and query');
    if (!http?.get) throw new Error('Target discovery source requires an HTTP transport');
    this.id = id;
    this.site = 'target';
    this.query = query;
    this.include = include ?? [];
    this.exclude = exclude ?? [];
    this.maxPrice = maxPrice;
    this.apiKey = apiKey;
    this.allowEmpty = allowEmpty;
    this.watchlistOnly = watchlistOnly;
    this.productMatcher = productMatcher;
    this.http = http;
    this.visitorIdFactory = visitorIdFactory ?? (() => randomBytes(16).toString('hex').toUpperCase());
  }

  async capture({ signal } = {}) {
    const url = createTargetSearchUrl({
      query: this.query,
      apiKey: this.apiKey,
      visitorId: this.visitorIdFactory(),
    });
    const response = await this.http.get(url, {
      signal,
      headers: {
        Accept: 'application/json',
        Origin: 'https://www.target.com',
        Referer: 'https://www.target.com/',
        'User-Agent': 'Mozilla/5.0 PokemonScalperDiscovery/1.0',
      },
    });
    if (response.status >= 400) throw new Error(`Target discovery returned HTTP ${response.status}`);
    let payload = response.bodyJson;
    if (!payload) {
      try { payload = JSON.parse(response.body); } catch { /* Fail closed below. */ }
    }
    const parsedItems = parseTargetSearchJson(payload, {
      include: this.include,
      exclude: this.exclude,
      maxPrice: this.maxPrice,
    });
    if (!parsedItems.length) {
      if (this.allowEmpty && Array.isArray(payload?.layout?.zones)) return [];
      const error = new Error('Target discovery found no structured matching products; preserving prior state');
      error.code = 'SCALPER_DISCOVERY_EMPTY';
      throw error;
    }
    return parsedItems.map((item) => {
      const product = this.productMatcher?.(item.name) ?? null;
      const priceCap = productPriceCap(product, this.site, this.maxPrice);
      const withinPriceCap = isWithinPriceCap(item.price, priceCap);
      return {
        ...item,
        onWatchlist: Boolean(product),
        ...(product ? { productId: product.id, product } : {}),
        priceCap: Number.isFinite(priceCap) ? priceCap : null,
        withinPriceCap,
        actionable: item.actionable && withinPriceCap && (!this.watchlistOnly || Boolean(product)),
      };
    });
  }
}

export class DiscoveryStateStore {
  constructor({ path = 'data/scalper/discovery-state.json' } = {}) {
    this.path = path;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, sources: {} };
      throw error;
    }
  }

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export class DiscoveryCatalogStore {
  constructor({ path = 'data/scalper/product-catalog.json', configuredProducts = [] } = {}) {
    this.path = path;
    this.configuredProducts = configuredProducts;
  }

  async save({ capturedAt, sources }) {
    const observed = Object.entries(sources ?? {}).flatMap(([sourceId, source]) => (source.items ?? []).map((item) => ({
      sourceId,
      sourceCapturedAt: source.capturedAt,
      observed: true,
      ...item,
    })));
    const observedKeys = new Set(observed.map((item) => `${item.site}:${item.id}`));
    const configured = this.configuredProducts
      .filter((item) => !observedKeys.has(`${item.site}:${item.id}`))
      .map((item) => ({ ...item, observed: false, actionable: false }));
    const products = [...observed, ...configured];
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, capturedAt, products }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return products;
  }
}

function shouldAlert(previous, current, { notifyCurrent, hadPriorCapture }) {
  if (!current.actionable) return false;
  if (!hadPriorCapture) return notifyCurrent;
  if (!previous || !previous.actionable) return true;
  if (previous.state !== current.state) return true;
  return Number.isFinite(current.price) && Number.isFinite(previous.price) && current.price < previous.price;
}

export class RetailerDiscoveryTracker {
  constructor({ sources = [], store = new DiscoveryStateStore(), catalogStore, alerts, onActionable, now = Date.now } = {}) {
    this.sources = sources;
    this.store = store;
    this.alerts = alerts;
    this.catalogStore = catalogStore;
    this.onActionable = onActionable;
    this.now = now;
  }

  async capture({ notifyCurrent = false, signal } = {}) {
    const previousState = await this.store.load();
    const nextState = { version: 1, capturedAt: this.now(), sources: { ...(previousState.sources ?? {}) } };
    const result = { capturedAt: nextState.capturedAt, sources: 0, items: 0, actionable: 0, alerts: [], executions: [], errors: [] };
    // Network capture is the dominant path and sources are independent. Run
    // them concurrently, then apply transitions in configured order so state
    // and alert behavior remain deterministic.
    const captures = await Promise.all(this.sources.map(async (source) => {
      try {
        return { source, items: await source.capture({ signal }) };
      } catch (error) {
        return { source, error };
      }
    }));
    const preservePrior = (source) => {
      const priorSource = previousState.sources?.[source.id];
      if (priorSource?.items && (source.retailOnly || source.onlineOnly || Number.isFinite(Number(source.maxPrice)))) {
        nextState.sources[source.id] = {
          ...priorSource,
          items: priorSource.items.map((item) => {
            const retailEligible = !source.retailOnly || item.retailSeller === true;
            const priceCap = productPriceCap(item.product, source.site, source.maxPrice);
            const withinPriceCap = isWithinPriceCap(item.price, priceCap);
            const watchlistEligible = !source.watchlistOnly || item.onWatchlist === true;
            const onlineEligible = !source.onlineOnly || item.fulfillment === 'online';
            return {
              ...item,
              priceCap: Number.isFinite(priceCap) ? priceCap : null,
              withinPriceCap,
              actionable: Boolean(item.actionable && retailEligible && withinPriceCap && watchlistEligible && onlineEligible),
              policyStale: item.retailSeller === undefined || (source.watchlistOnly && item.onWatchlist === undefined),
            };
          }),
        };
      }
    };
    for (const capture of captures) {
      const { source } = capture;
      if (capture.error) {
        preservePrior(source);
        result.errors.push({ source: source.id, error: capture.error.message, code: capture.error.code });
        continue;
      }
      try {
        const { items } = capture;
        const priorSource = previousState.sources?.[source.id];
        const previousItems = new Map((priorSource?.items ?? []).map((item) => [item.id, item]));
        const pending = items.filter((item) => shouldAlert(previousItems.get(item.id), item, {
          notifyCurrent,
          hadPriorCapture: Boolean(priorSource),
        }));
        let executionFailed = false;
        for (const item of pending) {
          const transition = { sourceId: source.id, ...item };
          result.alerts.push(transition);
          try {
            if (this.onActionable) {
              const execution = await this.onActionable(transition, { detectedAt: nextState.capturedAt, source });
              result.executions.push({ source: source.id, product: item.id, ...execution });
            } else {
              await this.alerts?.dropDetected?.({
                source: source.id,
                site: item.site,
                product: item.name,
                sku: item.sku,
                price: item.price ?? 'unknown',
                availability: item.fulfillment,
                url: item.url,
              });
            }
          } catch (error) {
            executionFailed = true;
            result.errors.push({ source: source.id, stage: 'execution', error: error.message, code: error.code });
          }
        }
        if (!executionFailed) nextState.sources[source.id] = { site: source.site, capturedAt: this.now(), items };
        else if (!priorSource) delete nextState.sources[source.id];
        result.sources += 1;
        result.items += items.length;
        result.actionable += items.filter((item) => item.actionable).length;
      } catch (error) {
        preservePrior(source);
        result.errors.push({ source: source.id, error: error.message, code: error.code });
      }
    }
    await this.store.save(nextState);
    await this.catalogStore?.save?.(nextState);
    return result;
  }
}

export function createBestBuySearchSource(options) {
  return new BestBuySearchSource(options);
}

export function createTargetSearchSource(options) {
  return new TargetSearchSource(options);
}

export function createRetailerDiscoveryTracker(options) {
  return new RetailerDiscoveryTracker(options);
}
