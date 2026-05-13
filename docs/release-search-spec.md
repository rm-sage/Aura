# Release-search service — design spec (revised)

**Status:** Phase 9 candidate. Supersedes the v1 draft.
**Owners:** rm-sage (Aura desktop) + Aura Cloud.
**Touches (desktop repo):** `src/sync.ts`, new `src/releaseSearch.ts`,
`src-tauri/src/sync.rs`, `src-tauri/src/stremio.rs`,
`src/views/CalendarView.tsx`, `src/libraryNormalize.ts`,
`permissions/player.toml`, `capabilities/default.json`.
**Touches (cloud repo `~/aura/cloud/`):** `main.go`, `db.go`, `sync.go`,
new `release.go`, new `releasepoll.go`, `docker-compose.yml`,
`README.md`, `INTEGRATION.md`.

> **Audience.** This spec is read by two Claude instances. The Aura
> desktop instance owns §6 (desktop integration). The Aura Cloud
> instance owns §3–§5 (cloud HTTP API, storage, poller). Sections §1,
> §2, §7, §8, §9 are shared.

---

## 1. Why

Today every Aura client periodically probes its installed metadata
addons (AIOMetadata, Cinemeta) for every series in the library to learn
whether new episodes have aired. Movie release-date polling has the same
shape. With N users each holding ~50–500 library items, the global
addon load is `N × items × poll_interval`, hitting public addons every
refresh tick.

The release-detection signal — "has tt22248376 had a new episode emitted
since 2026-05-08?" — is **identical across every user that holds the
title in their library**. Computing it N times wastes network on the
client, abuses the addon hosts, and slows the user's library refresh
because each probe goes through their bandwidth.

Moving this query to Aura Cloud reduces total addon load to
`1 × unique-items × poll_interval` regardless of user count, lets the
poller run while clients are offline so a freshly-opened Aura already
has fresh data, and centralises the self-hosted AIOMetadata fork's
consumption (filler / recap kinds, split-season ids) so every client
benefits without a client-side upgrade.

## 2. Privacy boundary — what stays per-user

**Streams.** Addon stream results are scoped to the requesting user's
auth (Debrid keys, AIOStreams config). Aura Cloud must **not** query
`fetch_streams` on behalf of any user and must **not** cache stream
URLs or info_hashes.

**Watch progress / scrobble state.** Already per-user via the existing
`/sync/v1/` namespaces. Untouched by this spec.

**Catalog / search results.** User-specific by selected addon order and
filter state. The client still runs these.

**Library contents.** Sent to the cloud only via `POST /batch` as a
list of imdb-ids. The cloud must not log the request body, must not
persist it, and must not correlate it to the requester's auth header.
The cloud already separates auth verification from body handling in the
existing sync handlers (`cloud/sync.go`); mirror that.

## 3. The signal payload

Stored once per imdb-id (NOT per user). JSON shape:

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
  "recent_aired": [
    { "season": 2, "episode": 5, "absolute_episode": 33, "aired_at": "2026-04-14T15:00:00Z", "id": "tt22248376:2:5" },
    { "season": 2, "episode": 6, "absolute_episode": 34, "aired_at": "2026-04-21T15:00:00Z", "id": "tt22248376:2:6" },
    { "season": 2, "episode": 7, "absolute_episode": 35, "aired_at": "2026-04-28T15:00:00Z", "id": "tt22248376:2:7" }
  ],
  "episode_kinds": [
    { "id": "tt22248376:2:7", "kind": "filler" },
    { "id": "tt22248376:2:9", "kind": "recap" }
  ],
  "polled_at": "2026-05-12T03:00:00Z",
  "etag": "7c3a91f0a2b51c8d"
}
```

Field rules:

- `media_type` ∈ {`series`, `movie`}.
- `last_aired`: most recently aired episode (series) or null (movie).
- `next_aired`: soonest future episode/release, or null when none known.
  For movies, `last_aired` is null and `next_aired.aired_at` carries the
  theatrical / streaming release date.
- `absolute_episode` is omitted when the addon doesn't supply it.
- `recent_aired`: every episode whose `aired_at` is in the last 365 days,
  sorted **ascending** by `aired_at`. Capped at the 200 most-recent
  entries (oldest are dropped first when the list overflows the cap).
  Empty array for movies. **This is the notification source**: the
  desktop iterates this list and fires one notification per episode
  newer than its local "last seen" record for the title, so multiple
  episodes that aired between sessions all surface — not just the single
  most-recent one. `last_aired` remains as a convenience accessor (= the
  newest entry of `recent_aired` when both are non-empty, modulo the
  365-day window: `last_aired` may be older than the window for titles
  with no recent activity, in which case `recent_aired` is empty).
- `episode_kinds`: per-episode classification, only for episodes whose
  `aired_at` is within ±14 days of `polled_at` (sliding window — drop
  older entries so the blob doesn't grow). Derived from AIOMetadata's
  per-video `filler` and `recap` booleans (which AIOMetadata stamps from
  Jikan / MAL data). `kind` ∈ {`"filler"`, `"recap"`} — strictly enum;
  there is no `"canon"` value. **Canon is encoded by absence**: an
  episode id missing from this list is canon (render no banner). When
  AIOMetadata flags an episode as both filler and recap, two entries
  appear with the same `id` and different `kind`s; the desktop should
  render both banners. When the signal was sourced from Cinemeta (or
  AIOMetadata was unreachable), this list is empty — Cinemeta does not
  carry the flags.
- `polled_at`: ISO-8601 UTC; when the cloud last successfully polled
  the upstream addon for this id.
- `etag`: 16-char hex, derived as `hex(sha256(payload_bytes))[:16]` so
  the same algorithm as existing sync blobs (`cloud/db.go:computeETag`).
  Served on `GET` as a strong validator (no `W/` weak prefix, no
  surrounding quotes — bare hex, matching the existing pattern).

## 4. Aura Cloud HTTP API

All endpoints under `/sync/v1/release/`. No collision with the existing
`GET /sync/v1/{namespace}` route — the namespace pattern only captures
a single trailing segment.

### 4.1 `GET /sync/v1/release/{imdb_id}` — read one signal

- **Auth:** none. Public, anonymous.
- **Response:** signal JSON (see §3). 404 when nothing has ever been
  polled for the id.
- **Headers:**
  ```
  ETag: 7c3a91f0a2b51c8d
  Cache-Control: public, max-age=300, stale-while-revalidate=3600
  Content-Type: application/json; charset=utf-8
  ```
  `Cache-Control` is set even though there's no CDN in front of Traefik
  today — it's a no-op at the edge but lets browsers / clients cache
  per their own policy, and will start helping the day a CDN is fronted.
- **Conditional requests:** if the request carries `If-None-Match` and
  it equals the current etag, respond `304 Not Modified` with no body.
- **Rate limit:** IP-keyed token bucket, 120 req capacity refilling at
  2/sec (separate `rateLimiter` instance from the existing per-(scope,
  ip) one).

### 4.2 `POST /sync/v1/release/batch` — read many signals

- **Auth:** required. `Authorization: Aura-Sync <64-hex>` header,
  validated by the existing `authSync` middleware.
- **Body:** JSON, capped at 64 KiB by `MaxBytesReader`:
  ```jsonc
  {
    "items": [
      { "id": "tt22248376", "type": "series" },
      { "id": "tt0944947",  "type": "series" },
      { "id": "tt15239678", "type": "movie"  }
    ]
  }
  ```
  Cap at 500 items per request. `type` is **required** so the poller
  can probe the correct addon endpoint for first-seen ids without
  wasted double-probes. Reject with 400 `bad_request` on missing /
  unknown type.
- **Response:** map keyed by id; missing ids have value `null` to
  differentiate "queued, no signal yet" from "key absent in request".
  ```jsonc
  {
    "signals": {
      "tt22248376": { /* signal */ },
      "tt0944947":  null,
      "tt15239678": { /* signal */ }
    }
  }
  ```
- **Side effect:** any id in the request that's not yet in
  `release_signals` is inserted with `priority=1` and
  `next_eligible_at=now()` so the poller picks it up on the next tick.
  This is how the queue seeds — see §5.4.
- **Logging:** log only `method`, status code, item count, and the
  scope-truncated-to-4-chars (same pattern as existing `logSync`).
  Never log the items array.
- **Response ETag (since 2026-05-13).** Every 200 response carries an
  `ETag` header derived deterministically from the request id list +
  per-signal etags. Clients may send `If-None-Match: <last-etag>` to
  short-circuit unchanged refresh ticks; the server replies `304 Not
  Modified` with the `ETag` header and no body. See §10.1 for the
  full produce/consume protocol.

### 4.3 `POST /sync/v1/release/{imdb_id}/refresh` — nudge the poller

- **Auth:** required (`Aura-Sync` header). Authentication is what makes
  this a sane endpoint — without it, an attacker could use the cloud
  to spam upstream addons via this amplification surface.
- **Body:** optional `{ "type": "series" | "movie" }` to teach the
  poller the type for a first-seen id. Ignored if a signal already
  exists for the id.
- **Response:** `202 Accepted` with empty body.
- **Effect:** sets `priority=1` and `next_eligible_at=now()` for the id,
  inserting the row if absent.
- **Rate limit:** IP-keyed, 30 nudges per minute (capacity 30, refill
  0.5/sec). Independent from the §4.1 limiter — different bucket map.

### 4.4 Errors

Use the existing `jsonErr` helper. Codes used by these endpoints:
`missing_or_invalid_auth` (401), `rate_limited` (429), `bad_request`
(400), `not_found` (404), `internal_error` (500). Match the existing
shape: `{"error": "<code>", ...extras}`.

## 5. Aura Cloud — storage, poller, config

### 5.1 Storage (new tables in `cloud/db.go`)

The existing service is SQLite-backed (`sql_blobs` per-user). The
signal cache is global, not per-user, so it gets its own table — not a
new namespace, not Redis.

```sql
CREATE TABLE IF NOT EXISTS release_signals (
    imdb_id           TEXT    PRIMARY KEY,
    media_type        TEXT,                        -- 'series' | 'movie' | NULL until first probe
    payload           BLOB,                        -- JSON, NULL until first successful poll
    etag              TEXT,                        -- 16-hex, NULL until first successful poll
    polled_at         INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 = never polled
    next_eligible_at  INTEGER NOT NULL DEFAULT 0,  -- unix seconds
    priority          INTEGER NOT NULL DEFAULT 0,  -- 0 = cold, 1 = hot
    fail_count        INTEGER NOT NULL DEFAULT 0,  -- consecutive failures, for backoff
    last_error        TEXT                         -- truncated, for debugging; cleared on success
);

CREATE INDEX IF NOT EXISTS idx_release_eligible
    ON release_signals (priority DESC, next_eligible_at ASC);
```

One table, one row per id. "Queue membership" is just `next_eligible_at
<= now()`. "Has a signal" is just `polled_at > 0`.

The existing `SetMaxOpenConns(1)` serialization still applies (single
writer over the SQLite connection). The poller runs in goroutines but
serializes its writes through the same `*sql.DB`.

GC: a nightly sweep drops rows where `polled_at < now() - 90 days` AND
`priority = 0` — i.e. cold ids the cloud hasn't been asked about
recently. Priority rows persist until they go cold (priority is
demoted to 0 if no `POST /batch` or `/refresh` touches the row for 7
days).

### 5.2 Poller (new file `cloud/releasepoll.go`)

Continuous worker pool, not a "every N minutes scan everything" loop:

- **Pool size:** 4 concurrent probes. Use a buffered channel as a
  semaphore.
- **Loop:** every 5 seconds, the dispatcher runs:
  ```sql
  SELECT imdb_id, media_type
    FROM release_signals
   WHERE next_eligible_at <= ?
   ORDER BY priority DESC, next_eligible_at ASC
   LIMIT 4
  ```
  with `? = unix now`. For each row returned, acquire the semaphore
  and dispatch a goroutine.
- **Probe:** AIOMetadata's meta route requires a userUUID prefix —
  the canonical Stremio path (`/meta/{type}/{id}.json`) returns 404
  because every meta request loads a per-user config from
  AIOMetadata's database. Cinemeta uses the canonical path with no
  prefix. The poller therefore builds source-specific URLs:
  1. AIOMetadata: `{AIOMETADATA_BASE_URL}/stremio/{AIOMETADATA_USER_UUID}/meta/{type}/{id}.json`.
  2. Cinemeta: `{CINEMETA_BASE_URL}/meta/{type}/{id}.json`.

  Then:
  1. If `media_type` is set, probe only that type.
  2. If `media_type` is unknown (first-seen id with no `type` hint),
     try `series` first, then `movie` on 404. (Series-first is a
     heuristic — most queued ids in practice are anime / TV.)
  3. On 5xx / transport error from AIOMetadata, fall back to Cinemeta
     at the same imdb-id and type. On 4xx from AIOMetadata, also try
     Cinemeta — AIOMetadata may genuinely not have the title while
     Cinemeta does.
- **Diff + write:** parse the addon response, derive `last_aired`,
  `next_aired`, `episode_kinds` (only entries within ±14 days of now),
  compute etag, write the row. On `last_aired` change, `polled_at` and
  `next_eligible_at` advance.
- **Scheduling:**
  - On success: `polled_at = now`. `next_eligible_at`:
    - `now + 10min` if `priority = 1` AND `next_aired.aired_at` is
      within 7 days of now (something is imminent — poll more often)
    - `now + 1h`  if `priority = 1` otherwise
    - `now + 24h` if `priority = 0`
    - `fail_count = 0`, `last_error = NULL`.
  - On failure: `fail_count++`,
    `next_eligible_at = now + min(2^fail_count, 3600) seconds` with
    jitter ±25%. Truncate `last_error` to 200 chars.
  - After 8 consecutive failures, demote `priority = 0` and stop
    auto-retrying until a new batch / refresh touches the row.
- **Backoff on upstream 429:** honour `Retry-After` if present;
  otherwise treat as a transient failure and use the exponential
  backoff above. The 4-concurrent cap means one bad addon can't
  saturate the pool indefinitely.
- **Telemetry:** emit one log line per probe outcome:
  ```
  release poll id=tt22248376 type=series source=aiometadata outcome=200 size=14823 latency_ms=412
  release poll id=tt22248376 type=series source=cinemeta outcome=fallback-ok latency_ms=611
  release poll id=tt22248376 type=series source=aiometadata outcome=upstream-429 retry_after=12
  ```
  Same single-line format as existing logs. Never log payload contents.

### 5.3 Configuration (env vars in `docker-compose.yml`)

Add to the existing block:

| Var                            | Required | Default                            | Notes                                                       |
| ------------------------------ | -------- | ---------------------------------- | ----------------------------------------------------------- |
| `AIOMETADATA_BASE_URL`         | yes      | —                                  | e.g. `http://aiometadata:3232` on the proxy network         |
| `AIOMETADATA_USER_UUID`        | yes      | —                                  | UUID of the AIOMetadata user config the poller probes as    |
| `CINEMETA_BASE_URL`            | no       | `https://v3-cinemeta.strem.io`     | Public Cinemeta; override only for self-hosted              |
| `RELEASE_POLLER_ENABLED`       | no       | `true`                             | Set `false` to disable the poller goroutine entirely        |
| `RELEASE_POLLER_INTERVAL`      | no       | `5s`                               | Dispatcher tick                                             |
| `RELEASE_POLLER_CONCURRENCY`   | no       | `4`                                | Max in-flight probes                                        |
| `RELEASE_PROBE_TIMEOUT`        | no       | `10s`                              | Per-probe HTTP timeout                                      |

`loadConfig` in `main.go` validates `AIOMETADATA_BASE_URL` and
`AIOMETADATA_USER_UUID` when `RELEASE_POLLER_ENABLED=true`. The other vars
get defaults.

**Operational note.** Pick one user config in AIOMetadata's database to be
the "canonical" config for the poller — its provider preferences and
toggles (e.g. `forceAnimeForDetectedImdb`, `aggregateAnimeSequels`) are
what shape the global cache that every Aura client reads. Changing the
canonical user's toggles invalidates the cache only via the natural poll
cadence; consider bumping `last_demand_at` cutoffs or manually clearing
`release_signals` if you need a faster cutover.

### 5.4 Queue lifecycle (no warm-start)

The original draft proposed warming the cache with the "top-1000
most-libraried ids" on cloud bring-up. Aura Cloud has no visibility
into user libraries (no namespace stores library contents), so this
step is **dropped**. The queue seeds organically:

1. Desktop opts in → calls `POST /batch` with library ids → cloud
   inserts cache-miss rows with `priority=1, next_eligible_at=now`.
2. Within one dispatcher tick (5s), the poller picks them up.
3. Subsequent `POST /batch` and `GET` calls return the cached signals.

For an opted-in user with a 200-item library, the first batch call
inserts 200 rows; with `concurrency=4` and ~500 ms per probe, the
cache is hot within ~25 seconds. Acceptable cold-start.

### 5.5 What Aura Cloud must NOT do

- Call `fetch_streams` or any per-user-auth'd addon endpoint.
- Cache stream URLs or info_hashes.
- Store anything user-specific in `release_signals` — these rows are
  global and shareable.
- Log the body of `POST /batch` or correlate the body to the auth
  header.

## 6. Aura desktop side — what changes

> **Desktop Claude:** this whole section is yours. §6.0 is a checklist —
> use it to plan the work; §6.1–§6.5 are the per-area details.

### 6.0 Aura responsibilities — what must ship on the desktop side

Each item below is required to fully utilise the release-search service.
None of them is optional except where called out. The cloud half is
already deployed (or will be deployed alongside the desktop rollout);
the desktop changes are what unlock the user-visible benefits.

- [ ] **New module `src/releaseSearch.ts`** exposing
      `fetchReleaseSignal`, `fetchReleaseSignals`, `nudgeReleasePoller`
      (full signatures in §6.1). Mirror the shape and ergonomics of
      `src/notifications.ts`. In-memory cache for single-id fetches
      with a 5-minute TTL; chunk batch requests at 500 items.
- [ ] **`POST /batch` items carry both `id` and `type`** (`"series"`
      or `"movie"`). The cloud rejects requests with missing/unknown
      `type` (400). Library entries already carry the media type —
      pass it through verbatim.
- [ ] **Conditional GET support.** On repeated `fetchReleaseSignal`
      for the same id, send `If-None-Match: <last-etag>`; the cloud
      replies `304 Not Modified` with no body when the signal hasn't
      changed. Treat `304` as "use cached".
- [ ] **Library reconciliation rewiring** (§6.2):
  - On library load → collect `{id, type}` for every entry → single
    `fetchReleaseSignals` call → merge `next_aired` into the
    in-memory library cache.
  - On detail-page open → `fetchReleaseSignal(id)` for the precise
    `episode_kinds` data.
  - On manual library refresh → `nudgeReleasePoller(id, type)` per
    item, then re-batch after 30s.
  - **Periodic refresh while open**: re-call `fetchReleaseSignals`
    on a timer (5–10 min recommended) so newly-aired episodes
    surface without the user manually refreshing. The cloud serves
    this from cache; it's cheap.
- [ ] **Stacked notifications via `recent_aired`** (§6.3 also). On
      each refresh, for every signal, walk `recent_aired` and fire one
      notification per episode whose `aired_at` is newer than the
      desktop's local "last seen" record for that title. Don't fire
      based on `last_aired` alone — that field is just the most-recent
      entry; using it would collapse three new episodes into one
      notification. Update the local "last seen" timestamp to the
      latest `aired_at` you fired for, so the next refresh doesn't
      duplicate.
- [ ] **Fallback path preservation.** Keep the existing per-user
      addon probe path. Fall back to it when:
  - the cloud is unreachable / returns 5xx;
  - `releaseSearchEnabled` is `false`;
  - the user is a guest (no signed-in scope);
  - `POST /batch` returns `null` for an id (queued, not yet polled);
  - the signal's `polled_at` is older than **1 hour** vs `now`.
- [ ] **Filler / recap banner consumption** (§6.3). Read
      `episode_kinds: [{id, kind}]` from batch / single-fetch
      responses. `kind` is strictly `"filler"` or `"recap"` — there
      is no `"canon"` value. **Canon is encoded by absence**: an
      episode id missing from the list is canon. An id may appear
      twice (once `filler`, once `recap`) when AIOMetadata flagged
      both — render both banners. Cinemeta-sourced signals always
      carry an empty array; that's expected, not a bug.
- [ ] **Settings opt-in** `releaseSearchEnabled: boolean` (§6.4).
      Default `true` for signed-in users; ignored for guests
      (always fall back). Settings copy in §6.4. When false, the
      client uses only the per-user addon probe path.
- [ ] **Three new Tauri commands** in `src-tauri/src/sync.rs`
      (§6.5): `fetch_release_signal`, `fetch_release_signals`,
      `nudge_release_poller`. Reuse the existing namespace HTTP
      client. `Authorization: Aura-Sync <scope>` header is required
      on the batch + nudge commands; the single-fetch command is
      anonymous. Three-place registration per CLAUDE.md.
- [ ] **Sync chip / disconnect signal.** The existing title-bar
      chip already reflects cloud-sync disconnect for the namespace
      endpoints. Confirm it lights up on release-search failures
      too (same HTTP client → same disconnect surface). No new UI.
- [ ] **Telemetry / debug aid (optional but recommended).** Log
      one line per `fetchReleaseSignals` outcome (count of items
      sent, count cached vs `null`, latency) so it's easy to verify
      the cloud side is doing its job once the feature ships.

If a checklist item is unclear, the corresponding subsection below
gives the full detail. The cloud half guarantees the API shape, the
auth model, and the schema in §3 / §4.

### 6.1 `src/releaseSearch.ts` (new module)

Thin wrapper around the three endpoints, mirroring the shape of
`src/notifications.ts`. Exposes:

```ts
export interface ReleaseSignal { /* §3 schema */ }

export interface ReleaseSignalItem { id: string; type: "series" | "movie" }

/** Fetch one signal. Caches in-memory for 5 minutes keyed by imdbId. */
export async function fetchReleaseSignal(imdbId: string): Promise<ReleaseSignal | null>;

/** Batch fetch for library reconciliation. Chunked at 500 items per request. */
export async function fetchReleaseSignals(items: ReleaseSignalItem[]): Promise<Map<string, ReleaseSignal | null>>;

/** Nudge the poller. Fire-and-forget; don't await on UI paths. */
export function nudgeReleasePoller(imdbId: string, type?: "series" | "movie"): void;
```

`fetchReleaseSignal` should send `If-None-Match` when re-fetching the
same id within the cache TTL (the cloud returns 304 cheaply).

`fetchReleaseSignals` rejects an empty `items` array as a no-op
(returns an empty map) without making a network call.

### 6.2 Calendar / Library reconciliation

`src/views/CalendarView.tsx` and `src/libraryNormalize.ts` currently
fan out an addon probe per library item. Replace with:

1. On library load → collect `{id, type}` for every library entry →
   single `fetchReleaseSignals` call → merge `next_aired` into the
   in-memory library cache.
2. On detail-page open → `fetchReleaseSignal(id)` for the precise
   episode-kind data.
3. On manual library refresh → `nudgeReleasePoller(id, type)` per
   item, then re-batch after 30s.

Existing per-item addon probes stay as a fallback for users with
release-search disabled OR for ids the poller returns `null` for
(queued, not yet polled).

### 6.3 Filler / recap banner cache

Today the per-episode `filler` / `recap` booleans (or the locally
derived `episode_kind` value) arrive on `VideoEntry` from the addon
response on detail-page open. With the cloud signal, the most recent
14 days' worth is already in the batch response — paint banners on
Calendar and Continue-Watching surfaces without a detail-page round
trip.

The signal's `episode_kinds` list is `[{id, kind}]` where `kind` is
strictly `"filler"` or `"recap"`. An episode id missing from the list
is canon (no banner). An id may appear twice with different `kind`s if
AIOMetadata flagged both — render both banners.

Don't pre-cache OLDER episodes via the signal — those belong to the
addon's full meta response which the detail page already loads.

### 6.4 Settings opt-in

Add `releaseSearchEnabled: boolean` (default `true` for signed-in
users; ignored for guests, who fall back to the existing per-user
probe path). When false, the client uses the existing addon probing
path. Settings copy:

> **Use Aura Cloud's shared release feed**
> When on, Aura asks the cloud service whether new episodes have
> aired instead of probing addons from your machine. Faster library
> refresh and lower bandwidth, but Aura Cloud sees the imdb-ids in
> your library (it never sees streams, watch history, or your Debrid
> keys).

### 6.5 Rust side (`src-tauri/src/sync.rs`)

Add a `release_*` set of commands mirroring the existing namespace ops:

```rust
#[tauri::command]
async fn fetch_release_signal(imdb_id: String, if_none_match: Option<String>) -> Result<Option<Value>, String>;

#[tauri::command]
async fn fetch_release_signals(items: Vec<ReleaseSignalItem>) -> Result<HashMap<String, Value>, String>;

#[tauri::command]
async fn nudge_release_poller(imdb_id: String, media_type: Option<String>) -> Result<(), String>;
```

`ReleaseSignalItem` is `{ id: String, r#type: String }` with serde
renaming `r#type` → `"type"`.

Use the same HTTP client as the existing namespace handlers (the one
in `sync.rs` that handles `/sync/v1/{namespace}`). No keyring writes —
these endpoints don't carry secrets. The `Authorization: Aura-Sync`
header is required only on `fetch_release_signals` and
`nudge_release_poller`; `fetch_release_signal` is anonymous.

Three-place registration per CLAUDE.md: command handler list,
`permissions/player.toml`, `capabilities/default.json`.

## 7. Rollout sequencing

1. **Cloud ships endpoints behind `RELEASE_POLLER_ENABLED=false`.**
   Endpoints respond but the poller never picks rows up; `GET`
   returns 404 for everything. Smoke test the HTTP shape without
   loading upstream addons.
2. **Flip `RELEASE_POLLER_ENABLED=true`** on the VPS. Cache stays
   empty until the first client batch call seeds it.
3. **Desktop ships behind opt-in setting (default off).** Power
   users opt in, surface latency / accuracy bugs. Watch the cloud
   logs for `release poll … outcome=upstream-*` errors.
4. **After two weeks without regressions, flip desktop default to
   `true` for signed-in users.** The per-addon probe path stays as
   the fallback (when the cloud is unreachable, when the user opts
   out, or for ids that return `null` from `POST /batch`).
5. **Telemetry:** poller logs already give per-id poll count, latency,
   error rate via grep/awk on `docker compose logs cloud`. If volume
   warrants, add a `/release/_stats` admin endpoint later.

## 8. Failure modes

- **Cloud unreachable.** Desktop falls back to per-addon probe path
  (same code as today). Sync chip in the title bar shows the
  disconnect.
- **Poller behind.** Signal carries stale `polled_at`. Desktop compares
  against now and re-falls-back to the addon probe when stale beyond
  1 h.
- **AIOMetadata down.** Poller falls back to Cinemeta. Cinemeta does
  not emit `filler` or `recap` per video, so signals from
  Cinemeta-only probes carry an empty `episode_kinds` array. Desktop
  renders banners only for ids present in `episode_kinds`, so a
  Cinemeta-sourced signal yields no banners — but `last_aired` and
  `next_aired` are still populated, so calendar / library reconciliation
  keeps working at degraded richness.

- **AIOMetadata user config drift.** The poller uses
  `AIOMETADATA_USER_UUID` to load the canonical user config. If that
  user's config changes upstream (e.g. they re-configure providers in
  AIOMetadata's UI), the cache silently starts holding different shapes.
  Operationally: freeze the canonical user's settings, or accept that
  cache contents follow the canonical user's choices.
- **Self-hosted custom addons.** Out of scope — the poller only knows
  about the two configured base URLs. Users on private metadata
  addons remain on the client-side probe path.

## 9. Non-goals

- Stream caching, addon-auth proxying, watch-progress fan-out — all
  per-user.
- Recommendation feeds, trending lists — catalog responsibility, not
  release-detection.
- Backfilling historical episodes — the 14-day `episode_kinds`
  window is intentional. Older episodes come from the addon's full
  meta response on detail-page open.
- A new sync namespace for library ids. The "what's in my library"
  list stays on the desktop; the cloud only sees it transiently
  via `POST /batch` and doesn't persist it.

---

## 10. Future optimizations

> **Status:** §10.1 is implemented (2026-05-13). Remaining items below
> are stubs for future PRs.

### 10.1 Batch response ETag — short-circuit unchanged refreshes — **implemented**

**Motivation.** With the periodic refresh tick from §6.0 (5–10 min
recommended), the desktop re-downloads the full `/batch` response
(~1 KB × N items ≈ ~120 KB for a typical library) on every tick even
when the cache is fully warm and the response is byte-identical to
the previous one. Most ticks return the same data; we should let the
desktop short-circuit.

**Cloud side.**

1. After collecting signal rows for the request's id list, compute a
   response ETag deterministically from the id list and per-row
   etags:
   ```
   response_etag = sha256(sorted("<id>:<etag>" for each row, plus
                                  "<id>:null" for cache-miss ids))[:16]
   ```
   Both the id set and the individual signal etags are inputs, so the
   response ETag changes when (a) any returned signal changes or (b)
   the request id list changes.
2. Return `ETag: <hex>` on every 200 response.
3. If the request carries `If-None-Match: <hex>` and it equals the
   recomputed response ETag, respond `304 Not Modified` with the
   `ETag` header and no body. Skip JSON serialization entirely.
4. Log line stays one line per request; add a `cached=1` field when
   we 304:
   ```
   release method=POST path=/sync/v1/release/batch scope=h7Q4 outcome=304 items=120 cached=1
   ```

**RFC nuance.** Strict RFC 7232 says servers should return
`412 Precondition Failed` (not `304`) for `If-None-Match` on POST.
We return `304` because the desired semantic — "no changes; use last
cache" — matches `304` and most clients handle it correctly. If you'd
rather stay strict, two alternative shapes work equally well:
- Move the freshness check to a body-level signature: request carries
  `"if_signature": "<hex>"`, response is either
  `{"unchanged": true, "signature": "<hex>"}` or the full payload
  with the new signature. Cleanest semantic for POST, slightly more
  client code.
- Move batch to GET with the id list compactly encoded in a query
  param (comma-joined). HTTP semantics then naturally support
  `If-None-Match` / `304`. Hits URL-length limits past ~200 ids
  unless you split into multiple GETs.

The HTTP-convention 304-on-POST path is what's documented above; pick
a different shape if you have strong reasons.

**Desktop side.**

1. Persist the response `ETag` returned on the last successful batch
   call (in-memory alongside the signal cache is fine — no need to
   write through to disk).
2. On the next batch call with the same id list, send
   `If-None-Match: <last-etag>`.
3. On `304`, reuse the cached signals and skip the downstream
   merge / notification-diff work. Notifications should still
   re-evaluate against the latest local "last seen" state — `304`
   just means "the cloud's view is the same as last tick", not "the
   user has seen everything", so a fresh local notification pass on
   the cached data is still correct.
4. On `200`, update the stored ETag and run the normal merge flow.

If the desktop's library changes between ticks (id added/removed),
the next request's id list differs and the cloud's response ETag
differs — the desktop should expect `200` here and treat it as the
new baseline.

**Estimated impact.** For a 120-item library at a 5-min refresh tick
with no upstream changes: ~99% of ticks return `304` (headers only,
maybe ~150 bytes including TLS framing); the full ~120 KB body only
flows when something actually advanced. Net inbound bandwidth on the
desktop drops from ~17 MB/day per user to ~50 KB/day per user.

**Failure modes.**

- ETag mismatch due to a signal being mid-write while we compute the
  response. SetMaxOpenConns(1) on the SQLite handle serializes reads
  vs writes, so this race can't actually occur — the batch read sees
  one consistent snapshot of every row's etag.
- The desktop persists the wrong ETag and the cloud always 200s. Not
  a correctness issue, just no bandwidth saving. Self-heals on next
  successful round trip.
- Race where the desktop sends `If-None-Match` from a stale local
  cache it has since dropped. Cloud's 304 says "you already have
  this"; desktop has nothing to reuse. The desktop should treat 304
  as authoritative only when its local cache is still populated —
  if the cache was evicted, drop the `If-None-Match` header on the
  next call and accept a 200.

---

## Appendix A — changes from v1 draft

For reviewers comparing this to the original draft you may have
already read:

1. **Storage:** removed all Redis / KV / ZSET references. The cloud
   is SQLite-only. Schema is one new table `release_signals`.
2. **Probe path:** corrected `{id}/meta` to `/meta/{type}/{id}.json`
   (canonical Stremio addon protocol).
3. **Warm-start:** dropped. Aura Cloud has no view of user libraries;
   queue seeds from `POST /batch` instead.
4. **Config:** enumerated env vars (`AIOMETADATA_BASE_URL` required;
   `CINEMETA_BASE_URL`, `RELEASE_POLLER_*` defaulted).
5. **Rate limiter:** new dedicated `rateLimiter` instances for the
   public endpoints (IP-keyed), independent of the existing
   (scope, ip) limiter.
6. **Poller cadence:** continuous worker pool with per-row
   `next_eligible_at`, not "every 10 min scan everything."
7. **Batch payload:** items now carry `{id, type}` so the poller
   doesn't double-probe first-seen ids.
8. **Conditional GET:** `If-None-Match` / `304` support documented.
9. **"TLS pin" language:** removed. The existing HTTP client just has
   a 10s timeout; no certificate pin.
10. **CDN claim:** softened. Headers are set forward-looking; no CDN
    is in the deployment today.

Post-implementation revisions (after auditing against the live
AIOMetadata source):

11. **AIOMetadata probe URL.** The earlier draft used the canonical
    Stremio meta path `/meta/{type}/{id}.json`. AIOMetadata's actual
    route is `/stremio/:userUUID/meta/:type/:id.json` and has no
    UUID-less alias. Added required env var `AIOMETADATA_USER_UUID`
    and updated §5.2 / §5.3 to reflect the real shape.
12. **Per-episode flag fields.** The earlier draft assumed AIOMetadata
    emits a single `episodeKind` string per video. The real shape is
    two independent booleans (`filler`, `recap`). The cached
    `episode_kinds` list now carries one entry per active flag
    (canon is encoded by absence; an id can appear with both kinds
    if AIOMetadata flagged both). Updated §3 schema and §8.
13. **Explicit Aura responsibilities checklist** added at the top of
    §6 so the desktop hand-off has a single-glance summary of what
    needs to land on the client side.
14. **`recent_aired` array** added to the signal (§3). The earlier
    draft only carried `last_aired` (single most-recent), which would
    collapse multiple episodes that aired between user sessions into
    one notification. `recent_aired` carries every aired episode in
    the last 365 days (capped at 200 most-recent), so the desktop can
    stack notifications by iterating the list and firing one per
    episode newer than the user's local "last seen" state. §6.0
    checklist updated with the corresponding consumption rule.
15. **§10 Future optimizations** section added to track planned-but-
    not-yet-built work. §10.1 specifies the `/batch` response ETag
    short-circuit for unchanged refresh ticks, both the cloud-side
    mechanics and the desktop-side consumption pattern — pick it up
    when periodic-refresh bandwidth becomes a concern (estimated
    ~99% reduction in steady-state refresh traffic).
16. **§10.1 implemented (2026-05-13).** `/batch` now returns an
    `ETag` header and honors `If-None-Match` with `304 Not Modified`.
    Verified end-to-end: same id list + same per-signal etags →
    304; id list change or per-signal etag change → 200 with new
    ETag. Logs include `etag=<4-hex>` on both 200 and 304 paths.