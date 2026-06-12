// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Watch-Together wire types — mirror watch-relay/src/worker.js. Small JSON
// frames only (play/pause/seek/title + presence); never video.
// ---------------------------------------------------------------------------

/** A room member as the relay reports it. */
export interface WatchMember {
  id: string;
  name: string;
  /** What this member is currently watching (so the UI can show who's in
   *  sync vs. on a different title). Null = nothing / not yet reported. */
  videoKey: string | null;
}

/** The shared room playback state (also what a late joiner receives). */
export interface RoomState {
  paused: boolean;
  /** Seconds into the title at `updatedAt`. */
  position: number;
  videoKey: string | null;
  title: string | null;
  /** Relay (server-clock) ms timestamp of this state. */
  updatedAt: number;
  driverId: string | null;
}

/** Server → client frames. */
export type ServerMsg =
  | { t: "welcome"; selfId: string; serverNow: number; state: RoomState; members: WatchMember[] }
  | { t: "members"; members: WatchMember[] }
  | { t: "control"; paused: boolean; position: number; videoKey: string | null; title: string | null; updatedAt: number; driverId: string | null }
  | { t: "tick"; position: number; paused: boolean; driverId: string | null }
  | { t: "video"; from: string; videoKey: string | null; title: string | null };

/** A snapshot of LOCAL playback the store reads to broadcast / tick. */
export interface LocalPlayback {
  paused: boolean;
  position: number;
  videoKey: string | null;
  title: string | null;
}

/** The host app wires this in so the store can drive / read local playback
 *  without importing React or the Tauri layer directly. */
export interface PlaybackBridge {
  /** Current local playback snapshot. */
  getLocal: () => LocalPlayback;
  /** Apply a remote target: seek to `position` and match `paused`. MUST NOT
   *  re-broadcast (it's applying, not originating). */
  apply: (paused: boolean, position: number) => void;
}
