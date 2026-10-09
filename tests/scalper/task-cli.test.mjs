import test from 'node:test';
import assert from 'node:assert/strict';
import { runTaskCommand } from '../../src/scalper/task-cli.mjs';

test('task reconciliation requires explicit acknowledgement', async () => {
  const calls = [];
  const tasks = {
    list: async () => [{ id: 't1' }],
    recoverable: async () => [{ id: 't2' }],
    reconcile: async (...args) => { calls.push(args); return { id: 't1', state: args[1] }; },
  };
  assert.deepEqual(await runTaskCommand({ command: 'list', tasks }), { tasks: [{ id: 't1' }] });
  await assert.rejects(runTaskCommand({ command: 'reconcile', id: 't1', outcome: 'purchased', env: {}, tasks }), /SCALPER_TASK_ACK/);
  const result = await runTaskCommand({ command: 'reconcile', id: 't1', outcome: 'purchased', orderId: 'o1', env: { SCALPER_TASK_ACK: '1' }, tasks });
  assert.equal(result.task.state, 'purchased');
  assert.equal(calls[0][2].orderId, 'o1');
});
