import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CircuitBreaker,
  TokenBucket,
  TrafficGovernor,
  classifyResponse,
  pollWithGovernance,
} from '../../src/scalper/rate-limit.mjs';

test('a per-site token bucket allows N requests in a window and throttles N+1', () => {
  let now = 0;
  const bucket = new TokenBucket({ ratePerSecond: 2, capacity: 2, now: () => now });
  assert.equal(bucket.tryTake().allowed, true);
  assert.equal(bucket.tryTake().allowed, true);
  assert.deepEqual(bucket.tryTake(), { allowed: false, retryAfterMs: 500 });
  now = 500;
  assert.equal(bucket.tryTake().allowed, true);
});

test('Retry-After is honored before another site request may run', async () => {
  let now = 0;
  let calls = 0;
  const governor = new TrafficGovernor({
    policies: { target: { maxRequestsPerSecond: 100 } }, now: () => now,
    baseBackoffMs: 100, timeoutSignal: () => undefined,
  });
  await assert.rejects(governor.request('target', async () => {
    calls += 1;
    return { status: 429, headers: { 'retry-after': '2' } };
  }), (error) => error.code === 'SCALPER_THROTTLED' && error.retryAfterMs === 2_000);
  await assert.rejects(governor.request('target', async () => { calls += 1; }), (error) => error.code === 'SCALPER_BACKOFF' && error.retryAfterMs === 2_000);
  now = 2_000;
  assert.equal((await governor.request('target', async () => { calls += 1; return { status: 200 }; })).status, 200);
  assert.equal(calls, 2);
});

test('the circuit opens after consecutive 5xx responses and a successful half-open probe closes it', async () => {
  let now = 0;
  const governor = new TrafficGovernor({
    policies: { bestbuy: { maxRequestsPerSecond: 100 } }, now: () => now,
    baseBackoffMs: 1, maxBackoffMs: 4, failureThreshold: 3, cooldownMs: 100,
    timeoutSignal: () => undefined,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let caught;
    try { await governor.request('bestbuy', async () => ({ status: 500, headers: {} })); } catch (error) { caught = error; }
    assert.equal(caught.code, 'SCALPER_SERVER_ERROR');
    now += caught.retryAfterMs;
  }
  await assert.rejects(governor.request('bestbuy', async () => ({ status: 200 })), (error) => error.code === 'SCALPER_CIRCUIT_OPEN');
  now += 100;
  assert.equal((await governor.request('bestbuy', async () => ({ status: 200 }))).status, 200);
});

test('CircuitBreaker admits one half-open probe after cooldown', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, now: () => now });
  breaker.failure();
  assert.equal(breaker.allow().allowed, false);
  now = 50;
  assert.deepEqual(breaker.allow(), { allowed: true, state: 'half-open', retryAfterMs: 0 });
  assert.equal(breaker.allow().allowed, false);
  breaker.success();
  assert.equal(breaker.allow().state, 'closed');
});

test('hard timeout failures are distinct from out-of-stock responses', async () => {
  const governor = new TrafficGovernor({
    policies: { target: { maxRequestsPerSecond: 1 } },
    timeoutSignal: () => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
  });
  await assert.rejects(governor.request('target', async (signal) => { throw signal.reason; }), (error) => error.code === 'SCALPER_POLL_TIMEOUT');
  assert.equal(classifyResponse({ status: 200, bodyJson: { available: false } }), 'ok');
});

test('a surprise watcher expires instead of reporting missed and 200 unavailable is not throttled', async () => {
  let now = 0;
  const result = await pollWithGovernance({
    request: async () => ({ status: 200, bodyJson: { available: false } }),
    isAvailable: (response) => response.bodyJson.available,
    delayMs: () => 50,
    clock: { now: () => now },
    sleep: async (ms) => { now += ms; },
    maxDurationMs: 100,
  });
  assert.equal(result.status, 'expired');
  assert.equal(result.reason, 'watcher-expired');
  assert.equal(result.polls, 2);
});

test('a throttled response cannot be classified as not in stock', async () => {
  const error = Object.assign(new Error('429'), {
    code: 'SCALPER_THROTTLED', classification: 'throttled', retryAfterMs: 1,
  });
  const result = await pollWithGovernance({
    request: async () => { throw error; }, isAvailable: () => false, delayMs: () => 1,
    sleep: async () => {}, maxPolls: 1,
  });
  assert.equal(result.status, 'throttled');
  assert.notEqual(result.status, 'not-in-stock');
});

test('a retailer redirect is validated before its destination is fetched', async () => {
  const calls = [];
  const governor = new TrafficGovernor({
    policies: { target: { maxRequestsPerSecond: 10 } }, timeoutSignal: () => undefined,
  });
  const http = governor.httpFor('target', {
    get: async (url) => {
      calls.push(url);
      return { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } };
    },
  });
  await assert.rejects(http.get('https://www.target.com/p/item'), (error) => error.code === 'SCALPER_UNSAFE_REDIRECT');
  assert.deepEqual(calls, ['https://www.target.com/p/item']);
});

test('an initial non-retailer URL is rejected before any GET or POST request', async () => {
  let calls = 0;
  const governor = new TrafficGovernor({
    policies: { target: { maxRequestsPerSecond: 10 } }, timeoutSignal: () => undefined,
  });
  const http = governor.httpFor('target', {
    get: async () => { calls += 1; return { status: 200 }; },
    request: async () => { calls += 1; return { status: 200 }; },
  });
  await assert.rejects(http.get('https://target.com.evil.example/item'), (error) => error.code === 'SCALPER_UNSAFE_URL');
  await assert.rejects(http.postJson('https://169.254.169.254/order', {}), (error) => error.code === 'SCALPER_UNSAFE_URL');
  assert.equal(calls, 0);
});

test('a mutating endpoint redirect is never followed implicitly', async () => {
  const calls = [];
  const governor = new TrafficGovernor({
    policies: { target: { maxRequestsPerSecond: 10 } }, timeoutSignal: () => undefined,
  });
  const http = governor.httpFor('target', {
    request: async (input) => {
      calls.push(input);
      return { status: 307, headers: { location: 'https://www.target.com/api/new-order' } };
    },
  });
  await assert.rejects(http.postJson('https://www.target.com/api/order', { sku: 'x' }), (error) => error.code === 'SCALPER_REDIRECT_REMEASURE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');
});
