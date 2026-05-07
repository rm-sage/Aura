// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MetaDetail, VideoEntry } from "./types";

// ---------------------------------------------------------------------------
// Episode sorting — single source of truth, memoized per `detail` identity.
//
// The same (season, episode) sort is used by autoAdvance, nextUp, DetailView
// resume-skip logic, and a handful of other consumers. Without memoization
// each consumer paid a full N log N + N-allocation copy on every call —
// noticeable on series detail pages with 200+ episodes (One Piece, Naruto,
// long-running anime).
//
// We memoize on the `detail` object identity via a WeakMap so the sorted
// array gets garbage-collected automatically when the detail itself does.
// MetaDetail objects come back from the metaCache as fresh values per fetch,
// so identity is a clean cache key — no need for hash-based invalidation.
// ---------------------------------------------------------------------------

const sortedCache = new WeakMap<MetaDetail, VideoEntry[]>();

/** Sort by (season, episode), specials (season 0) first. Stable across all
 *  call-sites. The result is FROZEN — callers must not mutate. */
export function getSortedEpisodes(detail: MetaDetail): VideoEntry[] {
  const cached = sortedCache.get(detail);
  if (cached) return cached;
  const videos = detail.videos ?? [];
  const sorted = [...videos].sort((a, b) => {
    const sa = a.season ?? 0;
    const sb = b.season ?? 0;
    if (sa !== sb) return sa - sb;
    return (a.episode ?? 0) - (b.episode ?? 0);
  });
  Object.freeze(sorted);
  sortedCache.set(detail, sorted);
  return sorted;
}
