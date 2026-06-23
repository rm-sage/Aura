// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// autoAdvance.ts ──────────────────────────────────────────────────────────
//
// Aired-only series-completion logic plus a recheck path that un-marks a
// "watched" series when new episodes air.
//
// NOTE: this module used to ALSO auto-promote the next episode to
// "in-progress" after you watched one (and bump the first new aired episode of
// a finished series). That painted a yellow Continue-Watching marker on
// episodes that were never actually started, so the auto-promotion was removed.
// The "in-progress" overlay is now reserved for episodes with a genuine saved
// resume position, or set by hand via the episode right-click "Mark as In
// Progress". CW membership and new-episode resurface do not depend on it: they
// run off the Stremio library state.timeOffset and the series "watched" flag.
//
// Fires from two places:
//   1. useScrobble — when playback crosses the completion threshold.
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
// series back out of "watched" so it returns to Continue Watching (via its
// preserved state.timeOffset). Called by DetailView whenever a
// freshly-fetched meta-detail comes in.
// ---------------------------------------------------------------------------

import type { AddonEntry, MetaDetail, VideoEntry } from "./types";
import { getRichestMetaDetail, peekRichestCachedDetailById } from "./metaCache";
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

/** True when ANY episode is still upcoming — a parseable FUTURE air date.
 *  A show with episodes yet to air is "caught up", NOT complete: the
 *  series-root "watched" mark (which removes it from Continue Watching)
 *  must wait until the finale has aired AND been watched with nothing
 *  further scheduled. Undated entries count as aired (same rule as
 *  isEpisodeAired), so a permanent "TBA" stub can't pin a finished show
 *  to CW forever. */
function hasFutureEpisode(sorted: VideoEntry[], now = Date.now()): boolean {
  return sorted.some((v) => !isEpisodeAired(v, now));
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

  // Richest detail (most videos) — prefer DetailView's cached full episode
  // list, else fetch the richest across addons. A leaner list (an addon
  // that lists only AIRED episodes) would hide the upcoming episodes and
  // make this mark the series complete on catch-up, dropping it from CW.
  const detail =
    peekRichestCachedDetailById(seriesId) ??
    (await getRichestMetaDetail(addons, mediaType, seriesId));
  if (!detail || !detail.videos || detail.videos.length === 0) return;

  const sorted = sortedEpisodes(detail);
  const idx = sorted.findIndex((v) => v.id === episodeId);
  if (idx < 0) return;

  // Series-completion check fires on EVERY advance, not just when the
  // sorted-last episode is watched. The user can mark non-contiguous
  // episodes (e.g. catching up by skipping around) — once every aired
  // episode lands, the series should flip to watched regardless of
  // which one they just finished.
  // Series-completion fires only when the FINALE is watched AND nothing
  // further is scheduled. A still-airing show (any upcoming future-dated
  // episode) is "caught up", not complete — marking the series-root
  // watched here would drop it from Continue Watching the moment the user
  // finishes the latest AIRED episode, even though more is coming. Gate on
  // "no future episode" so caught-up series stay in CW until their actual
  // finale airs and is watched.
  if (allAiredEpisodesWatched(sorted) && !hasFutureEpisode(sorted)) {
    if (getManualWatchedState(seriesId) !== "watched") {
      setManualWatchedState(seriesId, "watched");
    }
    return;
  }

  // Not complete: we deliberately do NOT auto-promote the next episode to
  // "in-progress" anymore. That painted a yellow Continue-Watching marker on an
  // episode the user never actually started. The series stays in CW via its
  // library state.timeOffset, and the amber resume marker is reserved for an
  // episode with a genuine saved resume position (CinemaRows resumeActive).
  // Manual right-click "Mark as In Progress" remains the only way to set that
  // overlay by hand.
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

  // Completion invariant: a series is "watched" only when the finale has
  // aired AND nothing further is scheduled. If upcoming episodes still
  // exist the show is "caught up", not complete — un-mark it so it returns
  // to Continue Watching (the state.timeOffset from the last watch is
  // intact). No auto-bump: the user follows airing shows from CW and wants
  // it there while waiting for the next episode. This also self-heals any
  // series an earlier build wrongly marked complete on catch-up.
  if (hasFutureEpisode(sorted)) {
    setManualWatchedState(seriesId, null);
    return;
  }

  // No upcoming episodes, but a NEW episode aired since the last watch
  // (some aired episode is now unwatched). If none exist the series
  // remains correctly watched.
  const firstUnwatchedAired = sorted.find(
    (v) => isEpisodeAired(v) && getManualWatchedState(v.id) !== "watched",
  );
  if (!firstUnwatchedAired) return;

  // New episode aired on a show that was previously fully watched.
  // Unmark the series so it returns to Continue Watching (its
  // state.timeOffset from the last watch is intact). Also tag the series
  // as auto-bumped so the CW row doesn't suddenly add it back the moment
  // it un-marks; the flag clears when the user actually engages with the
  // show again — playing an episode, manually re-marking, or marking the
  // new ep watched. We no longer bump the new episode to "in-progress":
  // that overlay is reserved for a genuine saved resume position. The
  // `firstUnwatchedAired` lookup above is kept purely as the guard that
  // decides whether a new aired episode exists at all.
  setManualWatchedState(seriesId, null);
  markAutoBumped(seriesId);
}
