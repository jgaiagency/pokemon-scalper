# Phase 3 compliant-build handoff

The measurement-independent build is complete. Live purchase paths remain
fail-closed. Direct first-party inventory is the primary truth source;
Discord is a discovery/early-warning source whose messages must resolve to a
measured product endpoint before execution.

## TODO(measure) seams

All URLs, selectors, request payloads, response mappings, challenge states,
and latency values below must come from an ordinary operator-authorized
session. Do not copy a commercial client's private contract and do not add a
challenge bypass.

### Pokémon Center

| Location | Operator-supplied shape |
|---|---|
| `src/scalper/sites/pokemon-center/config.mjs:7` | `checkAvailability`: first-party request descriptor and a mapper to `{ available, quantity, priceCents, sku, seller }`. |
| `src/scalper/sites/pokemon-center/config.mjs:9` | `addToCart`: first-party request descriptor/body mapping from `{ product, account, session }`, returning `{ cartId, items }`. |
| `src/scalper/sites/pokemon-center/config.mjs:11` | `getCart`: request mapping for `{ cartId, account, session }`, returning `{ items, totalCents, shippingCents, taxCents, address, fulfillment }`. |
| `src/scalper/sites/pokemon-center/config.mjs:13` | `submitOrder`: final first-party request mapping returning `{ orderId, status }`; never retry after an ambiguous commit. |
| `src/scalper/sites/pokemon-center/config.mjs:15` | `getOrder`: order-history request mapping returning `{ orderId, status, items, totalCents }` for uncertain-order reconciliation. |
| `src/scalper/sites/pokemon-center/config.mjs:19` | Stable measured selectors for add-to-cart, checkout, the irreversible order click, human verification states, and confirmation. Put the executable sequence in `config/scalper-browser-recipes.json`. |
| `src/scalper/sites/pokemon-center/config.mjs:23` | Observed WAF classification and measured stock-to-confirmation latency. Record challenge detection/human handoff only. |
| `src/scalper/sites/pokemon-center/api.mjs:18` | Convert each measured operation into the HTTP transport shape `{ method, url, headers?, body? }`, then normalize the response to the interface above. Keep credentials/cookies in the injected session, not source. |

The existing `isAvailable()` parser must be confirmed or corrected against
the recorded in-stock/out-of-stock payloads; the contract test is deliberately
skipped until those real fixtures exist.

### Best Buy

| Location | Operator-supplied shape |
|---|---|
| `src/scalper/sites/bestbuy/config.mjs:7` | Measured first-party product JSON URL and mapping for purchasability/button state. |
| `src/scalper/sites/bestbuy/config.mjs:9` | Measured add-to-cart URL plus SKU request/response mapping. |
| `src/scalper/sites/bestbuy/config.mjs:11` | Measured checkout/payment/order requests and confirmation mapping. |
| `src/scalper/sites/bestbuy/config.mjs:15` | Visible-Chrome add-to-cart, checkout, verification, irreversible commit, and confirmation selectors. |
| `src/scalper/sites/bestbuy/config.mjs:19` | Observed Akamai challenge state and stock-to-confirmation latency; preserve the existing profile/cookies. |

### Target

| Location | Operator-supplied shape |
|---|---|
| `src/scalper/sites/target/config.mjs:7` | Measured product JSON URL and mapping for available-to-promise plus fulfillment/shipping. |
| `src/scalper/sites/target/config.mjs:9` | Measured add-to-cart URL plus TCIN request/response mapping. |
| `src/scalper/sites/target/config.mjs:11` | Measured checkout/payment/order requests and confirmation mapping. |
| `src/scalper/sites/target/config.mjs:15` | Visible-Chrome add-to-cart, checkout, verification, irreversible commit, and confirmation selectors. |
| `src/scalper/sites/target/config.mjs:19` | Observed DataDome challenge state and stock-to-confirmation latency; preserve the existing profile/cookies. |
| `src/scalper/sites/target/datadome.mjs:10` | A handler for the observed human challenge flow only, conforming to `browser.handleChallenge(context)`; no circumvention. |

### TCGplayer

| Location | Operator-supplied shape |
|---|---|
| `src/scalper/sites/tcgplayer/config.mjs:10` | Measured buyer add-to-cart URL and listing/SKU payload mapping. |
| `src/scalper/sites/tcgplayer/config.mjs:12` | Measured browser checkout sequence and confirmation response shape. |
| `src/scalper/sites/tcgplayer/config.mjs:16` | Stable listing, cart, checkout, irreversible commit, and confirmation selectors. |
| `src/scalper/sites/tcgplayer/config.mjs:20` | Confirmed API rate limits and stock-to-confirmation latency. |
| `src/scalper/sites/tcgplayer/api.mjs:13` | Confirm authentication headers and catalog response mapping with the operator's authorized API key. |
| `src/scalper/sites/tcgplayer/api.mjs:17` | Confirm store-inventory fields and whether they represent buyer-visible availability. |

### Direct rich-inventory contract

Extend `config/scalper-product-endpoints.json` only with observed contracts.
The checked-in rows cover the measured first-party Best Buy product pages;
Pokémon Center, Target, and TCGplayer still require measurements. Each row has
this declarative shape:

```json
{
  "productId": "exact-local-drop-id",
  "site": "pokemon-center",
  "pollUrl": "https://www.pokemoncenter.com/<measured-first-party-path>",
  "measuredAt": 1790899200000,
  "metadata": {
    "contract": {
      "availableWhen": [{ "path": "observed.path", "equals": "observed-value" }],
      "fields": {
        "quantity": "observed.quantity.path",
        "priceCents": "observed.price.path",
        "sku": "observed.sku.path",
        "seller": "observed.seller.path",
        "fulfillment": "observed.fulfillment.path"
      }
    }
  }
}
```

`availableWhen` is mandatory and supports `equals`, `oneOf`, or `positive`.
Unknown fields/statuses fail closed. The scanner records availability,
quantity, price, SKU, seller, fulfillment, HTTP status, latency, body hash,
measurement timestamp, and confidence in bounded `0600` sample files.

## Mocks and fixtures to replace at the real boundary

- `src/scalper/sites/pokemon-center/api.mjs:32` — retain
  `createMockPokemonCenterApi()` for tests, but complete and wire the real
  `createPokemonCenterApi()` mappings described above.
- `src/scalper/transports/browser.mjs:17` — retain
  `createMockBrowserAdapter()` for tests/smoke/simulation. Production already
  uses `createPlaywrightBrowserAdapter()` and will refuse to run without a
  validated measured recipe.
- `tests/fixtures/pokemon-center/` — add redacted real `in-stock.json`,
  `out-of-stock.json`, `cart.json`, `checkout.json`, `confirmation.json`, and
  `capture-metadata.json`. Do not add fabricated payloads.
- `config/scalper-browser-recipes.json` — replace each `null` with its measured
  site recipe. No fallback selector or challenge selector is generated.
- `config/scalper-discord.json` — keep `authorIds` limited to IDs observed
  through an authorized bot installation. The token remains local in
  `SCALPER_DISCORD_BOT_TOKEN` and must never enter this file.

## Current canary status

Snapshot taken 2026-10-09. Both checks were inspection-only and returned
`ready: false`; no live canary or purchase was started.

Best Buy currently passes paper staging, kill switch, spend/quantity limits,
dashboard authentication, real product catalog, measured poll endpoints,
clean order state, detection samples, alert delivery, duplicate-order checks,
and latency evidence. It is blocked by:

- an unconfigured Best Buy account and no reusable Best Buy session;
- no measured checkout recipe;
- the still-running seven-day burn-in; and
- missing successful restart-reconciliation evidence.

Pokémon Center currently passes paper staging, kill switch, spend/quantity
limits, dashboard authentication, the local account/session checks, real
product catalog, clean order state, alert delivery, duplicate-order checks,
and latency evidence. It is blocked by:

- no measured checkout recipe or poll endpoint;
- no real Pokémon Center detection sample;
- the still-running seven-day burn-in;
- missing successful restart-reconciliation evidence; and
- the six missing recorded contracts: in-stock, out-of-stock, cart, checkout,
  confirmation, and capture metadata.

Live startup now re-runs this full gate for the selected retailer and refuses
with `SCALPER_CANARY_NOT_READY` if any evidence is missing.

## Judgment calls to review

- Built-in `node:sqlite` is used instead of a native dependency. The package
  accepts Node 22.5+ and CI is pinned to Node 26.8.2.
- `discord.js` is the only new dependency. It owns Gateway protocol state,
  heartbeat/resume, while the adapter adds bounded caching and REST backfill.
- The reviewed monitor source is bot-authored, while the brief also says to
  drop bot-flagged messages. The implementation resolves that contradiction by
  accepting an explicitly allowlisted bot author and dropping every other
  author. Review this policy before filling `authorIds`.
- The single-instance guard is an atomic PID lock with stale-process recovery,
  chosen for macOS portability instead of shelling out to OS `flock`.
- Direct measured inventory is authoritative. Discord never supplies purchase
  quantity and cannot execute a drop without a canonical measured poll URL.
- The live canary command is scoped to one exact `--drop-id`; it will not fall
  back to the earliest drop if that ID is absent.

## One supervised one-unit canary

Do not run these until every readiness blocker above is cleared. First stage
and review with the kill switch active:

```bash
cd /path/to/pokemon-scalper
export SCALPER_LIVE=0
export SCALPER_KILL_SWITCH=1
export SCALPER_MAX_QUANTITY=1
: "${SCALPER_MAX_ORDER_USD:?set the one-order dollar ceiling}"
: "${SCALPER_MAX_DAILY_SPEND_USD:?set the daily dollar ceiling}"
: "${SCALPER_DASHBOARD_TOKEN:?set a private local dashboard token}"
npm run scalper:doctor
npm run scalper:inventory -- pokemon-center
npm run scalper:canary -- pokemon-center
```

Only after `scalper:canary` exits zero with `ready: true`, inspect the exact
drop and run one supervised command in a visible terminal/browser:

```bash
SCALPER_LIVE=1 SCALPER_KILL_SWITCH=0 SCALPER_MAX_QUANTITY=1 \
  npm run scalper:pc -- --drop-id '<exact-local-drop-id>'
```

Immediately restage the switch and inspect durable results. Do not release or
reconcile an uncertain reservation until the retailer's order history has
been checked manually:

```bash
export SCALPER_KILL_SWITCH=1
export SCALPER_LIVE=0
npm run scalper:tasks -- list
npm run scalper:ledger -- list
```

No live canary was started during this build.
