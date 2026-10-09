function endpointUnmeasured(operation) {
  const error = new Error(`Pokémon Center ${operation} endpoint has not been measured`);
  error.code = 'SCALPER_ENDPOINT_UNMEASURED';
  error.operation = operation;
  return error;
}

function requireEndpoint(endpoints, operation) {
  const endpoint = endpoints?.[operation];
  if (!endpoint) throw endpointUnmeasured(operation);
  return endpoint;
}

export function createPokemonCenterApi({ http, endpoints = {} } = {}) {
  if (!http?.request) throw new Error('Pokémon Center API adapter requires an HTTP client');

  async function request(operation, input) {
    // TODO(measure): record the official first-party request contract before configuring this endpoint.
    const endpoint = requireEndpoint(endpoints, operation);
    return http.request({ ...endpoint, input, operation, site: 'pokemon-center' });
  }

  return {
    checkAvailability: (input) => request('checkAvailability', input),
    addToCart: (input) => request('addToCart', input),
    getCart: (input) => request('getCart', input),
    submitOrder: (input) => request('submitOrder', input),
    getOrder: (input) => request('getOrder', input),
  };
}

export function createMockPokemonCenterApi({
  available = true,
  sku = 'PC-SKU-1',
  productId = 'p1',
  seller = 'Pokémon Center',
  priceCents = 5_999,
  shippingCents = 500,
  taxCents = 400,
  address = { line1: '1 Main St', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' },
  fulfillment = 'shipping',
  orderId = 'pc-order-1',
} = {}) {
  const carts = new Map();
  const orders = new Map();
  let cartSequence = 0;

  return {
    async checkAvailability() {
      return { available, quantity: available ? 5 : 0, priceCents, sku, seller };
    },
    async addToCart({ product } = {}) {
      if (!available) {
        const error = new Error('Pokémon Center item is unavailable');
        error.code = 'SCALPER_ITEM_UNAVAILABLE';
        throw error;
      }
      const cartId = `pc-cart-${++cartSequence}`;
      const quantity = product?.purchaseQuantity ?? 1;
      carts.set(cartId, {
        cartId,
        items: [{ sku: product?.sku ?? sku, productId: product?.id ?? productId, seller: product?.seller ?? seller, quantity }],
        totalCents: priceCents + shippingCents + taxCents,
        shippingCents,
        taxCents,
        address: product?.address ?? address,
        fulfillment: product?.fulfillment ?? fulfillment,
      });
      return { cartId };
    },
    async getCart({ cartId } = {}) {
      return carts.has(cartId) ? structuredClone(carts.get(cartId)) : null;
    },
    async submitOrder({ cartId, cart } = {}) {
      const resolvedCartId = cartId ?? cart?.cartId;
      const resolvedCart = carts.get(resolvedCartId);
      if (!resolvedCart) throw new Error('Pokémon Center mock cart was not found');
      const order = { orderId, status: 'confirmed', items: structuredClone(resolvedCart.items), totalCents: resolvedCart.totalCents };
      orders.set(orderId, order);
      return structuredClone(order);
    },
    async getOrder({ orderId: requestedOrderId } = {}) {
      return orders.has(requestedOrderId) ? structuredClone(orders.get(requestedOrderId)) : null;
    },
  };
}
