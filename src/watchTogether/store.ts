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
  WatchMember, RoomState, ServerMsg, PlaybackBridge, VotePoll, MemberStat,
} from "./types";
import { showPartyToast } from "../PartyToast";

const LS_URL = "aura.watch.relayUrl";
const LS_NAME = "aura.watch.displayName";
const LS_TOKEN = "aura.watch.appToken";
const LS_CLIENT_ID = "aura.watch.clientId";
const LS_CLIENT_SECRET = "aura.watch.clientSecret";

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

/** Per-install secret that proves to the relay we own our cid, so nobody who
 *  knows the room code can connect claiming our cid to steal our roster slot or
 *  leader crown (the relay binds cid -> hash(secret) on first use and rejects a
 *  mismatch). Auto-generated once, stored locally, NEVER shown to the user or
 *  typed — zero friction, same UX as before (just a room code). */
function getClientSecret(): string {
  try {
    const existing = localStorage.getItem(LS_CLIENT_SECRET);
    if (existing) return existing;
  } catch { /* ignore */ }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, no padding (~43 chars) — URL-safe for the connect query param.
  const secret = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { localStorage.setItem(LS_CLIENT_SECRET, secret); } catch { /* ignore */ }
  return secret;
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

export type WatchStatus = "idle" | "connecting" | "connected" | "error" | "not-found";

export interface WatchUiState {
  status: WatchStatus;
  roomCode: string | null;
  selfId: string | null;
  members: WatchMember[];
  /** The room's current leader (host) cid, as the relay reports it — drives the
   *  crown, the transfer affordance, and the leader-only playback gate. */
  leaderId: string | null;
  /** The code that was just refused (status === "not-found") — drives the
   *  Lobby's "no one is hosting X — create it?" affordance. */
  pendingCode: string | null;
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
  /** "Vote to Watch" polls currently open (relay-authoritative, ≤3). */
  activeVotes: VotePoll[];
  /** Won votes pinned on screen until manually dismissed (click → details). */
  wonVotes: VotePoll[];
  /** Transient error (e.g. 3-vote cap reached); auto-clears. */
  voteError: string | null;
  /** Per-member buffer telemetry (readahead seconds + stall %), keyed by member
   *  id, broadcast over the relay (throttled). Drives the per-member buffer
   *  readout in the party panel. Includes self. Pruned to the live roster. */
  memberStats: Record<string, MemberStat>;
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
  leaderId: null,
  pendingCode: null,
  ...BLANK_ROOM,
  amStaging: false,
  inSync: false,
  isLeader: false,
  error: null,
  activeVotes: [],
  wonVotes: [],
  voteError: null,
  memberStats: {},
};

// ── Connection / runtime (not part of the emitted UI state) ────────────────
let ws: WebSocket | null = null;
let serverClockOffset = 0; // serverNow − Date.now() at welcome
let leaderTimer: ReturnType<typeof setInterval> | null = null;
let userLeft = false; // distinguishes a deliberate leave from a dropped socket
let roomNotFound = false; // set on a `room-not-found` frame so onclose doesn't reconnect
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let bridge: PlaybackBridge | null = null;
let lastApplyAt = 0; // throttles applied remote seeks (APPLY_MIN_INTERVAL_MS)
let localStaging = false; // are WE currently holding a stream for the party?
let lastRoomState: RoomState | null = null; // for snap-to-room on becoming in-sync
// Buffer-broadcast throttle: we send our buffer stat at most every
// BUFFER_SEND_INTERVAL_MS, plus immediately when the stall state flips so a
// member buffering shows up promptly.
const BUFFER_SEND_INTERVAL_MS = 2000;
// A stall flip sends sooner than the interval — but never faster than this, so a
// rapid stall/unstall hiccup can't spam the relay with a burst of stat frames.
const BUFFER_FLIP_MIN_GAP_MS = 600;
let lastBufferSentAt = 0;
let lastBufferStalled = false;
// Coalesce re-renders from inbound peer stats (≤ a few/sec across the party).
let statEmitTimer: ReturnType<typeof setTimeout> | null = null;
function emitStatsCoalesced() {
  if (statEmitTimer) return;
  statEmitTimer = setTimeout(() => { statEmitTimer = null; emit(); }, 400);
}
// Member ids from the last roster — diffed to fire join/leave toasts. Diffing by
// id (stable across reconnects via the cid) avoids false join/leave on reconnect.
let previousMemberIds = new Set<string>();
// Deferred "left" toasts, keyed by member id. A member's transient reconnect
// blip drops them from the roster then re-adds them; deferring the "left" toast
// (and cancelling it if they return) stops bystanders seeing "X left" → "X
// joined" for a wifi hiccup.
const pendingLeaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearPendingLeaves() {
  for (const t of pendingLeaveTimers.values()) clearTimeout(t);
  pendingLeaveTimers.clear();
}
// Member ids we've already announced as PRESENT (a join toast fired, or they
// were in the roster at welcome). Makes join toasts idempotent — an unstable
// peer flapping across the leave-grace window can't re-toast. An id is removed
// only when its deferred "left" toast actually fires, so a genuine rejoin
// re-toasts.
let toastedMembers = new Set<string>();

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
  // Ambiguity-free alphabet (no O/0/I/1) — easy to read aloud / type. Exactly 32
  // symbols, so `byte % 32` is unbiased (256 is a multiple of 32); no rejection
  // sampling needed. 8 chars = 40 bits of entropy, well past casual enumeration
  // of live rooms (the relay leaks only a roster + title even to a lucky guess).
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const LEN = 8;
  let out = "";
  const buf = new Uint8Array(LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < LEN; i++) out += alpha[buf[i] % alpha.length];
  return out;
}

/** Normalize a user-typed code to the relay's accepted shape (A-Z0-9, 4-16).
 *  Returns null + surfaces an error if it can't be made valid. */
function normalizeCode(code: string): string | null {
  const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length < 4 || c.length > 16) {
    setError("Room codes are 4–16 letters or numbers.");
    return null;
  }
  return c;
}

/** Create a new room (you become the first member / host). Returns the code. */
export function createRoom(): string | null {
  const code = genCode();
  return connect(code, "create") ? code : null;
}

/** Create a room with a SPECIFIC code (the "create it instead" affordance after
 *  a join found no host). Returns the code, or null if the code is invalid. */
export function createRoomWithCode(code: string): string | null {
  const c = normalizeCode(code);
  if (!c) return null;
  return connect(c, "create") ? c : null;
}

export function joinRoom(code: string): boolean {
  const c = normalizeCode(code);
  if (!c) return false;
  return connect(c, "join");
}

export function leaveRoom(): void {
  // Tell the relay we're leaving DELIBERATELY (before teardown closes the
  // socket) so the leader crown hands off permanently to the next member and
  // the room sees our departure promptly (vs. waiting for CF to reap the dead
  // socket). Best-effort — only sendable when OPEN. If we're still CONNECTING
  // (a reconnect in flight), bye is skipped, but the relay's webSocketClose
  // still resolves the next effective leader; the only thing missed is the
  // explicit permanent promotion, which is moot since a deliberate leaver sets
  // userLeft and won't reconnect to reclaim.
  if (ws && ws.readyState === WebSocket.OPEN) send({ t: "bye" });
  userLeft = true;
  localStaging = false;
  teardown();
  ui.status = "idle";
  ui.roomCode = null;
  ui.selfId = null;
  ui.members = [];
  ui.leaderId = null;
  ui.pendingCode = null;
  Object.assign(ui, BLANK_ROOM);
  ui.amStaging = false;
  ui.inSync = false;
  ui.isLeader = false;
  ui.error = null;
  ui.activeVotes = [];
  ui.wonVotes = [];
  ui.voteError = null;
  ui.memberStats = {};
  previousMemberIds = new Set();
  toastedMembers = new Set();
  lastBufferSentAt = 0;
  lastBufferStalled = false;
  emit();
}

function connect(code: string, intent: "join" | "create", isReconnect = false): boolean {
  const base = getRelayUrl();
  if (!base) {
    setError("Set a relay URL in Settings → Watch Together first.");
    return false;
  }
  teardown();
  userLeft = false;
  roomNotFound = false;
  // A fresh user-initiated connect (create / join) re-arms the retry budget; the
  // internal reconnect path passes isReconnect=true so it keeps counting down.
  // Without this a NEW party inherits an exhausted counter from a prior failed
  // session and gets zero reconnects on its first transient drop.
  if (!isReconnect) reconnectAttempts = 0;
  ui.status = "connecting";
  ui.roomCode = code;
  ui.pendingCode = null;
  ui.error = null;
  emit();

  let url: string;
  try {
    url = buildUrl(base, code, intent);
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
  ws.onclose = (ev) => {
    stopLeaderTimer();
    if (userLeft || roomNotFound) return;
    // A join to a room nobody is hosting is closed by the relay with the app
    // code 4404 — settle into not-found (don't reconnect, which would auto-
    // create). This is the reliable signal even if the room-not-found frame
    // didn't flush before the close.
    if (ev.code === 4404) { enterNotFound(ui.roomCode); return; }
    // Clear the SHARED staging/sync flags so the pause gate (wtStagedHold reads
    // ui.staging && ui.inSync) lifts in lock-step with the banner hiding during
    // the "connecting" window — otherwise the host sees the banner vanish (it's
    // gated on status==="connected") while the gate stays stale-active, then it
    // snaps back on reconnect. localStaging/amStaging are KEPT (the relay
    // re-ingests staging on welcome; the leader's re-assert below reconciles it).
    ui.staging = false;
    ui.inSync = false;
    emit();
    // Unexpected drop — try a few reconnects before giving up.
    if (reconnectAttempts < RECONNECT_MAX && ui.roomCode) {
      reconnectAttempts += 1;
      ui.status = "connecting";
      emit();
      // Reconnect with the intent appropriate to OUR role: a former leader /
      // creator re-establishes the room ("create"); a follower rejoins ("join")
      // so that if the host has since closed the room the relay's 4404 fires and
      // we settle into "no one is hosting" — instead of resurrecting a dead room
      // with "create" and silently becoming its new (blank) leader.
      const reIntent = ui.isLeader ? "create" : "join";
      reconnectTimer = setTimeout(() => connect(ui.roomCode as string, reIntent, true), 1500 * reconnectAttempts);
    } else {
      ui.status = "error";
      ui.error = ui.error ?? "Lost the watch-together connection.";
      emit();
    }
  };
  return true;
}

function buildUrl(base: string, code: string, intent: "join" | "create"): string {
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
  params.set("cs", getClientSecret()); // per-install ownership proof (see relay auth.js)
  // join → the relay refuses to auto-create if nobody's hosting (so we can
  // offer "create it"). create/reconnect → auto-create / re-establish.
  params.set("intent", intent);
  const v = bridge?.getLocal().videoKey ?? "";
  if (v) params.set("video", v);
  const token = getAppToken();
  if (token) params.set("t", token);
  // `new URL` validates the result and throws on garbage.
  return new URL(`${b}/room/${code}?${params.toString()}`).toString();
}

function teardown() {
  stopLeaderTimer();
  clearPendingLeaves(); // stale deferred-leave toasts must not fire across a (re)connect
  ui.memberStats = {}; // transient buffer stats don't survive a (re)connect — they repopulate
  if (statEmitTimer) { clearTimeout(statEmitTimer); statEmitTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // A pending vote-error timeout would otherwise fire into a torn-down / re-
  // connected room, emitting a stale error. Clear it with the rest.
  if (voteErrorTimer) { clearTimeout(voteErrorTimer); voteErrorTimer = null; ui.voteError = null; }
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

/** Settle into the "no one is hosting this code" state (the Lobby then offers
 *  "create it instead"). Sets roomNotFound so onclose won't reconnect, tears the
 *  socket down, and stashes the code for the create affordance. Driven by BOTH a
 *  `room-not-found` frame and a 4404 close code (whichever arrives). */
function enterNotFound(code: string | null) {
  roomNotFound = true;
  teardown();
  ui.status = "not-found";
  ui.pendingCode = code;
  ui.roomCode = null;
  ui.selfId = null;
  ui.members = [];
  ui.leaderId = null;
  ui.error = null;
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
    case "welcome": {
      reconnectAttempts = 0; // proven-healthy connection — re-arm the cap
      ui.selfId = msg.selfId;
      ui.leaderId = msg.leaderId ?? null;
      serverClockOffset = msg.serverNow - Date.now();
      ui.members = msg.members;
      previousMemberIds = new Set(msg.members.map((m) => m.id)); // seed (no join toasts on welcome)
      toastedMembers = new Set(msg.members.map((m) => m.id)); // everyone present is already "announced"
      recomputeLeader(); // needs members + selfId + leaderId — before ingest so we know ownership
      // A reconnecting LEADER already on the room's ESTABLISHED title re-asserts
      // its CURRENT local playback over the relay's persisted state, which can be
      // stale (e.g. we started playing during the drop — a control that never
      // broadcast). For that case we ingest labels WITHOUT driving local playback
      // (`drive=false`), so the leader isn't snapped to the relay's stale paused
      // snapshot, then re-broadcast our true local state. Guarded on already
      // owning the title, so a fresh room isn't auto-seeded with whatever we're
      // watching. If we're now playing, staging is over — clear it.
      const local = bridge?.getLocal();
      const ownerReconnect =
        ui.isLeader && local != null && local.videoKey != null && local.videoKey === msg.state.videoKey;
      ingestRoomState(msg.state, !ownerReconnect);
      if (ownerReconnect && local) {
        if (!local.paused) { localStaging = false; ui.amStaging = false; }
        broadcastControl(local.paused, local.position);
      }
      emit();
      break;
    }
    case "members": {
      const prevLeader = ui.leaderId;
      ui.leaderId = msg.leaderId ?? null;
      // Diff against the last roster (by stable id) to toast true joins/leaves —
      // never for self, never on the initial welcome (seeded there).
      const newIds = new Set(msg.members.map((m) => m.id));
      // Joins — but a member RETURNING within the leave grace window is a
      // reconnect blip, not a join: cancel the pending "left", emit nothing.
      // toastedMembers makes the announcement idempotent (no re-toast on a
      // flapping peer or a duplicate frame).
      for (const m of msg.members) {
        if (m.id === ui.selfId || previousMemberIds.has(m.id)) continue;
        const pending = pendingLeaveTimers.get(m.id);
        if (pending) {
          clearTimeout(pending);
          pendingLeaveTimers.delete(m.id);
          toastedMembers.add(m.id); // returned within grace — still present
        } else if (!toastedMembers.has(m.id)) {
          toastedMembers.add(m.id);
          showPartyToast(`${m.name} joined the party`, { tone: "success" });
        }
      }
      // Leaves — DEFERRED so a transient reconnect (the member reappears within
      // the window) doesn't flash "left" then "joined" on every bystander.
      for (const m of ui.members) {
        if (m.id === ui.selfId || newIds.has(m.id) || pendingLeaveTimers.has(m.id)) continue;
        const { id, name } = m;
        const timer = setTimeout(() => {
          pendingLeaveTimers.delete(id);
          toastedMembers.delete(id); // truly gone — a later rejoin re-toasts
          delete ui.memberStats[id]; // drop their buffer readout too
          if (ui.status === "connected") showPartyToast(`${name} left the party`, { tone: "default" });
        }, 6000);
        pendingLeaveTimers.set(id, timer);
      }
      previousMemberIds = newIds;
      ui.members = msg.members;
      // Diagnostic: the staging "X of Y ready" + the follower's sync gate both
      // hinge on each member's videoKey matching the room's. A mismatch (e.g.
      // the leader and a member resolve different episode-id schemes for the
      // SAME episode) leaves the leader stuck "1 of N" and the follower never
      // in-sync. Log the comparison so a 2-device test shows exactly which key
      // diverges.
      console.info(
        `[watch] roster (${msg.members.length}) roomVideoKey=${ui.roomVideoKey ?? "none"} ` +
          `members=[${msg.members.map((m) => `${m.name}=${m.videoKey ?? "none"}${m.videoKey === ui.roomVideoKey ? "✓" : "✗"}`).join(", ")}]`,
      );
      // Drop buffer stats for members who left.
      for (const id of Object.keys(ui.memberStats)) {
        if (!newIds.has(id)) delete ui.memberStats[id];
      }
      // Announce a leadership change (transfer or handoff) — but not the initial
      // assignment (prevLeader null) or a no-op repeat.
      if (ui.leaderId && prevLeader && ui.leaderId !== prevLeader) {
        const ldr = msg.members.find((m) => m.id === ui.leaderId);
        if (ui.leaderId === ui.selfId) showPartyToast("You're the host now", { tone: "leader" });
        else if (ldr) showPartyToast(`${ldr.name} is the host now`, { tone: "leader" });
      }
      recomputeLeader();
      recomputeSync();
      emit();
      break;
    }
    case "control": {
      const prevKey = ui.roomVideoKey;
      ingestRoomState(msg);
      // The host just selected / changed the party stream — call attention to
      // it for followers who aren't on it yet (a once-per-change toast; the pill
      // also animates while roomVideoKey is set but we're not in sync).
      if (!ui.isLeader && ui.roomVideoKey != null && ui.roomVideoKey !== prevKey && !ui.inSync) {
        showPartyToast("Stream selected", { tone: "leader" });
      }
      emit();
      break;
    }
    case "tick":
      applyTick(msg.position, msg.paused, msg.speed, msg.driverId);
      break;
    case "video":
      // Presence-only; the following `members` frame carries the roster.
      break;
    case "stat": {
      // A peer's buffer telemetry — store it for the per-member readout. Never
      // our own echo (we set self locally in notifyLocalBuffer).
      if (msg.from && msg.from !== ui.selfId) {
        ui.memberStats[msg.from] = {
          pct: typeof msg.pct === "number" ? msg.pct : null,
          seconds: typeof msg.seconds === "number" ? msg.seconds : null,
          stalled: !!msg.stalled,
          ts: Date.now(),
        };
        emitStatsCoalesced();
      }
      break;
    }
    case "votes":
      ui.activeVotes = msg.votes;
      emit();
      break;
    case "vote-won": {
      // Pin EVERY distinct winner — two near-simultaneous wins must not clobber
      // each other (an earlier agreed title would silently vanish). Newest first,
      // deduped, capped so a long session can't grow the pinned list unbounded.
      // Drop it from the active list immediately (the trailing `votes` frame
      // confirms, but don't wait for it).
      if (!ui.wonVotes.some((v) => v.id === msg.vote.id)) {
        ui.wonVotes = [msg.vote, ...ui.wonVotes].slice(0, 5);
      }
      ui.activeVotes = ui.activeVotes.filter((v) => v.id !== msg.vote.id);
      emit();
      break;
    }
    case "vote-error":
      setVoteError(msg.reason);
      break;
    case "room-not-found":
      // A join found no host — surface the "create it instead" affordance. (The
      // 4404 close code in onclose is the fallback if this frame doesn't land.)
      enterNotFound(msg.code || ui.roomCode);
      break;
    default:
      break;
  }
}

/** Adopt a new shared room state — update the "what we're watching" labels and,
 *  if we're on that title, snap local playback to it. `drive=false` updates the
 *  labels but does NOT touch local playback — used when a reconnecting
 *  owner-leader re-asserts (its own local state is authoritative; snapping it to
 *  the relay's possibly-stale paused snapshot would pause a leader who started
 *  playing during the drop). */
function ingestRoomState(state: RoomState, drive = true) {
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
  if (!drive || !ui.inSync || !bridge) return;
  const target = expectedPosition(state);
  applyRemote(state.paused, target, state.speed ?? 1);
}

/** Drift correction from the leader's tick. Only nudge when we're in sync and
 *  the room is playing, and only past the threshold. Ticks are honored ONLY
 *  from the current leader — this rejects a stale ex-leader's in-flight tick
 *  during a membership change and a non-leader peer spamming forged ticks. */
function applyTick(position: number, paused: boolean, speed: number | undefined, driverId: string | null) {
  if (!ui.inSync || !bridge || paused) return;
  if (!driverId || driverId !== effectiveLeaderId()) return;
  const local = bridge.getLocal();
  const spd = Number.isFinite(speed) && (speed as number) > 0 ? (speed as number) : local.speed;
  // Self-heal a locally-paused follower while the room is PLAYING (we passed the
  // `paused` guard above, and the leader only ticks when it is itself playing).
  // A pause that did not come from a leader control frame (a minimize-edge, a
  // buffering stall, a missed resume) is otherwise never corrected by ticks and
  // sticks until the host next acts — a silent, sticky desync. The driverId
  // guard above means a forged tick can't trigger this resume.
  if (local.paused) {
    applyRemote(false, position, spd);
    return;
  }
  if (Math.abs(local.position - position) > DRIFT_THRESHOLD_S) {
    applyRemote(false, position, spd);
  } else if (Math.abs(spd - local.speed) > 0.01) {
    // Position is fine but the leader's speed drifted (e.g. a missed control
    // frame) — match it WITHOUT a seek (position === local.position so apply's
    // seek check is a no-op). Keeps followers locked to the leader's speed.
    applyRemote(false, local.position, spd);
  }
}

/** Extrapolate the room's current position from a state stamped at updatedAt
 *  (server clock). */
function expectedPosition(state: RoomState): number {
  if (state.paused) return state.position;
  const serverNow = Date.now() + serverClockOffset;
  const elapsed = Math.max(0, (serverNow - state.updatedAt) / 1000);
  // The room playhead advances at the leader's SPEED, so a non-1x leader moved
  // `elapsed * speed` seconds since updatedAt. Extrapolating raw wall-seconds
  // would land a joiner / resyncer `elapsed*(speed-1)` behind on the first snap.
  const spd = state.speed && state.speed > 0 ? state.speed : 1;
  return state.position + elapsed * spd;
}

function applyRemote(paused: boolean, position: number, speed = 1) {
  if (!bridge) return;
  if (!Number.isFinite(position)) return; // reject NaN/Inf — would yank to 0
  // Throttle a flood of applied seeks (a buggy/malicious peer), but NEVER drop
  // a genuine pause-state change OR a speed change — both must always land (a
  // stale speed is exactly what makes a follower drift and re-seek forever).
  const local = bridge.getLocal();
  const spd = Number.isFinite(speed) && speed > 0 ? speed : local.speed;
  const speedChanged = Math.abs(spd - local.speed) > 0.01;
  const now = Date.now();
  if (paused === local.paused && !speedChanged && now - lastApplyAt < APPLY_MIN_INTERVAL_MS) return;
  lastApplyAt = now;
  bridge.apply(paused, position, spd);
}

function recomputeSync() {
  const local = bridge?.getLocal().videoKey ?? null;
  ui.inSync = ui.roomVideoKey != null && local != null && local === ui.roomVideoKey;
}

/** Fallback leader = lowest member id (deterministic across clients). Used only
 *  before the first leader-bearing frame arrives, or against an un-redeployed
 *  relay; normally the relay-provided ui.leaderId wins. */
function leaderId(): string | null {
  if (ui.members.length === 0) return null;
  return ui.members.reduce((a, m) => (m.id < a ? m.id : a), ui.members[0].id);
}

/** The effective leader cid this client believes in (relay value, else fallback). */
function effectiveLeaderId(): string | null {
  return ui.leaderId ?? leaderId();
}

function recomputeLeader() {
  if (!ui.selfId || ui.members.length === 0) {
    ui.isLeader = false;
    stopLeaderTimer();
    return;
  }
  const isLeader = ui.selfId === effectiveLeaderId();
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
    send({ t: "tick", position: local.position, paused: false, speed: local.speed });
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
export function notifyLocalControl(next?: { paused: boolean; position: number; speed?: number }): void {
  if (ui.status !== "connected" || !bridge) return;
  const local = bridge.getLocal();
  // No syncable title locally (e.g. LIVE TV reports a null videoKey) — never
  // broadcast. Critical for a LEADER on live: a null-identity control frame
  // would otherwise hit the relay's `?? prev` fallback and RESURRECT the old
  // VOD party stream, yanking every follower to the leader's live playhead.
  if (local.videoKey == null) return;
  // ONLY the party LEADER drives the party's playback (play/pause/seek) and the
  // stream identity. A follower never broadcasts — the relay drops their control
  // frames too, and the player UI disables their transport controls. (This
  // supersedes the old "in-sync follower may also drive" behaviour.)
  if (!ui.isLeader) return;
  broadcastControl(next?.paused ?? local.paused, next?.position ?? local.position, next?.speed);
}

/** LEADER ONLY — hand the host crown to another connected member. The relay
 *  validates (current leader + target present) and broadcasts the new leaderId. */
export function transferLeader(targetId: string): void {
  if (ui.status !== "connected" || !ui.isLeader || !targetId || targetId === ui.selfId) return;
  send({ t: "set-leader", target: targetId });
}

/** Send a full control frame AND mirror it into the local room state — we
 *  never receive our own frames, so without this our own inSync / room labels
 *  would lag what we just told everyone else. */
function broadcastControl(paused: boolean, position: number, speed?: number) {
  if (!bridge) return;
  const local = bridge.getLocal();
  // Leader's playback speed — the explicit value when this broadcast IS the
  // speed change, else the current local speed (so play/pause/seek frames carry
  // the leader's current speed for late-applying followers).
  const spd = Number.isFinite(speed) && (speed as number) > 0 ? (speed as number) : (local.speed ?? 1);
  // Belt-and-suspenders: an OWNER must never emit an identity-null control frame
  // (live TV) — the relay would reconstitute the prior identity from `?? prev`.
  if ((ui.isLeader || ui.roomVideoKey == null) && local.videoKey == null) return;
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
    t: "control", paused, position, speed: spd,
    videoKey, metaId, mediaType, title, streamLabel, streamKey, staging,
  });
  emit();
}

/** Start (or switch) the party's stream and HOLD it (staging) for the party to
 *  join. Bypasses the in-sync gate — this IS the new party content. LEADER ONLY
 *  (only the leader delegates a stream); called by the host right after their
 *  stream loads (paused). */
export function startPartyStream(): void {
  if (ui.status !== "connected" || !bridge || !ui.isLeader) return;
  localStaging = true;
  broadcastControl(true, 0);
}

/** LEADER ONLY — clear the party's selected stream so the NEXT stream the
 *  leader plays (re-)establishes it (even the same title). Resets the room to
 *  blank (the relay's `clear-stream` handler writes the blank state explicitly,
 *  bypassing its identity-preserving `?? prev` fallback). */
export function clearPartyStream(): void {
  if (ui.status !== "connected" || !ui.isLeader) return;
  localStaging = false;
  send({ t: "clear-stream" });
  // We never receive our own frames — blank the local room state optimistically.
  Object.assign(ui, BLANK_ROOM);
  ui.amStaging = false;
  recomputeSync();
  emit();
}

/** Is there a party stream currently delegated? (drives the leader's "Clear
 *  stream" affordance.) */
export function hasPartyStream(): boolean {
  return ui.roomVideoKey != null;
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
  console.info(
    `[watch] local video → videoKey=${local.videoKey ?? "none"} (roomVideoKey=${ui.roomVideoKey ?? "none"}, inSync=${ui.inSync})`,
  );
  recomputeSync();
  emit();
}

/** Snap local playback to the current room state — call once the local stream
 *  has its first frame (so the seek/pause actually lands). Safe no-op unless we
 *  are in sync on the room's title with a known room state. */
export function resyncToRoom(): void {
  if (!bridge || !ui.inSync || !lastRoomState) return;
  applyRemote(lastRoomState.paused, expectedPosition(lastRoomState), lastRoomState.speed ?? 1);
}

/** The party's current synced position (extrapolated from the last room state),
 *  so a follower opening the party stream can BYPASS the resume prompt and land
 *  in sync. Null when there's no established room stream yet (caller falls back
 *  to 0; resyncToRoom fine-tunes on the first decoded frame). */
export function getPartyStartPosition(): number | null {
  if (ui.roomVideoKey == null || !lastRoomState) return null;
  const p = expectedPosition(lastRoomState);
  return Number.isFinite(p) ? Math.max(0, p) : null;
}

/** Feed local buffer telemetry (from the engine's cache poll) to the party.
 *  Throttled: sent at most every BUFFER_SEND_INTERVAL_MS, plus immediately when
 *  the stall state flips. Also stamps our own entry for the local readout. */
export function notifyLocalBuffer(info: { pct: number | null; seconds: number | null; stalled: boolean }): void {
  if (ui.status !== "connected" || ui.selfId == null) return;
  const now = Date.now();
  // Send every BUFFER_SEND_INTERVAL_MS, or sooner on a stall flip — but never
  // faster than BUFFER_FLIP_MIN_GAP_MS, so a flapping stall can't burst-spam.
  const minGap = info.stalled !== lastBufferStalled ? BUFFER_FLIP_MIN_GAP_MS : BUFFER_SEND_INTERVAL_MS;
  if (now - lastBufferSentAt < minGap) return;
  lastBufferSentAt = now;
  lastBufferStalled = info.stalled;
  ui.memberStats[ui.selfId] = { pct: info.pct, seconds: info.seconds, stalled: info.stalled, ts: now };
  send({ t: "stat", pct: info.pct, seconds: info.seconds, stalled: info.stalled });
  emit();
}

// ── Vote to Watch ────────────────────────────────────────────────────────────

/** Total lifetime of a poll (mirrors the relay's VOTE_TTL_MS) — the denominator
 *  for the countdown ring. */
export const VOTE_TOTAL_MS = 60 * 1000;
export const VOTE_MAX_ACTIVE = 3;

let voteErrorTimer: ReturnType<typeof setTimeout> | null = null;
function setVoteError(reason: string) {
  ui.voteError = reason;
  emit();
  if (voteErrorTimer) clearTimeout(voteErrorTimer);
  voteErrorTimer = setTimeout(() => { ui.voteError = null; emit(); }, 4000);
}
export function clearVoteError(): void {
  if (voteErrorTimer) { clearTimeout(voteErrorTimer); voteErrorTimer = null; }
  ui.voteError = null;
  emit();
}

/** Propose a "Vote to Watch" poll for a catalog item. Returns false (with a
 *  surfaced error) if not in a party or the 3-vote cap is already reached. */
export function startVote(item: {
  metaId: string; mediaType: string | null; title: string; poster: string | null;
}): boolean {
  if (ui.status !== "connected") {
    setVoteError("Join a watch party first.");
    return false;
  }
  // Guard against the LIVE polls only — a client-expired-but-not-yet-swept poll
  // (quiet room, no relay traffic since its deadline) must not falsely block a
  // new proposal that the relay would actually accept.
  const live = ui.activeVotes.filter((v) => voteRemainingMs(v) > 0);
  if (live.length >= VOTE_MAX_ACTIVE) {
    setVoteError(`Only ${VOTE_MAX_ACTIVE} votes can run at once.`);
    return false;
  }
  if (live.some((v) => v.metaId === item.metaId)) {
    setVoteError("There's already a vote for that title.");
    return false;
  }
  send({
    t: "vote-start",
    metaId: item.metaId, mediaType: item.mediaType,
    title: item.title, poster: item.poster,
  });
  return true;
}

/** Cast (or change is not allowed — one vote per member) on an active poll. */
export function castVote(voteId: string, choice: "yes" | "no"): void {
  if (ui.status !== "connected") return;
  send({ t: "vote-cast", voteId, choice });
}

/** Whether WE have already cast on a poll (drives button state). */
export function haveVoted(vote: VotePoll): boolean {
  return ui.selfId != null && vote.voters.includes(ui.selfId);
}

/** Remaining ms on a poll, on our calibrated view of the server clock. */
export function voteRemainingMs(vote: VotePoll): number {
  return Math.max(0, vote.expiresAt - (Date.now() + serverClockOffset));
}

export function dismissWonVote(id: string): void {
  ui.wonVotes = ui.wonVotes.filter((v) => v.id !== id);
  emit();
}
