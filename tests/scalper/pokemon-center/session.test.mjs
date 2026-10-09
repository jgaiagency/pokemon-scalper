import test from 'node:test';
import assert from 'node:assert/strict';
import { PokemonCenterSession } from '../../../src/scalper/sites/pokemon-center/session.mjs';

test('Pokémon Center reuses a valid persisted session', async () => {
  let logins = 0;
  const manager = { loadSession: async () => ({ token: 'old' }), saveSession: async () => {} };
  const session = new PokemonCenterSession({ accounts: manager, auth: { validate: async () => true, login: async () => { logins += 1; } } });
  assert.deepEqual(await session.ensure({ id: 'a1' }), { token: 'old' });
  assert.equal(logins, 0);
});

test('Pokémon Center refresh persists auth state without clearing cookies', async () => {
  let saved;
  const manager = { loadSession: async () => ({ cookies: ['history'] }), saveSession: async (_a, value) => { saved = value; } };
  const session = new PokemonCenterSession({ accounts: manager, auth: { validate: async () => false, refresh: async (old) => ({ ...old, token: 'fresh' }) } });
  assert.equal((await session.ensure({ id: 'a1' })).token, 'fresh');
  assert.deepEqual(saved.cookies, ['history']);
});
