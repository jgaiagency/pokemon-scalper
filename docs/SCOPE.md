# Pokémon TCG Scalper — Scope & Architecture (2026-09-17)

> **STATUS: IMPLEMENTED THROUGH THE MEASURED-RETAILER BOUNDARY.** The shared
> core, transports, structured Discord parsing, wiring, health checks, launchd
> runner, runtime account/session wiring, durable purchase safety,
> replay/doctor tooling, measurement capture, metrics, recipe-driven visible
> Chrome checkout, and resilient shutdown/reconnect behavior are built. The
> four site commands are runnable. Current retailer endpoints, selectors, and
> confirmation states remain measurement-dependent configuration.
>
> **OPEN ITEMS (his calls, §11):**
> - Which 3–5 products to target first
> - Account creation (1 per site to start)
> - DevTools measurement of site endpoints and selectors
>
> **DISCORD IDS (re-verified 2026-10-01; the original category/channel labels were swapped):**
> - Guild: `<private-guild-id>`
> - Monitor category: `<private-monitor-category-id>`
> - Official-updates channel: `<private-official-channel-id>`
> - Excluded chat/noise channel: `<private-noise-channel-id>`

His words: *"i want to fully scope out a pokemon scalper that will be able to
autobuy packages for us right when they drop. we want to build an extremely
fast algo that goes through these websites, has bot detection, etc to maximize
our purchases as fast as possible."*

Sites: **Pokémon Center, TCGPlayer, Target, Best Buy.**
Product: **Sealed TCG** (booster boxes, ETBs, premium tins, collector boxes).
Drop types: **both** — scheduled (known time) and surprise (stock appears).
Infra: **local Mac mini, 24/7.**
Accounts: **none yet** — this doc includes the account strategy.
Payment: **deferred** — dry-run / paper mode first, real cards in testing.
Drop intel: **his Discord server** — a reliable feed of drop announcements
across all stores. This is a primary signal source, not just an alert channel.

---

## §0. What this is and is not

This is a **time-sensitive purchase system**. The goal is to detect that a
product is available and complete an ordinary purchase flow quickly. The
architecture optimises for the critical path:
**detect → decide → checkout → confirm.**

What it is NOT:
- Not a marketplace (we're buying, not selling).
- Not a general-purpose scraper (we target specific product pages / SKUs).
- Not a headless-browser-only solution (API-first where possible, browser as
  fallback).
- Not multi-region (US drops only, for now).

The three sites have fundamentally different drop mechanics, so this is a
**three-lane system** with a shared detection core and per-site checkout
adapters.

---

## §1. The three lanes, ranked by build priority

| Lane | Site | Drop type | Why this order |
|------|------|-----------|----------------|
| 1 | **Pokémon Center** | Scheduled (queue) | The drops are here. Known times. Queue reduces the race. Smallest buyer pool. |
| 2 | **TCGPlayer** | Surprise (marketplace listing) | API-friendly. No queue. The race is "who clicks buy first" on a seller's listing. |
| 3 | **Best Buy** | Both (scheduled + surprise) | Moderate bot detection. Smaller buyer pool than Target. Good markup on sealed TCG. |
| 4 | **Target** | Both (scheduled + surprise) | Hardest bot detection (DataDome). Largest buyer pool. Highest markup. |

**Build order: Lane 1 → Lane 2 → Lane 3 → Lane 4.** Each lane is
independently shippable. The shared core (clock sync, drop calendar, account
manager, dry-run harness, Discord feed) is built once and reused.

---

## §2. Shared core (built once, used by all lanes)

### 2.1 Clock sync

The single most important subsystem. If your clock is 200 ms off, you're
clicking before the button exists (or after the stock is gone).

```
src/scalper/clock.mjs
```

- Query 3+ NTP sources (pool.ntp.org, time.apple.com, time.cloudflare.com)
  every 30 s. Compute offset + jitter.
- Maintain a **monotonic clock** internally (performance.now() or
  process.hrtime.bigint()) for event ordering.
- Expose `now()` (ms since epoch, NTP-corrected) and `driftMs()` (current
  offset from best NTP source).
- Alert (log + optional webhook) when drift > 100 ms.
- **Do NOT use HTTP Date headers** as a clock source — they're
  second-granularity and can be cached by intermediaries.

### 2.2 Drop calendar

```
src/scalper/drop-calendar.mjs
config/scalper-drops.json
```

A config file of known drops:

```json
{
  "drops": [
    {
      "id": "scarlet-violet-151-booster-box",
      "name": "SV 151 Booster Box",
      "sites": ["pokemon-center", "tcgplayer", "target"],
      "time": "2026-09-23T14:00:00Z",
      "type": "scheduled",
      "productUrls": {
        "pokemon-center": "https://www.pokemoncenter.com/products/...",
        "tcgplayer": "https://www.tcgplayer.com/product/...",
        "target": "https://www.target.com/p/..."
      },
      "skus": {
        "pokemon-center": "1234567890",
        "tcgplayer": 987654321,
        "target": "A12345678"
      }
    }
  ]
}
```

The drop calendar scraper (§2.5) populates this. The pollers read it and
spin up 5 min before each drop.

### 2.3 Account manager

```
src/scalper/accounts.mjs
config/scalper-accounts.json
```

Per-site account config:

```json
{
  "pokemon-center": [
    {
      "id": "pc-1",
      "email": "user1@example.com",
      "password": "keychain:PC1_PASS",
      "card": { "brand": "visa", "last4": "4242", "secret": "keychain:PC1_CARD" },
      "address": { "street": "...", "city": "...", "state": "...", "zip": "..." },
      "sessionFile": "data/scalper/sessions/pc-1.json"
    }
  ],
  "tcgplayer": [
    { "id": "tcp-1", "email": "user1@example.com", "password": "keychain:TCP1_PASS" }
  ],
  "target": [
    { "id": "tgt-1", "email": "user1@example.com", "password": "keychain:TGT1_PASS" }
  ]
}
```

**Account strategy (he has none yet):**

- **Start with 1 account per site.** Get the full pipeline working end-to-end
  with one account before scaling.
- **Account creation:**
  - Pokémon Center: sign up at pokemoncenter.com. No verification beyond
    email. Add a payment method (even a $0 virtual card works for testing).
  - TCGPlayer: sign up at tcgplayer.com. Email verification. Add a card.
  - Best Buy: sign up at bestbuy.com. Email verification. Add a card.
    Best Buy checks IP and payment consistency but is less strict than Target.
  - Target: sign up at target.com. Email + phone verification. Add a card.
    Target is the strictest — they check IP, device, and payment method
    consistency.
- **Current operating boundary:** one legitimate account per site, conservative
  quantity limits, and the retailer's ordinary browser flow.
- **Session persistence:** each account's authenticated session (cookies,
  tokens) is saved to `data/scalper/sessions/<id>.json` and reused across
  runs. The session is refreshed on auth failure.

### 2.4 Dry-run / paper mode

```
src/scalper/dry-run.mjs
```

The entire pipeline runs in **paper mode** by default. No real money moves.

- `SCALPER_LIVE=1` arms real purchases (mirrors the `FANVUE_LIVE` pattern).
- In paper mode:
  - Detection runs normally (polling, API calls, page checks).
  - The "add to cart" step is simulated (or uses a real cart that's abandoned).
  - The "checkout" step logs the intended purchase but does NOT submit payment.
  - The "confirm" step records the result in `data/scalper/paper-orders.jsonl`.
- Every paper order is logged with: timestamp, site, product, account,
  simulated latency, would-have-paid amount.
- **This is how we test the full pipeline before a single real card is charged.**

### 2.5 Drop calendar scraper

```
src/scalper/drop-scraper.mjs
```

Scrapes upcoming Pokémon TCG release dates from:
- Pokémon's official release announcements (pokemon.com, pokemoncenter.com)
- TCGPlayer's "coming soon" / pre-order listings
- Target's product pages (when a product is listed but "out of stock" with
  a "notify me" option, it's a scheduled drop)
- Best Buy's product pages (same pattern as Target)

Output: updates `config/scalper-drops.json`.

This is a **secondary** scraper — the primary detection is the per-site
poller. The drop calendar tells the pollers *when* to spin up.

### 2.6 Discord drop feed (primary signal)

```
src/scalper/discord-feed.mjs
config/scalper-discord.json
```

The source server's Announcement channel is followed natively into the private
Homebase `#pokemon-restocks` channel. Native Discord notifications provide the
primary human signal without programmatically automating a user account.

Programmatic ingestion is optional. When enabled, the feed uses an authorized
Discord bot installed by a server administrator, watches the configured mirror
channel, logs messages, parses structured monitor embeds, ranks and deduplicates
signals, updates the drop calendar, and reconnects with bounded backoff. Normal
user-session tokens are rejected.

**Current config:**

```json
{
  "mode": "bot-token",
  "tokenEnv": "SCALPER_DISCORD_BOT_TOKEN",
  "guildId": "replace-me-guild-id",
  "channelIds": ["replace-me-channel-id"],
  "monitorChannelIds": ["replace-me-channel-id"],
  "stores": ["pokemon-center", "tcgplayer", "bestbuy", "target"]
}
```

**Why this matters:**
- Drop announcements in Discord often come **minutes before** the site's
  own announcement. That's a head start.
- The Discord feed covers **all stores** in one place — no need to scrape
  each site's blog/announcement page.
- It's a **human-curated** signal — less noise than a scraper.
- The orchestrator can use the Discord timestamp as the drop time (more
  reliable than guessing from the site's "coming soon" page).

**Integration with the orchestrator:**
- The Discord feed is a **push** signal (message arrives → parse → schedule).
- The per-site pollers are a **pull** signal (poll → detect → fire).
- Both feed the same drop calendar. The orchestrator doesn't care which
  signal source triggered the drop — it just reads the calendar.

The reviewed message samples and implemented parser patterns are documented in
`docs/DISCORD-REVIEW.md`.

---

## §3. Lane 1: Pokémon Center

### 3.1 What we know

- **Platform:** Custom stack (not Shopify). React frontend.
- **Bot detection:** Cloudflare (likely). Possible DataDome. Need to measure.
- **Drop mechanics:** Scheduled drops with a **queue/waitroom**. Product page
  exists before T-0 but "Add to Cart" is disabled. At T-0, the queue opens
  and buyers are let through in order.
- **Checkout:** Browser-based. Payment via their own gateway (likely Stripe
  or Braintree under the hood). Possible 3D Secure step.
- **Terms:** Pokémon Center's terms (at least for the JP store) explicitly
  prohibit automated purchasing. US terms need review. We're building a
  speed system, not a compliant integration — but this means we should be
  conservative with request rates.

### 3.2 Detection

```
src/scalper/sites/pokemon-center/detect.mjs
```

**Strategy:** Poll the product page's JSON endpoint (or the queue API) at
high frequency in the 30 s before T-0.

- **Pre-drop (T-5 min to T-30 s):** Poll every 2 s. Check if the product
  page's "availability" field has changed.
- **At T-0:** Poll every 200 ms. The moment "Add to Cart" becomes enabled,
  fire the checkout.
- **Queue tracking:** If there's a queue API (likely — the queue position
  is displayed in the UI), poll it to track our position. When we're in the
  top N, go full-throttle.

**What to measure (first build task):**
- [ ] Identify the product page's JSON endpoint (DevTools → Network → XHR).
- [ ] Identify the queue API (if any).
- [ ] Identify the "Add to Cart" API call.
- [ ] Identify the checkout API calls (cart → shipping → payment → confirm).
- [ ] Identify the WAF (Cloudflare? DataDome? Check response headers).
- [ ] Measure the latency from "stock available" to "order confirmed" on a
  real drop (or a test product).

### 3.3 Checkout

```
src/scalper/sites/pokemon-center/checkout.mjs
```

**Strategy:** API-first, browser-fallback.

1. **Pre-authenticated session** (from the account manager). Logged in,
   card on file, address saved.
2. **Add to cart:** POST to the cart API with the product ID.
3. **Checkout:** POST to the checkout API with shipping + payment info.
4. **Confirm:** POST to the order API. Get the order number.

If any step fails (WAF challenge, 3D Secure redirect, API change), fall back
to **Playwright with stealth** (real Chrome, not headless):
- Navigate to the product page.
- Click "Add to Cart."
- Navigate to checkout.
- Fill in payment (or use saved card).
- Click "Place Order."
- Wait for the confirmation page.

**Bot detection countermeasures:**
- Realistic TLS fingerprint (use `undici` or `fetch` with a real TLS stack,
  not Node's default).
- Consistent User-Agent, Accept-Language, and other headers.
- No `navigator.webdriver` tell (Playwright stealth plugin).
- Session persistence (cookies, localStorage) across runs.
- Rate limiting: don't poll more than 5 req/s per account.

### 3.4 Module breakdown

```
src/scalper/sites/pokemon-center/
  index.mjs          — lane entry point (detect → checkout → confirm)
  detect.mjs         — product page / queue polling
  checkout.mjs       — API checkout + Playwright fallback
  session.mjs        — auth, session persistence, refresh
  fingerprint.mjs    — TLS fingerprint, headers, UA
  config.mjs         — site-specific config (URLs, endpoints, selectors)
```

---

## §4. Lane 2: TCGPlayer

### 4.1 What we know

- **Platform:** Custom stack. React frontend.
- **API:** `api.tcgplayer.com` — RESTful. Catalog, pricing, store inventory.
  **No public buyer-checkout API** (the API is seller-side), but the catalog
  and pricing endpoints are open (with an application key).
- **Bot detection:** Lighter than Pokémon Center / Target. No queue.
- **Drop mechanics:** Marketplace model. Sellers list stock. When a seller
  adds a new listing (or restocks an existing one), it's available for
  purchase. No time gate — it's a "stock just appeared" event.
- **Checkout:** Browser-based. Simpler than Pokémon Center (no queue).
- **Terms:** API terms say "no automated purchasing" but mean "don't build
  a competing marketplace." A single buyer clicking buy is fine.

### 4.2 Detection

```
src/scalper/sites/tcgplayer/detect.mjs
```

**Strategy:** Use the TCGPlayer API to watch for new listings / restocks.

- **Catalog API:** `GET /catalog/products/{productIds}` — check if a product
  has available SKUs.
- **Store inventory API:** `GET /stores/{storeKey}/inventory` — check a
  specific store's stock levels.
- **Polling:** Every 5 s for known products. Every 30 s for the full catalog
  (search for new Pokémon TCG sealed product listings).
- **Alert:** When a product's available quantity goes from 0 → N, fire the
  checkout.

**What to measure (first build task):**
- [ ] Get a TCGPlayer API key (application form at developer.tcgplayer.com).
- [ ] Identify the product IDs for the target sealed products.
- [ ] Measure the polling rate limit (how fast can we hit the API?).
- [ ] Identify the "Add to Cart" and checkout flow on the website.
- [ ] Measure the latency from "stock available" to "order confirmed."

### 4.3 Checkout

```
src/scalper/sites/tcgplayer/checkout.mjs
```

**Strategy:** Browser-based (no buyer API). Playwright with stealth.

1. **Pre-authenticated session** (from the account manager).
2. **Navigate** to the product page.
3. **Add to cart** (click or API).
4. **Checkout** (fill in shipping + payment, or use saved).
5. **Confirm** (click "Place Order," wait for confirmation).

**Bot detection countermeasures:**
- Playwright stealth (real Chrome, no `navigator.webdriver`).
- Consistent session (cookies, localStorage).
- Rate limiting: don't hit the same product page more than 1 req/s.

### 4.4 Module breakdown

```
src/scalper/sites/tcgplayer/
  index.mjs          — lane entry point
  detect.mjs         — API polling for new listings / restocks
  checkout.mjs       — Playwright checkout
  session.mjs        — auth, session persistence
  api.mjs            — TCGPlayer API client (catalog, pricing, inventory)
  config.mjs         — site-specific config
```

---

## §5. Lane 3: Best Buy

### 5.1 What we know

- **Platform:** Custom React/Node stack.
- **Bot detection:** Akamai (likely). Moderate fingerprinting. Less strict
  than Target's DataDome but more than TCGPlayer.
- **Drop mechanics:** Both scheduled (known time, "notify me") and surprise
  (stock appears). No queue — it's a pure race.
- **Checkout:** Browser-based. Payment via their own gateway (or PayPal).
  Possible 3D Secure.
- **Terms:** No public buyer API. Browser-only.
- **Challenge:** Smaller buyer pool than Target (Best Buy is more
  electronics-focused, so fewer TCG scalpers). Good markup on sealed TCG.
  Less bot detection than Target, making it a good middle-ground lane.

### 5.2 Detection

```
src/scalper/sites/bestbuy/detect.mjs
```

**Strategy:** Poll the product page's JSON endpoint.

- **Pre-drop (T-5 min to T-0):** Poll every 1 s. Check the "availability"
  field.
- **At T-0:** Poll every 200 ms. The moment "Add to Cart" becomes enabled,
  fire the checkout.
- **Surprise drops:** Poll known product pages every 5 s, 24/7. When stock
  goes 0 → N, fire.

**What to measure (first build task):**
- [ ] Identify the product page's JSON endpoint (DevTools → Network).
- [ ] Identify the "Add to Cart" API call.
- [ ] Identify the checkout API calls.
- [ ] Identify the WAF (Akamai? Check for `ak_bmsc` cookie, `server: akamai`
  header).
- [ ] Measure the latency from "stock available" to "order confirmed."

### 5.3 Checkout

```
src/scalper/sites/bestbuy/checkout.mjs
```

**Strategy:** Playwright with stealth. API is not available for buyers.

1. **Pre-authenticated session** (from the account manager).
2. **Navigate** to the product page.
3. **Add to cart** (click).
4. **Checkout** (fill in shipping + payment, or use saved).
5. **Confirm** (click "Place Order," wait for confirmation).

**Bot detection countermeasures:**
- Playwright stealth plugin (real Chrome, no `navigator.webdriver`).
- Consistent session (cookies, localStorage).
- Rate limiting: don't hit the same page more than 1 req/s.
- Akamai-specific: maintain a consistent `ak_bmsc` cookie, don't clear
  cookies between runs.

### 5.4 Module breakdown

```
src/scalper/sites/bestbuy/
  index.mjs          — lane entry point
  detect.mjs         — product page polling
  checkout.mjs       — Playwright checkout
  session.mjs        — auth, session persistence
  config.mjs         — site-specific config
```

---

## §6. Lane 4: Target

### 6.1 What we know

- **Platform:** Custom React/Node stack.
- **Bot detection:** **DataDome** (likely). Strong fingerprinting.
- **Drop mechanics:** Both scheduled (known time, "notify me") and surprise
  (stock appears). No queue — it's a pure race.
- **Checkout:** Browser-based. Payment via their own gateway. Possible
  3D Secure.
- **Terms:** No public buyer API. Browser-only.
- **Challenge:** Largest buyer pool of the three. Hardest bot detection.
  But the highest markup (Target sealed TCG sells out in seconds).

### 6.2 Detection

```
src/scalper/sites/target/detect.mjs
```

**Strategy:** Poll the product page's JSON endpoint.

- **Pre-drop (T-5 min to T-0):** Poll every 1 s. Check the "availability"
  field.
- **At T-0:** Poll every 200 ms. The moment "Add to Cart" becomes enabled,
  fire the checkout.
- **Surprise drops:** Poll known product pages every 5 s, 24/7. When stock
  goes 0 → N, fire.

**What to measure (first build task):**
- [ ] Identify the product page's JSON endpoint (DevTools → Network).
- [ ] Identify the "Add to Cart" API call.
- [ ] Identify the checkout API calls.
- [ ] Identify the WAF (DataDome? Check for `datadome` cookie, `x-datadome`
  header).
- [ ] Measure the DataDome challenge flow (what does it look like? How long
  does it take to pass?).
- [ ] Measure the latency from "stock available" to "order confirmed."

### 6.3 Checkout

```
src/scalper/sites/target/checkout.mjs
```

**Strategy:** Playwright with stealth. API is not available for buyers.

1. **Pre-authenticated session** (from the account manager).
2. **Navigate** to the product page.
3. **Add to cart** (click).
4. **Checkout** (fill in shipping + payment, or use saved).
5. **Confirm** (click "Place Order," wait for confirmation).

**Bot detection countermeasures (Target is the hardest):**
- **DataDome bypass:**
  - Realistic TLS fingerprint (JA3/JA4).
  - Consistent browser fingerprint (canvas, WebGL, audio context, fonts).
  - No `navigator.webdriver`, no `chrome.runtime` tells.
  - Consistent IP (residential proxy, not datacenter).
  - Session persistence (cookies, localStorage, IndexedDB).
  - **Do NOT clear cookies between runs.** DataDome tracks device history.
- **Playwright stealth plugin** (or `playwright-extra` + `stealth` plugin).
- **Rate limiting:** Don't hit the same page more than 1 req/s. Space out
  requests with random jitter (800–1200 ms).
- **Human-like behavior:** Mouse movements, scroll events, focus/blur events.
  (Playwright can simulate these.)

### 6.4 Module breakdown

```
src/scalper/sites/target/
  index.mjs          — lane entry point
  detect.mjs         — product page polling
  checkout.mjs       — Playwright checkout
  session.mjs        — auth, session persistence
  datadome.mjs       — DataDome fingerprint, challenge handling
  config.mjs         — site-specific config
```

---

## §7. The orchestrator

```
src/scalper/orchestrator.mjs
```

The top-level loop. Reads the drop calendar, spins up the relevant lanes,
and coordinates the race.

```
1. Read config/scalper-drops.json.
2. For each upcoming drop (next 24 h):
   a. T-5 min: spin up the relevant lane(s).
   b. T-30 s: go full-throttle (polling rate up).
   c. T-0: fire the checkout.
   d. Post-drop: log the result, update the drop calendar.
3. For surprise drops (TCGPlayer, Target):
   a. Continuous polling (lower rate).
   b. On stock detection: fire the checkout.
```

**Concurrency model:**
- One orchestrator process (the Mac mini runs it 24/7).
- Each lane runs in its own async context (no threads needed — Node's event
  loop is fast enough for polling + API calls).
- Playwright instances are the only heavy resource — one per site, reused
  across accounts.
- **Max concurrent checkouts:** 1 per site (don't race yourself). If you
  have 3 accounts on Pokémon Center, they take turns (or you pick the best
  one based on queue position).

**Failure handling:**
- If a checkout fails (WAF challenge, 3D Secure, out of stock), log it and
  retry once (if the product is still available).
- If all accounts fail, log the drop as "missed" and alert.
- **Never double-buy:** a per-product lock ensures only one checkout is in
  flight at a time.

---

## §8. The test harness

```
tests/scalper/
  clock.test.mjs         — NTP sync, drift detection, monotonic ordering
  drop-calendar.test.mjs — config parsing, drop scheduling
  accounts.test.mjs      — account config, session persistence
  dry-run.test.mjs       — paper mode: detect → checkout → confirm, no money
  discord-feed.test.mjs  — message parsing, drop extraction, calendar update
  pokemon-center/
    detect.test.mjs      — polling logic, availability detection
    checkout.test.mjs    — API checkout flow (mocked), Playwright fallback
  tcgplayer/
    detect.test.mjs      — API polling, stock detection
    checkout.test.mjs    — Playwright checkout (mocked)
  bestbuy/
    detect.test.mjs      — polling logic, Akamai detection
    checkout.test.mjs    — Playwright checkout (mocked)
  target/
    detect.test.mjs      — polling logic, DataDome detection
    checkout.test.mjs    — Playwright checkout (mocked)
  orchestrator.test.mjs  — drop scheduling, lane coordination, concurrency
```

**Testing conventions (mirrors the repo's existing rules):**
- One test file per module. No network in tests (mock the HTTP layer).
- Named regressions: every bug found in a live run gets a test.
- A false-positive sibling per gate: every "stock detected" test has a
  matching "stock NOT detected" test.
- **A test that reaches production data is not a flaky test — it is data
  loss.** Anything that writes under `data/scalper/` takes an injectable
  seam. `npm run guard` is the whole-suite check.
- **A passing proof is not evidence until you have seen it fail.** Every
  test is run red first (break the code, watch the test fail, fix the code,
  watch it pass).

**The dry-run harness is the primary test.** Before any real card is
charged, the full pipeline (detect → checkout → confirm) runs in paper mode
against a live drop. The paper order log is the receipt.

---

## §9. Build plan (sequenced)

### Phase 1: Shared core (Week 1)

1. **Clock sync** (`src/scalper/clock.mjs`) — NTP, monotonic, drift alert.
   Tests: `tests/scalper/clock.test.mjs`.
2. **Drop calendar** (`src/scalper/drop-calendar.mjs`,
   `config/scalper-drops.json`) — config parsing, drop scheduling.
   Tests: `tests/scalper/drop-calendar.test.mjs`.
3. **Account manager** (`src/scalper/accounts.mjs`,
   `config/scalper-accounts.json`) — account config, session persistence.
   Tests: `tests/scalper/accounts.test.mjs`.
4. **Dry-run harness** (`src/scalper/dry-run.mjs`) — paper mode, order log.
   Tests: `tests/scalper/dry-run.test.mjs`.
5. **Drop calendar scraper** (`src/scalper/drop-scraper.mjs`) — populate
   the drop calendar from official sources.
6. **Discord drop feed** (`src/scalper/discord-feed.mjs`,
   `config/scalper-discord.json`) — watch his Discord server for drop
   announcements, parse them, update the drop calendar.
   Tests: `tests/scalper/discord-feed.test.mjs`.

**Deliverable:** `npm run scalper:dry` — runs the full pipeline in paper
mode against a configured drop. No money moves. The paper order log is the
receipt. The Discord feed is live and feeding the drop calendar.

### Phase 2: Lane 1 — Pokémon Center (Week 2)

6. **Measure the site** (DevTools, Network tab):
   - Product page JSON endpoint.
   - Queue API (if any).
   - Add-to-cart API.
   - Checkout API calls.
   - WAF (Cloudflare? DataDome?).
   - Latency from "stock available" to "order confirmed."
7. **Detection** (`src/scalper/sites/pokemon-center/detect.mjs`).
   Tests: `tests/scalper/pokemon-center/detect.test.mjs`.
8. **Checkout** (`src/scalper/sites/pokemon-center/checkout.mjs`) — API
   first, Playwright fallback.
   Tests: `tests/scalper/pokemon-center/checkout.test.mjs`.
9. **Session** (`src/scalper/sites/pokemon-center/session.mjs`) — auth,
   persistence, refresh.
10. **Fingerprint** (`src/scalper/sites/pokemon-center/fingerprint.mjs`) —
    TLS, headers, UA.
11. **Lane entry point** (`src/scalper/sites/pokemon-center/index.mjs`).

**Deliverable:** `npm run scalper:pc` — runs the Pokémon Center lane
(detect → checkout → confirm) in paper mode. Then `SCALPER_LIVE=1` for a
real purchase.

### Phase 3: Lane 2 — TCGPlayer (Week 3)

12. **Get API key** (application form at developer.tcgplayer.com).
13. **Measure the site** (API rate limits, checkout flow).
14. **API client** (`src/scalper/sites/tcgplayer/api.mjs`) — catalog,
    pricing, inventory.
15. **Detection** (`src/scalper/sites/tcgplayer/detect.mjs`).
16. **Checkout** (`src/scalper/sites/tcgplayer/checkout.mjs`) — Playwright.
17. **Session** (`src/scalper/sites/tcgplayer/session.mjs`).
18. **Lane entry point** (`src/scalper/sites/tcgplayer/index.mjs`).

**Deliverable:** `npm run scalper:tcp` — runs the TCGPlayer lane in paper
mode. Then `SCALPER_LIVE=1` for a real purchase.

### Phase 4: Lane 3 — Best Buy (Week 4)

19. **Measure the site** (DevTools, Network tab):
    - Product page JSON endpoint.
    - Add-to-cart API.
    - Checkout API calls.
    - Akamai challenge flow.
    - Latency from "stock available" to "order confirmed."
20. **Detection** (`src/scalper/sites/bestbuy/detect.mjs`).
21. **Checkout** (`src/scalper/sites/bestbuy/checkout.mjs`) — Playwright.
22. **Session** (`src/scalper/sites/bestbuy/session.mjs`).
23. **Lane entry point** (`src/scalper/sites/bestbuy/index.mjs`).

**Deliverable:** `npm run scalper:bb` — runs the Best Buy lane in paper
mode. Then `SCALPER_LIVE=1` for a real purchase.

### Phase 5: Lane 4 — Target (Week 5)

24. **Measure the site** (DevTools, Network tab):
    - Product page JSON endpoint.
    - Add-to-cart API.
    - Checkout API calls.
    - DataDome challenge flow.
    - Latency from "stock available" to "order confirmed."
25. **Detection** (`src/scalper/sites/target/detect.mjs`).
26. **DataDome** (`src/scalper/sites/target/datadome.mjs`) — fingerprint,
    challenge handling.
27. **Checkout** (`src/scalper/sites/target/checkout.mjs`) — Playwright.
28. **Session** (`src/scalper/sites/target/session.mjs`).
29. **Lane entry point** (`src/scalper/sites/target/index.mjs`).

**Deliverable:** `npm run scalper:tgt` — runs the Target lane in paper
mode. Then `SCALPER_LIVE=1` for a real purchase.

### Phase 6: Orchestrator + 24/7 (Week 6)

30. **Orchestrator** (`src/scalper/orchestrator.mjs`) — drop scheduling,
    lane coordination, concurrency.
    Tests: `tests/scalper/orchestrator.test.mjs`.
31. **24/7 runner** — `npm run scalper:watch` — the orchestrator as a
    long-running process (launchd on the Mac mini).
32. **Alerting** — webhook / SMS on drop detected, purchase confirmed,
    purchase failed.
33. **Monitoring** — `npm run scalper:health` — clock drift, session
    validity, account status, recent drops.

**Deliverable:** The Mac mini runs the scalper 24/7. Drops are detected,
purchases are made (paper or live), and the operator is alerted.

---

## §10. Safety strategy — how to scalp without getting burned

The goal is to buy fast without getting banned, charged back, or flagged for
fraud. This is the "safest way to do it" section.

### 10.1 Account hygiene

- **One identity per account.** Each account has its own email, phone,
  payment method, and shipping address. No shared info across accounts
  (until you scale to 3+ and start using different cards).
- **Consistent IP.** Each account is always accessed from the same IP
  (or the same subnet). If you use a residential proxy, pin the account to
  that proxy. Don't rotate IPs randomly — that's a bot tell.
- **Consistent device fingerprint.** Each account uses the same browser
  profile (same cookies, localStorage, IndexedDB). Don't clear the profile
  between runs.
- **Human-like timing.** Don't fire all accounts at the exact same
  millisecond. Stagger them by 50–200 ms. A human clicking "buy" on three
  accounts doesn't do it in the same tick.
- **Warm up new accounts.** A brand-new account that immediately buys a
  high-demand item is a fraud flag. Before the first live drop:
  1. Create the account.
  2. Browse the site for 5–10 min (view a few products, add one to cart,
     remove it).
  3. Make a small purchase (a $5–10 item, not the target product).
  4. Wait 24–48 h.
  5. Then hit the first real drop.

### 10.2 Payment safety

- **Virtual cards first.** Use a virtual card service (Privacy, Mercury,
  or a bank's virtual card feature) for the first few live runs. If the
  site charges and you cancel, the virtual card absorbs the hit without
  exposing your main card.
- **One card per account (at first).** Don't share a physical card across
  multiple accounts. If you scale to 3+ accounts, use 3 different virtual
  cards (or 3 different physical cards from the same bank).
- **3D Secure handling.** If the site triggers a 3D Secure challenge
  (OTP to your phone/email), the Playwright session needs to handle it:
  - Detect the challenge (look for the OTP input field).
  - Alert the operator (Discord webhook, SMS, desktop notification).
  - Wait for the operator to enter the OTP (or auto-fill it if you have
    access to the email/phone).
  - **Timeout:** if the OTP isn't entered within 60 s, abort the checkout
    and retry with the next account.
- **Chargeback protection.** Keep the order confirmation email + receipt
  for every purchase. If the site disputes the charge, you have the proof
  of purchase.

### 10.3 Retailer compatibility boundary (per site)

| Site | Observed/expected protection | Implemented behavior |
|------|-----|---------------------|
| Pokémon Center | Queue and CAPTCHA | Persistent visible Chrome, bounded polling, human challenge/resume |
| TCGPlayer | Session and checkout validation | Persistent visible Chrome, bounded polling, session-health markers |
| Best Buy | Akamai/queue behavior | Persistent visible Chrome, bounded polling, queue/challenge handoff |
| Target | DataDome behavior | Persistent visible Chrome, backoff on blocks, challenge handoff |

**Universal implementation rules:**
- Use visible system Chrome (`channel: 'chrome'`, `headless: false`).
- Preserve each account's ordinary browser profile and cookies.
- Apply configured polling ceilings, jitter, backoff, and abort signals.
- Pause for CAPTCHA, OTP, queues, and 3-D Secure; notify the operator and
  resume the same task after manual completion.
- Treat any ambiguous post-submit result as `uncertain`; never repeat the
  irreversible commit until the retailer order history is reconciled.
- Site-specific unmeasured work is listed in
  `docs/RETAILER-MEASUREMENT-BACKLOG.md`.

### 10.4 The "paper mode" safety net

The dry-run harness (§2.4) is the primary safety net. Before any real
card is charged:

1. Run the full pipeline in paper mode against a live drop.
2. Verify the detection fired at the right time.
3. Verify the checkout flow completed (simulated).
4. Verify the paper order log has the correct data.
5. **Only then** switch to `SCALPER_LIVE=1`.

If a paper run fails, fix it before going live. A failed paper run is
free. A failed live run is a missed drop (or a double-charge).

### 10.5 What to do when things go wrong

- **WAF challenge (CAPTCHA, "verify you're human"):**
  - Alert the operator.
  - The operator solves it manually in the already-open browser.
  - Resume the same durable task from the local dashboard.

- **3D Secure timeout:**
  - Leave the purchase task and ledger reservation unresolved.
  - Mark the result `uncertain` and alert the operator.
  - Check retailer order history before explicitly confirming or releasing
    the reservation. Do not retry automatically.

- **Out of stock (race lost):**
  - Log the drop as "missed."
  - Check if the site has a "notify me" / "restock alert" option. If so,
    subscribe (it's free and gives you a head start on the next drop).
  - Alert the operator with the product + site + time missed.

- **Double-charge (two accounts both succeeded):**
  - This is the worst case. It means the per-product lock failed.
  - Keep the cheaper order, cancel the other (within the cancellation
    window).
  - Log the incident + the fix (tighten the lock).

### 10.6 The "guarantee" — what we can and can't control

**We can control:**
- Detection speed (clock sync, polling rate, API-first).
- Checkout speed (pre-filled cart, saved payment, API-first).
- Session consistency, rate limiting, challenge handoff, and fail-closed recovery.
- Failure handling (retry, fallback, alert).

**We can't control:**
- The site's server-side race (if 10,000 people click at the same time,
  the site's backend decides who wins — not us).
- The site's bot detection (they can update their WAF at any time).
- The site's stock (if they only have 10 units and 100 people want them,
  we might lose).

**The "guarantee" is a probability, not a certainty.** The system maximises
our odds by being faster, cleaner, and more resilient than the average
buyer. It doesn't eliminate the race — it wins the race more often.

---

## §11. Open questions (his calls)

1. **Which products first?** The drop calendar needs a starting list. What
   are the 3–5 sealed products we're targeting for the first live run?
2. **Accounts:** 1 per site to start (recommended). Do you want me to write
   the account creation steps, or do you want to do it manually?
3. **Payment:** Paper mode first (recommended). When do we switch to real
   cards? (After the first successful paper run, I'd say.)
4. **Mac mini setup:** Is Node 22+ installed? Is Playwright + Chrome
   installed? Do we need a launchd plist for the 24/7 runner?
5. **Alerting:** Where do drop alerts go? (Discord webhook? SMS? Desktop
   notification?)
6. **Budget:** Are we buying 1 unit per drop, or multiple? (This affects
   the checkout logic — some sites limit quantity per account.)
7. **Discord drop feed:** The source Announcement channel is followed into a
   private Homebase mirror with native notifications. Programmatic ingestion
   is optional and accepts only an authorized bot token installed with server
   permission; normal user-session tokens are not supported.

---

## §12. What this doc is NOT

- Not a build. It's a scope. The build starts with Phase 1, Step 1
  (clock sync).
- Not a guarantee. The "what to measure" lists in §3.2, §4.2, §5.2 are
  hypotheses — the first build task on each lane is to confirm or correct
  them with DevTools.
- Not a multi-region system. US drops only, for now.
- Not a selling system. We're buying, not listing.

**Build status (2026-10-02):** The measurement-independent execution platform
is implemented, including durable tasks, Keychain secrets, human challenge
resume, session health, uncertain-order reconciliation, the local dashboard,
and private LaunchAgent installation. Live startup is fail-closed behind
account, session-profile, product/poll URL, price, safety-limit, and measured
checkout recipe checks. The remaining work is retailer-specific observation
and local configuration. Follow `docs/OPERATOR-RUNBOOK.md` and
`docs/RETAILER-MEASUREMENT-BACKLOG.md`.
