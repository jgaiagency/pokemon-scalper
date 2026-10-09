import test from 'node:test';
import assert from 'node:assert/strict';
import { BestBuySession } from '../../../src/scalper/sites/bestbuy/session.mjs';

test('Best Buy reuses a valid Akamai-bearing session', async () => {
  const session = new BestBuySession({ accounts: { loadSession: async () => ({ cookies: [{ name: 'ak_bmsc' }] }) }, auth: { validate: async () => true } });
  assert.equal((await session.ensure({ id: 'a1' })).cookies[0].name, 'ak_bmsc');
});

test('Best Buy refresh retains existing cookies and saves the refreshed session', async () => {
  let saved;
  const session = new BestBuySession({ accounts: { loadSession: async () => ({ cookies: ['akamai'] }), saveSession: async (_a, value) => { saved = value; } }, auth: { validate: async () => false, refresh: async (old) => ({ ...old, token: 'new' }) } });
  await session.ensure({ id: 'a1' });
  assert.deepEqual(saved.cookies, ['akamai']);
});
