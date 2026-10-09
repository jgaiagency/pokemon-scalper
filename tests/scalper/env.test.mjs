import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvFile, parseEnv } from '../../src/scalper/env.mjs';

test('env parser handles comments, export syntax, quotes, and embedded equals', () => {
  assert.deepEqual(parseEnv('# comment\nexport SCALPER_LIVE=0\nTOKEN="abc=123"\nEMPTY=\n'), {
    SCALPER_LIVE: '0', TOKEN: 'abc=123', EMPTY: '',
  });
});

test('env loading never overwrites an environment value supplied by launchd or the shell', async () => {
  const env = { SCALPER_LIVE: '0' };
  const result = await loadEnvFile({ env, readText: async () => 'SCALPER_LIVE=1\nPC1_PASS=secret\n' });
  assert.deepEqual(result, { loaded: true, keys: ['PC1_PASS'] });
  assert.equal(env.SCALPER_LIVE, '0');
  assert.equal(env.PC1_PASS, 'secret');
});

test('a missing optional .env file is not an error', async () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.deepEqual(await loadEnvFile({ env: {}, readText: async () => { throw error; } }), { loaded: false, keys: [] });
});
