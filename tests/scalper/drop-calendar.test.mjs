import test from 'node:test';
import assert from 'node:assert/strict';
import { DropCalendar, validateDrop } from '../../src/scalper/drop-calendar.mjs';
import { memoryStorage } from './helpers.mjs';

const path = '/test/drops.json';
const scheduled = {
  id: 'sv-151', name: 'SV 151 Booster Box', sites: ['target'],
  time: '2026-09-23T14:00:00.000Z', type: 'scheduled',
  productUrls: { target: 'https://www.target.com/p/example' }, skus: { target: 'A1' },
};

test('calendar validates, sorts, and filters upcoming drops', async () => {
  const storage = memoryStorage({ [path]: JSON.stringify({ drops: [
    { ...scheduled, id: 'later', time: '2026-09-23T14:30:00.000Z' }, scheduled,
    { ...scheduled, id: 'done', status: 'purchased' },
  ] }) });
  const calendar = new DropCalendar({ storage, path, now: () => Date.parse('2026-09-23T13:59:00Z') });
  assert.deepEqual((await calendar.upcomingDrops(10 * 60_000)).map((drop) => drop.id), ['sv-151']);
  assert.equal((await calendar.dropById('later')).name, scheduled.name);
});

test('calendar rejects malformed drop data instead of scheduling a false positive', () => {
  assert.throws(() => validateDrop({ ...scheduled, sites: ['unknown-store'] }), /unsupported site/);
  assert.throws(() => validateDrop({ ...scheduled, time: 'soon' }), /valid ISO timestamp/);
});

test('upsert persists one record per drop id', async () => {
  const storage = memoryStorage({ [path]: '{"drops":[]}' });
  const calendar = new DropCalendar({ storage, path });
  await calendar.upsertDrop(scheduled);
  await calendar.upsertDrop({ ...scheduled, name: 'Updated name' });
  const written = JSON.parse(storage.files.get(path));
  assert.equal(written.drops.length, 1);
  assert.equal(written.drops[0].name, 'Updated name');
});
