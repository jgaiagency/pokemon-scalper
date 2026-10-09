# Autonomous paper operations

This document is the implementation ledger for the eight-part continuation
plan. It describes evidence and boundaries, not a claim that the elapsed
seven-day gate has already passed.

| Item | Implementation | Persistent evidence |
| --- | --- | --- |
| 1. Discovery to orchestrator | New actionable retailer transitions become validated surprise drops and traverse safety, orchestration, durable task state, and paper checkout. Stable keys suppress repeated-poll duplicates. | `discovery-drops.json`, `purchase-tasks.json`, `paper-orders.jsonl`, `operations-events.jsonl` |
| 2. Best Buy repair | Structured zero-match searches can be accepted explicitly; malformed/challenge pages still fail closed. First-party, online, price, and watchlist gates are unchanged. | `discovery-state.json`, discovery-cycle events |
| 3. Daily reporting | Reports aggregate heartbeat uptime, source coverage/failures, imported signals, alerts, executions, tasks, duplicates, orders, and latency percentiles. | `reports/YYYY-MM-DD.json`, `reports/latest.json` |
| 4. Rotation and failure alerts | Logs rotate by size with bounded archives. Degraded and recovered operations alerts use a six-hour duplicate cooldown. | rotated `.1`–`.5` files, `failure-alert-state.json` |
| 5. Real read-only URLs | Every successful discovery cycle exports observed real retailer product URLs and policy state. | `product-catalog.json` |
| 6. Permitted signals | The service tails a local JSONL inbox and the CLI imports JSON/JSONL. No Discord user-token automation is used. | `inbox/discord.jsonl`, `inbox/cursor.json`, `discord-drops.jsonl` |
| 7. Seven-day burn-in | A persisted gate evaluates the complete elapsed window against coverage, reliability, alerts, duplicates, uncertainty, real input, and paper-order evidence. | `burn-in.json`, operations reports |
| 8. Canary gate | An inspection-only check requires a passed burn-in, one-unit safety setting, configured account/session, measured recipe, real product catalog, and no unresolved order. | command output; no purchase side effect |

## Always-on processes

- `com.local.pokemon-scalper`: orchestration, dashboard, heartbeat, and local
  signal inbox.
- `com.local.pokemon-scalper-discovery`: persistent 15-second read-only
  retailer checks, adaptive error backoff, and paper execution on a new
  eligible transition.
- `com.local.pokemon-scalper-operations`: hourly reporting, rotation, and
  health alerting.

All three read `.env`. During burn-in the required state is
`SCALPER_LIVE=0` and `SCALPER_KILL_SWITCH=1`.

## Interpretation

No inventory is a valid observation, not a failure. A challenge page, unknown
response shape, transport error, or policy ambiguity is a source failure and
cannot create an actionable transition. A paper order proves the internal
execution path; it does not prove retailer selectors or a live checkout. Those
remain gated by ordinary DevTools measurement, a manually authenticated
account, and a reviewed one-unit canary.
