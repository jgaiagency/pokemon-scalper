import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaperSessionManager,
  createAccountSelector,
  createRuntimeLane,
} from '../../src/scalper/runtime.mjs';

test('paper account selection rotates configured accounts and synthesizes an empty site', async () => {
  const accounts = {
    accountsFor: async (site) => site === 'target'
      ? [{ id: 't1', email: 'one@example.test' }, { id: 't2', email: 'two@example.test' }]
      : [],
  };
  const selector = createAccountSelector({ accounts, live: false });
  assert.equal((await selector.select('target')).id, 't1');
  assert.equal((await selector.select('target')).id, 't2');
  assert.equal((await selector.select('bestbuy')).id, 'paper-bestbuy');
});

test('live account selection rejects placeholders and missing credentials', async () => {
  const selector = createAccountSelector({
    accounts: { accountsFor: async () => [{ id: 't1', email: 'replace-me@example.com', password: null }] },
    live: true,
  });
  await assert.rejects(selector.select('target'), /configured live account/);
});

test('runtime lane injects an account and paper session into detection and checkout', async () => {
  const calls = [];
  const rawLane = {
    run: async (input) => { calls.push(input); return { status: 'paper-confirmed' }; },
    checkout: async (input) => { calls.push(input); return { status: 'paper-confirmed' }; },
  };
  const lane = createRuntimeLane({
    site: 'target',
    lane: rawLane,
    accountSelector: { select: async () => ({ id: 'paper-target' }) },
    sessionManager: new PaperSessionManager({ now: () => 123 }),
  });
  await lane.run({ drop: { id: 'p1' } });
  await lane.checkout({ drop: { id: 'p1' } });
  assert.equal(calls[0].account.id, 'paper-target');
  assert.equal(calls[0].sessionManager.constructor.name, 'PaperSessionManager');
  assert.equal(calls[1].account.id, 'paper-target');
  assert.deepEqual(calls[1].session, { paper: true, accountId: 'paper-target', createdAt: 123 });
});
