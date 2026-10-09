import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BurnInManager } from '../../src/scalper/burn-in.mjs';
import { DryRunHarness } from '../../src/scalper/dry-run.mjs';
import { OperationalEventLog } from '../../src/scalper/operations.mjs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

test('burn-in passes only after duration and real-input paper evidence', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-burn-'));
  let now = 1_000;
  const manager = new BurnInManager({ env: { SCALPER_LIVE: '0' }, dataDir, now: () => now });
  await manager.start({ durationMs: 1 });
  const events = new OperationalEventLog({ path: join(dataDir, 'operations-events.jsonl'), now: () => now });
  await events.record('discovery-cycle', { sources: 5, transitions: 1, errors: [] });
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: now, heartbeatAt: now, mode: 'paper' }));
  await writeFile(join(dataDir, 'paper-orders.jsonl'), `${JSON.stringify({ timestamp: now, site: 'bestbuy', product: 'p1', simulatedLatencyMs: 10 })}\n`);
  now += 2;
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: 1_000, heartbeatAt: now, mode: 'paper' }));
  const status = await manager.status();
  assert.equal(status.complete, true);
  assert.equal(status.passed, true);
});

test('BurnInManager reports a latency sample from a completed paper order', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-burn-latency-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 10_000;
  const env = { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir, SCALPER_DISCOVERY_INTERVAL_MS: String(SEVEN_DAYS_MS) };
  const manager = new BurnInManager({ env, dataDir, now: () => now });
  await manager.start();
  const events = new OperationalEventLog({ path: join(dataDir, 'operations-events.jsonl'), now: () => now });
  await events.record('discovery-cycle', { sources: 1, transitions: 1, errors: [] });
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: now, heartbeatAt: now, mode: 'paper' }));
  const paper = new DryRunHarness({ env, now: () => now });
  await paper.execute({
    site: 'bestbuy', product: { id: 'measured-product' }, account: { id: 'paper-bb' },
    amount: 79.99, detectedAt: now - 47,
  });

  const status = await manager.status();
  assert.equal(status.summary.paperOrders.count, 1);
  assert.equal(status.summary.paperOrders.latency.samples, 1);
  assert.equal(status.summary.paperOrders.latency.p50Ms, 47);
  assert.equal(status.criteria.find((criterion) => criterion.name === 'measured-latency').pass, true);
});

test('seven-day burn-in flips only after its deadline with the required latency evidence', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-burn-deadline-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1_000;
  const env = { SCALPER_LIVE: '0', SCALPER_DATA_DIR: dataDir, SCALPER_DISCOVERY_INTERVAL_MS: String(SEVEN_DAYS_MS) };
  const manager = new BurnInManager({ env, dataDir, now: () => now });
  await manager.start();
  const events = new OperationalEventLog({ path: join(dataDir, 'operations-events.jsonl'), now: () => now });
  await events.record('discovery-cycle', { sources: 1, transitions: 1, errors: [] });
  const paper = new DryRunHarness({ env, now: () => now });
  await paper.execute({
    site: 'bestbuy', product: { id: 'p1' }, account: { id: 'paper-bb' }, amount: 79.99, detectedAt: now - 25,
  });

  now = 1_000 + SEVEN_DAYS_MS - 1;
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: 1_000, heartbeatAt: now, mode: 'paper' }));
  const before = await manager.status();
  assert.equal(before.complete, false);
  assert.equal(before.passed, false);
  assert.equal(before.summary.paperOrders.latency.samples, 1);

  now = 1_000 + SEVEN_DAYS_MS;
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: 1_000, heartbeatAt: now, mode: 'paper' }));
  const after = await manager.status();
  assert.equal(after.complete, true);
  assert.equal(after.passed, true);
  assert.equal(after.remainingMs, 0);
});
