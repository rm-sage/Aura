// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaDetail, MetaPreview } from "./types";
import { isAnimeMeta } from "./aiometadata";

// ---------------------------------------------------------------------------
// useScrobble — completion-only scrobbling for the active playback session
//
// Originally a three-phase Trakt-style flow (start = "currently watching"
// check-in → heartbeats → end). The check-in feature was removed: AIOMetadata's
// AniList integration responded to /scrobble/start by bumping the user's
// `progress` to the current episode immediately, marking unwatched episodes
// as watched after a few seconds of preview playback. The user opted to drop
// check-in entirely; only the END event survives, fired exactly once per
// session when both completion thresholds are met.
//
// Backend exposes scrobble_start / scrobble_heartbeat / scrobble_end. This
// hook only invokes scrobble_end — the start/heartbeat commands remain in
// the Rust crate for a possible future opt-in but are no longer wired here.
// All calls are best-effort and never block the UI.
// ---------------------------------------------------------------------------

const COMPLETE_THRESHOLD = 0.80;
/**
 * Minimum ELAPSED playback time (seconds) of the current session
 * before we fire scrobble_start. Measured by accumulating positive
 * time-pos deltas between ticks (≤ 5s, while not paused) so seeks
 * forward / backward never inflate the counter — the user has to
 * actually watch this much fresh material before Trakt sees a "start".
 *
 * Without this gate, brief misclicks ("started the wrong stream, hit
 * back after 3 s") still emit scrobble_start, polluting the user's
 * history.
 *
 * Raised to 120 s (was 30 s). 30 s was the de-facto Trakt threshold,
 * but AIOMetadata's AniList integration on the addon side responds to
 * the start event by bumping the user's `progress` to the current
 * episode immediately — which means a 31-second-watched episode of
 * Frieren got flipped from unwatched → watched on AniList while the
 * user was still picking a stream. 120 s gives the user a longer
 * "preview window" to verify they actually want to commit to the
 * stream before any cloud state changes hands. Power users can lower
 * this back to 30 in Settings → Scrobbling.
 */
const START_WARMUP_S_DEFAULT = 120;
/**
 * Minimum ELAPSED playback time (same delta-accumulation as start)
 * before scrobble_end's auto-complete will fire. Without this floor,
 * resuming a CW item at 95% triggered an instant "completed" within
 * 1-2 ticks — Trakt then marked the episode watched while the user
 * had only seen a few seconds of fresh content. 90 s is enough to
 * filter out resume-bounce flickers without delaying genuine
 * completions (a user who legitimately watches 90 more seconds at
 * 90%+ has finished the episode for any practical purpose).
 */
const COMPLETE_WARMUP_S_DEFAULT = 300;
/** Per-tick clamp: anything above this is treated as a seek, not real
 *  playback, and isn't accumulated into elapsed playback. Tick
 *  intervals from MPV's playback-update event are sub-second; 5 s is
 *  comfortably above the longest legitimate idle-tick gap. */
const TICK_DELTA_CAP_S = 5;

interface PlaybackSnapshot {
  time: number;
  duration: number;
  paused: boolean;
}

/** What the caller knows about the *current* item being watched. */
export interface ActiveScrobbleTarget {
  /** Stream-fetch target id. For movies = movie id; for series = the
   *  EPISODE id (e.g. `tt0903747:1:5`) — what fetch_streams keys off. */
  id: string;
  /** Library record id. For movies = movie id; for series = the SERIES
   *  ROOT id (e.g. `tt0903747`). When omitted, callers should treat it
   *  as equal to `id` (movie / non-episodic content). Stremio's library
   *  is keyed at the series root, NOT per episode — `state.video_id`
   *  inside the library record carries the resume episode id. */
  series_id?: string;
  media_type: string;
  name: string;
  /** Compact season/episode tag, e.g. "S01E05". */
  episode?: string;
  /** The episode's own title (separate field so the OSD can render
   *  S01E05 — "The Big Heist" cleanly). */
  episode_title?: string;
  /** Authoritative numeric season from the VideoEntry the user clicked.
   *  Passed through to scrobble.rs so Trakt's /sync/history receives
   *  the picker's numbering directly instead of relying on the ID
   *  string-parse. Needed because AIOMetadata can produce dual-
   *  numbering inconsistencies (id says `:2:3` while video.season=1,
   *  video.episode=31 for the same physical episode). When omitted,
   *  the Rust side falls back to ID parsing (current behavior).
   *  Movies leave both fields undefined. */
  season?: number;
  episode_num?: number;
  /** Stylized logo URL — used by the buffering overlay. */
  logo?: string | null;
  /** Anime-detection signals — passed to `isAnimeMeta` so the AniList
   *  scrobble path correctly fires for IMDB-id'd anime served by
   *  Cinemeta (Frieren, Demon Slayer, etc.). Without these the
   *  detector only saw `media_type=series` + `id=tt...`, neither of
   *  which signal anime, and AniList scrobbling silently no-op'd for
   *  most anime in practice. Sourced from the `scoring` object that
   *  handlePlayStream already builds for the audio-track scorer. */
  genres?: string[] | null;
  original_language?: string | null;
  production_countries?: string[] | null;
}

export function activeTargetFromMeta(
  meta: MetaDetail | MetaPreview,
  episode?: string
): ActiveScrobbleTarget {
  return {
    id: meta.id,
    media_type: meta.media_type,
    name: meta.name,
    episode,
    // Carry every anime-detection signal the meta has so AniList
    // scrobbling fires for IMDB-id'd anime.
    genres: (meta as Partial<MetaDetail>).genres ?? null,
    original_language: (meta as Partial<MetaDetail>).original_language ?? null,
    production_countries: (meta as Partial<MetaDetail>).production_countries ?? null,
  };
}

interface Options {
  /** The current item, or null when nothing is playing / loaded. */
  active: ActiveScrobbleTarget | null;
  /** Latest playback snapshot from the playback-update event stream. */
  playback: PlaybackSnapshot;
  /** Stremio auth_key prefix (first 12 chars) or "guest" — keys the
   *  per-account Trakt / AniList token in the OS keyring. scrobble.rs
   *  needs this to fire /scrobble/stop with the right token. App.tsx
   *  derives it from the active session before mounting the hook. */
  scope: string;
  /** Optional override for the start warmup, in seconds. Defaults to
   *  START_WARMUP_S_DEFAULT (120). Surfaced as a Settings knob so
   *  users hitting addon-side over-scrobbling can lengthen the
   *  preview window without rebuilding. Clamped to [0, 600]. */
  startWarmupSecs?: number;
  /** Optional override for the auto-complete warmup. Defaults to
   *  COMPLETE_WARMUP_S_DEFAULT (300). */
  completeWarmupSecs?: number;
}

export function useScrobble({
  active,
  playback,
  scope,
  startWarmupSecs,
  completeWarmupSecs,
}: Options) {
  const startedFor = useRef<string | null>(null);   // session id we already started
  const completed = useRef<boolean>(false);         // suppress duplicate ends
  /** Session keys that have already auto-completed in THIS hook
   *  lifetime. After a scrobble_end fires from the completion branch,
   *  `startedFor` resets to null so a subsequent tick would normally
   *  re-enter the start-warmup branch (elapsed time is still high) and
   *  immediately re-complete. That's how Trakt ended up with 6× entries
   *  for one episode. This set holds the keys we've already completed,
   *  and the start branch refuses to re-arm for any key in it. Cleared
   *  on hook unmount (the wrapping useRef survives across renders but
   *  not full unmount). */
  const completedFor = useRef<Set<string>>(new Set());
  /** Elapsed playback time accumulated for the CURRENT session, in
   *  seconds. Reset on session change / unmount. Drives both the
   *  scrobble_start warmup and the auto-complete floor — a seek (or
   *  resume from a saved position) increments absolute time but does
   *  NOT increment elapsed, so Trakt can't be fooled into thinking a
   *  resumed-near-end CW item finished after one tick. */
  const elapsedThisSession = useRef<number>(0);
  /** Previous tick's `playback.time` — used to compute per-tick delta. */
  const lastTickTime = useRef<number>(0);
  /** Tracks which session key we're currently accumulating against,
   *  so changing items resets the elapsed counter cleanly. */
  const elapsedSessionKey = useRef<string | null>(null);
  /** Latest playback snapshot mirrored to a ref so the unmount handler
   *  and the beforeunload listener can read CURRENT values without
   *  closing over stale `playback` from the mount-time render. The
   *  earlier unmount path captured `{time: 0, duration: 0}` from the
   *  initial render, which meant a session ended via component
   *  teardown told the addon "ended at 0/0" — useless for /scrobble/end
   *  progress fidelity. */
  const playbackRef = useRef<PlaybackSnapshot>(playback);
  playbackRef.current = playback;

  const startWarmup = Math.max(
    0,
    Math.min(600, typeof startWarmupSecs === "number" ? startWarmupSecs : START_WARMUP_S_DEFAULT),
  );
  const completeWarmup = Math.max(
    0,
    Math.min(600, typeof completeWarmupSecs === "number" ? completeWarmupSecs : COMPLETE_WARMUP_S_DEFAULT),
  );

  // Helper: signal session end if one is in flight, then forget it.
  const endSession = (time: number, duration: number) => {
    if (!startedFor.current) return;
    invoke("scrobble_end", { time, duration }).catch(() => {});
    startedFor.current = null;
    completed.current = false;
  };

  // ── Switching items / leaving playback ──
  useEffect(() => {
    // Best-effort backstop: if the user closes the WHOLE WINDOW (X
    // button on the title bar, alt+f4, etc.) instead of exiting the
    // player overlay first, neither React's component teardown nor the
    // useScrobble effect cleanup runs — the process exits before
    // either gets a chance. The Rust side has its own synchronous
    // shutdown_blocking() in window_logic's CloseRequested handler;
    // this beforeunload is the JS-side belt-and-braces for any path
    // where Rust didn't get there first (deep-link triggered
    // navigation, IDE-driven hot-reload, etc.). Both ends are cheap
    // to call and the Rust session lock makes them idempotent.
    const onBeforeUnload = () => {
      if (startedFor.current) {
        // Fire-and-forget — the page may not stay alive long enough to
        // see the response, but the Tauri IPC bridge dispatches the
        // command synchronously enough that the Rust side records the
        // intent and the post_event lands via the runtime executor.
        invoke("scrobble_end", {
          time:     playbackRef.current.time,
          duration: playbackRef.current.duration,
        }).catch(() => {});
        startedFor.current = null;
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      // Component unmount: end any in-flight session using the LIVE
      // playback values (via ref), not the stale closure-captured ones.
      if (startedFor.current) {
        invoke("scrobble_end", {
          time:     playbackRef.current.time,
          duration: playbackRef.current.duration,
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Per-frame logic ──
  useEffect(() => {
    // No active target → end any open session and reset elapsed counter.
    if (!active) {
      endSession(playback.time, playback.duration);
      elapsedThisSession.current = 0;
      elapsedSessionKey.current = null;
      lastTickTime.current = 0;
      return;
    }

    const sessionKey = `${active.media_type}:${active.id}:${active.episode ?? ""}`;

    // Different item than what we started with → close prior, open new.
    if (startedFor.current && startedFor.current !== sessionKey) {
      endSession(playback.time, playback.duration);
    }

    // Reset the elapsed counter on session change so a switch to a
    // different episode starts the warmup over from zero — without
    // this, hopping between episodes within ~30 s would chain into a
    // single 30-s warmup that scrobble_starts the SECOND episode
    // immediately on first tick.
    if (elapsedSessionKey.current !== sessionKey) {
      elapsedSessionKey.current = sessionKey;
      elapsedThisSession.current = 0;
      lastTickTime.current = playback.time;
    } else {
      // Accumulate per-tick deltas, ignoring seeks (delta > cap) and
      // backward jumps (delta < 0) and pauses. This is the source of
      // truth for "how long has the user actually been watching".
      const dt = playback.time - lastTickTime.current;
      if (!playback.paused && dt > 0 && dt < TICK_DELTA_CAP_S) {
        elapsedThisSession.current += dt;
      }
      lastTickTime.current = playback.time;
    }

    // Mark this session as "active" so the unmount / beforeunload
    // handlers know to flush /scrobble/end. We need this gate even
    // without firing /scrobble/start (which used to set it) because
    // the Rust session_slot is what /scrobble/end pulls from. Calling
    // scrobble_start once on first tick keeps the wire-format invariant
    // that /end follows /start, while the Rust-side /start no longer
    // fans HTTP traffic to the addon (it just sets local state).
    if (
      startedFor.current !== sessionKey &&
      !completedFor.current.has(sessionKey) &&
      playback.duration > 0 &&
      elapsedThisSession.current >= startWarmup
    ) {
      startedFor.current = sessionKey;
      completed.current = false;
      void invoke("scrobble_start", {
        session: {
          imdb_id: active.id,
          media_type: active.media_type,
          episode: active.episode ?? null,
          title: active.name,
          is_anime: isAnimeMeta(active),
          scope,
          // Authoritative numbers from the VideoEntry the user clicked.
          // scrobble.rs prefers these over the ID-string parse when
          // building the Trakt payload — fixes dual-numbering anime
          // where the stream id and the displayed S/E disagree.
          season:      active.season ?? null,
          episode_num: active.episode_num ?? null,
        },
        duration: playback.duration,
      }).catch(() => {});
      return;
    }

    // Auto-complete when BOTH conditions hold: progress past the
    // 80 % threshold AND at least N seconds of fresh content actually
    // watched in THIS session (excludes pause time and seek jumps).
    // Logic switched from OR (over-eager) to AND on user feedback —
    // a drive-by 5 s preview that happened to land near the end no
    // longer pollutes scrobble history.
    if (
      startedFor.current === sessionKey &&
      !completed.current &&
      playback.duration > 0 &&
      playback.time / playback.duration >= COMPLETE_THRESHOLD &&
      elapsedThisSession.current >= completeWarmup
    ) {
      completed.current = true;
      // Remember this key — endSession resets startedFor + completed to
      // null/false, which without the completedFor gate above would let
      // the start branch immediately re-arm and re-complete on the next
      // tick.
      completedFor.current.add(sessionKey);
      endSession(playback.time, playback.duration);
      // Auto-advance: dispatch an event the App listens for and routes
      // to advanceWatchedAfter (which needs addon list access — we
      // don't carry that in this hook). Episode/series ids come from
      // the active target. For movies, series_id is undefined and the
      // event is harmless (advanceWatchedAfter ignores non-episodic).
      window.dispatchEvent(new CustomEvent("aura:auto-advance-watched", {
        detail: {
          seriesId:  active.series_id ?? active.id,
          episodeId: active.id,
          mediaType: active.media_type,
        },
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playback.time, playback.duration, playback.paused]);
}
