import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { PurchaseLedger } from './safety.mjs';
import { createStateStore } from './state-store.mjs';

export async function runLedgerCommand({ command = 'list', id, env = process.env, ledger } = {}) {
  if (!ledger) throw new Error('Ledger command requires a purchase ledger');
  if (command === 'list') return { records: await ledger.records() };
  if (command === 'release') {
    if (!id) throw new Error('Reservation id is required');
    if (env.SCALPER_LEDGER_ACK !== '1') throw new Error('Set SCALPER_LEDGER_ACK=1 after verifying that no order was placed');
    return { released: await ledger.release(id, { reason: 'operator-verified-no-order' }) };
  }
  if (command === 'confirm') {
    if (!id) throw new Error('Reservation id is required');
    if (env.SCALPER_LEDGER_ACK !== '1') throw new Error('Set SCALPER_LEDGER_ACK=1 after verifying that the retailer placed the order');
    return { confirmed: await ledger.complete(id, { status: 'purchased', orderId: env.SCALPER_RECONCILED_ORDER_ID || undefined, reason: 'operator-verified-order' }) };
  }
  throw new Error(`Unknown ledger command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const [command = 'list', id] = process.argv.slice(2);
  const dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper';
  const state = createStateStore({ path: `${dataDir}/scalper.db`, dataDir });
  try {
    console.log(JSON.stringify(await runLedgerCommand({ command, id, env: process.env, ledger: state.ledger }), null, 2));
  } finally {
    state.close();
  }
}
