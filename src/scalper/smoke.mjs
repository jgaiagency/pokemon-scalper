import { fileURLToPath } from 'node:url';
import { DryRunHarness, runConfiguredDryRun } from './dry-run.mjs';
import { createMockBrowserAdapter } from './transports/browser.mjs';
import { PurchaseTaskStore } from './task-state.mjs';
import { createScalper } from './wiring.mjs';

function memoryStorage() {
  const files = new Map();
  return {
    files,
    async appendText(path, value) { files.set(path, `${files.get(path) ?? ''}${value}`); },
    async readText(path) {
      if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: 'ENOENT' });
      return files.get(path);
    },
    async writeText(path, value) { files.set(path, value); },
  };
}

function smokeClock() {
  return {
    async start() {},
    stop() {},
    now: () => Date.parse('2026-10-01T12:00:00.100Z'),
    driftMs: () => 0,
    isSynchronized: () => true,
  };
}

export async function runSmokeTest() {
  const env = { SCALPER_LIVE: '0' };
  const storage = memoryStorage();
  const orderLogPath = '/isolated-smoke/paper-orders.jsonl';
  const drop = {
    id: 'smoke-target-etb', name: 'Smoke Test ETB', sites: ['target'], type: 'surprise',
    time: '2026-10-01T12:00:00.000Z', price: 49.99,
    // No network request is made; use an allowlisted host so the smoke test
    // also exercises the production SSRF boundary.
    productUrls: { target: 'https://www.target.com/p/isolated-smoke-product' },
  };
  const calendar = {
    allDrops: async () => [drop],
    upsertDrop: async () => {},
    markResult: async () => {},
  };
  const dryRun = new DryRunHarness({
    storage, orderLogPath, env,
    now: () => Date.parse('2026-10-01T12:00:00.250Z'),
  });
  const tasks = new PurchaseTaskStore({ storage, path: '/isolated-smoke/purchase-tasks.json', id: () => 'smoke-task' });
  const scalper = await createScalper({
    env,
    loadEnv: async () => ({ loaded: false, keys: [] }),
    clock: smokeClock(),
    calendar,
    dryRun,
    tasks,
    accounts: {
      accountsFor: async () => [{ id: 'smoke-target-account', email: 'paper@smoke.invalid' }],
      allAccounts: async () => [],
    },
    httpTransport: {
      get: async () => ({
        status: 200,
        bodyJson: { availableToPromise: 1, fulfillment: { shipping: 'AVAILABLE' } },
      }),
      postJson: async () => { throw new Error('Smoke test must not POST'); },
      request: async () => { throw new Error('Smoke test must not send arbitrary requests'); },
    },
    browser: createMockBrowserAdapter(),
    discordTransport: { close: async () => {} },
    discordConfig: { token: null, guildId: 'smoke', channelIds: [], categoryIds: [], stores: [] },
    connectDiscord: false,
  });
  try {
    const result = await runConfiguredDryRun({ calendar, dryRun, orchestrator: scalper.orchestrator, env });
    const raw = storage.files.get(orderLogPath)?.trim();
    const order = raw ? JSON.parse(raw) : null;
    return { ok: result.status === 'paper-confirmed' && order?.status === 'paper-confirmed', result, order };
  } finally {
    await scalper.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runSmokeTest();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
