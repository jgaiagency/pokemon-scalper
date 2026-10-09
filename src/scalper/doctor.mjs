import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './accounts.mjs';
import { DropCalendar } from './drop-calendar.mjs';
import { loadDiscordConfig } from './discord-feed.mjs';
import { loadEnvFile } from './env.mjs';
import { isLiveMode } from './dry-run.mjs';
import { PurchaseLedger } from './safety.mjs';
import { CheckoutRecipeProvider } from './checkout-recipes.mjs';
import { HumanChallengeBroker } from './challenge-broker.mjs';
import { PurchaseTaskStore } from './task-state.mjs';
import { createStateStore, migrateLegacyState } from './state-store.mjs';

const SYSTEM_CHROME = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
]);

function configuredAccount(account) {
  return Boolean(account?.email && !account.email.toLowerCase().startsWith('replace-me') && account.password);
}

export async function runDoctor({
  env = process.env,
  nodeVersion = process.versions.node,
  accounts = new AccountManager({ env }),
  calendar = new DropCalendar(),
  discordConfig,
  pathAccess = async (path, { writable = false, executable = false } = {}) => {
    const mode = fsConstants.R_OK | (writable ? fsConstants.W_OK : 0) | (executable ? fsConstants.X_OK : 0);
    return access(path, mode).then(() => true, () => false);
  },
  chromeCandidates = env.SCALPER_BROWSER_PATH ? [env.SCALPER_BROWSER_PATH] : SYSTEM_CHROME,
  clock,
  ledger,
  tasks,
  challengeBroker,
  recipeProvider = new CheckoutRecipeProvider(),
  sites,
  dropIds,
} = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const live = isLiveMode(env);
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  add('node', nodeMajor >= 22 ? 'ok' : 'blocker', `Node ${nodeVersion}; requires 22+`);

  const dataDir = env.SCALPER_DATA_DIR || 'data/scalper';
  add('data-directory', await pathAccess(dataDir, { writable: true }) ? 'ok' : 'blocker', dataDir);
  let chromePath = null;
  for (const candidate of chromeCandidates) {
    if (await pathAccess(candidate, { executable: true })) { chromePath = candidate; break; }
  }
  add('chrome', chromePath ? 'ok' : (live ? 'blocker' : 'warning'), chromePath ?? 'System Chrome not found');

  const siteScope = sites?.length ? new Set(sites) : null;
  const dropScope = dropIds?.length ? new Set(dropIds) : null;
  let accountList = [];
  try {
    accountList = await accounts.allAccounts();
    if (siteScope) accountList = accountList.filter((account) => siteScope.has(account.site));
  } catch (error) {
    // A clean clone intentionally has no account file. That is expected in
    // paper mode and remains a hard blocker for live mode.
    add('accounts', live ? 'blocker' : 'warning', error.message);
  }
  if (!checks.some((check) => check.name === 'accounts')) {
    const ready = accountList.filter(configuredAccount);
    add('accounts', ready.length === accountList.length && ready.length > 0 ? 'ok' : (live ? 'blocker' : 'warning'), `${ready.length}/${accountList.length} configured`);
    if (accounts.loadSession) {
      let validSessions = 0;
      for (const account of accountList) {
        try {
          const session = await accounts.loadSession(account);
          const profileReady = session?.type !== 'browser-profile'
            || (session.profileDir && await pathAccess(session.profileDir));
          if (session && profileReady && (!session.expiresAt || session.expiresAt > Date.now())) validSessions += 1;
        } catch { /* A malformed session is reported as unavailable. */ }
      }
      add('sessions', validSessions === accountList.length && accountList.length > 0 ? 'ok' : (live ? 'blocker' : 'warning'), `${validSessions}/${accountList.length} currently reusable`);
    }
  }

  let drops = [];
  try {
    drops = await calendar.allDrops();
    if (siteScope) drops = drops.filter((drop) => drop.sites?.some((site) => siteScope.has(site)));
    if (dropScope) drops = drops.filter((drop) => dropScope.has(drop.id));
  } catch (error) { add('drops', 'blocker', error.message); }
  if (!checks.some((check) => check.name === 'drops')) {
    const incomplete = drops.filter((drop) => drop.sites.some((site) => !drop.productUrls?.[site] || !drop.pollUrls?.[site])
      || drop.price === null || drop.price === '' || drop.price === undefined || !Number.isFinite(Number(drop.price)));
    add('drops', drops.length > 0 && incomplete.length === 0 ? 'ok' : (live ? 'blocker' : 'warning'), `${drops.length} configured; ${incomplete.length} missing a product URL, measured poll URL, or price`);
    const needsTcgplayer = drops.some((drop) => drop.sites.includes('tcgplayer'));
    if (needsTcgplayer) {
      const tcgplayerReady = Boolean(env.TCGPLAYER_PUBLIC_KEY && env.TCGPLAYER_PRIVATE_KEY);
      add('tcgplayer-api', tcgplayerReady ? 'ok' : (live ? 'blocker' : 'warning'), tcgplayerReady
        ? 'Developer credentials configured'
        : 'TCGPLAYER_PUBLIC_KEY or TCGPLAYER_PRIVATE_KEY is missing');
    }
  }

  const requiredSites = [...new Set(drops.flatMap((drop) => drop.sites ?? []))];
  if (requiredSites.length === 0) {
    add('checkout-recipes', 'ok', 'No configured drops require a checkout recipe');
  } else {
    try {
      const configured = [];
      for (const site of requiredSites) {
        if (await recipeProvider.forSite(site)) configured.push(site);
      }
      const missing = requiredSites.filter((site) => !configured.includes(site));
      add('checkout-recipes', missing.length === 0 ? 'ok' : (live ? 'blocker' : 'warning'), missing.length
        ? `Missing measured recipes: ${missing.join(', ')}`
        : `${configured.length}/${requiredSites.length} required site recipes configured`);
    } catch (error) {
      add('checkout-recipes', 'blocker', error.message);
    }
  }

  const safetyKeys = ['SCALPER_MAX_ORDER_USD', 'SCALPER_MAX_DAILY_SPEND_USD', 'SCALPER_MAX_QUANTITY'];
  const missingSafety = safetyKeys.filter((key) => !Number.isFinite(Number(env[key])) || Number(env[key]) <= 0);
  add('live-safety', live && (missingSafety.length > 0 || env.SCALPER_KILL_SWITCH === '1') ? 'blocker' : 'ok', live
    ? (missingSafety.length ? `Missing positive values: ${missingSafety.join(', ')}` : env.SCALPER_KILL_SWITCH === '1' ? 'Kill switch is active' : 'Live limits configured')
    : 'Paper mode');
  add('dashboard-auth', env.SCALPER_DASHBOARD_TOKEN ? 'ok' : (live ? 'blocker' : 'warning'), env.SCALPER_DASHBOARD_TOKEN
    ? 'Dashboard bearer/basic token configured'
    : 'SCALPER_DASHBOARD_TOKEN is required before live mode');

  const resolvedDiscord = discordConfig ?? {};
  add('discord', resolvedDiscord.token ? 'warning' : 'warning', resolvedDiscord.token
    ? 'Authorized bot token configured; verify guild installation and Message Content intent'
    : 'Authorized bot token not configured; Discord ingestion disabled');
  if (clock) add('clock', clock.isSynchronized?.() ? 'ok' : 'blocker', `drift=${clock.driftMs?.() ?? 'unknown'}ms`);
  if (ledger?.records) {
    try {
      const unresolved = (await ledger.records()).filter((record) => ['reserved', 'uncertain'].includes(record.status));
      add('purchase-ledger', unresolved.length ? (live ? 'blocker' : 'warning') : 'ok', `${unresolved.length} unresolved reservation(s)`);
    } catch (error) {
      add('purchase-ledger', 'blocker', error.message);
    }
  }
  if (tasks?.recoverable) {
    try {
      const recoverable = await tasks.recoverable();
      const uncertain = tasks.list ? await tasks.list({ states: ['uncertain'] }) : [];
      const unresolved = recoverable.length + uncertain.length;
      add('purchase-tasks', unresolved ? (live ? 'blocker' : 'warning') : 'ok', `${recoverable.length} recoverable and ${uncertain.length} uncertain task(s)`);
    } catch (error) {
      add('purchase-tasks', 'blocker', error.message);
    }
  }
  if (challengeBroker?.list) {
    try {
      const pending = await challengeBroker.list({ status: 'pending' });
      add('human-challenges', pending.length ? (live ? 'blocker' : 'warning') : 'ok', `${pending.length} pending challenge(s)`);
    } catch (error) {
      add('human-challenges', 'blocker', error.message);
    }
  }

  const blockers = checks.filter((check) => check.status === 'blocker');
  const warnings = checks.filter((check) => check.status === 'warning');
  return { ok: blockers.length === 0, mode: live ? 'live' : 'paper', checks, blockers, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper';
  const state = createStateStore({ path: `${dataDir}/scalper.db`, dataDir });
  await migrateLegacyState({
    database: state.database,
    paths: {
      ledger: `${dataDir}/purchase-ledger.json`, tasks: `${dataDir}/purchase-tasks.json`,
      drops: process.env.SCALPER_DROPS_PATH || 'config/scalper-drops.json', challenges: `${dataDir}/challenges.json`,
      marker: `${dataDir}/scalper.db.migrated`,
    },
  });
  let discordConfig = {};
  try { discordConfig = await loadDiscordConfig({ env: process.env }); } catch { /* Report missing config through other checks. */ }
  try {
    const report = await runDoctor({
      env: process.env, discordConfig, ledger: state.ledger, tasks: state.tasks,
      challengeBroker: state.createChallengeBroker(),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    state.close();
  }
}
