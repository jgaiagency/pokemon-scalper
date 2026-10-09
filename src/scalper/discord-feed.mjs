import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DropCalendar } from './drop-calendar.mjs';
import { parseDiscordDrop } from './discord-parser.mjs';

export const GUILDS_INTENT = 1 << 0;
export const GUILD_MESSAGES_INTENT = 1 << 9;
export const MESSAGE_CONTENT_INTENT = 1 << 15;
export const DEFAULT_DISCORD_INTENTS = GUILDS_INTENT | GUILD_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fileStorage() {
  return {
    async appendText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, value, { encoding: 'utf8', mode: 0o600 });
      await chmod(path, 0o600);
    },
  };
}

export function parseDropMessage(message, config = {}) {
  return parseDiscordDrop(message, config);
}

export class DiscordFeed {
  #config;
  #storage;
  #logPath;
  #parser;
  #calendar;
  #onDrop;
  #onSignal;
  #transport;
  #sleep;
  #logger;
  #reconnectBackoff;
  #reconnectAttempts = 0;
  #running = false;
  #connecting = null;
  #channelParents = new Map();
  #seenMessages;
  #productEndpoints;

  constructor({
    config,
    storage = fileStorage(),
    logPath,
    parser = parseDropMessage,
    calendar = new DropCalendar(),
    onDrop,
    onSignal,
    transport,
    sleep = delay,
    reconnectBackoff = (attempt) => Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1))),
    seenMessages,
    productEndpoints,
    logger = console,
  } = {}) {
    if (!config) throw new Error('DiscordFeed requires config');
    this.#config = config;
    this.#storage = storage;
    this.#logPath = logPath ?? join(process.env.SCALPER_DATA_DIR || 'data/scalper', 'discord-drops.jsonl');
    this.#parser = parser;
    this.#calendar = calendar;
    this.#onDrop = onDrop;
    this.#onSignal = onSignal;
    this.#transport = transport;
    this.#sleep = sleep;
    this.#reconnectBackoff = reconnectBackoff;
    this.#seenMessages = seenMessages;
    this.#productEndpoints = productEndpoints;
    this.#logger = logger;
    for (const channel of config.channels ?? []) this.handleChannel(channel);
  }

  handleChannel(channel) {
    if (channel?.guild_id !== this.#config.guildId || !channel.id) return false;
    this.#channelParents.set(channel.id, channel.parent_id ?? null);
    return this.#config.categoryIds?.includes(channel.parent_id) ?? false;
  }

  #isTracked(message) {
    if (message.guild_id !== this.#config.guildId) return false;
    const parentId = message.parent_id ?? message.channel?.parent_id ?? this.#channelParents.get(message.channel_id);
    return this.#config.channelIds?.includes(message.channel_id) || this.#config.categoryIds?.includes(parentId);
  }

  async handleMessage(message) {
    this.#reconnectAttempts = 0;
    if (!this.#isTracked(message)) return { tracked: false, matched: false };
    const authorId = message.author?.id ?? message.member?.user?.id;
    if (!authorId || !(this.#config.authorIds ?? []).includes(authorId)) {
      return { tracked: true, matched: false, reason: 'author-not-allowlisted' };
    }
    if (this.#seenMessages) {
      if (!message.id) return { tracked: true, matched: false, reason: 'missing-message-id' };
      const claimed = await this.#seenMessages.claim({
        messageId: message.id,
        channelId: message.channel_id,
        at: Number.isFinite(Date.parse(message.timestamp)) ? Date.parse(message.timestamp) : Date.now(),
      });
      if (!claimed) return { tracked: true, matched: false, reason: 'duplicate-message' };
    }
    await this.#storage.appendText(this.#logPath, `${JSON.stringify({ receivedAt: Date.now(), ...message })}\n`);
    const parentId = message.parent_id ?? message.channel?.parent_id ?? this.#channelParents.get(message.channel_id);
    const parserMessage = parentId && !message.parent_id ? { ...message, parent_id: parentId } : message;
    const parsed = await this.#parser(parserMessage, this.#config);
    if (!parsed) return { tracked: true, matched: false };
    const structured = typeof parsed === 'object' && parsed !== null
      && (Object.hasOwn(parsed, 'signal') || Object.hasOwn(parsed, 'drop') || Object.hasOwn(parsed, 'drops'));
    const signal = structured ? parsed.signal : null;
    const rank = structured ? parsed.rank : undefined;
    const drops = structured ? (parsed.drops ?? (parsed.drop ? [parsed.drop] : [])) : [parsed];
    const executableDrops = [];
    const persistedDrops = [];
    for (const value of drops) {
      if (!this.#productEndpoints) {
        persistedDrops.push(value);
        executableDrops.push(value);
        continue;
      }
      const mapped = await this.#productEndpoints.forDrop(value);
      if (mapped.missingSites.length) {
        persistedDrops.push({ ...mapped.drop, status: 'unmeasured', unmeasuredSites: mapped.missingSites });
      } else {
        persistedDrops.push(mapped.drop);
        executableDrops.push(mapped.drop);
      }
    }
    const drop = persistedDrops.length === 1 ? persistedDrops[0] : null;
    for (const value of persistedDrops) await this.#calendar?.upsertDrop?.(value);
    // Start eligible lane work immediately after durable persistence. Paging
    // and ranking are important, but neither belongs ahead of execution.
    for (const value of executableDrops) await this.#onDrop?.(value);
    if (signal) await this.#onSignal?.(signal, rank);
    return { tracked: true, matched: true, ...(signal ? { signal, rank } : {}), ...(drop ? { drop } : {}), ...(persistedDrops.length > 1 ? { drops: persistedDrops } : {}) };
  }

  async #connect() {
    if (!this.#transport?.connect) throw new Error('Discord Gateway transport must be injected');
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#transport.connect({
      token: this.#config.token,
      intents: this.#config.intents ?? DEFAULT_DISCORD_INTENTS,
      guildId: this.#config.guildId,
      channelIds: this.#config.channelIds,
      getLastMessageId: this.#seenMessages
        ? async (channelId) => (await this.#seenMessages.latest(channelId))?.messageId
        : undefined,
      onMessage: (message) => this.handleMessage(message).catch((error) => this.#logger?.warn?.('Discord message failed', error)),
      onChannel: (channel) => this.handleChannel(channel),
      onDisconnect: async () => {
        if (!this.#running) return;
        this.#reconnectAttempts += 1;
        await this.#sleep(this.#reconnectBackoff(this.#reconnectAttempts));
        if (!this.#running) return;
        this.#connecting = null;
        await this.#connect();
      },
    }).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async start() {
    this.#running = true;
    await this.#connect();
    return this;
  }

  async stop() {
    this.#running = false;
    await this.#transport?.close?.();
  }
}

export async function loadDiscordConfig({ path, env = process.env } = {}) {
  const configPath = path ?? env.SCALPER_DISCORD_CONFIG_PATH ?? 'config/scalper-discord.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof config.token === 'string' && config.token.startsWith('env:')) {
    const key = config.token.slice(4);
    config.token = env[key] ?? null;
  }
  return config;
}

export function createDiscordFeed(options) {
  return new DiscordFeed(options);
}
