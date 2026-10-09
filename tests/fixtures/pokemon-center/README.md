# Pokémon Center recorded contracts

This directory intentionally contains no fabricated retailer payloads. Capture and redact these five real first-party responses during the operator measurement session:

- `in-stock.json`
- `out-of-stock.json`
- `cart.json`
- `checkout.json`
- `confirmation.json`

Preserve field names and value types needed by the adapter while removing cookies, authorization headers, payment data, and real personal data. Replace the cart address and confirmation order ID with stable synthetic tokens rather than deleting their fields. Add `capture-metadata.json` with capture time, endpoint role, HTTP status, response-schema version, and an `expectedCart` object using the same synthetic address values. The canary gate remains blocked until all files exist and pass the recorded-contract loader.
