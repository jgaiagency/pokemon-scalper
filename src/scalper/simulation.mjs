import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DropCalendar } from './drop-calendar.mjs';
import { DryRunHarness } from './dry-run.mjs';
import { restockdTargetFixture, runEndToEndPaperTest } from './e2e.mjs';
import { RESTOCKD_CHANNELS, RESTOCKD_GUILD_ID } from './monitor-parser.mjs';
import { SafetyPolicy } from './safety.mjs';
import { createLane as createBestBuyLane } from './sites/bestbuy/index.mjs';
import { pollForAvailability as detectBestBuy } from './sites/bestbuy/detect.mjs';
import { createLane as createPokemonCenterLane } from './sites/pokemon-center/index.mjs';
import { pollForAvailability as detectPokemonCenter } from './sites/pokemon-center/detect.mjs';
import { createLane as createTargetLane } from './sites/target/index.mjs';
import { pollForAvailability as detectTarget } from './sites/target/detect.mjs';
import { createLane as createTcgplayerLane } from './sites/tcgplayer/index.mjs';
import { pollForAvailability as detectTcgplayer } from './sites/tcgplayer/detect.mjs';
import { createMockBrowserAdapter } from './transports/browser.mjs';
import { createScalper } from './wiring.mjs';

const NOW = Date.parse('2026-10-02T07:12:00.125Z');
const SITES = Object.freeze(['pokemon-center', 'tcgplayer', 'bestbuy', 'target']);

const AVAILABLE = Object.freeze({
  'pokemon-center': { availability: 'IN_STOCK', addToCartEnabled: true },
  tcgplayer: { listings: [{ quantity: 3, price: 29.99 }] },
  bestbuy: { purchasable: true, buttonState: 'ADD_TO_CART' },
  target: { availableToPromise: 10, fulfillment: { shipping: 'AVAILABLE' } },
});

const UNAVAILABLE = Object.freeze({
  'pokemon-center': { availability: 'OUT_OF_STOCK', addToCartEnabled: false },
  tcgplayer: { listings: [{ quantity: 0, price: 29.99 }] },
  bestbuy: { purchasable: false, buttonState: 'SOLD_OUT' },
  target: { availableToPromise: 0, fulfillment: { shipping: 'UNAVAILABLE' } },
});

const PRODUCT_URLS = Object.freeze({
  'pokemon-center': 'https://www.pokemoncenter.com/product/simulation',
  tcgplayer: 'https://www.tcgplayer.com/product/simulation',
  bestbuy: 'https://www.bestbuy.com/site/simulation/0000000.p',
  target: 'https://www.target.com/p/-/A-00000000',
});

function simulationClock() {
  return {
    async start() {},
    stop() {},
    now: () => NOW,
    driftMs: () => 0,
    isSynchronized: () => true,
  };
}

function bounded(detector) {
  return (input) => detector({ ...input, maxPolls: 1, sleep: async () => {} });
}

function simulationLaneFactories() {
  return {
    'pokemon-center': (dependencies) => createPokemonCenterLane({ ...dependencies, detector: bounded(detectPokemonCenter) }),
    tcgplayer: (dependencies) => createTcgplayerLane({ ...dependencies, detector: bounded(detectTcgplayer) }),
    bestbuy: (dependencies) => createBestBuyLane({ ...dependencies, detector: bounded(detectBestBuy) }),
    target: (dependencies) => createTargetLane({ ...dependencies, detector: bounded(detectTarget) }),
  };
}

function dropFor(site, suffix) {
  const id = `simulation-${site}-${suffix}`;
  const pollUrl = new URL(`/api/isolated-simulation/${encodeURIComponent(suffix)}`, PRODUCT_URLS[site]).href;
  return {
    id,
    name: `Simulation ${site} ${suffix}`,
    sites: [site],
    type: 'scheduled',
    time: new Date(NOW).toISOString(),
    price: 39.99,
    purchaseQuantity: 1,
    productUrls: { [site]: PRODUCT_URLS[site] },
    // The injected transport prevents network access; retaining the real
    // retailer host also exercises the production URL allowlist.
    pollUrls: { [site]: pollUrl },
  };
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function reportScenario(name, checks, evidence = {}) {
  return { name, ok: Object.values(checks).every(Boolean), checks, evidence };
}

async function createSimulationRig({ payloads = new Map(), safety, failConfirmationAlert = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pokemon-scalper-simulation-'));
  const dataDir = join(directory, 'data');
  const calendar = new DropCalendar({ path: join(directory, 'drops.json'), now: () => NOW });
  const dryRun = new DryRunHarness({
    env: { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir },
    orderLogPath: join(dataDir, 'paper-orders.jsonl'),
    now: () => NOW + 75,
  });
  const browser = createMockBrowserAdapter();
  const alertEvents = [];
  const gets = [];
  let posts = 0;
  let arbitraryRequests = 0;
  const loggerEvents = [];
  let scalper;

  try {
    scalper = await createScalper({
      env: { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir, SCALPER_ALERT_MIN_RANK: '50' },
      loadEnv: async () => ({ loaded: false, keys: [] }),
      clock: simulationClock(),
      calendar,
      dryRun,
      safety,
      accounts: {
        accountsFor: async (site) => [{ id: `simulation-${site}-account`, email: 'paper@simulation.invalid' }],
        allAccounts: async () => [],
      },
      httpTransport: {
        get: async (url) => {
          gets.push(url);
          if (!payloads.has(url)) throw new Error(`Simulation has no HTTP fixture for ${url}`);
          return { status: 200, bodyJson: structuredClone(payloads.get(url)) };
        },
        request: async () => {
          arbitraryRequests += 1;
          throw new Error('Simulation forbids arbitrary outbound requests');
        },
        postJson: async () => {
          posts += 1;
          throw new Error('Simulation forbids outbound POST requests');
        },
      },
      alerts: {
        clockDrift: async () => {},
        dropDetected: async (details) => { alertEvents.push({ event: 'drop-detected', details }); },
        purchaseConfirmed: async (details) => {
          alertEvents.push({ event: 'purchase-confirmed', details });
          if (failConfirmationAlert) throw new Error('simulated alert transport outage');
        },
        purchaseFailed: async (details) => { alertEvents.push({ event: 'purchase-failed', details }); },
        purchaseUncertain: async (details) => { alertEvents.push({ event: 'purchase-uncertain', details }); },
      },
      logger: {
        warn: (...args) => loggerEvents.push({ level: 'warn', message: String(args[0]) }),
        error: (...args) => loggerEvents.push({ level: 'error', message: String(args[0]) }),
      },
      browser,
      discordTransport: { close: async () => {} },
      discordConfig: {
        token: null,
        guildId: RESTOCKD_GUILD_ID,
        channelIds: [RESTOCKD_CHANNELS.target],
        monitorChannelIds: [RESTOCKD_CHANNELS.target],
        categoryIds: [],
        authorIds: ['restockd-app'],
        stores: ['target'],
      },
      laneFactories: simulationLaneFactories(),
      connectDiscord: false,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    dataDir,
    calendar,
    scalper,
    browser,
    alertEvents,
    gets,
    loggerEvents,
    mutationCount: () => posts + arbitraryRequests + browser.calls.length,
    orders: () => readJsonLines(join(dataDir, 'paper-orders.jsonl')),
    cleanup: async () => {
      await scalper.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function runRetailerMatrix({ available }) {
  const suffix = available ? 'available' : 'sold-out';
  const drops = SITES.map((site) => dropFor(site, suffix));
  const payloads = new Map(drops.map((drop) => [drop.pollUrls[drop.sites[0]], (available ? AVAILABLE : UNAVAILABLE)[drop.sites[0]]]));
  const rig = await createSimulationRig({ payloads });
  try {
    const results = [];
    for (const drop of drops) {
      await rig.calendar.upsertDrop(drop);
      results.push(await rig.scalper.orchestrator.runDrop(drop));
    }
    const orders = await rig.orders();
    const tasks = await rig.scalper.tasks.list();
    const expected = available ? 'paper-confirmed' : 'missed';
    return reportScenario(
      available ? 'all-retailer-paper-checkouts' : 'out-of-stock-fails-closed',
      {
        everyLaneReturnedExpectedState: results.every((result) => result.status === expected),
        everyDetectorRanOnce: rig.gets.length === SITES.length,
        expectedPaperOrderCount: orders.length === (available ? SITES.length : 0),
        expectedDurableTaskCount: tasks.length === (available ? SITES.length : 0),
        noExternalMutation: rig.mutationCount() === 0,
      },
      {
        results: Object.fromEntries(SITES.map((site, index) => [site, results[index].status])),
        paperOrders: orders.length,
        durableTasks: tasks.length,
      },
    );
  } finally {
    await rig.cleanup();
  }
}

async function runDuplicateScenario() {
  const drop = dropFor('target', 'duplicate');
  const rig = await createSimulationRig({ payloads: new Map([[drop.pollUrls.target, AVAILABLE.target]]) });
  try {
    await rig.calendar.upsertDrop(drop);
    const first = await rig.scalper.orchestrator.runDrop(drop);
    const second = await rig.scalper.orchestrator.runDrop(drop);
    const orders = await rig.orders();
    const tasks = await rig.scalper.tasks.list();
    return reportScenario('duplicate-suppression', {
      firstOrderConfirmed: first.status === 'paper-confirmed',
      secondOrderSuppressed: second.status === 'duplicate-suppressed',
      exactlyOnePaperOrder: orders.length === 1,
      exactlyOneDurableTask: tasks.length === 1,
      noExternalMutation: rig.mutationCount() === 0,
    }, { first: first.status, second: second.status, paperOrders: orders.length });
  } finally {
    await rig.cleanup();
  }
}

async function runKillSwitchScenario() {
  const drop = dropFor('target', 'kill-switch');
  const safety = new SafetyPolicy({
    env: { SCALPER_LIVE: '1', SCALPER_KILL_SWITCH: '1' },
    killSwitchExists: async () => false,
  });
  const rig = await createSimulationRig({ payloads: new Map([[drop.pollUrls.target, AVAILABLE.target]]), safety });
  try {
    await rig.calendar.upsertDrop(drop);
    const result = await rig.scalper.orchestrator.runDrop(drop);
    const orders = await rig.orders();
    const tasks = await rig.scalper.tasks.list();
    return reportScenario('kill-switch-fails-closed', {
      blockedBySafety: result.status === 'safety-blocked' && result.reason === 'kill-switch',
      noPaperOrLiveOrder: orders.length === 0,
      durableBlockedTask: tasks.length === 1 && tasks[0].state === 'blocked',
      noExternalMutation: rig.mutationCount() === 0,
    }, { status: result.status, reason: result.reason, taskState: tasks[0]?.state });
  } finally {
    await rig.cleanup();
  }
}

async function runSignalRejectionScenario() {
  const rig = await createSimulationRig();
  try {
    const fixture = restockdTargetFixture();
    const hostileDestination = 'https://www.target.com.attacker.invalid/p/fake';
    const hostile = {
      ...fixture,
      id: 'simulation-hostile-link',
      embeds: [{
        ...fixture.embeds[0],
        url: `https://howl.link/link/?url=${encodeURIComponent(hostileDestination)}`,
      }],
    };
    const humanNoise = {
      ...fixture,
      id: 'simulation-human-noise',
      author: { id: 'human', username: 'human', bot: false },
    };
    const hostileResult = await rig.scalper.discordFeed.handleMessage(hostile);
    const noiseResult = await rig.scalper.discordFeed.handleMessage(humanNoise);
    const drops = await rig.calendar.allDrops();
    const orders = await rig.orders();
    return reportScenario('invalid-and-noisy-signals-are-rejected', {
      hostileLinkRejected: hostileResult.tracked === true && hostileResult.matched === false,
      humanNoiseRejected: noiseResult.tracked === true && noiseResult.matched === false,
      noCalendarDropCreated: drops.length === 0,
      noOrderCreated: orders.length === 0,
      noExternalMutation: rig.mutationCount() === 0,
    }, { hostileMatched: hostileResult.matched, humanNoiseMatched: noiseResult.matched });
  } finally {
    await rig.cleanup();
  }
}

async function runAlertOutageScenario() {
  const drop = dropFor('target', 'alert-outage');
  const rig = await createSimulationRig({
    payloads: new Map([[drop.pollUrls.target, AVAILABLE.target]]),
    failConfirmationAlert: true,
  });
  try {
    await rig.calendar.upsertDrop(drop);
    const result = await rig.scalper.orchestrator.runDrop(drop);
    const orders = await rig.orders();
    const tasks = await rig.scalper.tasks.list();
    return reportScenario('alert-outage-does-not-repeat-order', {
      purchaseStillConfirmed: result.status === 'paper-confirmed',
      exactlyOneOrder: orders.length === 1,
      durableTaskConfirmed: tasks.length === 1 && tasks[0].state === 'paper-confirmed',
      outageWasContained: rig.loggerEvents.some((event) => event.level === 'warn' && event.message.includes('Alert delivery failed')),
      noExternalMutation: rig.mutationCount() === 0,
    }, { status: result.status, paperOrders: orders.length, containedWarnings: rig.loggerEvents.length });
  } finally {
    await rig.cleanup();
  }
}

export async function runSimulationSuite() {
  const discordToOrder = await runEndToEndPaperTest();
  const scenarios = [
    reportScenario('discord-to-target-paper-order', discordToOrder.checks, {
      signal: discordToOrder.signal,
      execution: discordToOrder.execution,
    }),
    await runRetailerMatrix({ available: true }),
    await runRetailerMatrix({ available: false }),
    await runDuplicateScenario(),
    await runKillSwitchScenario(),
    await runSignalRejectionScenario(),
    await runAlertOutageScenario(),
  ];
  return {
    ok: scenarios.every((scenario) => scenario.ok),
    mode: 'isolated-paper-simulation',
    summary: {
      passed: scenarios.filter((scenario) => scenario.ok).length,
      failed: scenarios.filter((scenario) => !scenario.ok).length,
      total: scenarios.length,
      realAccountsUsed: 0,
      realCardsUsed: 0,
      externalMutations: scenarios.every((scenario) => scenario.checks.noExternalMutation) ? 0 : 'detected',
    },
    scenarios,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runSimulationSuite();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
