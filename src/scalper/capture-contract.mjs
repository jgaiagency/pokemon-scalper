import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

// Captures the REAL first-party JSON responses at each purchase stage so the
// operator can fill the inventory contract (availableWhen + fields) and the
// recorded-contract fixtures without fabricating payloads.
//
// It drives a visible Chrome (channel: chrome, headless: false) against the
// live site, records every JSON response the page makes, and lets the operator
// tag which response is the availability / cart / checkout / confirmation
// payload. The tagged bodies are written to tests/fixtures/<site>/ and a draft
// product-endpoints contract row is emitted for review.
//
// This is a MEASUREMENT tool. It never submits an order by itself: the
// operator performs the add-to-cart / checkout / place-order actions in the
// visible browser, and this tool only observes the network.

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

async function prompt(message) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(message)).trim(); } finally { terminal.close(); }
}

function isJsonResponse(entry) {
  const contentType = String(entry?.contentType ?? entry?.response?.content?.mimeType ?? '').toLowerCase();
  return contentType.includes('json') || contentType === '';
}

function normalizeAvailabilityState(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['in', 'in-stock', 'available'].includes(normalized)) return 'in-stock';
  if (['out', 'out-of-stock', 'unavailable'].includes(normalized)) return 'out-of-stock';
  if (normalized === 'skip') return 'skip';
  throw new Error('Availability state must be in-stock, out-of-stock, or skip');
}

function redactBody(body) {
  // Keep field names and value types; replace obvious secret values with stable
  // synthetic tokens so the fixtures are usable but not leaky.
  const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|cvv|card|email|phone|street|city|zip|postal/i;
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = SECRET_KEY.test(key) && typeof item === 'string' ? `[${key.toUpperCase()}_TOKEN]` : walk(item);
      }
      return out;
    }
    return value;
  };
  return walk(body);
}

function bodyOf(entry) {
  const text = entry?.response?.content?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function captureContract({
  site,
  url,
  accountId = 'default',
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  fixturesDir = `tests/fixtures/${site}`,
  endpointsPath = 'config/scalper-product-endpoints.json',
  productId,
  availabilityState: requestedAvailabilityState,
  browserPath = process.env.SCALPER_BROWSER_PATH || undefined,
  loadPlaywright = () => import('playwright'),
  makeDirectory = (path) => mkdir(path, { recursive: true }),
  promptFn = prompt,
  now = Date.now,
  logger = console,
  writeText = (path, value) => writeFile(path, value, { encoding: 'utf8', mode: 0o600 }),
} = {}) {
  if (!site) throw new Error('Capture site is required');
  if (!productId) throw new Error('Capture requires a --product-id (the local drop id)');
  let availabilityState = normalizeAvailabilityState(requestedAvailabilityState);
  let productUrl;
  try { productUrl = new URL(url); } catch { throw new Error('Capture URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(productUrl.protocol)) throw new Error('Capture URL must be HTTP(S)');

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const outputDir = join(dataDir, 'captures', `${safeSegment(site)}-${stamp}`);
  await makeDirectory(outputDir);
  await makeDirectory(fixturesDir);
  const profile = join(dataDir, 'browser-profiles', `${safeSegment(site)}-${safeSegment(accountId)}`);
  logger?.warn?.(`Capture artifacts can contain session and checkout data. Keep ${outputDir} and ${fixturesDir} private.`);

  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false,
    ...(browserPath ? { executablePath: browserPath } : {}),
    recordHar: { path: join(outputDir, 'network.har'), mode: 'minimal', content: 'embed' },
  });
  const captured = [];
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.on('response', async (response) => {
      try {
        const entry = {
          url: response.url(),
          status: response.status(),
          contentType: response.headers()['content-type'] ?? null,
          at: new Date(now()).toISOString(),
        };
        if (!isJsonResponse(entry)) return;
        const body = await response.json().catch(() => null);
        if (body === null) return;
        entry.body = body;
        entry.bodySha256 = sha256(body);
        captured.push(entry);
      } catch { /* Non-JSON or already-consumed bodies are skipped. */ }
    });
    await page.goto(productUrl.href, { waitUntil: 'domcontentloaded' });
    logger?.warn?.('Browser is open. Perform the flow in the visible window:');
    logger?.warn?.('  1) confirm the product page shows the in-stock (or out-of-stock) state you want to record');
    logger?.warn?.('  2) add to cart, open the cart, proceed to checkout, and (optionally) place the order');
    logger?.warn?.('Then return here and tag the captured responses. Press Enter to list them.');
    await promptFn('Press Enter to list the captured JSON responses... ');

    const jsonEntries = captured.filter((entry) => entry.body !== null);
    if (!jsonEntries.length) throw new Error('No JSON responses were captured; the page may not have loaded or the product is not JSON-backed');
    jsonEntries.forEach((entry, index) => {
      const preview = JSON.stringify(entry.body).slice(0, 120);
      logger?.log?.(`[${index}] ${entry.status} ${entry.url}\n    ${preview}...`);
    });

    const tag = async (label, hint) => {
      const answer = await promptFn(`${label} (index, or "skip"): ${hint}\n> `);
      if (!answer || answer === 'skip') return null;
      const index = Number(answer);
      if (!Number.isInteger(index) || index < 0 || index >= jsonEntries.length) return null;
      return jsonEntries[index];
    };

    if (!availabilityState) {
      availabilityState = normalizeAvailabilityState(await promptFn('Observed availability state (in-stock, out-of-stock, or skip): '));
    }
    const availability = availabilityState === 'skip'
      ? null
      : await tag(`Tag the ${availabilityState.toUpperCase()} AVAILABILITY response`, '(the response whose fields prove this exact state)');
    const cart = await tag('Tag the CART response', '(items + totals)');
    const checkout = await tag('Tag the CHECKOUT response', '(payment/shipping/total before the final click)');
    const confirmation = await tag('Tag the CONFIRMATION response', '(order id + status after the final click)');

    const writeFixture = async (name, entry) => {
      if (!entry) return null;
      const redacted = redactBody(entry.body);
      const path = join(fixturesDir, name);
      await writeText(path, `${JSON.stringify(redacted, null, 2)}\n`);
      return { name, path, status: entry.status, url: entry.url, bodySha256: entry.bodySha256 };
    };

    const fixtures = [
      await writeFixture(availability ? `${availabilityState}.json` : null, availability),
      await writeFixture('cart.json', cart),
      await writeFixture('checkout.json', checkout),
      await writeFixture('confirmation.json', confirmation),
    ].filter(Boolean);

    const metadata = {
      site,
      productId,
      capturedAt: new Date(now()).toISOString(),
      node: process.version,
      fixtures: fixtures.map((item) => item.name),
      availability: availability ? {
        state: availabilityState,
        status: availability.status,
        url: availability.url,
        bodySha256: availability.bodySha256,
      } : null,
      expectedCart: cart ? { note: 'Fill the synthetic address/total values the attestation gate must match' } : null,
    };
    const metadataPath = join(fixturesDir, 'capture-metadata.json');
    await writeText(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    // Draft product-endpoints contract row. The operator must fill
    // availableWhen + fields with the OBSERVED paths/values before trusting it.
    const draftEndpoint = {
      productId,
      site,
      pollUrl: availability ? `${new URL(availability.url).origin}${new URL(availability.url).pathname}` : productUrl.href,
      measuredAt: now(),
      metadata: {
        contract: {
          availableWhen: [{ path: '__OBSERVED_PATH__', equals: '__OBSERVED_VALUE__' }],
          fields: {
            quantity: '__OBSERVED_PATH__',
            priceCents: '__OBSERVED_PATH__',
            sku: '__OBSERVED_PATH__',
            seller: '__OBSERVED_PATH__',
            fulfillment: '__OBSERVED_PATH__',
          },
        },
      },
    };
    const draftPath = join(outputDir, 'product-endpoint-draft.json');
    await writeText(draftPath, `${JSON.stringify(draftEndpoint, null, 2)}\n`);

    await Promise.all([metadataPath, draftPath].map((path) => chmod(path, 0o600).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    })));

    return {
      site,
      productId,
      outputDir,
      fixturesDir,
      fixtures: fixtures.map((item) => item.name),
      draftEndpointPath: draftPath,
      endpointsPath,
      capturedJson: jsonEntries.length,
      next: [
        `Review ${draftPath} and fill availableWhen + fields with the OBSERVED paths/values.`,
        `Append the completed row to ${endpointsPath} (endpoints array).`,
        `Run: npm run scalper:inventory -- ${site}`,
        `Run: npm run scalper:canary -- ${site}`,
      ],
    };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  if (process.env.SCALPER_CAPTURE_ACK !== '1') {
    throw new Error('Set SCALPER_CAPTURE_ACK=1 to acknowledge that capture files may contain sensitive session/checkout data');
  }
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const positional = args.filter((value, index) => !args[index - 1] || !['--product-id', '--account', '--availability'].includes(args[index - 1]));
  const [site, url] = positional;
  const result = await captureContract({
    site,
    url,
    productId: flag('--product-id'),
    accountId: flag('--account') ?? 'default',
    availabilityState: flag('--availability'),
  });
  console.log(JSON.stringify(result, null, 2));
}
