import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, isAuthFailure } from '../../src/scalper/accounts.mjs';
import { memoryStorage } from './helpers.mjs';

const configPath = '/test/accounts.json';
const sessionPath = '/test/sessions/pc-1.json';
const config = { 'pokemon-center': [{
  id: 'pc-1', email: 'buyer@example.com', password: 'env:PC1_PASS', sessionFile: sessionPath,
}] };

test('accounts resolve env secrets and persist sessions through injected storage', async () => {
  const storage = memoryStorage({ [configPath]: JSON.stringify(config) });
  const manager = new AccountManager({ storage, configPath, env: { PC1_PASS: 'secret' } });
  const [account] = await manager.accountsFor('pokemon-center');
  assert.equal(account.password, 'secret');
  await manager.saveSession(account, { cookies: [{ name: 'keep-me' }] });
  assert.deepEqual(await manager.loadSession(account), { cookies: [{ name: 'keep-me' }] });
});

test('authentication failures refresh once and retry without clearing session history', async () => {
  const storage = memoryStorage({ [configPath]: JSON.stringify(config) });
  const manager = new AccountManager({ storage, configPath, env: { PC1_PASS: 'secret' } });
  const [account] = await manager.accountsFor('pokemon-center');
  let calls = 0;
  const result = await manager.withSessionRefresh(account, async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('expired'), { status: 401 });
    return 'ok';
  }, async () => ({ token: 'fresh' }));
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal((await manager.loadSession(account)).token, 'fresh');
  assert.equal(isAuthFailure({ status: 500 }), false);
});

test('accounts resolve Keychain references through the injected vault without persisting secrets', async () => {
  const keychainConfig = { bestbuy: [{ id: 'bb-1', email: 'buyer@example.com', password: 'keychain:BB1_PASS' }] };
  const storage = memoryStorage({ [configPath]: JSON.stringify(keychainConfig) });
  const references = [];
  const manager = new AccountManager({
    storage, configPath, env: {},
    vault: { async resolve(reference) { references.push(reference); return 'from-keychain'; } },
  });
  const [account] = await manager.accountsFor('bestbuy');
  assert.equal(account.password, 'from-keychain');
  assert.deepEqual(references, ['keychain:BB1_PASS']);
  assert.doesNotMatch(storage.files.get(configPath), /from-keychain/);
});

test('AccountManager reads the real per-site config from config/scalper-accounts.json by default', async () => {
  const paths = [];
  const manager = new AccountManager({
    env: { BB_PASS: 'resolved' },
    storage: {
      async readText(path) {
        paths.push(path);
        return JSON.stringify({ bestbuy: [{ id: 'bb-1', email: 'buyer@example.test', password: 'env:BB_PASS' }] });
      },
    },
  });
  const [account] = await manager.accountsFor('bestbuy');
  assert.deepEqual(paths, ['config/scalper-accounts.json']);
  assert.equal(account.email, 'buyer@example.test');
  assert.equal(account.password, 'resolved');
});

test('AccountManager accepts a machine-local account path from the environment', async () => {
  const paths = [];
  const manager = new AccountManager({
    env: { SCALPER_ACCOUNTS_PATH: '/private/operator-accounts.json' },
    storage: {
      async readText(path) {
        paths.push(path);
        return JSON.stringify({ target: [{ id: 'tgt-1', email: 'buyer@example.test' }] });
      },
    },
  });
  await manager.accountsFor('target');
  assert.deepEqual(paths, ['/private/operator-accounts.json']);
});
