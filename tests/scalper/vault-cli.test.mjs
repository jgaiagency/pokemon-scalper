import test from 'node:test';
import assert from 'node:assert/strict';
import { runVaultCommand } from '../../src/scalper/vault-cli.mjs';

test('vault CLI uses native interactive storage and never requests a secret argument', async () => {
  const calls = [];
  const vault = {
    setInteractive: async (name) => { calls.push(name); return { stored: true, name }; },
    has: async () => true,
    delete: async (name) => ({ deleted: true, name }),
  };
  assert.deepEqual(await runVaultCommand(['set', 'BB1_PASS'], { vault }), { stored: true, name: 'BB1_PASS' });
  assert.deepEqual(calls, ['BB1_PASS']);
  assert.deepEqual(await runVaultCommand(['status', 'BB1_PASS'], { vault }), { name: 'BB1_PASS', configured: true });
});
