# Security policy

This repository contains source code and sanitized configuration only. It must
never contain account credentials, payment data, authenticated browser state,
Discord bot tokens, webhook secrets, API keys, captured HAR files, production
databases, or operator identity data.

## Local secret model

- Copy `.env.example` to `.env`; `.env` is ignored by Git.
- Copy `config/scalper-accounts.example.json` to
  `config/scalper-accounts.json`; the local account file is ignored by Git.
- Copy `config/scalper-discord.example.json` to
  `config/scalper-discord.json`; real Discord routing IDs remain local and the
  file is ignored by Git.
- Store passwords and payment references in macOS Keychain with
  `npm run scalper:secret -- set NAME`. JSON contains only `keychain:NAME` or
  `env:NAME` references.
- Keep authenticated browser profiles, sessions, captures, logs, SQLite files,
  burn-in evidence, and backups under `data/`; the entire runtime tree is
  ignored except for `data/scalper/.gitkeep`.
- Discord server, channel, application, and author IDs are not authentication
  secrets, but this project still treats them as private operational metadata.
  The bot token remains local in `SCALPER_DISCORD_BOT_TOKEN`.

Run `npm run security:scan` before every push. Use
`npm run security:scan -- --history` before transferring repository ownership
or changing visibility. The scanner reports the rule and location but never
prints a suspected secret. In addition to common credential formats it blocks
local config/runtime paths, Discord routing snowflakes, and machine-local Git
author addresses.

## Runtime boundaries

Paper mode is the default. Live execution requires `SCALPER_LIVE=1`, a cleared
kill switch, positive spend limits, a one-unit canary configuration, valid
local account/session state, measured retailer contracts, and a passing canary
readiness report. Human verification, OTP, queues, and 3-D Secure pause for the
operator; the project does not bypass them.

The dashboard binds only to a loopback address and requires a token in live
mode. Retailer URLs are allowlisted, redirects are checked, polling is rate
limited, and ambiguous order submissions become `uncertain` instead of being
retried.

## If a secret is exposed

1. Disable live mode and activate the kill switch.
2. Revoke or rotate the credential at its issuer. Deleting a Git commit is not
   sufficient because clones and caches may retain it.
3. Remove the value from the working tree and Git history with a dedicated
   history-rewrite tool, then force-push only after coordinating with every
   collaborator.
4. Recreate affected sessions and inspect account/order activity.

Report a vulnerability privately to the repository owner. Do not include live
credentials, cookies, payment data, or full captured responses in an issue.
