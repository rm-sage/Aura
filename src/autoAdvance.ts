// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// autoAdvance.ts ──────────────────────────────────────────────────────────
//
// "Watched an episode → mark the next one as in-progress" automation,
// plus aired-only series-completion logic and a recheck path that
// un-marks a "watched" series when new episodes air.
//
// Fires from two places:
//   1. useScrobble — when playback crosses the 90 % completion threshold.
//   2. DetailView's right-click "Mark as Watched" handler — when the user
//      manually flips an episode to watched.
//
// Aired-only completion: the series-root "watched" mark requires every
// AIRED episode to be watched, not just the highest-numbered video in
// the list. Many addons (TMDB, AIOMetadata) include upcoming episodes
// in the videos array with future `released` dates; counting those
// would either prematurely mark a show "watched" (if the user finishes
// the latest aired ep) or never (if they just got pushed back).
//
// Recheck path: when an addon adds a new aired episode to a show the
// user already marked watched, `recheckSeriesWatchedFlag` flips the
// series back to in-progress and bumps the first new aired ep to
// "in-progress" so it surfaces in CW. Called by DetailView whenever a
// freshly-fetched meta-detail comes in.
//
// Only ever PROMOTES the next episode's state (null → in-progress). If the
// next episode is already watched (out-of-order viewing) or already
// in-progress (user is part-way through the next ep already), we leave it
// alone. Same for the series root: only set "watched" if it isn't already.
// ---------------------------------------------------------------------------

import type { AddonEntry, MetaDetail, VideoEntry } from "./types";
import { getMetaDetailFallback } from "./metaCache";
import {
  getManualWatchedState,
  setManualWatchedState,
} from "./manualWatched";
import { markAutoBumped } from "./autoBumped";
import { getSortedEpisodes as sortedEpisodes } from "./episodeSort";

/** True when the episode's release date is in the past (or unknown).
 *  Future-dated episodes are considered upcoming and don't count
 *  toward the all-aired-watched series gate — addons (TMDB et al.)
 *  routinely list next-week's premiere with the wired airDate, so
 *  counting it would either mark the series prematurely watched OR
 *  unmark it when an air-date slip pushed it past today.
 *
 *  Undated entries default to aired: many older shows ship without
 *  per-episode dates from some addons, and skipping them would
 *  prevent the gate from ever closing on those titles. */
function isEpisodeAired(v: VideoEntry, now = Date.now()): boolean {
  if (!v.released) return true;
  const t = Date.parse(v.released);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

/** True when every AIRED episode is marked watched. The series-root
 *  "watched" flag is gated on this, not on "is the last sorted
 *  episode watched" — which would prematurely flag a show whose
 *  upcoming episodes haven't aired yet. */
function allAiredEpisodesWatched(sorted: VideoEntry[]): boolean {
  const aired = sorted.filter((v) => isEpisodeAired(v));
  if (aired.length === 0) return false;
  return aired.every((v) => getManualWatchedState(v.id) === "watched");
}

export async function advanceWatchedAfter(
  seriesId: string,
  episodeId: string,
  mediaType: string,
  addons: AddonEntry[],
): Promise<void> {
  const t = (mediaType ?? "").toLowerCase();
  if (t !== "series" && t !== "anime") return;
  if (!seriesId || !episodeId) return;
  if (!addons || addons.length === 0) return;

  // Mark the just-completed episode as watched. The 90 % auto-advance
  // path used to skip this — only the next-episode promotion step ran,
  // so a Frieren-style "I just finished E12, why is it not marked
  // watched?" gap appeared. The manual "Mark as Watched" right-click
  // path already sets this BEFORE dispatching, so the call here is
  // idempotent for that branch.
  if (getManualWatchedState(episodeId) !== "watched") {
    setManualWatchedState(episodeId, "watched");
  }

  const detail = await getMetaDetailFallback(addons, mediaType, seriesId);
  if (!detail || !detail.videos || detail.videos.length === 0) return;

  const sorted = sortedEpisodes(detail);
  const idx = sorted.findIndex((v) => v.id === episodeId);
  if (idx < 0) return;

  // Series-completion check fires on EVERY advance, not just when the
  // sorted-last episode is watched. The user can mark non-contiguous
  // episodes (e.g. catching up by skipping around) — once every aired
  // episode lands, the series should flip to watched regardless of
  // which one they just finished.
  if (allAiredEpisodesWatched(sorted)) {
    if (getManualWatchedState(seriesId) !== "watched") {
      setManualWatchedState(seriesId, "watched");
    }
    return;
  }

  // Otherwise: promote the next AIRED episode to in-progress so it
  // shows up in CW. Walking past unaired episodes is safe — the
  // sorted list keeps them after the aired ones (future air dates
  // sort highest by season/episode in the wire data).
  for (let i = idx + 1; i < sorted.length; i += 1) {
    const v = sorted[i];
    if (!isEpisodeAired(v)) continue;
    if (getManualWatchedState(v.id) == null) {
      setManualWatchedState(v.id, "in-progress");
    }
    break;
  }
}

/** Re-check whether a series' "watched" flag is still valid given
 *  the LATEST videos array. Called from DetailView whenever a
 *  meta-detail fetch resolves — addons can grow the videos array
 *  between visits as new episodes air, and a series the user marked
 *  watched a month ago might now have un-watched episodes that have
 *  since aired.
 *
 *  Behaviour:
 *    • Series not flagged watched → no-op.
 *    • All currently-aired episodes are still watched → no-op.
 *    • Some aired episode is unwatched → unmark the series, mark the
 *      first such episode "in-progress" so it surfaces in CW. */
export function recheckSeriesWatchedFlag(
  seriesId: string,
  detail: MetaDetail | null,
): void {
  if (!detail || !detail.videos || detail.videos.length === 0) return;
  if (getManualWatchedState(seriesId) !== "watched") return;

  const sorted = sortedEpisodes(detail);
  // Find the FIRST aired-but-unwatched episode. If none exist the
  // series remains correctly watched.
  const firstUnwatchedAired = sorted.find(
    (v) => isEpisodeAired(v) && getManualWatchedState(v.id) !== "watched",
  );
  if (!firstUnwatchedAired) return;

  // New episode aired on a show that was previously fully watched.
  // Unmark the series and bump the new episode into in-progress.
  // Also tag the series as auto-bumped so the CW row doesn't
  // suddenly add it (the library may still have a non-zero
  // state.timeOffset from an earlier watch). The flag clears when
  // the user actually engages with the show again — playing an
  // episode, manually re-marking, or marking the new ep watched.
  setManualWatchedState(seriesId, null);
  markAutoBumped(seriesId);
  if (getManualWatchedState(firstUnwatchedAired.id) == null) {
    setManualWatchedState(firstUnwatchedAired.id, "in-progress");
  }
}
