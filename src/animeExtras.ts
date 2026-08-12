// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// animeExtras — data layer for the detail page's "More info" overlay.
//
// Everything here is ON DEMAND. Nothing is fetched until a human opens the
// overlay, and each tab fetches only when that tab is first opened, so a user
// who opens the panel for the score histogram never pays for a staff request.
//
// This deliberately does NOT ride `MetaDetail` / `metaCache`. That cache holds
// up to 800 entries and is read by catalog hover, Calendar, Continue Watching
// and the 30-minute notification scanner, so a histogram plus a staff list
// plus a recommendation array attached there would be multiplied by 800 and
// paid on surfaces that render none of it.
//
// COUR SCOPE
//
// A MyAnimeList entry is per-cour, not per-series. One Piece is a single entry
// carrying all 30 openings, but Frieren's second cour is a separate MAL id
// with its own theme list and its own episode numbering. `detail.mal_id` is
// the SERIES ROOT, so using it alone would silently show only cour 1's songs
// and never mention the rest. `resolveCourMalIds` walks the seasons instead
// and dedups by resolved id, which collapses One Piece's many Cinemeta
// seasons back to one entry while keeping Frieren's two apart.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { PersistentCache } from "./persistentCache";
import { dedupedInvoke } from "./invokeDedupe";
import type { MetaDetail, VideoEntry } from "./types";

// ── Wire types. Field names mirror the RUST field names, not wire names:
//    Tauri serialises outgoing structs using the Rust identifiers. ──

/** An inclusive episode span. A singleton has `start === end`. */
export interface EpisodeSpan { start: number; end: number }

export interface AnimeTheme {
  index:    number | null;
  title:    string | null;
  artist:   string | null;
  /** EMPTY MEANS UNKNOWN, never "every episode". The parser clears the whole
   *  list rather than half-trust a malformed range, so an empty array must
   *  render as "no range shown", never as a guess. */
  episodes: EpisodeSpan[];
  /** The original display string, always present. The last-resort render when
   *  title and artist both failed to parse. */
  raw:      string;
}

export interface AnimeThemes {
  openings: AnimeTheme[];
  endings:  AnimeTheme[];
}

export interface ScoreBucket { score: number; votes: number; percentage: number }

export interface AnimeStatistics {
  watching:      number;
  completed:     number;
  on_hold:       number;
  dropped:       number;
  plan_to_watch: number;
  total:         number;
  scores:        ScoreBucket[];
}

export interface AnimeFacts {
  source:       string | null;
  status:       string | null;
  rating:       string | null;
  premiered:    string | null;
  aired:        string | null;
  studios:      string[];
  producers:    string[];
  licensors:    string[];
  demographics: string[];
}

export interface AnimeCharacter {
  mal_id:       number;
  name:         string;
  image:        string | null;
  role:         string | null;
  actor:        string | null;
  actor_image:  string | null;
}

export interface StaffCredit {
  mal_id:    number;
  name:      string;
  positions: string[];
  image:     string | null;
}

export interface Recommendation {
  mal_id: number;
  title:  string;
  votes:  number;
  image:  string | null;
}

export interface AnimeTrailer {
  youtube_id: string;
  title:      string;
  url:        string;
  thumbnail:  string | null;
}

/** One cour: a MAL entry plus the label the UI groups it under. */
export interface CourRef {
  malId: number;
  /** "Season 2", or the series name when there is only one cour. */
  label: string;
}

// ── Cache ──
// One store for every tab. This data is near-static (a finished show's staff
// and songs never change; an airing show gains a cour at most quarterly), so
// the TTL is long and the cap is what actually bounds it.

type ExtrasValue =
  | AnimeThemes
  | AnimeStatistics
  | StaffCredit[]
  | AnimeCharacter[]
  | AnimeFacts
  | Recommendation[]
  | AnimeTrailer[]
  | null;

const extrasCache = new PersistentCache<ExtrasValue>({
  storageKey: "aura:anime-extras:v1",
  ttlMs:      7 * 24 * 60 * 60 * 1000,
  maxEntries: 160,
});

export type ExtrasTab =
  | "songs" | "ratings" | "staff" | "characters" | "related" | "trailers"
  | "facts";

const COMMAND_BY_TAB: Record<ExtrasTab, string> = {
  songs:    "fetch_anime_themes",
  ratings:  "fetch_anime_statistics",
  staff:    "fetch_anime_staff",
  characters: "fetch_anime_characters",
  facts:      "fetch_anime_facts",
  related:  "fetch_anime_recommendations",
  trailers: "fetch_anime_trailers",
};

/**
 * Fetch one tab's payload for one MAL entry, cached.
 *
 * `null` is a legitimate cached value meaning "this entry has none of this",
 * and it IS persisted: a show with no promo trailers should not re-probe on
 * every visit. It is distinguished from a cache miss by `has`, not by
 * truthiness, because `null` and `[]` are both falsy answers that mean
 * different things from an empty cache.
 */
export async function fetchExtras<T>(
  tab: ExtrasTab,
  malId: number,
): Promise<T | null> {
  const key = `${malId}::${tab}`;
  const cached = extrasCache.get(key);
  if (cached !== undefined) return cached as T | null;
  try {
    // Deduped so opening, closing and reopening the overlay in quick
    // succession shares one in-flight request rather than racing.
    const value = await dedupedInvoke(
      `extras:${key}`,
      () => invoke<T | null>(COMMAND_BY_TAB[tab], { malId }),
    );
    const normalised = (value ?? null) as T | null;
    extrasCache.set(key, normalised as ExtrasValue);
    return normalised;
  } catch (e) {
    // Do NOT cache a thrown error. A network blip must not pin an empty tab
    // for the next seven days.
    console.warn(`[extras] ${tab} failed for mal=${malId}: ${String(e)}`);
    return null;
  }
}

/**
 * Resolve the set of MAL entries covering a series, one per cour.
 *
 * Walks the distinct seasons present in the meta's videos and asks the same
 * season-aware resolver the player uses for AniSkip, then dedups by the
 * RESOLVED id. That dedup is what makes this cheap for long shows: One Piece
 * has many Cinemeta seasons but one MAL entry, so it collapses to a single
 * fetch, while a genuinely split-cour show keeps its entries apart.
 *
 * Falls back to `detail.mal_id` when nothing resolves, so a single-entry show
 * with no season structure still works.
 */
export async function resolveCourMalIds(
  detail: MetaDetail | null,
  videos: VideoEntry[],
  seriesName: string,
): Promise<CourRef[]> {
  const rootMal = typeof detail?.mal_id === "number" ? detail.mal_id : null;

  // Season 0 is specials and never corresponds to a MAL TV entry.
  const seasons = Array.from(
    new Set(
      videos
        .map((v) => v.season)
        .filter((s): s is number => typeof s === "number" && s > 0),
    ),
  ).sort((a, b) => a - b);

  if (seasons.length === 0) {
    return rootMal ? [{ malId: rootMal, label: seriesName }] : [];
  }

  // Same derivation the in-player AniSkip menu uses: the resolver keys Fribb
  // by (imdb, season), and a `tt`-shaped meta id IS the series imdb id.
  const seriesImdb = detail?.id?.startsWith("tt") ? detail.id.split(":")[0] : null;
  const out: CourRef[] = [];
  const seen = new Set<number>();

  // How many seasons each resolved MAL id absorbed, so a PARTIAL collapse can
  // be labelled honestly. Without this, a show whose seasons 1-3 map to one
  // entry and season 4 to another labelled the first "Season 1", which reads
  // as though seasons 2 and 3 were simply missing.
  const seasonsFor = new Map<number, number[]>();
  for (const season of seasons) {
    // One representative episode id per season is all the resolver needs.
    const sample = videos.find((v) => v.season === season);
    let resolved: number | null = null;
    try {
      const m = await invoke<number | null>("resolve_mal_for_aniskip", {
        targetId:   sample?.id ?? detail?.id ?? "",
        seriesImdb,
        season,
        title:      seriesName,
      });
      resolved = typeof m === "number" ? m : null;
    } catch {
      resolved = null;
    }
    const malId = resolved ?? (season === 1 ? rootMal : null);
    if (!malId) continue;
    seasonsFor.set(malId, [...(seasonsFor.get(malId) ?? []), season]);
    if (seen.has(malId)) continue;
    seen.add(malId);
    out.push({
      malId,
      // A show that collapses to one entry is labelled by name, not
      // "Season 1", because calling One Piece's single entry "Season 1"
      // would be actively misleading.
      label: seasons.length > 1 ? `Season ${season}` : seriesName,
    });
  }

  if (out.length === 0 && rootMal) {
    return [{ malId: rootMal, label: seriesName }];
  }
  // Relabel from what each entry ACTUALLY absorbed. One entry for the whole
  // show is named after the show; an entry spanning a contiguous span of
  // seasons says so; a single season keeps "Season N".
  if (out.length === 1) {
    out[0].label = seriesName;
  } else {
    for (const c of out) {
      const list = seasonsFor.get(c.malId) ?? [];
      if (list.length > 1) {
        c.label = `Seasons ${list[0]}-${list[list.length - 1]}`;
      }
    }
  }
  return out;
}

/** Render an episode span list as "1-47, 1000". Empty yields null, never a
 *  guess: see the note on `AnimeTheme.episodes`. */
export function formatSpans(spans: EpisodeSpan[]): string | null {
  if (!spans.length) return null;
  return spans
    .map((s) => (s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`))
    .join(", ");
}

/** The label a theme row leads with: "OP1", "ED2", or the kind alone when the
 *  source string carried no ordinal. */
export function themeLabel(kind: "op" | "ed", theme: AnimeTheme): string {
  const base = kind === "op" ? "OP" : "ED";
  return theme.index === null ? base : `${base}${theme.index}`;
}
