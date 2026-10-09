import test from 'node:test';
import assert from 'node:assert/strict';
import { runMarketCommand } from '../../src/scalper/market-cli.mjs';

test('market CLI captures and ranks through an injected tracker', async () => {
  const tracker = {
    capture: async () => ({ observations: [{ productId: 'p1' }], errors: [] }),
    rank: async () => [{ id: 'p1', eligible: true, score: 80 }],
  };
  assert.equal((await runMarketCommand('capture', [], { tracker })).observations.length, 1);
  assert.equal((await runMarketCommand('rank', [], { tracker }))[0].score, 80);
});

test('market CLI imports JSONL sold comps through the validated store', async () => {
  const saved = [];
  const result = await runMarketCommand('import', ['/sold.jsonl'], {
    tracker: { store: { append: async (value) => { saved.push(value); return value; } } },
    readText: async () => [
      JSON.stringify({ productId: 'p1', source: 'manual', kind: 'completed-sale', price: 90, at: 1 }),
      JSON.stringify({ productId: 'p1', source: 'manual', kind: 'completed-sale', price: 95, at: 2 }),
    ].join('\n'),
  });
  assert.equal(result.imported, 2);
  assert.equal(saved[1].price, 95);
});
