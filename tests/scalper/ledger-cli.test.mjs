import test from 'node:test';
import assert from 'node:assert/strict';
import { runLedgerCommand } from '../../src/scalper/ledger-cli.mjs';

test('ledger release requires explicit acknowledgement', async () => {
  const released = [];
  const ledger = { records: async () => [{ id: 'r1' }], release: async (id, details) => { released.push({ id, details }); return { id, status: 'released' }; } };
  assert.deepEqual(await runLedgerCommand({ command: 'list', ledger }), { records: [{ id: 'r1' }] });
  await assert.rejects(runLedgerCommand({ command: 'release', id: 'r1', env: {}, ledger }), /SCALPER_LEDGER_ACK/);
  assert.equal((await runLedgerCommand({ command: 'release', id: 'r1', env: { SCALPER_LEDGER_ACK: '1' }, ledger })).released.status, 'released');
  assert.equal(released.length, 1);
});

test('ledger confirmation requires explicit acknowledgement after retailer reconciliation', async () => {
  const ledger = { complete: async (id, details) => ({ id, ...details }) };
  await assert.rejects(runLedgerCommand({ command: 'confirm', id: 'r1', env: {}, ledger }), /SCALPER_LEDGER_ACK/);
  const result = await runLedgerCommand({
    command: 'confirm', id: 'r1', env: { SCALPER_LEDGER_ACK: '1', SCALPER_RECONCILED_ORDER_ID: 'o1' }, ledger,
  });
  assert.equal(result.confirmed.orderId, 'o1');
});
