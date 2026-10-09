import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanChallengeBroker } from '../../src/scalper/challenge-broker.mjs';

function memoryStorage() {
  let value;
  return {
    async readText() {
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async writeText(_path, next) { value = next; },
  };
}

test('human challenge persists, alerts, and resumes the waiting checkout', async () => {
  const alerts = [];
  const broker = new HumanChallengeBroker({
    storage: memoryStorage(), id: () => 'challenge-1', now: () => 100,
    alerts: { challengeRequired: async (challenge) => alerts.push(challenge) },
  });
  const waiting = broker.request({ taskId: 'task-1', site: 'bestbuy', kind: 'captcha', url: 'https://bestbuy.example/checkout' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await broker.list({ status: 'pending' }))[0].id, 'challenge-1');
  assert.equal(alerts.length, 1);
  const resumed = await broker.resume('challenge-1', { actor: 'dashboard' });
  assert.equal(resumed.status, 'resumed');
  assert.equal((await waiting).status, 'resumed');
});

test('a pending challenge from a previous process cannot falsely resume a closed browser', async () => {
  const storage = memoryStorage();
  const first = new HumanChallengeBroker({ storage, id: () => 'challenge-1' });
  const waiting = first.request({ taskId: 'task-1', site: 'target', timeoutMs: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = new HumanChallengeBroker({ storage });
  await assert.rejects(restarted.resume('challenge-1'), (error) => error.code === 'SCALPER_CHALLENGE_NOT_ACTIVE');
  assert.equal((await restarted.expireInactive())[0].status, 'expired');
  await first.cancel('challenge-1');
  await assert.rejects(waiting, (error) => error.code === 'SCALPER_CHALLENGE_CANCELLED');
});

test('challenge timeout fails closed instead of continuing checkout', async () => {
  let callback;
  const broker = new HumanChallengeBroker({
    storage: memoryStorage(), id: () => 'challenge-1',
    schedule: (fn) => { callback = fn; return { unref() {} }; },
    cancelSchedule: () => {},
  });
  const waiting = broker.request({ taskId: 'task-1', site: 'pokemon-center', timeoutMs: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  await callback();
  await assert.rejects(waiting, (error) => error.code === 'SCALPER_CHALLENGE_TIMEOUT');
  assert.equal((await broker.get('challenge-1')).status, 'expired');
});

test('duplicate requests for one task share one challenge and one waiter', async () => {
  const broker = new HumanChallengeBroker({ storage: memoryStorage(), id: () => 'challenge-1' });
  const first = broker.request({ taskId: 'task-1', site: 'target' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = broker.request({ taskId: 'task-1', site: 'target' });
  await new Promise((resolve) => setImmediate(resolve));
  await broker.resume('challenge-1');
  assert.equal((await first).status, 'resumed');
  assert.equal((await second).status, 'resumed');
  assert.equal((await broker.list()).length, 1);
});
