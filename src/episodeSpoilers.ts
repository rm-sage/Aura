// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// episodeSpoilers — PURE, React-free replication of DetailView's anti-spoiler
// gate, so the EOS Spotlight and the in-player EpisodePanel apply byte-
// identical blur rules without re-implementing (or restructuring)
// DetailView's internals.
//
// DetailView's EpisodeRow blurs a thumbnail when:
//   loadAuraSettings().blurUnwatchedThumbnails === true  AND  the episode
//   is NOT watched, where "watched" is exactly what
//   `useWatchedVariant(video.id)` (NO mediaType arg → no series demotion)
//   resolves to "watched":
//     • manual mark "watched" wins, else
//     • `useLibraryProgress(video.id)`:
//         – direct library item → progressFromState (ratio ≥ 0.9 ⇒ watched)
//         – else series-root position-implied: an episode that precedes the
//           series record's `state.video_id` in (season, episode) order is
//           inferred fully watched (cross-season; specials are an out-of-
//           band track and never bridge).
//
// DetailView's EpisodeSynopsisSection blurs when:
//   loadAuraSettings().blurEpisodeSynopsis === true  AND  not watched  AND
//   not yet revealed (click-to-reveal latch lives in the consumer).
//
// The watched logic below is copied from LibraryContext.tsx
// (progressFromState / parseEpisodePosition / episodeIsBeforeResume /
// seriesRootFromEpisodeId) and WatchedBadge.useWatchedVariant — kept in
// lock-step deliberately. If LibraryContext's inference changes, mirror it
// here too (there is no test framework; tsc is the only gate).
// ---------------------------------------------------------------------------

import type { LibraryItem } from "./types";
import { getManualWatchedState } from "./manualWatched";

const WATCHED_RATIO = 0.9;

function progressWatched(state: { timeOffset?: number; duration?: number }): boolean {
  const off = typeof state.timeOffset === "number" ? state.timeOffset : 0;
  const dur = typeof state.duration === "number" ? state.duration : 0;
  if (dur <= 0 || off <= 0) return false;
  return Math.min(1, off / dur) >= WATCHED_RATIO;
}

/** tt0903747:1:5 → {1,5}; kitsu:12345:5 / mal:42:7 → {1,N}. null when the
 *  id isn't episode-shaped. Verbatim from LibraryContext. */
function parseEpisodePosition(id: string): { season: number; episode: number } | null {
  const parts = id.split(":");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (parts.length >= 3 && /^\d+$/.test(second) && /^\d+$/.test(last)) {
    return { season: Number(second), episode: Number(last) };
  }
  if (parts.length === 3 && /^\d+$/.test(last)) {
    return { season: 1, episode: Number(last) };
  }
  return null;
}

/** True when `epId` precedes `resumeId` in season:episode order.
 *  Specials (season 0) are an independent track — a mismatch on the
 *  season-0 axis refuses the inference. Verbatim from LibraryContext. */
function episodeIsBeforeResume(epId: string, resumeId: string): boolean {
  const a = parseEpisodePosition(epId);
  const b = parseEpisodePosition(resumeId);
  if (!a || !b) return false;
  if ((a.season === 0) !== (b.season === 0)) return false;
  if (a.season !== b.season) return a.season < b.season;
  return a.episode < b.episode;
}

/** tt0903747:1:5 → tt0903747; kitsu:12345:5 → kitsu:12345. Verbatim
 *  from LibraryContext.seriesRootFromEpisodeId. */
function seriesRootFromEpisodeId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length < 2) return null;
  if (parts[0].startsWith("tt")) return parts[0];
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}`;
  return null;
}

/**
 * Pure mirror of `useWatchedVariant(episodeId) === "watched"` with NO
 * mediaType argument (matches DetailView's EpisodeRow call — no series
 * demotion). `byId` is the same id→LibraryItem map LibraryProvider builds
 * (App passes `library` indexed, or callers can pass a Map directly).
 */
export function isEpisodeWatched(
  byId: Map<string, LibraryItem>,
  episodeId: string,
): boolean {
  if (!episodeId) return false;
  // Manual mark wins (right-click "Mark watched" / auto-advance path).
  if (getManualWatchedState(episodeId) === "watched") return true;
  // useLibraryProgress: direct entry first.
  const item = byId.get(episodeId);
  if (item) return progressWatched(item.state ?? {});
  // Position-implied via the series root's resume pointer.
  const seriesId = seriesRootFromEpisodeId(episodeId);
  if (!seriesId) return false;
  const series = byId.get(seriesId);
  if (!series) return false;
  const state = series.state ?? {};
  const resumeId = typeof state.video_id === "string" ? state.video_id : null;
  if (!resumeId || resumeId === episodeId) return false;
  return episodeIsBeforeResume(episodeId, resumeId);
}

/** DetailView EpisodeRow gate: blur the still iff the setting is on AND
 *  the episode is unwatched. (The series-art fallback for the EOS
 *  Spotlight is a separate Decision-6 rule applied by the consumer.) */
export function shouldBlurThumbnail(
  byId: Map<string, LibraryItem>,
  episodeId: string,
  blurUnwatchedThumbnails: boolean,
): boolean {
  if (!blurUnwatchedThumbnails) return false;
  return !isEpisodeWatched(byId, episodeId);
}

/** DetailView EpisodeSynopsisSection gate: blur iff the setting is on,
 *  the episode is unwatched, AND the user hasn't clicked to reveal. The
 *  `revealed` latch is owned by the consumer (per-episode id set). */
export function shouldBlurSynopsis(
  byId: Map<string, LibraryItem>,
  episodeId: string,
  blurEpisodeSynopsis: boolean,
  revealed: boolean,
): boolean {
  if (!blurEpisodeSynopsis) return false;
  if (revealed) return false;
  return !isEpisodeWatched(byId, episodeId);
}

/** Anime Songs tab: blur the EPISODE RANGE a theme song
 *  spans, never the song's title or artist. The song name is not the
 *  spoiler; "this opening only runs to episode 14" is, because it reveals
 *  where a cour or an arc boundary lands.
 *
 *  Deliberately NOT watch-aware, unlike the two gates above. A theme spans a
 *  RANGE rather than a single episode, so there is no one episode whose
 *  watched state would license revealing it, and partially revealing a list
 *  by progress would leak the boundary anyway. One click reveals one row. */
export function shouldBlurThemeRange(
  blurThemeEpisodeRanges: boolean,
  revealed: boolean,
): boolean {
  if (!blurThemeEpisodeRanges) return false;
  return !revealed;
}
