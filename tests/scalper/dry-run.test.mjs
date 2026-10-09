import test from 'node:test';
import assert from 'node:assert/strict';
import { DryRunHarness, isLiveMode, runConfiguredDryRun } from '../../src/scalper/dry-run.mjs';
import { memoryStorage } from './helpers.mjs';

test('paper mode records the intended purchase and never calls live checkout', async () => {
  const storage = memoryStorage();
  let charged = false;
  const harness = new DryRunHarness({ storage, orderLogPath: '/paper.jsonl', env: { SCALPER_LIVE: '0' }, now: () => 123 });
  const result = await harness.execute({
    site: 'target', product: { id: 'p1', name: 'ETB' }, account: { id: 'tgt-1' }, amount: 54.99,
    detectedAt: 100, liveCheckout: async () => { charged = true; },
  });
  assert.equal(charged, false);
  assert.equal(result.status, 'paper-confirmed');
  const order = JSON.parse(storage.files.get('/paper.jsonl').trim());
  assert.deepEqual({ site: order.site, product: order.product, account: order.account }, { site: 'target', product: 'p1', account: 'tgt-1' });
  assert.equal(order.simulatedLatencyMs, 23);
  assert.equal(order.wouldHavePaid, 54.99);
});

test('only the exact SCALPER_LIVE=1 value arms a live checkout', async () => {
  assert.equal(isLiveMode({ SCALPER_LIVE: 'true' }), false);
  assert.equal(isLiveMode({ SCALPER_LIVE: '1' }), true);
  const harness = new DryRunHarness({ storage: memoryStorage(), env: { SCALPER_LIVE: '1' } });
  assert.deepEqual(await harness.execute({ liveCheckout: async () => ({ status: 'purchased' }) }), { status: 'purchased' });
});

test('paper pipeline performs real detection but simulates cart and confirmation', async () => {
  const storage = memoryStorage();
  let detections = 0;
  let charged = false;
  const harness = new DryRunHarness({ storage, orderLogPath: '/pipeline.jsonl', env: { SCALPER_LIVE: '0' }, now: () => 200 });
  const result = await harness.runPipeline({
    detect: async () => { detections += 1; return { available: true, detectedAt: 150 }; },
    site: 'bestbuy', product: { id: 'p2' }, account: { id: 'bb-1' }, amount: 39.99,
    liveCheckout: async () => { charged = true; },
  });
  assert.equal(detections, 1);
  assert.equal(charged, false);
  assert.equal(result.status, 'paper-confirmed');
  assert.match(storage.files.get('/pipeline.jsonl'), /"product":"p2"/);
});

test('configured dry run delegates to the orchestrator lane instead of logging an immediate fake order', async () => {
  const drop = { id: 'live-observation', name: 'ETB', sites: ['target'], type: 'surprise', time: '2026-10-01T12:00:00Z' };
  const calls = [];
  const result = await runConfiguredDryRun({
    env: { SCALPER_LIVE: '0' },
    calendar: { allDrops: async () => [drop] },
    orchestrator: { runDrop: async (value) => { calls.push(value); return { status: 'paper-confirmed' }; } },
  });
  assert.deepEqual(result, { status: 'paper-confirmed' });
  assert.deepEqual(calls, [drop]);
});
