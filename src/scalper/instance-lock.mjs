import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function existingOwner(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function acquireInstanceLock({
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  path = join(dataDir, '.lock'),
  pid = process.pid,
  now = Date.now,
  token = randomUUID(),
  isProcessAlive = processExists,
} = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      const owner = { pid, token, startedAt: now() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      return {
        path,
        owner,
        async release() {
          try {
            const current = await existingOwner(path);
            if (current?.token === token) await unlink(path);
          } finally {
            await handle.close().catch(() => {});
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await existingOwner(path);
      if (attempt === 0 && owner?.pid && !isProcessAlive(Number(owner.pid))) {
        await unlink(path).catch((unlinkError) => { if (unlinkError?.code !== 'ENOENT') throw unlinkError; });
        continue;
      }
      const locked = new Error(`Another scalper process holds ${path}${owner?.pid ? ` (pid ${owner.pid})` : ''}`);
      locked.code = 'SCALPER_INSTANCE_LOCKED';
      locked.owner = owner;
      throw locked;
    }
  }
  throw new Error(`Could not acquire instance lock ${path}`);
}
