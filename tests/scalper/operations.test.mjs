import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationalEventLog, generateOperationsReport, rotateFile, writeOperationsReport } from '../../src/scalper/operations.mjs';

test('operations report summarizes uptime, source health, alerts, orders, latency, and duplicates', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-ops-'));
  const now = 2_000;
  const events = new OperationalEventLog({ path: join(dataDir, 'operations-events.jsonl'), now: () => now });
  await events.record('discovery-cycle', { sources: 5, transitions: 1, errors: [] });
  await events.record('alert-delivery', { outcome: 'delivered' });
  await events.record('discovery-execution', { status: 'paper-confirmed' });
  await writeFile(join(dataDir, 'runtime-state.json'), JSON.stringify({ startedAt: 1_000, heartbeatAt: now, mode: 'paper', signalInbox: true }));
  await writeFile(join(dataDir, 'paper-orders.jsonl'), `${JSON.stringify({ timestamp: now, site: 'bestbuy', product: 'p1', simulatedLatencyMs: 42 })}\n`);
  const report = await generateOperationsReport({ dataDir, now, since: 0 });
  assert.equal(report.status, 'healthy');
  assert.equal(report.runtime.uptimeMs, 1_000);
  assert.equal(report.discovery.sourceChecks, 5);
  assert.equal(report.alerts.delivered, 1);
  assert.equal(report.paperOrders.latency.p95Ms, 42);
  const path = await writeOperationsReport(report, { dataDir });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).paperOrders.count, 1);
});

test('log rotation preserves bounded numbered archives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scalper-rotate-'));
  const path = join(dir, 'service.log');
  await writeFile(path, 'large');
  assert.equal((await rotateFile(path, { maxBytes: 1, maxArchives: 2 })).rotated, true);
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'large');
});
