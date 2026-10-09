import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserProfileSessionManager,
  openBrowserSession,
} from '../../src/scalper/browser-session.mjs';

test('live browser session manager reuses the measured site and account profile', async () => {
  const manager = new BrowserProfileSessionManager({
    site: 'target',
    dataDir: '/private',
    pathExists: async (path) => path === '/private/browser-profiles/target-tgt-1',
    now: () => 123,
  });
  assert.deepEqual(await manager.ensure({ id: 'tgt-1' }), {
    type: 'browser-profile',
    site: 'target',
    accountId: 'tgt-1',
    profileDir: '/private/browser-profiles/target-tgt-1',
    validatedAt: 123,
  });
});

test('live browser session manager fails closed when onboarding has not created a profile', async () => {
  const manager = new BrowserProfileSessionManager({ site: 'bestbuy', pathExists: async () => false });
  await assert.rejects(manager.ensure({ id: 'bb-1' }), (error) => error.code === 'SCALPER_SESSION_NOT_ONBOARDED');
});

test('live browser session manager rejects an unmarked profile directory', async () => {
  const manager = new BrowserProfileSessionManager({
    site: 'target',
    accounts: { loadSession: async () => null },
    pathExists: async () => true,
  });
  await assert.rejects(manager.ensure({ id: 'tgt-1' }), (error) => error.code === 'SCALPER_SESSION_NOT_ONBOARDED');
});

test('manual session onboarding opens visible persistent Chrome and saves only profile metadata', async () => {
  const launches = [];
  const saved = [];
  const page = { goto: async (...args) => launches.push(['goto', ...args]) };
  const context = { pages: () => [page], close: async () => launches.push(['close']) };
  const result = await openBrowserSession({
    site: 'target',
    account: { id: 'tgt-1', email: 'buyer@example.test' },
    accounts: { saveSession: async (...args) => saved.push(args) },
    dataDir: '/private',
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async (...args) => {
          launches.push(['launch', ...args]);
          return context;
        },
      },
    }),
    waitForOperator: async () => {},
    now: () => 456,
  });
  assert.equal(launches[0][1], '/private/browser-profiles/target-tgt-1');
  assert.equal(launches[0][2].headless, false);
  assert.equal(launches[0][2].channel, 'chrome');
  assert.match(launches[1][1], /^https:\/\/www\.target\.com/);
  assert.deepEqual(saved[0][1], result);
  assert.equal(result.validatedAt, 456);
  assert.equal('password' in result, false);
});

test('stale browser sessions are revalidated and expired sessions fail closed', async () => {
  const session = {
    type: 'browser-profile', site: 'target', accountId: 'tgt-1',
    profileDir: '/private/browser-profiles/target-tgt-1', validatedAt: 100,
  };
  const saved = [];
  const manager = new BrowserProfileSessionManager({
    site: 'target', dataDir: '/private', now: () => 1_000, maxValidationAgeMs: 500,
    accounts: { loadSession: async () => session, saveSession: async (_account, value) => saved.push(value) },
    pathExists: async () => true,
    validator: async () => ({ valid: true, reason: 'signed-in-selector' }),
  });
  assert.equal((await manager.ensure({ id: 'tgt-1' })).validatedAt, 1_000);
  assert.equal(saved[0].sessionHealth, 'signed-in-selector');

  const expired = new BrowserProfileSessionManager({
    site: 'target', dataDir: '/private', now: () => 1_000, maxValidationAgeMs: 500,
    accounts: { loadSession: async () => session }, pathExists: async () => true,
    validator: async () => ({ valid: false, reason: 'signed-out-selector' }),
  });
  await assert.rejects(expired.ensure({ id: 'tgt-1' }), (error) => error.code === 'SCALPER_SESSION_EXPIRED');
});
