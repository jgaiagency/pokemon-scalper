import { readFile } from 'node:fs/promises';

const STEP_ACTIONS = new Set(['click', 'fill', 'select', 'check', 'waitFor', 'waitForUrl']);
const STEP_PHASES = new Set(['launching', 'navigating', 'carting', 'checkout', 'submitting', 'confirming']);
const SAFE_VALUE_PATHS = Object.freeze({
  account: new Set(['id', 'email', 'firstName', 'lastName', 'fullName', 'phone', 'address1', 'address2', 'city', 'state', 'province', 'postalCode', 'zip', 'country']),
  product: new Set(['id', 'sku', 'name']),
});

export function isAllowedRecipeValuePath(path) {
  if (typeof path !== 'string') return false;
  const [source, field, ...rest] = path.split('.');
  return rest.length === 0 && Boolean(SAFE_VALUE_PATHS[source]?.has(field));
}

function fileStorage() {
  return { readText: (path) => readFile(path, 'utf8') };
}

function requireSelectors(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((selector) => typeof selector !== 'string' || !selector.trim())) {
    throw new Error(`${label} requires at least one measured selector`);
  }
}

export function validateCheckoutRecipe(value, expectedSite) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Checkout recipe must be an object');
  if (value.version !== 1) throw new Error('Checkout recipe version must be 1');
  if (!value.site || (expectedSite && value.site !== expectedSite)) throw new Error(`Checkout recipe site must be ${expectedSite ?? 'configured'}`);
  if (!Array.isArray(value.steps) || value.steps.length === 0) throw new Error('Checkout recipe requires measured steps');

  let commitIndex = -1;
  value.steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || !STEP_ACTIONS.has(step.action)) {
      throw new Error(`Unsupported checkout recipe action at step ${index + 1}`);
    }
    if (step.action === 'waitForUrl') {
      if (typeof step.pattern !== 'string' || !step.pattern) throw new Error(`waitForUrl step ${index + 1} requires a pattern`);
      try { new RegExp(step.pattern); } catch { throw new Error(`waitForUrl step ${index + 1} has an invalid pattern`); }
    } else {
      requireSelectors(step.selectors, `Checkout recipe step ${index + 1}`);
    }
    if (['fill', 'select'].includes(step.action) && step.value === undefined && !step.valueFrom) {
      throw new Error(`${step.action} step ${index + 1} requires value or valueFrom`);
    }
    if (step.valueFrom !== undefined && !isAllowedRecipeValuePath(step.valueFrom)) {
      throw new Error(`Checkout recipe step ${index + 1} valueFrom is not an approved non-secret field`);
    }
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      throw new Error(`Checkout recipe step ${index + 1} timeoutMs must be positive`);
    }
    if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > 3)) {
      throw new Error(`Checkout recipe step ${index + 1} retries must be an integer from 0 to 3`);
    }
    if (step.phase !== undefined && !STEP_PHASES.has(step.phase)) {
      throw new Error(`Checkout recipe step ${index + 1} has an unsupported phase`);
    }
    if (step.commit) {
      if (step.action !== 'click') throw new Error('The irreversible commit step must be a click');
      if (commitIndex !== -1) throw new Error('Checkout recipe must contain exactly one commit step');
      commitIndex = index;
    }
  });
  if (commitIndex === -1) throw new Error('Checkout recipe requires an explicit commit step');
  if (commitIndex !== value.steps.length - 1) throw new Error('Checkout recipe commit must be the last step');

  requireSelectors(value.confirmation?.selectors, 'Checkout recipe confirmation');
  if (value.challenges !== undefined) {
    if (!Array.isArray(value.challenges)) throw new Error('Checkout recipe challenges must be an array');
    value.challenges.forEach((challenge, index) => {
      if (challenge?.id !== undefined && (typeof challenge.id !== 'string' || !challenge.id.trim())) {
        throw new Error(`Checkout recipe challenge ${index + 1} id must be a non-empty string`);
      }
      requireSelectors(challenge.selectors, `Checkout recipe challenge ${index + 1}`);
      if (challenge.timeoutMs !== undefined && (!Number.isFinite(challenge.timeoutMs) || challenge.timeoutMs <= 0)) {
        throw new Error(`Checkout recipe challenge ${index + 1} timeoutMs must be positive`);
      }
    });
  }
  if (value.navigation !== undefined) {
    if (!value.navigation || typeof value.navigation !== 'object') throw new Error('Checkout recipe navigation must be an object');
    if (value.navigation.retries !== undefined && (!Number.isInteger(value.navigation.retries) || value.navigation.retries < 0 || value.navigation.retries > 3)) {
      throw new Error('Checkout recipe navigation retries must be an integer from 0 to 3');
    }
  }
  if (value.session !== undefined) {
    if (!value.session || typeof value.session !== 'object') throw new Error('Checkout recipe session must be an object');
    if (value.session.url !== undefined) {
      try {
        const url = new URL(value.session.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      } catch { throw new Error('Checkout recipe session URL must be absolute HTTP(S)'); }
    }
    requireSelectors(value.session.signedInSelectors, 'Checkout recipe signed-in session');
    if (value.session.signedOutSelectors !== undefined) requireSelectors(value.session.signedOutSelectors, 'Checkout recipe signed-out session');
  }
  if (value.confirmation.orderId) {
    if (typeof value.confirmation.orderId.selector !== 'string' || !value.confirmation.orderId.selector) {
      throw new Error('Checkout recipe orderId requires a selector');
    }
    if (value.confirmation.orderId.pattern !== undefined) {
      try { new RegExp(value.confirmation.orderId.pattern); } catch { throw new Error('Checkout recipe orderId pattern is invalid'); }
    }
  }
  const recipe = structuredClone(value);
  if (recipe.challenges) {
    recipe.challenges = recipe.challenges.map((challenge, index) => ({
      ...challenge,
      id: challenge.id ?? `challenge-${index + 1}`,
    }));
  }
  return recipe;
}

export class CheckoutRecipeProvider {
  constructor({ storage = fileStorage(), path = 'config/scalper-browser-recipes.json' } = {}) {
    this.storage = storage;
    this.path = path;
  }

  async forSite(site) {
    let raw;
    try {
      raw = await this.storage.readText(this.path);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed.sites || typeof parsed.sites !== 'object') {
      throw new Error('Checkout recipe file must contain version 1 and a sites object');
    }
    const recipe = parsed.sites[site];
    return recipe == null ? null : validateCheckoutRecipe(recipe, site);
  }
}

export function createCheckoutRecipeProvider(options) {
  return new CheckoutRecipeProvider(options);
}
