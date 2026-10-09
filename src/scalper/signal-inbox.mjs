import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readCursor(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, offset: 0 };
    throw error;
  }
}

async function writeCursor(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function normalizeImportedMessage(value, { guildId, channelId, forceRoute = false } = {}) {
  const source = value?.message ?? value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Imported signal must be a Discord message object');
  const content = typeof source.content === 'string' ? source.content : '';
  const embeds = Array.isArray(source.embeds) ? source.embeds : [];
  if (!content && embeds.length === 0) throw new Error('Imported message has no content or embeds');
  const digest = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24);
  return {
    ...source,
    ...(forceRoute && source.guild_id && source.guild_id !== guildId ? { imported_from_guild_id: String(source.guild_id) } : {}),
    ...(forceRoute && source.channel_id && source.channel_id !== channelId ? { imported_from_channel_id: String(source.channel_id) } : {}),
    id: String(source.id ?? `import-${digest}`),
    guild_id: String(forceRoute ? (guildId ?? '') : (source.guild_id ?? guildId ?? '')),
    channel_id: String(forceRoute ? (channelId ?? '') : (source.channel_id ?? channelId ?? '')),
    content,
    embeds,
  };
}

export class SignalInbox {
  constructor({
    path = 'data/scalper/inbox/discord.jsonl',
    cursorPath = 'data/scalper/inbox/cursor.json',
    feed,
    guildId,
    channelId,
    events,
    env = process.env,
    now = Date.now,
    intervalMs = 5_000,
    setTimer = setInterval,
    clearTimer = clearInterval,
  } = {}) {
    if (!feed?.handleMessage) throw new Error('Signal inbox requires a Discord feed');
    this.path = path;
    this.cursorPath = cursorPath;
    this.feed = feed;
    this.guildId = guildId;
    this.channelId = channelId;
    this.events = events;
    this.env = env;
    this.now = now;
    this.intervalMs = intervalMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.polling = null;
  }

  async poll() {
    if (this.env.SCALPER_LIVE === '1' && this.env.SCALPER_SIGNAL_INBOX_LIVE_ACK !== '1') {
      return { processed: 0, matched: 0, errors: [], disabled: 'live-ack-required' };
    }
    const cursor = await readCursor(this.cursorPath);
    let buffer;
    try { buffer = await readFile(this.path); } catch (error) {
      if (error?.code === 'ENOENT') return { processed: 0, matched: 0, errors: [] };
      throw error;
    }
    let offset = Number(cursor.offset) || 0;
    if (offset > buffer.length) offset = 0;
    const unread = buffer.subarray(offset);
    const finalNewline = unread.lastIndexOf(0x0a);
    if (finalNewline < 0) return { processed: 0, matched: 0, errors: [] };
    const complete = unread.subarray(0, finalNewline + 1).toString('utf8');
    const result = { processed: 0, matched: 0, errors: [] };
    for (const line of complete.split(/\r?\n/)) {
      if (!line.trim()) continue;
      result.processed += 1;
      try {
        const message = normalizeImportedMessage(JSON.parse(line), { guildId: this.guildId, channelId: this.channelId, forceRoute: true });
        const handled = await this.feed.handleMessage(message);
        if (handled.matched) result.matched += 1;
        await this.events?.record?.('signal-inbox-message', { id: message.id, tracked: handled.tracked, matched: handled.matched });
      } catch (error) {
        result.errors.push({ error: error.message, code: error.code });
        await this.events?.record?.('signal-inbox-message', { error: error.message, code: error.code });
      }
    }
    offset += finalNewline + 1;
    await writeCursor(this.cursorPath, { version: 1, offset, updatedAt: this.now() });
    return result;
  }

  async start() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, '', { flag: 'a', mode: 0o600 });
    await this.poll();
    if (!this.timer) {
      this.timer = this.setTimer(() => {
        if (!this.polling) this.polling = this.poll().finally(() => { this.polling = null; });
      }, this.intervalMs);
      this.timer?.unref?.();
    }
    return this;
  }

  async stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.polling;
  }
}

export function createSignalInbox(options) { return new SignalInbox(options); }
