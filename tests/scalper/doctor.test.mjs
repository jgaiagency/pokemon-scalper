import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../../src/scalper/doctor.mjs';

test('doctor reports paper-mode placeholders as warnings rather than blockers', async () => {
  const report = await runDoctor({
    env: { SCALPER_LIVE: '0' },
    nodeVersion: '22.10.0',
    accounts: { allAccounts: async () => [{ site: 'target', id: 't1', email: 'replace-me@example.com', password: null }] },
    calendar: { allDrops: async () => [] },
    discordConfig: { token: null },
    pathAccess: async () => true,
    chromeCandidates: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  });
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((check) => check.name === 'accounts'));
  assert.ok(report.warnings.some((check) => check.name === 'drops'));
});

test('a missing local account file warns in paper mode and blocks live mode', async () => {
  const unavailableAccounts = { allAccounts: async () => { throw Object.assign(new Error('account file missing'), { code: 'ENOENT' }); } };
  const common = {
    nodeVersion: '22.10.0', accounts: unavailableAccounts,
    calendar: { allDrops: async () => [] }, discordConfig: {},
    pathAccess: async () => true, chromeCandidates: ['/chrome'],
  };
  const paper = await runDoctor({ ...common, env: { SCALPER_LIVE: '0' } });
  const live = await runDoctor({ ...common, env: { SCALPER_LIVE: '1' } });
  assert.equal(paper.blockers.some((check) => check.name === 'accounts'), false);
  assert.equal(paper.warnings.some((check) => check.name === 'accounts'), true);
  assert.equal(live.blockers.some((check) => check.name === 'accounts'), true);
});

test('doctor fails closed before live mode when budgets, accounts, prices, or endpoints are missing', async () => {
  const report = await runDoctor({
    env: { SCALPER_LIVE: '1' },
    nodeVersion: '22.10.0',
    accounts: { allAccounts: async () => [{ site: 'target', id: 't1', email: 'replace-me@example.com', password: null }] },
    calendar: { allDrops: async () => [{ id: 'p1', sites: ['target'], time: '2026-10-01T12:00:00Z', productUrls: {} }] },
    discordConfig: { token: null },
    pathAccess: async () => true,
    chromeCandidates: ['/chrome'],
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((check) => check.name === 'live-safety'));
  assert.ok(report.blockers.some((check) => check.name === 'accounts'));
  assert.ok(report.blockers.some((check) => check.name === 'drops'));
  assert.ok(report.blockers.some((check) => check.name === 'dashboard-auth'));
});

test('doctor blocks live mode when a required site has no measured checkout recipe', async () => {
  const report = await runDoctor({
    env: {
      SCALPER_LIVE: '1', SCALPER_MAX_ORDER_USD: '100',
      SCALPER_MAX_DAILY_SPEND_USD: '200', SCALPER_MAX_QUANTITY: '1',
    },
    nodeVersion: '22.10.0',
    accounts: {
      allAccounts: async () => [{ site: 'target', id: 't1', email: 'buyer@example.test', password: 'secret' }],
      loadSession: async () => ({ type: 'browser-profile' }),
    },
    calendar: {
      allDrops: async () => [{
        id: 'p1', sites: ['target'], price: 49.99,
        time: '2026-10-01T12:00:00Z', productUrls: { target: 'https://target.example/p1' },
      }],
    },
    recipeProvider: { forSite: async () => null },
    discordConfig: { token: null },
    pathAccess: async () => true,
    chromeCandidates: ['/chrome'],
  });
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((check) => check.name === 'checkout-recipes'));
});

test('doctor can scope a supervised live preflight to one exact site and drop', async () => {
  const recipeSites = [];
  const report = await runDoctor({
    env: {
      SCALPER_LIVE: '1', SCALPER_KILL_SWITCH: '0', SCALPER_DASHBOARD_TOKEN: 'token',
      SCALPER_MAX_ORDER_USD: '100', SCALPER_MAX_DAILY_SPEND_USD: '100', SCALPER_MAX_QUANTITY: '1',
    },
    nodeVersion: '22.14.0',
    sites: ['pokemon-center'],
    dropIds: ['pc-canary'],
    accounts: {
      allAccounts: async () => [
        { site: 'pokemon-center', id: 'pc-1', email: 'buyer@example.test', password: 'secret' },
        { site: 'target', id: 'tgt-1', email: 'replace-me@example.com' },
      ],
      loadSession: async () => ({ createdAt: Date.now() }),
    },
    calendar: { allDrops: async () => [
      { id: 'pc-canary', sites: ['pokemon-center'], price: 49.99, productUrls: { 'pokemon-center': 'https://www.pokemoncenter.com/product/x' }, pollUrls: { 'pokemon-center': 'https://www.pokemoncenter.com/api/x' } },
      { id: 'target-paper', sites: ['target'], price: null, productUrls: {} },
    ] },
    recipeProvider: { forSite: async (site) => { recipeSites.push(site); return { version: 1 }; } },
    discordConfig: {},
    pathAccess: async () => true,
    chromeCandidates: ['/chrome'],
  });
  assert.equal(report.ok, true);
  assert.deepEqual(recipeSites, ['pokemon-center']);
});
