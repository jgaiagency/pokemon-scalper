# Operator runbook

The application code is complete through the measured-retailer boundary. A
live retailer lane is deliberately fail-closed until its local account,
persistent Chrome profile, product page, polling endpoint, price, and checkout
recipe are configured.

Do not paste passwords, card values, Discord tokens, or recorded browser
artifacts into chat or commit them to Git. Store retailer credentials in the
macOS Keychain and keep browser artifacts under the ignored `data/scalper/`
paths.

## 1. Install and prove the local build

```bash
npm install
npm run browsers
npm test
npm run scalper:smoke
npm run scalper:e2e
npm run scalper:simulate
npm run scalper:doctor
```

`scalper:smoke` is isolated: it uses a fake in-stock Target response and a
paper order store in memory. Its HTTP mock refuses POSTs.

`scalper:e2e` starts one step earlier with a browser-reviewed Restockd Target
message. It proves channel tracking, parsing, watchlist matching, affiliate URL
unwrapping, retailer-domain validation, calendar persistence, lane detection,
safety, orchestration, durable task state, paper checkout, and confirmation.
It uses a temporary directory and fails if anything attempts an HTTP POST,
arbitrary redirect request, or browser checkout.

`scalper:simulate` is the pre-credential acceptance gate. It runs seven
isolated scenarios covering successful paper orders across every retailer,
sold-out inventory, duplicate suppression, the kill switch, hostile/noisy
Discord messages, and an alert outage. It uses temporary files and injected
HTTP fixtures, and reports zero real accounts, cards, or external mutations.

## 2. Configure accounts locally

Copy `.env.example` to `.env` and
`config/scalper-accounts.example.json` to the ignored local file
`config/scalper-accounts.json`. Replace the placeholder email/address metadata
there. If Discord ingestion is enabled, also copy
`config/scalper-discord.example.json` to the ignored local file
`config/scalper-discord.json` and fill its routing IDs. The templates reference
macOS Keychain and environment variables, so enter secrets interactively
without placing them in JSON or
shell history:

```bash
npm run scalper:secret -- set PC1_PASS
npm run scalper:secret -- set PC1_CARD
npm run scalper:secret -- set TCP1_PASS
npm run scalper:secret -- set BB1_PASS
npm run scalper:secret -- set TGT1_PASS
```

Use `npm run scalper:secret -- status BB1_PASS` to check presence without
printing the value. Environment references such as `env:BB1_PASS` remain
supported when explicitly configured.

Create the authenticated Chrome profile for each account by logging in
manually:

```bash
SCALPER_SESSION_ACK=1 npm run scalper:login -- target tgt-1
SCALPER_SESSION_ACK=1 npm run scalper:login -- bestbuy bb-1
SCALPER_SESSION_ACK=1 npm run scalper:login -- tcgplayer tcp-1
SCALPER_SESSION_ACK=1 npm run scalper:login -- pokemon-center pc-1
```

The command writes reusable browser state under the ignored
`data/scalper/browser-profiles/` directory and a non-secret metadata marker
under `data/scalper/sessions/`. It does not automate login, CAPTCHA, OTP, or
3-D Secure.

## 3. Measure each retailer flow

Use a real target product URL and the matching account id:

```bash
SCALPER_MEASURE_ACK=1 npm run scalper:measure -- target 'https://www.target.com/p/...' tgt-1
```

Perform the flow manually in the opened browser. The command produces a
private directory under `data/scalper/measurements/` containing:

- `network.har`: minimal request metadata with bodies omitted;
- `trace.zip`: Playwright trace snapshots;
- `interactions.json`: redacted clicked/changed element metadata and candidate
  selectors. Typed field values and URL query/fragment data are not recorded.

Do not place a real order merely to complete measurement. The confirmation
selector must come from an explicitly authorized test order or a safely
revisited confirmation/order-details page.

No challenge bypass, fingerprint spoofing, or proxy rotation is implemented.
If a site presents CAPTCHA, OTP, or 3-D Secure, complete it manually in the
persistent browser profile.

## 4. Configure a drop

`productUrls` are human-facing pages opened by Chrome. `pollUrls` are the
measured JSON endpoints used by the detector. `checkoutUrls` are optional page
overrides when checkout should start somewhere other than `productUrls`.

```json
{
  "drops": [
    {
      "id": "example-target-etb",
      "name": "Example ETB",
      "sites": ["target"],
      "type": "surprise",
      "time": "2026-10-01T17:00:00.000Z",
      "price": 49.99,
      "purchaseQuantity": 1,
      "productUrls": {
        "target": "https://www.target.com/p/..."
      },
      "pollUrls": {
        "target": "https://redacted-measured-endpoint.example/..."
      }
    }
  ]
}
```

The live doctor requires a numeric price, a product URL, and a measured poll
URL for every site on every configured drop. Observed Discord stock quantity
never changes `purchaseQuantity`.

## 5. Configure the measured checkout recipe

Replace the site's `null` value in `config/scalper-browser-recipes.json` with
a recipe derived from the recording. Every angle-bracketed value below is a
placeholder, not a retailer selector:

```json
{
  "version": 1,
  "site": "target",
  "steps": [
    {
      "action": "click",
      "selectors": ["<measured add-to-cart selector>"],
      "phase": "carting"
    },
    {
      "action": "fill",
      "selectors": ["<measured email selector>"],
      "valueFrom": "account.email"
    },
    {
      "action": "click",
      "selectors": ["<measured irreversible order selector>"],
      "phase": "submitting",
      "commit": true
    }
  ],
  "session": {
    "url": "https://www.target.com/account",
    "signedInSelectors": ["<measured signed-in selector>"],
    "signedOutSelectors": ["<measured signed-out selector>"]
  },
  "challenges": [
    {
      "id": "verification",
      "kind": "captcha",
      "selectors": ["<measured verification selector>"],
      "timeoutMs": 600000
    }
  ],
  "confirmation": {
    "selectors": ["<measured confirmation selector>"],
    "orderId": {
      "selector": "<measured order-number selector>",
      "pattern": "<measured order-number pattern>"
    }
  }
}
```

Allowed actions are `click`, `fill`, `select`, `check`, `waitFor`, and
`waitForUrl`. Selector arrays provide measured fallbacks. `fill` and `select`
accept either `value` or an approved non-secret `valueFrom` path rooted at
`account` or `product`. Arbitrary JavaScript is rejected. Exactly one `commit: true` click
is required, it must be the final step, and it cannot execute unless live mode
is explicitly armed. A measured confirmation selector is mandatory. Optional
`session` selectors power periodic login-health checks. Optional `challenges`
selectors pause the same visible browser task, alert the operator, and wait
for a dashboard resume. The commit click is never repeated after a post-submit
challenge or ambiguous confirmation.

## 6. Prove paper mode

Keep `SCALPER_LIVE=0`:

```bash
npm run scalper:doctor
npm run scalper:dry
npm run scalper:health
```

Inspect `data/scalper/paper-orders.jsonl`. Paper mode performs real detection
but never launches the live checkout recipe.

### Run the autonomous paper evidence window

Retailer discovery runs as a persistent worker with a 15-second baseline. A newly actionable, policy-eligible
item is sent through the same orchestrator and durable task state used by live
mode, but the final lane writes a paper order. Best Buy search results are also
materialized as a current, read-only URL catalog in
`data/scalper/product-catalog.json`.

For Discord messages obtained through an allowed export or authorized mirror,
append one raw Discord message object per line to
`data/scalper/inbox/discord.jsonl`, or import a file directly:

```bash
npm run scalper:ingest -- /path/to/exported-messages.jsonl
```

The inbox never extracts or automates a normal Discord user token. It is
disabled in live mode unless the separate `SCALPER_SIGNAL_INBOX_LIVE_ACK=1`
gate is deliberately set.

Start the seven-day window once, then inspect it at any time:

```bash
npm run scalper:burn-in -- start
npm run scalper:burn-in -- status
npm run scalper:operations
```

Reports live in `data/scalper/reports/`. Passing requires continuous source
coverage, at most a five-percent source error rate, no failed alert deliveries,
no duplicate or uncertain paper orders, at least one real input transition,
at least one paper order, and the full elapsed seven days. A synthetic test is
useful for code verification but does not satisfy the persistent evidence
window.

For scheduled products, measured `pollUrls` are the low-latency path. At T-5
minutes the lane validates its session, begins polling, and prewarms a visible
persistent Chrome context. At T-30 seconds the detector reaches its configured
200 ms cadence. The broad public-search worker is intentionally slower and
backs off on errors. Do not lower either cadence beyond the retailer-specific
rate budget established during measurement.

Before any canary discussion, run:

```bash
npm run scalper:canary -- bestbuy
```

This command only reports readiness. It does not arm live mode or submit an
order. Keep `SCALPER_LIVE=0` and `SCALPER_KILL_SWITCH=1` while resolving its
blockers.

## 7. Arm live mode

Set positive limits in `.env`:

```dotenv
SCALPER_LIVE=1
SCALPER_MAX_ORDER_USD=100
SCALPER_MAX_DAILY_SPEND_USD=200
SCALPER_MAX_QUANTITY=1
```

Then run `npm run scalper:doctor`. Live `createScalper()` performs the same
preflight and refuses to start if any blocker remains. Once it is clean, start
`npm run scalper:serve`. This runs the watcher and local dashboard together so
human challenges can resume the active Chrome task. Open
`http://127.0.0.1:4317`.

To stop purchases immediately, set `SCALPER_KILL_SWITCH=1` and restart, or
create `data/scalper/KILL_SWITCH`. Either blocks checkout even while live mode
is enabled.

## 8. Crash recovery

Before each live checkout, a durable product-global reservation is written.
After a crash:

```bash
npm run scalper:ledger -- list
```

An unresolved reservation intentionally prevents another purchase. Check the
retailer first. Only when no order exists, release it explicitly:

```bash
SCALPER_LEDGER_ACK=1 npm run scalper:ledger -- release <reservation-id>
```

The durable task journal must also be reconciled. List it with:

```bash
npm run scalper:tasks -- list
```

If the retailer shows a completed order, reconcile both records:

```bash
SCALPER_RECONCILED_ORDER_ID='<retailer-order-id>' \
SCALPER_LEDGER_ACK=1 npm run scalper:ledger -- confirm <reservation-id>
SCALPER_TASK_ACK=1 npm run scalper:tasks -- reconcile <task-id> purchased '<retailer-order-id>'
```

If no order exists, release the ledger record and reconcile the task as
failed. Automatic retry remains blocked until this deliberate check is done.

## 9. Install the private 24/7 service

Generate a LaunchAgent using the current repository and Node paths, plus a
`Pokemon Scalper Control.app` shortcut in the local Applications directory:

```bash
npm run scalper:install
SCALPER_INSTALL_ACK=1 npm run scalper:install -- --load
```

The generated service runs `src/scalper/serve.mjs`; it does not package or
copy `.env`, Keychain values, browser profiles, or measurements. The dashboard
binds only to loopback. Set `SCALPER_DASHBOARD_TOKEN` before live mode; the
dashboard refuses to start live without HTTP Basic/Bearer authentication.

## Discord

The source `#restocks-news` Announcement channel is followed into
`#pokemon-restocks` in the operator's Homebase. Native channel notifications provide the
human alert path without a bot. Programmatic Discord ingestion remains disabled
until `SCALPER_DISCORD_BOT_TOKEN` is present locally; normal user-session tokens
are not supported. The raw review is in `docs/DISCORD-REVIEW.md`.

The separately reviewed `Restockd | Pokemon Restocks` guild uses ordinary text
channels rather than a followable Announcement channel. The parser is ready for
its `pokemon-news`, `pokemon-center`, and `pokemon-target` formats, including
`howl.link` affiliate unwrapping, but the guild cannot be consumed continuously
without an administrator-installed bot or messages forwarded into Homebase.
Amazon and Dollar General channels are intentionally excluded.

## Direct discovery and alerts

`#scalper-alerts` has a channel-scoped incoming webhook whose URL is stored only
in `.env`. The alert manager formats Discord embeds, disables mentions, and
fails on rejected HTTP responses.

Best Buy discovery reads structured inventory embedded in its public search
response. A Target public-search adapter exists but its configured sources are
disabled because repeated requests began returning HTTP 435; do not enable it
until an authorized measured endpoint is available. Neither adapter uses a
private account session, CAPTCHA bypass, or checkout automation. Run one capture
with:

Best Buy alerts are fail-closed on all four eligibility gates: the offer must
be sold by Best Buy (`seller.classification = 1P`), remain below that source's
configured price ceiling, and match `config/scalper-watchlist.json`.
Marketplace (`3P`), over-ceiling, and off-watchlist offers remain visible in
the local state file but cannot notify or schedule a purchase.
Configured Best Buy sources are also online-only: `IN_STORE_ONLY` results are
retained for visibility but cannot alert or enter checkout.

```bash
npm run scalper:discover
```

When creating a new state file, explicitly alert on currently actionable items:

```bash
npm run scalper:discover -- --notify-current
```

Subsequent captures alert only when inventory becomes actionable, fulfillment
changes, or price falls. Disabled Target sources retain near-retail price
ceilings so marketplace listings above the configured ceiling cannot alert if
the sources are later measured and enabled. Install the persistent discovery LaunchAgent
with:

```bash
install -m 644 ops/discovery-tracker.launchd.plist \
  ~/Library/LaunchAgents/com.local.pokemon-scalper-discovery.plist
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.local.pokemon-scalper-discovery.plist
```

Inspect it with `launchctl print
"gui/$(id -u)/com.local.pokemon-scalper-discovery"`. A missing or newly shaped
structured response fails closed and preserves the prior state.

Discord product alerts use the same watchlist, require a resolved URL whose
hostname matches the named retailer, and page only at rank 50 or above by
default. Queue and scheduled official notices remain eligible. Unresolved
shorteners, marketplace links, lookalike domains, generic prose about
off-watchlist products, and low-ranked chatter are recorded in metrics but do
not page.

## Resale-market ranking

The purchase system and the market tracker are intentionally separate. Edit
`config/scalper-market.json` with verified acquisition prices and provider
identifiers, then run:

```bash
npm run scalper:market -- report
```

The ranking deducts configured tax, marketplace fees, fixed fees, and shipping.
It refuses to treat eBay active asks as completed sales. See
`docs/MARKET-RESEARCH.md` for sources, import format, and scheduling.
