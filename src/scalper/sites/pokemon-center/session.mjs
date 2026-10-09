export class PokemonCenterSession {
  constructor({ accounts, auth } = {}) {
    if (!accounts) throw new Error('PokemonCenterSession requires an account manager');
    if (!auth) throw new Error('PokemonCenterSession requires an injected auth interface');
    this.accounts = accounts;
    this.auth = auth;
  }

  async ensure(account) {
    const existing = await this.accounts.loadSession(account);
    if (existing && (await this.auth.validate?.(existing, account)) !== false) return existing;
    let fresh;
    if (existing && this.auth.refresh) fresh = { ...existing, ...await this.auth.refresh(existing, account) };
    else if (this.auth.login) fresh = await this.auth.login(account, { previousSession: existing });
    else throw new Error('No measured Pokémon Center login/refresh adapter is configured');
    await this.accounts.saveSession(account, fresh);
    return fresh;
  }

  refresh(account) {
    return this.ensure(account);
  }
}

export function createSession(options) { return new PokemonCenterSession(options); }
