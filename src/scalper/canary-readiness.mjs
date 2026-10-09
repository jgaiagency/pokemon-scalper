import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './accounts.mjs';
import { BurnInManager } from './burn-in.mjs';
import { CheckoutRecipeProvider } from './checkout-recipes.mjs';
import { loadEnvFile } from './env.mjs';
import { KeychainVault } from './secret-vault.mjs';
import { createStateStore } from './state-store.mjs';
import { loadPokemonCenterContracts } from './recorded-contracts.mjs';

export function accountConfigured(account) {
  return Boolean(account?.id && account?.email && !account.email.toLowerCase().startsWith('replace-me') && account.password);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function restartReconciliationObserved(dataDir) {
  let source;
  try { source = await readFile(join(dataDir, 'operations-events.jsonl'), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return source.split(/\r?\n/).filter(Boolean).some((line) => {
    try { const value = JSON.parse(line); return value.type === 'restart-reconciliation' && value.success === true; } catch { return false; }
  });
}

export async function checkCanaryReadiness({
  site = 'bestbuy',
  env = process.env,
  dataDir = env.SCALPER_DATA_DIR || 'data/scalper',
  accounts,
  recipes = new CheckoutRecipeProvider(),
  burnIn = new BurnInManager({ env, dataDir }),
  tasks,
  stateStore,
  productEndpoints,
  evidence = {},
  now = Date.now,
} = {}) {
  const vault = new KeychainVault({ service: env.SCALPER_KEYCHAIN_SERVICE || 'com.local.pokemon-scalper' });
  const accountManager = accounts ?? new AccountManager({ env, dataDir, vault });
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  add('staged-paper-mode', env.SCALPER_LIVE !== '1', env.SCALPER_LIVE === '1' ? 'Live mode is armed; canary readiness is inspection-only' : 'Paper mode');
  add('kill-switch-staged', env.SCALPER_KILL_SWITCH === '1', env.SCALPER_KILL_SWITCH === '1' ? 'Active' : 'Set SCALPER_KILL_SWITCH=1 until the final manual arm');
  const limits = ['SCALPER_MAX_ORDER_USD', 'SCALPER_MAX_DAILY_SPEND_USD'].filter((key) => Number(env[key]) > 0);
  add('spend-limits', limits.length === 2, `${limits.length}/2 positive limits configured`);
  add('canary-quantity-one', Number(env.SCALPER_MAX_QUANTITY) === 1, `SCALPER_MAX_QUANTITY=${env.SCALPER_MAX_QUANTITY ?? 'unset'}`);
  add('dashboard-auth', Boolean(env.SCALPER_DASHBOARD_TOKEN), env.SCALPER_DASHBOARD_TOKEN ? 'Configured' : 'SCALPER_DASHBOARD_TOKEN is required');

  let siteAccounts = [];
  try { siteAccounts = await accountManager.accountsFor(site); } catch (error) { add('account', false, error.message); }
  if (!checks.some((check) => check.name === 'account')) {
    const configured = siteAccounts.filter(accountConfigured);
    add('account', configured.length >= 1, `${configured.length}/${siteAccounts.length} ${site} account(s) configured`);
    const reusable = [];
    const checkedAt = now();
    for (const account of configured) {
      const session = await accountManager.loadSession(account).catch(() => null);
      if (session && (!session.expiresAt || session.expiresAt > checkedAt) && (!session.profileDir || await exists(session.profileDir))) reusable.push(account.id);
    }
    add('session', reusable.length >= 1, `${reusable.length}/${configured.length} reusable session(s)`);
  }

  let recipe = null;
  try { recipe = await recipes.forSite(site); } catch (error) { add('measured-recipe', false, error.message); }
  if (!checks.some((check) => check.name === 'measured-recipe')) add('measured-recipe', Boolean(recipe), recipe ? 'Validated measured checkout recipe' : 'Missing');

  const catalog = await readFile(join(dataDir, 'product-catalog.json'), 'utf8').then(JSON.parse, () => ({ products: [] }));
  const siteProducts = (catalog.products ?? []).filter((product) => product.site === site && product.url);
  add('real-product-catalog', siteProducts.length > 0, `${siteProducts.length} read-only ${site} product URL(s)`);

  const burn = await burnIn.status();
  add('seven-day-burn-in', burn.passed, burn.started ? `${burn.status}; remaining ${burn.remainingMs}ms` : 'Not started');
  const ownedState = !tasks && !stateStore ? createStateStore({ path: join(dataDir, 'scalper.db'), dataDir }) : null;
  const taskStore = tasks ?? stateStore?.tasks ?? ownedState.tasks;
  const endpointStore = productEndpoints ?? stateStore?.productEndpoints ?? ownedState?.productEndpoints;
  const measuredEndpoints = await endpointStore?.list?.({ site }) ?? [];
  add('measured-poll-endpoint', measuredEndpoints.length > 0, `${measuredEndpoints.length} ${site} measured endpoint(s)`);
  const unresolved = await taskStore.list({ states: ['uncertain', 'authorized', 'launching', 'navigating', 'carting', 'checkout', 'submitting', 'confirming'] });
  ownedState?.close();
  add('no-unresolved-orders', unresolved.length === 0, `${unresolved.length} unresolved task(s)`);

  const sample = evidence.detectionSample ?? await readJson(join(dataDir, 'detection-samples', `${site}.json`));
  const sampleCount = Number(sample?.samples?.length ?? sample?.count ?? 0);
  add('detection-samples', sampleCount > 0 && sample?.real !== false, `${sampleCount} real ${site} detection sample(s)`);
  const alertDelivered = evidence.alertDelivered ?? Number(burn.summary?.alerts?.delivered ?? 0) > 0;
  add('active-alert-delivery', alertDelivered, alertDelivered ? 'At least one alert was delivered during burn-in' : 'No successful alert delivery evidence');
  const duplicates = evidence.duplicateOrders ?? burn.summary?.paperOrders?.duplicates;
  add('zero-duplicate-orders', duplicates === 0, `${duplicates ?? 'unknown'} duplicate order(s)`);
  const restartReconciled = evidence.restartReconciled ?? await restartReconciliationObserved(dataDir);
  add('restart-reconciliation', restartReconciled, restartReconciled ? 'Successful restart reconciliation observed' : 'No successful restart reconciliation evidence');
  const latencySamples = evidence.latencySamples ?? burn.summary?.paperOrders?.latency?.samples ?? 0;
  add('measured-latency', Number(latencySamples) > 0, `${latencySamples} burn-in latency sample(s)`);
  if (site === 'pokemon-center') {
    const contracts = evidence.recordedContracts ?? await loadPokemonCenterContracts();
    add('recorded-contracts', contracts.ready, contracts.ready
      ? 'All Pokémon Center recorded contracts pass'
      : `Missing: ${(contracts.missing ?? []).join(', ') || 'none'}; defects: ${(contracts.defects ?? []).join(', ') || 'none'}`);
  }
  const blockers = checks.filter((check) => !check.pass);
  return {
    ready: blockers.length === 0,
    inspectionOnly: true,
    site,
    checks,
    blockers,
    nextStep: blockers.length
      ? 'Resolve blockers and re-run this command.'
      : 'Keep the kill switch active until a human reviews this report, then arm one account and one unit manually.',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const report = await checkCanaryReadiness({ site: process.argv[2] ?? 'bestbuy' });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
