import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { accountConfigured, checkCanaryReadiness } from '../../src/scalper/canary-readiness.mjs';

const readyEnv = {
  SCALPER_LIVE: '0',
  SCALPER_KILL_SWITCH: '1',
  SCALPER_MAX_ORDER_USD: '100',
  SCALPER_MAX_DAILY_SPEND_USD: '100',
  SCALPER_MAX_QUANTITY: '1',
  SCALPER_DASHBOARD_TOKEN: 'test-token',
};

test('accountConfigured accepts a real resolved account and rejects placeholder configuration', () => {
  assert.equal(accountConfigured({ id: 'bb-1', email: 'buyer@example.test', password: 'resolved-secret' }), true);
  assert.equal(accountConfigured({ id: 'bb-1', email: 'replace-me@example.com', password: 'resolved-secret' }), false);
  assert.equal(accountConfigured({ id: 'bb-1', email: 'buyer@example.test', password: null }), false);
});

test('canary gate is inspection-only and requires every safety prerequisite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-canary-'));
  const profileDir = join(dataDir, 'profile');
  await writeFile(join(dataDir, 'product-catalog.json'), JSON.stringify({ products: [{ site: 'bestbuy', url: 'https://www.bestbuy.com/product/x' }] }));
  const report = await checkCanaryReadiness({
    site: 'bestbuy', dataDir,
    env: readyEnv,
    accounts: {
      accountsFor: async () => [{ id: 'bb-1', email: 'real@example.test', password: 'secret' }],
      loadSession: async () => ({ createdAt: Date.now() }),
    },
    recipes: { forSite: async () => ({ version: 1 }) },
    burnIn: { status: async () => ({ started: true, passed: true, status: 'passed', remainingMs: 0 }) },
    tasks: { list: async () => [] },
    productEndpoints: { list: async () => [{ productId: 'p1', site: 'bestbuy', pollUrl: 'https://www.bestbuy.com/api/p1' }] },
    evidence: {
      detectionSample: { real: true, samples: [{ status: 'available' }] },
      alertDelivered: true,
      duplicateOrders: 0,
      restartReconciled: true,
      latencySamples: 10,
    },
  });
  assert.equal(report.ready, true);
  assert.equal(report.inspectionOnly, true);
  assert.equal(report.nextStep.includes('human'), true);
  assert.equal(profileDir.includes(dataDir), true);
});

async function canaryWithSession({ dataDir, profileDir, expiresAt, now }) {
  return checkCanaryReadiness({
    site: 'bestbuy',
    dataDir,
    now: () => now,
    env: readyEnv,
    accounts: {
      accountsFor: async () => [{ id: 'bb-1', email: 'buyer@example.test', password: 'resolved-secret' }],
      loadSession: async () => ({ profileDir, expiresAt }),
    },
    recipes: { forSite: async () => ({ version: 1 }) },
    burnIn: { status: async () => ({
      started: true,
      passed: true,
      status: 'passed',
      remainingMs: 0,
      summary: { alerts: { delivered: 1 }, paperOrders: { duplicates: 0, latency: { samples: 1 } } },
    }) },
    tasks: { list: async () => [] },
    productEndpoints: { list: async () => [{ productId: 'p1', site: 'bestbuy' }] },
    evidence: {
      detectionSample: { real: true, samples: [{}] },
      restartReconciled: true,
    },
  });
}

test('canary session check requires an existing profile and rejects an expired session', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-canary-session-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const profileDir = join(dataDir, 'browser-profile');
  await mkdir(profileDir);
  await writeFile(join(dataDir, 'product-catalog.json'), JSON.stringify({
    products: [{ site: 'bestbuy', url: 'https://www.bestbuy.com/product/x' }],
  }));
  const now = 10_000;

  const valid = await canaryWithSession({ dataDir, profileDir, expiresAt: now + 1, now });
  assert.equal(valid.checks.find((check) => check.name === 'dashboard-auth').pass, true);
  assert.equal(valid.checks.find((check) => check.name === 'account').pass, true);
  assert.equal(valid.checks.find((check) => check.name === 'session').pass, true);

  const expired = await canaryWithSession({ dataDir, profileDir, expiresAt: now - 1, now });
  assert.equal(expired.checks.find((check) => check.name === 'session').pass, false);
});
