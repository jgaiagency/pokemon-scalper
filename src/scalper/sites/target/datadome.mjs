export function inspectDataDome(response = {}) {
  const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const challenged = response.status === 403 && (Boolean(headers['x-datadome']) || /captcha|datadome/i.test(String(response.body ?? '')));
  return { challenged, status: response.status, challengeHeader: headers['x-datadome'] ?? null };
}

export class DataDomeAdapter {
  constructor({ browser } = {}) { this.browser = browser; }
  async ensureTrustedSession(context) {
    // TODO(measure): Implement only the observed challenge flow. Never replace or clear the persisted browser profile.
    if (!this.browser?.handleChallenge) throw new Error('Measured DataDome challenge handler is not configured');
    return this.browser.handleChallenge({ ...context, channel: 'chrome', headless: false, preserveCookies: true });
  }
}

export function createDataDomeAdapter(options) { return new DataDomeAdapter(options); }
