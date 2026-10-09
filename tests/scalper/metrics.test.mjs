import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../../src/scalper/metrics.mjs';

test('metrics registry emits stable labeled counters and latency summaries', () => {
  const metrics = new MetricsRegistry({ now: () => 123 });
  metrics.increment('discord_messages', { outcome: 'matched', site: 'target' });
  metrics.increment('discord_messages', { site: 'target', outcome: 'matched' }, 2);
  metrics.observe('detection_latency_ms', 25, { site: 'target' });
  metrics.observe('detection_latency_ms', 75, { site: 'target' });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.timestamp, 123);
  assert.equal(snapshot.counters[0].value, 3);
  assert.deepEqual(snapshot.histograms[0], {
    name: 'detection_latency_ms', labels: { site: 'target' }, count: 2, sum: 100, min: 25, max: 75, average: 50,
  });
});
