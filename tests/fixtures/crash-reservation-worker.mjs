import { createStateStore } from '../../src/scalper/state-store.mjs';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('database path required');
const state = createStateStore({ path: databasePath, dataDir: process.argv[3] });
const { task } = await state.tasks.ensure({ key: 'crash-drop', site: 'target', product: 'crash-product' });
await state.reserveForTask({
  taskId: task.id,
  key: 'crash-drop',
  site: 'target',
  product: 'crash-product',
  amount: 20,
  quantity: 1,
  dayStart: 0,
  dailyLimit: 100,
});
process.exit(77);
