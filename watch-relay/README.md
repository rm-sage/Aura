# Aura Watch-Together relay

A tiny **Cloudflare Worker + Durable Object** that relays Watch-Together room
messages between Aura clients. It only forwards small JSON frames
(play/pause/seek/title + presence) — it never touches your video, your debrid
tokens, or your IP. One Worker serves unlimited independent rooms; each room is
a Durable Object that hibernates while the party is idle/paused.

Why this instead of a VPS port: nothing of yours is exposed. Clients connect to
a Cloudflare edge hostname (`wss://…workers.dev`), so there's **no origin IP to
leak and no inbound port to scan**, with free TLS + Cloudflare's DDoS edge in
front. It also auto-scales — many separate parties cost you nothing extra.

## Deploy (≈2 minutes)

You need a free Cloudflare account.

```bash
cd watch-relay
npx wrangler login          # opens a browser, authorizes wrangler
npx wrangler deploy         # builds + deploys; prints your Worker URL
```

The deploy prints a URL like:

```
https://aura-watch-relay.<your-subdomain>.workers.dev
```

In **Aura → Settings → Watch Together**, set the **Relay URL** to that host with
the `wss://` scheme:

```
wss://aura-watch-relay.<your-subdomain>.workers.dev
```

That's it — create a room in the player and share the code.

## Optional: lock it to your builds

By default anyone who knows your Worker URL **and** a room code can join that
room. To stop randoms who find the URL from opening rooms at all, set a shared
token:

```bash
npx wrangler secret put APP_TOKEN     # paste any long random string
```

Then put the **same** string in Aura → Settings → Watch Together → *App token*.
The Worker rejects any socket whose token doesn't match.

## Cost / plan note

This uses **SQLite-backed Durable Objects**, which are eligible on the Workers
**Free** plan (the older key-value Durable Objects need the $5/mo Paid plan).
Cloudflare has been changing Durable Objects free-tier limits — if `wrangler
deploy` complains that Durable Objects require a paid plan, either enable the
$5/mo Workers Paid plan or check Cloudflare's current free-tier terms. The relay
itself is featherweight (a few JSON messages per playback action), so usage will
sit far below any meaningful limit for personal watch parties.

## Local test

```bash
npx wrangler dev      # runs the relay locally on http://127.0.0.1:8787
```

Point Aura's Relay URL at `ws://127.0.0.1:8787` to try it before deploying.

## Health check

`GET /` returns `aura-watch-relay ok`. Rooms are `GET /room/<CODE>` with a
WebSocket upgrade.
