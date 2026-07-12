// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// storyArcs — the frontend face of the Rust `arcs` module.
//
// Arcs come from TMDB's episode groups (type 5, "Story Arc") and are joined to
// Aura's real addon episode ids in Rust, by sequence alignment rather than by
// episode number. See `src-tauri/src/arc_align.rs` for why a numbering join is
// not just wrong but *silently* wrong.
//
// Everything here degrades to nothing: no TMDB key, no TMDB id, no story-arc
// grouping, or an alignment we do not trust -> `null`, and the Detail page
// simply never renders the Arcs toggle. Arcs are a progressive enhancement,
// and most of the library will not have them (arcs are a property of
// long-running manga, not of anime).
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { PersistentCache } from "./persistentCache";
import type { MetaDetail, VideoEntry } from "./types";
import { isAnimeMeta } from "./aiometadata";

export interface ArcGrouping {
  id: string;
  name: string;
  description: string;
  arc_count: number;
  episode_count: number;
}

export interface StoryArc {
  id: string;
  name: string;
  order: number;
  /** Aura video ids, in the arc's own order. A cross-season arc is flat: the
   *  season boundary is invisible and arc order wins. */
  episode_ids: string[];
  image: string | null;
  /** "fandom" | "tmdb" | "episode" | "none" — drives the attribution line. */
  image_source: string;
  year_start: number | null;
  year_end: number | null;
  /** Episodes TMDB listed for this arc that we could not map to an Aura
   *  episode. Non-zero is normal (a special TMDB promoted into the main run);
   *  it is surfaced so the UI can be honest rather than silently short. */
  dropped: number;
}

export interface ArcResult {
  grouping_id: string;
  grouping_name: string;
  /** Every viable grouping. One Piece has four: 55 fine-grained arcs, 12 broad
   *  sagas, an "official" cut, and a combo. */
  groupings: ArcGrouping[];
  arcs: StoryArc[];
  rejected: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Keyed `${seriesId}::${groupingId ?? "default"}`. 24 h because an ongoing
 *  show gains an episode weekly, and a stale arc would be missing it. */
const arcCache = new PersistentCache<ArcResult | null>({
  storageKey: "aura:story-arcs:v1",
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 60,
});

/** The user's Seasons-vs-Arcs choice, and chosen grouping, per series. Bounded
 *  so a big library cannot grow it without limit. */
const arcModeCache = new PersistentCache<{ mode: EpisodeGrouping; groupingId?: string }>({
  storageKey: "aura:arc-mode:v1",
  ttlMs: 365 * 24 * 60 * 60 * 1000,
  maxEntries: 200,
});

export type EpisodeGrouping = "seasons" | "arcs";

export function loadArcMode(seriesId: string): { mode: EpisodeGrouping; groupingId?: string } {
  return arcModeCache.get(seriesId) ?? { mode: "seasons" };
}

export function saveArcMode(seriesId: string, mode: EpisodeGrouping, groupingId?: string): void {
  arcModeCache.set(seriesId, { mode, groupingId });
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Cheap gate: false when no TMDB key is baked or stored, so the Detail page
 *  never even asks for arcs. Resolved once per session. */
let availablePromise: Promise<boolean> | null = null;
export function storyArcsAvailable(): Promise<boolean> {
  if (!availablePromise) {
    availablePromise = invoke<boolean>("story_arcs_available").catch(() => false);
  }
  return availablePromise;
}

/** The series-root IMDb id, when the show has one. Episode ids look like
 *  `tt0388629:7:1`; anime-only ids (`kitsu:12345:9`) have none, and those
 *  shows fall back to the addon's `tmdb_id`. */
function imdbRootOf(seriesId: string): string | null {
  const head = seriesId.split(":")[0] ?? "";
  return head.startsWith("tt") ? head : null;
}

export async function fetchStoryArcs(
  detail: MetaDetail,
  seriesId: string,
  groupingId?: string,
): Promise<ArcResult | null> {
  const key = `${seriesId}::${groupingId ?? "default"}`;
  const cached = arcCache.get(key);
  if (cached !== undefined) return cached;

  // Pass Aura's REAL videos. The Rust side maps arcs onto these exact ids, so
  // what comes back is directly playable — never reconstruct an episode id.
  const videos = detail.videos.map((v: VideoEntry) => ({
    id: v.id,
    season: v.season,
    episode: v.episode,
    released: v.released,
    title: v.title,
    thumbnail: v.thumbnail,
  }));

  try {
    const result = await invoke<ArcResult | null>("fetch_story_arcs", {
      tmdbId: detail.tmdb_id ?? null,
      imdbId: imdbRootOf(seriesId),
      videos,
      groupingId: groupingId ?? null,
    });
    arcCache.set(key, result ?? null);
    return result ?? null;
  } catch (e) {
    // A TMDB hiccup must never break the episode list. Do NOT cache the miss:
    // a transient 429 should not blank arcs for 24 hours.
    console.warn("[arcs] fetch failed", e);
    return null;
  }
}

/** Load arcs for an anime detail page. Returns `null` for anything that is not
 *  an anime series with arc data, which is most of the library. */
export function useStoryArcs(
  detail: MetaDetail | null,
  seriesId: string | null,
  groupingId?: string,
): { arcs: ArcResult | null; loading: boolean } {
  const [arcs, setArcs] = useState<ArcResult | null>(null);
  const [loading, setLoading] = useState(false);

  const eligible =
    !!detail &&
    !!seriesId &&
    detail.videos.length > 1 &&
    isAnimeMeta({
      media_type: detail.media_type,
      id: detail.id,
      genres: detail.genres,
      original_language: detail.original_language,
      production_countries: detail.production_countries,
    });

  useEffect(() => {
    if (!eligible || !detail || !seriesId) {
      setArcs(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      if (!(await storyArcsAvailable())) {
        if (!cancelled) {
          setArcs(null);
          setLoading(false);
        }
        return;
      }
      const result = await fetchStoryArcs(detail, seriesId, groupingId);
      if (!cancelled) {
        setArcs(result);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `detail.videos.length` rather than `detail`: a re-fetch that returns the
    // same episode count must not re-run the join, but a show that just gained
    // an episode must.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, seriesId, groupingId, detail?.videos.length, detail?.tmdb_id]);

  return { arcs, loading };
}

// ---------------------------------------------------------------------------
// Lookups used by the player surfaces
// ---------------------------------------------------------------------------

export interface ArcPosition {
  arc: StoryArc;
  index: number;
  /** True when this is the arc's final episode, i.e. finishing it crosses an
   *  arc boundary. */
  isLast: boolean;
  /** The arc that follows, when there is one. */
  next: StoryArc | null;
}

/** Where an episode sits in the arc order. `null` when the episode belongs to
 *  no arc (unaired, a special, or an episode the grouping omits). */
export function arcPositionOf(result: ArcResult | null, episodeId: string): ArcPosition | null {
  if (!result) return null;
  for (let i = 0; i < result.arcs.length; i++) {
    const arc = result.arcs[i];
    const idx = arc.episode_ids.indexOf(episodeId);
    if (idx === -1) continue;
    return {
      arc,
      index: idx,
      isLast: idx === arc.episode_ids.length - 1,
      next: result.arcs[i + 1] ?? null,
    };
  }
  return null;
}

/** `2001` or `2001-2002`. Empty string when the arc has no dated episodes. */
export function arcYearRange(arc: StoryArc): string {
  if (arc.year_start == null) return "";
  if (arc.year_end == null || arc.year_end === arc.year_start) return String(arc.year_start);
  return `${arc.year_start}-${arc.year_end}`;
}
