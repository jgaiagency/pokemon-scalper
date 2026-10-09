import test from 'node:test';
import assert from 'node:assert/strict';
import { attestCart } from '../../src/scalper/attestation.mjs';

const address = { line1: '1 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' };
const expected = {
  sku: 'SKU-1', skus: ['SKU-1'], productId: 'P-1', seller: 'Pokémon Center', quantity: 1,
  maxTotalCents: 7_000, shippingExpected: true, taxExpected: true,
  address, fulfillment: 'shipping',
};
const perfect = {
  items: [{ sku: 'SKU-1', productId: 'P-1', seller: 'Pokémon Center', quantity: 1 }],
  totalCents: 6_499, shippingCents: 500, taxCents: 400,
  address, fulfillment: 'shipping',
};

test('a perfect cart passes attestation', () => {
  assert.deepEqual(attestCart(perfect, expected), { ok: true, defects: [] });
});

for (const [name, mutate] of [
  ['sku', (cart) => { cart.items[0].sku = 'WRONG'; }],
  ['product', (cart) => { cart.items[0].productId = 'WRONG'; }],
  ['seller', (cart) => { cart.items[0].seller = 'Marketplace'; }],
  ['quantity', (cart) => { cart.items[0].quantity = 2; }],
  ['total', (cart) => { cart.totalCents = 7_001; }],
  ['shipping', (cart) => { cart.shippingCents = 0; }],
  ['tax', (cart) => { delete cart.taxCents; }],
  ['address', (cart) => { cart.address.postalCode = '00000'; }],
  ['fulfillment', (cart) => { cart.fulfillment = 'pickup'; }],
  ['stale-items', (cart) => { cart.items.push({ sku: 'STALE', productId: 'OTHER', quantity: 1 }); }],
]) {
  test(`cart attestation reports ${name}`, () => {
    const cart = structuredClone(perfect);
    mutate(cart);
    const result = attestCart(cart, expected);
    assert.equal(result.ok, false);
    assert.ok(result.defects.some((defect) => defect.name === name));
  });
}
