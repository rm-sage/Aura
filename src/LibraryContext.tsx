// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { LibraryItem, VideoEntry } from "./types";
import { getManualWatchedState, onManualWatchedChange, useManualWatchedVersion } from "./manualWatched";
import { airingInfo } from "./releaseCountdown";

// ---------------------------------------------------------------------------
// LibraryContext — exposes a (id) → LibraryItem lookup for components that
// want to render watched / progress indicators without manual prop-drilling.
//
// Provider lives in App.tsx wrapping the whole tree; the value is just the
// `library` array bundled with a memoised id index.
//
// `getProgress(id)` returns `{ ratio, watched, partial }` where:
//   • watched — timeOffset has reached the 90 % canonical Stremio threshold
//   • partial — has any nonzero offset under the watched threshold
//   • ratio   — 0..1 fraction of the duration (NaN-safe → 0)
//
// `id` is the canonical meta id for movies (`tt12345`) or the per-episode id
// for series (`tt12345:1:5`). Stremio writes per-episode entries when MPV
// scrobbles each episode, so episode rows are addressable directly.
// ---------------------------------------------------------------------------

export interface ProgressInfo {
  ratio: number;
  watched: boolean;
  partial: boolean;
}

interface LibraryCtxValue {
  byId: Map<string, LibraryItem>;
}

const LibraryCtx = createContext<LibraryCtxValue>({ byId: new Map() });

const WATCHED_RATIO = 0.9;

export function LibraryProvider({
  library, children,
}: { library: LibraryItem[]; children: ReactNode }) {
  // Re-index on every library change. Cheap (~few hundred items max) and
  // stable refs keep React.memo'd cards from re-rendering for free.
  const value = useMemo<LibraryCtxValue>(() => {
    const byId = new Map<string, LibraryItem>();
    for (const it of library) {
      if (it.removed) continue;
      byId.set(it.id, it);
    }
    return { byId };
  }, [library]);

  return <LibraryCtx.Provider value={value}>{children}</LibraryCtx.Provider>;
}

function progressFromState(state: { timeOffset?: number; duration?: number }): ProgressInfo | null {
  const off = typeof state.timeOffset === "number" ? state.timeOffset : 0;
  const dur = typeof state.duration === "number" ? state.duration : 0;
  if (dur <= 0 || off <= 0) return null;
  const ratio = Math.min(1, off / dur);
  return {
    ratio,
    watched: ratio >= WATCHED_RATIO,
    partial: ratio < WATCHED_RATIO,
  };
}

/** Parse the (season, episode) tuple out of a Stremio episode id.
 *  Recognises:
 *    tt0903747:1:5    → { season: 1, episode: 5 }    (IMDb)
 *    kitsu:12345:5    → { season: 1, episode: 5 }    (Kitsu — no season concept)
 *    mal:42:7         → { season: 1, episode: 7 }    (MAL)
 *    anidb:99:11      → { season: 1, episode: 11 }   (AniDB)
 *  Returns null when the id isn't an episode-shaped string. Used by the
 *  position-implied watched inference below to compare a candidate
 *  episode against the series' resume hint. */
function parseEpisodePosition(id: string): { season: number; episode: number } | null {
  const parts = id.split(":");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (parts.length >= 3 && /^\d+$/.test(second) && /^\d+$/.test(last)) {
    return { season: Number(second), episode: Number(last) };
  }
  if (parts.length === 3 && /^\d+$/.test(last)) {
    // kitsu / mal / anidb-style — no season segment, treat as season 1
    return { season: 1, episode: Number(last) };
  }
  return null;
}

/** True when `epId` precedes `resumeId` in season:episode order (i.e.
 *  `epId` should be inferred as already-watched given the resume
 *  pointer). Cross-season — `S01E05 < S03E02` returns true.
 *
 *  Specials (season 0) are an out-of-band track — they air sporadically
 *  alongside the main run, viewers often skip them entirely, and a user
 *  resuming the main series at S03E02 says NOTHING about whether they've
 *  watched the OVAs that aired between seasons. The earlier comparison
 *  (`a.season < b.season`) marked every S00E* episode as watched the
 *  moment a user resumed any S01+ episode (Frieren Specials bug). The
 *  symmetric case — a user watching only Specials — shouldn't infer the
 *  main run as watched either. Treating Specials as a separate "track"
 *  fixes both directions: if exactly ONE side is in S00, refuse to
 *  infer. Within-S00 ordering (S00E1 < S00E5) and within-main ordering
 *  still work normally. */
function episodeIsBeforeResume(epId: string, resumeId: string): boolean {
  const a = parseEpisodePosition(epId);
  const b = parseEpisodePosition(resumeId);
  if (!a || !b) return false;
  // Specials vs. main-run mismatch — refuse the inference. Specials
  // air independently and don't sit on the main "watch order" axis.
  if ((a.season === 0) !== (b.season === 0)) return false;
  if (a.season !== b.season) return a.season < b.season;
  return a.episode < b.episode;
}

/** Derive the series-root id from an episode id. Mirrors how Stremio
 *  constructs episode ids:
 *    tt0903747:1:5  → tt0903747
 *    kitsu:12345:5  → kitsu:12345
 *    mal:42:7       → mal:42
 *  Returns null when the input doesn't look like an episode id. */
function seriesRootFromEpisodeId(id: string): string | null {
  const parts = id.split(":");
  if (parts.length < 2) return null;
  // tt-style: ROOT is the leading "tt..." segment.
  if (parts[0].startsWith("tt")) return parts[0];
  // Prefix-style (kitsu/mal/anidb): ROOT is "<provider>:<seriesNum>".
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}`;
  return null;
}

/**
 * Progress for a top-level meta (movie, series root, anime root).
 *
 * For series this returns whatever the series root's last-known
 * state was — useful for "in progress" overlays on series posters.
 * For per-episode progress inside the episode list, use
 * `useEpisodeProgress(seriesId, episodeId)` instead.
 *
 * Position-implied inference: when called with an EPISODE id and
 * the library has no direct entry (Stremio doesn't store per-
 * episode rows), we fall back to the series root's resume pointer
 * (`state.video_id`). Episodes that precede the resume in
 * (season, episode) order are inferred as fully watched —
 * cross-season included, so a series stamped at S03E02 will mark
 * everything in S01–S02 + S03E01 as watched. This is what
 * Stremio's official client surfaces as the "watched" state for
 * episodes the user has gone past.
 */
export function useLibraryProgress(id: string | null | undefined): ProgressInfo | null {
  const { byId } = useContext(LibraryCtx);
  if (!id) return null;
  const item = byId.get(id);
  if (item) return progressFromState(item.state ?? {});
  // No direct library entry → could be an episode id whose series
  // root is in the library. Apply the position-implied fallback.
  const seriesId = seriesRootFromEpisodeId(id);
  if (!seriesId) return null;
  const series = byId.get(seriesId);
  if (!series) return null;
  const state = series.state ?? {};
  const resumeId = typeof state.video_id === "string" ? state.video_id : null;
  if (!resumeId || resumeId === id) return null;
  if (episodeIsBeforeResume(id, resumeId)) {
    return { ratio: 1, watched: true, partial: false };
  }
  return null;
}

/**
 * The `state.video_id` Stremio stamps onto a series LibraryItem when
 * playback last touched a specific episode. Used by DetailView to
 * auto-resume on a Continue-Watching click, so the user lands directly
 * on the streams panel for the right episode instead of seeing an empty
 * episode list.
 *
 * Falls back to scanning the library for an episode-level record whose
 * id starts with the series root — earlier Aura builds wrote per-episode
 * entries (with the episode id as `_id` and no `video_id` in state). For
 * those legacy records we treat `_id` itself as the resume hint so old
 * data still produces a usable resume on click.
 *
 * Returns null for movies, items not in the library, or items the user
 * hasn't started yet.
 */
export function useResumeVideoId(id: string | null | undefined): string | null {
  const { byId } = useContext(LibraryCtx);
  if (!id) return null;
  // Fast path: explicit state.video_id on the series root record.
  const item = byId.get(id);
  if (item) {
    const vid = (item.state ?? {}).video_id;
    if (typeof vid === "string" && vid.length > 0) return vid;
  }
  // Legacy fall-back: scan for any episode-level record whose id starts
  // with `${id}:` and carries a non-zero timeOffset. Pick the most
  // recently touched (largest mtime).
  let bestId: string | null = null;
  let bestMtime = "";
  for (const [k, it] of byId.entries()) {
    if (!k.startsWith(`${id}:`)) continue;
    const off = (it.state ?? {}).timeOffset;
    if (typeof off !== "number" || off <= 0) continue;
    const m = it.mtime ?? "";
    if (m > bestMtime) {
      bestMtime = m;
      bestId = k;
    }
  }
  return bestId;
}

/**
 * Progress for a single episode of a series. Stremio's library doesn't
 * keep a separate item per episode — instead each series item's
 * `state.video_id` records the LAST-watched episode and `state.timeOffset`
 * is the offset into THAT episode. So:
 *
 *   • If the series item's state.video_id matches `episodeId`,
 *     return its progress (the resume pointer's actual fraction).
 *   • Else if `episodeId` precedes `state.video_id` in
 *     (season, episode) order — cross-season — infer it as fully
 *     watched (ratio 1, watched true). Stremio's own clients surface
 *     this same inference; without it, Aura showed "unwatched" for
 *     every episode in earlier seasons even though the user clearly
 *     had progressed past them.
 *   • Otherwise null (no info — episode is at-or-after the resume).
 */
export function useEpisodeProgress(
  seriesId: string,
  episodeId: string,
): ProgressInfo | null {
  const { byId } = useContext(LibraryCtx);
  // Subscribe to manual-watched changes so flipping an episode to
  // "watched" (right-click → Mark as Watched, or via the auto-advance
  // path on completion) immediately clears the partial-progress bar
  // and the WatchedBadge upgrades to the green check. Without this
  // the bar stuck around because nothing on the library side had
  // changed — only manualWatched did.
  const [manual, setManual] = useState(() => getManualWatchedState(episodeId));
  useEffect(() => {
    setManual(getManualWatchedState(episodeId));
    return onManualWatchedChange(() => {
      setManual(getManualWatchedState(episodeId));
    });
  }, [episodeId]);

  const item = byId.get(seriesId);
  if (!item) return null;

  // Manual-watched wins: clear the bar even if state.timeOffset still
  // says "halfway through". The user's flag is the authoritative
  // signal and overrides any lingering library progress (which the
  // auto-advance path also tries to zero, but datastorePut is
  // eventually consistent and a stale read can keep timeOffset > 0
  // for several seconds).
  if (manual === "watched") {
    return { ratio: 1, watched: true, partial: false };
  }

  const state = item.state ?? {};
  if (state.video_id === episodeId) return progressFromState(state);
  const resumeId = typeof state.video_id === "string" ? state.video_id : null;
  if (resumeId && episodeIsBeforeResume(episodeId, resumeId)) {
    return { ratio: 1, watched: true, partial: false };
  }
  return null;
}

/** "Episodes behind the latest aired" for an AIRING series (else null).
 *  N = airedCount − fully-watched aired episodes, where "aired" means a
 *  parseable air date in the past (undated / future episodes are excluded
 *  from BOTH counts). A fully-watched aired episode is one manually marked
 *  watched OR inferred-before-resume; the in-progress resume episode is NOT
 *  counted (matches AniMouto: 2 behind / 7 watched). Returns null when not
 *  airing or when behind <= 0. Red "N episodes behind" surfaces on the
 *  DetailView meta strip + the hover panel. */
export function useEpisodesBehind(
  videos: VideoEntry[] | undefined,
  seriesId: string | null | undefined,
): number | null {
  void useManualWatchedVersion();
  const resumeId = useResumeVideoId(seriesId);
  if (!videos || videos.length === 0) return null;
  const now = Date.now();
  const info = airingInfo(videos, now);
  if (!info.isAiring) return null;
  let watchedAired = 0;
  for (const v of videos) {
    // Count ONLY episodes airingInfo counts as aired (a parseable air date in
    // the past), so watchedAired and airedCount cover the SAME set. Using
    // isVideoAired here would over-count: it treats undated episodes as aired,
    // but airingInfo's airedCount skips them — breaking watchedAired <= aired.
    const t = v.released ? Date.parse(v.released) : NaN;
    if (!Number.isFinite(t) || t > now) continue;
    const manual = getManualWatchedState(v.id);
    if (manual === "watched") { watchedAired += 1; continue; }
    if (resumeId && v.id !== resumeId && episodeIsBeforeResume(v.id, resumeId)) watchedAired += 1;
  }
  const behind = Math.max(0, info.airedCount - watchedAired);
  // "Behind" only means something when the user is actually WATCHING this
  // series under THIS id — a resume position or at least one watched-aired
  // episode. With zero progress here every aired episode reads as unwatched,
  // so the badge would scream "48 behind" for a show you've finished. This
  // fires on a duplicate per-season catalog entry (e.g. AIOMetadata's separate
  // "... Season 3" listing) whose id differs from the one you watched under,
  // so its library/resume state is empty. No progress = "not started", not
  // "behind" — suppress it rather than alarm.
  if (watchedAired === 0 && !resumeId) return null;
  return behind > 0 ? behind : null;
}
