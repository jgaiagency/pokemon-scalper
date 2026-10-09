import test from 'node:test';
import assert from 'node:assert/strict';
import { runFaultInjectionScenario } from '../../src/scalper/fault-injection.mjs';

test('fault injection proves failures before commit block without ordering', async () => {
  const scenario = await runFaultInjectionScenario({ point: 'before-commit' });
  assert.equal(scenario.result.status, 'safety-blocked');
  assert.equal(scenario.task.state, 'blocked');
  assert.equal(scenario.reservation.status, 'failed');
  assert.equal(scenario.commitCount, 0);
});

for (const point of ['during-commit', 'after-commit']) {
  test(`fault injection marks ${point} failure uncertain without retrying`, async () => {
    const scenario = await runFaultInjectionScenario({ point });
    assert.equal(scenario.result.status, 'uncertain');
    assert.equal(scenario.task.state, 'uncertain');
    assert.equal(scenario.reservation.status, 'uncertain');
    assert.equal(scenario.commitCount, 1);
  });
}

test('fault injection success completes task and reservation together', async () => {
  const scenario = await runFaultInjectionScenario({ point: 'none' });
  assert.equal(scenario.result.status, 'purchased');
  assert.equal(scenario.task.state, 'purchased');
  assert.equal(scenario.reservation.status, 'purchased');
  assert.equal(scenario.commitCount, 1);
});
