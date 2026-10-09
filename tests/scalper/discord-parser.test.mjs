import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDrop } from '../../src/scalper/drop-calendar.mjs';
import { parseDiscordDrop } from '../../src/scalper/discord-parser.mjs';

const now = Date.parse('2026-10-01T12:00:00.000Z');
const parse = (message) => parseDiscordDrop(typeof message === 'string' ? { id: 'm1', content: message } : message, { now: () => now, timeZoneOffsetMinutes: 0 });

test('parser handles seven common announcement shapes', async (t) => {
  const cases = [
    ['SV 151 Booster Box drops at 10am on Pokemon Center', 'pokemon-center', 'scheduled'],
    ['TCGPlayer just restocked Scarlet & Violet 151 ETBs — grab them now', 'tcgplayer', 'surprise'],
    ['Target: Pokemon TCG 151 Booster Box available at 2pm today', 'target', 'scheduled'],
    ['Best Buy has 151 booster boxes in stock, link: https://bestbuy.example/p/151', 'bestbuy', 'surprise'],
    ['DROP ALERT: Pokemon Center 151 ETB at 14:00 UTC', 'pokemon-center', 'scheduled'],
    ['Restock: TCGPlayer 151 booster box, 5 units available', 'tcgplayer', 'surprise'],
    [{ id: 'embed-1', content: '', embeds: [{ title: 'Target Pokémon TCG 151 ETB', description: 'Available now', url: 'https://target.example/p/151' }] }, 'target', 'surprise'],
  ];
  for (const [index, [message, site, type]] of cases.entries()) {
    await t.test(`pattern ${index + 1}`, () => {
      const drop = parse(message);
      assert.equal(drop.sites[0], site);
      assert.equal(drop.type, type);
      assert.doesNotThrow(() => validateDrop(drop));
    });
  }
});

test('parser extracts times, URLs, quantities, relative times, and the first store', () => {
  assert.equal(parse('SV 151 Booster Box drops at 10am on Pokemon Center').time, '2026-10-01T10:00:00.000Z');
  assert.equal(parse('Target: Pokemon TCG 151 Booster Box available at 2pm today').time, '2026-10-01T14:00:00.000Z');
  assert.equal(parse('DROP ALERT: Pokemon Center 151 ETB at 14:00 UTC').time, '2026-10-01T14:00:00.000Z');
  assert.equal(parse('Best Buy has 151 booster boxes in stock, link: https://bestbuy.example/p/151').productUrls.bestbuy, 'https://bestbuy.example/p/151');
  assert.equal(parse('Restock: TCGPlayer 151 booster box, 5 units available').quantity, 5);
  assert.equal(parse('Target Pokemon TCG 151 ETB available in 15 minutes').time, '2026-10-01T12:15:00.000Z');
  assert.equal(parse('Target and Best Buy: Pokemon TCG 151 ETB available now').sites[0], 'target');
});

test('parser defaults messages without a time to now as surprise drops', () => {
  const drop = parse('TCGPlayer just restocked Scarlet & Violet 151 ETBs');
  assert.equal(drop.time, '2026-10-01T12:00:00.000Z');
  assert.equal(drop.type, 'surprise');
});

test('parser rejects missing fields and non-Pokémon false positives', () => {
  assert.equal(parse('151 ETB available now'), null);
  assert.equal(parse('Target has Pokémon cards available now'), null);
  assert.equal(parse('Target One Piece booster box in stock'), null);
  assert.equal(parse('Target Pokémon Legends Z-A video game available now'), null);
  assert.equal(parse('Target Pokémon TCG 151 ETB looks cool'), null);
});
