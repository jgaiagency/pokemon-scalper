import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPokemonCenterApi, createPokemonCenterApi } from '../../../src/scalper/sites/pokemon-center/api.mjs';

test('Pokémon Center mock exposes realistic in-stock cart and order responses', async () => {
  const api = createMockPokemonCenterApi();
  const available = await api.checkAvailability({ product: { id: 'p1' } });
  assert.deepEqual(available, { available: true, quantity: 5, priceCents: 5999, sku: 'PC-SKU-1', seller: 'Pokémon Center' });
  const cart = await api.addToCart({ product: { id: 'p1' } });
  assert.equal((await api.getCart({ cartId: cart.cartId })).items[0].sku, 'PC-SKU-1');
  assert.equal((await api.submitOrder({ cartId: cart.cartId })).orderId, 'pc-order-1');
  assert.equal((await api.getOrder({ orderId: 'pc-order-1' })).status, 'confirmed');
});

test('Pokémon Center mock keeps out-of-stock responses distinct from transport errors', async () => {
  const api = createMockPokemonCenterApi({ available: false });
  assert.deepEqual(await api.checkAvailability({ product: { id: 'p1' } }), {
    available: false, quantity: 0, priceCents: 5999, sku: 'PC-SKU-1', seller: 'Pokémon Center',
  });
  await assert.rejects(api.addToCart({ product: { id: 'p1' } }), (error) => error.code === 'SCALPER_ITEM_UNAVAILABLE');
});

test('real Pokémon Center adapter fails closed while measured endpoints are absent', async () => {
  const api = createPokemonCenterApi({ http: { request: async () => { throw new Error('network should not run'); } } });
  await assert.rejects(api.checkAvailability({ product: { id: 'p1' } }), (error) => error.code === 'SCALPER_ENDPOINT_UNMEASURED');
});
