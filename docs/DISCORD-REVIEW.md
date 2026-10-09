# Discord Drop Server Review

Reviewed 2026-10-01 in Chrome (logged in as the operator) — guild
The locally configured "Pokemon Restocks & News" guild. 25 channels reviewed,
~640 messages, newest 2026-10-01 17:38Z. Message text below is verbatim from
the rendered client; the embed *JSON* shape is inferred from the rendering
(labels, link positions) and should be confirmed against one raw Gateway
`MESSAGE_CREATE` before the parser is finalised.

## The brief's IDs are swapped — fix the config first

| ID | What the brief says | What it actually is |
|---|---|---|
| `<private-monitor-category-id>` | primary channel | **⚡ Restock Monitors — a CATEGORY** (13 store channels) |
| `<private-news-channel-id>` | category | **🚨┃restocks-news — an announcement channel**, now mostly member chat |

Use the locally configured monitor category and official-updates channel. Do
**not** track
restocks-news.

## Channels

| Channel ID | Name | Posts drops? | Scraped | Notes |
|---|---|---|---|---|
| `<private-amazon-channel-id>` | 📦┃amazon | yes — bot | 50 (09-29→10-01) | busiest; Direct Link is `amzn.to` affiliate short link |
| `<private-target-channel-id>` | 🎯┃target | yes — bot | 70 (09-26→10-01) | Order Limit usually `2` |
| `<private-target-quantity-channel-id>` | 🎯┃target-10-plus-qt-restocks | yes — bot | 30 (09-25→10-01) | same posts as #target, filtered to 10+ qty; **best Target signal** |
| `<private-walmart-channel-id>` | 🌞┃walmart | yes — bot | 30 (09-28→10-01) | RESTOCK **and DRAW** variants |
| `<private-bestbuy-channel-id>` | 🔖┃best-buy | yes — bot | 10 (07-02→07-17) | dormant since July |
| `<private-macys-channel-id>` | ⭐┃macys | yes — bot | 30 (09-18→09-29) | |
| `<private-samsclub-channel-id>` | 💳┃sams-club | yes — bot | 10 (07-22→07-24) | dormant |
| `<private-costco-channel-id>` | 🏢┃costco | yes — bot | 22 (01-20→09-17) | rare |
| `<private-pokemon-center-channel-id>` | 🏥┃pokemon-center | yes — bot | 30 (02-05→09-30) | almost all **"Queue Detected"** |
| `<private-sporting-goods-channel-id>` | 🎣┃dsg-sporting-goods | yes — bot | 7 (08-18→09-08) | rare |
| `<private-ebay-channel-id>` | 🔰┃ebay | yes — bot | 4 | negligible |
| `<private-gamestop-channel-id>` | 🎮┃gamestop | yes — bot | 6 (06-30) | negligible |
| `<private-other-stores-channel-id>` | 🌐┃other-stores | yes — bot | 30 (07-31→09-16) | mixed retailers |
| `<private-official-channel-id>` | 📌┃official-updates | **yes — staff, human-written** | 30 (09-25→10-01) | scheduled drops, queue-live, direct PC links, stock status |
| `<private-community-channel-id>` | 🙌┃community-alerts | mirror | 30 | re-posts of monitor embeds prefixed `@Community Alerts` — duplicates |
| `<private-deals-channel-id>` | ⚡┃extra-pokemon-deals | weak | 30 | tweet relays from @PokemonDealsHub; rumours/preorders |
| `<private-global-channel-id>` | 🌍┃global-restocks | no | 4 | CA/UK tweet relays |
| `<private-news-channel-id>` | 🚨┃restocks-news | **no — noise** | 90 in ~25 h | 45 distinct human authors; "Is pokemon hacked", "Whats the queue look like" |
| `<private-talk-channel-id>` | 📦┃restock-talk | no | 30 | chat |
| `<private-store-finds-channel-id>` | 🛒┃store-finds | no | 30 | in-store finds, photos |
| `<private-success-channel-id>` | ✅┃success | indirect | 10 | checkout screenshots — a "drop is real" confirmation signal |
| `<private-faq-channel-id>` | ❓┃faq | reference | 7 | per-retailer drop guides (below) |
| `<private-roles-channel-id>` | 🔔┃notification-roles | reference | 4 | role buttons per store |
| chat, show-your-pulls, card-grading, pokemon-games, rules, … | — | no | — | community |

## Message patterns

All monitor posts come from the app **`Pokemon Restocks Monitor`** (bot). The
footer on every one is `Restocks Bot v2.0 | Pokemon Restocks Monitor #ad`.

### Pattern 1: RESTOCK (one template for every store) — 305 of 345 monitor posts
- **Example (content):** `🚨 RESTOCK - Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box @Amazon`
- **Example (embed, rendered top to bottom):**
  ```
  Item Restocked                                   ← embed author
  Pokémon TCG: Mega Evolution—Ascended Heroes Mega Meganium/Emboar/Feraligatr ex Box   ← title (links to Direct Link)
  Direct Link:   https://amzn.to/4rWYrTD
  Price          N/A
  Retailer       Sold by Amazon.com
  Status         In-Stock
  Order Limit    N/A
  Category       Click Me                          ← affiliate link to store category page
  Links          Cart | Login | eBay | Price History | Amazon | TCGPlayer Data
  Restocks Bot v2.0 | Pokemon Restocks Monitor #ad ← footer
  ```
  plus a product thumbnail from the retailer's CDN (`m.media-amazon.com`, `tcgplayer-cdn`, `i5.walmartimages.com`, `slimages.macysassets.com`, `pisces.bbystatic.com`).
- **Target example:** `🚨 RESTOCK - First Partner Illustration Collection Series 3 @Target` — Direct Link `https://buff.ly/7CJjR44`, Retailer `Target`, Order Limit `2`, thumbnail `tcgplayer-cdn.tcgplayer.com/product/695400_…` (the TCGplayer product id is in the image URL).
- **Target 10+ example:** `🚨 RESTOCK - First Partner Illustration Collection Series 3 @Target 10+ Quantity Restocks` — byte-identical embed, posted ~4 min *before* the #target copy (09:49:55Z vs 09:53:33Z).
- **Store:** explicit, twice — after `@` in content, and the `Retailer` field.
- **Product:** content between `RESTOCK - ` and ` @`; full name in embed title.
- **Time:** never — it's a "now" alert. Message timestamp = event time.
- **URL:** `Direct Link:` field. **Always a shortener**: `buff.ly` (241), `amzn.to` (61), `ebay.us` (1). Never a bare retailer URL.
- **Frequency:** Target ~14/day, Amazon ~20/day this week; others sporadic.

### Pattern 2: DRAW (Walmart drawings) — 17 posts
- **Example:** `🚨 DRAW - 30th Celebration Booster Bundle 2-Pack @Walmart`
- Embed identical to Pattern 1 except **`Status` is replaced by `Time`**: `Sep 30, 2:00pm PDT` (also seen `Sept 30, 2:00pm PDT`, `Sep 16, 2:00pm PT` — inconsistent month abbreviation and zone).
- Drawings are free entry, open ~1 hour (official-updates: "30th Celebration Drawings Live Soon (Open for 1 Hour)"). Not a speed race; a calendar item.

### Pattern 3: Pokémon Center queue — 28 posts
- **Example (content):** `🚨 Pokemon Center Queue Detected @Pokemon Center`
- **Embed:** author `Pokemon Center`, title `Pokemon Center Queue` → `https://pokemoncenter.com/`, `Direct Link` → `https://www.pokemoncenter.com/category/new-releases`, `Price N/A`, `Message: Queue is up!`. **No product.**
- These are the **highest-✅ posts in the server** (top: 295 ✅ / 134 ❌). The PC product links arrive afterwards in **official-updates**, written by staff.

### Pattern 4: official-updates (staff, free text) — the schedule source
- `Pokemon Center Queue is LIVE! Join the Queue! @Official Updates / JOIN QUEUE: https://pokemoncenter.com/ / We'll alert here as soon as any product drops are confirmed with direct links …`
- `@Official Updates Delta Reign Preorders LIVE at Pokemon Center! / ETB: https://www.pokemoncenter.com/product/10-10438-112 / Booster Box: https://www.pokemoncenter.com/product/10-10446-120 / Booster Bundle: https://www.pokemoncenter.com/product/10-10439-109 / Only use the direct links once you're through the queue!`
- `@Official Updates New 30th Celebration Walmart Drawings Confirmed for this Wednesday, September 30th at 2PM PT /5PM ET! … Drawings include 30th Celebration Booster Bundle 2-Pack, Mini Tin 10-Count Display and Knock Out Collection 4-Count Bundle.`
- `@Official Updates Looks like ETBs are out of stock as of now. Booster Bundles and Booster Boxes still seem to be in stock!`
- **These are the only messages with real `pokemoncenter.com/product/<sku>` URLs and with forward-dated drop times** — in prose (`Wednesday, September 30th at 2PM PT /5PM ET`).

### Pattern 5: mirrors and relays (dedupe or drop)
- **community-alerts:** `@Community Alerts  RESTOCK - First Partner Illustration Collection Series 3` + the same embed. Same product as Pattern 1, re-posted ~2 h later.
- **official-updates** also re-posts monitor embeds verbatim (e.g. a Target 30th Celebration ETB embed at 07:33Z).
- **extra-pokemon-deals / global-restocks:** tweet relays (`Tweeted`, embed `(@PokemonDealsHub)` / `(@PokemonDealsCA)`). Rumours ("just pinged on Pokemon Center as a possible upcoming invite-only drop"), preorders, non-TCG merch.

### Pattern 6: non-Pattern-1 one-offs in monitor channels
- `Gengar Pearlescent Pop! Vinyl Figure by Funko at Pokemon Center https://www.pokemoncenter.com/product/73-10117-101/…` from a *different* app, `Pokemon Center Drop Alerts` — no embed, bare URL in content.
- Older PC restock template (July): embed author `Pokemon Center`, fields `Price / Status / Type: In Stock / More: Click Me`, with the **real** `pokemoncenter.com/product/…` URL as the embed title link.
- `Status: New Listing` (6) — eBay/other-stores listings, not retail restocks.

## Consistent format?

**Yes, for the bot.** Every monitor post is
`🚨 <VERB> - <short product> @<Retailer>[ 10+ Quantity Restocks]` + one embed
with fixed field labels. Field value distribution across 345 bot posts:

| field | values |
|---|---|
| verb | `RESTOCK` 305 · `DRAW` 17 · PC queue 28 |
| Status | `In-Stock` 301 · `New Listing` 6 · `In Stock` 1 |
| Order Limit | `N/A` 185 · `2` 116 · `1` 1 |
| Price | `N/A` 318 · real prices only on a few (`$184.99` ×18, `$55.98`, `$160.99` …) |
| Retailer | Target 110 · Amazon (`Sold by Amazon.com`) 61 · Walmart 34 · Macy's 30 · Costco 22 · DSG 16 · Best Buy 10 · Sam's Club 10 · GameStop 6 · eBay 2 |
| Direct Link host | buff.ly 241 · amzn.to 61 · ebay.us 1 |

official-updates is free text and is **not** consistent.

## Noise

- `restocks-news` — 90 messages/day, 45 human authors, chat and moderator warnings (`PLEASE DO NOT SEND ANY MESSEGES HERE …`).
- `community-alerts` and embed re-posts in `official-updates` — **duplicates** of monitor posts; dedupe on `(retailer, product title)` within a window.
- Tweet relays in `extra-pokemon-deals` / `global-restocks`.
- `Status: New Listing` posts (eBay resellers).
- Non-TCG items in monitor channels: plush, Funko, `Tech Sticker Collection`, Owala bottles, Switch controllers.
- Repeats: the same Amazon item pings many times a day (Ascended Heroes Tin ×10+ on 09-30), mostly ❌-voted — Amazon "restocks" flap.

## Restockd server review — 2026-10-02

The supplied local identifier is a **guild ID**, not a channel ID. A
one-time visible-browser review of the already authenticated Discord session
identified the server as `Restockd | Pokemon Restocks` and sampled the recent
rendered history without extracting a user token or calling Discord's API.

| channel | ID | finding | recommendation |
|---|---|---|---|
| `pokemon-news` | `<private-secondary-news-id>` | scheduled Target/Walmart notices, five-minute warnings, PC queue + direct product links | ingest |
| `pokemon-center` | `<private-secondary-pc-id>` | dedicated queue detection with exact timestamp and direct PC URL | ingest |
| `pokemon-target` | `<private-secondary-target-id>` | retail prices, `Qty >= 10`, timestamps, Target product links | ingest |
| `pokemon-amazon` | `<private-secondary-amazon-id>` | frequent repeats, off-watchlist sets, prices up to `$239.95` | exclude by default |
| `dg-instore` | `<private-secondary-dg-id>` | local catalog; server itself warns inventory counts are unreliable | exclude |

The best observed Target sequence on 2026-10-02 was Booster Bundle `$31.99`
at 02:12 and 02:19, Mini Tin `$12.99` at 02:45, and Knock Out Collection
`$11.99` at 02:56, all reporting `Qty >= 10`. `pokemon-news` announced the
Target window the prior evening and published a PC queue with direct ETB,
Booster Bundle, and Booster Box links on 2026-09-30. Links use `howl.link`; its
long form embeds the final `target.com` URL in the `url` query parameter.

`parseRestockdMessage()` now supports these structured restock, queue, scheduled
notice, and PC-product patterns. `howl.link` is unwrapped or resolved before the
retailer-domain policy runs. Only the three recommended channel IDs are part of
the parser's default Restockd monitor set, and product restocks still have to
match the local watchlist.

This is parser readiness, not ongoing access. The source guild does not expose
a native Follow action in the reviewed text channels and this machine still has
no `SCALPER_DISCORD_BOT_TOKEN`. Live ingestion therefore requires a source
administrator to install an authorized bot, or manual/native forwarding into
the existing Homebase mirror. Never extract or automate a normal user-session
token.

## The most valuable signals, ranked

The ✅/❌ reactions are the community's "I scored / I didn't" vote (the FAQ
says to "check alert reactions to gauge whether others are scoring"). Across
315 reacted alerts: **4,170 ✅ vs 10,882 ❌ — ~28 % hit rate overall.**

1. **Pokémon Center queue + the official-updates follow-up with SKU links.** The highest ✅ counts in the server. The queue alert has no product; the staff post minutes later carries the `pokemoncenter.com/product/<sku>` URLs. FAQ: PC drops happen "most frequently between 8:30 AM-12:00 PM PT on weekdays", one queue session per internet connection.
2. **`target-10-plus-qt-restocks`.** Same data as #target, filtered to real quantity, and it posted *earlier* than #target on the one pair I could time (3 min 38 s). The FAQ says Target restocks in waves "as small as 1–10 items", so the plain #target channel is mostly unwinnable pings.
3. **Walmart: scheduled, not sniped.** FAQ: new TCG drops "Wednesdays at 6PM PT / 8PM CT / 9PM ET", per-item limit usually 5, queue opens up to 30 min before. Plus free DRAW entries (Pattern 2) with an explicit `Time` field. Both are calendar items.
4. **Costco / Sam's Club:** scheduled, membership required, announced in official-updates. Rare but high ✅ (Sam's Focused Fighters: 136 ✅ / 59 ❌).
5. **Amazon:** highest volume, lowest value. Constant flapping; ❌-dominant.
6. Best Buy, GameStop, eBay, DSG: dormant or negligible this quarter.

**Store coverage gap:** the current parser knows `pokemon-center, tcgplayer,
bestbuy, target`. This server's live volume is Target, Amazon, Walmart, Macy's
and Costco — and it has **no TCGplayer channel at all**.

## Parser recommendations

The current `parseDiscordDrop` **misfires on every Pattern 1 post for
Amazon/Walmart/Macy's/Costco**, mostly assigning the wrong store:
- `STORE_PATTERNS` matches `tcg\s*player` against the **Links row** (`TCGPlayer Data`), present in every embed. Any post whose store isn't in the list (Amazon, Walmart …) comes back as `tcgplayer`. The PC July template's Links row also lists `Macy's | Target | Best Buy | Walmart` → wrong store.
- `PRODUCT_KIND` misses `Booster Bundle`, `Mini Tin`, `Illustration Collection`, `Knock Out Collection`, `Booster Bundle 2-Pack`, `ex Box` → valid posts are dropped.
- PC queue posts have no product kind → dropped, though they're the best signal.
- `extractDropTime` reads `2:00pm` out of `Sep 30, 2:00pm PDT` in the *machine's* zone and ignores the date and the `PDT`.

Recommended: **parse the bot's structure first, prose second.**

```js
// 1. Route by author + shape, not by keyword soup
const isMonitor = message.author?.bot && /Pokemon Restocks Monitor/.test(message.author.username ?? '')
               || /Restocks Bot v\d/.test(embed?.footer?.text ?? '');

// 2. Headline (content) — verb, short name, retailer, 10+ flag
const HEADLINE = /^\W*(RESTOCK|DRAW)\s+-\s+(.+?)\s+@(Amazon|Target|Walmart|Best Buy|Macy's|Sam's Club|Costco|Pokemon Center|Dick's Sporting Goods|GameStop|eBay|Other Stores)(\s+10\+\s+Quantity Restocks)?\s*$/i;
const PC_QUEUE = /Pokemon Center Queue Detected/i;

// 3. Embed fields by NAME (labels are fixed; note the colon on "Direct Link:")
const field = (e, name) => e.fields?.find(f => f.name.replace(/:$/, '').trim() === name)?.value;
// field(e,'Direct Link') field(e,'Price') field(e,'Retailer') field(e,'Status')
// field(e,'Time') field(e,'Order Limit')  — ignore 'Links' and 'Category' (affiliate)
// product full name = embed.title ; product URL = embed.url (== Direct Link)

// 4. Retailer field → site key
const RETAILER = { 'Sold by Amazon.com': 'amazon', 'Target': 'target', 'Walmart': 'walmart',
  'Best Buy': 'bestbuy', "Macy's": 'macys', 'Costco': 'costco', "Sam's Club": 'samsclub',
  "Dick's Sporting Goods": 'dsg', 'GameStop': 'gamestop' };

// 5. DRAW time — explicit zone, tolerant month
const DRAW_TIME = /^(Sept?|[A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+(PDT|PST|PT)$/i; // PT → America/Los_Angeles

// 6. official-updates prose
const PC_SKU    = /https:\/\/www\.pokemoncenter\.com\/product\/([\w-]+)/g;          // 10-10438-112
const PC_LINE   = /^(ETB|Booster Box|Booster Bundle|[^:]{3,40}):\s*(https:\/\/www\.pokemoncenter\.com\/product\/\S+)/gm;
const SCHEDULED = /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(PT|ET)/i;
const QUEUE_LIVE = /Queue is LIVE/i;
const OOS        = /out of stock/i;   // staff stock-status updates → close the drop
```

Rules:
- **Skip** `Status: New Listing`, and skip by title for non-TCG (`Plush|Funko|Pop!|Sticker|Bottle|Controller|Figure`).
- **Dedupe** on `(site, normalised embed.title)` within ~10 min; community-alerts and official-updates embed re-posts are copies.
- **Prefer the 10+ channel** for Target; treat a #target post without a 10+ twin as low priority.
- **Resolve the shortener** (`buff.ly` → `mavely.app.link`/`7tiv.net` affiliate → retailer) with one HEAD/redirect follow and cache it per short code. Neither the shortener nor the `Click Me`/`Cart`/`Login` links is a retailer URL; Amazon's `amzn.to` resolves to `/dp/<ASIN>`. The redirect hop costs latency on every alert, so pre-resolve when you can.
- **Optional:** use the ✅/❌ reaction counts (`MESSAGE_REACTION_ADD`) a minute after the post as a "drop is real" signal.

## Embeds

One embed per monitor post. Inferred shape (confirm against a raw Gateway payload):

```json
{
  "author": { "name": "Item Restocked" },
  "title":  "Pokémon TCG: Mega Evolution—Ascended Heroes Tin",
  "url":    "https://amzn.to/4oSW3NP",
  "fields": [
    { "name": "Direct Link:", "value": "https://amzn.to/4oSW3NP", "inline": true },
    { "name": "Price",        "value": "N/A",                     "inline": true },
    { "name": "Retailer",     "value": "Sold by Amazon.com",      "inline": true },
    { "name": "Status",       "value": "In-Stock",                "inline": true },
    { "name": "Order Limit",  "value": "N/A",                     "inline": true },
    { "name": "Category",     "value": "[Click Me](https://amzn.to/…)", "inline": true },
    { "name": "Links",        "value": "[Cart](…) | [Login](…) | [eBay](…) | [Price History](…) | [Amazon](…) | [TCGPlayer Data](…)" }
  ],
  "thumbnail": { "url": "https://m.media-amazon.com/images/I/913JokfFaHL._AC_SL1500_.jpg" },
  "footer": { "text": "Restocks Bot v2.0 | Pokemon Restocks Monitor #ad" }
}
```

DRAW: `Status` → `Time` (`Sep 30, 2:00pm PDT`). PC queue: author `Pokemon Center`,
title `Pokemon Center Queue`, fields `Direct Link / Price / Message`. There are no
message components (buttons) on monitor posts; the "links" are markdown in the
`Links` field.

## Risks found while reviewing

- **Self-bot (rejected design).** The original proposal used a normal Discord
  user-session token, which is not supported. The implementation accepts only
  a bot token for an authorized application installed by a server
  administrator, or explicitly imported/permitted message exports.
- **Affiliate shorteners.** Every product URL goes through `buff.ly` → an
  affiliate redirector before reaching the retailer: one or two extra network
  round trips on the hot path.

## Built from this review (2026-10-01)

`src/scalper/monitor-parser.mjs` (+ `tests/scalper/monitor-parser.test.mjs`,
fixtures verbatim from the guild). Pure, no network. Wired on 2026-10-01:

- `DiscordFeed` tries `parseMonitorMessage(msg)` for channels under
  `MONITOR_CATEGORY_ID`, and `parseOfficialUpdate(msg)` for
  `CHANNELS.officialUpdates`, **before** the prose `parseDiscordDrop` fallback.
- Every signal passes through one `createSignalDeduper()`, then `rankSignal()`,
  and is sent to `AlertManager.dropDetected({ signal, rank })` — the operator's
  phone is the consumer.
- `signalToDrop()` writes calendar drops only for `SUPPORTED_SITES`; Amazon,
  Walmart, Macy's, Costco signals are alert-only.
- Local config supplies the reviewed `categoryIds` and `channelIds`; the
  shared example deliberately contains no real routing identifiers.

## Watchlist quality (2026-10-02)

The operator's 12 products are now `config/scalper-watchlist.json`, matched by
`src/scalper/watchlist.mjs` and applied in `createMonitorAwareParser({ watchlist })`
(wired by default in `createScalper`; `watchlist: false` turns it off). A
restock/draw for anything else is dropped with metric `off-watchlist`;
queue and official-update signals always pass.

Measured from 227 monitor pings, 2026-09-25 → 10-02 (Target, Target 10+,
Walmart, Amazon, Macy's, Costco, Sam's). ✅ = "I scored", ❌ = "I missed".
**hit** = ✅ ÷ all votes (how winnable); **demand** = votes per ping (how many
people chased it).

| product | MSRP | pings | ✅ / ❌ | hit | demand | verdict |
|---|---|---|---|---|---|---|
| Prismatic Evolutions Super-Premium | 129.99 | 10 | 76 / 504 | 13 % | 58 | **priority 3** — most-chased per ping on the list |
| 30th Celebration ETB | 69.99 | 23 | 79 / 986 | 7 % | 46 | **priority 3** — most pinged; hard to win at Target |
| 30th Booster Bundle | 31.99 | 16 | 75 / 573 | 12 % | 40 | **priority 3** |
| ↳ Walmart DRAW (2-pack) | — | 4 | 37 / 9 | 80 % | 12 | free entry — enter every one |
| Ascended Heroes ETB | 59.99 | 6 | 6 / 194 | 3 % | 33 | priority 2 — rarely winnable |
| Ascended Heroes Booster Bundle | 31.99 | 1 | 1 / 37 | — | 38 | priority 2 — too few pings to judge |
| Mega Evolution Booster Display | 179.99 | 0 | — | — | — | priority 2 — **no pings in 8 days**; not restocking at these stores |
| 30th Tin (Sylveon/Greninja) | 29.99 | 1 | 1 / 30 | — | 31 | priority 2 — too few to judge |
| 30th Poster Collection | 19.99 | 13 | 33 / 344 | 9 % | 29 | priority 1 (Macy's posts it too) |
| 30th Tech Sticker Collection | 19.99 | 19 | 25 / 224 | 10 % | 13 | priority 1 — pinged often, low interest |
| AH Tech Sticker (Charmander) | 19.99 | 2 | 2 / 65 | 3 % | 33 | priority 1 |
| 30th Mini Tin | 12.99 | 13 | 19 / 372 | 5 % | 30 | priority 1 |
| ↳ Walmart DRAW (10-ct display) | — | 3 | 16 / 4 | 80 % | 7 | free entry |
| 30th Knock Out Collection | 11.99 | 12 | 16 / 335 | 5 % | 29 | priority 1 |
| ↳ Walmart DRAW (4-ct bundle) | — | 4 | 17 / 13 | 57 % | 8 | free entry |

**Off-list products the Discord says are worth a look** (not added — operator's call):

| product | pings | ✅ / ❌ | hit | demand | note |
|---|---|---|---|---|---|
| First Partner Illustration Collection Series 3 | 8 | 164 / 69 | **70 %** | 29 | the most *winnable* thing at Target this week |
| Ascended Heroes Focused Fighters Premium (Sam's, $55.98) | 7 | 275 / 1314 | 17 % | **227** | highest demand in the server; membership drop |
| Mega Charizard UPC 2-pack (Costco, $184.99) | 7 | 63 / 1124 | 5 % | 170 | huge demand, rarely won |
| Perfect Order Booster Bundle (Walmart) | 10 | 24 / 133 | 15 % | 16 | |

**Caveats.** ✅/❌ measures whether *people* checked out, not resale value;
profitability needs the market prices (`config/scalper-market.json` /
`market-score.mjs`). That file has the 30th Booster Bundle at $26.94; the
Target listing is $31.99. The pings and votes come from one week; refresh
the `observed` blocks before re-tiering.
