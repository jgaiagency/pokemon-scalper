import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SUPPORTED_SITES } from './drop-calendar.mjs';

function fileStorage() {
  return {
    readText: (path) => readFile(path, 'utf8'),
    async writeText(path, value) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

async function resolveSecret(value, env, vault) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('env:')) return env[value.slice(4)] ?? null;
  if (value.startsWith('keychain:')) return vault ? vault.resolve(value) : null;
  return value;
}

export function isAuthFailure(error) {
  return error?.status === 401 || error?.status === 403 || error?.code === 'AUTH_EXPIRED';
}

export class AccountManager {
  #storage;
  #configPath;
  #env;
  #dataDir;
  #vault;

  constructor({
    storage = fileStorage(),
    configPath,
    env = process.env,
    dataDir = env.SCALPER_DATA_DIR || 'data/scalper',
    vault,
  } = {}) {
    this.#storage = storage;
    // The real account file is intentionally gitignored. Tests and alternate
    // deployments can still inject an explicit path, while operators can move
    // the local file without changing source code.
    this.#configPath = configPath ?? env.SCALPER_ACCOUNTS_PATH ?? 'config/scalper-accounts.json';
    this.#env = env;
    this.#dataDir = dataDir;
    this.#vault = vault;
  }

  async #config() {
    const parsed = JSON.parse(await this.#storage.readText(this.#configPath));
    for (const [site, accounts] of Object.entries(parsed)) {
      if (!SUPPORTED_SITES.includes(site)) throw new Error(`Unsupported account site: ${site}`);
      if (!Array.isArray(accounts)) throw new Error(`Accounts for ${site} must be an array`);
      for (const account of accounts) {
        if (!account.id || !account.email) throw new Error(`Account id and email are required for ${site}`);
      }
    }
    return parsed;
  }

  async #hydrate(account) {
    const password = await resolveSecret(account.password, this.#env, this.#vault);
    const cardReference = account.card?.secret
      ?? (account.card?.env ? `env:${account.card.env}` : account.card?.value);
    return {
      ...structuredClone(account),
      password,
      card: account.card ? {
        ...account.card,
        value: await resolveSecret(cardReference, this.#env, this.#vault),
      } : undefined,
      sessionFile: account.sessionFile ?? join(this.#dataDir, 'sessions', `${account.id}.json`),
    };
  }

  async accountsFor(site) {
    if (!SUPPORTED_SITES.includes(site)) throw new Error(`Unsupported site: ${site}`);
    return Promise.all(((await this.#config())[site] ?? []).map((account) => this.#hydrate(account)));
  }

  async allAccounts() {
    const config = await this.#config();
    return Promise.all(Object.entries(config).flatMap(([site, accounts]) => accounts.map(async (account) => ({ site, ...await this.#hydrate(account) }))));
  }

  async loadSession(account) {
    const path = account.sessionFile ?? join(this.#dataDir, 'sessions', `${account.id}.json`);
    try {
      return JSON.parse(await this.#storage.readText(path));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async saveSession(account, session) {
    const path = account.sessionFile ?? join(this.#dataDir, 'sessions', `${account.id}.json`);
    await this.#storage.writeText(path, `${JSON.stringify(session, null, 2)}\n`);
    return session;
  }

  async withSessionRefresh(account, operation, refresh) {
    try {
      return await operation(await this.loadSession(account));
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      const fresh = await refresh(await this.loadSession(account));
      await this.saveSession(account, fresh);
      return operation(fresh);
    }
  }
}

export function createAccountManager(options) {
  return new AccountManager(options);
}
