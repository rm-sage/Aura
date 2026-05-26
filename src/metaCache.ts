// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaDetail } from "./types";
import { dedupedInvoke } from "./invokeDedupe";

// ---------------------------------------------------------------------------
// metaCache — shared module-level cache of MetaDetail responses keyed by
// (addon URL, media_type, id). Survives component remounts AND app
// restarts (persisted to localStorage) so re-opening Aura doesn't replay
// the same HTTP round-trips we just made.
//
// The TTL is generous (24 h, same as CalendarView's local cache) because
// detail data rarely changes — release dates, runtime, cast lists. The
// CW row + Calendar + DetailView can all read through this layer; each
// caller fans out to multiple addons in fallback order, but the cache
// stamps one entry per (addon, id) so subsequent callers reusing the
// same addon get instant hits.
//
// Persistence:
//   • Cache hydrates from localStorage at module import.
//   • Writes are debounced (500 ms) so a burst of catalog meta lookups
//     turns into one localStorage write.
//   • A soft size cap drops the oldest 25 % of entries when we cross
//     1500 entries to keep the JSON blob under ~3 MB (well below the
//     browser's 5 MB quota and Aura's other localStorage tenants).
//   • Storage management UI in Settings → Storage exposes a clear
//     button keyed to `aura:meta-cache:v1` for surgical invalidation.
// ---------------------------------------------------------------------------

interface CacheEntry {
  detail: MetaDetail | null;
  ts: number;
}

/** Two-tier TTL: series and anime gain new episodes as they air, so a
 *  24-hour cache (the previous behavior) means a weekly-airing show
 *  could lag a full day behind the addon's view of "what's released".
 *  The notification scanner runs every 30 min but routes through this
 *  cache, so the TTL was the floor for "how stale can my bell be".
 *
 *  Movies are essentially immutable — title / runtime / cast almost
 *  never change post-release — so a week-long TTL keeps re-opens of
 *  the same DetailView free for the longest realistic re-engagement
 *  window without giving up correctness.
 *
 *  The chosen split: 4h for episodic, 7d for movies. */
const TTL_EPISODIC_MS = 4 * 60 * 60 * 1000;
const TTL_MOVIE_MS    = 7 * 24 * 60 * 60 * 1000;
function ttlFor(mediaType: string): number {
  const t = mediaType.toLowerCase();
  return (t === "series" || t === "anime") ? TTL_EPISODIC_MS : TTL_MOVIE_MS;
}
/** Used by the hydrate / persist pruning paths: anything older than the
 *  longest TTL is unconditionally stale regardless of media type. */
const TTL_MAX_MS = TTL_MOVIE_MS;
const STORAGE_KEY = "aura:meta-cache:v1";
const MAX_ENTRIES = 1500;
const PERSIST_DEBOUNCE_MS = 500;

const cache = new Map<string, CacheEntry>();

// Hydrate at import. Failure is silent — a corrupt or missing entry
// just leaves us with an empty cache, which is identical to a fresh
// install. Stale entries (past TTL) are dropped during hydration so
// they don't push live entries out under the size cap.
(function hydrate() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<[string, CacheEntry]>;
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [k, v] = entry;
      if (typeof k !== "string" || !v || typeof v.ts !== "number") continue;
      if (now - v.ts >= TTL_MAX_MS) continue;
      cache.set(k, v);
    }
  } catch { /* corrupt blob — start fresh */ }
})();

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}
function persistNow() {
  persistTimer = null;
  try {
    if (cache.size > MAX_ENTRIES) {
      // Evict oldest 25 %. Map preserves insertion order, but our
      // recency proxy is `ts`, so sort by ts desc and keep the top.
      const sorted = [...cache.entries()].sort((a, b) => b[1].ts - a[1].ts);
      const keep = sorted.slice(0, Math.floor(MAX_ENTRIES * 0.75));
      cache.clear();
      for (const [k, v] of keep) cache.set(k, v);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...cache.entries()]));
  } catch {
    // Quota or serialization failure — non-fatal; the in-memory cache
    // continues to function for this session.
  }
}

function cacheKey(addonUrl: string, mediaType: string, id: string): string {
  return `${addonUrl}::${mediaType}::${id}`;
}

/** Fetch meta detail through the cache. Returns null when the addon
 *  has nothing useful (`!detail.name`) — caller should treat null as a
 *  signal to try the next addon in its fallback list, not a hard
 *  error. Concurrent callers for the same key share a single
 *  in-flight request via `dedupedInvoke`. */
export async function getMetaDetail(
  addon: AddonEntry,
  mediaType: string,
  id: string,
): Promise<MetaDetail | null> {
  const key = cacheKey(addon.url, mediaType, id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlFor(mediaType)) return hit.detail;

  const fetched = await dedupedInvoke(`meta:${key}`, () =>
    invoke<MetaDetail>("fetch_meta_detail", {
      addonUrl:  addon.url,
      mediaType,
      id,
    }).catch(() => null as MetaDetail | null),
  );
  // Store BOTH success and null — caching null prevents a CW row from
  // re-firing the same dead fetch every render. The TTL aging will
  // re-attempt eventually.
  const detail = fetched && fetched.name ? fetched : null;
  cache.set(key, { detail, ts: Date.now() });
  schedulePersist();
  return detail;
}

/** Walk the addon list in priority order, returning the first detail
 *  with usable data. Mirrors DetailView's fallback chain so CW cards
 *  behave consistently when the primary addon's response is thin
 *  (no videos array etc). */
export async function getMetaDetailFallback(
  addons: AddonEntry[],
  mediaType: string,
  id: string,
): Promise<MetaDetail | null> {
  // Only query addons that actually expose the `meta` resource.
  // Search/catalog-only addons (e.g. "AI Search") otherwise get a
  // `/meta/...` round-trip on EVERY hover / CW / Calendar / detail
  // lookup and just return an empty "?" stub — pure wasted latency
  // since the loop then falls through to the real meta addon anyway.
  // Back-compat: if NO addon advertises `meta` (old addons.json that
  // predates the `resources` capture), fall back to the full list so
  // we never regress to "no metadata at all".
  const metaCapable = addons.filter((a) =>
    Array.isArray(a.resources) &&
    a.resources.some((r) => r.toLowerCase() === "meta"),
  );
  const candidates = metaCapable.length > 0 ? metaCapable : addons;
  for (const a of candidates) {
    const d = await getMetaDetail(a, mediaType, id);
    if (!d) continue;
    // For series, prefer a response with videos populated — otherwise
    // the segmented-bar caller has nothing to render.
    const isEpisodic = mediaType === "series" || mediaType === "anime";
    if (!isEpisodic) return d;
    if (d.videos && d.videos.length > 0) return d;
  }
  return null;
}

/** Synchronous best-effort peek — the freshest non-stale cached detail
 *  for an id across any addon / media type. No network and no fetch:
 *  for call sites that must stay synchronous and can only use what's
 *  already in memory (the card context menu's anime check — the hover
 *  panel / CW / Calendar usually warmed this entry first). Returns
 *  null on miss. */
export function peekCachedDetailById(id: string): MetaDetail | null {
  if (!id) return null;
  const suffix = `::${id}`;
  let best: CacheEntry | null = null;
  for (const [k, v] of cache) {
    if (!v.detail || !k.endsWith(suffix)) continue;
    const mt = k.split("::")[1] ?? "";
    if (Date.now() - v.ts >= ttlFor(mt)) continue;
    if (!best || v.ts > best.ts) best = v;
  }
  return best ? best.detail : null;
}

/** Batch-peek the freshest non-stale poster for each id in `ids`. One
 *  pass over the cache regardless of how many ids are queried, so it's
 *  safe to call against a full library (~hundreds of items) per render
 *  without quadratic blowup. Returns a Map keyed by id; ids with no
 *  cached poster are simply absent. Used by App.tsx to swap in fresh
 *  RPDB-rewritten poster URLs for library items whose stored Stremio
 *  record carries a stale (revoked-key) URL — Stremio library records
 *  freeze the poster URL at insertion time; the cache layer has the
 *  current addon view. */
export function peekFreshestPostersByIds(ids: Iterable<string>): Map<string, string> {
  const wanted = ids instanceof Set ? ids : new Set(ids);
  if (wanted.size === 0) return new Map();
  const best = new Map<string, { ts: number; poster: string }>();
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry.detail?.poster) continue;
    const parts = key.split("::");
    const mt = parts[1] ?? "";
    const id = parts[2] ?? "";
    if (!wanted.has(id)) continue;
    if (now - entry.ts >= ttlFor(mt)) continue;
    const prior = best.get(id);
    if (!prior || entry.ts > prior.ts) {
      best.set(id, { ts: entry.ts, poster: entry.detail.poster });
    }
  }
  const out = new Map<string, string>();
  for (const [id, v] of best) out.set(id, v.poster);
  return out;
}

/** Drop everything — useful as a last-resort cache buster. Wired to
 *  the Storage section in Settings via the `aura:meta-cache:v1`
 *  localStorage key, but also exposed here for "refresh metadata"
 *  actions that want to invalidate without touching localStorage. */
export function clearMetaCache(): void {
  cache.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
