import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransport } from '../../../src/scalper/transports/http.mjs';

test('HTTP GET returns status, normalized headers, and a string body', async () => {
  const calls = [];
  const http = createHttpTransport({ fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response('hello', { status: 200, headers: { 'x-test': 'yes', 'content-type': 'text/plain' } });
  } });
  const response = await http.get('https://example.test/item', { headers: { Accept: 'text/plain' } });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Accept, 'text/plain');
  assert.deepEqual(response, { status: 200, headers: { 'content-type': 'text/plain', 'x-test': 'yes' }, body: 'hello' });
});

test('HTTP POST serializes JSON and parses a JSON response', async () => {
  let captured;
  const http = createHttpTransport({ fetch: async (url, init) => {
    captured = { url, init };
    return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json; charset=utf-8' } });
  } });
  const response = await http.postJson('https://example.test/orders', { sku: 'p1' }, { headers: { Authorization: 'token' } });
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers.Authorization, 'token');
  assert.equal(captured.init.body, '{"sku":"p1"}');
  assert.deepEqual(response.bodyJson, { ok: true });
});

test('HTTP request propagates abort errors from fetch', async () => {
  const controller = new AbortController();
  controller.abort(new Error('operator cancelled'));
  const http = createHttpTransport({ fetch: async (_url, { signal }) => {
    if (signal.aborted) throw signal.reason;
  } });
  await assert.rejects(http.get('https://example.test', { signal: controller.signal }), /operator cancelled/);
});

test('HTTP leaves non-JSON responses as text and returns error statuses without throwing', async (t) => {
  await t.test('non-JSON', async () => {
    const http = createHttpTransport({ fetch: async () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    const response = await http.get('https://example.test');
    assert.equal(response.body, '<html>no</html>');
    assert.equal('bodyJson' in response, false);
  });
  await t.test('error status', async () => {
    const http = createHttpTransport({ fetch: async () => new Response('missing', { status: 404 }) });
    const response = await http.request({ method: 'GET', url: 'https://example.test/missing' });
    assert.equal(response.status, 404);
    assert.equal(response.body, 'missing');
  });
});
