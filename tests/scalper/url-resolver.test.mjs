import test from 'node:test';
import assert from 'node:assert/strict';
import { createUrlResolver, createResolvingParser } from '../../src/scalper/url-resolver.mjs';

test('short-link resolver follows once, caches the destination, and ignores ordinary URLs', async () => {
  const calls = [];
  const resolver = createUrlResolver({
    http: { request: async (input) => { calls.push(input); return { status: 302, headers: { location: 'https://www.target.com/p/item/-/A-123' } }; } },
    now: () => 100,
    signalFactory: () => undefined,
  });
  assert.equal(await resolver.resolve('https://buff.ly/abc'), 'https://www.target.com/p/item/-/A-123');
  assert.equal(await resolver.resolve('https://buff.ly/abc'), 'https://www.target.com/p/item/-/A-123');
  assert.equal(await resolver.resolve('https://www.pokemoncenter.com/product/x'), 'https://www.pokemoncenter.com/product/x');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'HEAD', url: 'https://buff.ly/abc', redirect: 'manual' });
});

test('short-link resolver unwraps Restockd howl.link destinations without a request', async () => {
  let calls = 0;
  const resolver = createUrlResolver({ http: { request: async () => { calls += 1; } } });
  const value = 'https://howl.link/link/?url=https%3A%2F%2Fwww.target.com%2Fp%2F-%2FA-1011407490&publisher_slug=restockdping';
  assert.equal(await resolver.resolve(value), 'https://www.target.com/p/-/A-1011407490');
  assert.equal(calls, 0);
});

test('resolving parser updates signal and generated drops without losing a failed short URL', async () => {
  const parser = createResolvingParser({
    parser: async () => ({
      signal: { kind: 'restock', site: 'target', name: 'ETB', at: '2026-10-01T12:00:00Z', url: 'https://buff.ly/x', messageId: 'm1' },
      rank: 40,
    }),
    resolver: { resolve: async () => 'https://target.example/item' },
  });
  const parsed = await parser({});
  assert.equal(parsed.signal.url, 'https://target.example/item');
  assert.equal(parsed.drops[0].productUrls.target, 'https://target.example/item');

  const fallback = createUrlResolver({ http: { request: async () => { throw new Error('offline'); } }, logger: { warn() {} } });
  assert.equal(await fallback.resolve('https://amzn.to/x'), 'https://amzn.to/x');
});

test('resolving parser applies eligibility policy after URL resolution', async () => {
  let observed;
  const parser = createResolvingParser({
    parser: async () => ({
      signal: { kind: 'restock', site: 'target', name: 'ETB', at: '2026-10-01T12:00:00Z', url: 'https://buff.ly/x' },
      rank: 40,
    }),
    resolver: { resolve: async () => 'https://www.target.com/p/item' },
    policy: (parsed) => { observed = parsed.signal.url; return parsed; },
  });
  await parser({});
  assert.equal(observed, 'https://www.target.com/p/item');
});

test('short-link resolution never follows a redirect into a local or insecure destination', async () => {
  const calls = [];
  const resolver = createUrlResolver({
    http: { request: async (input) => {
      calls.push(input);
      return { status: 302, headers: { location: 'http://127.0.0.1:4317/api/status' } };
    } },
    logger: { warn() {} },
    signalFactory: () => undefined,
  });
  assert.equal(await resolver.resolve('https://buff.ly/hostile'), 'https://buff.ly/hostile');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');

  const embedded = createUrlResolver({ http: { request: async () => { throw new Error('must not reach local destination'); } }, logger: { warn() {} } });
  const unsafe = 'https://howl.link/link/?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data';
  assert.equal(await embedded.resolve(unsafe), unsafe);
});

test('short-link resolution follows only allowlisted shortener hops and never fetches the retailer', async () => {
  const calls = [];
  const resolver = createUrlResolver({
    http: { request: async (input) => {
      calls.push(input.url);
      if (input.url === 'https://buff.ly/nested') return { status: 302, headers: { location: 'https://amzn.to/final' } };
      return { status: 302, headers: { location: 'https://www.target.com/p/item' } };
    } },
    signalFactory: () => undefined,
  });
  assert.equal(await resolver.resolve('https://buff.ly/nested'), 'https://www.target.com/p/item');
  assert.deepEqual(calls, ['https://buff.ly/nested', 'https://amzn.to/final']);
});
