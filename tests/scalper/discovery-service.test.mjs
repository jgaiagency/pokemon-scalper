import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDiscovery } from '../../src/scalper/discovery-service.mjs';

test('persistent discovery service keeps a fast cadence and backs off after source errors', async () => {
  let now = 1_000;
  let calls = 0;
  const delays = [];
  const result = await serveDiscovery({
    env: { SCALPER_DISCOVERY_INTERVAL_MS: '1000', SCALPER_DISCOVERY_MAX_BACKOFF_MS: '5000' },
    http: {}, maxCycles: 3, now: () => now,
    runCycle: async () => {
      calls += 1;
      now += 100;
      return { sources: calls === 2 ? 4 : 5, items: 10, actionable: 0, alerts: [], executions: [], errors: calls === 2 ? [{ source: 'bb', error: 'throttled' }] : [] };
    },
    sleep: async (ms) => { delays.push(ms); now += ms; },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.cycles, 3);
  assert.deepEqual(delays, [900, 1900]);
});
