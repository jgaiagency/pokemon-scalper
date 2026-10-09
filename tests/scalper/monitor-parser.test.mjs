import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDrop } from '../../src/scalper/drop-calendar.mjs';
import {
  CHANNELS,
  MONITOR_CATEGORY_ID,
  RESTOCKD_CHANNELS,
  RESTOCKD_GUILD_ID,
  createMonitorAwareParser,
  createSignalDeduper,
  parseMonitorMessage,
  parseOfficialUpdate,
  parseRestockdMessage,
  rankSignal,
  signalToDrop,
  signalsToDrops,
} from '../../src/scalper/monitor-parser.mjs';

// Fixtures are verbatim from the guild, 2026-10-01 (docs/DISCORD-REVIEW.md).
// Embed field shape is inferred from the rendered client.
const FOOTER = { text: 'Restocks Bot v2.0 | Pokemon Restocks Monitor #ad' };
const LINKS = { name: 'Links', value: '[Cart](https://amzn.to/48aMqDR) | [Login](https://amzn.to/3KwG9bF) | [eBay](https://ebay.us/Y1ukfo) | [Price History](https://ebay.us/Y1ukfo) | [Amazon](https://amzn.to/3WhuvnE) | [TCGPlayer Data](https://partner.tcgplayer.com/o4dOob)' };
const bot = { id: '1', username: 'Pokemon Restocks Monitor', bot: true };
const restockdBot = { id: '2', username: 'Restockd', bot: true };

function restock({ content, title, url, retailer, status = 'In-Stock', limit = 'N/A', price = 'N/A', channel_id = CHANNELS.amazon, timeField }) {
  return {
    id: 'fixture-monitor-message',
    channel_id,
    timestamp: '2026-10-01T17:14:26.967Z',
    author: bot,
    content,
    embeds: [{
      author: { name: 'Item Restocked' },
      title,
      url,
      fields: [
        { name: 'Direct Link:', value: url },
        { name: 'Price', value: price },
        { name: 'Retailer', value: retailer },
        timeField ? { name: 'Time', value: timeField } : { name: 'Status', value: status },
        { name: 'Order Limit', value: limit },
        { name: 'Category', value: '[Click Me](https://amzn.to/3WhuvnE)' },
        LINKS,
      ],
      thumbnail: { url: 'https://tcgplayer-cdn.tcgplayer.com/product/695400_in_1000x1000.jpg' },
      footer: FOOTER,
    }],
  };
}

const amazon = restock({
  content: '🚨 RESTOCK - Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box @Amazon',
  title: 'Pokémon TCG: Mega Evolution—Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box',
  url: 'https://amzn.to/4rWYrTD',
  retailer: 'Sold by Amazon.com',
});

const target10 = restock({
  content: '🚨 RESTOCK - First Partner Illustration Collection Series 3 @Target 10+ Quantity Restocks',
  title: 'Pokémon Trading Card Game: First Partner Illustration Collection Series 3',
  url: 'https://buff.ly/7CJjR44',
  retailer: 'Target',
  limit: '2',
  channel_id: CHANNELS.target10,
});

const draw = restock({
  content: '🚨 DRAW - 30th Celebration Booster Bundle 2-Pack @Walmart',
  title: 'Pokémon TCG: 30th Celebration Booster Bundle 2-Pack Bundle',
  url: 'https://buff.ly/TdwFTo9',
  retailer: 'Walmart',
  timeField: 'Sep 30, 2:00pm PDT',
  channel_id: CHANNELS.walmart,
});

const pcQueue = {
  id: 'fixture-official-message',
  channel_id: CHANNELS.pokemonCenter,
  timestamp: '2026-09-30T15:47:23.774Z',
  author: bot,
  content: '🚨 Pokemon Center Queue Detected @Pokemon Center',
  embeds: [{
    author: { name: 'Pokemon Center' },
    title: 'Pokemon Center Queue',
    url: 'https://pokemoncenter.com/',
    fields: [
      { name: 'Direct Link', value: '[New Releases](https://www.pokemoncenter.com/category/new-releases)' },
      { name: 'Price', value: 'N/A' },
      { name: 'Message', value: 'Queue is up!' },
      { name: 'Links', value: '[eBay](https://ebay.us/Y1ukfo) | [TCGPlayer Data](https://partner.tcgplayer.com/o4dOob)' },
    ],
    footer: FOOTER,
  }],
};

test('Amazon restock: store comes from the headline, not the TCGPlayer link in every embed', () => {
  const s = parseMonitorMessage(amazon);
  assert.equal(s.kind, 'restock');
  assert.equal(s.site, 'amazon');
  assert.equal(s.name, 'Pokémon TCG: Mega Evolution—Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box');
  assert.equal(s.shortName, 'Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box');
  assert.equal(s.url, 'https://amzn.to/4rWYrTD');
  assert.equal(s.at, '2026-10-01T17:14:26.967Z');
  assert.equal(s.orderLimit, null);
  assert.equal(s.price, null);
});

test('Target 10+ restock carries the quantity flag and order limit', () => {
  const s = parseMonitorMessage(target10);
  assert.equal(s.site, 'target');
  assert.equal(s.highQuantity, true);
  assert.equal(s.orderLimit, 2);
  assert.equal(s.tcgplayerId, '695400');
});

test('Walmart DRAW reads the Time field in Pacific time, not the machine zone', () => {
  const s = parseMonitorMessage(draw);
  assert.equal(s.kind, 'draw');
  assert.equal(s.site, 'walmart');
  assert.equal(s.at, '2026-09-30T21:00:00.000Z');
  assert.equal(parseMonitorMessage({ ...draw, embeds: [{ ...draw.embeds[0], fields: draw.embeds[0].fields.map((f) => f.name === 'Time' ? { ...f, value: 'Sept 23, 2:00pm PDT' } : f) }] }).at, '2026-09-23T21:00:00.000Z');
  assert.equal(parseMonitorMessage({ ...draw, embeds: [{ ...draw.embeds[0], fields: draw.embeds[0].fields.map((f) => f.name === 'Time' ? { ...f, value: 'Dec 2, 9:30am PST' } : f) }] }).at, '2026-12-02T17:30:00.000Z');
});

test('Pokemon Center queue is a signal even with no product', () => {
  const s = parseMonitorMessage(pcQueue);
  assert.equal(s.kind, 'queue');
  assert.equal(s.site, 'pokemon-center');
  assert.equal(s.url, 'https://pokemoncenter.com/');
});

test('Tech Sticker Collections are TCG products (3 booster packs) and are kept', () => {
  const s = parseMonitorMessage(restock({ content: '🚨 RESTOCK - Ascended Heroes Tech Sticker Collection @Amazon', title: 'Pokémon TCG: Mega Evolution—Ascended Heroes Tech Sticker Collection', url: 'https://amzn.to/x', retailer: 'Sold by Amazon.com' }));
  assert.equal(s?.kind, 'restock');
});

test('noise is rejected: humans, New Listing, non-TCG merch, chat', () => {
  assert.equal(parseMonitorMessage({ ...amazon, author: { username: 'Zeus', bot: false } }), null);
  assert.equal(parseMonitorMessage(restock({ content: '🚨 RESTOCK - Booster Box @eBay', title: 'Booster Box', url: 'https://ebay.us/x', retailer: 'eBay - Check Seller', status: 'New Listing' })), null);
  assert.equal(parseMonitorMessage(restock({ content: '🚨 RESTOCK - Professor Willow’s Assistant Pikachu Plush @Pokemon Center', title: 'Professor Willow’s Assistant Pikachu Plush', url: 'https://buff.ly/x', retailer: 'Pokemon Center' })), null);
  assert.equal(parseMonitorMessage({ id: '2', author: { username: 'Ericsillusions', bot: false }, content: 'Is pokemin hacked', embeds: [] }), null);
});

test('community-alerts re-post parses to the same signal', () => {
  const s = parseMonitorMessage({ ...target10, channel_id: CHANNELS.communityAlerts, content: '@Community Alerts  RESTOCK - First Partner Illustration Collection Series 3' });
  assert.equal(s.site, 'target');
  assert.equal(s.mirror, true);
});

test('official-updates: queue live, PC product links, scheduled drawing, out of stock', () => {
  const at = '2026-09-30T16:01:00.000Z';
  const live = parseOfficialUpdate({ timestamp: at, content: 'Pokemon Center Queue is LIVE! Join the Queue!  @Official Updates\nJOIN QUEUE: https://pokemoncenter.com/' });
  assert.equal(live.kind, 'queue-live');

  const links = parseOfficialUpdate({ timestamp: at, content: "@Official Updates Delta Reign Preorders LIVE at Pokemon Center!\nETB: https://www.pokemoncenter.com/product/10-10438-112\nBooster Box: https://www.pokemoncenter.com/product/10-10446-120\nBooster Bundle: https://www.pokemoncenter.com/product/10-10439-109\nOnly use the direct links once you're through the queue!" });
  assert.equal(links.kind, 'products-live');
  assert.equal(links.site, 'pokemon-center');
  assert.deepEqual(links.products.map((p) => [p.label, p.sku]), [['ETB', '10-10438-112'], ['Booster Box', '10-10446-120'], ['Booster Bundle', '10-10439-109']]);

  const sched = parseOfficialUpdate({ timestamp: '2026-09-29T03:38:00.000Z', content: '@Official Updates New 30th Celebration Walmart Drawings Confirmed for this Wednesday, September 30th at 2PM PT /5PM ET!' });
  assert.equal(sched.kind, 'scheduled');
  assert.equal(sched.site, 'walmart');
  assert.equal(sched.at, '2026-09-30T21:00:00.000Z');

  const oos = parseOfficialUpdate({ timestamp: at, content: '@Official Updates Looks like ETBs are out of stock as of now. Booster Bundles and Booster Boxes still seem to be in stock!' });
  assert.equal(oos.kind, 'stock-update');

  assert.equal(parseOfficialUpdate({ timestamp: at, content: 'Keep an eye on #target for more restocks' }), null);
});

test('ranking puts PC queue and Target 10+ above plain Amazon pings', () => {
  const q = rankSignal(parseMonitorMessage(pcQueue));
  const t = rankSignal(parseMonitorMessage(target10));
  const a = rankSignal(parseMonitorMessage(amazon));
  assert.ok(q > t && t > a, `${q} > ${t} > ${a}`);
  assert.ok(rankSignal(parseMonitorMessage(amazon), { yes: 2, no: 25 }) < a, 'a ❌-heavy vote lowers the rank');
});

test('dedupe: same site+product inside the window is a repeat', () => {
  const seen = createSignalDeduper({ windowMs: 10 * 60_000 });
  const s = parseMonitorMessage(target10);
  assert.equal(seen(s), true);
  assert.equal(seen({ ...s, at: '2026-10-01T17:20:00.000Z' }), false);
  assert.equal(seen({ ...s, at: '2026-10-01T17:40:00.000Z' }), true);
});

test('signalToDrop emits a valid calendar drop only for supported sites', () => {
  assert.doesNotThrow(() => validateDrop(signalToDrop(parseMonitorMessage(target10))));
  assert.equal(signalToDrop(parseMonitorMessage(amazon)), null);
});

test('official Pokemon Center product links fan out into distinct valid calendar drops', () => {
  const signal = parseOfficialUpdate({
    id: 'pc-products', timestamp: '2026-09-30T16:01:00.000Z',
    content: '@Official Updates Products LIVE!\nETB: https://www.pokemoncenter.com/product/10-10438-112\nBooster Box: https://www.pokemoncenter.com/product/10-10446-120\nBooster Bundle: https://www.pokemoncenter.com/product/10-10439-109',
  });
  const drops = signalsToDrops(signal);
  assert.equal(drops.length, 3);
  assert.deepEqual(drops.map((drop) => drop.name), ['ETB', 'Booster Box', 'Booster Bundle']);
  for (const drop of drops) assert.doesNotThrow(() => validateDrop(drop));
  assert.equal(new Set(drops.map((drop) => drop.id)).size, 3);
});

test('monitor-aware parser routes monitor, official, and prose messages in order', () => {
  const parse = createMonitorAwareParser();
  const monitor = parse({ ...target10, parent_id: MONITOR_CATEGORY_ID }, { stores: ['target'] });
  assert.equal(monitor.signal.site, 'target');
  assert.equal(monitor.rank, 70);
  assert.equal(monitor.drop.source, 'discord-monitor');
  assert.equal(parse({ ...target10, id: 'mirror', parent_id: MONITOR_CATEGORY_ID, timestamp: '2026-10-01T17:18:00.000Z' }), null);

  const official = parse({
    id: 'official-products', channel_id: CHANNELS.officialUpdates,
    timestamp: '2026-09-30T16:01:00.000Z',
    content: '@Official Updates Delta Reign Preorders LIVE at Pokemon Center!\nETB: https://www.pokemoncenter.com/product/10-10438-112',
  });
  assert.equal(official.signal.kind, 'products-live');
  assert.equal(official.drop.source, 'discord-monitor');
  assert.equal(official.drops.length, 1);

  const prose = parse({
    id: 'official-prose', channel_id: CHANNELS.officialUpdates,
    timestamp: '2026-10-01T12:00:00.000Z',
    content: 'Target: Pokemon TCG 151 Booster Box available at 2pm today',
  }, { stores: ['target'] });
  assert.equal(prose.source, 'discord');
  assert.deepEqual(prose.sites, ['target']);
});

test('monitor-aware parser treats an authorized announcement mirror as a monitor channel', () => {
  const parse = createMonitorAwareParser();
  const mirrored = parse({
    ...target10,
    id: 'homebase-mirror',
    channel_id: 'homebase-restocks',
  }, {
    stores: ['target'],
    monitorChannelIds: ['homebase-restocks'],
  });
  assert.equal(mirrored.signal.site, 'target');
  assert.equal(mirrored.rank, 70);
  assert.equal(mirrored.drop.source, 'discord-monitor');
});

test('watchlist: on-list products carry the product and outrank off-list noise', async () => {
  const { createWatchlistMatcher } = await import('../../src/scalper/watchlist.mjs');
  const watchlist = createWatchlistMatcher([
    { id: '30th-etb', msrp: 69.99, priority: 3, all: ['30th celebration', 'elite trainer box'], none: ['pokemon center'] },
  ]);
  const parse = createMonitorAwareParser({ watchlist });
  const etb = restock({ content: '🚨 RESTOCK - 30th Celebration Elite Trainer Box @Target', title: 'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box', url: 'https://buff.ly/mMPQFoR', retailer: 'Target', limit: '2', channel_id: CHANNELS.target });
  const hit = parse({ ...etb, parent_id: MONITOR_CATEGORY_ID });
  assert.equal(hit.signal.product.id, '30th-etb');
  assert.ok(hit.rank > rankSignal(parseMonitorMessage(etb)), 'priority raises rank');

  assert.equal(parse({ ...target10, id: 'off-list', parent_id: MONITOR_CATEGORY_ID }), null, 'off-watchlist restock is dropped, not passed to the prose parser');
  assert.equal(parse({ ...pcQueue, parent_id: MONITOR_CATEGORY_ID }).signal.kind, 'queue', 'queue alerts bypass the watchlist');

  const proseOnList = parse({
    id: 'prose-on-list', channel_id: CHANNELS.officialUpdates,
    timestamp: '2026-10-01T12:00:00.000Z',
    content: 'Target: Pokemon TCG 30th Celebration Elite Trainer Box available now https://www.target.com/p/item',
  }, { stores: ['target'] });
  assert.equal(proseOnList.product.id, '30th-etb');
  assert.equal(parse({
    id: 'prose-off-list', channel_id: CHANNELS.officialUpdates,
    timestamp: '2026-10-01T12:00:00.000Z',
    content: 'Target: Pokemon TCG Random Set Elite Trainer Box available now https://www.target.com/p/item',
  }, { stores: ['target'] }), null);
});

test('Restockd Target embeds preserve retail price, quantity floor, and affiliate destination', () => {
  const message = {
    id: 'restockd-target-1', guild_id: RESTOCKD_GUILD_ID, channel_id: RESTOCKD_CHANNELS.target,
    timestamp: '2026-10-02T07:12:00.000Z', author: restockdBot,
    content: '<@&target> Pokémon Trading Card Game: 30th Celebration Booster Bundle Box restocked',
    embeds: [{
      title: 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box | Target',
      url: 'https://howl.link/link/?url=https%3A%2F%2Fwww.target.com%2Fp%2F-%2FA-1011407490',
      fields: [
        { name: 'Price', value: '$31.99' },
        { name: 'Qty', value: '>= 10' },
        { name: 'Retailer', value: 'Target' },
        { name: 'Time', value: '02:12 AM' },
      ],
      footer: { text: 'Restockd.app • #ad' },
    }],
  };
  const signal = parseRestockdMessage(message);
  assert.equal(signal.site, 'target');
  assert.equal(signal.name, 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box');
  assert.equal(signal.price, 31.99);
  assert.equal(signal.quantityFloor, 10);
  assert.equal(signal.highQuantity, true);
  assert.match(signal.url, /^https:\/\/howl\.link/);
});

test('local channel routes replace private Discord IDs without hardcoding them', () => {
  const signal = parseRestockdMessage({
    id: 'local-route-message', channel_id: 'locally-configured-target-channel',
    timestamp: '2026-10-02T07:12:00.000Z', author: restockdBot,
    content: 'Pokémon Trading Card Game: Example Booster Bundle restocked',
    embeds: [{
      title: 'Pokémon Trading Card Game: Example Booster Bundle | Target',
      url: 'https://www.target.com/p/example',
      fields: [{ name: 'Price', value: '$31.99' }, { name: 'Qty', value: '>= 10' }],
      footer: { text: 'Restockd.app • #ad' },
    }],
  }, { channelRoutes: { 'locally-configured-target-channel': 'target' } });
  assert.equal(signal.site, 'target');
});

test('Restockd news parses scheduled Target notices and Pokemon Center product links', () => {
  const scheduled = parseRestockdMessage({
    id: 'restockd-news-1', guild_id: RESTOCKD_GUILD_ID, channel_id: RESTOCKD_CHANNELS.news,
    timestamp: '2026-10-02T02:26:00.000Z', author: restockdBot,
    content: 'Pokemon Target 10/2\nTarget release tonight, Friday 10/2 starting around 12 AM PT / 3 AM ET!\nBooster Bundle: https://howl.link/abc',
  });
  assert.equal(scheduled.kind, 'scheduled');
  assert.equal(scheduled.site, 'target');
  assert.equal(scheduled.at, '2026-10-02T07:00:00.000Z');

  const products = parseRestockdMessage({
    id: 'restockd-news-2', guild_id: RESTOCKD_GUILD_ID, channel_id: RESTOCKD_CHANNELS.news,
    timestamp: '2026-09-30T15:53:00.000Z', author: restockdBot,
    content: 'Pokemon Center queue is up!\nETB: https://www.pokemoncenter.com/product/10-10438-112\nBooster Bundle: https://www.pokemoncenter.com/product/10-10439-109',
  });
  assert.equal(products.kind, 'products-live');
  assert.deepEqual(products.products.map((product) => product.sku), ['10-10438-112', '10-10439-109']);
});

test('Restockd recommended channels route through watchlist, rank, and drop conversion', async () => {
  const { createWatchlistMatcher } = await import('../../src/scalper/watchlist.mjs');
  const parse = createMonitorAwareParser({
    watchlist: createWatchlistMatcher([{ id: 'bundle', priority: 3, all: ['30th celebration', 'booster bundle'] }]),
  });
  const parsed = parse({
    id: 'restockd-target-route', guild_id: RESTOCKD_GUILD_ID, channel_id: RESTOCKD_CHANNELS.target,
    timestamp: '2026-10-02T07:12:00.000Z', author: restockdBot,
    content: 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box restocked',
    embeds: [{
      title: 'Pokémon Trading Card Game: 30th Celebration Booster Bundle Box | Target',
      url: 'https://howl.link/link/?url=https%3A%2F%2Fwww.target.com%2Fp%2F-%2FA-1011407490',
      fields: [{ name: 'Price', value: '$31.99' }, { name: 'Qty', value: '>= 10' }, { name: 'Retailer', value: 'Target' }],
      footer: { text: 'Restockd.app • #ad' },
    }],
  });
  assert.equal(parsed.signal.product.id, 'bundle');
  assert.equal(parsed.rank, 100);
  assert.equal(parsed.drop.source, 'discord-monitor');
});
