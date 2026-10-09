const CONFIRMED_STATUSES = new Set(['confirmed', 'processing', 'placed', 'fulfilled', 'shipped', 'delivered']);

export async function reconcilePokemonCenterOrder({ api, account, session, orderId, product } = {}) {
  if (!api?.getOrder) throw new Error('Pokémon Center reconciliation requires getOrder');
  const order = await api.getOrder({ account, session, orderId, product });
  if (!order) return { status: 'failed', reason: 'order-not-found' };
  if (!CONFIRMED_STATUSES.has(String(order.status ?? '').toLocaleLowerCase())) {
    return { status: 'uncertain', reason: 'order-not-confirmed', orderId: order.orderId ?? orderId, order };
  }
  return { ...order, status: 'purchased', orderStatus: order.status, orderId: order.orderId ?? orderId };
}
