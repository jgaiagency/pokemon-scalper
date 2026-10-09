const DISCORD_WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\//i;

function displayName(value) {
  return String(value).split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function fieldValue(value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return String(rendered ?? 'unknown').slice(0, 1_024) || 'unknown';
}

export function formatAlertWebhookPayload(webhookUrl, body) {
  if (!DISCORD_WEBHOOK.test(webhookUrl)) return body;
  const { event, timestamp, ...details } = body;
  return {
    username: 'Pokemon Scalper Alerts',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: displayName(event),
      color: event === 'purchase-failed' || event === 'clock-drift'
        ? 0xED4245
        : event === 'challenge-required' || event === 'purchase-uncertain'
          ? 0xFEE75C
          : 0x57F287,
      timestamp: new Date(timestamp).toISOString(),
      fields: Object.entries(details).slice(0, 25).map(([name, value]) => ({
        name: displayName(name).slice(0, 256),
        value: fieldValue(value),
        inline: true,
      })),
    }],
  };
}

export class AlertManager {
  #webhookUrl;
  #transport;
  #sms;
  #now;
  #events;

  constructor({ webhookUrl = process.env.SCALPER_ALERT_WEBHOOK_URL || process.env.SCALPER_DISCORD_WEBHOOK_URL, transport, sms, now = Date.now, events } = {}) {
    this.#webhookUrl = webhookUrl;
    this.#transport = transport;
    this.#sms = sms;
    this.#now = now;
    this.#events = events;
  }

  async #record(event, details) {
    try { await this.#events?.record?.(event, details); } catch { /* Telemetry must never break alert delivery. */ }
  }

  async send(event, details = {}) {
    if (!this.#webhookUrl && !this.#sms?.send) {
      await this.#record('alert-delivery', { event, outcome: 'not-configured' });
      return { delivered: false, reason: 'not-configured' };
    }
    const body = { event, timestamp: this.#now(), ...details };
    const channels = [];
    try {
      if (this.#webhookUrl) {
        if (!this.#transport?.postJson) throw new Error('Alert webhook transport must be injected');
        const response = await this.#transport.postJson(
          this.#webhookUrl,
          formatAlertWebhookPayload(this.#webhookUrl, body),
        );
        if (response?.status >= 400) {
          const error = new Error(`Alert webhook rejected the request with HTTP ${response.status}`);
          error.code = 'SCALPER_ALERT_WEBHOOK_FAILED';
          error.status = response.status;
          throw error;
        }
        channels.push('webhook');
      }
      if (this.#sms?.send) {
        await this.#sms.send(body);
        channels.push('sms');
      }
    } catch (error) {
      await this.#record('alert-delivery', { event, outcome: 'failed', error: error.message, code: error.code, status: error.status });
      throw error;
    }
    await this.#record('alert-delivery', { event, outcome: 'delivered', channels });
    return { delivered: true, channels, body };
  }

  dropDetected(details) { return this.send('drop-detected', details); }
  purchaseConfirmed(details) { return this.send('purchase-confirmed', details); }
  purchaseFailed(details) { return this.send('purchase-failed', details); }
  purchaseUncertain(details) { return this.send('purchase-uncertain', details); }
  challengeRequired(details) { return this.send('challenge-required', details); }
  clockDrift(details) { return this.send('clock-drift', details); }
}

export function createAlertManager(options) {
  return new AlertManager(options);
}
