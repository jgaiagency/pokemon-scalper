import assert from 'node:assert/strict';
import test from 'node:test';
import { serve } from '../../src/scalper/serve.mjs';

function fakeScalper({ watch = async () => {} } = {}) {
  return {
    tasks: { markInterrupted: async () => [] },
    challengeBroker: { expireInactive: async () => [] },
    events: { record: async () => {} },
    orchestrator: { watch },
    stop: async () => {},
  };
}

test('serve releases its lock and resources when the watcher exits', async () => {
  const calls = [];
  const scalper = fakeScalper();
  scalper.stop = async () => calls.push('scalper-stop');

  const result = await serve({
    env: { SCALPER_DATA_DIR: '/tmp/scalper-serve-test', SCALPER_SIGNAL_INBOX: '0' },
    acquireLock: async () => ({ release: async () => calls.push('lock-release') }),
    create: async () => scalper,
    createDashboard: () => ({
      start: async () => ({ url: 'http://127.0.0.1:0' }),
      stop: async () => calls.push('dashboard-stop'),
    }),
    createHeartbeat: () => ({
      start: async () => {},
      stop: async () => calls.push('heartbeat-stop'),
    }),
    logger: { log() {} },
  });

  assert.deepEqual(result, { status: 'stopped' });
  assert.equal(calls.filter((call) => call === 'lock-release').length, 1);
  assert.ok(calls.includes('dashboard-stop'));
  assert.ok(calls.includes('heartbeat-stop'));
  assert.ok(calls.includes('scalper-stop'));
});

test('serve releases its lock and created resources after startup failure', async () => {
  const calls = [];
  const scalper = fakeScalper({ watch: async () => assert.fail('watch must not start') });
  scalper.stop = async () => calls.push('scalper-stop');

  await assert.rejects(serve({
    env: { SCALPER_DATA_DIR: '/tmp/scalper-serve-failure-test', SCALPER_SIGNAL_INBOX: '0' },
    acquireLock: async () => ({ release: async () => calls.push('lock-release') }),
    create: async () => scalper,
    createDashboard: () => ({
      start: async () => { throw new Error('dashboard bind failed'); },
      stop: async () => calls.push('dashboard-stop'),
    }),
    logger: { log() {} },
  }), /dashboard bind failed/);

  assert.equal(calls.filter((call) => call === 'lock-release').length, 1);
  assert.ok(calls.includes('dashboard-stop'));
  assert.ok(calls.includes('scalper-stop'));
});
