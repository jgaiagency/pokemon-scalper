import { DropCalendar } from './drop-calendar.mjs';

export const OFFICIAL_SOURCES = Object.freeze([
  { id: 'pokemon-news', site: 'pokemon-center', url: 'https://www.pokemon.com/us/pokemon-news' },
  { id: 'pokemon-center', site: 'pokemon-center', url: 'https://www.pokemoncenter.com/category/new-releases' },
  { id: 'tcgplayer-coming-soon', site: 'tcgplayer', url: 'https://www.tcgplayer.com/categories/trading-and-collectible-card-games/pokemon' },
]);

export class DropScraper {
  #sources;
  #http;
  #parsers;
  #calendar;

  constructor({ sources = OFFICIAL_SOURCES, http, parsers = {}, calendar = new DropCalendar() } = {}) {
    this.#sources = [...sources];
    this.#http = http;
    this.#parsers = parsers;
    this.#calendar = calendar;
  }

  async scrape() {
    if (!this.#http?.get) throw new Error('DropScraper requires an injected HTTP transport');
    const result = { sources: this.#sources.length, discovered: 0, added: 0, errors: [] };
    for (const source of this.#sources) {
      try {
        const body = await this.#http.get(source.url, { source });
        const parser = this.#parsers[source.id];
        if (typeof parser !== 'function') {
          result.errors.push({ source: source.id, error: 'parser-not-configured' });
          continue;
        }
        const drops = await parser(body, source);
        result.discovered += drops.length;
        for (const candidate of drops) {
          await this.#calendar.upsertDrop({ ...candidate, source: source.id });
          result.added += 1;
        }
      } catch (error) {
        result.errors.push({ source: source.id, error: error.message });
      }
    }
    return result;
  }
}

export function createDropScraper(options) {
  return new DropScraper(options);
}
