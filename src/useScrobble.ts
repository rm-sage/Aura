import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaDetail, MetaPreview } from "./types";
import { isAnimeMeta } from "./aiometadata";

// ---------------------------------------------------------------------------
// useScrobble — Trakt/AniList lifecycle for the active playback session
//
// Backend exposes scrobble_start / scrobble_heartbeat / scrobble_end which
// forward to the configured AIOMetadata endpoint. This hook turns playback
// state into the right sequence of events:
//
//   • on first time-pos > 0 with a duration       → scrobble_start
//   • every HEARTBEAT_MS while paused === false   → scrobble_heartbeat
//   • when activeMeta clears OR progress >= 0.9   → scrobble_end
//
// All RPC calls are best-effort (backend is no-op if no scrobble addon is
// configured); this hook never blocks the UI.
// ---------------------------------------------------------------------------

const HEARTBEAT_MS = 60_000;
const COMPLETE_THRESHOLD = 0.9;

interface PlaybackSnapshot {
  time: number;
  duration: number;
  paused: boolean;
}

/** What the caller knows about the *current* item being watched. */
export interface ActiveScrobbleTarget {
  id: string;
  media_type: string;
  name: string;
  episode?: string;
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
  };
}

interface Options {
  /** The current item, or null when nothing is playing / loaded. */
  active: ActiveScrobbleTarget | null;
  /** Latest playback snapshot from the playback-update event stream. */
  playback: PlaybackSnapshot;
}

export function useScrobble({ active, playback }: Options) {
  const startedFor = useRef<string | null>(null);   // session id we already started
  const lastHeartbeat = useRef<number>(0);          // unix ms
  const completed = useRef<boolean>(false);         // suppress duplicate ends

  // Helper: signal session end if one is in flight, then forget it.
  const endSession = (time: number, duration: number) => {
    if (!startedFor.current) return;
    invoke("scrobble_end", { time, duration }).catch(() => {});
    startedFor.current = null;
    completed.current = false;
    lastHeartbeat.current = 0;
  };

  // ── Switching items / leaving playback ──
  useEffect(() => {
    return () => {
      // Component unmount: end any in-flight session.
      if (startedFor.current) {
        invoke("scrobble_end", {
          time: playback.time,
          duration: playback.duration,
        }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Per-frame logic ──
  useEffect(() => {
    // No active target → end any open session.
    if (!active) {
      endSession(playback.time, playback.duration);
      return;
    }

    const sessionKey = `${active.media_type}:${active.id}:${active.episode ?? ""}`;

    // Different item than what we started with → close prior, open new.
    if (startedFor.current && startedFor.current !== sessionKey) {
      endSession(playback.time, playback.duration);
    }

    // Conditions to fire start:
    //   - Haven't started this session
    //   - duration > 0 (libmpv has resolved file metadata)
    //   - time > 0 (actually playing, not just loaded paused)
    if (
      startedFor.current !== sessionKey &&
      playback.duration > 0 &&
      playback.time > 0
    ) {
      startedFor.current = sessionKey;
      completed.current = false;
      lastHeartbeat.current = Date.now();
      invoke("scrobble_start", {
        session: {
          imdb_id: active.id,
          media_type: active.media_type,
          episode: active.episode ?? null,
          title: active.name,
          is_anime: isAnimeMeta(active),
        },
        duration: playback.duration,
      }).catch(() => {});
      return;
    }

    // Once started: heartbeats while playing
    if (startedFor.current === sessionKey && !playback.paused) {
      const now = Date.now();
      if (now - lastHeartbeat.current >= HEARTBEAT_MS) {
        lastHeartbeat.current = now;
        invoke("scrobble_heartbeat", {
          time: playback.time,
          duration: playback.duration,
        }).catch(() => {});
      }
    }

    // Auto-complete when we cross the threshold
    if (
      startedFor.current === sessionKey &&
      !completed.current &&
      playback.duration > 0 &&
      playback.time / playback.duration >= COMPLETE_THRESHOLD
    ) {
      completed.current = true;
      endSession(playback.time, playback.duration);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playback.time, playback.duration, playback.paused]);
}
