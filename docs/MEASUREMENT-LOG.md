# Retailer Measurement Log

Live measurements from the operator's visible-Chrome sessions. Each entry is a
**measurement, not a guess** — it records what the retailer actually returned,
so a fresh session does not re-derive it. Update the matching `config.mjs`
`waf` / `endpoints` fields when a measurement changes.

## Pokémon Center — 2026-10-03

- **Selected paper catalog target:** `10-10438-112`, Pokémon TCG: Mega
  Evolution—Delta Reign Pokémon Center Elite Trainer Box. The direct
  first-party URL came from the supplied monitor evidence and Pokémon Center's
  current preorder schedule independently confirms the product name. It is a
  catalog-only, non-actionable row until the availability contract is measured.
- **WAF: Imperva Incapsula** (the config previously guessed Cloudflare).
- Fresh profile → product page returns **HTTP 403** with a
  `/_Incapsula_Resource?CWUDNSAI=...` challenge iframe and a
  `/vice-come-...` beacon (JSON: `token`, `renewInSec`, `cookieDomain`).
- The challenge JS auto-runs and sets `visid_incap_*`, `incap_ses_*`,
  `nlbi_*` cookies, **but the product page still 403s on the next request.**
  The trusted session is necessary but not sufficient — the product endpoint
  needs the full Incapsula handshake state (or a different request shape).
- Home page loads (200) and fires only the Incapsula beacon + tracking; no
  product API is visible from the home page.
- **DEEP MEASUREMENT 2026-10-03** (warm-up + context request):
  - Warming on the home page sets `visid_incap` + `incap_ses` + `nlbi` cookies.
  - Warming on the product page itself also sets the cookies, but the product
    page **still 403s** on the next request (both `page.goto` and
    `context.request.fetch`).
  - The challenge iframe (`_Incapsula_Resource`) is present on the product page
    but **never resolves** (30s, no change, empty body). The JS challenge is
    not completing.
  - **Conclusion:** the Incapsula trust is necessary but not sufficient for the
    product endpoint. The block is likely **IP reputation** (datacenter IP) or
    a second-stage JS verification that's being blocked.
  - **Next lever:** residential IP in the same region as the fingerprint, or a
    more complete challenge resolution (the iframe JS needs to run to completion).
  - **Authenticated-profile retest 2026-10-04:** a manually logged-in,
    persistent Pokémon Center Chrome profile was saved successfully, then used
    to warm and request product `10-10438-112`. The request still returned the
    same HTTP 403 Incapsula challenge with no Product JSON-LD. Account login is
    therefore not the missing inventory signal and the adapter remains
    fail-closed.
  - **Working transport:** `src/scalper/transports/browser-http.mjs`
    (`openWarmedBrowserTransport`) — warms the context, then polls via
    `context.request` (carries the Incapsula cookies + matching fingerprint).
    Verified working against Best Buy (light WAF, JSON-LD extraction).

## Best Buy — 2026-10-03

- **WAF: light** — no challenge on a fresh profile. Home + product model API
  return 200.
- **Product availability API (confirmed 200):**
  `GET /api/tcfb/model.json?paths=[["shop","scds","v2","product",<sku>]]&method=get`
  Unknown skus return an empty atom (`{"$type":"atom","$expires":-5000}`); a
  real in-stock TCG SKU is needed to capture the full schema
  (`purchasable` / `buttonState` / `price`).
- **Cart API (confirmed 200):** `GET /pcn-api/basket?context=header&vt=...`
- **Discovery gap:** search + category pages 404 for this profile (geo/A-B), so
  discovery must use the model API with a known in-stock SKU, not the HTML
  search page.
- **CONTRACT MEASURED 2026-10-03** (SKU 12861077, Pokémon TCG Mega Evolution
  Pitch Black Elite Trainer Box, $79.99, InStock):
  - Availability is in the **JSON-LD Product object** embedded in the product
    page HTML (`script[type="application/ld+json"]`), NOT the `model.json` API
    (which returns an empty atom).
  - `offers[0].availability` = `"https://schema.org/InStock"` (the
    `availableWhen` field).
  - `offers[0].price` = `79.99` (dollars, not cents — adapter must ×100).
  - `offers[0].sku` = `"12861077"`.
  - `offers[0].seller.name` = `"Best Buy"`.
  - `offers[0].availableDeliveryMethod` = `["SHIPPING"]`.
  - Fixture: `tests/fixtures/bestbuy/in-stock.json`.
  - Contract row: `config/scalper-product-endpoints.json`.
- **Discovery:** the search results page fires
  `suggest/v1/fragment/products/www?skuids=<comma-list>` which returns the
  product list (pdpUrl, skuid, altText). Use this to find in-stock TCG SKUs.
- **Open seam:** add-to-cart / checkout / confirmation calls (need a logged-in
  session to capture the cart + payment flow).

### Supplied first-party products — 2026-10-04

- Four supplied product pages were measured against the same JSON-LD contract:
  - SKU `6639109`, Mega Evolution Booster Box: `$160.99`, `InStock`.
  - SKU `6621081`, Prismatic Evolutions Super-Premium Collection: `$89.99`,
    `InStock`.
  - SKU `6606082`, Prismatic Evolutions Elite Trainer Box: `$49.99`, `InStock`.
  - SKU `6645341`, Phantasmal Flames Booster Box: `$160.99`, `InStock`.
- Every offer reported `seller.name = "Best Buy"`; all four exact pages are now
  persistent measured inventory sources with retailer-specific price caps.
- Search results returned different third-party marketplace SKUs at inflated
  prices for the base Mega Evolution and Phantasmal Flames queries. Those
  search sources are disabled; the exact supplied first-party pages are the
  authoritative source.
- Batch scanning exposed and fixed a local token-bucket integration gap: a
  multi-product scan now waits for the configured one-request-per-second
  budget instead of discarding all endpoints after the first.

## Target — 2026-10-04 partial measurement

- Repeated public search polling previously returned HTTP 435, so Target search
  sources remain disabled and fail closed.
- A single ordinary GET to official TCIN `1010892069` returned HTTP 200 with a
  complete `__NEXT_DATA__` product document (identity, description, barcode,
  purchase limit, and static fulfillment metadata).
- The server document explicitly had server-side price rendering disabled and
  did **not** contain a measured price or availability field. Live inventory is
  fetched client-side, so the product HTML alone is not a safe stock contract.
- **Open seam:** capture the authorized client-side price/availability request
  and its in-stock/out-of-stock response shapes. Until then, the six supplied
  official Target URLs remain catalog-only and non-actionable.

## TCGplayer — not yet measured

- Config guesses a JSON API. No live capture yet.
