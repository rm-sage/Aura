// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// airing — the single "is this library series/anime currently airing?" rule,
// shared by the Airing page and the Airing-only filter so both agree.
//
// Airing = the show still has episodes coming: either the meta's episode list
// has an aired episode AND a future-dated one (airingInfo.isAiring), OR the
// release-signal cloud feed reports a scheduled next episode (next_aired) even
// before the local meta is dated (returning / between-cour shows). Movies are
// never airing.
// ---------------------------------------------------------------------------

import type { LibraryItem, MetaDetail, VideoEntry } from "./types";
import { airingInfo, nextAiringEpisode } from "./releaseCountdown";
import { getReleaseSignal } from "./releaseSignalStore";
import { libraryItemSeriesId } from "./libraryNormalize";
import { episodeIsBeforeResume } from "./LibraryContext";
import { getManualWatchedState } from "./manualWatched";
import { isAnimeMeta } from "./aiometadata";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AirWindow = "today" | "week" | "later" | "none";

/** Series / anime only — a movie can't "air". */
export function isAiringSeriesLike(item: LibraryItem): boolean {
  const t = (item.media_type ?? "").toLowerCase();
  return t === "series" || t === "anime";
}

/** Series-root imdb id that release signals are keyed under. */
function rootId(item: LibraryItem): string {
  return libraryItemSeriesId(item.id) || item.id;
}

/** THE airing predicate. `detail` optional: with it we use the exact episode
 *  list; without it we fall back to the cloud `next_aired` signal only. */
export function isAiring(item: LibraryItem, detail?: MetaDetail | null): boolean {
  if (!isAiringSeriesLike(item)) return false;
  if (detail?.videos && airingInfo(detail.videos).isAiring) return true;
  return getReleaseSignal(rootId(item))?.next_aired != null;
}

/** Ms of the next upcoming episode (meta first, then cloud next_aired). */
export function airingNextMs(item: LibraryItem, detail?: MetaDetail | null): number | null {
  const metaMs = detail?.videos ? nextAiringEpisode(detail.videos)?.targetMs ?? null : null;
  if (metaMs != null) return metaMs;
  const iso = getReleaseSignal(rootId(item))?.next_aired?.aired_at;
  const cloud = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(cloud) ? cloud : null;
}

/** Ms of the most recently AIRED episode (meta first, then cloud last_aired). */
export function airingLastAiredMs(item: LibraryItem, detail?: MetaDetail | null): number | null {
  const now = Date.now();
  let best = -Infinity;
  for (const v of detail?.videos ?? []) {
    const t = v.released ? Date.parse(v.released) : NaN;
    if (Number.isFinite(t) && t <= now && t > best) best = t;
  }
  if (best > -Infinity) return best;
  const iso = getReleaseSignal(rootId(item))?.last_aired?.aired_at;
  const cloud = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(cloud) ? cloud : null;
}

/** Bucket the next-air ms into the page's air-window groups. `none` covers a
 *  cloud-returning show with no concrete next date yet. */
export function airWindow(ms: number | null, now: number = Date.now()): AirWindow {
  if (ms == null) return "none";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + DAY_MS;
  if (ms < endOfToday) return "today";
  if (ms < startOfToday.getTime() + 7 * DAY_MS) return "week";
  return "later";
}

/** Pure "episodes behind the latest aired" count for the airing sort, given the
 *  resume pointer directly. Mirrors LibraryContext.useEpisodesBehind's counting
 *  (which the per-tile badge uses) so the sort and the badge agree. Returns null
 *  when not airing, nothing is behind, or the series isn't being watched here. */
export function episodesBehind(
  videos: VideoEntry[] | undefined,
  resumeId: string | null,
  now: number = Date.now(),
): number | null {
  if (!videos || videos.length === 0) return null;
  const info = airingInfo(videos, now);
  if (!info.isAiring) return null;
  let watchedAired = 0;
  for (const v of videos) {
    const t = v.released ? Date.parse(v.released) : NaN;
    if (!Number.isFinite(t) || t > now) continue;
    if (getManualWatchedState(v.id) === "watched") { watchedAired += 1; continue; }
    if (resumeId && v.id !== resumeId && episodeIsBeforeResume(v.id, resumeId)) watchedAired += 1;
  }
  const behind = Math.max(0, info.airedCount - watchedAired);
  if (watchedAired === 0 && !resumeId) return null;
  return behind > 0 ? behind : null;
}

/** Anime vs live-action, using the item's stored genres plus any detail
 *  signals (original language / production countries) when a MetaDetail is on
 *  hand. Mirrors LibraryView's bucket check so the page + pills agree. */
export function isAnimeItem(item: LibraryItem, detail?: MetaDetail | null): boolean {
  const stateGenres = (item.state ?? {}).genres;
  const genres = Array.isArray(stateGenres)
    ? stateGenres.filter((g): g is string => typeof g === "string")
    : (detail?.genres ?? null);
  return isAnimeMeta({
    media_type: item.media_type,
    id: item.id,
    genres,
    original_language: detail?.original_language ?? null,
    production_countries: detail?.production_countries ?? null,
  });
}
