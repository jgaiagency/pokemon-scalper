import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertManager, formatAlertWebhookPayload } from '../../src/scalper/alerts.mjs';

test('alerts send normalized webhook events through an injected transport', async () => {
  const sent = [];
  const alerts = new AlertManager({ webhookUrl: 'https://hooks.example.test/x', transport: { postJson: async (url, body) => sent.push({ url, body }) }, now: () => 123 });
  await alerts.purchaseConfirmed({ site: 'target', product: 'ETB', orderId: 'o1' });
  assert.equal(sent[0].url, 'https://hooks.example.test/x');
  assert.deepEqual(sent[0].body, { event: 'purchase-confirmed', timestamp: 123, site: 'target', product: 'ETB', orderId: 'o1' });
});

test('alerts are a safe no-op when no webhook is configured', async () => {
  const alerts = new AlertManager();
  assert.deepEqual(await alerts.dropDetected({ site: 'target' }), { delivered: false, reason: 'not-configured' });
});

test('alerts can use an injected SMS interface without adding a dependency', async () => {
  const sent = [];
  const alerts = new AlertManager({ sms: { send: async (body) => sent.push(body) }, now: () => 456 });
  const result = await alerts.purchaseFailed({ site: 'bestbuy', product: 'p1' });
  assert.equal(result.delivered, true);
  assert.deepEqual(result.channels, ['sms']);
  assert.equal(sent[0].event, 'purchase-failed');
});

test('Discord alert webhooks receive a bounded embed with mentions disabled', async () => {
  const url = 'https://discord.com/api/webhooks/123/token';
  const sent = [];
  const alerts = new AlertManager({
    webhookUrl: url,
    transport: { postJson: async (target, body) => { sent.push({ target, body }); return { status: 204 }; } },
    now: () => Date.parse('2026-10-02T12:00:00Z'),
  });
  const result = await alerts.dropDetected({ site: 'target', product: '30th Celebration Booster Bundle' });
  assert.equal(result.delivered, true);
  assert.equal(sent[0].target, url);
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
  assert.equal(sent[0].body.embeds[0].title, 'Drop Detected');
  assert.deepEqual(sent[0].body.embeds[0].fields.map((field) => field.name), ['Site', 'Product']);
});

test('alert manager reports a rejected webhook response', async () => {
  const alerts = new AlertManager({
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    transport: { postJson: async () => ({ status: 401 }) },
  });
  await assert.rejects(alerts.dropDetected({ site: 'target' }), (error) => (
    error.code === 'SCALPER_ALERT_WEBHOOK_FAILED' && error.status === 401
  ));
});

test('non-Discord webhook payloads retain the normalized event body', () => {
  assert.deepEqual(
    formatAlertWebhookPayload('https://hooks.example.test/x', { event: 'drop-detected', timestamp: 1, site: 'target' }),
    { event: 'drop-detected', timestamp: 1, site: 'target' },
  );
});

test('human challenges use a warning-colored Discord embed', () => {
  const payload = formatAlertWebhookPayload('https://discord.com/api/webhooks/1/token', {
    event: 'challenge-required', timestamp: 0, site: 'target', taskId: 'task-1',
  });
  assert.equal(payload.embeds[0].color, 0xFEE75C);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});
