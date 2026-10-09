import { isLiveMode } from '../../dry-run.mjs';
import { attestCart } from '../../attestation.mjs';
import { config } from './config.mjs';

function expectedCart(product, account) {
  const siteSkus = product?.skus?.['pokemon-center'];
  const skus = Array.isArray(siteSkus)
    ? siteSkus
    : [product?.sku ?? siteSkus].filter(Boolean);
  return {
    sku: product?.sku ?? skus[0],
    skus,
    productId: product?.productId ?? product?.id,
    seller: product?.seller ?? 'Pokémon Center',
    quantity: product?.purchaseQuantity ?? 1,
    maxTotalCents: product?.maxTotalCents,
    shippingExpected: product?.shippingExpected,
    taxExpected: product?.taxExpected,
    address: account?.address,
    fulfillment: product?.fulfillment ?? 'shipping',
  };
}

export async function checkoutProduct({ product, account, session, amount, detectedAt, env = process.env, dryRun, api, browser, taskId, onProgress, beforeCommit } = {}) {
  const live = isLiveMode(env);
  if (!live) {
    if (!dryRun?.execute) throw new Error('Paper checkout requires the dry-run harness');
    return dryRun.execute({ site: config.id, product, account, amount, detectedAt });
  }
  let cartError;
  if (api?.addToCart && api?.getCart && api?.submitOrder) {
    let cart;
    let cartReady = false;
    try {
      cart = await api.addToCart({ product, account, session });
      cartReady = true;
    } catch (error) {
      cartError = error;
    }
    if (cartReady) {
      const cartId = cart?.cartId ?? cart?.id;
      const fetchedCart = await api.getCart({ product, account, session, cartId });
      const attestation = attestCart(fetchedCart, expectedCart(product, account));
      if (!attestation.ok) return { status: 'safety-blocked', reason: 'cart-attestation', defects: attestation.defects };
      await beforeCommit?.({ transport: 'api' });
      await onProgress?.({ state: 'submitting', transport: 'api' });
      try {
        const result = await api.submitOrder({ product, account, session, cart: fetchedCart, cartId });
        if (!result?.orderId) throw new Error('Pokémon Center submitOrder returned no order ID');
        return { ...result, source: 'api' };
      } catch (cause) {
        const error = new Error('The API order submission result is uncertain; browser fallback is disabled');
        error.code = 'SCALPER_ORDER_STATUS_UNCERTAIN';
        error.cause = cause;
        throw error;
      }
    }
  }
  if (!browser?.checkout) throw new AggregateError(cartError ? [cartError] : [], 'No measured Pokémon Center checkout adapter is configured');
  return { ...await browser.checkout({ site: config.id, live: true, product, account, session, taskId, onProgress, beforeCommit, ...config.browser }), source: 'browser-fallback' };
}

export function createCheckout(dependencies) {
  return (input) => checkoutProduct({ ...dependencies, ...input });
}
