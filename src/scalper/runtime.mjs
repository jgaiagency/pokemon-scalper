import { isLiveMode } from './dry-run.mjs';

function isConfiguredAccount(account) {
  return Boolean(
    account?.id
    && account?.email
    && !account.email.toLowerCase().startsWith('replace-me')
    && account.password,
  );
}

export class PaperSessionManager {
  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  async ensure(account) {
    if (!account?.id) throw new Error('Paper session requires an account');
    return { paper: true, accountId: account.id, createdAt: this.now() };
  }

  refresh(account) {
    return this.ensure(account);
  }
}

export function createAccountSelector({ accounts, live = isLiveMode(), allowSynthetic = !live } = {}) {
  if (!accounts?.accountsFor) throw new Error('Account selector requires an account manager');
  const nextIndex = new Map();
  return {
    async select(site) {
      const configured = await accounts.accountsFor(site);
      const candidates = live ? configured.filter(isConfiguredAccount) : configured;
      if (candidates.length === 0) {
        if (allowSynthetic) return { id: `paper-${site}`, site, paper: true };
        throw new Error(`No configured live account is available for ${site}`);
      }
      const index = nextIndex.get(site) ?? 0;
      nextIndex.set(site, (index + 1) % candidates.length);
      return { site, ...candidates[index] };
    },
  };
}

export function createUnavailableSessionManager(site) {
  return {
    async ensure() {
      const error = new Error(`No measured ${site} authentication adapter is configured`);
      error.code = 'SCALPER_AUTH_UNMEASURED';
      throw error;
    },
  };
}

export function createRuntimeLane({ site, lane, accountSelector, sessionManager } = {}) {
  if (!site || !lane) throw new Error('Runtime lane requires a site and lane');
  if (!accountSelector?.select) throw new Error('Runtime lane requires an account selector');
  if (!sessionManager?.ensure) throw new Error('Runtime lane requires a session manager');

  const enrich = async (input = {}, { ensureSession = false } = {}) => {
    const account = input.account ?? await accountSelector.select(site);
    return {
      ...input,
      account,
      sessionManager: input.sessionManager ?? sessionManager,
      ...(ensureSession ? { session: input.session ?? await sessionManager.ensure(account) } : {}),
    };
  };
  const wrapped = {};
  for (const method of ['warmup', 'run', 'watch', 'isStillAvailable']) {
    if (typeof lane[method] === 'function') wrapped[method] = async (input) => lane[method](await enrich(input));
  }
  if (typeof lane.checkout === 'function') wrapped.checkout = async (input) => lane.checkout(await enrich(input, { ensureSession: true }));
  if (typeof lane.fullThrottle === 'function') wrapped.fullThrottle = (input) => lane.fullThrottle(input);
  return wrapped;
}

export async function createRuntimeLanes({
  rawLanes,
  accounts,
  env = process.env,
  accountSelector = createAccountSelector({ accounts, live: isLiveMode(env) }),
  sessionManagers = {},
  sessionManagerFactories = {},
  dependencies = {},
} = {}) {
  const runtime = {};
  for (const [site, lane] of Object.entries(rawLanes ?? {})) {
    let sessionManager = sessionManagers[site];
    if (!sessionManager && sessionManagerFactories[site]) {
      sessionManager = await sessionManagerFactories[site]({ site, accounts, env, ...dependencies });
    }
    sessionManager ??= isLiveMode(env) ? createUnavailableSessionManager(site) : new PaperSessionManager();
    runtime[site] = createRuntimeLane({ site, lane, accountSelector, sessionManager });
  }
  return runtime;
}
