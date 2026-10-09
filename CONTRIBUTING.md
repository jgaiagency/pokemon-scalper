# Contributing

Read `docs/ARCHITECTURE.md`, `SECURITY.md`, and `docs/OPERATOR-RUNBOOK.md`
before changing an execution path. Historical phase briefs explain why parts
of the system exist; current behavior is defined by source, tests, and the
architecture document.

## Local setup

```bash
npm ci
cp .env.example .env
cp config/scalper-accounts.example.json config/scalper-accounts.json
cp config/scalper-discord.example.json config/scalper-discord.json
npm test
npm run scalper:doctor
npm run scalper:smoke
```

The copied files are local and ignored. Keep `SCALPER_LIVE=0` and
`SCALPER_KILL_SWITCH=1` during development. Tests must not require a retailer,
Discord, a real browser session, a Keychain item, or network access.

## Change rules

- Preserve dependency injection at network, clock, storage, browser, sleep,
  and ID boundaries so tests remain deterministic.
- Add a focused `node:test` case for every behavior change and a false-positive
  or failure-path sibling for parsers and safety logic.
- Treat selectors, undocumented endpoints, response fields, prices, and WAF
  behavior as measurements. Record the date and evidence in
  `docs/MEASUREMENT-LOG.md`; do not guess a live contract.
- Keep checkout recipes declarative. The final irreversible action must be
  explicitly marked, and confirmation must use an independently measured
  signal.
- Never retry an ambiguous submission. Persist it as `uncertain` and require
  reconciliation against retailer order history.
- Do not add CAPTCHA bypasses, stealth patches, fingerprint spoofing, account
  rotation, residential-proxy automation, or Discord user-token automation.
- Do not weaken the kill switch, budgets, duplicate protection, seller checks,
  price caps, URL policy, traffic governor, or live canary gate to make a test
  pass.

## Verification

```bash
npm test
npm run security:scan
npm run scalper:doctor
npm run scalper:smoke
npm run scalper:e2e
npm run scalper:simulate
git diff --check
```

Before a pull request, document the user-visible behavior, tests run, config or
schema changes, migration impact, rollback path, and any remaining
`TODO(measure)` boundary. Never attach `data/`, `.env`, local account config,
HAR/trace archives, screenshots containing identity data, Discord routing IDs,
or full retailer responses.
