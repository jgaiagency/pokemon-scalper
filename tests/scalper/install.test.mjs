import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocalService, launchAgentPlist } from '../../src/scalper/install.mjs';

test('LaunchAgent uses the exact local Node, repository, dashboard service, and private logs', () => {
  const plist = launchAgentPlist({ label: 'com.test.scalper', nodePath: '/node', repoDir: '/repo & private' });
  assert.match(plist, /<string>\/node<\/string>/);
  assert.match(plist, /src\/scalper\/serve\.mjs/);
  assert.match(plist, /\/repo &amp; private/);
  assert.match(plist, /launchd\.err\.log/);
});

test('installer writes a LaunchAgent and local app shortcut without loading by default', async () => {
  const writes = [];
  const result = await installLocalService({
    home: '/Users/test', repoDir: '/repo', nodePath: '/node', load: false, sign: false, platform: 'darwin',
    makeDirectory: async () => {},
    writeText: async (...args) => writes.push(args),
    makeExecutable: async () => {},
  });
  assert.equal(result.loaded, false);
  assert.match(result.plistPath, /Library\/LaunchAgents/);
  assert.ok(writes.some(([path, value, mode]) => path.endsWith('.plist') && value.includes('serve.mjs') && mode === 0o600));
  assert.ok(writes.some(([path, value]) => path.endsWith('pokemon-scalper-control') && value.includes('/usr/bin/open')));
});

test('loading the persistent service requires an explicit acknowledgement', async () => {
  await assert.rejects(installLocalService({
    env: {}, home: '/Users/test', repoDir: '/repo', nodePath: '/node', load: true, sign: false, platform: 'darwin',
    makeDirectory: async () => {}, writeText: async () => {}, makeExecutable: async () => {}, execFile: async () => {},
  }), /SCALPER_INSTALL_ACK/);
});
