import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DropCalendar } from './drop-calendar.mjs';
import { DryRunHarness } from './dry-run.mjs';
import { RESTOCKD_CHANNELS, RESTOCKD_GUILD_ID } from './monitor-parser.mjs';
import { createMockBrowserAdapter } from './transports/browser.mjs';
import { createScalper } from './wiring.mjs';

const MESSAGE_AT = '2026-10-02T07:12:00.000Z';
const NOW = Date.parse(MESSAGE_AT) + 125;
const TERMINAL_TASK_STATES = new Set(['purchased', 'paper-confirmed', 'blocked', 'failed', 'uncertain', 'cancelled']);

async function waitForTerminalTask(tasks, { timeoutMs = 2_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const task = (await tasks.list()).find((item) => TERMINAL_TASK_STATES.has(item.state));
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return null;
}

async function waitForCompletionSideEffects(calendar, dropId, alertEvents, { timeoutMs = 2_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let drop = null;
  do {
    drop = await calendar.dropById(dropId);
    if (drop?.status === 'paper-confirmed' && alertEvents.some((event) => event.event === 'purchase-confirmed')) return drop;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return drop;
}

function e2eClock() {
  return {
    async start() {},
    stop() {},
    now: () => NOW,
    driftMs: () => 0,
    isSynchronized: () => true,
  };
}

export function restockdTargetFixture() {
  return {
    id: 'restockd-e2e-target-bundle',
    guild_id: RESTOCKD_GUILD_ID,
    channel_id: RESTOCKD_CHANNELS.target,
    timestamp: MESSAGE_AT,
    author: { id: 'restockd-app', username: 'Restockd', bot: true },
    content: '<@&target> Pokémon Trading Card Game: 30th Celebration Booster Bundle Box restocked',
    embeds: [{
      title: 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box | Target',
      url: 'https://howl.link/link/?url=https%3A%2F%2Fwww.target.com%2Fp%2F-%2FA-1011407490&publisher_slug=restockdping',
      fields: [
        { name: 'Price', value: '$31.99' },
        { name: 'Qty', value: '>= 10' },
        { name: 'Retailer', value: 'Target' },
        { name: 'Time', value: '02:12 AM' },
      ],
      footer: { text: 'Restockd.app • #ad' },
    }],
  };
}

export async function runEndToEndPaperTest() {
  const directory = await mkdtemp(join(tmpdir(), 'pokemon-scalper-e2e-'));
  const dataDir = join(directory, 'data');
  const calendar = new DropCalendar({ path: join(directory, 'drops.json'), now: () => NOW });
  const dryRun = new DryRunHarness({
    env: { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir },
    orderLogPath: join(dataDir, 'paper-orders.jsonl'),
    now: () => NOW + 75,
  });
  const alertEvents = [];
  const browser = createMockBrowserAdapter();
  let detectorGets = 0;
  let arbitraryRequests = 0;
  let posts = 0;
  let scalper;
  try {
    scalper = await createScalper({
      env: { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir, SCALPER_ALERT_MIN_RANK: '50' },
      loadEnv: async () => ({ loaded: false, keys: [] }),
      clock: e2eClock(),
      calendar,
      dryRun,
      accounts: {
        accountsFor: async (site) => [{ id: `e2e-${site}-account`, email: 'paper@e2e.invalid' }],
        allAccounts: async () => [],
      },
      httpTransport: {
        get: async () => {
          detectorGets += 1;
          return { status: 200, bodyJson: { availableToPromise: 10, fulfillment: { shipping: 'AVAILABLE' } } };
        },
        request: async () => {
          arbitraryRequests += 1;
          throw new Error('E2E embedded howl.link URL must not require a request');
        },
        postJson: async () => {
          posts += 1;
          throw new Error('E2E paper test must not POST');
        },
      },
      alerts: {
        clockDrift: async () => {},
        dropDetected: async (details) => { alertEvents.push({ event: 'drop-detected', details }); },
        purchaseConfirmed: async (details) => { alertEvents.push({ event: 'purchase-confirmed', details }); },
        purchaseFailed: async (details) => { alertEvents.push({ event: 'purchase-failed', details }); },
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
      connectDiscord: false,
    });

    await scalper.stateStore.productEndpoints.set({
      productId: '30th-booster-bundle',
      site: 'target',
      pollUrl: 'https://www.target.com/api/measured/30th-booster-bundle',
      metadata: { fixture: true, responseContract: 'available-to-promise-v1' },
    });

    const ingestion = await scalper.discordFeed.handleMessage(restockdTargetFixture());
    const detectedDrop = ingestion.drop;
    // Discord ingestion starts the surprise watcher immediately. Await its
    // durable terminal task instead of racing it with a duplicate manual run.
    const completedTask = await waitForTerminalTask(scalper.tasks);
    const execution = { status: completedTask?.state ?? 'timed-out' };
    const finalDrop = await waitForCompletionSideEffects(calendar, detectedDrop.id, alertEvents);
    const tasks = await scalper.tasks.list();
    const rawOrders = await readFile(join(dataDir, 'paper-orders.jsonl'), 'utf8');
    const orders = rawOrders.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const rawMessages = await readFile(join(dataDir, 'discord-drops.jsonl'), 'utf8');
    const browserCalls = browser.calls ?? [];

    const checks = {
      messageTracked: ingestion.tracked === true && ingestion.matched === true,
      watchlistMatched: ingestion.signal?.product?.id === '30th-booster-bundle',
      retailerUrlResolved: ingestion.signal?.url === 'https://www.target.com/p/-/A-1011407490',
      highQuantityParsed: ingestion.signal?.quantityFloor === 10 && ingestion.signal?.highQuantity === true,
      calendarPersisted: finalDrop?.source === 'discord-monitor',
      detectorRan: detectorGets === 1,
      paperCheckoutConfirmed: execution?.status === 'paper-confirmed' && orders[0]?.status === 'paper-confirmed',
      taskDurable: tasks.length === 1 && tasks[0].state === 'paper-confirmed',
      purchaseAlertProduced: alertEvents.some((event) => event.event === 'purchase-confirmed'),
      rawSignalLogged: rawMessages.includes('restockd-e2e-target-bundle'),
      noExternalMutation: posts === 0 && arbitraryRequests === 0 && browserCalls.length === 0,
    };

    return {
      ok: Object.values(checks).every(Boolean),
      mode: 'isolated-paper',
      checks,
      signal: {
        site: ingestion.signal?.site,
        product: ingestion.signal?.product?.id,
        price: ingestion.signal?.price,
        quantityFloor: ingestion.signal?.quantityFloor,
        rank: ingestion.rank,
        url: ingestion.signal?.url,
      },
      execution: {
        status: execution?.status,
        taskState: tasks[0]?.state,
        simulatedLatencyMs: orders[0]?.simulatedLatencyMs,
        wouldHavePaid: orders[0]?.wouldHavePaid,
      },
    };
  } finally {
    await scalper?.stop?.();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runEndToEndPaperTest();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
