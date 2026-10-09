# Codex Brief — Phase 3: Production Backbone (compliant build)

> Historical steering document. Current behavior and setup are defined by
> `docs/ARCHITECTURE.md`, `SECURITY.md`, tests, and source.

## Division of labor (read this first)

This repo is built by two agents with a hard boundary:

- **Codex (you)** builds the **compliant, structural** backbone: state,
  transactions, orchestration, signals, traffic governance, security, CI,
  deploy. Everything that is "boring" and ToS-safe. You may add **one**
  external dependency where this brief says so (a maintained Discord SDK).
- **The operator (Claude)** owns the **stealth / edge** items that need live
  measurement and judgment: real selector/endpoint capture, WAF/challenge
  behavior, fingerprinting, proxy/account rotation, and the final "beat the
  captcha" tuning. These are left as **clean seams** — you build the interface
  and the mock, the operator fills the measured values.

**Rule: build the seam, not the guess.** Where a value needs a live browser or
a real retailer response, leave a `TODO(measure)` with the expected shape and a
working mock. Do NOT invent selectors, endpoints, or WAF countermeasures.

## Why Phase 3 exists

An adversarial review (see `docs/REVIEW-PHASE3.md` if present, otherwise the
operator's summary) found the system is a **paper-mode control plane**, not a
live scalper: 0/4 retailers ready, all recipes `null`, JSON state with no
transactions, a broken retry state machine, a swallowed ledger failure, a
kill switch not re-checked at commit, an orphaned market scorer, and a
hand-rolled Discord WS that sends Identify before Hello and never Resumes.

Phase 3 fixes the **structural** defects so that, once the operator measures
one retailer, the system can buy it correctly and durably.

## Hard constraints (carry forward from Phase 1/2)

- **Node 22+, ESM (`.mjs`).**
- **One test file per module. No network in tests.** Mock the transport layer.
- **A test that reaches production data is data loss.** Anything that writes
  under `data/scalper/` takes an injectable seam.
- **A passing proof is not evidence until you have seen it fail** (red first).
- **A false-positive sibling per gate** (every "detected" test has a
  "NOT detected" test).
- **`SCALPER_LIVE=1` arms real purchases.** Anything else is a dry run.
- **No `headless: true`.** `channel: 'chrome'`, never clear cookies.
- **Max 1 concurrent checkout per site.** Per-product lock.
- **New external deps allowed in Phase 3, ONLY:**
  - **Prefer `node:sqlite`** (verified available on the target Node 26 —
    `node -e "require('node:sqlite')"` succeeds). It is a builtin, so it adds
    zero deps. Fall back to `better-sqlite3` only if `node:sqlite` lacks a
    feature you need (document why).
  - **one** maintained Discord Gateway SDK (e.g. `discord.js` or
    `discord-api-types` + a WS lib) — to replace the hand-rolled WS. Pick the
    one with the best Ready/Resume/backfill support and document why.
  - Playwright (already present) — unchanged.
  - Nothing else. No stealth/fingerprinting libs (that's the operator's lane).

## Verified facts (measured 2026-10-02, do not re-derive)

- `data/scalper/discord-drops.jsonl` is mode `0644` (should be `0600`).
- 102 files are untracked; `package-lock.json` is untracked; no
  `.github/workflows/` exists.
- `node:sqlite` loads cleanly on Node v26.8.2.
- `maxRequestsPerSecond` is declared in all four `sites/*/config.mjs`
  (`pokemon-center: 5`, `bestbuy: 1`, `tcgplayer: 1`, `target: 1`) but is
  never read by any detector — polling runs at `fullThrottleMs: 200` (5 req/s
  per product) with no site-wide bucket.

## What to build (in order)

### 0. Stop-ship bug fixes (do these FIRST, they unblock everything)

These are small, testable, and independent of retailer choice. Each gets a
named regression test.

1. **Retry state machine.** `task-state.mjs` `TRANSITIONS` disallows
   `navigating → launching`, so a second checkout attempt on the same task
   throws `Invalid purchase task transition`. Fix: the orchestrator
   (`orchestrator.mjs:224`) must transition the task to `retrying` between
   attempts, and `retrying` must be reachable from every execution state and
   able to re-enter `launching`/`navigating`/etc. (It already lists
   `retrying` in `TRANSITIONS` — wire the orchestrator to actually use it.)
   - Test: two attempts on one task, attempt 1 reaches `navigating` then
     transient-fails, attempt 2 proceeds. Must NOT throw.
   - False-positive sibling: a terminal task (`purchased`) cannot be retried.

2. **Ledger failure is not swallowed.** `orchestrator.mjs:233-238` catches
   `ledger.complete` and logs, then returns `purchased`. Fix: if the ledger
   cannot be finalized after a successful checkout, the result is `uncertain`
   (durable duplicate/spend protection must survive), not `purchased`.
   - Test: inject a `ledger.complete` throw after a successful checkout →
     result is `uncertain`, not `purchased`.

3. **Kill switch re-checked at commit.** `safety.mjs:142` checks once before
   the site slot. Add a `recheckAtCommit({ amount, quantity, ... })` method on
   `SafetyPolicy` that re-reads the kill switch + daily spend + max order, and
   call it from the `beforeCommit` hook (`transports/browser.mjs:151`) and the
   API path (`sites/pokemon-center/checkout.mjs:21`).
   - Test: kill switch created after `authorize` but before commit → commit
     blocked.

4. **Post-commit failures are `uncertain`, not retryable.** Extend the
   `SCALPER_ORDER_STATUS_UNCERTAIN` contract to cover: order-ID extraction
   failure, confirmation-selector failure, and any error after the commit
   click. The orchestrator already breaks on that code (`orchestrator.mjs:253`)
   — make the browser adapter and the Pokémon Center API path throw it in
   those cases.
   - Test: commit click succeeds, then order-ID extraction throws → result is
     `uncertain`, and a second attempt is NOT made.

5. **Wire the market scorer into the gate.** `market-score.mjs`
   (`scoreProduct`/`rankProducts`) is never imported by `safety.mjs`,
   `orchestrator.mjs`, or `wiring.mjs`. Add a profitability gate to
   `SafetyPolicy.authorize`: if a fresh score for the product is `eligible:
   false` (or missing evidence and `SCALPER_ALLOW_UNSCORED !== '1'`), block.
   Inject the scorer + observations so it's testable.
   - Test: product scored `eligible: false` → `authorize` blocks with reason
     `profitability`.
   - False-positive sibling: `eligible: true` with sufficient evidence →
     allowed.

6. **Test isolation.** `wiring.test.mjs:79` builds a real `DiscordFeed` whose
   default `logPath` is `data/scalper/discord-drops.jsonl`, so fixtures append
   to the real file. Inject an explicit `logPath` under the temp `dataDir` in
   every test that constructs a `DiscordFeed` or `createScalper`. Add a guard
   test that asserts no test writes outside its temp dir.
   - Test: run the wiring suite, then assert `data/scalper/discord-drops.jsonl`
     line count is unchanged.

### 1. SQLite state store (replace the JSON files)

**File:** `src/scalper/db.mjs` (new) + `src/scalper/state-store.mjs` (new)

Replace the four separate JSON files (`purchase-ledger.json`,
`purchase-tasks.json`, `drop-calendar.json`, `challenges.json`) with **one**
SQLite database with real transactions.

- **Single DB file:** `data/scalper/scalper.db` (path injectable).
- **Tables (minimum):**
  - `tasks` — the purchase task state machine (id, key, site, product,
    account, state, revision, created_at, updated_at). `UNIQUE(key)`.
  - `task_events` — append-only event log (task_id, state, at, details_json).
  - `reservations` — ledger (id, key, site, product, account, amount_cents,
    quantity, status, created_at, updated_at). `UNIQUE(key)` for active
    statuses. **Money is integer cents.**
  - `drops` — the drop calendar (id, time, sites_json, type, price_cents,
    purchase_quantity, status, source).
  - `challenges` — human challenges (id, task_id, site, kind, status,
    created_at, expires_at, resolution_json).
  - `idempotency` — unique idempotency keys for commit operations (key,
    site, product, created_at, result_json). `UNIQUE(key)`.
- **Transactions:** every multi-table mutation (reserve → checkout →
  complete) is one SQLite transaction. A crash mid-checkout must leave the DB
  in a consistent state (either fully reserved or fully released).
- **Leases:** a `lease` column or table so a second process cannot act on a
  task another process holds. Lease expiry = stale takeover.
- **One authoritative order state machine.** The `tasks.state` column is the
  single source of truth; the in-memory `Orchestrator.#states` becomes a
  cache, not the record.
- **Migration:** a `schema_version` table + a `migrate()` that upgrades the
  current JSON files into SQLite on first run (read the JSON, insert, then
  keep a `.migrated` marker). Idempotent.
- **Injectable driver** for tests (an in-memory SQLite or a fake with the same
  API). No real file in tests.

**Interfaces to preserve** (so `orchestrator.mjs`, `safety.mjs`,
`task-state.mjs`, `challenge-broker.mjs` keep working):
- `PurchaseLedger`: `reserve`, `complete`, `fail`, `uncertain`, `release`,
  `spentSince`, `records`.
- `PurchaseTaskStore`: `ensure`, `transition`, `reconcile`, `recoverable`,
  `list`, `get`, `markInterrupted`.
- `HumanChallengeBroker`: `request`, `resume`, `cancel`, `list`, `get`,
  `expireInactive`.
- `DropCalendar`: `upsertDrop`, `allDrops`, `markResult`.

Re-implement these **on top of** the SQLite store. Keep the same method
signatures so the orchestrator and tests don't change.

**Tests:** `tests/scalper/db.test.mjs`, `tests/scalper/state-store.test.mjs`
- Reserve → complete is atomic (a crash between them leaves no orphan).
- `UNIQUE(key)` prevents a double reservation.
- Money is stored as integer cents (no float drift).
- Lease: a second "process" cannot transition a leased task.
- Migration: seed the JSON files, run `migrate()`, assert the DB matches.
- **False-positive sibling:** a `reserve` with the same key after a
  `purchased` record → rejected as `already-purchased`.

### 2. Pokémon Center end-to-end (the one retailer we make bulletproof)

**Files:** `src/scalper/sites/pokemon-center/*` (extend),
`src/scalper/attestation.mjs` (new)

Pokémon Center is the first retailer because it has an **API-first** path and
the best ToS posture. Build the full pipeline so that, once the operator
measures the real endpoints, it buys correctly.

- **API adapter interface** (`sites/pokemon-center/api.mjs`):
  ```js
  {
    checkAvailability({ product, account, session }) → Promise<{ available, quantity, priceCents, sku, seller }>
    addToCart({ product, account, session }) → Promise<{ cartId, items }>
    getCart({ account, session, cartId }) → Promise<{ items, totalCents, shippingCents, taxCents, address, fulfillment }>
    submitOrder({ account, session, cartId }) → Promise<{ orderId, status }>
    getOrder({ account, session, orderId }) → Promise<{ orderId, status, items, totalCents }>
  }
  ```
  Build the interface + a **mock** that returns a realistic in-stock and an
  out-of-stock response. `TODO(measure)` the real endpoints.
- **Pre-commit attestation** (`src/scalper/attestation.mjs`, new): a pure
  function `attestCart(cart, expected)` that verifies, before the irreversible
  click:
  - exact SKU/product matches `expected.sku`;
  - seller matches `expected.seller` (if the site has sellers);
  - quantity matches `expected.quantity`;
  - final total (`totalCents`) is within `expected.maxTotalCents`;
  - shipping + tax are present and sane (not negative, not zero when expected);
  - delivery method + address match `expected`;
  - **no unrelated/stale cart items** (every item is in `expected.skus`).
  Returns `{ ok, defects: [...] }`. The orchestrator blocks on `ok: false`.
  - Tests: each defect type → `ok: false` with the right defect name.
  - **False-positive sibling:** a perfect cart → `ok: true`.
- **Wire attestation into the API path** (`sites/pokemon-center/checkout.mjs`):
  after `addToCart` + `getCart`, call `attestCart` before `submitOrder`. On
  failure, do NOT submit — return `safety-blocked` with the defects.
- **Reconciliation** (`sites/pokemon-center/reconcile.mjs`, new): after an
  `uncertain` result, call `getOrder` / order-history to determine if the order
  actually went through. This is the "reconcile against order history before
  proceeding" step.
  - Test: `submitOrder` throws but `getOrder` shows a real order → reconcile to
    `purchased`.
  - **False-positive sibling:** `submitOrder` throws and `getOrder` shows no
    order → reconcile to `failed`.

### 3. Signals: replace the hand-rolled Discord WS

**File:** `src/scalper/transports/discord-ws.mjs` (replace internals) or a new
`src/scalper/discord-client.mjs`

The current WS sends Identify before Hello, never Resumes, drops sequence on
reconnect, and grows the compressed buffer unboundedly. Replace it with a
maintained SDK (see allowed deps).

- **Must support:** Hello → Identify (correct order), Ready detection,
  **Resume** with saved `session_id` + `seq` on reconnect, **backfill** of
  missed `MESSAGE_CREATE` events (via REST `/channels/:id/messages` after
  Resume), heartbeat ACK tracking, and bounded memory.
- **Durable dedupe:** a `seen_messages` table in SQLite (message_id,
  channel_id, at). A message is processed at most once, even across restarts.
- **Author allowlist:** only process messages from allowlisted
  `author.id` / `member` (config `scalper-discord.json` → add
  `authorIds: []`). Bot-flagged or non-allowlisted authors are dropped.
- **Canonical product mapping:** a signal's product URL must map to a
  **measured poll endpoint** (not a human-facing product page). Add a
  `productEndpoints` table (product_id, site, poll_url) that the detector
  reads. `TODO(measure)` the real poll URLs.
- **SSRF guard:** validate the final URL (after redirect) against the
  retailer HTTPS allowlist (`retail-url-policy.mjs`) BEFORE fetching. Do not
  follow redirects to a non-retailer host.
- Keep the `connect({ token, intents, onMessage, onChannel, onDisconnect })`
  and `close()` interface so `discord-feed.mjs` and `wiring.mjs` don't change.

**Tests:** `tests/scalper/transports/discord-ws.test.mjs` (extend)
- Identify is sent AFTER Hello (assert order with a mock socket).
- Resume is attempted on reconnect with the saved session_id + seq.
- A missed message is backfilled via the REST call (mock the REST).
- A duplicate message_id is processed once (durable dedupe).
- A non-allowlisted author is dropped.
- **False-positive sibling:** a message from the right channel but a
  non-allowlisted author → NOT dispatched.

### 4. Traffic governance

**File:** `src/scalper/rate-limit.mjs` (new)

- **Per-site token bucket** shared across all products at that site (not per
  product). Config `maxRequestsPerSecond` is currently unused — wire it in.
- **Hard timeouts** on every poll (a hung request must not strand a watcher).
- **Exponential backoff** + honor `Retry-After` on 403/429/500.
- **Circuit breaker:** after N consecutive 429/5xx, stop polling that site for
  a cooldown, then half-open.
- **Watcher expiry:** a surprise watcher has a max duration; it stops and
  records `expired` (not `missed`) when it hits the limit.
- **Error classification:** 403/429/500 are NOT "not in stock." They are
  `throttled` / `server-error` and trigger backoff/breaker, not a `missed`
  result.

**Tests:** `tests/scalper/rate-limit.test.mjs`
- Token bucket: N requests in a window are allowed, N+1 is throttled.
- `Retry-After` is honored (mock the clock).
- Circuit breaker opens after N failures, half-opens after cooldown.
- **False-positive sibling:** a 200 with `available: false` is "not in
  stock," NOT "throttled."

### 5. Security hardening

- **Dashboard token mandatory** in live mode (`dashboard.mjs`): if
  `SCALPER_LIVE=1` and no `SCALPER_DASHBOARD_TOKEN`, fail preflight.
- **CSRF/Origin check:** state-changing dashboard endpoints require a
  matching `Origin`/`Referer` (localhost) AND `Content-Type: application/json`.
- **Retailer HTTPS allowlist at navigation time** (`transports/browser.mjs`):
  before `page.goto`, assert the URL is in `retail-url-policy.mjs` for that
  site. A recipe that navigates to another host is rejected.
- **Secret file mode `0600`:** all files under `data/scalper/` that hold
  secrets (sessions, challenges, the DB) are created `0600`. The raw
  `discord-drops.jsonl` is currently `0644` — fix.
- **Single-instance lock:** a `flock` on `data/scalper/.lock` so a second
  process cannot race the DB. Fail fast with a clear message if the lock is
  held.
- **Encrypted backup:** a `npm run scalper:backup` that copies the DB + config
  to a timestamped, `0600` file (encryption is the operator's lane; build the
  copy + the seam).

**Tests:** `tests/scalper/security.test.mjs`
- Dashboard without token in live mode → preflight fails.
- State-changing dashboard call with wrong Origin → rejected.
- A recipe navigating to a non-retailer host → rejected.
- **False-positive sibling:** a recipe navigating to the right host → allowed.

### 6. Productionize delivery

- **Commit the full tree + lockfile.** Currently 47 source files are
  untracked and `package-lock.json` is not committed. Add a
  `docs/DEPLOY.md` with: how to build, how to deploy, how to roll back.
- **CI:** a `.github/workflows/ci.yml` (or the repo's CI) that runs
  `npm test` + `npm run scalper:doctor` + `npm run scalper:smoke` on every
  push. Pin Node 22.
- **Immutable release:** a `npm run scalper:release` that tags a version,
  records the git SHA + lockfile hash, and writes a `releases/` manifest.
  Rollback = re-deploy a previous manifest.
- **Pin compatibility:** record the tested Node + Playwright + Chrome versions
  in `docs/DEPLOY.md` and assert them in CI.

### 7. Prove the real boundary (test harness, not the live run)

- **Recorded-contract tests:** for Pokémon Center, record (via the operator's
  measurement) a real in-stock response, an out-of-stock response, a cart
  state, a checkout state, and a confirmation. Store them as fixtures under
  `tests/fixtures/pokemon-center/`. The detector + attestation + checkout are
  tested against these **recorded** responses, not fabricated ones.
- **Fault injection:** a harness (`src/scalper/fault-injection.mjs`, new) that
  injects failures before/during/after commit and asserts the state machine
  ends in the right terminal state. Wire it into the test suite.
- **Crash recovery:** a test that kills the process mid-checkout (after
  reserve, before complete) and asserts the DB is consistent and the task is
  `uncertain` (reconcilable), not `purchased`.
- **Canary readiness** (`canary-readiness.mjs`, extend): a checklist that
  gates `SCALPER_LIVE=1` on: per-retailer detection samples present, active
  alert delivery, session validation, zero duplicate orders in the last N
  runs, successful restart reconciliation, and measured latency over a
  burn-in window.

## What NOT to build (the operator's lane)

- **Do NOT invent selectors or endpoints.** Leave `TODO(measure)` + a mock.
- **Do NOT add stealth/fingerprinting/proxy libs.** That's the operator's
  "beat the captcha" work. Build the seam (a `stealth` hook the operator can
  plug into) but don't implement it.
- **Do NOT implement the real WAF countermeasures** (DataDome, Akamai,
  Cloudflare). Build the interface + the mock.
- **Do NOT do the live canary.** Build the readiness gate; the operator runs
  the canary.
- **Do NOT add more than the allowed deps** (SQLite driver + one Discord SDK).

## Verification

```bash
cd /path/to/pokemon-scalper
npm test
npm run scalper:doctor
npm run scalper:smoke
```

All must pass. Then:

```bash
node -e "import('./src/scalper/db.mjs').then(m => console.log('db:', Object.keys(m)))"
node -e "import('./src/scalper/state-store.mjs').then(m => console.log('state:', Object.keys(m)))"
node -e "import('./src/scalper/attestation.mjs').then(m => console.log('attest:', Object.keys(m)))"
node -e "import('./src/scalper/rate-limit.mjs').then(m => console.log('ratelimit:', Object.keys(m)))"
node -e "import('./src/scalper/fault-injection.mjs').then(m => console.log('fault:', Object.keys(m)))"
```

Each must print the exported names without error.

## What the operator will do after you're done

1. Measure Pokémon Center's real endpoints (DevTools → Network) → fill the
   `TODO(measure)` in `sites/pokemon-center/api.mjs` + `config.mjs`.
2. Record the in-stock/out-of-stock/cart/checkout/confirmation fixtures.
3. Fill `productEndpoints` with the real poll URLs.
4. Add the Discord author allowlist to `config/scalper-discord.json`.
5. Run `npm run scalper:canary` and clear the readiness gate.
6. Run one supervised 1-unit canary.
7. Then the operator clones the Pokémon Center pattern to Best Buy.
