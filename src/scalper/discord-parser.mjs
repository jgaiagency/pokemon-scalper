import { createHash } from 'node:crypto';

const STORE_PATTERNS = Object.freeze([
  ['pokemon-center', /pokemon\s*center|\bpkmn\b/i],
  ['tcgplayer', /tcg\s*player/i],
  ['bestbuy', /best\s*buy|\bbestbuy\b|\bbb\b/i],
  ['target', /\btarget\b/i],
]);

const PRODUCT_KIND = /\b(?:booster\s+box(?:es)?|etbs?|elite\s+trainer\s+box(?:es)?|premium\s+tin(?:s)?|tin(?:s)?|collector\s+box(?:es)?|collection\s+box(?:es)?|premium\s+collection(?:s)?)\b/i;
const OTHER_GAMES = /\b(?:one\s+piece|magic(?:\s+the\s+gathering)?|mtg|yu-?gi-?oh|lorcana|baseball|basketball|football)\b/i;
const POKEMON_CONTEXT = /\b(?:pok[eé]mon|pokemon\s*tcg|sv|scarlet|violet|prismatic|paldean|temporal|twilight|stellar|surging|shrouded|obsidian|crown\s+zenith|lost\s+origin|silver\s+tempest|151|etbs?)\b/i;
const DROP_SIGNAL = /\b(?:drop(?:s|ped)?|restock(?:ed|s)?|release|available|in\s+stock|just\s+dropped|grab\s+them\s+now|on\s+sale|live\s+now)\b/i;

function messageParts(message = {}) {
  const parts = [];
  if (message.content) parts.push(message.content);
  for (const embed of message.embeds ?? []) {
    if (embed.title) parts.push(embed.title);
    if (embed.description) parts.push(embed.description);
    for (const field of embed.fields ?? []) parts.push(field.name, field.value);
    if (embed.footer?.text) parts.push(embed.footer.text);
    if (embed.url) parts.push(embed.url);
  }
  return parts.filter(Boolean).map(String);
}

export function extractStore(text) {
  const matches = STORE_PATTERNS.map(([site, pattern], order) => {
    const match = pattern.exec(text);
    return match ? { site, index: match.index, order } : null;
  }).filter(Boolean).sort((a, b) => a.index - b.index || a.order - b.order);
  return matches[0]?.site ?? null;
}

function isPokemonSealedProduct(text, site) {
  if (!PRODUCT_KIND.test(text)) return false;
  if (OTHER_GAMES.test(text) && !/pok[eé]mon/i.test(text)) return false;
  return POKEMON_CONTEXT.test(text) || site === 'pokemon-center';
}

export function extractProductName(parts) {
  const source = parts.find((part) => PRODUCT_KIND.test(part));
  if (!source) return null;
  let text = source
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/^\s*(?:drop\s+alert|restock|drop|alert)\s*:?\s*/i, '')
    .replace(/pokemon\s*center|\bpkmn\b|tcg\s*player|best\s*buy|\bbestbuy\b|\btarget\b/ig, ' ')
    .replace(/^\s*[:—-]?\s*(?:just\s+)?(?:has\s+|restocked\s+|restocks?\s+)?/i, '')
    .replace(/^\s*(?:and|or)\b\s*[:—-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const end = PRODUCT_KIND.exec(text);
  if (!end) return null;
  text = text.slice(0, end.index + end[0].length)
    .replace(/^\s*[:—,-]+\s*/, '')
    .trim();
  return text || null;
}

function localDateAt(nowMs, dayOffset, hour, minute, offsetMinutes) {
  const local = new Date(nowMs + offsetMinutes * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour, minute) - offsetMinutes * 60_000;
}

function normalizeHour(hour, meridiem) {
  let value = Number(hour);
  if (!meridiem) return value;
  if (value === 12) value = 0;
  if (meridiem.toLowerCase() === 'pm') value += 12;
  return value;
}

export function extractDropTime(text, { nowMs, timeZoneOffsetMinutes } = {}) {
  const discordTimestamp = text.match(/<t:(\d{9,12})(?::[A-Za-z])?>/);
  if (discordTimestamp) return { timeMs: Number(discordTimestamp[1]) * 1_000, explicit: true };

  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/i)?.[0];
  if (iso && Number.isFinite(Date.parse(iso))) return { timeMs: Date.parse(iso), explicit: true };

  const relative = text.match(/\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/i);
  if (relative) {
    const multiplier = /^h/i.test(relative[2]) ? 60 * 60_000 : 60_000;
    return { timeMs: nowMs + Number(relative[1]) * multiplier, explicit: true };
  }

  const utc = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*utc\b/i);
  if (utc) {
    const dayOffset = /\btomorrow\b/i.test(text) ? 1 : 0;
    const date = new Date(nowMs);
    const hour = normalizeHour(utc[1], utc[3]);
    return { timeMs: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset, hour, Number(utc[2] ?? 0)), explicit: true };
  }

  const localTime = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))\s*(am|pm)?\b/i)
    ?? text.match(/\b(?:at\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (localTime) {
    const dayOffset = /\btomorrow\b/i.test(text) ? 1 : 0;
    const hour = normalizeHour(localTime[1], localTime[3]);
    return { timeMs: localDateAt(nowMs, dayOffset, hour, Number(localTime[2] ?? 0), timeZoneOffsetMinutes), explicit: true };
  }
  return { timeMs: nowMs, explicit: false };
}

function extractQuantity(text) {
  const match = text.match(/\b(?:qty\.?\s*[:=]?\s*|only\s+)?(\d+)\s+units?\s+(?:available|left|in\s+stock)\b/i)
    ?? text.match(/\bqty\.?\s*[:=]?\s*(\d+)\b/i);
  return match ? Number(match[1]) : undefined;
}

export function parseDiscordDrop(message, options = {}) {
  const parts = messageParts(message);
  const text = parts.join('\n');
  const site = extractStore(text);
  if (!site || (options.stores?.length && !options.stores.includes(site))) return null;
  if (!DROP_SIGNAL.test(text)) return null;
  if (!isPokemonSealedProduct(text, site)) return null;
  const name = extractProductName(parts);
  if (!name) return null;

  const suppliedNow = typeof options.now === 'function' ? options.now() : options.now;
  const timestampNow = Number.isFinite(suppliedNow) ? suppliedNow : Date.now();
  const messageTime = Date.parse(message?.timestamp ?? '');
  const nowMs = Number.isFinite(messageTime) ? messageTime : timestampNow;
  const offset = Number.isFinite(options.timeZoneOffsetMinutes)
    ? options.timeZoneOffsetMinutes
    : -new Date(nowMs).getTimezoneOffset();
  const parsedTime = extractDropTime(text, { nowMs, timeZoneOffsetMinutes: offset });
  const url = text.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;]+$/, '');
  const quantity = extractQuantity(text);
  const time = new Date(parsedTime.timeMs).toISOString();
  const seed = message?.id ?? `${site}:${name}:${url ?? ''}:${time}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  return {
    id: `discord-${site}-${hash}`,
    name,
    sites: [site],
    time,
    type: parsedTime.explicit ? 'scheduled' : 'surprise',
    productUrls: url ? { [site]: url } : {},
    ...(quantity === undefined ? {} : { quantity }),
    source: 'discord',
  };
}

export default parseDiscordDrop;
