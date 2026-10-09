# Retailer measurement backlog

The common execution platform is implemented. These items intentionally remain
site-specific because they must be observed in the operator's own ordinary
checkout session. Do not guess selectors or request payloads and do not copy
them from a commercial client.

## Required artifact for every site

- One manually authenticated persistent Chrome profile.
- One current product page and a safely testable in-stock product.
- Stable semantic selectors for cart, checkout, purchase submission, session
  signed-in state, session signed-out state, and order confirmation.
- Human-verification selectors for CAPTCHA, OTP, queue, and 3-D Secure states.
- A revisitable order-details or confirmation page from an authorized test
  purchase, including an order-number selector.
- Detector evidence showing both an in-stock and an out-of-stock response.
- The retailer's current quantity and order limits.

## Best Buy

- Measure product/SKU availability and fulfillment response shapes.
- Record add-to-cart, cart, sign-in/session, checkout, place-order, and
  confirmation selectors.
- Record the ordinary queue/wait state and account-verification handoff.
- Confirm whether pickup-only inventory should be eligible for checkout.

## Pokémon Center

- Measure the product/PID availability response and guest-checkout path.
- Record queue admission, cart, address, payment, commit, and confirmation
  selectors.
- Record CAPTCHA detection selectors for human handoff.
- Confirm which product limits apply to the selected release.

## Target

- Measure a normal browser product page after the current public-search
  endpoint returned HTTP 435.
- Record TCIN availability, fulfillment choice, cart, checkout, commit, and
  confirmation selectors.
- Record challenge detection only. Challenge circumvention is not part of the
  shared adapter.

## TCGplayer

- Measure the buyer listing selection and cart path; catalog/market API access
  is not sufficient for buyer checkout.
- Record seller/listing choice, quantity, cart, checkout, commit, and
  confirmation selectors.
- Confirm whether an authenticated buyer session is mandatory for the chosen
  flow.

## Recipe completion criteria

The generated recipe is ready only when `npm run scalper:doctor` accepts it,
the session markers distinguish signed-in from signed-out, a paper run records
the intended order, and an inexpensive explicitly authorized purchase confirms
the order-number selector. A missing confirmation becomes `uncertain` and is
never automatically retried.

## Measured inventory contract

Add only observed first-party poll URLs to `config/scalper-product-endpoints.json`. Each row is imported into SQLite and has this shape:

```json
{
  "productId": "operator-watchlist-id",
  "site": "pokemon-center",
  "pollUrl": "https://www.pokemoncenter.com/TODO-measured",
  "measuredAt": 0,
  "metadata": {
    "contract": {
      "availableWhen": [
        { "path": "TODO.response.field", "equals": "TODO-observed-value" }
      ],
      "fields": {
        "quantity": "TODO.response.quantity",
        "priceCents": "TODO.response.priceCents",
        "sku": "TODO.response.sku",
        "seller": "TODO.response.seller",
        "fulfillment": "TODO.response.fulfillment"
      }
    }
  }
}
```

Paths are declarative JSON field paths, not executable selectors. `availableWhen` is mandatory and all conditions must match. Optional rich fields are persisted only when their paths were measured. Run `npm run scalper:inventory -- pokemon-center` to collect bounded, `0600` detection samples. Unknown response shapes fail closed.
