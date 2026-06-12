// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Watch-Together store — a module-level pub/sub (mirrors the other Aura
// stores) over a single WebSocket to the relay (watch-relay/). It:
//   • owns the room connection + the config (relay URL / name / token),
//   • relays LOCAL play/pause/seek to the room (notifyLocalControl),
//   • applies REMOTE play/pause/seek to local playback via a PlaybackBridge,
//   • keeps everyone drift-corrected (the lowest-id member is the "leader"
//     and emits a position tick every few seconds),
//   • gates all sync on title agreement (same videoKey) — debrid URLs are
//     per-user, so each peer resolves its OWN stream for the shared title.
//
// The WebSocket lives in the webview (frontend) directly — no Rust hop. It
// drives playback only through the existing toggle_pause / seek_absolute
// commands (via the bridge), so the MPV landmines don't apply.
// ---------------------------------------------------------------------------

import type {
  WatchMember, RoomState, ServerMsg, PlaybackBridge,
} from "./types";

const LS_URL = "aura.watch.relayUrl";
const LS_NAME = "aura.watch.displayName";
const LS_TOKEN = "aura.watch.appToken";
const LS_CLIENT_ID = "aura.watch.clientId";

/** Stable per-install id sent as `cid`. The relay keys the member on it so a
 *  reconnect reclaims the same roster slot + leader-election ordering (instead
 *  of re-rolling a random id and making the leader crown flap). */
function getClientId(): string {
  try {
    const existing = localStorage.getItem(LS_CLIENT_ID);
    if (existing) return existing;
  } catch { /* ignore */ }
  const id = crypto.randomUUID().slice(0, 8);
  try { localStorage.setItem(LS_CLIENT_ID, id); } catch { /* ignore */ }
  return id;
}

/** Re-seek a follower only when it has drifted more than this from the room
 *  clock — small enough to stay in sync, large enough to avoid micro-seek
 *  thrash from network jitter. */
const DRIFT_THRESHOLD_S = 1.5;
const TICK_MS = 4000;
const RECONNECT_MAX = 4;
/** Coalesce applied remote seeks so a flood of control/tick frames (a buggy or
 *  malicious peer) can't thrash the local playhead. */
const APPLY_MIN_INTERVAL_MS = 300;

export type WatchStatus = "idle" | "connecting" | "connected" | "error";

export interface WatchUiState {
  status: WatchStatus;
  roomCode: string | null;
  selfId: string | null;
  members: WatchMember[];
  /** What the party is watching (from the shared playback state). */
  roomVideoKey: string | null;
  roomMetaId: string | null;
  roomMediaType: string | null;
  roomTitle: string | null;
  roomStreamLabel: string | null;
  roomStreamKey: string | null;
  /** Current room play/pause (drives the waiting vs playing UI). */
  roomPaused: boolean;
  /** True while the host is holding playback, waiting for the party. */
  staging: boolean;
  /** True when WE are the member holding a staged stream (drives the host-only
   *  "Start now" affordance — derived from local truth, not leader election, so
   *  a leader crown flap mid-staging can't strand the control on the wrong peer). */
  amStaging: boolean;
  /** True when local playback is on the room's title (sync is active). */
  inSync: boolean;
  isLeader: boolean;
  error: string | null;
}

const BLANK_ROOM = {
  roomVideoKey: null, roomMetaId: null, roomMediaType: null, roomTitle: null,
  roomStreamLabel: null, roomStreamKey: null, roomPaused: true, staging: false,
};

const ui: WatchUiState = {
  status: "idle",
  roomCode: null,
  selfId: null,
  members: [],
  ...BLANK_ROOM,
  amStaging: false,
  inSync: false,
  isLeader: false,
  error: null,
};

// ── Connection / runtime (not part of the emitted UI state) ────────────────
let ws: WebSocket | null = null;
let serverClockOffset = 0; // serverNow − Date.now() at welcome
let leaderTimer: ReturnType<typeof setInterval> | null = null;
let userLeft = false; // distinguishes a deliberate leave from a dropped socket
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let bridge: PlaybackBridge | null = null;
let lastApplyAt = 0; // throttles applied remote seeks (APPLY_MIN_INTERVAL_MS)
let localStaging = false; // are WE currently holding a stream for the party?
let lastRoomState: RoomState | null = null; // for snap-to-room on becoming in-sync

// ── Pub/sub ────────────────────────────────────────────────────────────────
const subs = new Set<() => void>();
export function subscribeWatch(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}
export function getWatchState(): WatchUiState {
  return ui;
}
function emit() {
  for (const cb of subs) cb();
}

// ── Config ─────────────────────────────────────────────────────────────────
/** Baked-in default relay (a deployed Cloudflare Worker) so users only need a
 *  room code to join a party — no relay URL to paste. Overridable per-install
 *  in the panel's "Relay settings". */
const DEFAULT_RELAY_URL = "wss://aura-watch-relay.rmsage95.workers.dev";
export function getRelayUrl(): string {
  try {
    const v = localStorage.getItem(LS_URL);
    if (v && v.trim()) return v.trim();
  } catch { /* ignore */ }
  return DEFAULT_RELAY_URL;
}
export function getDisplayName(): string {
  try {
    const n = localStorage.getItem(LS_NAME);
    if (n) return n;
  } catch { /* ignore */ }
  return "Guest";
}
export function getAppToken(): string {
  try { return localStorage.getItem(LS_TOKEN) || ""; } catch { return ""; }
}
export function setWatchConfig(cfg: { relayUrl?: string; displayName?: string; appToken?: string }): void {
  try {
    if (cfg.relayUrl !== undefined) localStorage.setItem(LS_URL, cfg.relayUrl.trim());
    if (cfg.displayName !== undefined) localStorage.setItem(LS_NAME, cfg.displayName.trim().slice(0, 40));
    if (cfg.appToken !== undefined) localStorage.setItem(LS_TOKEN, cfg.appToken.trim());
  } catch { /* ignore */ }
  emit();
}

/** The host app registers how to read + drive local playback. */
export function setPlaybackBridge(b: PlaybackBridge | null): void {
  bridge = b;
}

// ── Room lifecycle ─────────────────────────────────────────────────────────

function genCode(): string {
  // Ambiguity-free alphabet (no O/0/I/1) — easy to read aloud / type.
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) out += alpha[buf[i] % alpha.length];
  return out;
}

/** Create a new room (you become the first member / leader). Returns the code. */
export function createRoom(): string | null {
  const code = genCode();
  return connect(code) ? code : null;
}

export function joinRoom(code: string): boolean {
  const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!c) {
    setError("Enter a room code.");
    return false;
  }
  return connect(c);
}

export function leaveRoom(): void {
  userLeft = true;
  localStaging = false;
  teardown();
  ui.status = "idle";
  ui.roomCode = null;
  ui.selfId = null;
  ui.members = [];
  Object.assign(ui, BLANK_ROOM);
  ui.amStaging = false;
  ui.inSync = false;
  ui.isLeader = false;
  ui.error = null;
  emit();
}

function connect(code: string): boolean {
  const base = getRelayUrl();
  if (!base) {
    setError("Set a relay URL in Settings → Watch Together first.");
    return false;
  }
  teardown();
  userLeft = false;
  ui.status = "connecting";
  ui.roomCode = code;
  ui.error = null;
  emit();

  let url: string;
  try {
    url = buildUrl(base, code);
  } catch {
    setError("That relay URL doesn't look valid (use wss://… or ws://…).");
    return false;
  }

  try {
    ws = new WebSocket(url);
  } catch (e) {
    setError(`Couldn't open the relay connection: ${String(e)}`);
    return false;
  }

  ws.onopen = () => {
    // NB: do NOT reset reconnectAttempts here — a transport that opens then
    // immediately drops (CF DO recycle, a proxy that 101s then resets) would
    // otherwise loop forever. The counter is cleared only once a `welcome`
    // proves the DO fully accepted us (handleMessage).
    ui.status = "connected";
    ui.error = null;
    emit();
  };
  ws.onmessage = (ev) => {
    try { handleMessage(ev.data as string); } catch { /* ignore bad frame */ }
  };
  ws.onerror = () => {
    // onclose follows; surface a hint there.
  };
  ws.onclose = () => {
    stopLeaderTimer();
    if (userLeft) return;
    // Unexpected drop — try a few reconnects before giving up.
    if (reconnectAttempts < RECONNECT_MAX && ui.roomCode) {
      reconnectAttempts += 1;
      ui.status = "connecting";
      emit();
      reconnectTimer = setTimeout(() => connect(ui.roomCode as string), 1500 * reconnectAttempts);
    } else {
      ui.status = "error";
      ui.error = ui.error ?? "Lost the watch-together connection.";
      emit();
    }
  };
  return true;
}

function buildUrl(base: string, code: string): string {
  let b = base.trim();
  // Tolerate http(s):// by upgrading to ws(s):// — a common copy-paste slip.
  if (b.startsWith("https://")) b = "wss://" + b.slice(8);
  else if (b.startsWith("http://")) b = "ws://" + b.slice(7);
  if (!b.startsWith("ws://") && !b.startsWith("wss://")) {
    b = "wss://" + b; // bare host → assume secure
  }
  b = b.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("name", getDisplayName());
  params.set("cid", getClientId());
  const v = bridge?.getLocal().videoKey ?? "";
  if (v) params.set("video", v);
  const token = getAppToken();
  if (token) params.set("t", token);
  // `new URL` validates the result and throws on garbage.
  return new URL(`${b}/room/${code}?${params.toString()}`).toString();
}

function teardown() {
  stopLeaderTimer();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

function setError(msg: string) {
  ui.status = "error";
  ui.error = msg;
  emit();
}

function send(obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* dropped */ }
  }
}

// ── Inbound protocol ────────────────────────────────────────────────────────

function handleMessage(data: string) {
  const msg = JSON.parse(data) as ServerMsg;
  switch (msg.t) {
    case "welcome":
      reconnectAttempts = 0; // proven-healthy connection — re-arm the cap
      ui.selfId = msg.selfId;
      serverClockOffset = msg.serverNow - Date.now();
      ui.members = msg.members;
      ingestRoomState(msg.state);
      recomputeLeader();
      emit();
      break;
    case "members":
      ui.members = msg.members;
      recomputeLeader();
      recomputeSync();
      emit();
      break;
    case "control":
      ingestRoomState(msg);
      emit();
      break;
    case "tick":
      applyTick(msg.position, msg.paused, msg.driverId);
      break;
    case "video":
      // Presence-only; the following `members` frame carries the roster.
      break;
    default:
      break;
  }
}

/** Adopt a new shared room state — update the "what we're watching" labels and,
 *  if we're on that title, snap local playback to it. */
function ingestRoomState(state: RoomState) {
  lastRoomState = state;
  ui.roomVideoKey = state.videoKey;
  ui.roomMetaId = state.metaId ?? null;
  ui.roomMediaType = state.mediaType ?? null;
  ui.roomTitle = state.title;
  ui.roomStreamLabel = state.streamLabel ?? null;
  ui.roomStreamKey = state.streamKey ?? null;
  ui.roomPaused = state.paused;
  ui.staging = !!state.staging;
  recomputeSync();
  if (!ui.inSync || !bridge) return;
  const target = expectedPosition(state);
  applyRemote(state.paused, target);
}

/** Drift correction from the leader's tick. Only nudge when we're in sync and
 *  the room is playing, and only past the threshold. Ticks are honored ONLY
 *  from the current leader — this rejects a stale ex-leader's in-flight tick
 *  during a membership change and a non-leader peer spamming forged ticks. */
function applyTick(position: number, paused: boolean, driverId: string | null) {
  if (!ui.inSync || !bridge || paused) return;
  if (!driverId || driverId !== leaderId()) return;
  const local = bridge.getLocal();
  if (local.paused) return;
  if (Math.abs(local.position - position) > DRIFT_THRESHOLD_S) {
    applyRemote(false, position);
  }
}

/** Extrapolate the room's current position from a state stamped at updatedAt
 *  (server clock). */
function expectedPosition(state: RoomState): number {
  if (state.paused) return state.position;
  const serverNow = Date.now() + serverClockOffset;
  const elapsed = Math.max(0, (serverNow - state.updatedAt) / 1000);
  return state.position + elapsed;
}

function applyRemote(paused: boolean, position: number) {
  if (!bridge) return;
  if (!Number.isFinite(position)) return; // reject NaN/Inf — would yank to 0
  // Throttle a flood of applied seeks (a buggy/malicious peer), but NEVER drop
  // a genuine pause-state change — those must always land.
  const now = Date.now();
  if (paused === bridge.getLocal().paused && now - lastApplyAt < APPLY_MIN_INTERVAL_MS) return;
  lastApplyAt = now;
  bridge.apply(paused, position);
}

function recomputeSync() {
  const local = bridge?.getLocal().videoKey ?? null;
  ui.inSync = ui.roomVideoKey != null && local != null && local === ui.roomVideoKey;
}

/** The current leader = lowest member id (deterministic across clients). */
function leaderId(): string | null {
  if (ui.members.length === 0) return null;
  return ui.members.reduce((a, m) => (m.id < a ? m.id : a), ui.members[0].id);
}

function recomputeLeader() {
  if (!ui.selfId || ui.members.length === 0) {
    ui.isLeader = false;
    stopLeaderTimer();
    return;
  }
  const isLeader = ui.selfId === leaderId();
  ui.isLeader = isLeader;
  if (isLeader) startLeaderTimer();
  else stopLeaderTimer();
}

function startLeaderTimer() {
  if (leaderTimer) return;
  leaderTimer = setInterval(() => {
    if (!bridge || ui.status !== "connected") return;
    const local = bridge.getLocal();
    // Only drive drift while WE are watching the room title and playing.
    if (local.paused || local.videoKey == null || local.videoKey !== ui.roomVideoKey) return;
    send({ t: "tick", position: local.position, paused: false });
  }, TICK_MS);
}

function stopLeaderTimer() {
  if (leaderTimer) { clearInterval(leaderTimer); leaderTimer = null; }
}

// ── Outbound (called by the host app on LOCAL user actions) ─────────────────

/** The local user played / paused / seeked. Broadcast it to the room — but
 *  only if we're establishing the room's title (none yet) or already in sync,
 *  so a member off watching something else can't hijack the party. Suppressed
 *  briefly right after applying a remote action (belt-and-suspenders against
 *  echo). The echo guard is the raw-vs-wrapped control split (apply() uses the
 *  RAW controls, which never call this), so no time-window suppression is
 *  needed — and a blanket window would wrongly swallow a real user action that
 *  happens to land just after a remote frame.
 *
 *  `next` carries the INTENDED post-action paused/position because React state
 *  (and the refs the bridge reads) haven't updated yet at the call site. */
export function notifyLocalControl(next?: { paused: boolean; position: number }): void {
  if (ui.status !== "connected" || !bridge) return;
  const local = bridge.getLocal();
  const establishing = ui.roomVideoKey == null;
  const matches = local.videoKey != null && local.videoKey === ui.roomVideoKey;
  if (!establishing && !matches) return;
  broadcastControl(next?.paused ?? local.paused, next?.position ?? local.position);
}

/** Send a full control frame AND mirror it into the local room state — we
 *  never receive our own frames, so without this our own inSync / room labels
 *  would lag what we just told everyone else. */
function broadcastControl(paused: boolean, position: number) {
  if (!bridge) return;
  const local = bridge.getLocal();
  // Stream/meta IDENTITY (which title + which stream pick + staging) belongs to
  // whoever established the party stream — the leader, or the very first control
  // when the room has no title yet. An in-sync FOLLOWER pausing/seeking only
  // moves the play-head; it must NOT overwrite the host's stream pick with its
  // own per-user debrid resolution, nor clear the host's staging flag. So a
  // non-owner preserves the room identity and re-sends it verbatim.
  const owns = ui.isLeader || ui.roomVideoKey == null;
  const videoKey = owns ? local.videoKey : ui.roomVideoKey;
  const metaId = owns ? local.metaId : ui.roomMetaId;
  const mediaType = owns ? local.mediaType : ui.roomMediaType;
  const title = owns ? local.title : ui.roomTitle;
  const streamLabel = owns ? local.streamLabel : ui.roomStreamLabel;
  const streamKey = owns ? local.streamKey : ui.roomStreamKey;
  const staging = owns ? localStaging : ui.staging;
  ui.roomVideoKey = videoKey;
  ui.roomMetaId = metaId;
  ui.roomMediaType = mediaType;
  ui.roomTitle = title;
  ui.roomStreamLabel = streamLabel;
  ui.roomStreamKey = streamKey;
  ui.roomPaused = paused;
  ui.staging = staging;
  ui.amStaging = localStaging;
  recomputeSync();
  send({
    t: "control", paused, position,
    videoKey, metaId, mediaType, title, streamLabel, streamKey, staging,
  });
  emit();
}

/** Start (or switch) the party's stream and HOLD it (staging) for the party to
 *  join. Bypasses the in-sync gate — this IS the new party content. Called by
 *  the host right after their stream loads (paused). */
export function startPartyStream(): void {
  if (ui.status !== "connected" || !bridge) return;
  localStaging = true;
  broadcastControl(true, 0);
}

/** Whether WE are the one holding a staged stream (drives the host's
 *  "waiting for party / Start now" UI + the auto-start effect). */
export function amStagingHost(): boolean {
  return localStaging && ui.status === "connected";
}

/** Clear our staging flag (host pressed "Start now" / auto-started). The
 *  caller then unpauses local playback, whose broadcast carries staging=false. */
export function setLocalStaging(v: boolean): void {
  localStaging = v;
  ui.amStaging = v;
  emit();
}

/** Members (besides us) currently on the party's title — the "ready" count. */
export function readyCount(): number {
  if (!ui.roomVideoKey) return 0;
  return ui.members.filter((m) => m.id !== ui.selfId && m.videoKey === ui.roomVideoKey).length;
}

/** True once every OTHER member is on the party's title — the auto-start
 *  trigger. Excludes self (and reads self-readiness from local truth, not the
 *  relay roster which lags) AND requires at least one other member, so a solo
 *  host keeps waiting on the staging banner (with the Start-now override)
 *  instead of blowing straight through it. */
export function everyoneReady(): boolean {
  if (!ui.roomVideoKey) return false;
  const selfReady = (bridge?.getLocal().videoKey ?? null) === ui.roomVideoKey;
  const others = ui.members.filter((m) => m.id !== ui.selfId);
  return selfReady && others.length > 0 && others.every((m) => m.videoKey === ui.roomVideoKey);
}

/** Open the party's title locally, landing on the stream picker. */
export function openRoomVideo(): void {
  if (!bridge || !ui.roomMetaId) return;
  bridge.openVideo({
    metaId: ui.roomMetaId, mediaType: ui.roomMediaType, videoKey: ui.roomVideoKey,
    title: ui.roomTitle, streamKey: ui.roomStreamKey,
  });
}

/** The local user switched what they're watching (active target changed).
 *  Updates presence + the sync gate. The actual snap-to-room is DEFERRED to
 *  resyncToRoom() on first decoded frame — seeking/pausing a stream that hasn't
 *  loaded yet is a no-op on this libmpv build, so a member who Joins would land
 *  un-synced (playing from 0 while the party is paused mid-film). */
export function notifyLocalVideo(): void {
  if (ui.status !== "connected" || !bridge) return;
  const local = bridge.getLocal();
  send({ t: "video", videoKey: local.videoKey, title: local.title });
  recomputeSync();
  emit();
}

/** Snap local playback to the current room state — call once the local stream
 *  has its first frame (so the seek/pause actually lands). Safe no-op unless we
 *  are in sync on the room's title with a known room state. */
export function resyncToRoom(): void {
  if (!bridge || !ui.inSync || !lastRoomState) return;
  applyRemote(lastRoomState.paused, expectedPosition(lastRoomState));
}
