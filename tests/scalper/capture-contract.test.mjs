import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContract } from '../../src/scalper/capture-contract.mjs';

function fakePlaywright(body) {
  const listeners = new Map();
  const page = {
    on(name, listener) { listeners.set(name, listener); },
    async goto() {
      await listeners.get('response')?.({
        url: () => 'https://www.pokemoncenter.com/api/availability',
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        json: async () => body,
      });
    },
  };
  const context = { pages: () => [page], close: async () => {} };
  return { chromium: { launchPersistentContext: async () => context } };
}

test('contract capture writes an explicitly observed out-of-stock payload under the correct name', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'capture-contract-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixturesDir = join(root, 'fixtures');
  const answers = ['', '0', 'skip', 'skip', 'skip'];
  const result = await captureContract({
    site: 'pokemon-center',
    url: 'https://www.pokemoncenter.com/product/10-10438-112',
    productId: 'delta-reign-pokemon-center-etb',
    availabilityState: 'out-of-stock',
    dataDir: join(root, 'data'),
    fixturesDir,
    loadPlaywright: async () => fakePlaywright({ availability: 'OUT_OF_STOCK', quantity: 0 }),
    promptFn: async () => answers.shift(),
    now: () => 100,
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(result.fixtures, ['out-of-stock.json']);
  assert.deepEqual(JSON.parse(await readFile(join(fixturesDir, 'out-of-stock.json'), 'utf8')), {
    availability: 'OUT_OF_STOCK', quantity: 0,
  });
  const metadata = JSON.parse(await readFile(join(fixturesDir, 'capture-metadata.json'), 'utf8'));
  assert.equal(metadata.availability.state, 'out-of-stock');
  await assert.rejects(readFile(join(fixturesDir, 'in-stock.json'), 'utf8'), { code: 'ENOENT' });
});

test('contract capture rejects an ambiguous availability label before opening Chrome', async () => {
  await assert.rejects(captureContract({
    site: 'pokemon-center',
    url: 'https://www.pokemoncenter.com/product/10-10438-112',
    productId: 'delta-reign-pokemon-center-etb',
    availabilityState: 'maybe',
  }), /Availability state must be/);
});
