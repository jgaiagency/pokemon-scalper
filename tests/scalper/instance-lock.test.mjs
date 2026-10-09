import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../../src/scalper/instance-lock.mjs';

test('an atomic instance lock rejects a second process and releases cleanly', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-lock-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await acquireInstanceLock({ dataDir, token: 'first' });
  await assert.rejects(acquireInstanceLock({ dataDir, pid: process.pid + 1, token: 'second' }), (error) => error.code === 'SCALPER_INSTANCE_LOCKED');
  await first.release();
  const second = await acquireInstanceLock({ dataDir, token: 'second' });
  await second.release();
});

test('a stale lock owned by a dead process is replaced', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'scalper-lock-stale-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, '.lock'), JSON.stringify({ pid: 999, token: 'stale' }));
  const recovered = await acquireInstanceLock({ dataDir, token: 'recovered', isProcessAlive: () => false });
  await recovered.release();
});
