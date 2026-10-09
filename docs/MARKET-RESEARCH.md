# Resale market research and tracker

## Data-source findings

- [TCGplayer Pricing API](https://docs.tcgplayer.com/reference/pricing) exposes
  market, low, mid, high, and buylist price data. The tracker uses the official
  single-SKU market-price endpoint. TCGplayer's
  [getting-started documentation](https://docs.tcgplayer.com/docs/getting-started)
  says new API access is no longer granted, so this provider is enabled only
  when existing public/private credentials are configured.
- [eBay Browse API](https://developer.ebay.com/develop/api/buy) exposes active
  listings using an application access token. Active listing prices are asks,
  not sales. eBay documents that
  [Marketplace Insights is restricted and not open to new users](https://developer.ebay.com/api-docs/buy/ref-marketplace-supported.html),
  so the tracker gives Browse observations low confidence and labels them
  `active-listing`.
- The official
  [30th Celebration product showcase](https://www.pokemon.com/us/news/pokemon-tcg-30th-celebration-product-showcase)
  provides the initial candidate names and release dates in
  `config/scalper-market.json`. Corroborated published US retail prices are
  included as starting acquisition costs and must be verified at checkout.
  Conflicting prices (currently the Ditto collection) remain `null`. Product
  identifiers and market observations are never guessed.

## Ranking model

The tracker stores append-only observations in the ignored
`data/scalper/market-observations.jsonl` file. Each product is scored using:

- acquisition cost including configured sales tax;
- expected resale proceeds after percentage fee, fixed fee, and outbound
  shipping;
- estimated dollar profit and ROI;
- evidence confidence and sample size;
- historical price direction.

Verified completed sales receive higher default confidence than TCGplayer
market prices. Active eBay listings alone fail the default confidence gate.
Products missing acquisition cost or price evidence receive a zero score; the
tracker never invents a resale value.

The result is decision support, not a profit guarantee. It does not account
for every return, fraud, storage, cancellation, income-tax, or marketplace
policy cost unless those costs are included in the configured thresholds.

## Commands

Edit `config/scalper-market.json` to add verified acquisition prices,
TCGplayer SKU ids, and precise eBay queries. Then:

```bash
npm run scalper:market -- capture
npm run scalper:market -- rank
npm run scalper:market -- report
```

`capture` appends current provider observations. `rank` is offline and reads
the saved history. `report` captures and then ranks.

Import authorized completed-sale exports as JSON or JSONL:

```bash
npm run scalper:market -- import /private/path/sold-comps.jsonl
```

Each record uses epoch milliseconds:

```json
{"productId":"30th-upc-day-night","source":"manual-ebay-export","kind":"completed-sale","price":189.99,"at":1790899200000,"confidence":0.95,"sampleSize":1}
```

Do not include buyer names, addresses, order ids, auth headers, or other
personal data in imported records.

`ops/market-tracker.launchd.plist` runs `capture` every six hours. It is useful
only after at least one provider credential and product source id/query are
configured.
