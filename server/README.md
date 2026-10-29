# gatheros-server

Cloudflare Worker for GatherOS sign-in, licensing, the AI proxy, and the optional inbox. It lives in this repo so the desktop app and the API stay in lock-step.

The desktop app still defaults to `https://api.gatheros.co` until you set **Settings → Inbox → API server** (or `GATHEROS_API_BASE_URL`). Auth, licensing, AI, and the inbox all use that one base URL. Deploying this Worker does not change the upstream service. Do not put the upstream D1 database id back into `wrangler.toml`. `npm run deploy` refuses it.

Nothing in this README deploys for you. Every remote command needs your own `wrangler login`.

## What's in here

```
server/
├─ migrations/                  D1 schema, including 0006 (inbox tokens + queue)
├─ src/index.ts                 Worker entry (fetch + daily inbox retention)
├─ src/auth.ts                  Magic-link sign-in and session lookup
├─ src/license.ts               /license/verify, checkout, customer portal
├─ src/ai.ts                    OpenAI proxy
├─ src/tokens.ts                POST/GET/DELETE /v1/tokens
├─ src/inbox.ts                 /v1/inbox queue
├─ src/mcp.ts                   POST /mcp (streamable HTTP)
├─ wrangler.toml                bindings and non-secret vars
└─ scripts/check-config.mjs     blocks a remote deploy aimed at the wrong database
```

## Deploy on your own Cloudflare account

Run these from `server/` after `npm install`.

```bash
cd server
npx wrangler login

# 1. D1. Wrangler prints a database_id. Paste it over the all-zero
#    sentinel in wrangler.toml ([[d1_databases]] database_id).
npx wrangler d1 create gatheros-db

# 2. R2 bucket for inbox image bytes. The binding name in
#    wrangler.toml is ASSETS; the bucket name is gatheros-assets.
npx wrangler r2 bucket create gatheros-assets

# 3. Apply the schema to that new database.
npm run db:migrate:remote

# 4. Secrets. Each command prompts. Do not commit the values.
#    Use a real Resend key only after EMAIL_FROM is an address on a
#    domain you have verified. "stub" is for local dev, not production.
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put LEMONSQUEEZY_API_KEY
npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET
npx wrangler secret put OPENAI_API_KEY
# Optional:
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put GITHUB_TOKEN

# 5. Non-secret vars already live in wrangler.toml. Before real
#    billing, set LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_MONTHLY,
#    and LEMONSQUEEZY_VARIANT_YEARLY to ids from your own store, and
#    set EMAIL_FROM to a sender you control. Empty store id makes
#    checkout return billing_not_configured instead of calling
#    Lemon Squeezy.

# 6. Deploy. This fails if database_id is still the sentinel.
npm run deploy
```

Bindings the Worker expects:

| Binding | Kind | Name |
| --- | --- | --- |
| `DB` | D1 | `gatheros-db` |
| `ASSETS` | R2 | `gatheros-assets` |

A cron trigger (`15 7 * * *` UTC) deletes inbox bytes 7 days after delivery and drops pending items after 30 days. `npm run deploy` publishes it with the Worker.

After deploy, the Worker answers on `https://gatheros-api.<your-subdomain>.workers.dev`. A custom hostname is optional. Put that origin in the desktop app. It must be the origin only (`https://host`), with no path.

### Point the desktop app at it

In the app: **Settings → Inbox → API server**, paste the Worker origin, and leave the field. Auth, licensing, AI, and inbox calls all move together. Or launch with:

```bash
GATHEROS_API_BASE_URL=https://gatheros-api.<your-subdomain>.workers.dev npm run dev
```

The Settings value wins over the environment variable. Clear the field to go back to `https://api.gatheros.co`.

Sign out and sign in again after switching servers. A session from one deployment is not valid on another.

### Connect an MCP client

1. Sign in on the desktop app against your Worker.
2. **Settings → Inbox**. Copy **MCP server**. It is `{API server}/mcp`.
3. **Create token**. Copy the token immediately. It is not shown again and it is not stored on the Mac. The server keeps only a hash.
4. In the MCP client, add a remote server:

   - URL: the MCP server value, for example `https://gatheros-api.<your-subdomain>.workers.dev/mcp`
   - Transport: streamable HTTP
   - Header: `Authorization: Bearer gos_in_…`

The token’s scope is `inbox:write`. It can call `add_item`, `list_collections`, `list_recent_inbox_items`, `list_rated_items`, and `file_items`. It cannot read the library, stream image bytes back, or call `/license` or `/ai`. Revoke it in Settings to cut it off and delete its undelivered items.

Turn **Pull inbox items** on. Items land in the open library, in the collection the assistant named, or in **Inbox** when it didn’t name one. The app also pulls on launch, when the window is focused, and every 15 minutes.

`list_collections` returns names the app published on its last pull (collections and boards, ids and names only). Pull once, or create a collection and pull, before expecting the assistant to target it.

`add_item` also takes `collection_name` (up to 80 characters). The app matches it to an existing collection or board, ignoring case, or creates a collection with that name. A valid `collection_id` wins over the name.

### Ratings and filing

Inbox saves get **Like** and **Dislike** in the detail panel and on grid cards (hover or keyboard focus). Clicking the active one clears it. Only saves that came through the inbox can be rated. The app sends ratings to `POST /v1/inbox/ratings` with your session, a few seconds after a click and on every pull. The latest `rated_at` wins.

- `list_rated_items` (`since` as epoch ms or ISO date, `rating` `like` | `dislike` | `any`, `limit` up to 50) returns rated inbox items: id, title, note, tags, source, the collection it was sent to, the rating, and the state of any filing. No image bytes.
- `file_items` takes up to 50 `{ item_id, collection_id? | collection_name? }`. Each one queues a move. On the next pull the app adds the save to that collection (matching the name or creating it) and takes it out of **Inbox**, then acks to `POST /v1/inbox/filings/ack`. It never deletes a save, and it only touches saves that came from the inbox. An item that has not been pulled yet is retargeted instead, so it lands in the right place.
- New collections from `add_item` or `file_items` are capped at 20 distinct names per account per rolling day (`INBOX_DAILY_NEW_COLLECTION_LIMIT`). The app applies the same cap per pull. Past the cap, the server returns `collection_create_limit` and the app falls back to **Inbox**.

Routes the desktop uses for this, all with the session: `POST /v1/inbox/ratings`, `GET /v1/inbox/filings`, `POST /v1/inbox/filings/ack`.

### Calling it from a script

`workers.dev` returns 403 to some default client user agents, including Python `urllib`’s `Python-urllib/3.x`. Send a normal `User-Agent` header:

```python
import json, urllib.request
req = urllib.request.Request(
    "https://gatheros-api.<your-subdomain>.workers.dev/mcp",
    data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; my-inbox-script/1.0)",
    },
)
print(urllib.request.urlopen(req).read().decode())
```

Example, once the Worker is running locally (`npm run dev` in `server/`):

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_item","arguments":{"title":"Ramp home","note":"One input, three chips.","source_url":"https://example.com/ramp","source_name":"web","tags":["empty-state"],"image_base64":"'"$PNG_BASE64"'"}}}'
```

## Local dev

```bash
cd server
cp .dev.vars.example .dev.vars   # RESEND_API_KEY=stub skips real email
npm run db:migrate:local
npm run dev                      # http://127.0.0.1:8787
```

The all-zero `database_id` is only for this local database. Magic-link URLs print in the wrangler log when the Resend key is `stub`.

An end-to-end check against that local Worker (no deploy) is `node scripts/inbox-e2e.js` from the repo root. It adds an item over MCP and imports it with the desktop save path.

## Smoke-test auth

```bash
curl -X POST http://127.0.0.1:8787/auth/magic-link \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'

# Copy the token from the wrangler log, then:
curl -X POST http://127.0.0.1:8787/auth/exchange \
  -H "Content-Type: application/json" \
  -d '{"token":"<paste-token-here>","deviceLabel":"laptop"}'

curl http://127.0.0.1:8787/license/verify \
  -H "Authorization: Bearer <sessionToken>"
```

## D1 console

```bash
npm run db:console:local -- "SELECT email, trial_ends_at FROM users"
npm run db:console:remote -- "SELECT id, status, plan FROM subscriptions"
```

The remote console runs the same database-id check as deploy.

## Entitlement

Entitlement is decided in `src/rules.ts` (`rowEntitles`) and covered by `src/license.test.ts`. A subscription row entitles the user when its status is `active`, `past_due`, or `trialing`, or when `current_period_end` is still in the future. Cancelling does not revoke access before that period ends.

Inbox writes do not require a paid plan. Importing on the desktop still respects the app’s free-tier save limit, and items stay pending when a new save isn’t allowed.

### Someone says they lost access they paid for

These need `ADMIN_TOKEN` (`npx wrangler secret put ADMIN_TOKEN`). Replace `$API` with your Worker origin.

```bash
curl -s "$API/license/admin-audit" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s -X POST "$API/license/admin-sync?email=someone@example.com" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s -X POST "$API/license/admin-grant?email=someone@example.com&until=2027-08-20&plan=yearly" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

The desktop caches `/license/verify` for an hour and re-verifies every 6 hours. Signing out and back in picks up a fix immediately.

## Inbox limits

Defaults in `wrangler.toml`, overridable there:

- 10 MB per image
- 50 new items per token per day, 200 per account per day
- 250 MB of pending image bytes per account
- 5 active tokens per account
- note up to 1,000 characters, 10 tags
- https image URLs only, and not a private or link-local host
- delivered bytes deleted after 7 days, pending items after 30 days
- 20 new collections per account per day from `collection_name` (`INBOX_DAILY_NEW_COLLECTION_LIMIT`)
- `list_rated_items` and `file_items` up to 50 items per call

## Tests

```bash
cd server && npm test
```

From the repo root, `npm test` covers the desktop import decisions, ratings and filing, the pull loop, API base resolution, and the image size and type guards. `node scripts/inbox-e2e.js` runs the whole loop against a local `wrangler dev`: add, pull, rate, `list_rated_items`, `file_items`, and the pull that moves the save out of Inbox. Set `INBOX_E2E_PORT` if 8791 is taken.
