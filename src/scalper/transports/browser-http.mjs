import { browserProfilePath, SITE_HOME_URLS } from '../browser-session.mjs';

// A Playwright-context HTTP transport. Unlike the bare node-fetch transport,
// every request goes through the browser's network stack — same cookies
// (including the Imperva Incapsula trust tokens), same TLS/JA3 fingerprint,
// same headers — so a WAF that 403s a cold fetch accepts the context request.
//
// This is the fix for Pokémon Center's Incapsula wall: warm the context on the
// home page (let the challenge iframe run and set visid_incap/incap_ses), then
// poll the product endpoint through context.request so it carries the trust.

function headerEntries(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function extractJsonLd(html) {
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.['@type'] === 'Product') return data;
    } catch { /* Keep scanning. */ }
  }
  return null;
}

async function parseBody(response) {
  // Playwright APIResponse: status(), text(), headers(), url() are all methods.
  if (!response || ['status', 'text', 'headers', 'url'].some((name) => typeof response[name] !== 'function')) {
    throw new Error('Browser HTTP transport requires a Playwright APIResponse method shape');
  }
  const status = response.status();
  const rawHeaders = response.headers();
  const headers = headerEntries(rawHeaders);
  const body = await response.text();
  const url = response.url();
  const result = { status, headers, body, url };
  const contentType = headers['content-type'] ?? '';
  if (/\b(?:application|text)\/[\w.+-]*json\b/i.test(contentType) || /\+json\b/i.test(contentType)) {
    try { result.bodyJson = JSON.parse(body); } catch { /* Keep invalid JSON as text. */ }
  } else if (/\btext\/html\b/i.test(contentType) || /\bhtml\b/i.test(contentType)) {
    const jsonLd = extractJsonLd(body);
    if (jsonLd) result.bodyJson = jsonLd;
  }
  return result;
}

export function createBrowserHttpTransport({
  context,
  warmUrl,
  warmUp = true,
  waitForChallenge = true,
  challengeTimeoutMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logger,
} = {}) {
  if (typeof context?.request?.fetch !== 'function') throw new Error('Browser HTTP transport requires a Playwright context with a request API');
  let page = context.pages()[0] ?? null;

  const isChallengePage = async (target) => {
    if (!target) return false;
    try {
      const html = await target.content();
      return /_Incapsula_Resource|incapsula|datadome|akamai|_abck|captcha|challenge/i.test(html);
    } catch { return false; }
  };

  const warm = async () => {
    if (!warmUp || !warmUrl) return;
    logger?.({ step: 'warm', url: warmUrl });
    const target = page ?? await context.newPage();
    page = target;
    await target.goto(warmUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (waitForChallenge) {
      // Wait for the WAF challenge to clear (the trust cookies to be set).
      const deadline = Date.now() + challengeTimeoutMs;
      while (Date.now() < deadline) {
        if (!(await isChallengePage(target))) break;
        await sleep(1_000);
      }
      // Give the challenge JS a moment to finish setting cookies.
      await sleep(2_000);
    }
    logger?.({ step: 'warm-complete' });
  };

  const request = async ({ method = 'GET', url, headers, body, timeoutMs = 30_000, redirect } = {}) => {
    if (!url) throw new Error('Browser HTTP request URL is required');
    const response = await context.request.fetch(url, {
      method, headers, data: body, timeout: timeoutMs,
      ...(redirect === 'manual' ? { maxRedirects: 0 } : {}),
    });
    return parseBody(response);
  };

  return {
    warm,
    request,
    get(url, { headers, timeoutMs, redirect } = {}) {
      return request({ method: 'GET', url, headers, timeoutMs, redirect });
    },
    postJson(url, body, { headers, timeoutMs } = {}) {
      return request({
        method: 'POST', url, body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...headers }, timeoutMs,
      });
    },
  };
}

// Open a warmed Playwright context for a site and return a context-aware HTTP
// transport. The context is left open (caller closes it) so the WAF trust
// persists across polls.
export async function openWarmedBrowserTransport({
  site,
  accountId = 'default',
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  browserPath = process.env.SCALPER_BROWSER_PATH || undefined,
  loadPlaywright = () => import('playwright'),
  warmUrl,
  waitForChallenge = true,
  challengeTimeoutMs = 30_000,
  logger,
} = {}) {
  if (!SITE_HOME_URLS[site]) throw new Error(`Unsupported browser transport site: ${site}`);
  const { chromium } = await loadPlaywright();
  const profile = browserProfilePath({ dataDir, site, accountId });
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false,
    ...(browserPath ? { executablePath: browserPath } : {}),
  });
  try {
    const transport = createBrowserHttpTransport({
      context,
      warmUrl: warmUrl ?? SITE_HOME_URLS[site],
      waitForChallenge,
      challengeTimeoutMs,
      logger,
    });
    await transport.warm();
    return { context, transport };
  } catch (error) {
    await context.close();
    throw error;
  }
}
