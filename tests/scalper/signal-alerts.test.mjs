import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalAlertHandler } from '../../src/scalper/signal-alerts.mjs';

test('signal alert threshold pages high ranks and records low ranks without paging', async () => {
  const sent = [];
  const counts = [];
  const handler = createSignalAlertHandler({
    minRank: 50,
    alerts: { dropDetected: async (details) => { sent.push(details); return { delivered: true }; } },
    metrics: { increment: (name, labels) => counts.push({ name, labels }) },
  });
  assert.deepEqual(await handler({ site: 'amazon' }, 20), { delivered: false, reason: 'below-rank-threshold', rank: 20, minRank: 50 });
  await handler({ site: 'target' }, 70);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].signal.site, 'target');
  assert.deepEqual(counts.map((item) => item.labels.outcome), ['suppressed', 'paged']);
});
