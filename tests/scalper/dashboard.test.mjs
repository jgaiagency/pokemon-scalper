import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createDashboardHandler, createDashboardServer, KillSwitchController } from '../../src/scalper/dashboard.mjs';

function request(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  return {
    headers: {}, status: null, body: '',
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body += body; },
  };
}

async function call(handler, input) {
  const output = response();
  await handler(input, output);
  return { ...output, json: output.headers['content-type']?.startsWith('application/json') ? JSON.parse(output.body) : null };
}

test('dashboard exposes health, redacted durable state, and active challenges', async () => {
  const handler = createDashboardHandler({
    env: { SCALPER_LIVE: '0' },
    healthCheck: async () => ({ ok: true }),
    tasks: { list: async () => [{ id: 't1', state: 'awaiting-human' }] },
    challenges: { list: async () => [{ id: 'c1', status: 'pending' }] },
    ledger: { records: async () => [{ id: 'r1', status: 'reserved' }] },
    killSwitch: { status: async () => ({ active: false }) },
  });
  assert.deepEqual((await call(handler, request('GET', '/api/status'))).json, {
    mode: 'paper', health: { ok: true }, killSwitch: { active: false },
  });
  assert.equal((await call(handler, request('GET', '/api/tasks'))).json[0].state, 'awaiting-human');
  assert.equal((await call(handler, request('GET', '/api/challenges'))).json[0].status, 'pending');
  assert.equal((await call(handler, request('GET', '/api/ledger'))).json[0].status, 'reserved');
});

test('dashboard resumes an active challenge and toggles the file kill switch', async () => {
  const events = [];
  const handler = createDashboardHandler({
    challenges: { resume: async (id, details) => { events.push(['resume', id, details]); return { id, status: 'resumed' }; } },
    killSwitch: {
      status: async () => ({ active: false }),
      setActive: async (active) => { events.push(['kill', active]); return { active }; },
    },
  });
  const jsonHeaders = { 'content-type': 'application/json', origin: 'http://127.0.0.1:4317', host: '127.0.0.1:4317' };
  assert.equal((await call(handler, request('POST', '/api/challenges/c1/resume', {}, jsonHeaders))).json.status, 'resumed');
  assert.equal((await call(handler, request('POST', '/api/kill-switch', { active: true }, jsonHeaders))).json.active, true);
  assert.deepEqual(events.map((event) => event.slice(0, 2)), [['resume', 'c1'], ['kill', true]]);
});

test('dashboard authentication and loopback binding fail closed', async () => {
  const handler = createDashboardHandler({ authToken: 'token' });
  assert.equal((await call(handler, request('GET', '/api/status'))).status, 401);
  const basic = `Basic ${Buffer.from('scalper:token').toString('base64')}`;
  assert.equal((await call(handler, request('GET', '/api/tasks', undefined, { authorization: basic }))).status, 200);
  assert.throws(() => createDashboardServer({ host: '0.0.0.0' }), /loopback/i);
  assert.throws(() => createDashboardHandler({ env: { SCALPER_LIVE: '1' } }), /requires SCALPER_DASHBOARD_TOKEN/i);
});

test('dashboard rejects cross-site and non-JSON state changes', async () => {
  let mutations = 0;
  const handler = createDashboardHandler({
    killSwitch: { setActive: async () => { mutations += 1; return { active: true }; } },
  });
  assert.equal((await call(handler, request('POST', '/api/kill-switch', { active: true }))).status, 403);
  assert.equal((await call(handler, request('POST', '/api/kill-switch', { active: true }, {
    'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:4317',
  }))).status, 403);
  assert.equal((await call(handler, request('POST', '/api/kill-switch', { active: true }, {
    'content-type': 'application/json', origin: 'http://localhost:9999', host: '127.0.0.1:4317',
  }))).status, 403);
  assert.equal(mutations, 0);
});

test('file kill switch cannot override an environment kill switch', async () => {
  let file = false;
  const controller = new KillSwitchController({
    env: { SCALPER_KILL_SWITCH: '1' }, path: '/safe/KILL_SWITCH',
    exists: async () => file,
    write: async () => { file = true; },
    remove: async () => { file = false; },
  });
  assert.equal((await controller.setActive(true)).active, true);
  const afterRemove = await controller.setActive(false);
  assert.equal(afterRemove.file, false);
  assert.equal(afterRemove.environment, true);
  assert.equal(afterRemove.active, true);
});
