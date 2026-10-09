import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDiscordConfig } from './discord-feed.mjs';
import { loadEnvFile } from './env.mjs';
import { normalizeImportedMessage } from './signal-inbox.mjs';
import { createScalper } from './wiring.mjs';

export function parseSignalImport(source) {
  const text = String(source).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch (error) { throw new Error(`Invalid JSON on import line ${index + 1}: ${error.message}`); }
    });
  }
}

export async function importSignals({ path, env = process.env, create = createScalper, config } = {}) {
  if (!path) throw new Error('Usage: npm run scalper:ingest -- <discord-json-or-jsonl>');
  if (env.SCALPER_LIVE === '1' && env.SCALPER_SIGNAL_INBOX_LIVE_ACK !== '1') {
    throw new Error('Signal import is paper-only unless SCALPER_SIGNAL_INBOX_LIVE_ACK=1');
  }
  const resolvedConfig = config ?? await loadDiscordConfig({ env });
  const fallbackChannel = resolvedConfig.channelIds?.[0];
  const messages = parseSignalImport(await readFile(path, 'utf8'));
  const scalper = await create({ env, connectDiscord: false, discordConfig: resolvedConfig });
  const results = [];
  try {
    for (const value of messages) {
      const message = normalizeImportedMessage(value, { guildId: resolvedConfig.guildId, channelId: fallbackChannel, forceRoute: true });
      results.push(await scalper.discordFeed.handleMessage(message));
    }
  } finally {
    await scalper.stop?.();
  }
  return {
    processed: results.length,
    tracked: results.filter((result) => result.tracked).length,
    matched: results.filter((result) => result.matched).length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  console.log(JSON.stringify(await importSignals({ path: process.argv[2] }), null, 2));
}
