import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './accounts.mjs';
import { loadEnvFile } from './env.mjs';

export const SITE_HOME_URLS = Object.freeze({
  'pokemon-center': 'https://www.pokemoncenter.com/',
  tcgplayer: 'https://www.tcgplayer.com/',
  bestbuy: 'https://www.bestbuy.com/',
  target: 'https://www.target.com/',
});

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

export function browserProfilePath({ dataDir = 'data/scalper', site, accountId }) {
  if (!SITE_HOME_URLS[site]) throw new Error(`Unsupported browser session site: ${site}`);
  if (!accountId) throw new Error('Browser session requires an account id');
  return join(dataDir, 'browser-profiles', `${safeSegment(site)}-${safeSegment(accountId)}`);
}

async function pathExists(path) {
  try { return (await stat(path)).isDirectory(); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForEnter() {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question('Log in completely in Chrome, then press Enter here to save the session profile. ');
  } finally {
    terminal.close();
  }
}

export class BrowserProfileSessionManager {
  constructor({
    site,
    accounts,
    dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
    pathExists: exists = pathExists,
    validator,
    maxValidationAgeMs = 30 * 60_000,
    now = Date.now,
  } = {}) {
    if (!SITE_HOME_URLS[site]) throw new Error(`Unsupported browser session site: ${site}`);
    this.site = site;
    this.accounts = accounts;
    this.dataDir = dataDir;
    this.pathExists = exists;
    this.validator = validator;
    this.maxValidationAgeMs = maxValidationAgeMs;
    this.now = now;
  }

  async ensure(account) {
    const profileDir = browserProfilePath({ dataDir: this.dataDir, site: this.site, accountId: account?.id });
    const metadata = await this.accounts?.loadSession?.(account);
    const metadataValid = !this.accounts || (
      metadata?.type === 'browser-profile'
      && metadata.site === this.site
      && metadata.accountId === account?.id
      && metadata.profileDir === profileDir
    );
    if (!metadataValid || !await this.pathExists(profileDir)) {
      const error = new Error(`Browser session for ${this.site}/${account?.id ?? 'unknown'} has not been onboarded; run npm run scalper:login -- ${this.site} ${account?.id ?? ''}`.trim());
      error.code = 'SCALPER_SESSION_NOT_ONBOARDED';
      throw error;
    }
    let session = metadata ?? {
      type: 'browser-profile', site: this.site, accountId: account.id,
      profileDir, validatedAt: this.now(),
    };
    const stale = !Number.isFinite(session.validatedAt) || this.now() - session.validatedAt >= this.maxValidationAgeMs;
    if (this.validator && stale) {
      const validation = await this.validator({ site: this.site, account, session, profileDir });
      const valid = typeof validation === 'boolean' ? validation : validation?.valid;
      if (valid === false) {
        const error = new Error(`Browser session for ${this.site}/${account.id} has expired; run npm run scalper:login -- ${this.site} ${account.id}`);
        error.code = 'SCALPER_SESSION_EXPIRED';
        throw error;
      }
      if (valid === true) {
        session = { ...session, validatedAt: this.now(), sessionHealth: validation?.reason ?? 'signed-in' };
        await this.accounts?.saveSession?.(account, session);
      }
    }
    return session;
  }

  refresh(account) {
    return this.ensure(account);
  }
}

export async function openBrowserSession({
  site,
  account,
  accounts,
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  browserPath = process.env.SCALPER_BROWSER_PATH || undefined,
  loadPlaywright = () => import('playwright'),
  waitForOperator = waitForEnter,
  now = Date.now,
} = {}) {
  if (!SITE_HOME_URLS[site]) throw new Error(`Unsupported browser session site: ${site}`);
  if (!account?.id) throw new Error('Browser session onboarding requires an account');
  const profileDir = browserProfilePath({ dataDir, site, accountId: account.id });
  const { chromium } = await loadPlaywright();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false,
    ...(browserPath ? { executablePath: browserPath } : {}),
  });
  let session;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(SITE_HOME_URLS[site], { waitUntil: 'domcontentloaded' });
    await waitForOperator();
    session = {
      type: 'browser-profile', site, accountId: account.id,
      profileDir, validatedAt: now(),
    };
    await accounts?.saveSession?.(account, session);
  } finally {
    await context.close();
  }
  return session;
}

export function createBrowserProfileSessionManager(options) {
  return new BrowserProfileSessionManager(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  if (process.env.SCALPER_SESSION_ACK !== '1') {
    throw new Error('Set SCALPER_SESSION_ACK=1 to acknowledge that the persistent Chrome profile contains sensitive authenticated state');
  }
  const [site, accountId] = process.argv.slice(2);
  const accounts = new AccountManager({ env: process.env });
  const candidates = await accounts.accountsFor(site);
  const account = accountId ? candidates.find((item) => item.id === accountId) : candidates[0];
  if (!account) throw new Error(`No account ${accountId || '(first)'} is configured for ${site || '(missing site)'}`);
  const result = await openBrowserSession({ site, account, accounts });
  console.log(JSON.stringify(result, null, 2));
}
