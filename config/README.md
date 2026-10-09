# Configuration

Configuration falls into three classes:

| Class | Files | Git policy |
|---|---|---|
| Safe shared policy | watchlist, market, discovery, product endpoints, drops, browser recipe skeleton | committed |
| Local identity/routing | `scalper-accounts.json`, `scalper-discord.json`, `*.local.json` | ignored |
| Secrets | `.env`, macOS Keychain values, browser state under `data/` | ignored |

Bootstrap the account file with:

```bash
cp config/scalper-accounts.example.json config/scalper-accounts.json
cp config/scalper-discord.example.json config/scalper-discord.json
```

Keep passwords and card values out of JSON. Use `keychain:NAME` references and
set them interactively with `npm run scalper:secret -- set NAME`. The optional
`SCALPER_ACCOUNTS_PATH` environment variable selects another local account
file.

The Discord example contains placeholder routing only. Keep real guild,
category, channel, author, and application IDs in the ignored local copy.

`scalper-product-endpoints.json` contains only operator-measured, first-party
read contracts. `scalper-browser-recipes.json` remains null for a retailer
until its ordinary authorized checkout flow has been measured. A missing or
invalid contract fails closed.
