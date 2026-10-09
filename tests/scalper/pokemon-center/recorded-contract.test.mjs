import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPokemonCenterContracts } from '../../../src/scalper/recorded-contracts.mjs';

test('operator-recorded Pokémon Center contracts satisfy detection and cart invariants', async (context) => {
  const result = await loadPokemonCenterContracts();
  if (result.missing.length) {
    context.skip(`operator capture required: ${result.missing.join(', ')}`);
    return;
  }
  assert.deepEqual(result.defects, []);
  assert.equal(result.ready, true);
});
