import { createHash } from 'node:crypto';
import { parseDiscordDrop } from './discord-parser.mjs';
import { SUPPORTED_SITES } from './drop-calendar.mjs';

// Structured parser for reviewed monitor-bot and staff-written announcement
// shapes. These symbolic route IDs keep tests deterministic without publishing
// an operator's Discord topology. Real IDs belong in the ignored local config.

export const GUILD_ID = 'reviewed-monitor-guild';
export const MONITOR_CATEGORY_ID = 'reviewed-monitor-category';
export const CHANNELS = Object.freeze({
  amazon: 'monitor-amazon',
  target: 'monitor-target',
  target10: 'monitor-target-high-quantity',
  walmart: 'monitor-walmart',
  bestbuy: 'monitor-bestbuy',
  macys: 'monitor-macys',
  samsclub: 'monitor-samsclub',
  costco: 'monitor-costco',
  pokemonCenter: 'monitor-pokemon-center',
  dsg: 'monitor-sporting-goods',
  ebay: 'monitor-ebay',
  gamestop: 'monitor-gamestop',
  otherStores: 'monitor-other-stores',
  officialUpdates: 'monitor-official-updates',
  communityAlerts: 'monitor-community-alerts',
});

export const RESTOCKD_GUILD_ID = 'reviewed-secondary-guild';
export const RESTOCKD_CHANNELS = Object.freeze({
  news: 'secondary-news',
  pokemonCenter: 'secondary-pokemon-center',
  amazon: 'secondary-amazon',
  target: 'secondary-target',
  dollarGeneral: 'secondary-dollar-general',
});

// Browser review on 2026-10-02 found these three channels timely and useful.
// Amazon was high-volume/over-retail and Dollar General explicitly warned that
// its inventory counts are unreliable, so neither is enabled by default.
export const RESTOCKD_RECOMMENDED_CHANNEL_IDS = Object.freeze([
  RESTOCKD_CHANNELS.news,
  RESTOCKD_CHANNELS.pokemonCenter,
  RESTOCKD_CHANNELS.target,
]);

export const MONITOR_CHANNEL_IDS = Object.freeze([
  CHANNELS.amazon,
  CHANNELS.target,
  CHANNELS.target10,
  CHANNELS.walmart,
  CHANNELS.bestbuy,
  CHANNELS.macys,
  CHANNELS.samsclub,
  CHANNELS.costco,
  CHANNELS.pokemonCenter,
  CHANNELS.dsg,
  CHANNELS.ebay,
  CHANNELS.gamestop,
  CHANNELS.otherStores,
]);

const RETAILERS = [
  [/amazon/i, 'amazon'],
  [/target/i, 'target'],
  [/walmart/i, 'walmart'],
  [/best\s*buy/i, 'bestbuy'],
  [/macy/i, 'macys'],
  [/sam'?s\s*club/i, 'samsclub'],
  [/costco/i, 'costco'],
  [/pok[eé]mon\s*center/i, 'pokemon-center'],
  [/dick'?s/i, 'dsg'],
  [/gamestop/i, 'gamestop'],
  [/ebay/i, 'ebay'],
];

const FOOTER = /Restocks Bot v\d/i;
const RESTOCKD_FOOTER = /\bRestockd(?:\.app)?\b/i;
const HEADLINE = /\b(RESTOCK|DRAW)\s+-\s+(.+?)(?:\s+@([^@]+?))?\s*$/;
const PC_QUEUE = /Pokemon Center Queue Detected/i;
const HIGH_QTY = /10\+\s*Quantity/i;
const NOT_TCG = /\b(?:plush|funko|pop!|vinyl|figure|bottle|controller|switch|apparel|hoodie|t-shirt)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const BASE_RANK = Object.freeze({
  'pokemon-center': 100, costco: 60, samsclub: 60, walmart: 45, target: 40,
  bestbuy: 35, macys: 30, dsg: 25, gamestop: 25, amazon: 20, ebay: 5,
});

function siteOf(text) {
  for (const [pattern, site] of RETAILERS) if (pattern.test(text ?? '')) return site;
  return null;
}

function linkOf(value) {
  return value?.match(/\((https?:\/\/[^)\s]+)\)/)?.[1] ?? value?.match(/https?:\/\/\S+/)?.[0] ?? null;
}

function field(embed, name) {
  return embed?.fields?.find((f) => String(f.name).replace(/:\s*$/, '').trim().toLowerCase() === name.toLowerCase())?.value?.trim();
}

function numericField(embed, name) {
  const value = field(embed, name);
  const match = value?.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function na(value) {
  return !value || /^n\/?a$/i.test(value) ? null : value;
}

// Offset in minutes of America/Los_Angeles at the given UTC instant.
function pacificOffsetMinutes(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - utcMs) / 60_000);
}

function wallClock({ year, month, day, hour, minute, zone }) {
  const naive = Date.UTC(year, month, day, hour, minute);
  const fixed = { PDT: -420, PST: -480, EDT: -240, EST: -300 }[zone?.toUpperCase()];
  if (fixed !== undefined) return naive - fixed * 60_000;
  const pacific = pacificOffsetMinutes(naive - pacificOffsetMinutes(naive) * 60_000);
  const offset = /^E/i.test(zone ?? '') ? pacific + 180 : pacific;
  return naive - offset * 60_000;
}

function yearFor(month, referenceMs) {
  const ref = new Date(referenceMs);
  const year = ref.getUTCFullYear();
  return month < ref.getUTCMonth() - 6 ? year + 1 : year;
}

function hour24(hour, meridiem) {
  let h = Number(hour) % 12;
  if (/pm/i.test(meridiem)) h += 12;
  return h;
}

// "Sep 30, 2:00pm PDT" · "Sept 30, 2:00pm PDT" · "Sep 16, 2:00pm PT"
export function parseMonitorTime(value, referenceMs) {
  const m = value?.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(PDT|PST|PT|EDT|EST|ET)\b/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return new Date(wallClock({ year: yearFor(month, referenceMs), month, day: +m[2], hour: hour24(m[3], m[5]), minute: +(m[4] ?? 0), zone: m[6] })).toISOString();
}

export function parseMonitorMessage(message = {}) {
  if (message.author?.bot !== true) return null;
  const embed = message.embeds?.[0];
  if (!embed || !FOOTER.test(embed.footer?.text ?? '')) return null;
  const content = message.content ?? '';
  const at = message.timestamp ?? null;
  const mirror = message.channel_id === CHANNELS.communityAlerts || /@Community Alerts/i.test(content);

  if (PC_QUEUE.test(content) || /Pokemon Center Queue/i.test(embed.title ?? '')) {
    return { kind: 'queue', site: 'pokemon-center', name: 'Pokemon Center Queue', url: embed.url ?? 'https://www.pokemoncenter.com/', at, messageId: message.id, channelId: message.channel_id, mirror };
  }

  const headline = content.match(HEADLINE);
  if (!headline) return null;
  const status = field(embed, 'Status');
  if (/new listing/i.test(status ?? '')) return null;
  const name = embed.title?.trim() || headline[2].trim();
  if (NOT_TCG.test(name)) return null;
  const site = siteOf(field(embed, 'Retailer')) ?? siteOf(headline[3]);
  if (!site) return null;
  const kind = headline[1].toUpperCase() === 'DRAW' ? 'draw' : 'restock';
  const limit = na(field(embed, 'Order Limit'));
  const price = na(field(embed, 'Price'));
  const drawAt = kind === 'draw' ? parseMonitorTime(field(embed, 'Time'), Date.parse(at ?? '') || Date.now()) : null;

  return {
    kind,
    site,
    name,
    shortName: headline[2].trim(),
    url: linkOf(field(embed, 'Direct Link')) ?? embed.url ?? null,
    at: drawAt ?? at,
    postedAt: at,
    price: price ? Number(price.replace(/[^\d.]/g, '')) : null,
    orderLimit: limit && /^\d+$/.test(limit) ? Number(limit) : null,
    highQuantity: message.channel_id === CHANNELS.target10 || HIGH_QTY.test(content),
    tcgplayerId: embed.thumbnail?.url?.match(/tcgplayer-cdn\.tcgplayer\.com\/product\/(\d+)_/)?.[1] ?? null,
    messageId: message.id,
    channelId: message.channel_id,
    mirror,
  };
}

function channelRoute(channelId, routes = {}) {
  return routes?.[channelId] ?? null;
}

function restockdChannelSite(channelId, routes) {
  const configured = channelRoute(channelId, routes);
  if (configured && configured !== 'news') return configured;
  if (channelId === RESTOCKD_CHANNELS.target) return 'target';
  if (channelId === RESTOCKD_CHANNELS.amazon) return 'amazon';
  if (channelId === RESTOCKD_CHANNELS.pokemonCenter) return 'pokemon-center';
  return null;
}

function zonedDateParts(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long',
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
}

function restockdSchedule(content, referenceMs) {
  const site = /walmart/i.test(content) ? 'walmart' : /target/i.test(content) ? 'target' : null;
  if (!site) return null;
  const relative = content.match(/\bin\s+(\d+)\s+minutes?\b/i);
  if (relative) return new Date(referenceMs + Number(relative[1]) * 60_000).toISOString();
  const time = content.match(/(?:starting(?:\s+around)?|at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(PT|PDT|PST|ET|EDT|EST)\b/i);
  if (!time) return null;
  const zone = time[4].toUpperCase();
  const timeZone = /^P/.test(zone) ? 'America/Los_Angeles' : 'America/New_York';
  const parts = zonedDateParts(referenceMs, timeZone);
  let month = Number(parts.month) - 1;
  let day = Number(parts.day);
  let year = Number(parts.year);
  const explicit = content.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicit) {
    month = Number(explicit[1]) - 1;
    day = Number(explicit[2]);
    year = explicit[3]
      ? Number(explicit[3]) + (Number(explicit[3]) < 100 ? 2_000 : 0)
      : yearFor(month, referenceMs);
  } else {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const named = weekdays.findIndex((weekday) => new RegExp(`\\b${weekday}\\b`, 'i').test(content));
    if (named >= 0) {
      const current = weekdays.indexOf(parts.weekday);
      const delta = (named - current + 7) % 7;
      const date = new Date(Date.UTC(year, month, day + delta));
      year = date.getUTCFullYear();
      month = date.getUTCMonth();
      day = date.getUTCDate();
    }
  }
  return new Date(wallClock({
    year, month, day,
    hour: hour24(time[1], time[3]), minute: Number(time[2] ?? 0), zone,
  })).toISOString();
}

export function parseRestockdMessage(message = {}, { channelRoutes = {} } = {}) {
  if (message.author?.bot !== true) return null;
  const embed = message.embeds?.[0];
  const content = message.content ?? '';
  const trustedShape = RESTOCKD_FOOTER.test(embed?.footer?.text ?? '')
    || /\bRestockd\b/i.test(message.author?.username ?? '');
  if (!trustedShape) return null;
  const at = message.timestamp ?? null;
  const route = channelRoute(message.channel_id, channelRoutes);
  const channelSite = restockdChannelSite(message.channel_id, channelRoutes);

  if (message.channel_id === RESTOCKD_CHANNELS.news || route === 'news') {
    const products = [...content.matchAll(/^\s*([^:\n]{2,40}):\s*(https:\/\/www\.pokemoncenter\.com\/product\/([\w-]+)\S*)/gm)]
      .map((match) => ({ label: match[1].trim(), url: match[2], sku: match[3] }));
    if (/Pokemon Center queue is up/i.test(content)) {
      if (products.length) {
        return { kind: 'products-live', site: 'pokemon-center', products, at, messageId: message.id, channelId: message.channel_id };
      }
      return { kind: 'queue-live', site: 'pokemon-center', url: 'https://www.pokemoncenter.com/', at, messageId: message.id, channelId: message.channel_id };
    }
    const scheduledAt = restockdSchedule(content, Date.parse(at ?? '') || Date.now());
    if (scheduledAt) {
      const site = /walmart/i.test(content) ? 'walmart' : 'target';
      const url = content.match(/https?:\/\/(?!restockd\.app)[^\s<>]+/i)?.[0]?.replace(/[),.;]+$/, '') ?? null;
      return { kind: 'scheduled', site, name: site === 'walmart' ? 'Walmart Drawing' : 'Target Release', text: content.trim(), url, at: scheduledAt, postedAt: at, messageId: message.id, channelId: message.channel_id };
    }
    return null;
  }

  if (message.channel_id === RESTOCKD_CHANNELS.pokemonCenter || channelSite === 'pokemon-center') {
    const status = field(embed, 'Status');
    if (/queue/i.test(`${content}\n${embed?.title ?? ''}\n${status ?? ''}`)) {
      return {
        kind: /possible/i.test(status ?? '') ? 'queue-watch' : 'queue',
        site: 'pokemon-center', name: 'Pokemon Center Queue',
        url: embed?.url ?? 'https://www.pokemoncenter.com/', at,
        messageId: message.id, channelId: message.channel_id,
      };
    }
  }

  if (!embed || !/restock/i.test(`${content}\n${embed.title ?? ''}`)) return null;
  const site = siteOf(field(embed, 'Retailer')) ?? channelSite;
  if (!site) return null;
  const name = embed.title?.replace(/\s*\|\s*(?:Target|Amazon)\s*$/i, '').trim();
  if (!name) return null;
  const quantityFloor = numericField(embed, 'Qty');
  return {
    kind: 'restock', site, name,
    url: embed.url ?? linkOf(field(embed, `View on ${site}`)) ?? null,
    at, postedAt: at,
    price: numericField(embed, 'Price'),
    quantityFloor,
    highQuantity: Number.isFinite(quantityFloor) && quantityFloor >= 10,
    messageId: message.id, channelId: message.channel_id,
  };
}

const PC_PRODUCT_LINE = /^\s*([^:\n]{2,40}):\s*(https:\/\/www\.pokemoncenter\.com\/product\/([\w-]+)\S*)/gm;
const SCHEDULED = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(PT|PDT|PST|ET|EDT|EST)\b/i;

export function parseOfficialUpdate(message = {}) {
  const content = message.content ?? '';
  const at = message.timestamp ?? null;
  if (/Queue is LIVE/i.test(content)) {
    return { kind: 'queue-live', site: 'pokemon-center', url: 'https://www.pokemoncenter.com/', at, messageId: message.id };
  }
  const products = [...content.matchAll(PC_PRODUCT_LINE)].map((m) => ({ label: m[1].trim(), url: m[2], sku: m[3] }));
  if (products.length) {
    return { kind: 'products-live', site: 'pokemon-center', products, at, messageId: message.id };
  }
  const sched = content.match(SCHEDULED);
  if (sched) {
    const month = MONTHS.indexOf(sched[1].slice(0, 3).toLowerCase());
    if (month >= 0) {
      const when = wallClock({ year: yearFor(month, Date.parse(at ?? '') || Date.now()), month, day: +sched[2], hour: hour24(sched[3], sched[5]), minute: +(sched[4] ?? 0), zone: sched[6] });
      return { kind: 'scheduled', site: siteOf(content), text: content.trim(), at: new Date(when).toISOString(), postedAt: at, messageId: message.id };
    }
  }
  if (/out of stock|in stock/i.test(content) && /@Official Updates/i.test(content)) {
    return { kind: 'stock-update', site: siteOf(content), text: content.trim(), at, messageId: message.id };
  }
  return null;
}

// Higher = act on it first. votes = the ✅/❌ reactions ("I scored" / "I didn't").
export function rankSignal(signal, votes) {
  if (!signal) return 0;
  let score = ['queue', 'queue-live', 'products-live'].includes(signal.kind) ? 100 : (BASE_RANK[signal.site] ?? 10);
  if (signal.highQuantity) score += 30;
  if (signal.kind === 'draw' || signal.kind === 'scheduled') score = Math.max(score, 50);
  if (signal.mirror) score -= 5;
  if (signal.product?.priority) score += 10 * signal.product.priority;
  const yes = votes?.yes ?? 0;
  const no = votes?.no ?? 0;
  if (yes + no >= 5) score *= 0.5 + yes / (yes + no);
  return Math.round(score * 10) / 10;
}

// Returns true when the signal is new; false for a repeat of the same
// site+product inside the window (mirrors, flapping Amazon pings).
export function createSignalDeduper({ windowMs = 10 * 60_000 } = {}) {
  const last = new Map();
  return (signal) => {
    const identity = signal.name
      ?? signal.products?.map((product) => product.sku ?? product.url ?? product.label).join('|')
      ?? signal.text
      ?? signal.url
      ?? '';
    const key = `${signal.kind}:${signal.site}:${identity.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    const t = Date.parse(signal.at ?? signal.postedAt ?? '') || Date.now();
    const prev = last.get(key);
    if (prev !== undefined && t - prev < windowMs) return false;
    last.set(key, t);
    return true;
  };
}

function dropFromSignal(signal, { name, url, identity = name, productId = signal.product?.id } = {}) {
  const seed = signal.messageId ? `${signal.messageId}:${identity}` : `${signal.site}:${identity}:${signal.at}`;
  return {
    id: `discord-monitor-${signal.site}-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`,
    name,
    sites: [signal.site],
    time: signal.at,
    type: signal.kind === 'draw' || signal.kind === 'scheduled' ? 'scheduled' : 'surprise',
    productUrls: url ? { [signal.site]: url } : {},
    ...(productId ? { productId } : {}),
    ...(Number.isFinite(signal.price) ? { price: signal.price } : {}),
    source: 'discord-monitor',
  };
}

export function signalsToDrops(signal) {
  if (!signal?.at || !SUPPORTED_SITES.includes(signal.site)) return [];
  if (signal.kind === 'products-live' && signal.products?.length) {
    return signal.products.map((product) => dropFromSignal(signal, {
      name: product.label,
      url: product.url,
      identity: product.sku ?? product.url ?? product.label,
      productId: product.productId ?? product.id ?? product.sku,
    }));
  }
  if (!signal.name) return [];
  return [dropFromSignal(signal, { name: signal.name, url: signal.url })];
}

export function signalToDrop(signal) {
  return signalsToDrops(signal)[0] ?? null;
}

function reactionVotes(message) {
  const votes = { yes: 0, no: 0 };
  for (const reaction of message?.reactions ?? []) {
    if (reaction.emoji?.name === '✅') votes.yes += Number(reaction.count) || 0;
    if (reaction.emoji?.name === '❌') votes.no += Number(reaction.count) || 0;
  }
  return votes;
}

// Returns either a legacy calendar drop or a structured monitor result. The
// latter can be alert-only when a retailer is outside the four checkout lanes.
// watchlist: (name) => product | null (src/scalper/watchlist.mjs). When given,
// restock/draw signals for products not on it are dropped; queue and official
// signals carry no product and always pass.
export function createMonitorAwareParser({ dedupe = createSignalDeduper(), metrics, watchlist } = {}) {
  const monitorChannels = new Set([...MONITOR_CHANNEL_IDS, ...RESTOCKD_RECOMMENDED_CHANNEL_IDS]);
  return (message, config = {}) => {
    const configuredMonitorChannels = new Set(config.monitorChannelIds ?? []);
    const configuredOfficialChannels = new Set(config.officialChannelIds ?? []);
    const configuredCategories = new Set(config.categoryIds ?? []);
    const monitorChannel = message?.parent_id === MONITOR_CATEGORY_ID
      || configuredCategories.has(message?.parent_id)
      || monitorChannels.has(message?.channel_id)
      || configuredMonitorChannels.has(message?.channel_id);
    const officialChannel = message?.channel_id === CHANNELS.officialUpdates
      || configuredOfficialChannels.has(message?.channel_id);
    let signal = null;
    if (monitorChannel) signal = parseMonitorMessage(message)
      ?? parseRestockdMessage(message, { channelRoutes: config.channelRoutes });
    if (!signal && officialChannel) signal = parseMonitorMessage(message) ?? parseOfficialUpdate(message);
    if (signal && watchlist && (signal.kind === 'restock' || signal.kind === 'draw')) {
      const product = watchlist(signal.name) ?? watchlist(signal.shortName);
      if (!product) {
        metrics?.increment?.('discord_parser', { outcome: 'off-watchlist', kind: signal.kind, site: signal.site ?? 'unknown' });
        return null;
      }
      signal = { ...signal, product };
    }
    if (signal) {
      metrics?.increment?.('discord_parser', { outcome: 'signal', kind: signal.kind, site: signal.site ?? 'unknown' });
      if (!dedupe(signal)) {
        metrics?.increment?.('discord_parser', { outcome: 'duplicate', kind: signal.kind, site: signal.site ?? 'unknown' });
        return null;
      }
      const rank = rankSignal(signal, reactionVotes(message));
      metrics?.observe?.('discord_signal_rank', rank, { kind: signal.kind, site: signal.site ?? 'unknown' });
      const drops = signalsToDrops(signal);
      return {
        signal,
        rank,
        drops,
        drop: drops.length === 1 ? drops[0] : null,
      };
    }
    const drop = parseDiscordDrop(message, config);
    if (drop && watchlist) {
      const product = watchlist(drop.name);
      if (!product) {
        metrics?.increment?.('discord_parser', {
          outcome: 'off-watchlist', kind: 'prose', site: drop.sites?.[0] ?? 'unknown',
        });
        return null;
      }
      drop.product = product;
    }
    metrics?.increment?.('discord_parser', { outcome: drop ? 'prose' : 'unmatched', site: drop?.sites?.[0] ?? 'unknown' });
    return drop;
  };
}
