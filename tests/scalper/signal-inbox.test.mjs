import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SignalInbox, normalizeImportedMessage } from '../../src/scalper/signal-inbox.mjs';

test('imported Discord messages receive safe defaults without changing message content', () => {
  const message = normalizeImportedMessage({ content: 'Pokemon restock', embeds: [] }, { guildId: 'g', channelId: 'c' });
  assert.equal(message.guild_id, 'g');
  assert.equal(message.channel_id, 'c');
  assert.match(message.id, /^import-/);
});

test('signal inbox tails complete JSONL records exactly once and isolates poison lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scalper-inbox-'));
  const path = join(dir, 'inbox.jsonl');
  const cursorPath = join(dir, 'cursor.json');
  await writeFile(path, `${JSON.stringify({ content: 'Pokemon restock', embeds: [] })}\nnot-json\n`);
  const handled = [];
  const events = [];
  const inbox = new SignalInbox({
    path, cursorPath, guildId: 'g', channelId: 'c', env: { SCALPER_LIVE: '0' },
    feed: { handleMessage: async (message) => { handled.push(message); return { tracked: true, matched: true }; } },
    events: { record: async (type, details) => events.push({ type, ...details }) },
  });
  const first = await inbox.poll();
  const second = await inbox.poll();
  assert.deepEqual({ processed: first.processed, matched: first.matched, errors: first.errors.length }, { processed: 2, matched: 1, errors: 1 });
  assert.equal(second.processed, 0);
  assert.equal(handled.length, 1);
  assert.ok(JSON.parse(await readFile(cursorPath, 'utf8')).offset > 0);
  assert.equal(events.length, 2);
});

test('signal inbox is inert in live mode without its separate acknowledgement', async () => {
  const inbox = new SignalInbox({
    env: { SCALPER_LIVE: '1' }, feed: { handleMessage: async () => assert.fail('must not process') },
  });
  assert.equal((await inbox.poll()).disabled, 'live-ack-required');
});
