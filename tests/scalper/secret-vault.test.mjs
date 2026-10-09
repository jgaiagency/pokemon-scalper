import test from 'node:test';
import assert from 'node:assert/strict';
import { KeychainVault } from '../../src/scalper/secret-vault.mjs';

test('Keychain vault stores, reads, and deletes a named secret without returning it from writes', async () => {
  const calls = [];
  const vault = new KeychainVault({
    platform: 'darwin',
    execFile: async (_path, args) => {
      calls.push(args);
      if (args[0] === 'find-generic-password') return { stdout: 'sensitive-value\n' };
      return { stdout: '' };
    },
  });
  assert.deepEqual(await vault.set('BB1_PASS', 'sensitive-value'), { stored: true, name: 'BB1_PASS' });
  assert.equal(await vault.get('BB1_PASS'), 'sensitive-value');
  assert.equal(await vault.has('BB1_PASS'), true);
  assert.deepEqual(await vault.delete('BB1_PASS'), { deleted: true, name: 'BB1_PASS' });
  assert.ok(calls.some((args) => args[0] === 'add-generic-password'));
});

test('interactive Keychain storage uses the native prompt without putting a secret in argv', async () => {
  const calls = [];
  const vault = new KeychainVault({
    platform: 'darwin',
    interactiveRun: async (_path, args) => calls.push(args),
  });
  assert.deepEqual(await vault.setInteractive('BB1_PASS'), { stored: true, name: 'BB1_PASS' });
  assert.deepEqual(calls[0].slice(-2), ['com.local.pokemon-scalper', '-w']);
  assert.equal(calls[0].length, 7);
});

test('missing Keychain entries resolve to null and never become false credentials', async () => {
  const vault = new KeychainVault({
    platform: 'darwin',
    execFile: async () => { throw Object.assign(new Error('item not found'), { code: 44 }); },
  });
  assert.equal(await vault.get('TGT1_PASS'), null);
  assert.equal(await vault.resolve('keychain:TGT1_PASS'), null);
});

test('Keychain vault rejects unsafe names and unsupported platforms', async () => {
  const vault = new KeychainVault({ platform: 'linux', execFile: async () => ({}) });
  await assert.rejects(vault.get('OK_NAME'), (error) => error.code === 'SCALPER_KEYCHAIN_UNAVAILABLE');
  const mac = new KeychainVault({ platform: 'darwin', execFile: async () => ({}) });
  await assert.rejects(mac.set('../bad name', 'value'), /secret name/i);
});
