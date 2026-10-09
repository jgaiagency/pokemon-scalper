import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCheckoutRecipe } from './checkout-recipes.mjs';

// Reads a measurement session (interactions.json + network.har) and produces
// a draft checkout recipe. The operator reviews and edits the draft before
// it is trusted. The output is validated against the same schema the
// Playwright adapter enforces at runtime. It never supplies selector defaults:
// absent measurement evidence is an error, not a generated guess.

function harEntries(har) {
  return har?.log?.entries ?? [];
}

function isCheckoutRequest(entry) {
  const url = entry?.request?.url ?? '';
  const method = entry?.request?.method ?? 'GET';
  const interesting = /checkout|place.?order|submit|confirm|payment|shipping/i;
  return method !== 'GET' && interesting.test(url);
}

function isProductRequest(entry) {
  const url = entry?.request?.url ?? '';
  return /product|availability|stock|cart/i.test(url) && entry?.response?.status === 200;
}

function selectorsFromInteraction(interaction) {
  return (interaction.selectors ?? []).filter((selector) => typeof selector === 'string' && selector.trim());
}

function inferAction(interaction) {
  const tag = interaction.tag?.toLowerCase() ?? '';
  const type = interaction.type?.toLowerCase() ?? '';
  const kind = interaction.kind ?? 'click';
  if (kind === 'change' && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
    if (type === 'select-one' || tag === 'select') return 'select';
    if (type === 'checkbox' || type === 'radio') return 'check';
    return 'fill';
  }
  return 'click';
}

function inferPhase(interaction, action) {
  const text = interaction.text ?? '';
  const url = interaction.url ?? '';
  if (/place.?order|submit|confirm|buy.?now|complete/i.test(text)) return 'submitting';
  if (/add.?to.?cart|add.?to.?bag/i.test(text)) return 'carting';
  if (/checkout|payment|shipping|delivery|billing/i.test(`${text} ${url}`)) return 'checkout';
  return action === 'click' ? 'checkout' : 'checkout';
}

function buildSteps(interactions) {
  const steps = [];
  for (const interaction of interactions) {
    const selectors = selectorsFromInteraction(interaction);
    if (!selectors.length) continue;
    const action = inferAction(interaction);
    const step = { action, selectors, phase: inferPhase(interaction, action) };
    if (action === 'fill' || action === 'select') step.value = '__FILL_ME__';
    if (action === 'click' && /place.?order|submit|confirm|buy.?now|complete/i.test(interaction.text ?? '')) {
      step.commit = true;
    }
    steps.push(step);
    if (step.commit) break;
  }
  return steps;
}

function buildConfirmation(interactions) {
  const confirmationInteraction = interactions.find((interaction) => /order.?confirm|thank.?you|success|receipt/i.test(interaction.text ?? ''));
  const selectors = confirmationInteraction ? selectorsFromInteraction(confirmationInteraction) : [];
  return selectors.length ? { selectors, timeoutMs: 30_000 } : null;
}

function extractProductEndpoint(har) {
  const entries = harEntries(har).filter(isProductRequest);
  if (!entries.length) return null;
  const entry = entries[0];
  const url = new URL(entry.request.url);
  return {
    url: `${url.origin}${url.pathname}`,
    method: entry.request.method,
    notes: 'Extracted from HAR. Verify the response shape matches isAvailable() in detect.mjs.',
  };
}

function extractCheckoutEndpoints(har) {
  const entries = harEntries(har).filter(isCheckoutRequest);
  return entries.map((entry) => {
    const url = new URL(entry.request.url);
    return {
      url: `${url.origin}${url.pathname}`,
      method: entry.request.method,
      requestBody: 'redacted; measure and map only non-secret fields manually',
    };
  });
}

export async function generateRecipe({
  site,
  measurementDir,
  outputDir = 'config',
  readText = (path) => readFile(path, 'utf8'),
  writeText = (path, value) => writeFile(path, value, 'utf8'),
} = {}) {
  if (!site) throw new Error('Recipe generation requires a site name');
  if (!measurementDir) throw new Error('Recipe generation requires a measurement directory');

  const interactionsPath = join(measurementDir, 'interactions.json');
  const harPath = join(measurementDir, 'network.har');

  let interactions = [];
  try {
    interactions = JSON.parse(await readText(interactionsPath));
    if (!Array.isArray(interactions)) interactions = [];
  } catch { /* The explicit error below reports missing measured interactions. */ }

  let har = null;
  try {
    har = JSON.parse(await readText(harPath));
  } catch { /* No HAR file — endpoints will be null. */ }

  const steps = buildSteps(interactions);
  if (!steps.length) throw new Error('No measured checkout selectors were recorded; refusing to generate selector guesses');
  if (!steps.some((step) => step.commit)) throw new Error('No measured commit interaction was identified; mark and review the irreversible click before generating');
  const confirmation = buildConfirmation(interactions);
  if (!confirmation) throw new Error('No measured confirmation selector was recorded; refusing to generate a confirmation guess');

  const recipe = {
    version: 1,
    site,
    steps,
    confirmation,
    challenges: [],
    navigation: { retries: 1, timeoutMs: 30000, waitUntil: 'domcontentloaded' },
    ...(har ? { endpoints: { product: extractProductEndpoint(har), checkout: extractCheckoutEndpoints(har) } } : {}),
  };

  validateCheckoutRecipe(recipe, site);

  const outputPath = join(outputDir, 'scalper-browser-recipes.json');
  let existing = { version: 1, sites: {} };
  try {
    existing = JSON.parse(await readText(outputPath));
  } catch { /* First recipe — start fresh. */ }
  existing.sites[site] = recipe;
  await writeText(outputPath, `${JSON.stringify(existing, null, 2)}\n`);

  return { site, outputPath, steps: steps.length, hasHar: Boolean(har), interactions: interactions.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [site, measurementDir] = process.argv.slice(2);
  if (!site || !measurementDir) {
    console.error('Usage: node recipe-generator.mjs <site> <measurement-dir>');
    console.error('  site: pokemon-center | tcgplayer | bestbuy | target');
    console.error('  measurement-dir: output of npm run scalper:measure');
    process.exit(1);
  }
  const result = await generateRecipe({ site, measurementDir });
  console.log(JSON.stringify(result, null, 2));
}
