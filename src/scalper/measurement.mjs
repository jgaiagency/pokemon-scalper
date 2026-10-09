import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

async function waitForEnter() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { await terminal.question('Use Chrome manually, then press Enter here to stop recording. '); } finally { terminal.close(); }
}

function installInteractionCapture() {
  const trim = (value, limit = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const cssEscape = globalThis.CSS?.escape ?? ((value) => String(value).replace(/[^A-Za-z0-9_-]/g, '\\$&'));
  const selectorsFor = (element) => {
    const selectors = [];
    if (element.id) selectors.push(`#${cssEscape(element.id)}`);
    for (const name of ['data-testid', 'data-test', 'data-automation-id', 'data-track']) {
      const value = element.getAttribute?.(name);
      if (value) selectors.push(`[${name}="${cssEscape(value)}"]`);
    }
    const aria = element.getAttribute?.('aria-label');
    if (aria) selectors.push(`${element.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`);
    const name = element.getAttribute?.('name');
    if (name) selectors.push(`${element.tagName.toLowerCase()}[name="${cssEscape(name)}"]`);
    return [...new Set(selectors)].slice(0, 6);
  };
  const capture = (kind, event) => {
    const target = event.target?.closest?.('button,a,input,select,textarea,[role="button"],[role="link"]');
    if (!target) return;
    globalThis.__scalperRecordInteraction?.({
      kind,
      url: location.href,
      tag: target.tagName?.toLowerCase(),
      role: target.getAttribute?.('role') || null,
      type: target.getAttribute?.('type') || null,
      text: ['button', 'a'].includes(target.tagName?.toLowerCase()) ? trim(target.textContent) : null,
      selectors: selectorsFor(target),
    }).catch?.(() => {});
  };
  document.addEventListener('click', (event) => capture('click', event), true);
  document.addEventListener('change', (event) => capture('change', event), true);
}

function sanitizeInteraction(value, timestamp) {
  let url = null;
  try {
    const parsed = new URL(value?.url);
    url = `${parsed.origin}${parsed.pathname}`;
  } catch { /* Ignore malformed page URLs. */ }
  return {
    timestamp,
    kind: value?.kind === 'change' ? 'change' : 'click',
    url,
    tag: String(value?.tag ?? '').slice(0, 32) || null,
    role: String(value?.role ?? '').slice(0, 64) || null,
    type: String(value?.type ?? '').slice(0, 64) || null,
    text: String(value?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || null,
    selectors: Array.isArray(value?.selectors)
      ? value.selectors.filter((selector) => typeof selector === 'string').map((selector) => selector.slice(0, 300)).slice(0, 6)
      : [],
  };
}

export async function recordMeasurement({
  site,
  url,
  accountId = 'default',
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  browserPath = process.env.SCALPER_BROWSER_PATH || undefined,
  loadPlaywright = () => import('playwright'),
  makeDirectory = (path) => mkdir(path, { recursive: true }),
  waitForOperator = waitForEnter,
  now = Date.now,
  logger = console,
  writeText = (path, value) => writeFile(path, value, { encoding: 'utf8', mode: 0o600 }),
} = {}) {
  if (!site) throw new Error('Measurement site is required');
  let productUrl;
  try { productUrl = new URL(url); } catch { throw new Error('Measurement URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(productUrl.protocol)) throw new Error('Measurement URL must be HTTP(S)');
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const outputDir = join(dataDir, 'measurements', `${safeSegment(site)}-${stamp}`);
  const harPath = join(outputDir, 'network.har');
  const tracePath = join(outputDir, 'trace.zip');
  const interactionsPath = join(outputDir, 'interactions.json');
  const profile = join(dataDir, 'browser-profiles', `${safeSegment(site)}-${safeSegment(accountId)}`);
  await makeDirectory(outputDir);
  logger?.warn?.(`Measurement artifacts can contain session and checkout data. Keep ${outputDir} private.`);
  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false,
    ...(browserPath ? { executablePath: browserPath } : {}),
    recordHar: { path: harPath, mode: 'minimal', content: 'omit' },
  });
  let traceStarted = false;
  const interactions = [];
  try {
    await context.exposeBinding('__scalperRecordInteraction', (_source, value) => {
      interactions.push(sanitizeInteraction(value, new Date(now()).toISOString()));
    });
    await context.addInitScript(installInteractionCapture);
    await context.tracing.start({ screenshots: false, snapshots: true, sources: true });
    traceStarted = true;
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(productUrl.href, { waitUntil: 'domcontentloaded' });
    await waitForOperator();
  } finally {
    try {
      if (traceStarted) await context.tracing.stop({ path: tracePath });
    } finally {
      try {
        await writeText(interactionsPath, `${JSON.stringify(interactions, null, 2)}\n`);
      } finally {
        await context.close();
      }
    }
  }
  await Promise.all([harPath, tracePath, interactionsPath].map((path) => chmod(path, 0o600).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  })));
  return { outputDir, harPath, tracePath, interactionsPath, profile };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  if (process.env.SCALPER_MEASURE_ACK !== '1') {
    throw new Error('Set SCALPER_MEASURE_ACK=1 to acknowledge that HAR/trace files may contain sensitive session data');
  }
  const [site, url, accountId] = process.argv.slice(2);
  const result = await recordMeasurement({ site, url, accountId });
  console.log(JSON.stringify(result, null, 2));
}
