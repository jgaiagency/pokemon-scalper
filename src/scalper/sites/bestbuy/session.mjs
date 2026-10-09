export class BestBuySession {
  constructor({ accounts, auth } = {}) {
    if (!accounts || !auth) throw new Error('BestBuySession requires account and auth interfaces');
    this.accounts = accounts;
    this.auth = auth;
  }
  async ensure(account) {
    const existing = await this.accounts.loadSession(account);
    if (existing && (await this.auth.validate?.(existing, account)) !== false) return existing;
    let fresh;
    if (existing && this.auth.refresh) fresh = { ...existing, ...await this.auth.refresh(existing, account) };
    else if (this.auth.login) fresh = await this.auth.login(account, { previousSession: existing });
    else throw new Error('No measured Best Buy auth adapter is configured');
    await this.accounts.saveSession(account, fresh);
    return fresh;
  }
  refresh(account) { return this.ensure(account); }
}

export function createSession(options) { return new BestBuySession(options); }
