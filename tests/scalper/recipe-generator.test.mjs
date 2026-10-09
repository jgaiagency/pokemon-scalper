import assert from 'node:assert/strict';
import test from 'node:test';
import { generateRecipe } from '../../src/scalper/recipe-generator.mjs';

test('recipe generation uses only captured selectors and emits no default challenge selectors', async () => {
  const interactions = [
    { kind: 'click', tag: 'button', text: 'Add to cart', selectors: ['#observed-add'] },
    { kind: 'click', tag: 'button', text: 'Place order', selectors: ['#observed-commit'] },
    { kind: 'click', tag: 'div', text: 'Thank you for your order', selectors: ['#observed-confirmation'] },
  ];
  let written;
  const result = await generateRecipe({
    site: 'pokemon-center',
    measurementDir: '/measurement',
    outputDir: '/config',
    readText: async (path) => {
      if (path.endsWith('interactions.json')) return JSON.stringify(interactions);
      if (path.endsWith('network.har')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify({ version: 1, sites: {} });
    },
    writeText: async (_path, value) => { written = JSON.parse(value); },
  });

  assert.equal(result.steps, 2);
  assert.deepEqual(written.sites['pokemon-center'].steps.map((step) => step.selectors[0]), [
    '#observed-add', '#observed-commit',
  ]);
  assert.deepEqual(written.sites['pokemon-center'].confirmation.selectors, ['#observed-confirmation']);
  assert.deepEqual(written.sites['pokemon-center'].challenges, []);
  assert.equal(JSON.stringify(written).includes('data-sitekey'), false);
});

test('recipe generation fails closed when measurement has no selectors', async () => {
  await assert.rejects(generateRecipe({
    site: 'pokemon-center',
    measurementDir: '/measurement',
    readText: async (path) => {
      if (path.endsWith('interactions.json')) return '[]';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    writeText: async () => assert.fail('must not write a guessed recipe'),
  }), /refusing to generate selector guesses/);
});
