// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Watch-Together wire types — mirror watch-relay/src/worker.js. Small JSON
// frames only (play/pause/seek + the title/stream the leader picked +
// presence); never video, never the debrid URL.
// ---------------------------------------------------------------------------

/** A room member as the relay reports it. */
export interface WatchMember {
  id: string;
  name: string;
  /** What this member is currently watching (so the UI can show who's in
   *  sync vs. on a different title, and compute "ready" during staging). */
  videoKey: string | null;
}

/** The shared room playback state (also what a late joiner receives). */
export interface RoomState {
  paused: boolean;
  /** Seconds into the title at `updatedAt`. */
  position: number;
  /** Episode id (series) / movie id — the sync key + the episode to open. */
  videoKey: string | null;
  /** Series-root id (or movie id) — what a member navigates to. */
  metaId: string | null;
  mediaType: string | null;
  title: string | null;
  /** Human label for the leader's chosen stream ("Provider · 1080p"). */
  streamLabel: string | null;
  /** Stable-ish match key (info_hash / filename) so a member's stream list
   *  can highlight the same pick. */
  streamKey: string | null;
  /** True while the leader is holding playback, waiting for the party to
   *  join the same stream. */
  staging: boolean;
  /** Relay (server-clock) ms timestamp of this state. */
  updatedAt: number;
  driverId: string | null;
}

/** Server → client frames. */
export type ServerMsg =
  | { t: "welcome"; selfId: string; serverNow: number; state: RoomState; members: WatchMember[] }
  | { t: "members"; members: WatchMember[] }
  | ({ t: "control" } & RoomState)
  | { t: "tick"; position: number; paused: boolean; driverId: string | null }
  | { t: "video"; from: string; videoKey: string | null; title: string | null };

/** A snapshot of LOCAL playback the store reads to broadcast / tick. */
export interface LocalPlayback {
  paused: boolean;
  position: number;
  videoKey: string | null;
  metaId: string | null;
  mediaType: string | null;
  title: string | null;
  streamLabel: string | null;
  streamKey: string | null;
}

/** The host app wires this in so the store can drive / read local playback
 *  without importing React or the Tauri layer directly. */
export interface PlaybackBridge {
  /** Current local playback snapshot. */
  getLocal: () => LocalPlayback;
  /** Apply a remote target: seek to `position` and match `paused`. MUST NOT
   *  re-broadcast (it's applying, not originating). */
  apply: (paused: boolean, position: number) => void;
  /** Open the party's title locally, landing on the stream picker (and
   *  highlighting the leader's stream when `streamKey` matches). */
  openVideo: (target: {
    metaId: string; mediaType: string | null; videoKey: string | null;
    title: string | null; streamKey: string | null;
  }) => void;
}
