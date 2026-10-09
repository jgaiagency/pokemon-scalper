import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadDiscordConfig } from './discord-feed.mjs';
import { MetricsRegistry } from './metrics.mjs';
import { createMonitorAwareParser } from './monitor-parser.mjs';

export async function replayDiscordLog({ path, readText = (value) => readFile(value, 'utf8'), parser, config = {} } = {}) {
  if (!path) throw new Error('Replay path is required');
  if (typeof parser !== 'function') throw new Error('Replay parser is required');
  const source = await readText(path);
  const report = { path, messages: 0, matched: 0, signals: 0, filtered: 0, drops: [], ranks: [], errors: [] };
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let message;
    try { message = JSON.parse(lines[index]); } catch (error) {
      report.errors.push({ line: index + 1, error: error.message });
      continue;
    }
    report.messages += 1;
    try {
      const parsed = await parser(message, config);
      if (!parsed) { report.filtered += 1; continue; }
      report.matched += 1;
      if (parsed.signal) {
        report.signals += 1;
        report.ranks.push({ messageId: message.id, site: parsed.signal.site, kind: parsed.signal.kind, rank: parsed.rank });
      }
      const drops = parsed.drops ?? (parsed.drop ? [parsed.drop] : parsed.signal ? [] : [parsed]);
      report.drops.push(...drops);
    } catch (error) {
      report.errors.push({ line: index + 1, messageId: message.id, error: error.message });
    }
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? 'data/scalper/discord-drops.jsonl';
  const config = await loadDiscordConfig();
  const metrics = new MetricsRegistry();
  const parser = createMonitorAwareParser({ metrics });
  const report = await replayDiscordLog({ path, parser, config });
  console.log(JSON.stringify({ ...report, metrics: metrics.snapshot() }, null, 2));
}
