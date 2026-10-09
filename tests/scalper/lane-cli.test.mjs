import test from 'node:test';
import assert from 'node:assert/strict';
import { runSiteLane } from '../../src/scalper/lane-cli.mjs';

test('site lane CLI selects the earliest active drop for that site and stops cleanly', async () => {
  const calls = [];
  const drops = [
    { id: 'other', sites: ['bestbuy'], time: '2026-10-01T11:00:00Z' },
    { id: 'later', sites: ['target'], time: '2026-10-01T13:00:00Z' },
    { id: 'first', sites: ['target'], time: '2026-10-01T12:00:00Z' },
    { id: 'done', sites: ['target'], time: '2026-10-01T10:00:00Z', status: 'purchased' },
  ];
  const result = await runSiteLane({
    site: 'target',
    createScalper: async () => ({
      calendar: { allDrops: async () => drops },
      orchestrator: { runDrop: async (drop, options) => { calls.push([drop, options]); return { status: 'paper-confirmed' }; } },
      stop: async () => calls.push(['stop']),
    }),
  });
  assert.equal(calls[0][0].id, 'first');
  assert.deepEqual(calls[0][1], { site: 'target' });
  assert.equal(calls[1][0], 'stop');
  assert.equal(result.status, 'paper-confirmed');
});

test('site lane CLI reports an empty site without starting checkout', async () => {
  let stopped = false;
  const result = await runSiteLane({
    site: 'tcgplayer',
    createScalper: async () => ({
      calendar: { allDrops: async () => [] },
      orchestrator: { runDrop: async () => { throw new Error('must not run'); } },
      stop: async () => { stopped = true; },
    }),
  });
  assert.deepEqual(result, { status: 'no-configured-drops', site: 'tcgplayer' });
  assert.equal(stopped, true);
});

test('site lane CLI runs only an explicitly selected active drop', async () => {
  const calls = [];
  await runSiteLane({
    site: 'pokemon-center',
    dropId: 'canary-product',
    createScalper: async (options) => {
      calls.push(options);
      return {
      calendar: { allDrops: async () => [
        { id: 'earlier-product', sites: ['pokemon-center'], time: '2026-10-01T11:00:00Z' },
        { id: 'canary-product', sites: ['pokemon-center'], time: '2026-10-01T12:00:00Z' },
      ] },
      orchestrator: { runDrop: async (drop) => calls.push(drop.id) },
      stop: async () => {},
      };
    },
  });
  assert.deepEqual(calls, [
    { connectDiscord: false, liveSites: ['pokemon-center'], liveDropIds: ['canary-product'] },
    'canary-product',
  ]);
});

test('site lane CLI refuses an unknown explicit drop instead of falling back', async () => {
  await assert.rejects(runSiteLane({
    site: 'pokemon-center',
    dropId: 'missing',
    createScalper: async () => ({
      calendar: { allDrops: async () => [{ id: 'other', sites: ['pokemon-center'], time: '2026-10-01T11:00:00Z' }] },
      orchestrator: { runDrop: async () => assert.fail('must not run a fallback drop') },
      stop: async () => {},
    }),
  }), (error) => error.code === 'SCALPER_DROP_NOT_FOUND');
});
