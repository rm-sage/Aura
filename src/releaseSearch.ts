// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Release-search client (Aura Cloud Phase 9)
//
// Thin wrapper around the three Tauri commands (`fetch_release_signal`,
// `fetch_release_signals`, `nudge_release_poller`) that hit
// `aura.animasec.dev/sync/v1/release/`. Cloud-side design in
// docs/release-search-spec.md; desktop responsibilities live in §6.
//
// Why this lives separate from sync.ts: this module's traffic is keyed
// per-imdb-id rather than per-namespace, doesn't carry merge semantics,
// and doesn't write to localStorage — keeping the two concerns apart
// avoids accidentally tangling a stream-side cache fix with the
// release-signal cache.
//
// Caching:
//   • `fetchReleaseSignal` keeps a 5-minute in-memory cache per
//     imdb-id. Re-fetch within the TTL sends `If-None-Match` so the
//     cloud can answer 304 without re-serializing the payload.
//   • `fetchReleaseSignals` is a one-shot batch fetcher (no
//     per-call cache) — the caller usually does its own merge into
//     library state. We DO chunk requests at 500 items so the cloud
//     (which caps body size at 64 KiB) accepts payloads from users
//     with multi-thousand-item libraries.
//   • `nudgeReleasePoller` is fire-and-forget.
//
// Telemetry: every batch call logs a single console.info line
// (item count, signals/null counts, latency) so the cloud half can
// be observed from DevConsole without instrumenting further.
// ---------------------------------------------------------------------------

export type ReleaseMediaType = "series" | "movie";

/** Wire shape per §3 of the spec. Optional fields are explicit so the
 *  desktop code can branch on presence without nullable juggling. */
export interface ReleaseSignal {
  imdb_id: string;
  media_type: ReleaseMediaType;
  last_aired: ReleaseAired | null;
  next_aired: ReleaseAired | null;
  /** Every episode whose `aired_at` is in the last 365 days, sorted
   *  ascending by `aired_at`, capped at 200 most-recent. The
   *  notification source per §3 — desktop iterates this list and
   *  fires one notification per episode newer than its local
   *  "last seen" record, so multiple between-session aired episodes
   *  surface (instead of being collapsed into one via `last_aired`
   *  alone). Empty array for movies. */
  recent_aired: ReleaseAired[];
  /** Per-episode classification within ±14 days of `polled_at`. Empty
   *  for Cinemeta-sourced signals (Cinemeta doesn't carry
   *  filler/recap). An id can appear twice with different `kind`s when
   *  AIOMetadata flagged both — the caller should render both banners. */
  episode_kinds: ReleaseEpisodeKind[];
  /** ISO-8601 UTC. Used by the caller's staleness gate (per §6 fallback
   *  rule: ids whose `polled_at` is older than 1 h re-fall-back to the
   *  per-user addon probe path). */
  polled_at: string;
  /** Server-supplied 16-hex strong validator. Send back as
   *  `If-None-Match` on the next conditional fetch. */
  etag: string;
}

export interface ReleaseAired {
  season: number | null;
  episode: number | null;
  absolute_episode?: number;
  aired_at: string;
  id: string;
}

export interface ReleaseEpisodeKind {
  id: string;
  /** Strict enum: only `"filler"` and `"recap"` are emitted by the
   *  cloud. Canon is encoded by absence. */
  kind: "filler" | "recap";
}

export interface ReleaseSignalItem {
  id: string;
  type: ReleaseMediaType;
}

// ── Single-fetch cache ──────────────────────────────────────────────────
// Five-minute TTL per §6.1. Stored as `{ signal, etag, fetchedAt }` so
// the conditional-fetch path can lift `etag` without parsing the
// payload, and stale-entry eviction can read `fetchedAt` without an
// extra index. `signal: null` is a valid cached value — means the
// cloud responded 404 (id not yet polled) and we shouldn't re-hit
// immediately.
interface SingleFetchEntry {
  signal: ReleaseSignal | null;
  etag: string | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const singleFetchCache = new Map<string, SingleFetchEntry>();

/** Helper — strip stale entries lazily. Called on every read so the
 *  cache doesn't grow unboundedly with imdb-ids that never re-fetch. */
function getCachedSingle(imdbId: string): SingleFetchEntry | null {
  const entry = singleFetchCache.get(imdbId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    singleFetchCache.delete(imdbId);
    return null;
  }
  return entry;
}

/** Drop one id from the cache. Useful after `nudgeReleasePoller` —
 *  the user expects the next fetch to see fresh data. */
export function invalidateReleaseSignal(imdbId: string): void {
  singleFetchCache.delete(imdbId);
}

/** Drop the entire single-fetch cache AND the batch-etag cache.
 *  Called from sync.ts on session change so signals from a prior
 *  account don't leak. The batch cache also has to drop because the
 *  prior account's etag is invalid for the new scope (cloud computes
 *  the etag over signal data scoped to the auth header). */
export function clearReleaseSignalCache(): void {
  singleFetchCache.clear();
  batchEtagCache.clear();
}

/**
 * Fetch one signal. Cached for 5 minutes per imdb-id.
 *
 * Cache + conditional-fetch flow:
 *   1. Fresh cache (within TTL) → return the cached signal (or null
 *      if the prior fetch was 404).
 *   2. Expired cache with a remembered etag → send `If-None-Match`;
 *      304 means "use cached" so we refresh `fetchedAt` and return
 *      the prior signal unchanged.
 *   3. No cache → unconditional fetch.
 *
 * Returns `null` when the cloud has no record for the id (404 — id
 * not yet polled). Callers should treat that as "fall back to the
 * per-user addon probe for this id" per §6's fallback rules.
 *
 * Errors bubble up; the caller is responsible for surfacing them and
 * (typically) falling back to addon probes.
 */
export async function fetchReleaseSignal(imdbId: string): Promise<ReleaseSignal | null> {
  if (!imdbId) return null;
  const cached = getCachedSingle(imdbId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.signal;
  }
  const ifNoneMatch = cached?.etag ?? null;
  try {
    const result = await invoke<ReleaseSignal | null>("fetch_release_signal", {
      imdbId,
      ifNoneMatch,
    });
    // The Rust side returns `Some(value)` on 200 with body, `None` on
    // both 304 (use cached) and 404 (no record). We distinguish via
    // the prior cache state: had cache + None → 304 reuse; no cache +
    // None → 404, store the null so we don't re-hit for 5 min.
    if (result === null) {
      if (cached) {
        cached.fetchedAt = Date.now();
        return cached.signal;
      }
      singleFetchCache.set(imdbId, {
        signal: null,
        etag: null,
        fetchedAt: Date.now(),
      });
      return null;
    }
    singleFetchCache.set(imdbId, {
      signal: result,
      etag: result.etag ?? null,
      fetchedAt: Date.now(),
    });
    return result;
  } catch (err) {
    // Surface caller-side so the calling code can fall back. Don't
    // poison the cache with a network blip — next call retries.
    console.warn(`[release-search] fetchReleaseSignal(${imdbId}) failed: ${String(err)}`);
    throw err;
  }
}

const BATCH_MAX_ITEMS = 500;

// ── Batch-response ETag cache ───────────────────────────────────────
// Per spec §10.1: the cloud computes a response ETag from the sorted
// id list + per-row etags. The desktop persists the last response
// ETag keyed by the SAME sorted id list, then sends it as
// `If-None-Match` on the next call with the same list. On 304 the
// cloud returns empty body — we reuse the cached `signals` map
// without re-decoding the (potentially ~100 KB) payload.
//
// Cache lives in-memory only (no localStorage persistence). On app
// restart the first batch round-trips the full payload; subsequent
// ticks reuse the etag. This matches the spec's "in-memory alongside
// the signal cache is fine" guidance.
interface BatchCacheEntry {
  etag: string;
  // The actual decoded signal map. On 304 we return this verbatim
  // (per the spec, the etag matching means nothing changed). If the
  // local cache was evicted between calls, we drop `If-None-Match`
  // on the next call and accept a 200 — handled in `runBatchChunk`.
  signals: Map<string, ReleaseSignal | null>;
}
const batchEtagCache = new Map<string, BatchCacheEntry>();

/** Build a stable cache key from a chunk's id list. Order matters
 *  for the cloud's etag hash (it sorts before hashing), so we sort
 *  the same way locally — that lets a re-fetch with the items
 *  shuffled still hit the cache. */
function batchCacheKey(chunk: ReleaseSignalItem[]): string {
  return chunk
    .map((it) => `${it.id}:${it.type}`)
    .sort()
    .join(",");
}

interface BatchChunkOutcome {
  signals: Map<string, ReleaseSignal | null>;
  cached304: boolean;
}

async function runBatchChunk(chunk: ReleaseSignalItem[]): Promise<BatchChunkOutcome> {
  const cacheKey = batchCacheKey(chunk);
  const cached = batchEtagCache.get(cacheKey);
  const ifNoneMatch = cached?.etag ?? null;
  const result = await invoke<{
    etag: string | null;
    signals: Record<string, ReleaseSignal | null> | null;
  }>("fetch_release_signals", { items: chunk, ifNoneMatch });

  // 304 short-circuit — cloud returned no body, just an etag.
  // Reuse the prior decode if we still have it. If the in-memory
  // cache was evicted (which shouldn't happen since we only purge
  // on session swap), fall back to issuing a fresh request without
  // the If-None-Match header.
  if (result.signals === null) {
    if (cached) {
      return { signals: cached.signals, cached304: true };
    }
    // Cache miss with 304 — pathological. Drop the etag and retry
    // unconditionally. Defensive; in practice the cache always has
    // the matching entry because we only evict on session swap.
    const fresh = await invoke<{
      etag: string | null;
      signals: Record<string, ReleaseSignal | null> | null;
    }>("fetch_release_signals", { items: chunk, ifNoneMatch: null });
    if (fresh.signals == null) {
      // Cloud insists on 304 even with no If-None-Match — surface
      // an empty map rather than throw.
      return { signals: new Map(), cached304: false };
    }
    const map = new Map<string, ReleaseSignal | null>();
    for (const it of chunk) map.set(it.id, fresh.signals[it.id] ?? null);
    if (fresh.etag) batchEtagCache.set(cacheKey, { etag: fresh.etag, signals: map });
    return { signals: map, cached304: false };
  }

  // 200 — fresh data. Decode into a Map + persist the new etag.
  const map = new Map<string, ReleaseSignal | null>();
  for (const it of chunk) map.set(it.id, result.signals[it.id] ?? null);
  if (result.etag) {
    batchEtagCache.set(cacheKey, { etag: result.etag, signals: map });
  } else {
    // No etag header — older cloud build? Don't cache; force a
    // full-body refresh on the next tick.
    batchEtagCache.delete(cacheKey);
  }
  return { signals: map, cached304: false };
}

/** Batch-fetch signals for many ids. Chunks at 500 items per call so
 *  large libraries don't hit the cloud's 64 KiB body cap. Returns a
 *  Map keyed by imdb_id — entries with `null` value mean "queued, no
 *  signal yet" per the spec; the caller should fall back to the addon
 *  probe path for those.
 *
 *  Empty input returns an empty map without making a network call
 *  (cheap guard the cloud doesn't have to enforce).
 *
 *  Conditional-fetch behaviour (spec §10.1): on a repeated call with
 *  the same chunk id list, the cloud returns 304 + an unchanged
 *  ETag header. We reuse the cached `signals` map without
 *  re-decoding the body — the typical refresh tick goes from a
 *  ~100 KB JSON payload to ~150 bytes of headers. The
 *  `cached304=true` flag in the chunk outcome bubbles up to the
 *  per-batch log line so it's easy to verify the cache is working
 *  in DevConsole. */
export async function fetchReleaseSignals(
  items: ReleaseSignalItem[],
): Promise<Map<string, ReleaseSignal | null>> {
  const out = new Map<string, ReleaseSignal | null>();
  if (items.length === 0) return out;
  const t0 = performance.now();
  let cachedCount = 0;
  let nullCount = 0;
  let chunk304Count = 0;
  let chunk200Count = 0;
  // Outbound list — start with everything, then trim ids we already
  // have a fresh single-fetch cache for. The cloud bills us per
  // item-bytes so sending less is friendlier; on the desktop side it
  // also means the response is smaller to parse.
  const outbound: ReleaseSignalItem[] = [];
  for (const it of items) {
    const c = getCachedSingle(it.id);
    if (c) {
      out.set(it.id, c.signal);
      if (c.signal == null) nullCount += 1;
      cachedCount += 1;
    } else {
      outbound.push(it);
    }
  }
  // Chunk + dispatch.
  for (let i = 0; i < outbound.length; i += BATCH_MAX_ITEMS) {
    const chunk = outbound.slice(i, i + BATCH_MAX_ITEMS);
    try {
      const { signals, cached304 } = await runBatchChunk(chunk);
      if (cached304) chunk304Count += 1;
      else chunk200Count += 1;
      for (const it of chunk) {
        const sig = signals.get(it.id) ?? null;
        out.set(it.id, sig);
        // Seed the single-fetch cache so a follow-up
        // fetchReleaseSignal hits the warm path.
        singleFetchCache.set(it.id, {
          signal: sig,
          etag: sig?.etag ?? null,
          fetchedAt: Date.now(),
        });
        if (sig == null) nullCount += 1;
      }
    } catch (err) {
      console.warn(
        `[release-search] fetchReleaseSignals chunk ${i / BATCH_MAX_ITEMS} failed: ${String(err)}`,
      );
      // Don't throw — partial success is more useful than total
      // failure. Per-id missing entries become "fall back to addon
      // probe" at the call site.
      for (const it of chunk) {
        if (!out.has(it.id)) out.set(it.id, null);
      }
    }
  }
  const ms = Math.round(performance.now() - t0);
  console.info(
    `[release-search] batch n=${items.length} cached=${cachedCount} ` +
    `null=${nullCount} resolved=${items.length - cachedCount - nullCount} ` +
    `chunks=${chunk200Count}+${chunk304Count}(304) latency=${ms}ms`,
  );
  return out;
}

/** Fire-and-forget poke to the cloud's release poller. Used by the
 *  manual-refresh path so the user's freshly-airing episodes get
 *  re-probed within the next 5 s dispatcher tick instead of waiting
 *  for the normal 1 h cadence. Don't await on UI paths — the cloud
 *  responds 202 immediately. Errors are logged but never thrown.
 *
 *  Also invalidates the single-fetch cache entry so the next
 *  `fetchReleaseSignal` call doesn't return the stale pre-nudge
 *  value. */
export function nudgeReleasePoller(imdbId: string, type?: ReleaseMediaType): void {
  if (!imdbId) return;
  invalidateReleaseSignal(imdbId);
  void invoke<void>("nudge_release_poller", { imdbId, mediaType: type ?? null })
    .catch((err) => {
      console.warn(`[release-search] nudgeReleasePoller(${imdbId}) failed: ${String(err)}`);
    });
}

/** True when the signal's `polled_at` is more than 1 hour older than
 *  `now`. Per §6 fallback rules, such ids should be addon-probed
 *  instead of trusting the cloud's stale view. */
export function isSignalStale(signal: ReleaseSignal | null, nowMs: number = Date.now()): boolean {
  if (!signal?.polled_at) return false;
  const polled = Date.parse(signal.polled_at);
  if (!Number.isFinite(polled)) return false;
  return nowMs - polled > 60 * 60 * 1000;
}
