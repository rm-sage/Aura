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
  /** Playback speed multiplier the leader is using (1 = normal). Followers
   *  match it so they don't drift and re-seek to catch up — a leader at 1.5x
   *  outpaces a 1x follower otherwise. Defaults to 1 on older relays/clients. */
  speed: number;
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

/** A "Vote to Watch" poll — any member proposes a title; the party votes
 *  yes/no; unanimous yes wins, any no fails, 60 s with no decision expires.
 *  Up to 3 can be active at once. The relay is authoritative for the tally. */
export interface VotePoll {
  id: string;
  /** Series-root id (or movie id) — what a winning vote navigates to. */
  metaId: string;
  mediaType: string | null;
  title: string;
  poster: string | null;
  proposedBy: string;
  proposedByName: string;
  /** Relay (server-clock) ms timestamps. */
  startedAt: number;
  expiresAt: number;
  yes: number;
  no: number;
  /** Member ids that have already cast — so the UI can disable re-voting and
   *  show "X of N voted". */
  voters: string[];
}

/** A member's live buffer telemetry, broadcast over the relay (throttled) and
 *  shown per-member in the party panel. `seconds` = demuxer readahead buffered
 *  ahead of the playhead; `pct` = stall buffering % (only while stalled);
 *  `stalled` = paused-for-cache. `ts` is the local receive time (freshness). */
export interface MemberStat {
  pct: number | null;
  seconds: number | null;
  stalled: boolean;
  ts: number;
}

/** Server → client frames. */
export type ServerMsg =
  | { t: "welcome"; selfId: string; serverNow: number; state: RoomState; members: WatchMember[]; leaderId: string | null }
  | { t: "members"; members: WatchMember[]; leaderId: string | null }
  | ({ t: "control" } & RoomState)
  | { t: "tick"; position: number; paused: boolean; speed?: number; driverId: string | null }
  | { t: "video"; from: string; videoKey: string | null; title: string | null }
  /** Full active-vote list (broadcast on any change / expiry sweep). */
  | { t: "votes"; votes: VotePoll[] }
  /** A vote reached unanimous yes — clients persist it as a dismissable card. */
  | { t: "vote-won"; vote: VotePoll }
  /** Sent to the initiator only (3-vote cap reached, or duplicate). */
  | { t: "vote-error"; reason: string }
  /** A `join`-intent connect to a room nobody is currently hosting — the relay
   *  refuses to auto-create, so the client can offer "create it instead". */
  | { t: "room-not-found"; code: string }
  /** A peer's buffer telemetry, relayed (throttled) for the per-member readout. */
  | { t: "stat"; from: string; pct: number | null; seconds: number | null; stalled: boolean };

/** A snapshot of LOCAL playback the store reads to broadcast / tick. */
export interface LocalPlayback {
  paused: boolean;
  position: number;
  /** True while a load is in flight and `position` is therefore not a real
   *  playhead. mpv has not confirmed the new file open yet, so the host
   *  reports 0. The leader tick MUST skip on this: a broadcast 0 is taken by
   *  every in-sync follower as a 1200-second backward drift and seeks the
   *  whole room to 00:00. */
  loading: boolean;
  /** Current local playback speed (1 = normal). */
  speed: number;
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
  /** Apply a remote target: seek to `position`, match `paused`, and match the
   *  leader's `speed`. MUST NOT re-broadcast (it's applying, not originating). */
  apply: (paused: boolean, position: number, speed: number) => void;
  /** Open the party's title locally, landing on the stream picker (and
   *  highlighting the leader's stream when `streamKey` matches). */
  openVideo: (target: {
    metaId: string; mediaType: string | null; videoKey: string | null;
    title: string | null; streamKey: string | null;
  }) => void;
}
