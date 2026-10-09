import { readFile } from 'node:fs/promises';

export function parseEnv(source) {
  const values = {};
  for (const originalLine of String(source).split(/\r?\n/)) {
    let line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    values[key] = value;
  }
  return values;
}

export async function loadEnvFile({ path = '.env', env = process.env, readText = (file) => readFile(file, 'utf8') } = {}) {
  let source;
  try {
    source = await readText(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { loaded: false, keys: [] };
    throw error;
  }
  const keys = [];
  for (const [key, value] of Object.entries(parseEnv(source))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    keys.push(key);
  }
  return { loaded: true, keys };
}
