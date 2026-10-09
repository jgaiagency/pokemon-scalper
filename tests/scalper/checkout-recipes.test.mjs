import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckoutRecipeProvider,
  validateCheckoutRecipe,
} from '../../src/scalper/checkout-recipes.mjs';
import { memoryStorage } from './helpers.mjs';

const validRecipe = {
  version: 1,
  site: 'target',
  steps: [
    { action: 'click', selectors: ['button[data-test="add-to-cart"]'] },
    { action: 'fill', selectors: ['input[name="email"]'], valueFrom: 'account.email' },
    { action: 'click', selectors: ['button[data-test="place-order"]'], commit: true },
  ],
  confirmation: {
    selectors: ['[data-test="order-confirmation"]'],
    orderId: { selector: '[data-test="order-number"]', pattern: '([A-Z0-9-]+)' },
  },
};

const validBestBuyRecipe = {
  version: 1,
  site: 'bestbuy',
  steps: [
    { action: 'click', selectors: ['button[data-testid="add-to-cart"]'] },
    { action: 'waitForUrl', pattern: '/cart' },
    { action: 'click', selectors: ['button[data-testid="place-order"]'], commit: true },
  ],
  confirmation: { selectors: ['[data-testid="order-confirmation"]'] },
  challenges: [{ selectors: ['[data-testid="human-challenge"]'] }],
  navigation: { retries: 1 },
  session: {
    url: 'https://www.bestbuy.com/identity/global/signin',
    signedInSelectors: ['[data-testid="account-menu"]'],
  },
};

test('checkout recipe provider returns a validated measured recipe for one site', async () => {
  const storage = memoryStorage({
    '/recipes.json': JSON.stringify({ version: 1, sites: { target: validRecipe, bestbuy: null } }),
  });
  const provider = new CheckoutRecipeProvider({ storage, path: '/recipes.json' });
  assert.deepEqual(await provider.forSite('target'), validRecipe);
  assert.equal(await provider.forSite('bestbuy'), null);
});

test('Best Buy per-site recipe loads from scalper-browser-recipes.json and accepts the operator shape', async () => {
  const paths = [];
  const provider = new CheckoutRecipeProvider({
    storage: {
      async readText(path) {
        paths.push(path);
        return JSON.stringify({ version: 1, sites: { bestbuy: validBestBuyRecipe } });
      },
    },
  });
  const recipe = await provider.forSite('bestbuy');
  assert.deepEqual(paths, ['config/scalper-browser-recipes.json']);
  assert.equal(recipe.site, 'bestbuy');
  assert.equal(recipe.steps.at(-1).commit, true);
  assert.equal(recipe.challenges[0].id, 'challenge-1');
});

test('checkout recipes fail closed without a final commit and measured confirmation', () => {
  assert.throws(
    () => validateCheckoutRecipe({ ...validRecipe, confirmation: { selectors: [] } }, 'target'),
    /confirmation/i,
  );
  assert.throws(
    () => validateCheckoutRecipe({ ...validRecipe, steps: validRecipe.steps.slice(0, 2) }, 'target'),
    /commit/i,
  );
});

test('checkout recipes reject arbitrary script actions and commits before the last step', () => {
  assert.throws(
    () => validateCheckoutRecipe({ ...validRecipe, steps: [{ action: 'evaluate', script: 'fetch("/")' }] }, 'target'),
    /unsupported/i,
  );
  assert.throws(
    () => validateCheckoutRecipe({
      ...validRecipe,
      steps: [validRecipe.steps[2], validRecipe.steps[0]],
    }, 'target'),
    /last step/i,
  );
});

test('checkout recipes reject two commits, a non-final commit, and missing confirmation selectors', () => {
  assert.throws(() => validateCheckoutRecipe({
    ...validBestBuyRecipe,
    steps: [
      { action: 'click', selectors: ['#first'], commit: true },
      { action: 'click', selectors: ['#second'], commit: true },
    ],
  }, 'bestbuy'), /exactly one commit/i);
  assert.throws(() => validateCheckoutRecipe({
    ...validBestBuyRecipe,
    steps: [
      { action: 'click', selectors: ['#commit'], commit: true },
      { action: 'click', selectors: ['#after'] },
    ],
  }, 'bestbuy'), /last step/i);
  assert.throws(() => validateCheckoutRecipe({
    ...validBestBuyRecipe,
    confirmation: {},
  }, 'bestbuy'), /confirmation/i);
});

test('checkout recipes validate optional measured session markers', () => {
  assert.doesNotThrow(() => validateCheckoutRecipe({
    ...validRecipe,
    session: { url: 'https://www.target.com/account', signedInSelectors: ['#account'], signedOutSelectors: ['#login'] },
  }, 'target'));
  assert.throws(() => validateCheckoutRecipe({ ...validRecipe, session: { signedInSelectors: [] } }, 'target'), /signed-in/i);
});

test('checkout recipes cannot read credentials, tokens, cookies, or payment fields', () => {
  for (const valueFrom of ['account.password', 'account.cardNumber', 'account.cvv', 'session.cookie', 'session.token']) {
    assert.throws(() => validateCheckoutRecipe({
      ...validRecipe,
      steps: [
        { action: 'fill', selectors: ['#field'], valueFrom },
        validRecipe.steps[2],
      ],
    }, 'target'), /approved non-secret field/i);
  }
});
