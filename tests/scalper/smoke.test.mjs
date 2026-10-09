import test from 'node:test';
import assert from 'node:assert/strict';
import { runSmokeTest } from '../../src/scalper/smoke.mjs';

test('smoke test exercises the wired detector and paper checkout without external services', async () => {
  const result = await runSmokeTest();
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'paper-confirmed');
  assert.equal(result.order.site, 'target');
  assert.equal(result.order.product, 'smoke-target-etb');
  assert.equal(result.order.wouldHavePaid, 49.99);
});
