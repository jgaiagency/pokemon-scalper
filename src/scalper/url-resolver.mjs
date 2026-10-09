import { signalsToDrops } from './monitor-parser.mjs';
import { isIP } from 'node:net';

const DEFAULT_SHORTENERS = Object.freeze(['buff.ly', 'amzn.to', 'ebay.us', 'howl.link']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function isSafeResolvedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = normalizedHostname(url);
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) return !isPrivateIpv4(hostname);
    if (ipVersion === 6) {
      const lower = hostname.toLowerCase();
      return lower !== '::' && lower !== '::1' && !lower.startsWith('fc') && !lower.startsWith('fd') && !lower.startsWith('fe8') && !lower.startsWith('fe9') && !lower.startsWith('fea') && !lower.startsWith('feb');
    }
    return true;
  } catch {
    return false;
  }
}

function embeddedDestination(url) {
  if (url.hostname.toLowerCase() !== 'howl.link') return null;
  const destination = url.searchParams.get('url');
  if (!destination) return null;
  try {
    const parsed = new URL(destination);
    return isSafeResolvedUrl(parsed.href) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function createUrlResolver({
  http,
  shortenerHosts = DEFAULT_SHORTENERS,
  ttlMs = 24 * 60 * 60_000,
  now = Date.now,
  cache = new Map(),
  logger = console,
  metrics,
  timeoutMs = 750,
  signalFactory = (ms) => AbortSignal.timeout(ms),
  maxRedirects = 3,
} = {}) {
  const hosts = new Set(shortenerHosts.map((host) => host.toLowerCase()));
  return {
    async resolve(value) {
      let url;
      try { url = new URL(value); } catch { return value; }
      if (!hosts.has(url.hostname.toLowerCase()) || !isSafeResolvedUrl(url.href)) return value;
      const embedded = embeddedDestination(url);
      if (embedded) {
        metrics?.increment?.('short_url_resolution', { outcome: 'embedded', host: url.hostname });
        return embedded;
      }
      const cached = cache.get(value);
      if (cached && cached.expiresAt > now()) {
        metrics?.increment?.('short_url_resolution', { outcome: 'cache-hit', host: url.hostname });
        return cached.url;
      }
      try {
        if (!http?.request) throw new Error('HTTP request transport is unavailable');
        let current = url;
        let resolved = value;
        for (let hop = 0; hop <= maxRedirects; hop += 1) {
          const signal = signalFactory?.(timeoutMs);
          const response = await http.request({ method: 'HEAD', url: current.href, redirect: 'manual', ...(signal ? { signal } : {}) });
          const location = response?.headers?.location;
          if (!REDIRECT_STATUSES.has(response?.status) || !location) break;
          const destination = new URL(location, current);
          if (!isSafeResolvedUrl(destination.href)) throw new Error('Short URL resolved to an unsafe destination');
          resolved = destination.href;
          if (!hosts.has(destination.hostname.toLowerCase())) break;
          if (hop === maxRedirects) throw new Error('Short URL exceeded the redirect limit');
          current = destination;
        }
        cache.set(value, { url: resolved, expiresAt: now() + ttlMs });
        metrics?.increment?.('short_url_resolution', { outcome: resolved === value ? 'unchanged' : 'resolved', host: url.hostname });
        return resolved;
      } catch (error) {
        metrics?.increment?.('short_url_resolution', { outcome: 'failed', host: url.hostname });
        logger?.warn?.(`Could not resolve short URL ${value}`, error);
        return value;
      }
    },
    cache,
  };
}

export function createResolvingParser({ parser, resolver, policy } = {}) {
  if (typeof parser !== 'function') throw new Error('Resolving parser requires a parser');
  return async (message, config) => {
    const parsed = await parser(message, config);
    if (!parsed) return null;
    if (parsed.signal) {
      let signal = structuredClone(parsed.signal);
      if (signal.url) signal.url = await resolver.resolve(signal.url);
      if (signal.products) {
        signal.products = await Promise.all(signal.products.map(async (product) => ({
          ...product,
          ...(product.url ? { url: await resolver.resolve(product.url) } : {}),
        })));
      }
      const eligible = policy ? await policy({ ...parsed, signal }) : { ...parsed, signal };
      if (!eligible) return null;
      signal = eligible.signal;
      const drops = signalsToDrops(signal);
      return { ...eligible, signal, drops, drop: drops.length === 1 ? drops[0] : null };
    }
    if (parsed.productUrls) {
      const productUrls = Object.fromEntries(await Promise.all(Object.entries(parsed.productUrls).map(async ([site, url]) => [site, await resolver.resolve(url)])));
      const resolved = { ...parsed, productUrls };
      return policy ? policy(resolved) : resolved;
    }
    return policy ? policy(parsed) : parsed;
  };
}
