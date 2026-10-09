import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketObservationStore, MarketTracker } from '../../src/scalper/market-tracker.mjs';
import { memoryStorage } from './helpers.mjs';

test('market tracker captures injectable sources, isolates source failures, and ranks saved evidence', async () => {
  const storage = memoryStorage();
  const store = new MarketObservationStore({ storage, path: '/market.jsonl' });
  const tracker = new MarketTracker({
    config: {
      version: 1,
      defaults: {
        acquisitionTaxRate: 0, sellingFeeRate: 0.1, paymentFeeFlat: 0,
        outboundShipping: 5, minProfit: 5, minRoi: 0.1, minConfidence: 0.5,
      },
      products: [{ id: 'etb', name: 'ETB', acquisitionPrice: 50 }],
    },
    store,
    sources: [
      { id: 'sold', quote: async () => ({ kind: 'completed-sale', price: 100, confidence: 0.9, sampleSize: 8 }) },
      { id: 'broken', quote: async () => { throw new Error('provider down'); } },
    ],
    now: () => 123,
    logger: { warn() {} },
  });
  const capture = await tracker.capture();
  assert.equal(capture.observations.length, 1);
  assert.equal(capture.errors.length, 1);
  assert.equal(capture.observations[0].source, 'sold');
  assert.equal(capture.observations[0].productId, 'etb');
  const ranked = await tracker.rank();
  assert.equal(ranked[0].id, 'etb');
  assert.equal(ranked[0].eligible, true);
});

test('market observation import rejects invalid or non-positive prices', async () => {
  const store = new MarketObservationStore({ storage: memoryStorage(), path: '/market.jsonl' });
  await assert.rejects(store.append({ productId: 'p1', source: 'manual', kind: 'completed-sale', price: 0, at: 1 }), /price/i);
});
