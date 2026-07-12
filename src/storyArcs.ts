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
 *  never even asks for arcs. Memoised per session, but INVALIDATED when the user
 *  changes an API key: without that, pasting a TMDB key into Settings would do
 *  nothing at all until the next app launch (the memo would keep answering
 *  "false"), and even then nothing for 24 hours (the arc cache would keep
 *  serving the `null` recorded while the key was missing). */
let availablePromise: Promise<boolean> | null = null;
export function storyArcsAvailable(): Promise<boolean> {
  if (!availablePromise) {
    availablePromise = invoke<boolean>("story_arcs_available").catch(() => false);
  }
  return availablePromise;
}

if (typeof window !== "undefined") {
  window.addEventListener("aura:api-keys-changed", () => {
    availablePromise = null;
    arcCache.clear();
  });
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

// ---------------------------------------------------------------------------
// Grouping display order + default
//
// The backend returns groupings sorted by an internal score, which puts
// whatever it liked best first. The UI wants a STABLE, meaningful order that a
// user can build a habit around: the broad view first, the fine-grained view
// next, the mashups last. That is a general rule keyed on the grouping NAME, not
// a One Piece special case: any show whose TMDB episode groups are named
// "... Sagas" gets the coarse view first, anything named "combo"/"combined"
// sinks to the end, and everything else keeps the backend's relative order in
// the middle. A show with no saga-ish grouping simply starts at its first
// grouping, which is what happens today.
// ---------------------------------------------------------------------------

function groupingRank(name: string): number {
  const n = name.toLowerCase();
  // COMBO IS TESTED FIRST, AND THAT ORDER IS LOAD-BEARING. One Piece's combo
  // grouping is literally named "Season, Arc & Saga Combos", so a "saga" check
  // that ran first would match it, sort it leftmost, AND make it the default
  // (the default is just the first in display order) - the exact opposite of
  // what we want.
  if (n.includes("combo") || n.includes("combined")) return 2;
  if (n.includes("saga")) return 0;
  return 1;
}

/** Sagas first, story arcs next, combos last. Stable within a rank, so the
 *  backend's own ordering still breaks ties. Never mutates the input. */
export function orderGroupings(groupings: ArcGrouping[]): ArcGrouping[] {
  return groupings
    .map((g, i) => ({ g, i }))
    .sort((a, b) => groupingRank(a.g.name) - groupingRank(b.g.name) || a.i - b.i)
    .map((e) => e.g);
}

/** The grouping to open on by default: the first one in display order, i.e. the
 *  Sagas grouping when the show has one. `undefined` for a show with no
 *  groupings (the caller then leaves the backend's own pick alone). */
export function preferredGroupingId(groupings: ArcGrouping[]): string | undefined {
  return orderGroupings(groupings)[0]?.id;
}

// ---------------------------------------------------------------------------
// Episode-number range
// ---------------------------------------------------------------------------

function epLabel(v: VideoEntry, withSeason: boolean): string {
  const ep = v.episode != null ? `E${v.episode}` : "";
  if (!withSeason || v.season == null) return ep;
  return `S${String(v.season).padStart(2, "0")}${ep}`;
}

/** Human episode range for an arc, e.g. `E890-E1085`, `S20E13-S21E194`, or the
 *  single-episode `S02E05`. Empty string when NONE of the arc's episode ids
 *  resolve against the addon's video list (an arc whose ids the addon no longer
 *  lists is rendered without a range rather than with a wrong one).
 *
 *  `videosById` is the caller's id -> VideoEntry map (the episodes panel already
 *  has the list in scope). Unresolvable ids inside the arc are skipped, so the
 *  range is always drawn from real episodes.
 *
 *  Season prefixing rule: shown when the arc crosses a season boundary, or when
 *  it sits in a season other than 1. A single-season-1 show (the long-runner
 *  case: One Piece is one 1000+ episode season) reads as a plain `E890-E1085`. */
export function arcEpisodeRange(arc: StoryArc, videosById: Map<string, VideoEntry>): string {
  let first: VideoEntry | null = null;
  let last: VideoEntry | null = null;
  for (const id of arc.episode_ids) {
    const v = videosById.get(id);
    if (!v) continue;
    if (!first) first = v;
    last = v;
  }
  if (!first || !last) return "";

  const crossesSeason = first.season != null && last.season != null && first.season !== last.season;
  const withSeason = crossesSeason || (first.season != null && first.season !== 1);

  const a = epLabel(first, withSeason);
  const b = epLabel(last, withSeason);
  if (!a && !b) return "";
  if (first.id === last.id || a === b) return a || b;
  // Same season: only the left side carries the Sxx prefix (`S02E05-E12`), so a
  // within-season range does not read as a cross-season one.
  return `${a}-${crossesSeason ? b : epLabel(last, false) || b}`;
}
