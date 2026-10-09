import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openScalperDatabase } from '../../src/scalper/db.mjs';
import { createBackup } from '../../src/scalper/backup.mjs';

test('backup takes a consistent SQLite snapshot plus config into a 0600 bundle', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'scalper-backup-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'scalper-test.json'), '{"safe":true}\n');
  const database = openScalperDatabase({ path: join(dataDir, 'scalper.db') });
  database.prepare('INSERT INTO seen_messages (message_id, channel_id, at) VALUES (?, ?, ?)').run('m1', 'c1', 1);
  database.close();
  const result = await createBackup({ dataDir, configDir, now: () => 1_000 });
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  const bundle = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(bundle.encryption, 'none');
  assert.deepEqual(bundle.files.map((file) => file.path).sort(), ['config/scalper-test.json', 'scalper.db']);
});

test('backup exposes an operator encryption seam without writing plaintext output', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'scalper-backup-encrypted-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'), { recursive: true });
  const database = openScalperDatabase({ path: join(root, 'data', 'scalper.db') });
  database.close();
  const result = await createBackup({
    dataDir: join(root, 'data'), configDir: join(root, 'config'), now: () => 2_000,
    encrypt: async () => Buffer.from('ciphertext'),
  });
  assert.equal(result.encrypted, true);
  assert.equal(await readFile(result.path, 'utf8'), 'ciphertext');
});
