import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../src/scalper/state-store.mjs';

function runWorker(script, databasePath, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, databasePath, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test('a process killed after reserve recovers to uncertain, never purchased', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-crash-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const databasePath = join(dataDir, 'scalper.db');
  const script = new URL('../fixtures/crash-reservation-worker.mjs', import.meta.url).pathname;
  const child = await runWorker(script, databasePath, dataDir);
  assert.equal(child.code, 77, child.stderr);

  const state = createStateStore({ path: databasePath, dataDir, now: () => Date.now() + 1_000 });
  try {
    assert.equal(state.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const before = (await state.tasks.list())[0];
    assert.equal(before.state, 'authorized');
    await state.tasks.markInterrupted({ olderThanMs: 0 });
    assert.equal((await state.tasks.get(before.id)).state, 'uncertain');
    const reservation = (await state.ledger.records())[0];
    assert.equal(reservation.status, 'reserved');
    assert.notEqual(reservation.status, 'purchased');
  } finally {
    state.close();
  }
});
