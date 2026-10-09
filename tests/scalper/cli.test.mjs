import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../src/scalper/cli.mjs';

test('CLI dry command completes through an injected wired application and always stops it', async () => {
  let stopped = false;
  const result = await runCommand('dry', [], {
    createScalper: async () => ({
      calendar: { allDrops: async () => [] },
      dryRun: {},
      orchestrator: {},
      stop: async () => { stopped = true; },
    }),
    env: { SCALPER_LIVE: '0' },
  });
  assert.deepEqual(result, { status: 'no-configured-drops' });
  assert.equal(stopped, true);
});

test('CLI site commands route to the requested lane without importing recursively', async () => {
  const calls = [];
  const result = await runCommand('tgt', [], {
    createScalper: async () => ({
      calendar: { allDrops: async () => [{ id: 'p1', sites: ['target'], time: '2026-10-01T12:00:00Z' }] },
      orchestrator: { runDrop: async (drop, options) => { calls.push([drop.id, options.site]); return { status: 'paper-confirmed' }; } },
      stop: async () => calls.push(['stop']),
    }),
  });
  assert.deepEqual(calls, [['p1', 'target'], ['stop']]);
  assert.equal(result.status, 'paper-confirmed');
});

test('CLI forwards an exact canary drop id to a site lane', async () => {
  const calls = [];
  await runCommand('pc', ['--drop-id', 'chosen'], {
    createScalper: async () => ({
      calendar: { allDrops: async () => [
        { id: 'first', sites: ['pokemon-center'], time: '2026-10-01T11:00:00Z' },
        { id: 'chosen', sites: ['pokemon-center'], time: '2026-10-01T12:00:00Z' },
      ] },
      orchestrator: { runDrop: async (drop) => calls.push(drop.id) },
      stop: async () => {},
    }),
  });
  assert.deepEqual(calls, ['chosen']);
});
