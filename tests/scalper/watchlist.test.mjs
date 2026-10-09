import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWatchlistMatcher, normalizeProductName } from '../../src/scalper/watchlist.mjs';

const config = JSON.parse(await readFile(new URL('../../config/scalper-watchlist.json', import.meta.url), 'utf8'));
const match = createWatchlistMatcher(config.products);
const id = (name) => match(name)?.id ?? null;

// Titles verbatim from the monitor embeds (2026-09-25 → 10-02) and the
// operator's Target listings (2026-10-02).
test('every operator product matches its own retailer title', () => {
  const cases = [
    ['Pokémon TCG: Mega Evolution—Delta Reign Pokémon Center Elite Trainer Box', 'delta-reign-pokemon-center-etb'],
    ['Pokémon Trading Card Game: 30th Celebration Booster Bundle', '30th-booster-bundle'],
    ['Pokémon SV 8.5 Prismatic Evolutions Super Premium Collection', 'pe-super-premium'],
    ['Pokémon Trading Card Game: Mega Evolution— Ascended Heroes Elite Trainer Box', 'ah-etb'],
    ['Celebration Tech Sticker Collection (Lucario or Alolan Exeggutor)- Styles May Vary', '30th-tech-sticker'],
    ['Pokémon Trading Card Game: Mega Evolution Ascended Heroes Booster Bundle', 'ah-booster-bundle'],
    ['Pokémon Trading Card Game: 30th Celebration Poster Collection', '30th-poster'],
    ['Pokemon Trading Card Game: 30th Celebration Tin (Sylveon or Greninja)- Styles May Vary', '30th-tin'],
    ['Pokémon Trading Card Game: 30th Celebration Elite Trainer Box', '30th-etb'],
    ['Pokémon Trading Card Game: Mega Evolution Booster Display', 'me-booster-display'],
    ['Pokémon - Trading Card Game: Scarlet & Violet - Prismatic Evolutions Elite Trainer Box', 'pe-etb'],
    ['Pokémon - Trading Card Game: Mega Evolution - Phantasmal Flames Booster Box (36 Packs)', 'phantasmal-flames-booster-display'],
    ['Pokémon Trading Card Game: 30th Celebration Knock Out Collection', '30th-knock-out'],
    ['Pokémon Trading Card Game: 30th Celebration Mini Tin- Styles May Vary', '30th-mini-tin'],
    ['Pokémon Mega Evolution S2.5 Ascended Heroes Tech Sticker - Charmander', 'ah-tech-sticker'],
  ];
  for (const [name, expected] of cases) assert.equal(id(name), expected, name);
});

test('monitor-embed spellings map to the same products', () => {
  assert.equal(id('Scarlet & Violet—Prismatic Evolutions Super-Premium Collection'), 'pe-super-premium');
  assert.equal(id('Pokémon TCG: 30th Celebration Booster Bundle 2-Pack Bundle'), '30th-booster-bundle');
  assert.equal(id('Pokemon 30th Celebration Elite Trainer Box'), '30th-etb');
  assert.equal(id('Pokémon TCG: 30th Celebration Mini Tin 10-Count Display Box'), '30th-mini-tin');
  assert.equal(id('Pokémon TCG: 30th Celebration Knock Out Collection 4-Count Bundle'), '30th-knock-out');
  assert.equal(id('Pokémon TCG: Mega Evolution—Ascended Heroes Booster Bundle'), 'ah-booster-bundle');
  assert.equal(id('Pokémon TCG: 30th Celebration Tech Sticker Collection'), '30th-tech-sticker');
});

test('near-misses do NOT match — the products that look alike', () => {
  for (const name of [
    'Pokémon TCG: Mega Evolution—Ascended Heroes Tin',
    'Pokémon TCG: Mega Evolution—Pitch Black Booster Bundle',
    'Pokémon - Trading Card Game: Mega Evolution - Pitch Black Booster Box (36 Packs)',
    'Pokémon TCG: Mega Evolution—Chaos Rising Booster Box',
    'Pokémon TCG: Mega Evolution—Delta Reign Elite Trainer Box',
    'Pokemon Scarlet & Violet 8.5 Prismatic Evolutions Poster Collection',
    '30th Celebration Pokémon Center Elite Trainer Box',
    'Pokémon TCG: 30th Celebration Greninja ex Box',
    'Mega Charizard Ultra-Premium Collection, 2-pack',
    'First Partner Illustration Collection Series 3',
    '[JP] Pokemon M6 Storm Emeralda Booster Box',
    '30th Celebration Booster Box (Japanese)',
  ]) assert.equal(id(name), null, name);
  assert.notEqual(id('Pokémon TCG: 30th Celebration Mini Tin'), '30th-tin');
});

test('normalisation folds accents, dashes and the TCG prefix', () => {
  assert.equal(normalizeProductName('Pokémon TCG: Mega Evolution—Ascended Heroes Super-Premium'), 'mega evolution ascended heroes super premium');
});

test('every product carries an MSRP and a priority', () => {
  for (const p of config.products) {
    assert.ok(Number.isFinite(p.msrp), p.id);
    assert.ok([1, 2, 3].includes(p.priority), p.id);
  }
});

test('loadWatchlist reads an injected file and returns a matcher', async () => {
  const { loadWatchlist } = await import('../../src/scalper/watchlist.mjs');
  const wl = await loadWatchlist({ path: 'x.json', read: async () => JSON.stringify({ exclude: ['japanese'], products: [{ id: 'a', all: ['booster bundle'] }] }) });
  assert.equal(wl.match('30th Celebration Booster Bundle').id, 'a');
  assert.equal(wl.match('30th Celebration Booster Bundle (Japanese)'), null);
});
