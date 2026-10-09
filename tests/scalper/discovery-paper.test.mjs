import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DiscoveryPaperExecutor, discoveryItemToDrop } from '../../src/scalper/discovery-paper.mjs';
import { DropCalendar } from '../../src/scalper/drop-calendar.mjs';
import { DryRunHarness } from '../../src/scalper/dry-run.mjs';
import { createMockBrowserAdapter } from '../../src/scalper/transports/browser.mjs';
import { createScalper } from '../../src/scalper/wiring.mjs';

const item = {
  sourceId: 'bb-search', site: 'bestbuy', id: 'bestbuy-123', sku: '123', productId: 'target-product',
  name: 'Pokemon Booster Bundle', url: 'https://www.bestbuy.com/product/example/sku/123', price: 26.99,
};

test('discovery items become stable validated paper drops', () => {
  const drop = discoveryItemToDrop(item, { detectedAt: 1_700_000_000_000 });
  assert.equal(drop.id, 'retailer-bestbuy-target-product');
  assert.equal(drop.purchaseQuantity, 1);
  assert.equal(drop.productUrls.bestbuy, item.url);
});

test('discovery paper executor persists the drop before orchestrating and records the result', async () => {
  const calls = [];
  const executor = new DiscoveryPaperExecutor({
    env: { SCALPER_LIVE: '0' },
    calendar: { upsertDrop: async (drop) => calls.push(['upsert', drop.id]) },
    orchestrator: { handleDetection: async ({ drop }) => { calls.push(['execute', drop.id]); return { status: 'paper-confirmed', taskId: 'task-1' }; } },
    events: { record: async (type, details) => calls.push([type, details.status]) },
  });
  const result = await executor.execute(item, { detectedAt: 100 });
  assert.equal(result.status, 'paper-confirmed');
  assert.deepEqual(calls, [
    ['upsert', 'retailer-bestbuy-target-product'],
    ['execute', 'retailer-bestbuy-target-product'],
    ['discovery-execution', 'paper-confirmed'],
  ]);
});

test('discovery execution refuses to become a hidden live-order path', async () => {
  const executor = new DiscoveryPaperExecutor({
    env: { SCALPER_LIVE: '1' },
    calendar: { upsertDrop: async () => {} },
    orchestrator: { handleDetection: async () => ({}) },
  });
  await assert.rejects(executor.execute(item), (error) => error.code === 'SCALPER_DISCOVERY_PAPER_ONLY');
});

test('actionable discovery traverses the wired orchestrator into a durable paper order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-discovery-e2e-'));
  const env = { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir };
  const clock = { start: async () => {}, stop() {}, now: () => 1_000, isSynchronized: () => true, driftMs: () => 0 };
  const calendar = new DropCalendar({ path: join(dataDir, 'drops.json'), now: clock.now });
  const dryRun = new DryRunHarness({ env, now: clock.now });
  const scalper = await createScalper({
    env, loadEnv: async () => {}, clock, calendar, dryRun, browser: createMockBrowserAdapter(),
    // Keep the integration test independent of the intentionally gitignored
    // operator account file. Paper mode still traverses account selection and
    // session creation with this deterministic synthetic account.
    accounts: { accountsFor: async (site) => [{ id: `paper-${site}`, email: 'paper@example.invalid' }] },
    httpTransport: { get() {}, postJson() {}, request() {} },
    discordTransport: { close: async () => {} },
    discordConfig: { token: null, guildId: 'g', channelIds: [], categoryIds: [], stores: [] },
  });
  try {
    const executor = new DiscoveryPaperExecutor({ env, calendar, orchestrator: scalper.orchestrator });
    const result = await executor.execute(item, { detectedAt: 900 });
    assert.equal(result.status, 'paper-confirmed');
    const order = JSON.parse((await readFile(join(dataDir, 'paper-orders.jsonl'), 'utf8')).trim());
    assert.equal(order.product, 'retailer-bestbuy-target-product');
    assert.equal(order.simulatedLatencyMs, 100);
    assert.equal((await scalper.tasks.list())[0].state, 'paper-confirmed');
  } finally {
    await scalper.stop();
  }
});
