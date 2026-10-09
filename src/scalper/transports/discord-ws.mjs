import { Client, Events, Options, REST, Routes } from 'discord.js';

const DEFAULT_BACKFILL_PAGES = 5;
const DISCORD_PAGE_SIZE = 100;

function normalizeMessage(value) {
  const raw = typeof value?.toJSON === 'function' ? value.toJSON() : { ...value };
  const author = typeof value?.author?.toJSON === 'function' ? value.author.toJSON() : value?.author ?? raw.author;
  const member = typeof value?.member?.toJSON === 'function' ? value.member.toJSON() : value?.member ?? raw.member;
  return {
    ...raw,
    id: value?.id ?? raw.id,
    guild_id: value?.guildId ?? raw.guild_id,
    channel_id: value?.channelId ?? raw.channel_id,
    ...(author ? { author } : {}),
    ...(member ? { member } : {}),
    ...(value?.createdAt && !raw.timestamp ? { timestamp: value.createdAt.toISOString() } : {}),
  };
}

function normalizeChannel(value) {
  const raw = typeof value?.toJSON === 'function' ? value.toJSON() : { ...value };
  return {
    ...raw,
    id: value?.id ?? raw.id,
    guild_id: value?.guildId ?? raw.guild_id,
    parent_id: value?.parentId ?? raw.parent_id,
  };
}

function compareSnowflakes(left, right) {
  try {
    const a = BigInt(left.id);
    const b = BigInt(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return String(left.id).localeCompare(String(right.id));
  }
}

function defaultClientFactory({ intents }) {
  return new Client({
    intents,
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
      GuildMemberManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 600 },
    },
  });
}

function defaultRestFactory(token) {
  return new REST({ version: '10' }).setToken(token);
}

class DiscordSdkTransport {
  constructor({ clientFactory, restFactory, routes, maxBackfillPages, logger }) {
    Object.assign(this, { clientFactory, restFactory, routes, maxBackfillPages, logger });
    this.client = null;
    this.rest = null;
    this.callbacks = {};
    this.guildId = null;
    this.channelIds = new Set();
    this.resumeCount = 0;
    this.readyCount = 0;
    this.backfilledMessages = 0;
    this.closing = false;
    this.disconnectNotified = false;
    this.backfillPromise = Promise.resolve();
  }

  stats() {
    return {
      sdk: 'discord.js',
      connected: Boolean(this.client?.isReady?.()),
      userId: this.client?.user?.id ?? null,
      heartbeatRttMs: Number.isFinite(this.client?.ws?.ping) ? this.client.ws.ping : null,
      resumeCount: this.resumeCount,
      readyCount: this.readyCount,
      backfilledMessages: this.backfilledMessages,
      cachedMessagesLimit: 100,
    };
  }

  async connect({ token, intents, guildId, channelIds = [], getLastMessageId, onMessage, onChannel, onDisconnect } = {}) {
    if (!token) throw new Error('Discord Gateway token is required');
    if (this.client) return;
    this.callbacks = { getLastMessageId, onMessage, onChannel, onDisconnect };
    this.guildId = guildId ?? null;
    this.channelIds = new Set(channelIds);
    this.disconnectNotified = false;
    this.closing = false;
    this.rest = this.restFactory(token);
    const client = this.clientFactory({ intents });
    this.client = client;

    client.on(Events.MessageCreate, (message) => {
      const normalized = normalizeMessage(message);
      if (!this.guildId || normalized.guild_id === this.guildId) this.#invoke(onMessage, normalized);
    });
    client.on(Events.ChannelCreate, (channel) => {
      const normalized = normalizeChannel(channel);
      if (!this.guildId || normalized.guild_id === this.guildId) this.#invoke(onChannel, normalized);
    });
    client.on(Events.ClientReady, (readyClient) => {
      this.readyCount += 1;
      for (const channel of readyClient?.channels?.cache?.values?.() ?? []) {
        const normalized = normalizeChannel(channel);
        if (!this.guildId || normalized.guild_id === this.guildId) this.#invoke(onChannel, normalized);
      }
      this.#queueBackfill('ready');
    });
    client.on(Events.ShardResume, () => {
      // discord.js owns session_id/sequence and sends OP 6 RESUME only after
      // HELLO. This event proves that the maintained SDK completed a resume.
      this.resumeCount += 1;
      this.#queueBackfill('resume');
    });
    client.on(Events.Invalidated, () => {
      if (this.client === client) this.client = null;
      try { client.destroy?.(); } catch { /* Reconnect callback still runs. */ }
      this.#notifyDisconnect();
    });
    client.on(Events.Error, (error) => this.logger?.warn?.('Discord SDK client error', error));
    client.on(Events.ShardError, (error) => this.logger?.warn?.('Discord SDK shard error', error));

    try {
      // discord.js performs HELLO -> IDENTIFY for a new session and retains
      // session_id + sequence for RESUME. This wrapper writes no raw opcodes.
      await client.login(token);
    } catch (error) {
      this.client = null;
      try { client.destroy?.(); } catch { /* Preserve the login error. */ }
      throw error;
    }
  }

  #queueBackfill(reason) {
    this.backfillPromise = this.backfillPromise
      .then(() => this.#backfill())
      .catch((error) => this.logger?.warn?.(`Discord ${reason} backfill failed`, error));
  }

  async #backfill() {
    if (!this.rest?.get) return;
    for (const channelId of this.channelIds) {
      let after = await this.callbacks.getLastMessageId?.(channelId);
      for (let page = 0; page < this.maxBackfillPages; page += 1) {
        const query = new URLSearchParams({ limit: String(DISCORD_PAGE_SIZE) });
        if (after) query.set('after', after);
        const response = await this.rest.get(this.routes.channelMessages(channelId), { query });
        const messages = Array.isArray(response) ? response.map(normalizeMessage).sort(compareSnowflakes) : [];
        for (const message of messages) {
          if (!this.guildId || message.guild_id === this.guildId) {
            await this.callbacks.onMessage?.(message);
            this.backfilledMessages += 1;
          }
        }
        if (messages.length < DISCORD_PAGE_SIZE) break;
        after = messages.at(-1)?.id;
        if (!after) break;
      }
    }
  }

  #invoke(callback, value) {
    if (!callback) return;
    try {
      Promise.resolve(callback(value)).catch((error) => this.logger?.warn?.('Discord callback failed', error));
    } catch (error) {
      this.logger?.warn?.('Discord callback failed', error);
    }
  }

  #notifyDisconnect() {
    if (this.closing || this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.#invoke(this.callbacks.onDisconnect);
  }

  async close() {
    if (!this.client) {
      await this.backfillPromise;
      return;
    }
    this.closing = true;
    const client = this.client;
    this.client = null;
    client.destroy?.();
    await this.backfillPromise;
  }
}

export function createDiscordWsTransport({
  clientFactory = defaultClientFactory,
  restFactory = defaultRestFactory,
  routes = Routes,
  maxBackfillPages = DEFAULT_BACKFILL_PAGES,
  logger = console,
} = {}) {
  if (typeof clientFactory !== 'function') throw new Error('Discord transport requires a client factory');
  if (typeof restFactory !== 'function') throw new Error('Discord transport requires a REST factory');
  if (!Number.isInteger(maxBackfillPages) || maxBackfillPages < 1 || maxBackfillPages > 20) {
    throw new RangeError('Discord maxBackfillPages must be between 1 and 20');
  }
  return new DiscordSdkTransport({ clientFactory, restFactory, routes, maxBackfillPages, logger });
}
