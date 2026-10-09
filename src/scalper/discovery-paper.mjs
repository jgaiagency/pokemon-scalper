function safeKey(value) {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
}

export function discoveryItemToDrop(item, { detectedAt = Date.now() } = {}) {
  if (!item?.site || !item?.id || !item?.name || !item?.url) throw new Error('Discovery execution requires a complete retailer item');
  const productKey = item.productId ?? item.sku ?? item.tcin ?? item.id;
  return {
    id: `retailer-${safeKey(item.site)}-${safeKey(productKey)}`,
    name: item.name,
    type: 'surprise',
    time: new Date(detectedAt).toISOString(),
    sites: [item.site],
    price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
    purchaseQuantity: 1,
    productUrls: { [item.site]: item.url },
    source: 'retailer-discovery',
    sourceId: item.sourceId,
    retailerProductId: item.id,
    ...(item.sku ? { skus: { [item.site]: String(item.sku) } } : {}),
  };
}

export class DiscoveryPaperExecutor {
  constructor({ env = process.env, calendar, orchestrator, events } = {}) {
    if (!calendar?.upsertDrop) throw new Error('Discovery paper executor requires a calendar');
    if (!orchestrator?.handleDetection) throw new Error('Discovery paper executor requires an orchestrator');
    this.env = env;
    this.calendar = calendar;
    this.orchestrator = orchestrator;
    this.events = events;
  }

  async execute(item, { detectedAt = Date.now() } = {}) {
    if (this.env.SCALPER_LIVE === '1') {
      const error = new Error('Retailer discovery execution is restricted to paper mode');
      error.code = 'SCALPER_DISCOVERY_PAPER_ONLY';
      throw error;
    }
    const drop = discoveryItemToDrop(item, { detectedAt });
    await this.calendar.upsertDrop(drop);
    const result = await this.orchestrator.handleDetection({
      site: item.site,
      drop,
      detectedAt,
      amount: drop.price,
      discoverySource: item.sourceId,
    });
    await this.events?.record?.('discovery-execution', {
      source: item.sourceId,
      site: item.site,
      product: drop.id,
      status: result?.status ?? 'unknown',
      taskId: result?.taskId,
    });
    return { status: result?.status ?? 'unknown', dropId: drop.id, taskId: result?.taskId };
  }
}

export function createDiscoveryPaperExecutor(options) {
  const executor = new DiscoveryPaperExecutor(options);
  return (item, context) => executor.execute(item, context);
}
