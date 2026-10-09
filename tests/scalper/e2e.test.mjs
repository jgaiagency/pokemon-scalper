import test from 'node:test';
import assert from 'node:assert/strict';
import { runEndToEndPaperTest } from '../../src/scalper/e2e.mjs';

test('realistic Restockd Target signal completes the isolated paper pipeline end to end', async () => {
  const report = await runEndToEndPaperTest();
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.signal.product, '30th-booster-bundle');
  assert.equal(report.signal.url, 'https://www.target.com/p/-/A-1011407490');
  assert.equal(report.execution.status, 'paper-confirmed');
  assert.equal(report.execution.taskState, 'paper-confirmed');
  assert.equal(report.checks.noExternalMutation, true);
});
