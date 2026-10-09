# Deploy and rollback

## Pinned compatibility

- CI/runtime baseline: **Node 26.8.2** (pinned in `.github/workflows/ci.yml`). `node:sqlite` is stable on Node 26 and emits no experimental warning there.
- Minimum: Node 22.5.0 (the `node:sqlite` API floor). On Node 22 the module is still experimental, so the `--experimental-sqlite` flag (already in the `test` script) is required and an experimental warning is expected.
- Locally verified during this phase: Node 26.8.2.
- `discord.js`: 14.27.0 from `package-lock.json`.
- Playwright: 1.63.0 from `package-lock.json`.
- System Chrome used locally: 154.0.8037.95.

Use `npm ci`; do not substitute a fresh dependency resolution during deployment. Chrome is the visible system browser and must be validated again after a Chrome or Playwright update.

## Build and verify

```bash
npm ci
npm test
npm run scalper:doctor
npm run scalper:smoke
```

Before live mode, populate the measured endpoints, recorded Pokémon Center contracts, author allowlist, account sessions, and checkout recipe. Run `npm run scalper:canary -- pokemon-center`; it is inspection-only and must report no blockers. Do not use the live service for endpoint discovery.

## Back up and deploy

```bash
npm run scalper:backup
npm run scalper:release
npm run scalper:install -- --acknowledge-persistence
```

The backup bundle is `0600`. By default it is not encrypted; `createBackup({ encrypt })` is the operator encryption seam and must be supplied before storing a backup off-host. The service takes an atomic single-instance lock at `data/scalper/.lock`.

Release creates an annotated `scalper-v<version>` tag at the clean source commit and a `releases/` manifest containing the source SHA, lockfile hash, and compatibility pins. Commit the generated manifest after confirming the tag.

## Rollback

1. Activate `SCALPER_KILL_SWITCH=1` and stop the LaunchAgent.
2. Select a prior `releases/scalper-v*.json` manifest.
3. Check out its `sourceSha` in a fresh deployment directory and run `npm ci`.
4. Restore the matching backup into a separate data directory and run `npm run scalper:doctor` in paper mode.
5. Point the LaunchAgent at that immutable directory, restart it in paper mode, and repeat the canary-readiness review before any manual live arm.

Never roll the database backward in place while a process is running.
