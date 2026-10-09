import { readFile } from 'node:fs/promises';

// The operator's product watchlist: only signals for these products are worth
// an alert. Rules live in config/scalper-watchlist.json; each product matches
// when every `all` pattern and no `none` pattern hits the normalised name.

export function normalizeProductName(name = '') {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[—–\-:,()/&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^pokemon\s+/, '')
    .replace(/^(?:trading card game|tcg)\s+/, '')
    .replace(/^(?:scarlet violet|sv\s*[\d.]+)\s+/, '');
}

export function createWatchlistMatcher(products = [], { exclude = [] } = {}) {
  const compiled = products.map((product) => ({
    product,
    all: (product.all ?? []).map((p) => new RegExp(p, 'i')),
    none: (product.none ?? []).map((p) => new RegExp(p, 'i')),
  }));
  const excluded = exclude.map((p) => new RegExp(p, 'i'));
  return (name) => {
    const text = normalizeProductName(name);
    if (!text || excluded.some((re) => re.test(text))) return null;
    return compiled.find(({ all, none }) => all.length && all.every((re) => re.test(text)) && !none.some((re) => re.test(text)))?.product ?? null;
  };
}

export async function loadWatchlist({ path = 'config/scalper-watchlist.json', read = readFile } = {}) {
  const config = JSON.parse(await read(path, 'utf8'));
  return { ...config, match: createWatchlistMatcher(config.products, { exclude: config.exclude }) };
}
