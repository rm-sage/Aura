# Aura Proxy v2 — Sync Endpoint Specification

> **Audience:** maintainer of the `aura-proxy` Go service running on the VPS at `aura.animasec.dev`.
> **Status:** spec frozen for client implementation. Server-side implementation in progress.

This document specifies what the proxy must add to enable per-account
state sync for Aura desktop. The Aura side is already wired and ships
in the next release; pushes will silently 404 until these endpoints
exist on the proxy. No client changes are needed once the proxy is up.

## 1. Scope

The proxy already handles OAuth (`/oauth/{trakt,anilist}/...`).
Phase 2 adds a parallel route group `/sync/v1/...` that stores per-
account JSON blobs. The two route groups share nothing operationally;
the OAuth flow is unchanged.

## 2. Auth model

Aura derives a per-account scope hash on the desktop:

```
scope_hash = sha256_hex(stremio_auth_key)   // 64 lowercase hex chars
```

and sends it on every sync request:

```
Authorization: Aura-Sync <scope_hash>
```

The proxy never sees the raw auth key. Anyone holding the auth key
already owns the Stremio account, so deriving sync identity from it
adds no new compromise vector. The proxy treats the hash as opaque:
no validation against Stremio's API is required (the security model
is "whoever knows the hash can read/write that scope's blobs," same
posture as Stremio itself).

**Auth middleware contract:**

- Reject when the header is missing, malformed, or not `64` lowercase hex chars: `401 Unauthorized` with body `{"error":"missing_or_invalid_auth"}`
- On success, attach `scope_hash` to the request context for use by handlers
- No CORS preflight is needed (Aura desktop sets the header directly from a Tauri webview which bypasses browser-side CORS)

## 3. Storage backend

Recommended: **SQLite** with a single table:

```sql
CREATE TABLE sync_blobs (
    scope_hash    TEXT    NOT NULL,
    namespace     TEXT    NOT NULL,
    data          BLOB    NOT NULL,           -- raw JSON bytes
    etag          TEXT    NOT NULL,           -- sha256_hex(data)[..16]
    updated_at    INTEGER NOT NULL,           -- unix seconds
    size          INTEGER NOT NULL,           -- byte length of `data`
    PRIMARY KEY (scope_hash, namespace)
);

CREATE INDEX idx_scope_updated ON sync_blobs (scope_hash, updated_at DESC);
```

This is the simplest viable shape. Postgres would also work but adds
ops overhead; sync traffic is small (a few KB per blob, low write rate)
so SQLite handles it comfortably. The migration to Postgres is cheap
if you ever need multi-instance HA: one table, one `JSONB` column,
handler logic ports verbatim.

**Required PRAGMAs at startup.** Defaults will surprise you with write
latency under concurrent reads; set both before serving traffic:

```sql
PRAGMA journal_mode = WAL;       -- readers don't block writers
PRAGMA synchronous  = NORMAL;    -- one fsync per checkpoint, not per txn
PRAGMA busy_timeout = 5000;      -- 5s to wait for the writer mutex
PRAGMA foreign_keys = ON;        -- enforce constraints if you add any
```

`journal_mode=WAL` is the load-bearing one: with the default `DELETE`
journaling, a long-running read blocks every writer (and vice versa),
which would surface as 30s+ tail latency on PUTs the moment a client
runs the GET-list during the same second.

**Backup.** Use SQLite's online backup API (`sqlite3_backup_init` /
`.backup` in the CLI) rather than `cp` of the live db file: the latter
captures a torn snapshot if a write is in flight. A nightly cron of
`sqlite3 sync.db ".backup '/var/backups/sync.db.$(date +%F)'"` is
sufficient given the write volume; rotate to keep ~14 days.

**ETag derivation:** `sha256_hex(data)[..16]` (16 lowercase hex chars). Collision risk is irrelevant for optimistic concurrency at this size.

## 4. Endpoints

All endpoints are under `/sync/v1/`. Content-Type for JSON bodies is `application/json; charset=utf-8`.

### 4.1 `GET /sync/v1/`

List every namespace this account owns. Returns 200 with:

```json
{
  "namespaces": [
    { "name": "settings",       "etag": "h7Q49xK0pL1z3M5n", "updated_at": 1715300000, "size": 4132 },
    { "name": "manual-state",   "etag": "p3K12abc4def56gh", "updated_at": 1715299876, "size": 2018 },
    { "name": "anilist-id-map", "etag": "z9R7q8sT2v0Y4j6K", "updated_at": 1715210000, "size":  956 }
  ],
  "total_size": 7106,
  "quota": 10485760
}
```

If the scope has no blobs, return 200 with empty `namespaces: []` (NOT 404). Aura uses this on the Settings → Cloud Sync panel to render "Connected, nothing synced yet" instead of an error.

### 4.2 `GET /sync/v1/{namespace}`

Return the stored blob plus its metadata:

```json
{
  "data": { ... },
  "etag": "h7Q49xK0pL1z3M5n",
  "updated_at": 1715300000
}
```

- 200 on success
- 404 when the namespace doesn't exist for this scope (NOT 200 with null data)
- 400 when `namespace` isn't in the allowed list (see §5)

### 4.3 `PUT /sync/v1/{namespace}`

Write a blob. Body is the JSON value to store; Content-Type must be `application/json`. Optional `If-Match: <etag>` header for optimistic concurrency.

**Success:** 200 with:

```json
{ "etag": "h7Q49xK0pL1z3M5n", "updated_at": 1715300000 }
```

**Conflict (412 Precondition Failed):** when `If-Match` is present and the stored ETag differs. Body MUST include the current server blob so the client can merge without a separate GET round-trip:

```json
{
  "error": "etag_mismatch",
  "current": {
    "data": { ... },
    "etag": "newEtagHex",
    "updated_at": 1715301234
  }
}
```

**Body too large (413):** single-blob limit is 1 MB. Body:

```json
{ "error": "blob_too_large", "max_bytes": 1048576 }
```

**Quota exceeded (413):** total per-account is 10 MB. Body:

```json
{ "error": "quota_exceeded", "quota": 10485760, "would_be": 10500000 }
```

Quota check formula:

```
new_total = (sum(size for all blobs in scope) - existing_namespace_size) + new_blob_size
reject if new_total > 10 MB
```

**Bad request (400):** unknown namespace OR malformed JSON body.

### 4.4 `DELETE /sync/v1/{namespace}`

Drop the blob. Idempotent. 204 whether or not it existed. 400 on unknown namespace.

### 4.5 `POST /sync/v1/_purge`

Drop every blob owned by the requesting scope. Used by Aura's "Clear cloud sync data" privacy action. 204 on success. No body in the response.

This endpoint MUST validate the auth header same as the others (a missing or wrong hash returns 401). There's no confirmation step on the proxy side; the Aura UI handles user confirmation before calling.

## 5. Allowed namespaces

The proxy MUST whitelist the namespace name on every request. Current set:

```
settings
manual-state
auto-bumped
notifications
recent-searches
title-state
anilist-id-map
```

Anything else returns `400 Bad Request` with body `{"error":"unknown_namespace","name":"..."}`. Adding a new namespace is intentionally a two-place change (proxy + `sync.rs`) so a typo can't accidentally create stray blobs.

The proxy does NOT validate the SHAPE of the JSON inside each blob. The desktop handles its own schema migration; the proxy is byte-transparent.

## 6. Rate limiting

Token bucket per `(scope_hash, remote_addr)`:

- 60 requests per minute, refilled smoothly (1 token per second)
- Burst capacity: 60 tokens
- 429 response with `Retry-After: <seconds>` header and body `{"error":"rate_limited","retry_after":<seconds>}`

The desktop does not retry 429 automatically. The user sees a Settings panel warning and can manually re-pull later.

## 7. Garbage collection

Nightly cron sweep:

```sql
DELETE FROM sync_blobs
 WHERE scope_hash IN (
   SELECT scope_hash FROM sync_blobs
   GROUP BY scope_hash
   HAVING MAX(updated_at) < strftime('%s','now') - 365*86400
 );
```

A scope whose most-recent write is older than 365 days has stopped using Aura with that account; reclaim the storage.

## 8. Logging

Per request, log:

```
sync provider=v1 method=PUT namespace=settings scope=h7Q4… outcome=200 size=4132 etag=h7Q4…
```

`scope` is the FIRST 4 chars of the scope hash, never the full hash. The full hash isn't a secret per se (it's not the auth_key) but truncating prevents log scrapers from reconstructing per-account activity timelines.

The body contents (the actual blob JSON) MUST NEVER be logged. Settings blobs include the user's encrypted OpenSubtitles API key.

## 9. CORS

Not required. Aura desktop is a Tauri app and bypasses browser CORS. If a future web client appears, add an explicit allowlist for it then.

## 10. TLS

Already in place via the existing OAuth deployment (Let's Encrypt or whatever cert is on `aura.animasec.dev`). The desktop client builds its reqwest client with `https_only(true)`; HTTP requests will fail at the client layer.

## 11. Implementation checklist

- [ ] Add `sync_blobs` table to the SQLite database (or whatever storage layer is in use)
- [ ] Add `Authorization: Aura-Sync <hex>` parsing middleware
- [ ] Add the 5 route handlers under `/sync/v1/`
- [ ] Add the 1 MB / 10 MB quota enforcement on PUT
- [ ] Add the namespace allowlist (reject unknown names)
- [ ] Add the rate limiter (60 req/min per scope+IP)
- [ ] Add the nightly GC sweep
- [ ] Smoke test: GET / on a fresh scope returns empty list; PUT settings; GET settings returns the blob; PUT with stale If-Match returns 412 with current; DELETE; PUT 1 MB blob succeeds; PUT 1 MB + 1 byte returns 413
- [ ] Update the proxy's README/CHANGELOG to describe the new endpoints

## 12. Out of scope (do not implement)

- Bulk endpoints (no `/sync/v1/_pull_all` on the server; the client does N parallel GETs which is simpler and cacheable independently)
- WebSocket / SSE for live cross-device sync (5-minute polling is enough for this use case)
- Per-namespace ACLs (every blob is readable and writable by the same scope hash)
- Client identification beyond the scope hash (no device tokens, no device names; the user's local cache is the source of "which device wrote last")
- Validation of the JSON shape inside any blob (the desktop handles its own schema migration)
- Per-blob encryption at rest (the Stremio auth_key the hash derives from already gates access; OS filesystem trust on the VPS is the threat boundary, same as the existing OAuth proxy)
