import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockBrowserAdapter, createPlaywrightBrowserAdapter } from '../../../src/scalper/transports/browser.mjs';

test('mock browser checkout returns a fake order and records the complete call', async () => {
  const browser = createMockBrowserAdapter();
  const input = { product: { id: 'p1' }, account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true };
  assert.deepEqual(await browser.checkout(input), { orderId: 'mock-123', status: 'purchased' });
  assert.deepEqual(browser.calls, [{ method: 'checkout', input }]);
});

test('mock browser challenge handler is callable and logged', async () => {
  const browser = createMockBrowserAdapter();
  await browser.handleChallenge({ channel: 'chrome', headless: false, preserveCookies: true });
  assert.equal(browser.calls[0].method, 'handleChallenge');
});

test('browser checkout rejects a missing product instead of creating a false purchase', async () => {
  await assert.rejects(createMockBrowserAdapter().checkout({ account: { id: 'a1' } }), /product/i);
});

test('Playwright stub refuses unsafe launch settings before loading Playwright', async () => {
  let loaded = false;
  const browser = createPlaywrightBrowserAdapter({ loadPlaywright: async () => { loaded = true; } });
  await assert.rejects(browser.checkout({ product: { id: 'p1' }, channel: 'chrome', headless: true, preserveCookies: true }), /headless must be false/i);
  assert.equal(loaded, false);
});

test('Playwright rejects non-retailer navigation before launching Chrome', async () => {
  let loaded = false;
  const adapter = createPlaywrightBrowserAdapter({
    loadPlaywright: async () => { loaded = true; },
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'target', steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
  });
  await assert.rejects(adapter.checkout({
    site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://target.com.evil.example/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
  }), (error) => error.code === 'SCALPER_UNSAFE_NAVIGATION');
  assert.equal(loaded, false);
});

test('Playwright executes a validated measured recipe and verifies order confirmation', async () => {
  const calls = [];
  const locator = (selector) => ({
    first: () => ({
      waitFor: async (options) => calls.push(['waitFor', selector, options]),
      click: async () => calls.push(['click', selector]),
      fill: async (value) => calls.push(['fill', selector, value]),
      textContent: async () => 'Order AB-123 confirmed',
    }),
  });
  const page = {
    goto: async (...args) => calls.push(['goto', ...args]),
    locator,
    url: () => 'https://www.target.com/co-thankyou',
  };
  const context = { pages: () => [page], close: async () => calls.push(['close']) };
  const adapter = createPlaywrightBrowserAdapter({
    dataDir: '/private',
    recipeProvider: {
      forSite: async () => ({
        version: 1,
        site: 'target',
        steps: [
          { action: 'click', selectors: ['#add'] },
          { action: 'fill', selectors: ['#email'], valueFrom: 'account.email' },
          { action: 'click', selectors: ['#place-order'], commit: true },
        ],
        confirmation: {
          selectors: ['#confirmed'],
          orderId: { selector: '#order-id', pattern: 'Order ([A-Z0-9-]+)' },
        },
      }),
    },
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async (...args) => {
          calls.push(['launch', ...args]);
          return context;
        },
      },
    }),
  });
  const result = await adapter.checkout({
    site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1', bestbuy: 'https://bestbuy.example/p1' } },
    account: { id: 'tgt-1', email: 'buyer@example.test' },
    channel: 'chrome', headless: false, preserveCookies: true,
  });
  assert.equal(calls[0][1], '/private/browser-profiles/target-tgt-1');
  assert.equal(calls[1][1], 'https://www.target.com/p/p1');
  assert.ok(calls.some((call) => call[0] === 'fill' && call[2] === 'buyer@example.test'));
  assert.deepEqual(result, {
    status: 'purchased', orderId: 'AB-123',
    confirmation: { selector: '#confirmed', url: 'https://www.target.com/co-thankyou' },
  });
});

test('Playwright prewarm reuses one open persistent context for checkout', async () => {
  let launches = 0;
  let closes = 0;
  let navigations = 0;
  const page = {
    goto: async () => { navigations += 1; },
    url: () => 'https://www.target.com/confirmed',
    locator: () => ({ first: () => ({
      isVisible: async () => false,
      waitFor: async () => {},
      click: async () => {},
      textContent: async () => 'Order 1',
    }) }),
  };
  const context = { pages: () => [page], close: async () => { closes += 1; } };
  const recipeProvider = { forSite: async () => ({
    version: 1, site: 'target',
    steps: [{ action: 'click', selectors: ['#place'], commit: true }],
    confirmation: { selectors: ['#confirmed'] },
  }) };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider,
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => { launches += 1; return context; } } }),
  });
  const input = {
    site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
  };
  await adapter.prewarm(input);
  assert.equal((await adapter.checkout(input)).status, 'purchased');
  assert.equal(launches, 1);
  assert.equal(navigations, 2);
  assert.equal(closes, 0);
  await adapter.close();
  assert.equal(closes, 1);
});

test('Playwright refuses to execute the irreversible recipe step unless live is explicit', async () => {
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: {
      forSite: async () => ({
        version: 1, site: 'target',
        steps: [{ action: 'click', selectors: ['#place-order'], commit: true }],
        confirmation: { selectors: ['#confirmed'] },
      }),
    },
  });
  await assert.rejects(adapter.checkout({
    site: 'target', product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'tgt-1' }, channel: 'chrome', headless: false, preserveCookies: true,
  }), /explicit live authorization/i);
});

test('Playwright runs the pre-commit gate after locating the button and before clicking it', async () => {
  const events = [];
  const page = {
    goto: async () => {},
    url: () => 'https://www.target.com/confirmed',
    locator: (selector) => ({ first: () => ({
      isVisible: async () => false,
      waitFor: async () => { events.push(`located:${selector}`); },
      click: async () => { events.push(`clicked:${selector}`); },
      textContent: async () => 'Order 1',
    }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'target',
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  await adapter.checkout({
    site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
    beforeCommit: async () => { events.push('precommit'); },
    onProgress: async ({ state }) => { if (state === 'submitting') events.push('submitting'); },
  });
  assert.deepEqual(events.slice(0, 4), ['located:#place', 'precommit', 'submitting', 'clicked:#place']);
});

test('Playwright never clicks when the pre-commit gate blocks checkout', async () => {
  let clicks = 0;
  const blocked = Object.assign(new Error('kill switch'), { code: 'SCALPER_PRECOMMIT_BLOCKED' });
  const page = {
    goto: async () => {}, url: () => 'https://www.target.com/checkout',
    locator: () => ({ first: () => ({
      isVisible: async () => false,
      waitFor: async () => {},
      click: async () => { clicks += 1; },
    }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'target',
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  await assert.rejects(adapter.checkout({
    site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
    beforeCommit: async () => { throw blocked; },
  }), (error) => error === blocked);
  assert.equal(clicks, 0);
});

test('Playwright pauses for a detected human challenge and resumes the same task', async () => {
  let challenged = true;
  const progress = [];
  const requests = [];
  const page = {
    goto: async () => {},
    url: () => 'https://www.target.com/checkout',
    locator: (selector) => ({
      first: () => ({
        isVisible: async () => selector === '#captcha' && challenged,
        waitFor: async () => {},
        click: async () => {},
        textContent: async () => 'Order 12345',
      }),
    }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    challengeBroker: {
      request: async (input) => { requests.push(input); challenged = false; return { status: 'resumed' }; },
    },
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'target',
      challenges: [{ id: 'captcha', kind: 'captcha', selectors: ['#captcha'] }],
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  const result = await adapter.checkout({
    taskId: 'task-1', site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
    onProgress: async (event) => progress.push(event.state),
  });
  assert.equal(result.status, 'purchased');
  assert.equal(requests[0].taskId, 'task-1');
  assert.ok(progress.includes('awaiting-human'));
  assert.ok(progress.includes('resuming'));
});

test('Playwright reports an uncertain order and never retries after an unverified commit', async () => {
  let commits = 0;
  const page = {
    goto: async () => {}, url: () => 'https://www.bestbuy.com/checkout',
    locator: (selector) => ({ first: () => ({
      isVisible: async () => false,
      waitFor: async () => { if (selector === '#confirmed') throw new Error('timeout'); },
      click: async () => { if (selector === '#place') commits += 1; },
    }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'bestbuy',
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  await assert.rejects(adapter.checkout({
    site: 'bestbuy', live: true,
    product: { id: 'p1', productUrls: { bestbuy: 'https://www.bestbuy.com/site/p1/1.p' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
  }), (error) => error.code === 'SCALPER_ORDER_STATUS_UNCERTAIN');
  assert.equal(commits, 1);
});

test('Playwright reports uncertain when order ID extraction fails after commit', async () => {
  let commits = 0;
  const page = {
    goto: async () => {}, url: () => 'https://www.bestbuy.com/confirmed',
    locator: (selector) => ({ first: () => ({
      isVisible: async () => false,
      waitFor: async () => {},
      click: async () => { if (selector === '#place') commits += 1; },
      textContent: async () => { throw new Error('confirmation DOM changed'); },
    }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'bestbuy',
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'], orderId: { selector: '#order-id', pattern: 'Order (.+)' } },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  await assert.rejects(adapter.checkout({
    site: 'bestbuy', live: true,
    product: { id: 'p1', productUrls: { bestbuy: 'https://www.bestbuy.com/site/p1/1.p' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
  }), (error) => error.code === 'SCALPER_ORDER_STATUS_UNCERTAIN');
  assert.equal(commits, 1);
});

test('Playwright session validation distinguishes signed-in, signed-out, and unmeasured recipes', async () => {
  const visible = new Set(['#account']);
  const page = {
    goto: async () => {},
    locator: (selector) => ({ first: () => ({ isVisible: async () => visible.has(selector) }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    recipeProvider: { forSite: async () => ({ session: {
      url: 'https://www.target.com/account', signedInSelectors: ['#account'], signedOutSelectors: ['#login'],
    } }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  const input = { site: 'target', account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true };
  assert.equal((await adapter.validateSession(input)).valid, true);
  visible.clear(); visible.add('#login');
  assert.equal((await adapter.validateSession(input)).valid, false);

  const unmeasured = createPlaywrightBrowserAdapter({ recipeProvider: { forSite: async () => null } });
  assert.deepEqual(await unmeasured.validateSession(input), { valid: null, reason: 'session-selectors-unmeasured' });
});

test('post-submit 3DS pauses without repeating the irreversible commit', async () => {
  let challengeVisible = false;
  let commits = 0;
  let confirmations = 0;
  const page = {
    goto: async () => {}, url: () => 'https://www.target.com/payment',
    locator: (selector) => ({ first: () => ({
      isVisible: async () => selector === '#three-ds' && challengeVisible,
      click: async () => { if (selector === '#place') { commits += 1; challengeVisible = true; } },
      waitFor: async () => {
        if (selector === '#confirmed') {
          confirmations += 1;
          if (challengeVisible) throw new Error('3DS in progress');
        }
      },
      textContent: async () => 'Order 12345',
    }) }),
  };
  const adapter = createPlaywrightBrowserAdapter({
    challengeBroker: { request: async () => { challengeVisible = false; return { status: 'resumed' }; } },
    recipeProvider: { forSite: async () => ({
      version: 1, site: 'target',
      challenges: [{ id: '3ds', kind: '3ds', selectors: ['#three-ds'] }],
      steps: [{ action: 'click', selectors: ['#place'], commit: true }],
      confirmation: { selectors: ['#confirmed'] },
    }) },
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => ({ pages: () => [page], close: async () => {} }) } }),
  });
  const result = await adapter.checkout({
    taskId: 'task-3ds', site: 'target', live: true,
    product: { id: 'p1', productUrls: { target: 'https://www.target.com/p/p1' } },
    account: { id: 'a1' }, channel: 'chrome', headless: false, preserveCookies: true,
  });
  assert.equal(result.status, 'purchased');
  assert.equal(commits, 1);
  assert.equal(confirmations, 2);
});
