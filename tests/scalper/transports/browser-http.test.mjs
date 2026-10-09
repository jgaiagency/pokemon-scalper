import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHttpTransport } from '../../../src/scalper/transports/browser-http.mjs';

function responseFor(url, {
  status = 200,
  contentType = 'application/json',
  body = '{"ok":true}',
} = {}) {
  return {
    status: () => status,
    headers: () => ({ 'content-type': contentType, 'x-test': 'yes' }),
    text: async () => body,
    url: () => url,
  };
}

function harness({ response, pages = [] } = {}) {
  const calls = [];
  const page = {
    goto: async (...args) => calls.push(['goto', ...args]),
    content: async () => '<html>ready</html>',
  };
  const context = {
    request: {
      fetch: async (url, options) => {
        calls.push(['fetch', url, options]);
        return response ?? responseFor(url);
      },
    },
    pages: () => pages,
    newPage: async () => { calls.push(['newPage']); return page; },
  };
  return { context, page, calls };
}

test('browser HTTP transport requires a Playwright context request API', () => {
  assert.throws(() => createBrowserHttpTransport({ context: {} }), /request API/);
  assert.throws(() => createBrowserHttpTransport({ context: { request: {}, pages: () => [] } }), /request API/);
});

test('browser HTTP GET calls Playwright APIResponse methods and returns the normalized response', async () => {
  const url = 'https://www.bestbuy.com/product/example';
  let methodCalls = 0;
  const h = harness({ response: {
    status: () => { methodCalls += 1; return 200; },
    headers: () => { methodCalls += 1; return { 'content-type': 'application/json' }; },
    text: async () => { methodCalls += 1; return '{"available":true}'; },
    url: () => { methodCalls += 1; return url; },
  } });
  const result = await createBrowserHttpTransport({ context: h.context, warmUp: false }).get(url, { redirect: 'manual' });

  assert.equal(methodCalls, 4, 'regression: status/text/headers/url must be invoked as APIResponse methods');
  assert.equal(h.calls[0][0], 'fetch');
  assert.equal(h.calls[0][1], url);
  assert.equal(h.calls[0][2].method, 'GET');
  assert.equal(h.calls[0][2].maxRedirects, 0, 'manual redirect policy must survive the browser transport');
  assert.deepEqual(result, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"available":true}',
    url,
    bodyJson: { available: true },
  });
});

test('browser HTTP POST sends a JSON content type and JSON-stringified Playwright data', async () => {
  const h = harness();
  await createBrowserHttpTransport({ context: h.context, warmUp: false })
    .postJson('https://www.pokemoncenter.com/api/cart', { sku: '10-10438-112' }, { headers: { 'x-test': 'keep' } });
  const options = h.calls[0][2];
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['x-test'], 'keep');
  assert.equal(options.data, '{"sku":"10-10438-112"}');
  assert.equal(Object.hasOwn(options, 'body'), false);
});

test('browser HTTP extracts a Product JSON-LD object from an HTML response', async () => {
  const url = 'https://www.bestbuy.com/product/example';
  const product = { '@context': 'https://schema.org', '@type': 'Product', sku: '12861077', offers: [{ availability: 'https://schema.org/InStock' }] };
  const html = `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'BreadcrumbList' })}</script><script type="application/ld+json">${JSON.stringify(product)}</script></html>`;
  const h = harness({ response: responseFor(url, { contentType: 'text/html; charset=utf-8', body: html }) });
  const result = await createBrowserHttpTransport({ context: h.context, warmUp: false }).get(url);
  assert.deepEqual(result.bodyJson, product);
});

test('browser HTTP warm-up can be disabled without opening or navigating a page', async () => {
  const h = harness();
  await createBrowserHttpTransport({ context: h.context, warmUrl: 'https://www.pokemoncenter.com/', warmUp: false }).warm();
  assert.deepEqual(h.calls, []);
});

test('browser HTTP warm-up waits until challenge markers leave a newly-created page', async () => {
  const h = harness({ pages: [] });
  const contents = [
    '<iframe src="/_Incapsula_Resource?challenge=1"></iframe>',
    '<html><body>Pokémon Center</body></html>',
  ];
  h.page.content = async () => contents.shift() ?? '<html>ready</html>';
  const sleeps = [];
  const transport = createBrowserHttpTransport({
    context: h.context,
    warmUrl: 'https://www.pokemoncenter.com/',
    waitForChallenge: true,
    sleep: async (ms) => sleeps.push(ms),
  });
  await transport.warm();

  assert.equal(h.calls.filter(([name]) => name === 'newPage').length, 1);
  assert.deepEqual(h.calls.find(([name]) => name === 'goto').slice(1), [
    'https://www.pokemoncenter.com/',
    { waitUntil: 'domcontentloaded', timeout: 60_000 },
  ]);
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.equal(contents.length, 0);
});
