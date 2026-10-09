import test from 'node:test';
import assert from 'node:assert/strict';
import { DropScraper } from '../../src/scalper/drop-scraper.mjs';

test('scraper uses injected HTTP and parser seams and upserts official-source drops', async () => {
  const seen = [];
  const upserts = [];
  const scraper = new DropScraper({
    sources: [{ id: 'pokemon-news', url: 'https://example.test/news', site: 'pokemon-center' }],
    http: { get: async (url) => { seen.push(url); return '<html>fixture</html>'; } },
    parsers: { 'pokemon-news': async () => [{ id: 'drop-1', name: 'Booster', sites: ['pokemon-center'], time: '2026-10-02T14:00:00Z', type: 'scheduled' }] },
    calendar: { upsertDrop: async (drop) => upserts.push(drop) },
  });
  const result = await scraper.scrape();
  assert.deepEqual(seen, ['https://example.test/news']);
  assert.equal(result.added, 1);
  assert.equal(upserts[0].source, 'pokemon-news');
});

test('scraper does not create a drop when a source has no matching release', async () => {
  let wrote = false;
  const scraper = new DropScraper({
    sources: [{ id: 'target-notify', url: 'https://example.test/target' }],
    http: { get: async () => 'out of stock' }, parsers: { 'target-notify': async () => [] },
    calendar: { upsertDrop: async () => { wrote = true; } },
  });
  assert.deepEqual(await scraper.scrape(), { sources: 1, discovered: 0, added: 0, errors: [] });
  assert.equal(wrote, false);
});
