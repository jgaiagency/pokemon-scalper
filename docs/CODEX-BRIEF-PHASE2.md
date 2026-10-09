# Codex Brief — Phase 2: Transport Layer + Discord Review

> Historical build brief. The hand-rolled Gateway design below was superseded
> by the current `discord.js` adapter and authorized bot-token policy. Do not
> implement or use a Discord user-session token; follow
> `docs/ARCHITECTURE.md` and `SECURITY.md`.

## Context

Phase 1 is complete. 56 tests pass. All core modules (clock, calendar, accounts,
dry-run, scraper, discord-feed, orchestrator, health, alerts, env) and all four
site lane skeletons (pokemon-center, tcgplayer, bestbuy, target) are built with
clean injectable seams.

**What's missing:** the actual transport implementations. Every module has an
interface and a mock, but no real transport. This phase builds the real
transports so the system can actually run.

## Hard constraints (same as Phase 1)

- **Node 22+, ESM (`.mjs`).**
- **Zero external dependencies** for the transport layer. Use `node:` builtins
  only (`node:dgram` for NTP, `node:net` + `node:crypto` for Discord WS,
  `node:fetch` / `node:http` for HTTP).
- **Playwright is the ONLY allowed external dep**, and only for the
  browser-checkout adapters. The transport layer must not import it.
- **One test file per module.** No network in tests (mock the socket/UDP layer).
- **A test that reaches production data is not a flaky test — it is data
  loss.** Anything that writes under `data/scalper/` takes an injectable seam.
- **A passing proof is not evidence until you have seen it fail.**
- **A false-positive sibling per gate.**
- **`SCALPER_LIVE=1` arms real purchases.** Anything else is a dry run.

## What to build (in order)

### 1. NTP UDP transport

**File:** `src/scalper/transports/ntp.mjs`

The clock module (`src/scalper/clock.mjs`) expects a transport with:
```js
{ query(source) → Promise<{ offsetMs, roundTripMs }> }
```

Build the real NTP client using `node:dgram`:

- Send an NTPv4 request (20-byte packet, LI=0, VN=4, Mode=3) to the source
  on UDP port 123.
- Receive the response (48 bytes).
- Compute `offsetMs` and `roundTripMs` using the standard NTP offset formula:
  ```
  t0 = client send time (hrtime)
  t1 = server origin timestamp (from response)
  t2 = server receive timestamp (from response)
  t3 = client receive time (hrtime)
  offset = ((t1 - t0) + (t2 - t3)) / 2
  delay  = (t3 - t0) - (t2 - t1)
  ```
- Convert NTP timestamps (seconds since 1900-01-01) to ms since epoch.
  NTP epoch offset: 2208988800 seconds (1900-01-01 to 1970-01-01).
- Timeout: 2 seconds per source.
- Export: `createNtpTransport({ timeoutMs = 2000 } = {})` → the transport object.
- **Injectable socket factory** for tests (no real UDP in tests).

**Tests:** `tests/scalper/transports/ntp.test.mjs`
- Correct offset computation from a mock NTP response.
- Correct roundTrip computation.
- Timeout when no response.
- Invalid response (wrong length, bad version) → reject.
- NTP epoch conversion (1900 → 1970 offset).

### 2. HTTP transport

**File:** `src/scalper/transports/http.mjs`

The detect/checkout modules expect a transport with:
```js
{
  get(url, { signal, headers } = {}) → Promise<{ status, headers, body }>
  postJson(url, body, { signal, headers } = {}) → Promise<{ status, headers, body }>
  request({ method, url, headers, body, signal }) → Promise<{ status, headers, body }>
}
```

Build the real HTTP client using `node:fetch` (global in Node 22):

- `get(url, opts)` → `fetch(url, { signal, headers, method: 'GET' })`
- `postJson(url, body, opts)` → `fetch(url, { signal, headers: { 'Content-Type': 'application/json', ...opts?.headers }, method: 'POST', body: JSON.stringify(body) })`
- `request(opts)` → `fetch(opts.url, { ...opts })`
- Parse the response: `{ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() }`
- If the content-type is JSON, also parse `body` as JSON and attach as `bodyJson`.
- **Injectable fetch function** for tests (no real network in tests).

**Tests:** `tests/scalper/transports/http.test.mjs`
- GET returns status, headers, body.
- POST JSON sends the correct content-type and body.
- Signal abort propagates.
- JSON body is parsed into `bodyJson`.
- Non-JSON body is left as string.
- Error status (404, 500) is returned, not thrown.

### 3. Discord WebSocket transport

**File:** `src/scalper/transports/discord-ws.mjs`

The discord-feed module (`src/scalper/discord-feed.mjs`) expects a transport
with:
```js
{
  connect({ token, intents, onMessage, onChannel, onDisconnect }) → Promise<void>
  close() → Promise<void>
}
```

Build the real Discord Gateway client using `node:net` + `node:crypto` +
`node:zlib`:

**Discord Gateway protocol (v10):**

1. **HTTP GET** `https://discord.com/api/v10/gateway` → `{ url: "wss://gateway.discord.gg/?v=10&encoding=json" }`
2. **WebSocket CONNECT** to the returned URL.
3. **On open**, send opcode 2 (IDENTIFY):
   ```json
   {
     "op": 2,
     "d": {
       "token": "<authorized-bot-token>",
       "intents": 32,
       "properties": {
         "os": "darwin",
         "browser": "scalper",
         "device": "scalper"
       }
     }
   }
   ```
   Use the bot intents exported by `discord-feed.mjs`; the current SDK adapter
   owns IDENTIFY, heartbeat, resume, and intent serialization.
4. **On opcode 10 (READY):** extract `session_id`, `user.id`. Send opcode 6
   (HEARTBEAT) with the `heartbeat_interval` from the READY payload.
5. **Heartbeat:** send `{ op: 1, d: <last sequence number> }` every
   `heartbeat_interval` ms. Track the `s` (sequence) field from every
   incoming message.
6. **On opcode 1 (HEARTBEAT request):** respond immediately with
   `{ op: 1, d: <last sequence> }`.
7. **On opcode 0 (DISPATCH):**
   - `MESSAGE_CREATE` → call `onMessage(message.d)`.
   - `GUILD_CREATE` / `GUILD_MEMBERS` → extract channels, call `onChannel(channel)`
     for each channel.
   - `CHANNEL_CREATE` → call `onChannel(channel.d)`.
8. **On opcode 11 (HEARTBEAT ACK):** record the round-trip time.
9. **On close:** call `onDisconnect()`.
10. **Reconnect:** the discord-feed module handles reconnection by calling
    `connect()` again. The transport just needs to call `onDisconnect()` on
    close.

**WebSocket framing (RFC 6455):**

- **Client → Server:** FIN=1, opcode=1 (text), mask=1, 4-byte random mask key,
  masked payload.
- **Server → Client:** FIN=1, opcode=1 (text), mask=0, unmasked payload.
- **Close frame:** opcode=8.
- **Ping/Pong:** opcode=9 (ping) → respond with opcode=10 (pong), same payload.

**TLS:** Use `node:tls` to connect to `gateway.discord.gg:443`. The SNI must
be `gateway.discord.gg`.

**Injectable socket factory** for tests (no real TCP/TLS in tests).

**Export:** `createDiscordWsTransport({ fetch = globalThis.fetch, tlsConnect, timeoutMs = 5000 } = {})`

**Tests:** `tests/scalper/transports/discord-ws.test.mjs`
- IDENTIFY is sent with the correct token and intents.
- HEARTBEAT is sent at the correct interval.
- MESSAGE_CREATE dispatches to onMessage.
- CHANNEL_CREATE dispatches to onChannel.
- HEARTBEAT_ACK is tracked.
- Close frame triggers onDisconnect.
- Ping is answered with Pong.
- Reconnection: after close, connect() can be called again.
- **False-positive sibling:** a message from a different guild does NOT
  dispatch to onMessage.

### 4. Wire the transports into the modules

**File:** `src/scalper/wiring.mjs` (new)

A single entry point that wires the real transports into the core modules:

```js
import { createNtpTransport } from './transports/ntp.mjs';
import { createHttpTransport } from './transports/http.mjs';
import { createDiscordWsTransport } from './transports/discord-ws.mjs';
import { SynchronizedClock } from './clock.mjs';
import { DropCalendar } from './drop-calendar.mjs';
import { AccountManager } from './accounts.mjs';
import { DryRunHarness } from './dry-run.mjs';
import { DiscordFeed } from './discord-feed.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { AlertManager } from './alerts.mjs';
import { loadEnvFile } from './env.mjs';

export async function createScalper({ env = process.env } = {}) {
  await loadEnvFile({ env });

  const ntp = createNtpTransport();
  const clock = new SynchronizedClock({ transport: ntp });
  await clock.start();

  const http = createHttpTransport();
  const calendar = new DropCalendar();
  const accounts = new AccountManager({ env });
  const dryRun = new DryRunHarness({ env });
  const alerts = new AlertManager({ env });

  const discordWs = createDiscordWsTransport();
  const discordConfig = await loadDiscordConfig();
  const discordFeed = new DiscordFeed({
    config: discordConfig,
    transport: discordWs,
    calendar,
    onDrop: (drop) => alerts.dropDetected({ product: drop.id }),
  });

  const orchestrator = new Orchestrator({
    calendar,
    clock,
    alerts,
    lanes: {
      // Wire each site lane here with the real http transport.
      // The site lanes' detect/checkout modules already accept an injected http.
    },
  });

  return { clock, calendar, accounts, dryRun, alerts, discordFeed, orchestrator, http };
}
```

**Tests:** `tests/scalper/wiring.test.mjs`
- `createScalper()` returns all the expected modules.
- The clock is synchronized after `createScalper()`.
- The discord feed is connected.
- **False-positive sibling:** `createScalper()` with a missing token does
  NOT throw (the discord feed just doesn't connect).

### 5. Update the entry points

**`src/scalper/orchestrator.mjs`** — the `if (process.argv[1] ...)` block at
the bottom should use `createScalper()` instead of `new Orchestrator()`.

**`src/scalper/discord-feed.mjs`** — the `if (process.argv[1] ...)` block at
the bottom should use `createScalper()` instead of throwing "transport not
implemented."

**`src/scalper/health.mjs`** — the `if (process.argv[1] ...)` block at the
bottom should use `createScalper()` instead of `new SynchronizedClock()`.

**`src/scalper/dry-run.mjs`** — the `if (process.argv[1] ...)` block at the
bottom should use `createScalper()` instead of `new DropCalendar()`.

### 6. Discord drop message parser (real patterns)

**File:** `src/scalper/discord-parser.mjs` (new)

The current `parseDropMessage` in `discord-feed.mjs` is a starting guess.
Build a more robust parser that:

1. **Extracts the store** from the message content (pokemon-center, tcgplayer,
   bestbuy, target).
2. **Extracts the product name** (booster box, ETB, tin, etc.).
3. **Extracts the drop time** (ISO timestamp, or "today at 10am", or
   "tomorrow at 2pm", or a relative time).
4. **Extracts the product URL** (if present).
5. **Extracts the quantity** (if mentioned, e.g. "5 boxes available").
6. **Returns a structured drop object** matching the `validateDrop` schema.

**The parser must handle these real-world patterns** (the operator will send
3-5 examples, but build for the common cases now):

- "SV 151 Booster Box drops at 10am on Pokemon Center"
- "TCGPlayer just restocked Scarlet & Violet 151 ETBs — grab them now"
- "Target: Pokemon TCG 151 Booster Box available at 2pm today"
- "Best Buy has 151 booster boxes in stock, link: https://..."
- "DROP ALERT: Pokemon Center 151 ETB at 14:00 UTC"
- "Restock: TCGPlayer 151 booster box, 5 units available"
- Messages with embeds (the product info is in the embed, not the content)
- Messages with multiple stores mentioned (pick the first match)
- Messages with no time (default to "now" → surprise drop)

**Tests:** `tests/scalper/discord-parser.test.mjs`
- Each of the 7 patterns above → correct structured drop.
- Message with no store → null.
- Message with no product → null.
- Message with embed → parsed from embed.
- **False-positive sibling:** a message about a non-Pokémon product → null.
- **False-positive sibling:** a message about a Pokémon video game (not TCG)
  → null.

### 7. Playwright browser adapter (interface + mock)

**File:** `src/scalper/transports/browser.mjs` (new)

The checkout modules expect a browser adapter with:
```js
{
  checkout({ product, account, session, channel, headless, preserveCookies }) → Promise<{ orderId, status }>
  handleChallenge({ channel, headless, preserveCookies }) → Promise<void>
}
```

Build the interface and a **mock implementation** for tests. The real
Playwright implementation will be built in a later phase (it needs the actual
selectors and click sequences from DevTools measurement).

**The mock must:**
- Accept the same interface.
- Return a fake `{ orderId: 'mock-123', status: 'purchased' }`.
- Log the call for test verification.

**The real Playwright adapter** (stub, to be filled in after measurement):
- Import `playwright` (the only external dep).
- Launch with `channel: 'chrome'`, `headless: false`.
- Navigate to the product page.
- Click "Add to Cart."
- Navigate to checkout.
- Fill in payment (or use saved card).
- Click "Place Order."
- Wait for the confirmation page.
- Extract the order number.
- **TODO(measure):** the actual selectors and click sequences.

**Tests:** `tests/scalper/transports/browser.test.mjs`
- Mock checkout returns the expected shape.
- Mock handleChallenge does not throw.
- **False-positive sibling:** checkout with no product → throws.

### 8. Update package.json

Add the Playwright dependency (the only external dep):
```json
{
  "dependencies": {
    "playwright": "^1.50.0"
  }
}
```

Add a script to install browsers:
```json
{
  "scripts": {
    "browsers": "npx playwright install chrome"
  }
}
```

### 9. Update .env.example

Add:
```
# Playwright browser path (optional; defaults to system Chrome).
SCALPER_BROWSER_PATH=
```

## File tree (new files in this phase)

```
src/scalper/transports/
  ntp.mjs
  http.mjs
  discord-ws.mjs
  browser.mjs
src/scalper/
  wiring.mjs
  discord-parser.mjs
tests/scalper/transports/
  ntp.test.mjs
  http.test.mjs
  discord-ws.test.mjs
  browser.test.mjs
tests/scalper/
  wiring.test.mjs
  discord-parser.test.mjs
```

## Verification

After building, run:

```bash
cd /path/to/pokemon-scalper
node --test --test-timeout=120000 'tests/**/*.test.mjs'
```

All tests must pass (the 56 from Phase 1 + the new ones). Then run:

```bash
node -e "import('./src/scalper/transports/ntp.mjs').then(m => console.log('ntp:', Object.keys(m)))"
node -e "import('./src/scalper/transports/http.mjs').then(m => console.log('http:', Object.keys(m)))"
node -e "import('./src/scalper/transports/discord-ws.mjs').then(m => console.log('ws:', Object.keys(m)))"
node -e "import('./src/scalper/transports/browser.mjs').then(m => console.log('browser:', Object.keys(m)))"
node -e "import('./src/scalper/wiring.mjs').then(m => console.log('wiring:', Object.keys(m)))"
node -e "import('./src/scalper/discord-parser.mjs').then(m => console.log('parser:', Object.keys(m)))"
```

Each must print the exported function names without error.

## What the operator will do after you're done

1. Send 3-5 examples of the actual Discord drop announcement messages.
2. Install an authorized Discord bot with the server administrator's approval
   and store its bot token only in the local `.env`.
3. Get the TCGPlayer API key → `.env`.
4. Create 1 account per site → `config/scalper-accounts.json`.
5. Add 3-5 target products → `config/scalper-drops.json`.
6. Run `npm run scalper:dry` against a live drop.
7. Switch to `SCALPER_LIVE=1` for a real purchase.

## What NOT to build in this phase

- **Do NOT build the actual Playwright click sequences.** Build the interface
  and the mock. The real selectors need DevTools measurement.
- **Do NOT build the actual site-specific endpoint URLs.** They're still TODOs
  in the config files.
- **Do NOT add any external npm dependencies** except Playwright.
