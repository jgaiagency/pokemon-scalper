import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScalperDatabase } from '../../src/scalper/db.mjs';
import { createStateStore } from '../../src/scalper/state-store.mjs';
import { importProductEndpoints } from '../../src/scalper/product-endpoints.mjs';

test('measured endpoint config imports its rich response contract into SQLite', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'product-endpoints-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'endpoints.json');
  await writeFile(path, JSON.stringify({ version: 1, endpoints: [{
    productId: 'pc-etb', site: 'pokemon-center', pollUrl: 'https://www.pokemoncenter.com/api/measured', measuredAt: 100,
    metadata: { contract: { availableWhen: [{ path: 'availability', equals: 'IN_STOCK' }] } },
  }] }));
  const database = openScalperDatabase({ path: ':memory:' });
  const state = createStateStore({ database });
  try {
    assert.equal((await importProductEndpoints({ store: state.productEndpoints, path })).imported, 1);
    assert.equal((await state.productEndpoints.get('pc-etb', 'pokemon-center')).metadata.contract.availableWhen[0].path, 'availability');
  } finally {
    database.close();
  }
});
