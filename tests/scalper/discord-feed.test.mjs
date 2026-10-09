import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DISCORD_INTENTS,
  DiscordFeed,
  GUILDS_INTENT,
  GUILD_MESSAGES_INTENT,
  MESSAGE_CONTENT_INTENT,
  loadDiscordConfig,
  parseDropMessage,
} from '../../src/scalper/discord-feed.mjs';
import { memoryStorage } from './helpers.mjs';

const config = {
  token: 'token', guildId: 'g1', channelIds: ['c1'], categoryIds: ['cat1'], authorIds: ['a1'], stores: ['target'],
};
const exampleConfigPath = fileURLToPath(new URL('../../config/scalper-discord.example.json', import.meta.url));
const message = (value = {}) => ({ id: 'm1', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1', bot: true }, ...value });

test('Discord config resolves an authorized bot token without accepting a user-token alias', async () => {
  const bot = await loadDiscordConfig({ path: exampleConfigPath, env: { SCALPER_DISCORD_BOT_TOKEN: 'bot-token' } });
  assert.equal(bot.mode, 'bot-token');
  assert.equal(bot.token, 'bot-token');

  const legacy = await loadDiscordConfig({ path: exampleConfigPath, env: { SCALPER_DISCORD_USER_TOKEN: 'legacy-token' } });
  assert.equal(legacy.token, null);
});

test('tracked Discord messages are logged, parsed, scheduled, and emitted', async () => {
  const storage = memoryStorage();
  const drops = [];
  const emitted = [];
  const feed = new DiscordFeed({
    config, storage, logPath: '/discord.jsonl',
    parser: async () => ({ id: 'target-etb', name: 'ETB', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' }),
    calendar: { upsertDrop: async (drop) => drops.push(drop) }, onDrop: async (drop) => emitted.push(drop),
  });
  const result = await feed.handleMessage(message({ content: 'Target ETB in stock' }));
  assert.equal(result.matched, true);
  assert.equal(drops.length, 1);
  assert.equal(emitted.length, 1);
  assert.match(storage.files.get('/discord.jsonl'), /Target ETB/);
  assert.equal(GUILD_MESSAGES_INTENT, 512);
  assert.equal(GUILDS_INTENT, 1);
  assert.equal(MESSAGE_CONTENT_INTENT, 32768);
  assert.equal(DEFAULT_DISCORD_INTENTS, 33281);
});

test('untracked messages cannot create false-positive drops', async () => {
  let parsed = false;
  const feed = new DiscordFeed({ config, storage: memoryStorage(), parser: async () => { parsed = true; } });
  assert.deepEqual(await feed.handleMessage(message({ guild_id: 'other', content: 'in stock' })), { tracked: false, matched: false });
  assert.equal(parsed, false);
  assert.equal(parseDropMessage({ content: 'ordinary conversation' }, config), null);
});

test('feed connects with the configured bot token and reconnects after disconnect', async () => {
  const connections = [];
  let disconnect;
  const transport = { connect: async (options) => { connections.push(options); disconnect = options.onDisconnect; } };
  const feed = new DiscordFeed({ config, storage: memoryStorage(), transport, sleep: async () => {} });
  await feed.start();
  await disconnect();
  assert.equal(connections.length, 2);
  assert.equal(connections[0].token, 'token');
  assert.equal(connections[0].intents, DEFAULT_DISCORD_INTENTS);
  await feed.stop();
});

test('feed applies bounded reconnect backoff and resets it after a received message', async () => {
  const delays = [];
  let disconnect;
  const transport = { connect: async (options) => { disconnect = options.onDisconnect; }, close: async () => {} };
  const feed = new DiscordFeed({
    config, storage: memoryStorage(), transport,
    reconnectBackoff: (attempt) => Math.min(250, attempt * 100),
    sleep: async (ms) => { delays.push(ms); },
  });
  await feed.start();
  await disconnect();
  await disconnect();
  assert.deepEqual(delays, [100, 200]);
  await feed.handleMessage(message({ content: 'ordinary conversation' }));
  await disconnect();
  assert.deepEqual(delays, [100, 200, 100]);
  await feed.stop();
});

test('category tracking learns child channels from Gateway channel events', async () => {
  const drops = [];
  const parsedMessages = [];
  const feed = new DiscordFeed({
    config: { ...config, channelIds: [] }, storage: memoryStorage(),
    parser: async (message) => {
      parsedMessages.push(message);
      return { id: 'category-drop', name: 'ETB', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' };
    },
    calendar: { upsertDrop: async (drop) => drops.push(drop) },
  });
  feed.handleChannel({ id: 'category-child', guild_id: 'g1', parent_id: 'cat1' });
  const result = await feed.handleMessage(message({ channel_id: 'category-child', content: 'Target ETB in stock' }));
  assert.equal(result.matched, true);
  assert.equal(drops.length, 1);
  assert.equal(parsedMessages[0].parent_id, 'cat1');
});

test('structured signals can alert without creating unsupported calendar drops', async () => {
  const signals = [];
  const drops = [];
  const feed = new DiscordFeed({
    config, storage: memoryStorage(),
    parser: async () => ({ signal: { kind: 'restock', site: 'amazon', name: 'ETB' }, rank: 20, drop: null }),
    calendar: { upsertDrop: async (drop) => drops.push(drop) },
    onSignal: async (signal, rank) => signals.push({ signal, rank }),
  });
  const result = await feed.handleMessage(message({ content: 'structured monitor post' }));
  assert.equal(result.matched, true);
  assert.equal(drops.length, 0);
  assert.deepEqual(signals, [{ signal: { kind: 'restock', site: 'amazon', name: 'ETB' }, rank: 20 }]);
});

test('a supported signal is persisted before an alert outage is reported', async () => {
  const drops = [];
  const drop = { id: 'target-etb', name: 'ETB', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' };
  const feed = new DiscordFeed({
    config, storage: memoryStorage(),
    parser: async () => ({ signal: { kind: 'restock', site: 'target', name: 'ETB' }, rank: 40, drop }),
    calendar: { upsertDrop: async (value) => drops.push(value) },
    onSignal: async () => { throw new Error('alert unavailable'); },
  });
  await assert.rejects(
    feed.handleMessage(message({ content: 'structured monitor post' })),
    /alert unavailable/,
  );
  assert.deepEqual(drops, [drop]);
});

test('persisted drops start execution before signal alert work', async () => {
  const order = [];
  const drop = { id: 'target-etb', name: 'ETB', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' };
  const feed = new DiscordFeed({
    config, storage: memoryStorage(),
    parser: async () => ({ signal: { kind: 'restock', site: 'target', name: 'ETB' }, rank: 70, drop }),
    calendar: { upsertDrop: async () => { order.push('persist'); } },
    onDrop: async () => { order.push('execute'); },
    onSignal: async () => { order.push('alert'); },
  });

  await feed.handleMessage(message({ content: 'structured monitor post' }));

  assert.deepEqual(order, ['persist', 'execute', 'alert']);
});

test('structured official updates can persist multiple product drops from one signal', async () => {
  const drops = [];
  const values = [
    { id: 'pc-etb', name: 'ETB', sites: ['pokemon-center'], type: 'surprise', time: '2026-10-01T12:00:00Z' },
    { id: 'pc-box', name: 'Booster Box', sites: ['pokemon-center'], type: 'surprise', time: '2026-10-01T12:00:00Z' },
  ];
  const feed = new DiscordFeed({
    config, storage: memoryStorage(),
    parser: async () => ({ signal: { kind: 'products-live', site: 'pokemon-center' }, rank: 100, drops: values }),
    calendar: { upsertDrop: async (drop) => drops.push(drop) },
  });
  const result = await feed.handleMessage(message({ content: 'products live' }));
  assert.equal(result.matched, true);
  assert.deepEqual(drops, values);
});

test('only allowlisted authors dispatch, including explicitly allowlisted monitor bots', async () => {
  let parses = 0;
  const feed = new DiscordFeed({ config, storage: memoryStorage(), parser: async () => { parses += 1; return null; } });
  assert.equal((await feed.handleMessage(message({ author: { id: 'not-allowed', bot: false } }))).reason, 'author-not-allowlisted');
  assert.equal((await feed.handleMessage(message({ author: { id: 'a1', bot: true } }))).tracked, true);
  assert.equal(parses, 1);
});

test('durable message claims suppress a duplicate across feed instances', async () => {
  const claimed = new Set();
  const seenMessages = {
    claim: async ({ messageId }) => !claimed.has(messageId) && Boolean(claimed.add(messageId)),
    latest: async () => null,
  };
  let parses = 0;
  const options = { config, storage: memoryStorage(), seenMessages, parser: async () => { parses += 1; return null; } };
  assert.equal((await new DiscordFeed(options).handleMessage(message())).matched, false);
  assert.equal((await new DiscordFeed(options).handleMessage(message())).reason, 'duplicate-message');
  assert.equal(parses, 1);
});

test('Discord drops execute only after a measured poll endpoint is attached', async () => {
  const executions = [];
  const persisted = [];
  const endpoint = { pollUrl: null };
  const productEndpoints = {
    async forDrop(drop) {
      return endpoint.pollUrl
        ? { drop: { ...drop, pollUrls: { target: endpoint.pollUrl } }, missingSites: [] }
        : { drop, missingSites: ['target'] };
    },
  };
  const feed = new DiscordFeed({
    config, storage: memoryStorage(), productEndpoints,
    parser: async () => ({ id: 'target-etb', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' }),
    calendar: { upsertDrop: async (drop) => persisted.push(drop) }, onDrop: async (drop) => executions.push(drop),
  });
  assert.equal((await feed.handleMessage(message({ id: 'endpoint-1' }))).drop.status, 'unmeasured');
  assert.equal(executions.length, 0);
  endpoint.pollUrl = 'https://www.target.com/api/measured';
  await feed.handleMessage(message({ id: 'endpoint-2' }));
  assert.equal(executions[0].pollUrls.target, endpoint.pollUrl);
  assert.equal(persisted.length, 2);
});
