import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileDefault = promisify(execFileCallback);

function xml(value) {
  return String(value).replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

export function launchAgentPlist({ label, nodePath, repoDir }) {
  const logDir = join(repoDir, 'data/scalper');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string>
    <string>${xml(join(repoDir, 'src/scalper/serve.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repoDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Standard</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'launchd.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'launchd.err.log'))}</string>
</dict></plist>
`;
}

function appInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Pokemon Scalper Control</string>
  <key>CFBundleDisplayName</key><string>Pokemon Scalper Control</string>
  <key>CFBundleIdentifier</key><string>com.local.pokemon-scalper.control</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>pokemon-scalper-control</string>
</dict></plist>
`;
}

export async function installLocalService({
  env = process.env,
  home = env.HOME,
  repoDir = resolve('.'),
  nodePath = process.execPath,
  label = 'com.local.pokemon-scalper',
  dashboardUrl = `http://${env.SCALPER_DASHBOARD_HOST || '127.0.0.1'}:${env.SCALPER_DASHBOARD_PORT || 4317}`,
  load = false,
  sign = true,
  platform = process.platform,
  makeDirectory = (path) => mkdir(path, { recursive: true }),
  writeText = (path, value, mode) => writeFile(path, value, { encoding: 'utf8', mode }),
  makeExecutable = (path) => chmod(path, 0o755),
  execFile = execFileDefault,
  uid = process.getuid?.(),
} = {}) {
  if (platform !== 'darwin') throw new Error('The local service installer currently supports macOS only');
  if (!home || !repoDir || !nodePath) throw new Error('Installer requires home, repository, and Node paths');
  if (load && env.SCALPER_INSTALL_ACK !== '1') throw new Error('Set SCALPER_INSTALL_ACK=1 to load the 24/7 LaunchAgent');
  const agentsDir = join(home, 'Library/LaunchAgents');
  const plistPath = join(agentsDir, `${label}.plist`);
  const appDir = join(home, 'Applications/Pokemon Scalper Control.app');
  const contentsDir = join(appDir, 'Contents');
  const executableDir = join(contentsDir, 'MacOS');
  const executablePath = join(executableDir, 'pokemon-scalper-control');
  await makeDirectory(agentsDir);
  await makeDirectory(join(repoDir, 'data/scalper'));
  await makeDirectory(executableDir);
  await writeText(plistPath, launchAgentPlist({ label, nodePath, repoDir }), 0o600);
  await writeText(join(contentsDir, 'Info.plist'), appInfoPlist(), 0o600);
  await writeText(executablePath, `#!/bin/zsh\n/usr/bin/open ${JSON.stringify(dashboardUrl)}\n`, 0o700);
  await makeExecutable(executablePath);
  if (sign) await execFile('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appDir]);
  if (load) {
    await execFile('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  }
  return { plistPath, appDir, dashboardUrl, loaded: load, signed: sign };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await installLocalService({ load: process.argv.slice(2).includes('--load') });
  console.log(JSON.stringify(result, null, 2));
}
