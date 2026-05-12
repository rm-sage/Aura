# Backend release-search service — design spec

**Status:** proposal (Phase 9 candidate).
**Owners:** rm-sage (Aura client) + Aura Cloud Claude (proxy / poller).
**Touches:** `src/sync.ts`, new `src/releaseSearch.ts`, `src-tauri/src/sync.rs`,
`src-tauri/src/stremio.rs` (calendar / library-watch surfaces), Aura Cloud's
Go service.

---

## 1. Why

Today every Aura client periodically probes its installed metadata addons
(AIOMetadata, Cinemeta) for every series in the library to learn whether
new episodes have aired. Movie release-date polling has the same shape.
With N users each holding ~50–500 library items, the global addon load is
`N × items × poll_interval`, hitting public addons every refresh tick.

The release-detection signal — "has tt22248376 had a new episode emitted
since 2026-05-08?" — is **identical across every user that holds the
title in their library**. Computing it N times wastes network on the
client, abuses the addon hosts, and slows the user's library refresh
because each probe goes through their bandwidth.

Moving this query to Aura Cloud reduces total addon load to `1 ×
unique-items × poll_interval` regardless of user count, lets us run the
poller while clients are offline so a freshly-opened Aura already has
fresh data, and centralises the AIOMetadata patch consumption (filler /
recap kinds, split-season ids) so every client benefits without a
client-side upgrade.

## 2. What stays per-user

**Streams.** Addon stream results are scoped to the requesting user's
auth (Debrid keys, AIOStreams config). Aura Cloud must not query
`fetch_streams` on the user's behalf and must not cache stream URLs.

**Watch progress / scrobble state.** Already per-user via the existing
sync namespaces. Untouched by this spec.

**Catalog / search results.** User-specific by selected addon order and
filter state. The client still runs these.

## 3. What moves to Aura Cloud

**Per-imdb-id release signal** — the answer to:

  > "Is there a NEW episode / movie release for `<imdb_id>` since
  > `<last_seen_at>`?"

Stored as a single `release-signal` namespace blob per imdb-id (NOT per
user). Schema:

```jsonc
{
  "imdb_id": "tt22248376",
  "media_type": "series",
  "last_aired": {
    "season": 2,
    "episode": 7,
    "absolute_episode": 35,
    "aired_at": "2026-04-28T15:00:00Z",
    "id": "tt22248376:2:7"
  },
  "next_aired": {
    "season": 2,
    "episode": 8,
    "absolute_episode": 36,
    "aired_at": "2026-05-05T15:00:00Z",
    "id": "tt22248376:2:8"
  },
  "episode_kinds": [
    { "id": "tt22248376:2:7", "kind": "filler" },
    { "id": "tt22248376:2:8", "kind": "canon" }
  ],
  "polled_at": "2026-05-12T03:00:00Z",
  "etag": "W/\"7c3a91f0\""
}
```

`episode_kinds` is the subset of AIOMetadata's `episodeKind` field for
episodes in the last 14 days (sliding window — drop older entries so the
blob doesn't grow unbounded). Clients use it to render the existing
filler / recap banners without each one re-probing AIOMetadata.

`next_aired` is null when no future episode is announced. `last_aired`
is null for movies (`next_aired.aired_at` carries the theatrical /
streaming release date instead).

## 4. Aura Cloud side — what the Go proxy needs

### 4.1 New endpoints

All under `/sync/v1/release/`.

#### `GET /sync/v1/release/{imdb_id}`

Returns the latest cached signal for one imdb-id. No auth header
required — the data is metadata-level and public. Response:

```
HTTP/1.1 200 OK
ETag: W/"7c3a91f0"
Cache-Control: public, max-age=300, stale-while-revalidate=3600
Content-Type: application/json

{ <ReleaseSignal payload, see §3> }
```

Returns 404 when nothing has ever been polled for the id. Clients then
have two choices: wait for the next poller cycle, or call POST below to
nudge an out-of-band poll.

#### `POST /sync/v1/release/batch`

Read-side fan-out — clients send the list of imdb-ids in their library
and get back the signals in one round-trip. Request:

```jsonc
{ "ids": ["tt22248376", "tt0944947", "tt12345678"] }
```

Cap at 500 ids per request. Response is a map keyed by id; missing ids
have value `null` to differentiate "no signal yet" from "key absent".

#### `POST /sync/v1/release/{imdb_id}/refresh`

Async nudge — tells the poller "this id matters to a real user right
now; bump its priority". Returns 202 immediately; the next poller pass
will pick it up. Rate-limited per-source-IP to 30 nudges per minute so
this can't be used as an amplification attack against the upstream
addons.

### 4.2 The poller

A goroutine inside the existing Aura Cloud service runs the poll loop:

```
every 10 minutes:
  for each id in priority_queue ∪ regular_queue:
    probe each configured metadata addon (AIOMetadata primary,
      Cinemeta fallback) for `{id}/meta`
    diff against last cached signal:
      if last_aired changed -> emit release event
      if next_aired changed -> update signal
      if episode_kinds drift -> update signal
    write signal to KV with new etag
    pop from priority queue on success
```

Priority queue: pushed via `POST /refresh` and via library imports (see
§5). Regular queue: every imdb-id we've ever cached, walked round-robin
so cold ids still get refreshed nightly.

Concurrency: cap at 4 in-flight addon probes; AIOMetadata's host is the
bottleneck. Back-off on 429 / 5xx with exponential jitter.

Storage: existing namespace KV. Suggested key scheme:

```
release:signal:{imdb_id}    -> ReleaseSignal JSON blob
release:meta:queue:priority -> ZSET of imdb_ids by enqueue time
release:meta:queue:cold     -> SORTED SET of imdb_ids by last-polled-at
```

### 4.3 Identity / privacy

`POST /batch` is the only endpoint that takes a list of user-held ids.
Don't log the request body, don't correlate it to the user's
`Authorization: Aura-Sync` header. The proxy already separates auth
verification from the request body in the existing namespace handlers —
mirror that.

`GET /{imdb_id}` is fully anonymous and can be CDN-cached without auth.

`POST /refresh` is authenticated to prevent amplification (also rate-
limited).

### 4.4 What Aura Cloud does NOT do

- **Never** call `fetch_streams` or any addon endpoint that requires
  per-user auth.
- **Never** cache stream URLs or info_hashes.
- **Never** store anything user-specific in the `release:signal:*`
  namespace — those blobs are global and CDN-friendly.

## 5. Aura client side — what changes

### 5.1 `src/releaseSearch.ts` (new module)

Thin wrapper around the three endpoints, mirroring the shape of
`src/notifications.ts` (existing client for the per-user notifications
namespace). Exposes:

```ts
export interface ReleaseSignal { /* §3 schema */ }

/** Fetch one signal — cached in-memory for 5 minutes. */
export async function fetchReleaseSignal(imdbId: string): Promise<ReleaseSignal | null>;

/** Batch fetch for library reconciliation — chunked at 500 ids. */
export async function fetchReleaseSignals(imdbIds: string[]): Promise<Map<string, ReleaseSignal>>;

/** Nudge the poller. Fire-and-forget; don't await for UI work. */
export function nudgeReleasePoller(imdbId: string): void;
```

### 5.2 Calendar / Library reconciliation

`src/views/CalendarView.tsx` and `src/libraryNormalize.ts` currently
fan out an addon probe per library item. Replace with:

1. On library load → collect imdb-ids → single `fetchReleaseSignals`
   call → merge `next_aired` into the in-memory library cache.
2. On detail-page open → `fetchReleaseSignal(id)` for the precise
   episode-kind data.
3. On manual library refresh → `nudgeReleasePoller(id)` per item, then
   re-batch after 30s.

Existing per-item addon probes stay as a fallback for users with sync
turned off OR for ids the poller hasn't seen yet (`null` response).

### 5.3 Filler / recap banner cache

Today the `episode_kind` field arrives on `VideoEntry` from the addon
response on detail-page open. With the backend signal, the most recent
14 days' worth is already in the batch response — we can paint banners
on Calendar and Continue-Watching surfaces without a detail-page round
trip.

Don't pre-cache OLDER episodes via the signal — those belong to the
addon's full meta response which the detail page already loads.

### 5.4 Settings opt-in

Add `releaseSearchEnabled: boolean` (default `true` for signed-in
users, ignored for guests). When false, the client falls back to the
existing per-user addon probing. Settings copy:

  > **Use Aura Cloud's shared release feed**
  > When on, Aura asks the cloud service whether new episodes have
  > aired instead of probing addons from your machine. Faster library
  > refresh and lower bandwidth, but Aura Cloud sees the imdb-ids in
  > your library (it never sees streams, watch history, or your
  > Debrid keys).

### 5.5 Rust side (`sync.rs`)

Add a `release_*` set of commands mirroring the existing namespace ops:

```rust
#[tauri::command]
async fn fetch_release_signal(imdb_id: String) -> Result<Option<Value>, String>;

#[tauri::command]
async fn fetch_release_signals(imdb_ids: Vec<String>) -> Result<HashMap<String, Value>, String>;

#[tauri::command]
async fn nudge_release_poller(imdb_id: String) -> Result<(), String>;
```

Same HTTP client as the existing namespace handlers (matches TLS pin /
timeout policy). No keyring writes — these endpoints don't carry
secrets.

Three-place registration per CLAUDE.md (handler list,
`permissions/player.toml`, `capabilities/default.json`).

## 6. Rollout sequencing

1. Aura Cloud ships endpoints behind a feature flag. Poller fills the
   cache for the top-1000 most-libraried ids (warm start).
2. Aura client ships behind a settings opt-in (default off). Power
   users opt in, surface latency / accuracy bugs.
3. Once two weeks pass without regressions, flip default to on for
   signed-in users. Existing per-addon probe path stays as the
   fallback.
4. Telemetry: poller emits per-id `poll_count`, `avg_latency`,
   `addon_error_rate` to Aura Cloud's existing observability lane.

## 7. Failure modes

- **Cloud unreachable** → client falls back to addon probe path (same
  code path as today). Sync chip in title bar shows the disconnect.
- **Poller behind** → signal carries stale `polled_at`; client compares
  against now and re-falls-back when stale beyond 1 h.
- **AIOMetadata patch differs across users** → poller uses the
  upstream-public patch (the one the user maintains on the VPS).
  Self-hosted custom addons remain a client-side probe (the poller
  doesn't know about user-private addon URLs).

## 8. Non-goals

- Stream caching, addon auth proxying, watch-progress fan-out. All
  per-user.
- Recommendation feeds, trending lists. Out of scope; those are
  catalog responsibilities that already work fine per-user.
- Backfilling historical episodes — the 14-day `episode_kinds`
  window is intentional. Older episodes come from the addon directly
  on detail-page open.
