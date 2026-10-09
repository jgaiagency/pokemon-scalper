import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetSession } from '../../../src/scalper/sites/target/session.mjs';

test('Target reuses a valid DataDome session and browser history', async () => {
  const session = new TargetSession({ accounts: { loadSession: async () => ({ cookies: ['datadome'], localStorage: { device: 'known' } }) }, auth: { validate: async () => true } });
  assert.equal((await session.ensure({ id: 'a1' })).localStorage.device, 'known');
});

test('Target refresh merges new auth into persisted device state', async () => {
  let saved;
  const session = new TargetSession({ accounts: { loadSession: async () => ({ cookies: ['datadome'] }), saveSession: async (_a, value) => { saved = value; } }, auth: { validate: async () => false, refresh: async () => ({ token: 'fresh' }) } });
  await session.ensure({ id: 'a1' });
  assert.deepEqual(saved.cookies, ['datadome']);
  assert.equal(saved.token, 'fresh');
});
