import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { createEbayBrowseSource, createTcgplayerMarketSource } from './market-sources.mjs';
import { loadMarketConfig, MarketObservationStore, MarketTracker } from './market-tracker.mjs';
import { createHttpTransport } from './transports/http.mjs';

export async function createMarketTracker({
  env = process.env,
  http = createHttpTransport(),
  config,
  store = new MarketObservationStore({ path: `${env.SCALPER_DATA_DIR || 'data/scalper'}/market-observations.jsonl` }),
} = {}) {
  const resolvedConfig = config ?? await loadMarketConfig();
  const sources = [];
  if (env.TCGPLAYER_PUBLIC_KEY && env.TCGPLAYER_PRIVATE_KEY) {
    sources.push(createTcgplayerMarketSource({
      http,
      publicKey: env.TCGPLAYER_PUBLIC_KEY,
      privateKey: env.TCGPLAYER_PRIVATE_KEY,
      accessToken: env.TCGPLAYER_ACCESS_TOKEN || undefined,
    }));
  }
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    sources.push(createEbayBrowseSource({
      http,
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
    }));
  }
  return new MarketTracker({ config: resolvedConfig, store, sources });
}

function parseImport(source) {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('Market import JSON must be an array');
    return parsed;
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export async function runMarketCommand(command, args = [], {
  tracker,
  readText = (path) => readFile(path, 'utf8'),
  env = process.env,
} = {}) {
  const resolved = tracker ?? await createMarketTracker({ env });
  if (command === 'capture') return resolved.capture();
  if (command === 'rank') return resolved.rank();
  if (command === 'report') {
    const capture = await resolved.capture();
    return { capture, ranking: await resolved.rank() };
  }
  if (command === 'import') {
    const path = args[0];
    if (!path) throw new Error('Market import requires a JSON or JSONL file path');
    const values = parseImport(await readText(path));
    const configuredIds = resolved.config?.products ? new Set(resolved.config.products.map((product) => product.id)) : null;
    for (const value of values) {
      if (configuredIds && !configuredIds.has(value.productId)) throw new Error(`Market import references unknown product: ${value.productId}`);
      await resolved.store.append(value);
    }
    return { imported: values.length, path };
  }
  throw new Error(`Unknown market command: ${command ?? '(missing)'}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const result = await runMarketCommand(process.argv[2], process.argv.slice(3));
  console.log(JSON.stringify(result, null, 2));
}
