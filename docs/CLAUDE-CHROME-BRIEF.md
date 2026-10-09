# Claude Chrome Brief — Discord Drop Server Review

## What you're doing

You have access to Claude Chrome (a browser automation tool). Use it to log
into the operator's Discord server and review the drop announcement channel.
Report back with the findings so the parser can be refined.

## The Discord server

- **Guild ID:** `<private-guild-id>`
- **Category ID:** `<private-category-id>` (all channels under this category are
  drop channels)
- **Primary channel ID:** `<private-primary-channel-id>`

## What to do

1. **Open Discord** in the browser (discord.com or the desktop app).
2. **Navigate to the locally configured guild** `<private-guild-id>`.
3. **Find the category** `<private-category-id>` and list all channels under it.
4. **Open the primary channel** `<private-primary-channel-id>`.
5. **Scroll up** to find the last 10-20 drop announcement messages.
6. **For each message, record:**
   - The exact text content (verbatim).
   - Whether it has an embed (and if so, the embed's title, description, URL).
   - The timestamp.
   - The store mentioned (pokemon-center, tcgplayer, bestbuy, target).
   - The product mentioned (booster box, ETB, tin, etc.).
   - The drop time (if mentioned).
   - The product URL (if present).
   - The quantity (if mentioned).
   - Any links or buttons.
7. **Also check:**
   - Are there other channels under the category that post drops?
   - Do the messages use a consistent format?
   - Are there embeds with structured data (product name, price, URL)?
   - Do the messages mention the store explicitly, or is it implied?
   - Is the drop time always included, or is it sometimes "now" / "ASAP"?
   - Are there any messages that are NOT drop announcements (noise)?

## Report format

Write your findings to `docs/DISCORD-REVIEW.md` in this repo. Use this format:

```markdown
# Discord Drop Server Review

## Channels

| Channel ID | Name | Posts drops? | Notes |
|---|---|---|---|
| `<private-primary-channel-id>` | #drops | yes | primary channel |
| ... | ... | ... | ... |

## Message patterns

### Pattern 1: <description>
- **Example:** "<verbatim message text>"
- **Store:** <store>
- **Product:** <product>
- **Time:** <time or "not mentioned">
- **URL:** <url or "none">
- **Embed:** <yes/no, and what's in it>
- **Frequency:** <how often this pattern appears>

### Pattern 2: <description>
...

## Consistent format?

<yes/no, and what the consistent parts are>

## Noise

<what messages are NOT drop announcements>

## Parser recommendations

<specific regex patterns or parsing rules that would match the real messages>

## Embeds

<if the messages use embeds, describe the embed structure>
```

## What the operator needs from you

1. **3-5 verbatim examples** of drop announcement messages (the exact text).
2. **The embed structure** (if messages use embeds).
3. **The consistent format** (if there is one).
4. **The noise** (what messages are NOT drops).
5. **Parser recommendations** (specific regex patterns).

This report will be used to refine the `parseDropMessage` function in
`src/scalper/discord-feed.mjs` and the new `src/scalper/discord-parser.mjs`.
