import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

async function git(root, args) {
  return (await execFileAsync('git', args, { cwd: root })).stdout.trim();
}

export async function createRelease({
  root = process.cwd(),
  runGit = (args) => git(root, args),
  now = Date.now,
  tag = true,
} = {}) {
  const status = await runGit(['status', '--porcelain']);
  if (status) throw new Error('Release requires a clean Git worktree');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = await readFile(join(root, 'package-lock.json'));
  const sourceSha = await runGit(['rev-parse', 'HEAD']);
  const tagName = `scalper-v${packageJson.version}`;
  const manifest = {
    version: 1,
    release: packageJson.version,
    tag: tagName,
    sourceSha,
    lockfileSha256: createHash('sha256').update(lock).digest('hex'),
    createdAt: new Date(now()).toISOString(),
    compatibility: { node: '22.14.0', playwright: '1.63.0', chrome: '154.0.8037.95' },
  };
  const releaseDir = join(root, 'releases');
  const path = join(releaseDir, `${tagName}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(releaseDir, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' });
  try {
    if (tag) await runGit(['tag', '-a', tagName, sourceSha, '-m', `Immutable release ${tagName}`]);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path, manifest, tagged: tag };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await createRelease({ tag: !process.argv.includes('--manifest-only') });
  console.log(JSON.stringify(result, null, 2));
}
