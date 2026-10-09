import { browserProfilePath, SITE_HOME_URLS } from '../browser-session.mjs';
import { CheckoutRecipeProvider, isAllowedRecipeValuePath, validateCheckoutRecipe } from '../checkout-recipes.mjs';
import { isRetailerUrl } from '../retail-url-policy.mjs';

const DEFAULT_CHALLENGES = Object.freeze([]);

function assertCheckoutInput(input) {
  if (!input?.product) throw new Error('Browser checkout requires a product');
}

function assertSafeBrowserOptions({ channel = 'chrome', headless = false, preserveCookies = true } = {}) {
  if (channel !== 'chrome') throw new Error("Browser channel must be 'chrome'");
  if (headless !== false) throw new Error('Browser headless must be false');
  if (preserveCookies !== true) throw new Error('Browser must preserve cookies');
}

export function createMockBrowserAdapter({ orderId = 'mock-123', logger } = {}) {
  const calls = [];
  return {
    calls,
    async checkout(input) {
      assertCheckoutInput(input);
      calls.push({ method: 'checkout', input });
      logger?.({ method: 'checkout', input });
      return { orderId, status: 'purchased' };
    },
    async handleChallenge(input) {
      calls.push({ method: 'handleChallenge', input });
      logger?.({ method: 'handleChallenge', input });
    },
  };
}

export function createPlaywrightBrowserAdapter({
  loadPlaywright = () => import('playwright'),
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  browserPath = process.env.SCALPER_BROWSER_PATH || undefined,
  recipeProvider = new CheckoutRecipeProvider(),
  challengeBroker,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const warmedContexts = new Map();
  const contextKey = (input) => `${input.site}:${input.account?.id ?? 'unknown'}`;
  const productUrlFor = (input) => input.product?.checkoutUrls?.[input.site]
    ?? input.product?.productUrls?.[input.site]
    ?? input.product?.url
    ?? input.product?.productUrl;
  const assertRetailerNavigation = (url, site) => {
    if (!isRetailerUrl(url, site)) {
      const error = new Error(`Browser navigation URL is not allowlisted for ${site}`);
      error.code = 'SCALPER_UNSAFE_NAVIGATION';
      throw error;
    }
    return url;
  };
  const valueFrom = (input, path) => {
    if (!isAllowedRecipeValuePath(path)) throw new Error(`Checkout recipe valueFrom is not allowed: ${path}`);
    const value = path.split('.').reduce((current, key) => current?.[key], input);
    if (value === undefined || value === null) throw new Error(`Checkout recipe value is missing: ${path}`);
    return String(value);
  };

  const visibleLocator = async (page, selectors, timeoutMs = 10_000) => {
    let lastError;
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: timeoutMs });
        return { locator, selector };
      } catch (error) {
        lastError = error;
      }
    }
    throw new AggregateError(lastError ? [lastError] : [], `None of the measured selectors became visible: ${selectors.join(', ')}`);
  };

  const report = async (input, state, details = {}) => {
    await input.onProgress?.({ state, ...details });
  };

  const detectedChallenge = async (page, recipe) => {
    for (const challenge of recipe.challenges ?? DEFAULT_CHALLENGES) {
      for (const selector of challenge.selectors) {
        try {
          if (await page.locator(selector).first().isVisible()) return challenge;
        } catch { /* Unsupported or absent selectors are not challenges. */ }
      }
    }
    return null;
  };

  const handleMeasuredChallenge = async (page, recipe, input) => {
    const challenge = await detectedChallenge(page, recipe);
    if (!challenge) return false;
    await report(input, 'awaiting-human', { kind: challenge.kind ?? challenge.id });
    if (!challengeBroker?.request) {
      const error = new Error(`Human interaction is required: ${challenge.id}`);
      error.code = 'SCALPER_HUMAN_CHALLENGE_REQUIRED';
      error.challenge = { id: challenge.id, kind: challenge.kind ?? challenge.id, url: page.url?.() };
      throw error;
    }
    await challengeBroker.request({
      taskId: input.taskId ?? `${input.site}:${input.product?.id ?? 'unknown'}`,
      site: input.site,
      kind: challenge.kind ?? challenge.id,
      message: challenge.message,
      url: page.url?.(),
      timeoutMs: challenge.timeoutMs ?? 10 * 60_000,
    });
    await report(input, 'resuming', { kind: challenge.kind ?? challenge.id });
    return true;
  };

  const runStep = async (page, step, input, { beforeAction } = {}) => {
    const timeout = step.timeoutMs ?? 10_000;
    if (step.action === 'waitForUrl') {
      await page.waitForURL(new RegExp(step.pattern), { timeout });
      return;
    }
    const { locator } = await visibleLocator(page, step.selectors, timeout);
    await beforeAction?.();
    if (step.action === 'click') await locator.click({ timeout });
    else if (step.action === 'fill') await locator.fill(step.valueFrom ? valueFrom(input, step.valueFrom) : String(step.value), { timeout });
    else if (step.action === 'select') await locator.selectOption(step.valueFrom ? valueFrom(input, step.valueFrom) : String(step.value), { timeout });
    else if (step.action === 'check') await locator.check({ timeout });
  };

  const phaseFor = (step, index) => {
    if (step.phase) return step.phase;
    if (step.commit) return 'submitting';
    if (index === 0 && step.action === 'click') return 'carting';
    return 'checkout';
  };

  const runStepWithRecovery = async (page, step, input, recipe, index) => {
    await handleMeasuredChallenge(page, recipe, input);
    const progress = { step: index + 1, action: step.action, commit: Boolean(step.commit) };
    if (!step.commit) await report(input, phaseFor(step, index), progress);
    const retries = step.commit ? 0 : (step.retries ?? 1);
    for (let attempt = 0; ; attempt += 1) {
      let commitAttempted = false;
      try {
        await runStep(page, step, input, {
          beforeAction: step.commit ? async () => {
            await input.beforeCommit?.(progress);
            await report(input, 'submitting', progress);
            commitAttempted = true;
          } : undefined,
        });
        return;
      } catch (cause) {
        if (step.commit && commitAttempted) {
          const error = new Error('The order submission result is uncertain; checkout will not be retried');
          error.code = 'SCALPER_ORDER_STATUS_UNCERTAIN';
          error.cause = cause;
          throw error;
        }
        if (step.commit) throw cause;
        const handled = await handleMeasuredChallenge(page, recipe, input);
        if (!handled && attempt >= retries) throw cause;
        if (!handled) await sleep(Math.min(2_000, 250 * (attempt + 1)));
      }
    }
  };

  const prewarm = async (input = {}) => {
    assertCheckoutInput(input);
    assertSafeBrowserOptions(input);
    if (!input.site || !input.account?.id) throw new Error('Browser prewarm requires a site and account');
    const productUrl = productUrlFor(input);
    if (!productUrl) throw new Error('Browser prewarm requires a product URL');
    assertRetailerNavigation(productUrl, input.site);
    const recipe = await recipeProvider.forSite(input.site);
    if (!recipe) {
      const error = new Error(`Playwright checkout recipe for ${input.site} has not been measured`);
      error.code = 'SCALPER_SELECTORS_UNMEASURED';
      throw error;
    }
    validateCheckoutRecipe(recipe, input.site);
    const key = contextKey(input);
    if (warmedContexts.has(key)) return warmedContexts.get(key);
    const pending = (async () => {
      const { chromium } = await loadPlaywright();
      const profile = input.session?.profileDir ?? browserProfilePath({ dataDir, site: input.site, accountId: input.account.id });
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chrome', headless: false, ...(browserPath ? { executablePath: browserPath } : {}),
      });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto(productUrl, {
          waitUntil: recipe.navigation?.waitUntil ?? 'domcontentloaded',
          ...(recipe.navigation?.timeoutMs ? { timeout: recipe.navigation.timeoutMs } : {}),
        });
        return { context, page, profile, productUrl, warmedAt: Date.now() };
      } catch (error) {
        await context.close();
        throw error;
      }
    })();
    warmedContexts.set(key, pending);
    pending.catch(() => { if (warmedContexts.get(key) === pending) warmedContexts.delete(key); });
    return pending;
  };

  return {
    prewarm,
    async validateSession(input = {}) {
      assertSafeBrowserOptions(input);
      if (!input.site || !input.account?.id) throw new Error('Browser session validation requires site and account');
      const recipe = await recipeProvider.forSite(input.site);
      if (!recipe?.session) return { valid: null, reason: 'session-selectors-unmeasured' };
      const { chromium } = await loadPlaywright();
      const profile = input.session?.profileDir ?? browserProfilePath({ dataDir, site: input.site, accountId: input.account.id });
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chrome', headless: false, ...(browserPath ? { executablePath: browserPath } : {}),
      });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        const sessionUrl = assertRetailerNavigation(recipe.session.url ?? SITE_HOME_URLS[input.site], input.site);
        await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
        for (const selector of recipe.session.signedOutSelectors ?? []) {
          try { if (await page.locator(selector).first().isVisible()) return { valid: false, reason: 'signed-out-selector', selector }; } catch { /* Ignore a missing selector. */ }
        }
        for (const selector of recipe.session.signedInSelectors) {
          try { if (await page.locator(selector).first().isVisible()) return { valid: true, reason: 'signed-in-selector', selector }; } catch { /* Ignore a missing selector. */ }
        }
        return { valid: null, reason: 'session-state-unknown' };
      } finally {
        await context.close();
      }
    },
    async checkout(input = {}) {
      assertCheckoutInput(input);
      assertSafeBrowserOptions(input);
      if (!input.site) throw new Error('Browser checkout requires a site');
      const suppliedRecipe = await recipeProvider.forSite(input.site);
      if (!suppliedRecipe) {
        const error = new Error(`Playwright checkout recipe for ${input.site} has not been measured`);
        error.code = 'SCALPER_SELECTORS_UNMEASURED';
        throw error;
      }
      const recipe = validateCheckoutRecipe(suppliedRecipe, input.site);
      if (recipe.steps.some((step) => step.commit) && input.live !== true) {
        throw new Error('Checkout commit requires explicit live authorization');
      }
      const productUrl = productUrlFor(input);
      if (!productUrl) throw new Error('Browser checkout requires a product URL');
      assertRetailerNavigation(productUrl, input.site);
      const key = contextKey(input);
      const warmed = warmedContexts.get(key) ? await warmedContexts.get(key) : null;
      const profile = warmed?.profile ?? input.session?.profileDir ?? browserProfilePath({ dataDir, site: input.site, accountId: input.account?.id });
      await report(input, 'launching', { profile, prewarmed: Boolean(warmed) });
      let context = warmed?.context;
      let page = warmed?.page;
      const pooled = Boolean(context);
      if (!context) {
        const { chromium } = await loadPlaywright();
        context = await chromium.launchPersistentContext(profile, {
          channel: 'chrome', headless: false, ...(browserPath ? { executablePath: browserPath } : {}),
        });
        page = context.pages()[0] ?? await context.newPage();
      }
      try {
        await report(input, 'navigating', { url: productUrl });
        const navigationRetries = recipe.navigation?.retries ?? 1;
        for (let attempt = 0; ; attempt += 1) {
          try {
            await page.goto(productUrl, {
              waitUntil: recipe.navigation?.waitUntil ?? 'domcontentloaded',
              ...(recipe.navigation?.timeoutMs ? { timeout: recipe.navigation.timeoutMs } : {}),
            });
            break;
          } catch (error) {
            if (attempt >= navigationRetries) throw error;
            await sleep(Math.min(2_000, 250 * (attempt + 1)));
          }
        }
        for (const [index, step] of recipe.steps.entries()) await runStepWithRecovery(page, step, input, recipe, index);
        await report(input, 'confirming');
        let confirmation;
        try {
          confirmation = await visibleLocator(page, recipe.confirmation.selectors, recipe.confirmation.timeoutMs ?? 30_000);
        } catch (cause) {
          const handled = await handleMeasuredChallenge(page, recipe, input);
          if (handled) {
            await report(input, 'confirming');
            try {
              confirmation = await visibleLocator(page, recipe.confirmation.selectors, recipe.confirmation.timeoutMs ?? 30_000);
            } catch (retryCause) {
              cause = retryCause;
            }
          }
          if (!confirmation) {
            const error = new Error('Order submission completed but confirmation could not be verified');
            error.code = 'SCALPER_ORDER_STATUS_UNCERTAIN';
            error.cause = cause;
            throw error;
          }
        }
        let orderId;
        if (recipe.confirmation.orderId) {
          try {
            const orderLocator = page.locator(recipe.confirmation.orderId.selector).first();
            const source = recipe.confirmation.orderId.attribute
              ? await orderLocator.getAttribute(recipe.confirmation.orderId.attribute)
              : await orderLocator.textContent();
            const match = source?.match(new RegExp(recipe.confirmation.orderId.pattern ?? '(.+)'));
            orderId = match?.[1]?.trim();
            if (!orderId) throw new Error('The measured order ID pattern did not match the confirmation');
          } catch (cause) {
            const error = new Error('Order submission completed but the order ID could not be extracted');
            error.code = 'SCALPER_ORDER_STATUS_UNCERTAIN';
            error.cause = cause;
            throw error;
          }
        }
        return {
          status: 'purchased', orderId: orderId ?? null,
          confirmation: { selector: confirmation.selector, url: page.url() },
        };
      } finally {
        if (!pooled) await context.close();
      }
    },
    async handleChallenge(input = {}) {
      assertSafeBrowserOptions(input);
      if (!challengeBroker?.request) {
        const error = new Error('No human challenge broker is configured');
        error.code = 'SCALPER_CHALLENGE_BROKER_MISSING';
        throw error;
      }
      await report(input, 'awaiting-human', { kind: input.kind ?? 'verification' });
      const result = await challengeBroker.request({
        taskId: input.taskId,
        site: input.site,
        kind: input.kind ?? 'verification',
        message: input.message,
        url: input.url,
        timeoutMs: input.timeoutMs,
      });
      await report(input, 'resuming', { kind: input.kind ?? 'verification' });
      return result;
    },
    async close() {
      const contexts = [];
      for (const pending of warmedContexts.values()) {
        try { contexts.push((await pending).context); } catch { /* Failed prewarms have already closed. */ }
      }
      warmedContexts.clear();
      await Promise.allSettled([...new Set(contexts)].map((context) => context.close()));
    },
  };
}
