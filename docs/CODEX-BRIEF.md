# Codex Brief — Pokémon TCG Scalper

> Historical build brief. Do not treat it as current setup or security
> guidance; use `docs/ARCHITECTURE.md`, `SECURITY.md`, and the current source.
> In particular, the implemented Discord transport accepts only an authorized
> bot token and never a normal user-session token.

## What you're building

A speed system that auto-buys sealed Pokémon TCG product (booster boxes, ETBs,
premium tins) the moment it drops. Four sites: Pokémon Center, TCGPlayer,
Best Buy, Target. Runs 24/7 on a local Mac mini.

**Read `docs/SCOPE.md` first.** It is the full architecture, the 6-week build
plan, the safety strategy, and the open questions. This brief tells you what to
build NOW and what to leave as a clean seam for later.

## Hard constraints

- **Node 22+, ESM (`.mjs`), zero external dependencies for Phase 1.**
  The amber-funnel repo this lives next to uses only `node:` builtins.
  Follow that. No `npm install` for the core.
- **Playwright is the ONLY allowed external dep**, and only for the
  browser-checkout lanes (Phases 2–5). Phase 1 must not import it.
- **One test file per module.** No network in tests (mock the HTTP layer).
- **A test that reaches production data is not a flaky test — it is data
  loss.** Anything that writes under `data/scalper/` takes an injectable seam.
- **A passing proof is not evidence until you have seen it fail.** Every test
  is run red first (break the code, watch the test fail, fix the code, watch
  it pass).
- **A false-positive sibling per gate:** every "stock detected" test has a
  matching "stock NOT detected" test.
- **Named regressions:** every bug found in a live run gets a test.
- **`SCALPER_LIVE=1` arms real purchases.** Anything else is a dry run.
  Mirror the `FANVUE_LIVE` pattern from the sibling repo.
- **No `headless: true` in Playwright.** Use `channel: 'chrome'` (system
  Chrome, not bundled Chromium).
- **Never clear cookies between runs.** Every WAF tracks device history.
- **Randomize timing.** Don't poll at exactly 1000 ms intervals. Use 900–1100
  ms with random jitter. A metronome is a bot tell.
- **Max concurrent checkouts: 1 per site.** Don't race yourself.
- **Never double-buy:** a per-product lock ensures only one checkout is in
  flight at a time.

## What to build (in order)

### Phase 1: Shared core (build ALL of this)

1. **`package.json`** — name `pokemon-scalper`, type `module`, engines
   `node >=22`. Scripts:
   - `test`: `node --test --test-timeout=120000 'tests/**/*.test.mjs'`
   - `scalper:dry`: run the full pipeline in paper mode against a configured drop
   - `scalper:health`: clock drift, session validity, account status, recent drops
   - `scalper:watch`: the orchestrator as a long-running process
   - `scalper:pc` / `scalper:tcp` / `scalper:bb` / `scalper:tgt`: per-lane entry points
   - `scalper:discord`: run the Discord drop feed standalone

2. **`.env.example`** — every env var the system reads, with comments:
   - `SCALPER_LIVE` (0/1, default 0)
   - `SCALPER_DISCORD_BOT_TOKEN`
   - `SCALPER_DISCORD_WEBHOOK_URL` (optional, for alerts)
   - `SCALPER_ALERT_WEBHOOK_URL` (optional, generic alert)
   - Per-account: `PC1_PASS`, `PC1_CARD`, `TCP1_PASS`, `BB1_PASS`, `TGT1_PASS`
   - `SCALPER_DATA_DIR` (default `data/scalper`)

3. **`src/scalper/clock.mjs`** — NTP sync, monotonic clock, drift alert.
   - Query 3+ NTP sources (pool.ntp.org, time.apple.com, time.cloudflare.com)
     every 30 s. Compute offset + jitter.
   - Maintain a monotonic clock internally (`process.hrtime.bigint()`) for
     event ordering.
   - Expose `now()` (ms since epoch, NTP-corrected) and `driftMs()` (current
     offset from best NTP source).
   - Alert (log + optional webhook) when drift > 100 ms.
   - **Do NOT use HTTP Date headers** as a clock source.
   - **Injectable NTP transport** for tests (no real UDP in tests).
   - Tests: `tests/scalper/clock.test.mjs`

4. **`src/scalper/drop-calendar.mjs`** + **`config/scalper-drops.json`**
   - Config file of known drops (see SCOPE.md §2.2 for the schema).
   - Parse, validate, schedule. Expose `upcomingDrops(withinMs)` and
     `dropById(id)`.
   - The drop calendar scraper and Discord feed both write to this file.
   - Tests: `tests/scalper/drop-calendar.test.mjs`

5. **`src/scalper/accounts.mjs`** + local **`config/scalper-accounts.json`**
   - Per-site account config (see SCOPE.md §2.3 for the schema).
   - Session persistence: each account's authenticated session (cookies,
     tokens) saved to `data/scalper/sessions/<id>.json` and reused across runs.
   - Session refresh on auth failure.
   - **Injectable storage seam** for tests.
   - Tests: `tests/scalper/accounts.test.mjs`

6. **`src/scalper/dry-run.mjs`** — paper mode, order log.
   - `SCALPER_LIVE=1` arms real purchases.
   - In paper mode: detection runs normally, "add to cart" is simulated,
     "checkout" logs the intended purchase but does NOT submit payment,
     "confirm" records the result in `data/scalper/paper-orders.jsonl`.
   - Every paper order logged with: timestamp, site, product, account,
     simulated latency, would-have-paid amount.
   - **Injectable storage seam** for tests.
   - Tests: `tests/scalper/dry-run.test.mjs`

7. **`src/scalper/drop-scraper.mjs`** — populate the drop calendar from
   official sources.
   - Scrape Pokémon's official release announcements, TCGPlayer "coming soon"
     listings, Target/Best Buy product pages with "notify me" options.
   - Output: updates `config/scalper-drops.json`.
   - This is a **secondary** scraper — the primary detection is the per-site
     poller.
   - Tests: `tests/scalper/drop-scraper.test.mjs`

8. **`src/scalper/discord-feed.mjs`** + **`config/scalper-discord.json`**
   - Connect with a bot token issued for an authorized application installed
     by a server administrator. Never automate a normal user account.
   - Identify with `GUILD_MESSAGES` intent.
   - Watch the configured category (all channels under it).
   - When a new message arrives in a tracked channel:
     a. Log the raw message to `data/scalper/discord-drops.jsonl`.
     b. Parse the drop details (product, store, time, URL) using patterns.
     c. If it matches a drop, add it to `config/scalper-drops.json`.
     d. Alert the orchestrator to spin up the relevant lane.
   - Reconnect automatically on disconnect.
   - **Injectable WebSocket transport** for tests (no real WS in tests).
   - **Injectable parser** for tests.
   - Routing IDs (measured 2026-09-17):
     - Guild: `<private-guild-id>`
     - Category: `<private-category-id>`
     - Channel: `<private-channel-id>`
   - Tests: `tests/scalper/discord-feed.test.mjs`

9. **`src/scalper/orchestrator.mjs`** — the top-level loop.
   - Read `config/scalper-drops.json`.
   - For each upcoming drop (next 24 h):
     a. T-5 min: spin up the relevant lane(s).
     b. T-30 s: go full-throttle (polling rate up).
     c. T-0: fire the checkout.
     d. Post-drop: log the result, update the drop calendar.
   - For surprise drops (TCGPlayer, Target): continuous polling (lower rate).
   - Concurrency: one orchestrator process, each lane in its own async context,
     max 1 concurrent checkout per site, per-product lock.
   - Failure handling: retry once on failure, log "missed" if all accounts fail.
   - Tests: `tests/scalper/orchestrator.test.mjs`

### Phase 2–5: Site lanes (build the SKELETON of each)

For each site (pokemon-center, tcgplayer, bestbuy, target), build:

```
src/scalper/sites/<site>/
  index.mjs          — lane entry point (detect → checkout → confirm)
  detect.mjs         — product page / API polling
  checkout.mjs       — API checkout + Playwright fallback
  session.mjs        — auth, session persistence, refresh
  config.mjs         — site-specific config (URLs, endpoints, selectors)
```

**What to build now (the parts that are pure code):**
- `config.mjs` — site-specific config with the known URLs, WAF type,
  rate limits, and the "what to measure" TODOs as comments.
- `detect.mjs` — the polling loop with the correct cadence (2 s pre-drop,
  200 ms at T-0, 5 s for surprise drops). The HTTP layer is injectable.
  The "what to measure" endpoints are TODOs with the expected shape.
- `session.mjs` — auth flow, session persistence, refresh. The HTTP layer
  is injectable.
- `checkout.mjs` — the checkout flow. API-first where possible, Playwright
  fallback. The Playwright layer is behind an interface so it can be mocked.
- `index.mjs` — the lane entry point that wires detect → checkout → confirm.

**What to leave as clean seams (the parts that need measurement):**
- The actual endpoint URLs (TODO comments with the expected shape).
- The actual selectors (TODO comments).
- The WAF-specific countermeasures (TODO comments with the known WAF type).
- The latency measurements (TODO comments).

**Tests for each lane:**
- `tests/scalper/<site>/detect.test.mjs` — polling logic, availability detection
- `tests/scalper/<site>/checkout.test.mjs` — checkout flow (mocked)
- `tests/scalper/<site>/session.test.mjs` — auth, persistence, refresh

### Phase 6: 24/7 runner + monitoring

- **`src/scalper/health.mjs`** — clock drift, session validity, account status,
  recent drops. Exposed as `npm run scalper:health`.
- **`ops/launchd.plist`** — the launchd plist for the Mac mini 24/7 runner.
- **`src/scalper/alerts.mjs`** — webhook / SMS on drop detected, purchase
  confirmed, purchase failed.

## File tree (target)

```
pokemon-scalper/
  package.json
  .env.example
  .gitignore
  README.md              (update: add "Built" status, commands)
  docs/
    SCOPE.md             (already exists — the full scope)
    CODEX-BRIEF.md       (this file)
  config/
    scalper-drops.json
    scalper-accounts.json
    scalper-discord.json
  src/
    scalper/
      clock.mjs
      drop-calendar.mjs
      accounts.mjs
      dry-run.mjs
      drop-scraper.mjs
      discord-feed.mjs
      orchestrator.mjs
      health.mjs
      alerts.mjs
      sites/
        pokemon-center/
          index.mjs
          detect.mjs
          checkout.mjs
          session.mjs
          config.mjs
        tcgplayer/
          index.mjs
          detect.mjs
          checkout.mjs
          session.mjs
          api.mjs
          config.mjs
        bestbuy/
          index.mjs
          detect.mjs
          checkout.mjs
          session.mjs
          config.mjs
        target/
          index.mjs
          detect.mjs
          checkout.mjs
          session.mjs
          datadome.mjs
          config.mjs
  tests/
    scalper/
      clock.test.mjs
      drop-calendar.test.mjs
      accounts.test.mjs
      dry-run.test.mjs
      drop-scraper.test.mjs
      discord-feed.test.mjs
      orchestrator.test.mjs
      health.test.mjs
      alerts.test.mjs
      pokemon-center/
        detect.test.mjs
        checkout.test.mjs
        session.test.mjs
      tcgplayer/
        detect.test.mjs
        checkout.test.mjs
        session.test.mjs
      bestbuy/
        detect.test.mjs
        checkout.test.mjs
        session.test.mjs
      target/
        detect.test.mjs
        checkout.test.mjs
        session.test.mjs
  ops/
    launchd.plist
  data/
    scalper/
      .gitkeep
      sessions/
        .gitkeep
      paper-orders.jsonl
      discord-drops.jsonl
```

## What NOT to build

- **Do NOT build the actual Playwright browser automation** (the click
  sequences, the form fills). Build the interface and the mock. The real
  selectors and click sequences need DevTools measurement.
- **Do NOT build the actual NTP UDP client.** Build the interface and the
  mock. The real UDP transport is a thin wrapper.
- **Do NOT build the actual Discord WebSocket client.** Build the interface
  and the mock. The real WS transport is a thin wrapper.
- **Do NOT build the actual HTTP client.** Build the interface and the mock.
  The real HTTP transport uses `node:http` / `fetch`.
- **Do NOT add any external npm dependencies** except Playwright (and only
  in the checkout modules, behind an interface).

## Verification

After building, run:

```bash
cd /path/to/pokemon-scalper
node --test --test-timeout=120000 'tests/**/*.test.mjs'
```

All tests must pass. Then run:

```bash
node -e "import('./src/scalper/clock.mjs').then(m => console.log(Object.keys(m)))"
node -e "import('./src/scalper/drop-calendar.mjs').then(m => console.log(Object.keys(m)))"
node -e "import('./src/scalper/accounts.mjs').then(m => console.log(Object.keys(m)))"
node -e "import('./src/scalper/dry-run.mjs').then(m => console.log(Object.keys(m)))"
node -e "import('./src/scalper/discord-feed.mjs').then(m => console.log(Object.keys(m)))"
node -e "import('./src/scalper/orchestrator.mjs').then(m => console.log(Object.keys(m)))"
```

Each must print the exported function names without error.

## What the operator will do after you're done

1. Measure each site's actual endpoints (DevTools → Network tab).
2. Create an authorized Discord bot application and install it with the server
   administrator's approval; keep its bot token only in the local environment.
3. Get the TCGPlayer API key.
4. Create 1 account per site.
5. Send 3–5 examples of the Discord drop announcement messages.
6. Fill in the TODOs in the site config files.
7. Run `npm run scalper:dry` against a live drop.
8. Switch to `SCALPER_LIVE=1` for a real purchase.
