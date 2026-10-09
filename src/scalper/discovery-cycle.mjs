import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AlertManager } from './alerts.mjs';
import { DiscoveryPaperExecutor } from './discovery-paper.mjs';
import { DropCalendar } from './drop-calendar.mjs';
import { loadEnvFile } from './env.mjs';
import {
  BestBuySearchSource,
  DiscoveryCatalogStore,
  DiscoveryStateStore,
  RetailerDiscoveryTracker,
  TargetSearchSource,
} from './retailer-discovery.mjs';
import { createHttpTransport } from './transports/http.mjs';
import { loadWatchlist } from './watchlist.mjs';
import { OperationalEventLog } from './operations.mjs';
import { createScalper } from './wiring.mjs';
import { InventorySampleStore, SITE_CONFIGS } from './inventory-scanner.mjs';
import { MeasuredInventoryDiscoverySource } from './inventory-discovery.mjs';
import { createTrafficGovernor } from './rate-limit.mjs';

export async function loadDiscoveryConfig(path = 'config/scalper-discovery.json') {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.sources)) throw new Error('Invalid discovery config');
  return config;
}

export async function loadProductEndpointConfig(path = 'config/scalper-product-endpoints.json') {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.endpoints)) throw new Error('Invalid product endpoint config');
  return config;
}

export async function createDiscoveryCycle({
  config,
  http = createHttpTransport(),
  alerts,
  store,
  catalogStore,
  watchlist,
  onActionable,
  env = process.env,
  endpointConfig,
  governor,
  samples,
  events,
} = {}) {
  const resolvedConfig = config ?? await loadDiscoveryConfig();
  const resolvedAlerts = alerts ?? new AlertManager({ transport: http });
  const resolvedWatchlist = watchlist === false ? null
    : watchlist ?? await loadWatchlist({ path: resolvedConfig.watchlistPath ?? 'config/scalper-watchlist.json' });
  const hasMeasuredSources = resolvedConfig.sources.some((source) => source.enabled !== false && source.type === 'measured-product-endpoints');
  const resolvedEndpoints = hasMeasuredSources
    ? endpointConfig ?? await loadProductEndpointConfig(resolvedConfig.productEndpointsPath ?? 'config/scalper-product-endpoints.json')
    : null;
  const resolvedGovernor = hasMeasuredSources ? governor ?? createTrafficGovernor({
    policies: Object.fromEntries(Object.entries(SITE_CONFIGS).map(([site, siteConfig]) => [site, siteConfig.polling])),
  }) : null;
  const governedHttp = new Map();
  const httpForSite = (site) => {
    if (!governedHttp.has(site)) governedHttp.set(site, resolvedGovernor.httpFor(site, http));
    return governedHttp.get(site);
  };
  const sources = resolvedConfig.sources.filter((source) => source.enabled !== false).map((source) => {
    if (source.type === 'bestbuy-search') return new BestBuySearchSource({
      ...source,
      http,
      productMatcher: resolvedWatchlist?.match,
    });
    if (source.type === 'target-search') return new TargetSearchSource({
      ...source,
      apiKey: source.apiKey ?? env.TARGET_PUBLIC_SEARCH_KEY,
      http,
      productMatcher: resolvedWatchlist?.match,
    });
    if (source.type === 'measured-product-endpoints') return new MeasuredInventoryDiscoverySource({
      ...source,
      endpoints: resolvedEndpoints.endpoints,
      products: resolvedWatchlist?.products ?? [],
      httpForSite,
      samples: samples ?? new InventorySampleStore({ dataDir: env.SCALPER_DATA_DIR || 'data/scalper' }),
      events,
    });
    throw new Error(`Unsupported discovery source type: ${source.type}`);
  });
  return new RetailerDiscoveryTracker({
    sources,
    alerts: resolvedAlerts,
    store: store ?? new DiscoveryStateStore({ path: resolvedConfig.statePath }),
    catalogStore: catalogStore ?? new DiscoveryCatalogStore({
      path: resolvedConfig.catalogPath,
      configuredProducts: resolvedConfig.products,
    }),
    onActionable,
  });
}

export async function runDiscoveryCycle({ notifyCurrent = false, ...options } = {}) {
  const tracker = await createDiscoveryCycle(options);
  return tracker.capture({ notifyCurrent });
}

export async function runAutonomousDiscoveryCycle({
  env = process.env,
  notifyCurrent = false,
  create = createScalper,
  now = Date.now,
  ...options
} = {}) {
  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  const events = options.events ?? new OperationalEventLog({ path: `${dataDir}/operations-events.jsonl`, now });
  const http = options.http ?? createHttpTransport();
  const alerts = options.alerts ?? new AlertManager({
    webhookUrl: env.SCALPER_ALERT_WEBHOOK_URL || env.SCALPER_DISCORD_WEBHOOK_URL,
    transport: http,
    events,
    now,
  });
  const paperEnabled = env.SCALPER_LIVE !== '1' && env.SCALPER_DISCOVERY_PAPER !== '0';
  let scalperPromise;
  const onActionable = paperEnabled ? async (item, context) => {
    scalperPromise ??= (async () => {
      const calendar = new DropCalendar({ path: `${dataDir}/discovery-drops.json`, now });
      const scalper = await create({ env, calendar, alerts, connectDiscord: false });
      const executor = new DiscoveryPaperExecutor({ env, calendar, orchestrator: scalper.orchestrator, events });
      return { scalper, executor };
    })();
    const { executor } = await scalperPromise;
    return executor.execute(item, context);
  } : undefined;
  const startedAt = now();
  let result;
  try {
    result = await runDiscoveryCycle({ ...options, env, http, alerts, notifyCurrent, onActionable });
    await events.record('discovery-cycle', {
      durationMs: Math.max(0, now() - startedAt),
      sources: result.sources,
      items: result.items,
      actionable: result.actionable,
      transitions: result.alerts.length,
      executions: result.executions.length,
      errors: result.errors,
    });
    return result;
  } finally {
    if (scalperPromise) await (await scalperPromise).scalper.stop?.();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const notifyCurrent = process.argv.includes('--notify-current');
  const result = await runAutonomousDiscoveryCycle({ notifyCurrent });
  console.log(JSON.stringify(result, null, 2));
  if (result.sources === 0 && result.errors.length) process.exitCode = 1;
}
