# Pokémon TCG Scalper

Autobuy sealed Pokémon TCG product (booster boxes, ETBs, premium tins) the
moment it drops. Four sites: Pokémon Center, TCGPlayer, Best Buy, Target.

**Status: the private execution platform is complete through the
measured-retailer boundary.** The shared core, transports, discovery, market
ranking, durable purchase-task state machine, macOS Keychain vault, persistent
browser sessions, human challenge/resume flow, recipe-driven automatic
checkout, local control dashboard, diagnostics, monitoring, and LaunchAgent
installer are built. Live operation remains fail-closed until each retailer's
current endpoints and selectors are measured and configured locally.

## Start here

1. `docs/ARCHITECTURE.md` — current system design, state, invariants, and extension points
2. `docs/OPERATOR-RUNBOOK.md` — local setup, measurement, recipe, and live checklist
3. `docs/HANDOFF-PHASE3.md` — remaining measured seams and supervised canary commands
4. `docs/RETAILER-MEASUREMENT-BACKLOG.md` — exact remaining work per retailer
5. `SECURITY.md` — secret handling, runtime boundaries, and incident response
6. `CONTRIBUTING.md` — development rules and verification checklist
7. `docs/SCOPE.md` and `docs/CODEX-BRIEF*.md` — scope and historical build rationale

## Commands

Install dependencies, create local configuration, and keep the service in
paper mode while developing:

```bash
npm ci
cp .env.example .env
cp config/scalper-accounts.example.json config/scalper-accounts.json
cp config/scalper-discord.example.json config/scalper-discord.json
npm run verify
```

All copied files are ignored by Git. Fill only the credentials you have; CLI
entry points load `.env` without overwriting values supplied by the shell or
launchd. Store account passwords and card references in macOS Keychain as
described in `config/README.md`, never directly in JSON.

```bash
npm test
npm run security:scan
npm run verify
npm run browsers
npm run scalper:smoke
npm run scalper:e2e
npm run scalper:simulate
npm run scalper:dry
npm run scalper:health
npm run scalper:doctor
npm run scalper:replay -- data/scalper/discord-drops.jsonl
npm run scalper:ledger -- list
npm run scalper:tasks -- list
npm run scalper:secret -- status BB1_PASS
npm run scalper:login -- target tgt-1
npm run scalper:market -- report
npm run scalper:discover
npm run scalper:ingest -- exported-discord-messages.jsonl
npm run scalper:operations
npm run scalper:burn-in -- start
npm run scalper:burn-in -- status
npm run scalper:canary -- bestbuy
npm run scalper:watch
npm run scalper:serve
npm run scalper:install
npm run scalper:discord
npm run scalper:pc -- --drop-id '<exact-local-drop-id>'
npm run scalper:tcp
npm run scalper:bb
npm run scalper:tgt
```

For manual endpoint measurement, set `SCALPER_MEASURE_ACK=1`, then run
`npm run scalper:measure -- <site> <product-url> [account-id]`. It launches a
visible persistent Chrome profile and records a private HAR, trace, and
redacted interaction-selector log while the operator performs the flow; it
does not automate clicks.

Measured checkout steps live in `config/scalper-browser-recipes.json`. The
engine accepts a small declarative action set, requires the final purchase
click to be explicitly marked, and requires a measured confirmation selector.
See `docs/OPERATOR-RUNBOOK.md` for the schema and end-to-end checklist.

After a crash during checkout, inspect `npm run scalper:ledger -- list`. A
reservation intentionally blocks another purchase until the retailer is
checked. If no order exists, set `SCALPER_LEDGER_ACK=1` and run
`npm run scalper:ledger -- release <reservation-id>`.

`SCALPER_LIVE=1` is the only value that arms a live checkout. Keep it unset or
set to `0` until a live drop succeeds end-to-end in paper mode.

`npm run scalper:e2e` is an isolated, repeatable proof of the complete paper
path. It feeds a browser-reviewed Restockd Target message through channel
tracking, structured parsing, watchlist matching, `howl.link` unwrapping,
retailer-domain validation, calendar persistence, real lane detection, safety,
orchestration, durable task state, paper checkout, and confirmation alerts. It
uses a temporary data directory and asserts that no POST, browser checkout, or
real purchase occurred.

`npm run scalper:simulate` runs a seven-scenario acceptance suite without real
accounts, payment cards, browser checkout, or outbound mutations. It covers the
Discord-to-order path, all four retailer detectors, sold-out responses,
duplicate suppression, the kill switch, invalid/noisy signal filtering, and an
alert outage after an otherwise successful paper order.

`npm run scalper:serve` runs monitoring, checkout, the human-challenge broker,
and the loopback-only dashboard in one process. Open
`http://127.0.0.1:4317`. Generate the private LaunchAgent and local
Applications shortcut with `npm run scalper:install`; loading it requires
`SCALPER_INSTALL_ACK=1 npm run scalper:install -- --load`.

## Phase 2 transport layer

`docs/CODEX-BRIEF-PHASE2.md` covers the completed transport build:
- NTP UDP transport (`node:dgram`)
- HTTP transport (`node:fetch`)
- Discord Gateway transport (`discord.js`) with SDK-managed heartbeat/resume,
  bounded caches, REST backfill, durable message dedupe, and author allowlisting
- Playwright browser adapter (interface + mock)
- Discord prose and structured-monitor parsers, with ranking and deduplication
- Cached short-link resolution and multi-product official-update fan-out
- Wiring module (`createScalper()`)
- Updated entry points

## Operational safety and tooling

- Runtime account selection and paper-session wiring for every lane
- macOS Keychain secret references and an interactive secret command
- Restart-safe purchase-task journal with uncertain-order reconciliation
- Human challenge alerts, dashboard resume, and post-submit 3DS continuation
- Loopback-only control dashboard and generated private LaunchAgent
- End-to-end paper execution through detector, orchestrator, and checkout
- Live price, quantity, per-order, and daily-spend gates
- Environment/file kill switch and restart-safe purchase reservation ledger
- Abortable polling, watcher backoff, heartbeat-liveness checks, and reconnect backoff
- In-memory parser, rank, latency, safety, watcher, and checkout metrics
- Live startup readiness preflight and consistent per-site/account Chrome profiles
- `scalper:doctor`, isolated smoke test, offline replay, session onboarding,
  and manual HAR/trace/selector capture commands
- Resale-market snapshots and fee-adjusted product ranking using TCGplayer
  market prices, low-confidence eBay active asks, and imported sold comps
- Transition-based retailer discovery that parses Best Buy's public,
  server-rendered search inventory and sends deduplicated Discord webhook alerts

`docs/CLAUDE-CHROME-BRIEF.md` tells Claude Chrome to:
- Log into the Discord drop server
- Review the last 10-20 drop announcement messages
- Record the exact text, embeds, stores, products, times, URLs
- Report findings to `docs/DISCORD-REVIEW.md`
- Recommend parser patterns

## External state still required for live operation

- Product pages, prices, and measured polling endpoints for the target drops
- One locally configured and manually authenticated account per enabled site
- A measured checkout recipe and confirmation selector per enabled site
- TCGPlayer API credentials if that measured lane uses its API
- An authorized Discord bot installed by a server administrator, with its token
  stored locally as `SCALPER_DISCORD_BOT_TOKEN`, if Discord ingestion is enabled

## Resale tracker

The current official 30th Celebration release candidates are seeded in
`config/scalper-market.json`. Fill verified acquisition prices and source ids,
then run `npm run scalper:market -- report`. See
`docs/MARKET-RESEARCH.md` for data-source limitations, scoring, sold-comp
imports, and the optional six-hour launchd tracker.

## Direct retailer discovery

`npm run scalper:discover` checks the configured public retailer search source,
stores the last state in `data/scalper/discovery-state.json`, and alerts only
when an item becomes actionable, changes fulfillment state, or drops in price.
Best Buy eligibility requires a first-party seller, a price below the configured
ceiling, and a product match in `config/scalper-watchlist.json`; marketplace and
off-watchlist results cannot alert.
Use `npm run scalper:discover -- --notify-current` only when intentionally
priming a new state file. `ops/discovery-tracker.launchd.plist` is a portable
template for a persistent worker at a 15-second baseline cadence; render its
documented path placeholders locally before installation. Independent searches run
concurrently, HTTP connections stay warm, and source failures back off
exponentially to avoid turning throttling into an outage.

In paper mode, a new actionable discovery transition now continues through the
real safety/orchestration/task pipeline and writes a durable simulated order.
Current read-only retailer URLs are exported to
`data/scalper/product-catalog.json`. The same product cannot produce a second
order merely because it appears in another poll.

For products with operator-measured first-party endpoints,
`npm run scalper:inventory -- <site>` is the richer path. It records exact
availability plus any measured quantity, price, SKU, seller, and fulfillment
fields, along with freshness, latency, and a response hash. Endpoints and
field mappings come only from `config/scalper-product-endpoints.json`; the
scanner never guesses a URL or response shape. All products at one retailer
share the same token bucket, Retry-After/backoff, circuit breaker, hard timeout,
and redirect allowlist.

## Autonomous paper burn-in

The 24/7 service tails `data/scalper/inbox/discord.jsonl` for permitted Discord
message exports or an authorized mirror. This does not automate a Discord user
account. `npm run scalper:ingest -- <file>` imports a JSON object, JSON array,
or JSONL file immediately. Both paths are paper-only unless a distinct live
inbox acknowledgement is set.

Start and inspect the seven-day evidence gate with `scalper:burn-in`. Hourly
operations reports are written under `data/scalper/reports/`; they cover
heartbeat uptime, retailer source errors, alert delivery, signal matching,
duplicate suppression, paper orders, task outcomes, and latency. The
operations LaunchAgent also rotates bounded logs and sends cooldown-protected
degraded/recovery alerts. `scalper:canary` is inspection-only: it cannot place
an order and will not report ready until the burn-in, one-unit limits, account,
session, measured recipe, product catalog, and clean task state all pass.

## Latency behavior

- Broad Best Buy discovery runs every 15 seconds and currently completes in
  roughly two seconds on this Mac. It is a discovery fallback, not a substitute
  for a measured product inventory endpoint.
- Known scheduled lanes poll at 200 ms near T-0; surprise lanes use their
  configured five-second cadence.
- Live lane warmup validates the account session while opening the measured
  product in a reusable persistent Chrome context. Checkout reuses that context
  instead of launching Chrome after detection.
- Detection webhooks run outside the checkout critical path. Durable task
  creation, safety authorization, duplicate protection, and order confirmation
  remain synchronous because removing those would create financial risk.
- Reports include detection-to-authorization, submission, and terminal-state
  latency distributions. Retailer queues, network latency, challenges, and
  unmeasured endpoints still prevent any guarantee of an instantaneous order.
