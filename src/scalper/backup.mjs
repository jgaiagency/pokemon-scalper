import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

async function filesBelow(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filesBelow(root, path));
    else if (entry.isFile()) paths.push({ path, name: join('config', relative(root, path)) });
  }
  return paths;
}

function fileEntry(name, data) {
  return {
    path: name,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    encoding: 'base64',
    data: data.toString('base64'),
  };
}

export async function createBackup({
  dataDir = process.env.SCALPER_DATA_DIR || 'data/scalper',
  configDir = 'config',
  outputDir = join(dataDir, 'backups'),
  now = Date.now,
  encrypt,
} = {}) {
  const sourcePath = join(dataDir, 'scalper.db');
  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const snapshotPath = join(outputDir, `.scalper-${process.pid}-${timestamp}.db`);
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqliteBackup(database, snapshotPath);
  } finally {
    database.close();
  }

  try {
    const configPaths = await filesBelow(configDir);
    const files = [fileEntry(basename(sourcePath), await readFile(snapshotPath))];
    for (const item of configPaths) files.push(fileEntry(item.name, await readFile(item.path)));
    const manifest = {
      version: 1,
      createdAt: now(),
      source: { dataDir, configDir },
      encryption: encrypt ? 'operator-hook' : 'none',
      files,
    };
    const plain = Buffer.from(`${JSON.stringify(manifest)}\n`);
    const output = encrypt ? Buffer.from(await encrypt(plain, { createdAt: manifest.createdAt, files: files.map(({ data, ...metadata }) => metadata) })) : plain;
    const path = join(outputDir, `scalper-${timestamp}.backup${encrypt ? '.enc' : ''}`);
    await writeFile(path, output, { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    return { path, encrypted: Boolean(encrypt), files: files.map(({ data, ...metadata }) => metadata) };
  } finally {
    await unlink(snapshotPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadEnvFile();
  const result = await createBackup({ outputDir: process.env.SCALPER_BACKUP_DIR || undefined });
  console.log(JSON.stringify({
    ...result,
    warning: result.encrypted ? undefined : 'Backup is permission-protected but not encrypted; supply the encryption hook before off-host storage.',
  }, null, 2));
}
