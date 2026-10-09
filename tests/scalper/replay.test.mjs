import test from 'node:test';
import assert from 'node:assert/strict';
import { replayDiscordLog } from '../../src/scalper/replay.mjs';

test('Discord replay processes JSONL deterministically and isolates malformed records', async () => {
  const lines = [
    JSON.stringify({ id: 'm1', content: 'match' }),
    '{bad json',
    JSON.stringify({ id: 'm2', content: 'ignore' }),
  ].join('\n');
  const report = await replayDiscordLog({
    path: '/drops.jsonl',
    readText: async () => lines,
    parser: async (message) => message.content === 'match'
      ? { signal: { site: 'target', kind: 'restock' }, rank: 40, drops: [{ id: 'd1' }] }
      : null,
  });
  assert.deepEqual({ messages: report.messages, matched: report.matched, signals: report.signals, drops: report.drops.length, filtered: report.filtered }, {
    messages: 2, matched: 1, signals: 1, drops: 1, filtered: 1,
  });
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].line, 2);
});
