import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePokemonCenterOrder } from '../../../src/scalper/sites/pokemon-center/reconcile.mjs';

test('an uncertain submit reconciles to purchased when order history contains the order', async () => {
  const result = await reconcilePokemonCenterOrder({
    api: { getOrder: async () => ({ orderId: 'pc-1', status: 'confirmed', items: [{ sku: 'SKU-1' }], totalCents: 6499 }) },
    orderId: 'pc-1', product: { id: 'p1', sku: 'SKU-1' },
  });
  assert.equal(result.status, 'purchased');
  assert.equal(result.orderId, 'pc-1');
});

test('an uncertain submit reconciles to failed when order history has no matching order', async () => {
  const result = await reconcilePokemonCenterOrder({
    api: { getOrder: async () => null }, orderId: 'missing', product: { id: 'p1', sku: 'SKU-1' },
  });
  assert.deepEqual(result, { status: 'failed', reason: 'order-not-found' });
});
