import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DryRunHarness, runConfiguredDryRun } from '../../src/scalper/dry-run.mjs';
import { CHANNELS, MONITOR_CATEGORY_ID } from '../../src/scalper/monitor-parser.mjs';
import { createMockBrowserAdapter } from '../../src/scalper/transports/browser.mjs';
import { createScalper } from '../../src/scalper/wiring.mjs';
import { PurchaseTaskStore } from '../../src/scalper/task-state.mjs';
import { memoryStorage } from './helpers.mjs';

function fakeClock() {
  let synchronized = false;
  return {
    async start() { synchronized = true; },
    stop() {},
    now: () => 1_000,
    driftMs: () => 0,
    isSynchronized: () => synchronized,
  };
}

async function isolatedEnv(context, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pokemon-scalper-wiring-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  return { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir, ...extra };
}

test('createScalper wires and starts every expected subsystem', async (context) => {
  let connections = 0;
  const discordTransport = { connect: async () => { connections += 1; }, close: async () => {} };
  const clock = fakeClock();
  const scalper = await createScalper({
    env: await isolatedEnv(context),
    loadEnv: async () => ({ loaded: false, keys: [] }),
    clock,
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport,
    browser: createMockBrowserAdapter(),
    discordConfig: { token: 'user-token', guildId: 'g1', channelIds: ['c1'], categoryIds: [], stores: ['target'] },
  });
  for (const key of ['clock', 'calendar', 'accounts', 'vault', 'dryRun', 'alerts', 'discordFeed', 'orchestrator', 'http', 'browser', 'lanes', 'tasks', 'challengeBroker']) {
    assert.ok(scalper[key], `missing ${key}`);
  }
  assert.equal(clock.isSynchronized(), true);
  assert.equal(connections, 1);
  assert.equal(scalper.discordConnected, true);
  assert.deepEqual(Object.keys(scalper.lanes).sort(), ['bestbuy', 'pokemon-center', 'target', 'tcgplayer']);
  await scalper.stop();
});

test('createScalper skips Discord cleanly when the bot token is missing', async (context) => {
  let connections = 0;
  const scalper = await createScalper({
    env: await isolatedEnv(context), loadEnv: async () => ({ loaded: false, keys: [] }), clock: fakeClock(),
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { connect: async () => { connections += 1; }, close: async () => {} },
    browser: createMockBrowserAdapter(),
    discordConfig: { token: null, guildId: 'g1', channelIds: [], categoryIds: [], stores: [] },
  });
  assert.equal(connections, 0);
  assert.equal(scalper.discordConnected, false);
  await scalper.stop();
});

test('shared Discord config is a sanitized local-routing template', async () => {
  const config = JSON.parse(await readFile(new URL('../../config/scalper-discord.example.json', import.meta.url), 'utf8'));
  assert.equal(config.guildId, 'replace-me-guild-id');
  assert.deepEqual(config.categoryIds, []);
  assert.deepEqual(config.channelIds, []);
  assert.deepEqual(config.monitorChannelIds, []);
  assert.deepEqual(config.authorIds, []);
  assert.equal(config.token, 'env:SCALPER_DISCORD_BOT_TOKEN');
  assert.equal(config.channelRoutes['replace-me-target-channel-id'], 'target');
});

test('createScalper routes monitor signals through rank, dedupe, alerts, and the supported-site calendar', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pokemon-scalper-wiring-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let gateway;
  const alertsSent = [];
  const calendarDrops = [];
  const scalper = await createScalper({
    watchlist: false, // this test is about routing; product filtering is tests/scalper/watchlist.test.mjs
    env: { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir },
    loadEnv: async () => ({ loaded: false, keys: [] }),
    clock: fakeClock(),
    httpTransport: {
      get() {}, postJson() {},
      request: async () => ({ status: 302, headers: { location: 'https://www.target.com/p/item/-/A-123' } }),
    },
    discordTransport: {
      connect: async (options) => { gateway = options; },
      close: async () => {},
    },
    browser: createMockBrowserAdapter(),
    calendar: { upsertDrop: async (drop) => calendarDrops.push(drop), allDrops: async () => [] },
    alerts: {
      clockDrift: async () => {},
      dropDetected: async (details) => alertsSent.push(details),
    },
    discordConfig: {
      token: 'user-token', guildId: 'g1', categoryIds: [MONITOR_CATEGORY_ID],
      channelIds: [CHANNELS.officialUpdates], authorIds: ['monitor-author'], stores: ['pokemon-center', 'tcgplayer', 'bestbuy', 'target'],
    },
  });

  gateway.onChannel({ id: CHANNELS.target10, guild_id: 'g1', parent_id: MONITOR_CATEGORY_ID });
  const message = {
    id: 'monitor-target-1', guild_id: 'g1', channel_id: CHANNELS.target10,
    timestamp: '2026-10-01T17:14:26.967Z',
    author: { id: 'monitor-author', bot: true, username: 'Pokemon Restocks Monitor' },
    content: '🚨 RESTOCK - First Partner Illustration Collection Series 3 @Target 10+ Quantity Restocks',
    embeds: [{
      title: 'Pokémon Trading Card Game: First Partner Illustration Collection Series 3',
      url: 'https://buff.ly/7CJjR44',
      fields: [
        { name: 'Direct Link:', value: 'https://buff.ly/7CJjR44' },
        { name: 'Retailer', value: 'Target' },
        { name: 'Status', value: 'In-Stock' },
        { name: 'Order Limit', value: '2' },
      ],
      footer: { text: 'Restocks Bot v2.0 | Pokemon Restocks Monitor #ad' },
    }],
  };

  await gateway.onMessage(message);
  await gateway.onMessage({ ...message, id: 'monitor-target-mirror', timestamp: '2026-10-01T17:18:00.000Z' });

  assert.equal(alertsSent.length, 1);
  assert.equal(alertsSent[0].signal.site, 'target');
  assert.equal(alertsSent[0].rank, 70);
  assert.equal(calendarDrops.length, 1);
  assert.equal(calendarDrops[0].source, 'discord-monitor');
  await scalper.stop();
});

test('wired dry run traverses account selection, paper session, detector callback, orchestrator, and paper checkout', async (context) => {
  const storage = memoryStorage();
  const drop = {
    id: 'target-live-observation', name: 'Target ETB', sites: ['target'], type: 'surprise',
    time: '2026-10-01T12:00:00.000Z', price: 49.99, productUrls: { target: 'https://target.example/api/product' },
  };
  const calendar = {
    allDrops: async () => [drop],
    markResult: async () => {},
    upsertDrop: async () => {},
  };
  const dryRun = new DryRunHarness({ storage, orderLogPath: '/paper.jsonl', env: { SCALPER_LIVE: '0' }, now: () => 1_000 });
  const tasks = new PurchaseTaskStore({ storage, path: '/tasks.json', id: () => 'task-1', now: () => 1_000 });
  const scalper = await createScalper({
    env: await isolatedEnv(context), loadEnv: async () => {}, clock: fakeClock(), calendar, dryRun, tasks,
    accounts: {
      accountsFor: async () => [{ id: 'target-paper-1', email: 'paper@example.test' }],
      allAccounts: async () => [],
    },
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { close: async () => {} },
    discordConfig: { token: null, guildId: 'g1', channelIds: [], categoryIds: [], stores: [] },
    browser: createMockBrowserAdapter(),
    laneFactories: {
      target: (dependencies) => ({
        async run(input) {
          const session = await input.sessionManager.ensure(input.account);
          return input.onDetection({ account: input.account, session, detectedAt: 900, amount: drop.price });
        },
        checkout(input) {
          return dependencies.dryRun.execute({
            site: 'target', product: input.drop, account: input.account,
            amount: input.amount, detectedAt: input.detectedAt,
          });
        },
      }),
    },
  });
  const result = await runConfiguredDryRun({ calendar, dryRun, orchestrator: scalper.orchestrator, env: { SCALPER_LIVE: '0' } });
  assert.equal(result.status, 'paper-confirmed');
  const order = JSON.parse(storage.files.get('/paper.jsonl').trim());
  assert.equal(order.account, 'target-paper-1');
  assert.equal(order.simulatedLatencyMs, 100);
  await scalper.stop();
});

test('wired rank threshold keeps low-priority signals in metrics without paging', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pokemon-scalper-rank-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let gateway;
  const alerts = [];
  const scalper = await createScalper({
    env: { SCALPER_LIVE: '0', SCALPER_ALERT_MIN_RANK: '50', SCALPER_DATA_DIR: dataDir }, loadEnv: async () => {}, clock: fakeClock(),
    httpTransport: { get() {}, postJson() {}, request() {} }, browser: createMockBrowserAdapter(),
    discordTransport: { connect: async (options) => { gateway = options; }, close: async () => {} },
    discordConfig: { token: 'token', guildId: 'g1', channelIds: ['c1'], categoryIds: [], authorIds: ['a1'], stores: [] },
    discordParser: async () => ({ signal: { site: 'amazon', kind: 'restock', name: 'Tin' }, rank: 20, drops: [] }),
    alerts: { clockDrift: async () => {}, dropDetected: async (details) => alerts.push(details) },
  });
  await gateway.onMessage({ id: 'm1', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1' }, content: 'low priority' });
  assert.equal(alerts.length, 0);
  const metric = scalper.metrics.snapshot().counters.find((item) => item.name === 'discord_signal_alerts');
  assert.equal(metric.labels.outcome, 'suppressed');
  await scalper.stop();
});

test('createScalper refuses to arm live mode when readiness preflight has blockers', async (context) => {
  let stopped = false;
  let connected = false;
  const clock = {
    ...fakeClock(),
    stop() { stopped = true; },
  };
  await assert.rejects(createScalper({
    env: await isolatedEnv(context, { SCALPER_LIVE: '1' }),
    loadEnv: async () => {},
    clock,
    accounts: { accountsFor: async () => [], allAccounts: async () => [] },
    calendar: { allDrops: async () => [] },
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { connect: async () => { connected = true; }, close: async () => {} },
    discordConfig: { token: 'token', guildId: 'g1', channelIds: [], categoryIds: [], stores: [] },
    browser: createMockBrowserAdapter(),
    preflightCheck: async () => ({ ok: false, blockers: [{ name: 'drops', detail: 'none' }] }),
  }), (error) => error.code === 'SCALPER_PREFLIGHT_FAILED');
  assert.equal(stopped, true);
  assert.equal(connected, false);
});

test('createScalper refuses live mode when the full canary evidence gate has blockers', async (context) => {
  let connected = false;
  const calendar = {
    allDrops: async () => [{ id: 'pc-canary', sites: ['pokemon-center'], time: '2026-10-01T12:00:00Z' }],
  };
  await assert.rejects(createScalper({
    env: await isolatedEnv(context, { SCALPER_LIVE: '1' }),
    loadEnv: async () => {},
    clock: fakeClock(),
    accounts: { accountsFor: async () => [], allAccounts: async () => [] },
    calendar,
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { connect: async () => { connected = true; }, close: async () => {} },
    discordConfig: { token: 'token', guildId: 'g1', channelIds: [], categoryIds: [], stores: [] },
    browser: createMockBrowserAdapter(),
    preflightCheck: async () => ({ ok: true, blockers: [] }),
    canaryCheck: async ({ site, env }) => ({
      site,
      ready: false,
      blockers: [{ name: 'seven-day-burn-in', detail: 'not passed' }],
      stagedEnv: env,
    }),
  }), (error) => error.code === 'SCALPER_CANARY_NOT_READY'
    && error.report.blockers[0].site === 'pokemon-center');
  assert.equal(connected, false);
});

test('wiring never appends Discord fixtures outside its injected temporary data directory', async (context) => {
  const productionLog = new URL('../../data/scalper/discord-drops.jsonl', import.meta.url);
  const before = await readFile(productionLog, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const env = await isolatedEnv(context);
  let gateway;
  const scalper = await createScalper({
    env,
    loadEnv: async () => {},
    clock: fakeClock(),
    calendar: { upsertDrop: async () => {}, allDrops: async () => [] },
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { connect: async (options) => { gateway = options; }, close: async () => {} },
    discordConfig: { token: 'token', guildId: 'g1', channelIds: ['c1'], categoryIds: [], authorIds: ['a1'], stores: [] },
    discordParser: async () => null,
    browser: createMockBrowserAdapter(),
  });
  await gateway.onMessage({ id: 'fixture-1', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1' }, content: 'fixture' });
  await scalper.stop();
  const after = await readFile(productionLog, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert.equal(after, before);
  assert.match(await readFile(join(env.SCALPER_DATA_DIR, 'discord-drops.jsonl'), 'utf8'), /fixture-1/);
});
