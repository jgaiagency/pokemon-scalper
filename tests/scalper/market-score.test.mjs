import test from 'node:test';
import assert from 'node:assert/strict';
import { rankProducts, scoreProduct } from '../../src/scalper/market-score.mjs';

const defaults = {
  acquisitionTaxRate: 0.08,
  sellingFeeRate: 0.13,
  paymentFeeFlat: 0.30,
  outboundShipping: 8,
  minProfit: 10,
  minRoi: 0.15,
  minConfidence: 0.5,
};

test('market scoring accounts for acquisition tax, selling fees, fixed fees, and shipping', () => {
  const result = scoreProduct({ id: 'etb', name: 'ETB', acquisitionPrice: 50 }, [
    { productId: 'etb', source: 'manual', kind: 'completed-sale', price: 100, at: 1_000, confidence: 0.95, sampleSize: 10 },
  ], defaults);
  assert.equal(result.acquisitionCost, 54);
  assert.equal(result.estimatedNetProceeds, 78.7);
  assert.equal(result.estimatedProfit, 24.7);
  assert.equal(result.eligible, true);
});

test('verified sold comps outrank active asking prices with the same headline margin', () => {
  const products = [
    { id: 'sold', name: 'Sold Product', acquisitionPrice: 50 },
    { id: 'asking', name: 'Asking Product', acquisitionPrice: 50 },
  ];
  const ranked = rankProducts(products, [
    { productId: 'sold', source: 'manual', kind: 'completed-sale', price: 100, at: 1_000, confidence: 0.95, sampleSize: 12 },
    { productId: 'asking', source: 'ebay', kind: 'active-listing', price: 100, at: 1_000, confidence: 0.35, sampleSize: 40 },
  ], defaults);
  assert.equal(ranked[0].id, 'sold');
  assert.equal(ranked[1].eligible, false);
  assert.ok(ranked[1].risks.includes('active-listings-only'));
});

test('products without cost or resale evidence remain unranked rather than receiving invented values', () => {
  const result = scoreProduct({ id: 'unknown', name: 'Unknown' }, [], defaults);
  assert.equal(result.eligible, false);
  assert.equal(result.score, 0);
  assert.ok(result.risks.includes('missing-acquisition-price'));
  assert.ok(result.risks.includes('missing-market-evidence'));
});

test('unreleased presale evidence is discounted and explicitly flagged', () => {
  const result = scoreProduct({
    id: 'future', name: 'Future UPC', acquisitionPrice: 100, releaseDate: '2026-11-06',
  }, [
    { productId: 'future', source: 'tcgplayer', kind: 'market-price', price: 300, at: 1_000, confidence: 0.8, sampleSize: 10 },
  ], defaults, Date.parse('2026-10-01'));
  assert.ok(result.risks.includes('presale-market'));
  assert.equal(result.confidence, 0.6);
});
