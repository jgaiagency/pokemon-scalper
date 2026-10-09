import { openScalperDatabase } from './db.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { createStateStore } from './state-store.mjs';

export const FAULT_POINTS = Object.freeze(['before-commit', 'during-commit', 'after-commit', 'none']);

export async function runFaultInjectionScenario({ point, stateStore, now = () => 1_000 } = {}) {
  if (!FAULT_POINTS.includes(point)) throw new Error(`Unsupported fault point: ${point}`);
  const database = stateStore ? null : openScalperDatabase({ path: ':memory:' });
  const state = stateStore ?? createStateStore({
    database, now, id: (() => { let sequence = 0; return () => `fault-${++sequence}`; })(),
  });
  let commitCount = 0;
  const calendarResults = [];
  const orchestrator = new Orchestrator({
    stateStore: state,
    tasks: state.tasks,
    ledger: state.ledger,
    calendar: { markResult: async (id, status) => calendarResults.push({ id, status }) },
    safety: {
      authorize: async () => ({ allowed: true, live: true, dayStart: 0, dailyLimit: 100 }),
      recheckAtCommit: async () => point === 'before-commit'
        ? { allowed: false, live: true, reason: 'injected-before-commit' }
        : { allowed: true, live: true },
    },
    lanes: {
      target: {
        async checkout({ beforeCommit, onProgress }) {
          await beforeCommit({ faultPoint: point });
          await onProgress({ state: 'submitting' });
          commitCount += 1;
          if (point === 'during-commit') throw new Error('injected failure during commit');
          await onProgress({ state: 'confirming' });
          if (point === 'after-commit') throw new Error('injected failure after commit');
          return { status: 'purchased', orderId: 'fault-order-1' };
        },
      },
    },
    logger: { warn() {}, error() {} },
  });
  try {
    const result = await orchestrator.handleDetection({ site: 'target', drop: { id: `fault-${point}`, price: 20 } });
    const tasks = await state.tasks.list();
    const reservations = await state.ledger.records();
    return { result, task: tasks[0], reservation: reservations[0], commitCount, calendarResults };
  } finally {
    database?.close();
  }
}
