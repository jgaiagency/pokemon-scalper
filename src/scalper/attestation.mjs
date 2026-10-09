function same(left, right) {
  return String(left ?? '').trim().toLocaleLowerCase() === String(right ?? '').trim().toLocaleLowerCase();
}

function validCents(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function defect(name, expected, actual) {
  return { name, expected, actual };
}

export function attestCart(cart, expected) {
  const defects = [];
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const allowedSkus = new Set((expected?.skus ?? [expected?.sku]).filter(Boolean).map(String));
  const item = items.find((candidate) => same(candidate?.sku, expected?.sku));

  if (!item) defects.push(defect('sku', expected?.sku, items.map((candidate) => candidate?.sku)));
  if (!item || !same(item.productId, expected?.productId)) defects.push(defect('product', expected?.productId, item?.productId));
  if (!item || !same(item.seller, expected?.seller)) defects.push(defect('seller', expected?.seller, item?.seller));
  if (!item || item.quantity !== expected?.quantity) defects.push(defect('quantity', expected?.quantity, item?.quantity));

  if (!validCents(cart?.totalCents) || !validCents(expected?.maxTotalCents) || cart.totalCents > expected.maxTotalCents) {
    defects.push(defect('total', { maximumCents: expected?.maxTotalCents }, cart?.totalCents));
  }
  if (!validCents(cart?.shippingCents) || (expected?.shippingExpected === true && cart.shippingCents <= 0)) {
    defects.push(defect('shipping', expected?.shippingExpected ? 'positive cents' : 'nonnegative cents', cart?.shippingCents));
  }
  if (!validCents(cart?.taxCents) || (expected?.taxExpected === true && cart.taxCents <= 0)) {
    defects.push(defect('tax', expected?.taxExpected ? 'positive cents' : 'nonnegative cents', cart?.taxCents));
  }

  const addressFields = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'];
  if (!expected?.address || addressFields.some((field) => expected.address[field] != null && !same(cart?.address?.[field], expected.address[field]))) {
    defects.push(defect('address', expected?.address, cart?.address));
  }
  if (!same(cart?.fulfillment, expected?.fulfillment)) {
    defects.push(defect('fulfillment', expected?.fulfillment, cart?.fulfillment));
  }
  if (items.some((candidate) => !allowedSkus.has(String(candidate?.sku)))) {
    defects.push(defect('stale-items', [...allowedSkus], items.map((candidate) => candidate?.sku)));
  }

  return { ok: defects.length === 0, defects };
}
