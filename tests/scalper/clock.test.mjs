import test from 'node:test';
import assert from 'node:assert/strict';
import { NTP_SOURCES, SynchronizedClock } from '../../src/scalper/clock.mjs';

test('sync chooses the lowest-latency NTP sample and advances monotonically', async () => {
  let monotonic = 10_000;
  const samples = {
    'pool.ntp.org': { offsetMs: 42, roundTripMs: 30 },
    'time.apple.com': { offsetMs: 25, roundTripMs: 5 },
    'time.cloudflare.com': { offsetMs: 31, roundTripMs: 15 },
  };
  const clock = new SynchronizedClock({
    transport: { query: async (source) => samples[source] },
    wallNow: () => 1_000_000,
    monotonicNow: () => monotonic,
  });

  const stats = await clock.syncOnce();
  assert.deepEqual(NTP_SOURCES, Object.keys(samples));
  assert.equal(clock.driftMs(), 25);
  assert.equal(stats.source, 'time.apple.com');
  const first = clock.now();
  monotonic += 12;
  assert.equal(clock.now(), first + 12);
});

test('sync alerts when absolute clock drift exceeds 100 ms', async () => {
  const alerts = [];
  const clock = new SynchronizedClock({
    transport: { query: async () => ({ offsetMs: -125, roundTripMs: 1 }) },
    alert: async (event) => alerts.push(event),
    logger: { warn() {} },
  });
  await clock.syncOnce();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'clock-drift');
});
