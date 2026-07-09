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
  // Cloud "returning" signal, gated two ways: the next episode must be genuinely
  // in the FUTURE (a stale/past next_aired can't keep an ended show airing) AND
  // must be MAIN-RUN (season != 0). An upcoming SPECIAL doesn't make a finished
  // show airing (My Hero Academia after its final season). airingInfo above is
  // already main-run-only, so the meta path agrees.
  const sig = getReleaseSignal(rootId(item))?.next_aired;
  return sig != null && sig.season !== 0 && sig.aired_at != null && Date.parse(sig.aired_at) > Date.now();
}

/** Ms of the next upcoming MAIN-RUN episode (meta first, then cloud next_aired).
 *  Specials (season 0) are excluded so the Airing sort/countdown targets a real
 *  next episode, not a lone upcoming special. */
export function airingNextMs(item: LibraryItem, detail?: MetaDetail | null): number | null {
  const metaMs = detail?.videos
    ? nextAiringEpisode(detail.videos, undefined, { mainRunOnly: true })?.targetMs ?? null
    : null;
  if (metaMs != null) return metaMs;
  const sig = getReleaseSignal(rootId(item))?.next_aired;
  const cloud = sig && sig.season !== 0 && sig.aired_at ? Date.parse(sig.aired_at) : NaN;
  // "Next" is future by definition — never surface a stale/past cloud date.
  return Number.isFinite(cloud) && cloud > Date.now() ? cloud : null;
}

/** Ms of the most recently AIRED MAIN-RUN episode (meta first, then cloud
 *  last_aired). Specials (season 0) excluded to match the airing axis. */
export function airingLastAiredMs(item: LibraryItem, detail?: MetaDetail | null): number | null {
  const now = Date.now();
  let best = -Infinity;
  for (const v of detail?.videos ?? []) {
    if (v.season === 0) continue;
    const t = v.released ? Date.parse(v.released) : NaN;
    if (Number.isFinite(t) && t <= now && t > best) best = t;
  }
  if (best > -Infinity) return best;
  const sig = getReleaseSignal(rootId(item))?.last_aired;
  const cloud = sig && sig.season !== 0 && sig.aired_at ? Date.parse(sig.aired_at) : NaN;
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
  // Main-run only: specials (season 0) are off the "behind" axis, matching
  // useEpisodesBehind (the per-tile badge) so the sort and the badge agree.
  let airedMain = 0;
  let watchedAired = 0;
  for (const v of videos) {
    if (v.season === 0) continue;
    const t = v.released ? Date.parse(v.released) : NaN;
    if (!Number.isFinite(t) || t > now) continue;
    airedMain += 1;
    if (getManualWatchedState(v.id) === "watched") { watchedAired += 1; continue; }
    if (resumeId && v.id !== resumeId && episodeIsBeforeResume(v.id, resumeId)) watchedAired += 1;
  }
  const behind = Math.max(0, airedMain - watchedAired);
  if (watchedAired === 0 && !resumeId) return null;
  return behind > 0 ? behind : null;
}

/** Anime vs live-action, using ONLY the item's stored genres (+ media_type /
 *  id) — the exact inputs LibraryView's Series/Anime bucket + itemMatchesTypeFilter
 *  use, so the Airing page's grouping and the Library pills classify a title the
 *  same way. (Detail signals would classify more IMDb anime but would disagree
 *  with the pills, which is worse.) */
export function isAnimeItem(item: LibraryItem): boolean {
  const stateGenres = (item.state ?? {}).genres;
  const genres = Array.isArray(stateGenres)
    ? stateGenres.filter((g): g is string => typeof g === "string")
    : [];
  return isAnimeMeta({ media_type: item.media_type, id: item.id, genres });
}
