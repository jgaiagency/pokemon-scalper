import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { createDiscordWsTransport } from '../../../src/scalper/transports/discord-ws.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeDiscordClient extends EventEmitter {
  constructor(events) {
    super();
    this.events = events;
    this.user = { id: 'bot-1' };
    this.ws = { ping: 42 };
    this.channels = { cache: new Map() };
    this.ready = false;
    this.destroyed = false;
  }

  async login(token) {
    // These are the SDK's observable protocol milestones. The wrapper only
    // invokes login and never writes IDENTIFY before the SDK receives HELLO.
    this.events.push('hello');
    this.events.push('identify');
    this.token = token;
    this.ready = true;
    this.emit(Events.ClientReady, this);
    return token;
  }

  isReady() { return this.ready; }
  destroy() { this.destroyed = true; this.ready = false; }
}

function harness({ restGet = async () => [] } = {}) {
  const protocolEvents = [];
  const clients = [];
  const restCalls = [];
  const transport = createDiscordWsTransport({
    clientFactory: ({ intents }) => {
      const client = new FakeDiscordClient(protocolEvents);
      client.intents = intents;
      clients.push(client);
      return client;
    },
    restFactory: (token) => ({
      get: async (route, options) => {
        restCalls.push({ token, route, query: Object.fromEntries(options.query) });
        return restGet(route, options);
      },
    }),
    routes: { channelMessages: (id) => `/channels/${id}/messages` },
    logger: { warn() {} },
  });
  return { transport, clients, protocolEvents, restCalls };
}

test('Discord SDK owns HELLO then IDENTIFY and exposes bounded connection stats', async () => {
  const h = harness();
  await h.transport.connect({ token: 'bot-token', intents: 513 });
  assert.deepEqual(h.protocolEvents, ['hello', 'identify']);
  assert.equal(h.clients[0].token, 'bot-token');
  assert.equal(h.clients[0].intents, 513);
  assert.deepEqual(h.transport.stats(), {
    sdk: 'discord.js', connected: true, userId: 'bot-1', heartbeatRttMs: 42,
    resumeCount: 0, readyCount: 1, backfilledMessages: 0, cachedMessagesLimit: 100,
  });
  await h.transport.close();
  assert.equal(h.clients[0].destroyed, true);
});

test('Discord SDK events dispatch normalized messages and channels for the configured guild', async () => {
  const h = harness();
  const messages = [];
  const channels = [];
  await h.transport.connect({
    token: 't', intents: 512, guildId: 'g1',
    onMessage: (message) => messages.push(message), onChannel: (channel) => channels.push(channel),
  });
  h.clients[0].emit(Events.MessageCreate, { id: 'm1', guildId: 'g1', channelId: 'c1', author: { id: 'a1' } });
  h.clients[0].emit(Events.MessageCreate, { id: 'noise', guildId: 'other', channelId: 'c1' });
  h.clients[0].emit(Events.ChannelCreate, { id: 'c1', guildId: 'g1', parentId: 'cat1' });
  await flush();
  assert.deepEqual(messages.map((value) => value.id), ['m1']);
  assert.deepEqual(channels.map((value) => value.id), ['c1']);
  assert.equal(messages[0].guild_id, 'g1');
  assert.equal(channels[0].parent_id, 'cat1');
  await h.transport.close();
});

test('a completed SDK resume backfills missed messages after the durable channel cursor', async () => {
  let resumed = false;
  const h = harness({ restGet: async () => resumed ? [
    { id: '103', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1' }, content: 'third' },
    { id: '102', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1' }, content: 'second' },
  ] : [] });
  const messages = [];
  await h.transport.connect({
    token: 't', intents: 512, guildId: 'g1', channelIds: ['c1'],
    getLastMessageId: async () => '101', onMessage: (message) => messages.push(message),
  });
  await flush();
  resumed = true;
  h.clients[0].emit(Events.ShardResume, 0, 2);
  await h.transport.close();
  assert.equal(h.transport.stats().resumeCount, 1);
  assert.deepEqual(messages.map((message) => message.id), ['102', '103']);
  assert.deepEqual(h.restCalls.at(-1), {
    token: 't', route: '/channels/c1/messages', query: { limit: '100', after: '101' },
  });
});

test('initial Ready backfills a bounded page and invalidation reports one disconnect', async () => {
  const h = harness({ restGet: async () => [{ id: '1', guild_id: 'g1', channel_id: 'c1', author: { id: 'a1' } }] });
  const messages = [];
  let disconnects = 0;
  await h.transport.connect({
    token: 't', intents: 512, guildId: 'g1', channelIds: ['c1'], onMessage: (message) => messages.push(message),
    onDisconnect: () => { disconnects += 1; },
  });
  h.clients[0].emit(Events.Invalidated);
  h.clients[0].emit(Events.Invalidated);
  await h.transport.close();
  assert.deepEqual(messages.map((message) => message.id), ['1']);
  assert.equal(disconnects, 1);
  assert.equal(h.restCalls[0].query.limit, '100');
});
