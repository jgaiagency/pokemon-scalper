import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelease } from '../../src/scalper/release.mjs';

test('release manifest pins source SHA, lockfile hash, and runtime compatibility', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'scalper-release-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const result = await createRelease({
    root, tag: false, now: () => 0,
    runGit: async (args) => args[0] === 'status' ? '' : 'abc123',
  });
  const manifest = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(manifest.tag, 'scalper-v1.2.3');
  assert.equal(manifest.sourceSha, 'abc123');
  assert.equal(manifest.lockfileSha256.length, 64);
  assert.equal(manifest.compatibility.node, '22.14.0');
});
