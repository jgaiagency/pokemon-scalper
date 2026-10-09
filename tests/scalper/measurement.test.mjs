import test from 'node:test';
import assert from 'node:assert/strict';
import { recordMeasurement } from '../../src/scalper/measurement.mjs';

test('measurement recorder launches visible persistent Chrome and saves HAR plus trace without automating clicks', async () => {
  const events = [];
  const writes = [];
  const page = { goto: async (url) => events.push(['goto', url]) };
  const context = {
    tracing: {
      start: async (options) => events.push(['trace-start', options]),
      stop: async (options) => events.push(['trace-stop', options]),
    },
    exposeBinding: async (name, callback) => {
      events.push(['binding', name]);
      await callback({}, {
        kind: 'click', url: 'https://target.example/checkout?token=secret#payment',
        tag: 'button', text: 'Place order', selectors: ['button[data-test="place-order"]'],
      });
    },
    addInitScript: async (script) => events.push(['init-script', typeof script]),
    pages: () => [page],
    close: async () => events.push(['close']),
  };
  let launch;
  const result = await recordMeasurement({
    site: 'target', url: 'https://target.example/item', accountId: 't1', dataDir: '/data',
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async (profile, options) => { launch = { profile, options }; return context; } } }),
    makeDirectory: async (path) => events.push(['mkdir', path]),
    waitForOperator: async () => events.push(['wait']),
    now: () => Date.parse('2026-10-01T12:00:00Z'),
    logger: { warn: (message) => events.push(['warn', message]) },
    writeText: async (path, value) => writes.push([path, value]),
  });
  assert.equal(launch.options.channel, 'chrome');
  assert.equal(launch.options.headless, false);
  assert.equal(launch.options.recordHar.content, 'omit');
  assert.equal(launch.profile, '/data/browser-profiles/target-t1');
  assert.deepEqual(events.filter(([event]) => event === 'goto' || event === 'wait' || event === 'close').map(([event]) => event), ['goto', 'wait', 'close']);
  assert.match(result.harPath, /target-2026-10-01T12-00-00-000Z\/network\.har$/);
  assert.match(result.tracePath, /trace\.zip$/);
  assert.match(result.interactionsPath, /interactions\.json$/);
  assert.equal(events.some(([event]) => event === 'binding'), true);
  assert.equal(events.some(([event]) => event === 'init-script'), true);
  const interactions = JSON.parse(writes[0][1]);
  assert.equal(interactions[0].url, 'https://target.example/checkout');
  assert.equal(JSON.stringify(interactions).includes('secret'), false);
});
