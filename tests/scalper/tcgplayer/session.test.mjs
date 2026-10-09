import test from 'node:test';
import assert from 'node:assert/strict';
import { TcgplayerSession } from '../../../src/scalper/sites/tcgplayer/session.mjs';

test('TCGPlayer reuses a valid persisted session', async () => {
  const sessions = new TcgplayerSession({ accounts: { loadSession: async () => ({ token: 'old' }), saveSession: async () => {} }, auth: { validate: async () => true } });
  assert.equal((await sessions.ensure({ id: 'a1' })).token, 'old');
});

test('TCGPlayer logs in and persists when there is no valid session', async () => {
  let saved;
  const sessions = new TcgplayerSession({ accounts: { loadSession: async () => null, saveSession: async (_a, value) => { saved = value; } }, auth: { login: async () => ({ token: 'new' }) } });
  assert.equal((await sessions.ensure({ id: 'a1' })).token, 'new');
  assert.equal(saved.token, 'new');
});
