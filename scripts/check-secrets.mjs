#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = new Set(process.argv.slice(2));
const scanHistory = argv.has('--history');
const scanWorktree = argv.has('--worktree');

const secretPatterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['discord-token', /\b(?:mfa\.[A-Za-z0-9_-]{50,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})\b/g],
  ['discord-webhook', /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ['npm-token', /\/\/:_authToken\s*=\s*[^\s${][^\s]*/g],
  ['literal-bearer', /\bAuthorization\s*[:=]\s*["']Bearer\s+[A-Za-z0-9._~-]{16,}["']/gi],
  ['credentialed-url', /https?:\/\/(?!(?:user|example):(?:secret|password|example)@)[^\s/:@]+:[^\s/@]+@/g],
  // Discord snowflakes are routing metadata rather than authentication
  // credentials, but publishing them exposes private server topology.
  ['private-routing-id', /\b\d{17,20}\b/g],
];

const forbiddenCurrentPaths = [
  ['environment-file', /(^|\/)\.env(?:\..+)?$/],
  ['local-account-config', /^config\/scalper-accounts\.json$/],
  ['local-discord-config', /^config\/scalper-discord\.json$/],
  ['runtime-data', /^data\/(?!scalper\/\.gitkeep$)/],
  ['credential-artifact', /\.(?:har|pem|key|p12|pfx|sqlite3?|db(?:-.+)?|backup|trace\.zip)$/i],
];

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}

function nullList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function currentFiles() {
  if (scanWorktree) return nullList(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 'buffer'));
  return nullList(git(['ls-files', '-z'], 'buffer'));
}

function plausibleSecret(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized) return false;
  return !/^(?:env:|keychain:|process\.env|\$\{|<|replace|example|sample|dummy|fake|test|null$|undefined$)/i.test(normalized);
}

function scanText(text, location, findings) {
  if (text.includes('\0')) return;
  for (const [rule, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.add(`${rule}\t${location}`);
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const envMatch = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (envMatch && plausibleSecret(envMatch[2])) findings.add(`populated-secret-assignment\t${location}:${index + 1}`);

    const jsonMatch = line.match(/"(?:password|token|secret|clientSecret|privateKey|apiKey)"\s*:\s*"([^"]+)"/i);
    if (jsonMatch && plausibleSecret(jsonMatch[1])) findings.add(`literal-json-secret\t${location}:${index + 1}`);
  }
}

function scanCurrent(findings) {
  for (const path of currentFiles()) {
    for (const [rule, pattern] of forbiddenCurrentPaths) {
      if (path === '.env.example') continue;
      if (pattern.test(path)) findings.add(`${rule}\t${path}`);
    }
    try {
      const data = readFileSync(path);
      if (data.length <= 10 * 1024 * 1024) scanText(data.toString('utf8'), path, findings);
    } catch (error) {
      findings.add(`unreadable-file\t${path} (${error.code ?? error.message})`);
    }
  }
}

function scanGitHistory(findings) {
  const objects = git(['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean);
  const seen = new Set();
  for (const row of objects) {
    const separator = row.indexOf(' ');
    if (separator < 0) continue;
    const object = row.slice(0, separator);
    const path = row.slice(separator + 1);
    if (seen.has(object)) continue;
    seen.add(object);
    try {
      if (git(['cat-file', '-t', object]).trim() !== 'blob') continue;
      const size = Number(git(['cat-file', '-s', object]).trim());
      if (!Number.isFinite(size) || size > 10 * 1024 * 1024) continue;
      const data = git(['cat-file', '-p', object], 'buffer');
      scanText(data.toString('utf8'), `history:${path}@${object.slice(0, 8)}`, findings);
    } catch {
      findings.add(`unreadable-history-object\t${path}@${object.slice(0, 8)}`);
    }
  }

  const identities = git(['log', '--all', '--format=%H%x09%ae']).trim().split('\n').filter(Boolean);
  for (const row of identities) {
    const [commit, email = ''] = row.split('\t');
    if (/\.local$/i.test(email)) findings.add(`local-author-email\thistory:${commit.slice(0, 8)}`);
  }
}

const findings = new Set();
scanCurrent(findings);
if (scanHistory) scanGitHistory(findings);

if (findings.size) {
  console.error(`Credential scan failed with ${findings.size} finding(s):`);
  for (const finding of [...findings].sort()) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Credential scan passed (${scanHistory ? 'tracked files and history' : scanWorktree ? 'shareable worktree files' : 'tracked files'}).`);
}
