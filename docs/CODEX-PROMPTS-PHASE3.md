# Codex Prompts — Phase 3 (copy-paste, in order)

> Historical implementation prompts retained for design provenance. They are
> not the current handoff; start with `docs/ARCHITECTURE.md` and
> `CONTRIBUTING.md`.

Hand these to Codex one at a time. Each is self-contained. After each, run the
verification block and confirm green before the next.

---

## PROMPT 0 — Read the brief and confirm scope

```
Read docs/CODEX-BRIEF-PHASE3.md in full, plus docs/SCOPE.md and
docs/CODEX-BRIEF-PHASE2.md for context. Do NOT write code yet. Reply with:
1. The 6 stop-ship bugs you will fix in Phase 0, each with the exact file:line
   you will change.
2. Which SQLite driver you will use (node:sqlite vs better-sqlite3) and why.
3. Which Discord SDK you will use and why (Ready/Resume/backfill support).
4. The list of files you will create vs modify.
5. Anything in the brief that is ambiguous or that you think is wrong.
```

---

## PROMPT 1 — Phase 0: stop-ship bug fixes

```
Implement Phase 0 of docs/CODEX-BRIEF-PHASE3.md (the 6 stop-ship bug fixes),
in this order:
1. Retry state machine (task-state.mjs + orchestrator.mjs:224) — a second
   checkout attempt on the same task must not throw
   "Invalid purchase task transition: navigating -> launching".
2. Ledger failure is not swallowed (orchestrator.mjs:233-238) — a failed
   ledger.complete after a successful checkout must yield `uncertain`, not
   `purchased`.
3. Kill switch re-checked at commit (safety.mjs:142 + transports/browser.mjs:151
   + sites/pokemon-center/checkout.mjs:21).
4. Post-commit failures are `uncertain`, not retryable (extend the
   SCALPER_ORDER_STATUS_UNCERTAIN contract to order-ID extraction +
   confirmation).
5. Wire the market scorer into SafetyPolicy.authorize as a profitability gate
   (market-score.mjs is currently orphaned).
6. Test isolation — wiring.test.mjs:79 appends fixtures to the real
   data/scalper/discord-drops.jsonl; inject an explicit logPath under the temp
   dataDir.

Every fix gets a named regression test (red first, then green) and a
false-positive sibling where the brief calls for one. Do not touch the
retailer selectors or endpoints. Run `npm test` and report the count.
```

---

## PROMPT 2 — Phase 1: SQLite state store

```
Implement Phase 1 of docs/CODEX-BRIEF-PHASE3.md: replace the four JSON state
files (purchase-ledger.json, purchase-tasks.json, drop-calendar.json,
challenges.json) with ONE SQLite database using node:sqlite (fall back to
better-sqlite3 only if you must, and say why).

Requirements:
- Single DB at data/scalper/scalper.db (path injectable).
- Tables: tasks, task_events, reservations (money as INTEGER cents), drops,
  challenges, idempotency. UNIQUE constraints on the idempotency keys.
- Real transactions: reserve -> checkout -> complete is atomic.
- Leases so a second process cannot act on a held task.
- tasks.state is the single source of truth; the in-memory Orchestrator.#states
  becomes a cache.
- A migrate() that upgrades the existing JSON files into SQLite on first run,
  idempotent, with a .migrated marker.
- Preserve the existing method signatures of PurchaseLedger, PurchaseTaskStore,
  HumanChallengeBroker, and DropCalendar so orchestrator.mjs and the existing
  tests keep passing.
- Injectable driver for tests (in-memory SQLite or a fake). No real file in
  tests.

Run `npm test` — the existing suite must still pass (you are re-implementing
the backends, not changing the contracts). Report the new test count.
```

---

## PROMPT 3 — Phase 2: Pokémon Center end-to-end + attestation

```
Implement Phase 2 of docs/CODEX-BRIEF-PHASE3.md for Pokémon Center ONLY:
- Build the API adapter INTERFACE + a realistic mock (in-stock and
  out-of-stock) in sites/pokemon-center/api.mjs. Leave the real endpoints as
  TODO(measure). Do NOT invent selectors or URLs.
- Build src/scalper/attestation.mjs: attestCart(cart, expected) that verifies
  SKU, seller, quantity, final total (cents), shipping+tax, address,
  fulfillment, and NO unrelated/stale cart items. Returns { ok, defects }.
- Wire attestation into the API path in sites/pokemon-center/checkout.mjs:
  after addToCart + getCart, attest before submitOrder. On failure, do NOT
  submit — return safety-blocked with the defects.
- Build src/scalper/sites/pokemon-center/reconcile.mjs: after an `uncertain`
  result, query order history (getOrder) to decide purchased vs failed.

Every defect type gets a test + a false-positive sibling (a perfect cart ->
ok: true). Run `npm test`.
```

---

## PROMPT 4 — Phase 3: signals (Discord) + traffic governance

```
Implement Phase 3 + 4 of docs/CODEX-BRIEF-PHASE3.md:
- Replace the hand-rolled Discord WS (transports/discord-ws.mjs) with a
  maintained SDK. It MUST: send Identify AFTER Hello, detect Ready, Resume
  with saved session_id + seq on reconnect, backfill missed MESSAGE_CREATE via
  REST, track heartbeat ACK, and use bounded memory. Keep the
  connect({token,intents,onMessage,onChannel,onDisconnect}) + close()
  interface so discord-feed.mjs and wiring.mjs don't change.
- Durable dedupe: a seen_messages table in SQLite (message_id, channel_id, at);
  a message is processed at most once across restarts.
- Author allowlist: config/scalper-discord.json gains authorIds: []; only
  allowlisted authors are processed.
- Canonical product mapping: a productEndpoints table (product_id, site,
  poll_url) the detector reads. TODO(measure) the real poll URLs.
- SSRF guard: validate the final (post-redirect) URL against
  retail-url-policy.mjs BEFORE fetching.
- Traffic governance (src/scalper/rate-limit.mjs): per-site token bucket shared
  across products (wire in the currently-unused maxRequestsPerSecond), hard
  timeouts, exponential backoff + Retry-After, circuit breaker, watcher
  expiry, and error classification (403/429/500 are NOT "not in stock").

Run `npm test`. Report which Discord SDK you chose and why.
```

---

## PROMPT 5 — Phase 4: security + productionize + proof

```
Implement Phase 5 + 6 + 7 of docs/CODEX-BRIEF-PHASE3.md:
- Security: mandatory dashboard token in live mode, CSRF/Origin check on
  state-changing dashboard endpoints, retailer HTTPS allowlist at navigation
  time (transports/browser.mjs), 0600 on all secret files under data/scalper/
  (discord-drops.jsonl is currently 0644), single-instance flock on
  data/scalper/.lock, and a `npm run scalper:backup` that copies the DB +
  config to a timestamped 0600 file.
- Productionize: commit the full tree + package-lock.json (102 files are
  currently untracked), add .github/workflows/ci.yml (npm test + scalper:doctor
  + scalper:smoke, pin Node 22), add `npm run scalper:release` (tag + git SHA +
  lockfile hash + releases/ manifest), and write docs/DEPLOY.md (build, deploy,
  rollback, pinned Node/Playwright/Chrome versions).
- Proof: recorded-contract test fixtures under tests/fixtures/pokemon-center/
  (in-stock, out-of-stock, cart, checkout, confirmation), a
  src/scalper/fault-injection.mjs harness (failures before/during/after commit
  -> correct terminal state), a crash-recovery test (kill mid-checkout -> DB
  consistent, task `uncertain`), and extend canary-readiness.mjs into a gate
  for SCALPER_LIVE=1.

Run `npm test`, `npm run scalper:doctor`, `npm run scalper:smoke`. Report the
final test count and any remaining TODO(measure) seams.
```

---

## PROMPT 6 — Hand back to the operator

```
You are done with the compliant build. Produce a handoff note:
1. Every TODO(measure) seam, with the file:line and the exact shape the
   operator must fill.
2. The list of mocks the operator must replace with real implementations.
3. The canary-readiness checklist and which items are currently unmet.
4. Any place you had to make a judgment call the operator should review.
5. The exact commands to run the one supervised 1-unit canary.
Do NOT start the canary. Do NOT add stealth/fingerprinting/proxy code.
```
