import { readFile } from 'node:fs/promises';

export async function importProductEndpoints({
  store,
  path = process.env.SCALPER_PRODUCT_ENDPOINTS_PATH || 'config/scalper-product-endpoints.json',
} = {}) {
  if (!store?.set) throw new Error('Product endpoint import requires a store');
  let document;
  try { document = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return { imported: 0, path, missing: true };
    throw error;
  }
  if (document?.version !== 1 || !Array.isArray(document.endpoints)) {
    throw new Error('Product endpoints config must contain version 1 and an endpoints array');
  }
  for (const endpoint of document.endpoints) await store.set(endpoint);
  return { imported: document.endpoints.length, path, missing: false };
}
