# Codex Brief — Scalper Wiring (no browser needed)

> Historical steering document. Current behavior and setup are defined by
> `docs/ARCHITECTURE.md`, `SECURITY.md`, tests, and source.

**Context:** We are building a Pokémon TCG scalper. The operator (Claude) owns
the live-browser measurement (WAF, selectors, endpoints). Codex owns the
compliant/structural wiring. This brief is the wiring work that unblocks the
canary gate **without** a live browser — every item is testable with `npm test`.

**Ground rules (from CLAUDE.md):**
- Node 26.8.2, `node:sqlite` (zero new deps beyond `discord.js` + `playwright`).
- One test file per module, no network in tests. Named regressions.
- A rule that lives only in prose has failed here before — put it in a red test.
- `git commit -- <paths>` (never bare `git add X && git commit`).
- Do NOT edit source while a mutation register runs.

**What is already measured (operator's lane, do not re-derive):**
- Best Buy: light WAF. Availability is in JSON-LD (`offers[0].availability` =
  `https://schema.org/InStock`, `offers[0].price` = 79.99, `offers[0].sku`).
  Contract row exists in `config/scalper-product-endpoints.json`. Fixture at
  `tests/fixtures/bestbuy/in-stock.json`.
- Pokémon Center: Imperva Incapsula. Hard block on product endpoint for a
  datacenter IP (cookies set, challenge iframe never resolves). Next lever is a
  residential IP — that's the operator's lane, not yours.
- `src/scalper/transports/browser-http.mjs` exists (warms a Playwright context,
  then polls via `context.request`). It has NO test yet.

---

## PROMPT 1 — Test the browser-http transport (no network)

`src/scalper/transports/browser-http.mjs` exports `createBrowserHttpTransport`
and `openWarmedBrowserTransport`. Write `tests/scalper/transports/browser-http.test.mjs`
that, with a **mock Playwright context** (no real browser, no network):

1. `createBrowserHttpTransport` throws when given a context without a `request` API.
2. `get()` calls `context.request.fetch` with `method: 'GET'` and the URL, and
   returns `{ status, headers, body, url, bodyJson }`.
3. `postJson()` sends `Content-Type: application/json` and a JSON-stringified body.
4. **JSON-LD extraction:** when the response `content-type` is `text/html` and the
   body contains a `<script type="application/ld+json">` with `@type: "Product"`,
   `bodyJson` is that parsed object. (This is the Best Buy path.)
5. **APIResponse shape:** the mock `response` must expose `status()`, `text()`,
   `headers()`, `url()` as **methods** (Playwright's real shape). The transport
   must call them, not read them as properties. Add a regression: a mock where
   `status` is a method — if the transport reads `response.status` as a property
   it gets a function, and the test fails.
6. `warm()` with `warmUp: false` does not call `context.newPage` or `page.goto`.
7. `warm()` with a `warmUrl` calls `page.goto(warmUrl, ...)` and, when
   `waitForChallenge: true`, polls until the challenge markers are gone (mock the
   page content to include `_Incapsula_Resource` first, then not).

Use a fake `context` object: `{ request: { fetch: async (url, opts) => fakeResponse }, pages: () => [fakePage], newPage: async () => fakePage }`.
`fakeResponse` = `{ status: () => 200, headers: () => ({ 'content-type': 'text/html' }), text: async () => html, url: () => url }`.
`fakePage` = `{ goto: async () => {}, content: async () => html }`.

Verify: `npm test` green. The new test file must fail if you break the
method-vs-property handling (run it against a deliberately-wrong transport to
confirm it's a real regression, not a tautology).

---

## PROMPT 2 — Wire the browser-http transport into the inventory scanner for WAF sites

The inventory scanner (`src/scalper/inventory-scanner.mjs`) currently uses a bare
`node fetch` transport (`createHttpTransport`). For WAF-gated sites (Pokémon
Center), the poll must go through the **warmed Playwright context** so it carries
the WAF trust cookies + matching fingerprint.

Add an optional `httpForSite` override seam (it already exists — the scanner
takes `httpForSite`). The wiring change: in `runInventoryScanCli`, when the site
is WAF-gated (add a `wafGated: true` flag to the site config, or detect
`config.waf` containing 'Incapsula'/'Imperva'), open a warmed browser transport
via `openWarmedBrowserTransport({ site, accountId, warmUrl: SITE_HOME_URLS[site] })`
and pass its `.transport` as the `httpForSite` for that site. Non-WAF sites keep
the bare fetch transport.

Requirements:
- The warmed context must be **closed** in a `finally` block (no leaked browser).
- The warm-up must happen **once** per site, not per product (the scanner's
  `scanAll` loops products; the transport is shared).
- Add a `wafGated` field to `src/scalper/sites/pokemon-center/config.mjs`
  (`wafGated: true`) and `false` (or absent) for the others. Do NOT change the
  measured `waf` string.
- Add a test: a mock `openWarmedBrowserTransport` is called exactly once for a
  WAF-gated site and its `.transport` is used for every product in `scanAll`.
  For a non-WAF site it is NOT called.

Verify: `npm test` green. Add a named regression: "WAF-gated site polls through
the warmed context, not bare fetch."

---

## PROMPT 3 — Make the canary gate's `measured-recipe` check accept a per-site recipe file

The canary gate (`src/scalper/canary-readiness.mjs`) checks `measured-recipe`
via `recipes.forSite(site)`. The recipe shape is defined by
`validateCheckoutRecipe` in `src/scalper/checkout-recipes.mjs`:
- `steps`: non-empty array; each step has `action` (`click`/`fill`/`select`/`check`/`waitForUrl`)
  and `selectors` (array of strings), except `waitForUrl` which needs `pattern`.
- Exactly one `commit: true` step, it must be a `click`, and it must be the LAST step.
- `confirmation.selectors`: non-empty array.
- Optional: `challenges` (array of `{ selectors }`), `navigation` (`retries` 0–3),
  `session` (`url` absolute HTTP(S), `signedInSelectors` array).

The operator will measure the real Best Buy selectors and drop them into
`config/scalper-browser-recipes.json` (currently all `null`). Your job:
1. Confirm `CheckoutRecipeProvider.forSite('bestbuy')` reads from
   `config/scalper-browser-recipes.json` (check the provider's source; if it reads
   a different path, wire it to this one).
2. Add a test that a **valid** Best Buy recipe (you can use placeholder selectors
   like `['button[data-testid="add-to-cart"]']` — the shape is what's tested, not
   the real selectors) passes `validateCheckoutRecipe` and is returned by
   `forSite('bestbuy')`.
3. Add a test that a recipe with **two** commit steps, or a commit step that is
   not last, or a missing `confirmation.selectors`, is rejected.

Do NOT invent real selectors — that's the operator's measurement. You are only
proving the loader + validator accept the shape the operator will fill in.

Verify: `npm test` green.

---

## PROMPT 4 — Account + dashboard-token canary checks: make them pass with real config

The canary gate checks:
- `dashboard-auth`: `Boolean(env.SCALPER_DASHBOARD_TOKEN)`.
- `account`: at least one account for the site where `email` does not start with
  `replace-me` and `password` is set.
- `session`: at least one configured account with a valid, non-expired session
  whose `profileDir` exists.

The operator will fill `config/scalper-accounts.json` (real email/password via
keychain refs) and set `SCALPER_DASHBOARD_TOKEN`. Your job:
1. Add a test that `accountConfigured` returns `true` for an account with a real
   email + password, and `false` for `replace-me@example.com`.
2. Add a test that the `session` check passes when a session file exists with a
   future `expiresAt` and an existing `profileDir`, and fails when `expiresAt` is
   in the past.
3. Confirm the `AccountManager.accountsFor('bestbuy')` reads
   `config/scalper-accounts.json` (check the source; wire it if it reads elsewhere).

Do NOT put real credentials in the test — use a fake account object. The operator
fills the real config.

Verify: `npm test` green.

---

## PROMPT 5 — Burn-in + latency: make the evidence path testable

The canary gate checks:
- `seven-day-burn-in`: `burn.passed` from `BurnInManager`.
- `measured-latency`: `evidence.latencySamples > 0` (from
  `burn.summary?.paperOrders?.latency?.samples`).

The 7-day timer is running (operator's lane to let it elapse). Your job:
1. Add a test that `BurnInManager` records a latency sample when a paper order
   completes, and that `summary.paperOrders.latency.samples` increments.
2. Add a test that `seven-day-burn-in` passes when `now` is past
   `startedAt + 7d` and the required sample count is met, and fails when `now` is
   before the deadline.
3. Confirm the burn-in manager writes evidence to a path the canary gate reads
   (check both sources; if they disagree on the path, wire them to the same one).

Do NOT fast-forward the real burn-in — that's the operator's call. You are only
proving the evidence path is wired so that when the 7 days elapse, the gate
flips.

Verify: `npm test` green.

---

## What I (the operator) am doing in parallel (do NOT touch)

- Measuring the real Best Buy checkout selectors (add-to-cart → checkout →
  place-order → confirmation) in a visible Chrome, then filling
  `config/scalper-browser-recipes.json`.
- Measuring Target + TCGplayer WAF/endpoint reality.
- Getting a residential IP for Pokémon Center (the Incapsula block).
- Filling `config/scalper-accounts.json` with real credentials + setting
  `SCALPER_DASHBOARD_TOKEN`.
- Letting the 7-day burn-in elapse.

**Handoff:** when you're done, run `npm test` (must be green) and
`npm run scalper:canary -- bestbuy` and report the blocker list. The blockers
that should remain are ONLY the operator-lane ones (real account, real session,
real recipe selectors, 7-day burn-in elapsed). Everything structural should pass.
