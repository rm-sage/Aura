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
  roomTitle: string | null;
  /** True when local playback is on the room's title (sync is active). */
  inSync: boolean;
  isLeader: boolean;
  error: string | null;
}

const ui: WatchUiState = {
  status: "idle",
  roomCode: null,
  selfId: null,
  members: [],
  roomVideoKey: null,
  roomTitle: null,
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
export function getRelayUrl(): string {
  try { return localStorage.getItem(LS_URL) || ""; } catch { return ""; }
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
  teardown();
  ui.status = "idle";
  ui.roomCode = null;
  ui.selfId = null;
  ui.members = [];
  ui.roomVideoKey = null;
  ui.roomTitle = null;
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
      ingestRoomState({
        paused: msg.paused, position: msg.position, videoKey: msg.videoKey,
        title: msg.title, updatedAt: msg.updatedAt, driverId: msg.driverId,
      });
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
  ui.roomVideoKey = state.videoKey;
  ui.roomTitle = state.title;
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
  send({
    t: "control",
    paused: next?.paused ?? local.paused,
    position: next?.position ?? local.position,
    videoKey: local.videoKey,
    title: local.title,
  });
}

/** The local user switched what they're watching (active target changed).
 *  Updates presence + re-evaluates whether we're in sync with the party. */
export function notifyLocalVideo(): void {
  if (ui.status !== "connected" || !bridge) return;
  const local = bridge.getLocal();
  send({ t: "video", videoKey: local.videoKey, title: local.title });
  recomputeSync();
  emit();
}
