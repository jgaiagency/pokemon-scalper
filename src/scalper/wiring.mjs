import { AccountManager } from './accounts.mjs';
import { AlertManager } from './alerts.mjs';
import { createBrowserProfileSessionManager } from './browser-session.mjs';
import { CheckoutRecipeProvider } from './checkout-recipes.mjs';
import { HumanChallengeBroker } from './challenge-broker.mjs';
import { SynchronizedClock } from './clock.mjs';
import { DiscordFeed, loadDiscordConfig } from './discord-feed.mjs';
import { DropCalendar, validateDrop } from './drop-calendar.mjs';
import { DryRunHarness } from './dry-run.mjs';
import { runDoctor } from './doctor.mjs';
import { loadEnvFile } from './env.mjs';
import { MetricsRegistry } from './metrics.mjs';
import { loadMarketConfig, MarketObservationStore } from './market-tracker.mjs';
import { createMonitorAwareParser } from './monitor-parser.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { createAccountSelector, createRuntimeLanes } from './runtime.mjs';
import { PurchaseLedger, SafetyPolicy } from './safety.mjs';
import { KeychainVault } from './secret-vault.mjs';
import { createSignalAlertHandler } from './signal-alerts.mjs';
import { createLane as createBestBuyLane } from './sites/bestbuy/index.mjs';
import { config as bestBuyConfig } from './sites/bestbuy/config.mjs';
import { createLane as createPokemonCenterLane } from './sites/pokemon-center/index.mjs';
import { config as pokemonCenterConfig } from './sites/pokemon-center/config.mjs';
import { createLane as createTargetLane } from './sites/target/index.mjs';
import { config as targetConfig } from './sites/target/config.mjs';
import { createLane as createTcgplayerLane } from './sites/tcgplayer/index.mjs';
import { config as tcgplayerConfig } from './sites/tcgplayer/config.mjs';
import { createPlaywrightBrowserAdapter } from './transports/browser.mjs';
import { createDiscordWsTransport } from './transports/discord-ws.mjs';
import { createHttpTransport } from './transports/http.mjs';
import { createNtpTransport } from './transports/ntp.mjs';
import { createResolvingParser, createUrlResolver } from './url-resolver.mjs';
import { loadWatchlist } from './watchlist.mjs';
import { PurchaseTaskStore } from './task-state.mjs';
import { createStateStore, migrateLegacyState } from './state-store.mjs';
import { createRetailUrlPolicy } from './retail-url-policy.mjs';
import { OperationalEventLog } from './operations.mjs';
import { createTrafficGovernor } from './rate-limit.mjs';
import { importProductEndpoints } from './product-endpoints.mjs';
import { checkCanaryReadiness } from './canary-readiness.mjs';

export async function createScalper({
  env = process.env,
  loadEnv = loadEnvFile,
  ntpTransport,
  httpTransport,
  discordTransport,
  browser,
  recipeProvider,
  clock,
  calendar,
  accounts,
  vault,
  dryRun,
  alerts,
  discordFeed,
  discordParser,
  signalDeduper,
  accountSelector,
  sessionManagers,
  sessionManagerFactories,
  laneFactories,
  safety,
  ledger,
  marketConfig,
  marketStore,
  stateStore,
  database,
  migrateState = true,
  tasks,
  challengeBroker,
  metrics,
  trafficGovernor,
  events,
  urlResolver,
  watchlist,
  alertMinRank,
  orchestrator,
  lanes,
  discordConfig,
  logger = console,
  connectDiscord = true,
  preflight = true,
  preflightCheck = runDoctor,
  canaryCheck = checkCanaryReadiness,
  liveSites,
  liveDropIds,
} = {}) {
  await loadEnv({ env });

  const http = httpTransport ?? createHttpTransport();
  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  const resolvedStateStore = stateStore ?? createStateStore({
    database, path: `${dataDir}/scalper.db`, dataDir, validateDrop,
  });
  if (migrateState) await migrateLegacyState({
    database: resolvedStateStore.database,
    paths: {
      ledger: `${dataDir}/purchase-ledger.json`,
      tasks: `${dataDir}/purchase-tasks.json`,
      drops: env.SCALPER_DROPS_PATH || 'config/scalper-drops.json',
      challenges: `${dataDir}/challenges.json`,
      marker: `${dataDir}/scalper.db.migrated`,
    },
  });
  await importProductEndpoints({
    store: resolvedStateStore.productEndpoints,
    path: env.SCALPER_PRODUCT_ENDPOINTS_PATH || 'config/scalper-product-endpoints.json',
  });
  const resolvedEvents = events ?? (loadEnv === loadEnvFile
    ? new OperationalEventLog({ path: `${dataDir}/operations-events.jsonl` })
    : null);
  const resolvedMetrics = metrics ?? new MetricsRegistry();
  const resolvedCalendar = calendar ?? resolvedStateStore.calendar ?? new DropCalendar({ database: resolvedStateStore.database });
  const resolvedVault = vault ?? new KeychainVault({
    service: env.SCALPER_KEYCHAIN_SERVICE || 'com.local.pokemon-scalper',
  });
  const resolvedAccounts = accounts ?? new AccountManager({ env, vault: resolvedVault });
  const resolvedDryRun = dryRun ?? new DryRunHarness({ env });
  const resolvedAlerts = alerts ?? new AlertManager({
    webhookUrl: env.SCALPER_ALERT_WEBHOOK_URL || env.SCALPER_DISCORD_WEBHOOK_URL,
    transport: http,
    events: resolvedEvents,
  });
  const resolvedClock = clock ?? new SynchronizedClock({
    transport: ntpTransport ?? createNtpTransport(),
    alert: (event) => resolvedAlerts.clockDrift(event),
  });
  await resolvedClock.start();

  const resolvedRecipeProvider = recipeProvider ?? new CheckoutRecipeProvider();
  const resolvedTasks = tasks ?? resolvedStateStore.tasks ?? new PurchaseTaskStore({ database: resolvedStateStore.database });
  const resolvedChallengeBroker = challengeBroker ?? resolvedStateStore.createChallengeBroker({ alerts: resolvedAlerts });
  const resolvedBrowser = browser ?? createPlaywrightBrowserAdapter({
    dataDir,
    browserPath: env.SCALPER_BROWSER_PATH || undefined,
    recipeProvider: resolvedRecipeProvider,
    challengeBroker: resolvedChallengeBroker,
  });
  const resolvedTrafficGovernor = trafficGovernor ?? createTrafficGovernor({ policies: {
    'pokemon-center': pokemonCenterConfig.polling,
    bestbuy: bestBuyConfig.polling,
    target: targetConfig.polling,
    tcgplayer: tcgplayerConfig.polling,
  } });
  const sharedLaneDependencies = {
    http,
    browser: resolvedBrowser,
    dryRun: resolvedDryRun,
    clock: resolvedClock,
    env,
  };
  const resolvedLedger = ledger ?? resolvedStateStore.ledger ?? new PurchaseLedger({ database: resolvedStateStore.database });
  const resolvedMarketStore = marketStore ?? new MarketObservationStore({ path: `${dataDir}/market-observations.jsonl` });
  const resolvedMarketConfig = marketConfig ?? await loadMarketConfig().catch(() => ({ defaults: {} }));
  const resolvedSafety = safety ?? new SafetyPolicy({
    env,
    ledger: resolvedLedger,
    observations: () => resolvedMarketStore.all(),
    marketDefaults: resolvedMarketConfig.defaults,
  });
  const resolvedAccountSelector = accountSelector ?? createAccountSelector({
    accounts: resolvedAccounts,
    live: resolvedDryRun.isLive?.() ?? env.SCALPER_LIVE === '1',
  });
  const live = resolvedDryRun.isLive?.() ?? env.SCALPER_LIVE === '1';
  const factories = laneFactories ?? {
    'pokemon-center': createPokemonCenterLane,
    tcgplayer: createTcgplayerLane,
    bestbuy: createBestBuyLane,
    target: createTargetLane,
  };
  const resolvedLanes = lanes ?? await createRuntimeLanes({
    rawLanes: Object.fromEntries(Object.entries(factories).map(([site, factory]) => [site, factory({
      ...sharedLaneDependencies,
      http: resolvedTrafficGovernor.httpFor(site, http),
    })])),
    accounts: resolvedAccounts,
    env,
    accountSelector: resolvedAccountSelector,
    sessionManagers,
    sessionManagerFactories: sessionManagerFactories ?? (live
      ? Object.fromEntries(Object.keys(factories).map((site) => [site, () => createBrowserProfileSessionManager({
        site,
        accounts: resolvedAccounts,
        dataDir,
        validator: resolvedBrowser.validateSession
          ? (input) => resolvedBrowser.validateSession({ ...input, channel: 'chrome', headless: false, preserveCookies: true })
          : undefined,
      })]))
      : undefined),
    dependencies: sharedLaneDependencies,
  });
  const resolvedOrchestrator = orchestrator ?? new Orchestrator({
    calendar: resolvedCalendar,
    clock: resolvedClock,
    alerts: resolvedAlerts,
    lanes: resolvedLanes,
    safety: resolvedSafety,
    ledger: resolvedLedger,
    stateStore: resolvedStateStore,
    metrics: resolvedMetrics,
    tasks: resolvedTasks,
    logger,
  });

  const resolvedDiscordConfig = discordConfig ?? await loadDiscordConfig({ env });
  let preflightReport = null;
  if (live && preflight) {
    try {
      preflightReport = await preflightCheck({
        env,
        accounts: resolvedAccounts,
        calendar: resolvedCalendar,
        discordConfig: resolvedDiscordConfig,
        clock: resolvedClock,
        ledger: resolvedLedger,
        tasks: resolvedTasks,
        challengeBroker: resolvedChallengeBroker,
        recipeProvider: resolvedRecipeProvider,
        sites: liveSites,
        dropIds: liveDropIds,
      });
      if (!preflightReport.ok) {
        const error = new Error(`Live readiness preflight failed: ${preflightReport.blockers?.map((item) => item.name).join(', ') || 'unknown blocker'}`);
        error.code = 'SCALPER_PREFLIGHT_FAILED';
        error.report = preflightReport;
        throw error;
      }
      const requiredSites = liveSites?.length
        ? [...new Set(liveSites)]
        : [...new Set((await resolvedCalendar.allDrops()).flatMap((drop) => drop.sites ?? []))];
      const canaryReports = [];
      for (const site of requiredSites) {
        canaryReports.push(await canaryCheck({
          site,
          env: { ...env, SCALPER_LIVE: '0', SCALPER_KILL_SWITCH: '1' },
          dataDir,
          accounts: resolvedAccounts,
          recipes: resolvedRecipeProvider,
          tasks: resolvedTasks,
          stateStore: resolvedStateStore,
          productEndpoints: resolvedStateStore.productEndpoints,
        }));
      }
      const canaryBlockers = canaryReports.flatMap((report) => report.blockers.map((blocker) => ({ site: report.site, ...blocker })));
      preflightReport = { ...preflightReport, canary: canaryReports };
      if (canaryBlockers.length) {
        const error = new Error(`Live canary gate failed: ${canaryBlockers.map((item) => `${item.site}:${item.name}`).join(', ')}`);
        error.code = 'SCALPER_CANARY_NOT_READY';
        error.report = { ready: false, blockers: canaryBlockers, reports: canaryReports };
        throw error;
      }
    } catch (error) {
      resolvedClock.stop?.();
      await resolvedBrowser.close?.();
      resolvedStateStore.close?.();
      throw error;
    }
  }
  const resolvedDiscordTransport = discordTransport ?? createDiscordWsTransport();
  // false = every product; default = config/scalper-watchlist.json when present.
  const resolvedWatchlist = watchlist === false ? undefined
    : watchlist ?? (await loadWatchlist({ path: env.SCALPER_WATCHLIST_PATH || 'config/scalper-watchlist.json' }).catch(() => null))?.match;
  const resolvedUrlResolver = urlResolver ?? createUrlResolver({ http, metrics: resolvedMetrics, logger });
  const resolvedDiscordParser = discordParser ?? createResolvingParser({
    parser: createMonitorAwareParser({ dedupe: signalDeduper, metrics: resolvedMetrics, watchlist: resolvedWatchlist }),
    resolver: resolvedUrlResolver,
    policy: createRetailUrlPolicy({ metrics: resolvedMetrics }),
  });
  const signalAlert = createSignalAlertHandler({
    alerts: resolvedAlerts,
    minRank: alertMinRank ?? env.SCALPER_ALERT_MIN_RANK ?? 0,
    metrics: resolvedMetrics,
  });
  const resolvedDiscordFeed = discordFeed ?? new DiscordFeed({
    config: resolvedDiscordConfig,
    transport: resolvedDiscordTransport,
    logPath: `${dataDir}/discord-drops.jsonl`,
    calendar: resolvedCalendar,
    parser: resolvedDiscordParser,
    onSignal: signalAlert,
    seenMessages: resolvedStateStore.seenMessages,
    productEndpoints: resolvedStateStore.productEndpoints,
    onDrop: async (drop) => {
      // DiscordFeed has already persisted the drop before this callback.
      // tick() starts surprise watchers without waiting for their lifetime.
      await resolvedOrchestrator.tick?.();
      if (drop.source !== 'discord-monitor') {
        void Promise.resolve()
          .then(() => resolvedAlerts.dropDetected({ product: drop.id, site: drop.sites?.[0] }))
          .catch((error) => logger?.warn?.('Alert delivery failed: dropDetected', error));
      }
    },
    logger,
  });
  const discordConnected = Boolean(connectDiscord && resolvedDiscordConfig.token);
  if (discordConnected) await resolvedDiscordFeed.start();

  let stopped = false;
  return {
    clock: resolvedClock,
    calendar: resolvedCalendar,
    accounts: resolvedAccounts,
    vault: resolvedVault,
    dryRun: resolvedDryRun,
    safety: resolvedSafety,
    ledger: resolvedLedger,
    marketStore: resolvedMarketStore,
    stateStore: resolvedStateStore,
    tasks: resolvedTasks,
    challengeBroker: resolvedChallengeBroker,
    metrics: resolvedMetrics,
    trafficGovernor: resolvedTrafficGovernor,
    urlResolver: resolvedUrlResolver,
    accountSelector: resolvedAccountSelector,
    alerts: resolvedAlerts,
    events: resolvedEvents,
    discordFeed: resolvedDiscordFeed,
    discordParser: resolvedDiscordParser,
    orchestrator: resolvedOrchestrator,
    http,
    browser: resolvedBrowser,
    recipeProvider: resolvedRecipeProvider,
    lanes: resolvedLanes,
    discordConnected,
    discordConfig: resolvedDiscordConfig,
    preflightReport,
    async stop() {
      if (stopped) return;
      stopped = true;
      await resolvedOrchestrator.stop?.();
      await resolvedDiscordFeed.stop?.();
      await resolvedBrowser.close?.();
      resolvedClock.stop?.();
      resolvedStateStore.close?.();
    },
  };
}

export default createScalper;
