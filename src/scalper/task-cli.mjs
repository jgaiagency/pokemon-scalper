import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';
import { PurchaseTaskStore } from './task-state.mjs';
import { createStateStore } from './state-store.mjs';

export async function runTaskCommand({ command = 'list', id, outcome, orderId, env = process.env, tasks } = {}) {
  if (!tasks) throw new Error('Task command requires a purchase task store');
  if (command === 'list') return { tasks: await tasks.list() };
  if (command === 'recoverable') return { tasks: await tasks.recoverable() };
  if (command === 'reconcile') {
    if (!id || !outcome) throw new Error('Task id and purchased|failed outcome are required');
    if (env.SCALPER_TASK_ACK !== '1') throw new Error('Set SCALPER_TASK_ACK=1 after reconciling the order with the retailer');
    return { task: await tasks.reconcile(id, outcome, { actor: 'operator', orderId }) };
  }
  throw new Error(`Unknown task command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const [command = 'list', id, outcome, orderId] = process.argv.slice(2);
  const dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper';
  const state = createStateStore({ path: `${dataDir}/scalper.db`, dataDir });
  try {
    console.log(JSON.stringify(await runTaskCommand({ command, id, outcome, orderId, env: process.env, tasks: state.tasks }), null, 2));
  } finally {
    state.close();
  }
}
