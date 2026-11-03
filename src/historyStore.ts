// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// historyStore - per-account watch-history log.
//
// SCOPE - its own scope id (see getHistoryScope), "user-<prefix>" or "guest".
// Each entry captures one completion event: the user actually played content
// and crossed the 80 % threshold AND watched 5+ minutes. Manual
// mark-as-WATCHED is NOT recorded here, by contract: the user set state
// without playing, so there is nothing to log.
//
// SKIPS ARE THE ONE EXCEPTION (`skipped: true`). A skip is a deliberate
// decision that an episode is DONE, which is the same claim a play makes, and
// the user needs those rows to re-scrobble from. They carry no watched_seconds
// and are tagged in the History view so a skip is never mistaken for a play.
//
// STORAGE - a Rust-owned compact gzip file per scope under
// app_data_dir()/history (src-tauri/src/history_store.rs), with NO entry cap.
// It used to be localStorage `aura:history:<scope>` capped at 1000 rows,
// older rows silently dropped. This module keeps the synchronous read API
// over an in-memory array HYDRATED from Rust (`load`), and every write
// updates that array at once and sends the matching small mutation, so a
// finished play never ships the whole history over IPC.
//
// ORDERING - every Rust call goes through ONE promise chain, so Rust applies
// them in issue order, and `applyMutation` here is the exact mirror of
// history_store.rs's ops. Three calls replace the state wholesale (load, the
// legacy carry-over, a cloud merge) and resolve LATER than writes issued
// after them, so while one is in flight every write is also LOGGED with its
// sequence number, and when it lands the visible array is rebuilt as
// "its result, then every logged write issued after it". That is what lets a
// play recorded during startup, or during a cloud pull, survive both in
// memory and on disk without either clobbering the other.
//
// MIGRATION - the first load of a scope sends its localStorage copy (when one
// is still there); Rust unions it in, writes the file synchronously and reads
// it back, and only on `verified` is the key removed. A crash anywhere in
// between just repeats an idempotent union on the next launch: no loss, no
// duplicates. When that first write fails, the key is NOT left for the next
// launch: it would union back every row the user removes or clears in the
// meantime. Instead `flush` with the scope is retried (backing off, and right
// after every remove / clear / replace) until Rust reports the file verified,
// and the key goes then. The pre-user_id carry-over (`legacyScope`) is kept:
// for a scope with no history of its own, the legacy scope's FILE, else its
// localStorage copy, is carried in once. The legacy localStorage key itself
// stays put, as it always did.
//
// A LOAD THAT FAILS IS NOT AN EMPTY HISTORY. Rust fails `load` while the file
// exists but cannot be read (history_store.rs "A FILE THAT EXISTS"); this
// module keeps retrying, a few times quickly and then every 30 s, and the
// History view says it is retrying instead of "no history". A file that did
// not decode loads empty with `recovered`: the cloud copy must be merged
// before anything is pushed over it (`historyNeedsCloudMerge`, read by
// sync.ts). Rust persists that latch, so a restart reports it again. So does a
// signed-in scope with NO file: the sync etag lives in localStorage and can
// outlive it, and a pull that 304s would then let the next play replace the
// cloud copy. An etag vouches for the file, so no file means no etag.
//
// Each entry's primary key for removal purposes is `played_at` (ISO
// timestamp) + `id`; re-watching the same episode produces a new entry with a
// distinct timestamp.
// ---------------------------------------------------------------------------

/** The old localStorage home, read only by the one-time migration. */
const LEGACY_KEY_PREFIX = "aura:history:";
const CHANGE_EVENT = "aura:history-changed";
/** Quick retries of a failed hydration, then a slow retry for as long as the
 *  scope stays active: a file held open by another program is released
 *  eventually, and until then the store must not pretend to be empty. */
const LOAD_RETRIES = 3;
const LOAD_RETRY_MS = 3000;
const LOAD_RETRY_SLOW_MS = 30_000;
/** Back-off of the late removal of a migrated localStorage copy. */
const LEGACY_CLEANUP_FIRST_MS = 5000;
const LEGACY_CLEANUP_MAX_MS = 60_000;

export interface HistoryEntry {
  /** The canonical id played: episode id for series/anime, movie id
   *  otherwise. Used in conjunction with `played_at` as a removal key. */
  id: string;
  /** Series root id when the entry is an episode; absent for movies. */
  parent_id?: string;
  /** Display name. For series this is the SERIES name; episode title
   *  is in `episode_title`. */
  name: string;
  media_type: string;
  poster?: string | null;
  background?: string | null;
  /** Parsed season number for episode rows; null for movies. */
  season?: number | null;
  /** Parsed episode number; null for movies. */
  episode?: number | null;
  /** Optional episode title (when the addon shipped one). */
  episode_title?: string | null;
  /** The episode's air date (VideoEntry `released`), captured at play time.
   *  With `episode_title` it lets a later Trakt scrobble of this row fall back
   *  to Trakt's title + air-date lookup. Absent on older rows. */
  episode_released?: string | null;
  /** ISO 8601: when the user finished watching (or exited playback).
   *  Acts as the secondary key for removal. */
  played_at: string;
  /** Total runtime in seconds, when known. */
  duration?: number;
  /** How far into the file the user was at the time of write. Same
   *  semantics as state.timeOffset. */
  watched_seconds?: number;
  /** AIOMetadata's per-video AniList mapping, captured AT PLAY TIME from the
   *  VideoEntry (via ActiveScrobbleTarget).
   *
   *  These are what make AniList scrobbling correct for split-cour franchises.
   *  AniList models each cour as its own entry (Dr. STONE: 24 + 11 + 11 + ...),
   *  while the addon numbers season 4 cumulatively (S04E29). Without the
   *  embedded id, the resolver has to guess: it title-searches, walks SEQUEL
   *  relations looking for a cour with >= 29 episodes, finds none (each is ~11),
   *  and falls back to the base entry -- where 29 clamps to 24 and the save is
   *  skipped. The live-playback path already avoids all that by passing these
   *  through, but HISTORY rows never stored them, so the manual / bulk scrobble
   *  rebuilt a session without them and took the broken guessing path.
   *
   *  Absent on rows written before this field existed, and on non-anime; the
   *  resolver's title-search fallback still covers those. */
  anilist_id?: number | null;
  anilist_episode?: number | null;
  /** True when this row records a SKIP rather than a play.
   *
   *  Skips are the one exception to the "automatic playback only" rule in the
   *  module note above: they are a deliberate completion decision the user made
   *  about an episode, so they belong in the same log and stay re-scrobblable
   *  from it. They carry no watched_seconds, and the History view tags them so
   *  the two are never confused. */
  skipped?: boolean;
}

/** Why a change event fired. Only "mutation" is a LOCAL edit: cloud sync
 *  pushes and the auto-backup snapshots on it alone, so hydration and a
 *  cloud merge re-render the view without bouncing straight back out. An
 *  event with no detail (an older dispatcher) counts as a mutation. */
export type HistoryChangeReason = "mutation" | "hydrated" | "load-failed" | "scope" | "cloud";

export function historyChangeReason(e: Event): HistoryChangeReason {
  const r = (e as CustomEvent<{ reason?: HistoryChangeReason }>).detail?.reason;
  return r ?? "mutation";
}

type Key = { id: string; played_at: string };
type Mutation =
  | { op: "append"; entries: HistoryEntry[] }
  | { op: "remove"; keys: Key[] }
  | { op: "replace"; entries: HistoryEntry[] }
  | { op: "clear" };

let _activeScope = "guest";
let _entries: HistoryEntry[] = [];
let _loaded = false;
let _started = false;
/** Bumped on every (re)load; a late answer for an older load is dropped. */
let _token = 0;
let _seq = 0;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Why the active scope is not loaded, while a load is failing. */
let _loadError: string | null = null;
/** The active scope's file did not decode and was set aside, or it has none
 *  and the sync etag may have outlived it: no push until a cloud merge (or a
 *  pull that finds no cloud copy) has landed. */
let _needsCloudMerge = false;
/** A migration whose first write did not verify: the scope's localStorage
 *  copy is removed once a later `flush` verifies the file. */
let _legacyCleanup: { scope: string; token: number; delay: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

/** State as of the oldest in-flight base op, plus the writes logged since.
 *  Both are emptied the moment no base op is in flight. */
let _confirmed: HistoryEntry[] = [];
let _log: Array<{ seq: number; m: Mutation }> = [];
const _basesInFlight = new Set<number>();

let _ready: { promise: Promise<boolean>; resolve: (ok: boolean) => void } = newReady();

function newReady() {
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  return { promise, resolve };
}

let _chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = _chain.then(fn, fn);
  _chain = p.catch(() => undefined);
  return p;
}
function call<T>(action: Record<string, unknown>): Promise<T> {
  return enqueue(() => invoke<T>("history_store", { action }));
}

function dispatchChange(reason: HistoryChangeReason): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { reason } }));
}

function isEntry(e: unknown): e is HistoryEntry {
  return e != null && typeof e === "object"
    && typeof (e as HistoryEntry).id === "string"
    && typeof (e as HistoryEntry).played_at === "string";
}

/** The mirror of history_store.rs's ops. Never mutates `list` (base-op
 *  snapshots share array references with it). */
function applyMutation(list: HistoryEntry[], m: Mutation): HistoryEntry[] {
  switch (m.op) {
    case "append": {
      const out = list.slice();
      for (const entry of m.entries) {
        const i = out.findIndex((e) => e.id === entry.id && e.played_at === entry.played_at);
        if (i >= 0) out[i] = entry;
        else out.unshift(entry);
      }
      return out;
    }
    case "remove": {
      const drop = new Set(m.keys.map((k) => `${k.id}::${k.played_at}`));
      return list.filter((e) => !drop.has(`${e.id}::${e.played_at}`));
    }
    case "replace":
      return m.entries.filter(isEntry);
    case "clear":
      return [];
  }
}

/** history_store.rs `apply_cloud_merge`, replayed from its delta: the shared
 *  keys' FIRST occurrence takes the server row, new rows are appended in
 *  server order, then one stable sort newest first. */
function applyMergeDelta(list: HistoryEntry[], replaced: HistoryEntry[], added: HistoryEntry[]): HistoryEntry[] {
  if (replaced.length === 0 && added.length === 0) return list;
  const rep = new Map(replaced.map((e) => [`${e.id}::${e.played_at}`, e]));
  const out = list.map((e) => {
    const k = `${e.id}::${e.played_at}`;
    const r = rep.get(k);
    if (!r) return e;
    rep.delete(k);
    return r;
  });
  for (const e of added) out.push(e);
  out.sort((a, b) => (a.played_at < b.played_at ? 1 : a.played_at > b.played_at ? -1 : 0));
  return out;
}

function beginBase(): number {
  const seq = ++_seq;
  if (_basesInFlight.size === 0) {
    // Nothing else pending, so memory mirrors Rust exactly as of this seq.
    _confirmed = _entries;
    _log = [];
  }
  _basesInFlight.add(seq);
  return seq;
}

/** Land a base op. `compute` gets the state Rust had when the op ran and
 *  returns the state after it (null = unchanged, e.g. the call failed). Base
 *  ops settle in issue order because they share the chain. */
function settleBase(seq: number, compute: (atSeq: HistoryEntry[]) => HistoryEntry[] | null): void {
  let state = _confirmed;
  for (const l of _log) if (l.seq < seq) state = applyMutation(state, l.m);
  const next = compute(state) ?? state;
  _basesInFlight.delete(seq);
  _log = _log.filter((l) => l.seq > seq);
  let visible = next;
  for (const l of _log) visible = applyMutation(visible, l.m);
  _entries = visible;
  if (_basesInFlight.size === 0) {
    _confirmed = [];
    _log = [];
  } else {
    _confirmed = next;
  }
}

function rustAction(scope: string, m: Mutation): Record<string, unknown> {
  switch (m.op) {
    case "append":  return { op: "append", scope, entries: m.entries };
    case "remove":  return { op: "remove", scope, keys: m.keys };
    case "replace": return { op: "replace", scope, entries: m.entries };
    case "clear":   return { op: "clear", scope };
  }
}

/** The promise settles when Rust has applied (or refused) the write. Only a
 *  caller that reports the refusal needs it; the failure is logged either way. */
function mutate(m: Mutation, opts?: { silent?: boolean }): Promise<unknown> {
  ensureStarted();
  const scope = _activeScope;
  _entries = applyMutation(_entries, m);
  const seq = ++_seq;
  if (_basesInFlight.size > 0) _log.push({ seq, m });
  const done = call(rustAction(scope, m));
  void done.catch((e) => {
    // Rust keeps an append it cannot place (an unreadable file, a refused
    // scope swap), so this is a refused remove / replace / clear, which the
    // retried load takes back, or the IPC itself failing.
    console.warn(`[history] ${m.op} failed:`, e);
  });
  // A removal is exactly what a stale localStorage copy would undo on the
  // next launch: retry its cleanup right behind this write (same chain).
  if (m.op !== "append" && _legacyCleanup) runLegacyCleanup();
  if (!opts?.silent) dispatchChange("mutation");
  return done;
}

function cancelLegacyCleanup(): void {
  if (_legacyCleanup?.timer) clearTimeout(_legacyCleanup.timer);
  _legacyCleanup = null;
}

function scheduleLegacyCleanup(c: NonNullable<typeof _legacyCleanup>): void {
  if (c.timer) clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    c.timer = null;
    runLegacyCleanup();
  }, c.delay);
  c.delay = Math.min(c.delay * 2, LEGACY_CLEANUP_MAX_MS);
}

/** Ask Rust to write the scope durably and read it back; on `verified`, the
 *  migrated localStorage copy is redundant and goes. */
function runLegacyCleanup(): void {
  const c = _legacyCleanup;
  if (!c) return;
  if (c.timer) { clearTimeout(c.timer); c.timer = null; }
  if (c.token !== _token) { cancelLegacyCleanup(); return; }
  call<{ verified?: boolean }>({ op: "flush", scope: c.scope }).then(
    (res) => {
      if (_legacyCleanup !== c) return;
      if (c.token !== _token) { cancelLegacyCleanup(); return; }
      if (res?.verified) {
        try {
          localStorage.removeItem(`${LEGACY_KEY_PREFIX}${c.scope}`);
          console.info(`[history] migrated localStorage copy of ${c.scope} removed after a verified write`);
          cancelLegacyCleanup();
          return;
        } catch { /* retried below */ }
      }
      scheduleLegacyCleanup(c);
    },
    () => {
      if (_legacyCleanup === c && c.token === _token) scheduleLegacyCleanup(c);
    },
  );
}

// ── Hydration ──────────────────────────────────────────────────────────────

/** The scope's localStorage copy, or null when there is none. A key that
 *  does not parse is left alone (null): deleting it could only lose data a
 *  later fix might still read. */
function readLegacyKey(scope: string): HistoryEntry[] | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(`${LEGACY_KEY_PREFIX}${scope}`); } catch { return null; }
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : null;
  } catch {
    console.warn(`[history] localStorage history for ${scope} does not parse; leaving it in place`);
    return null;
  }
}

interface LoadResult {
  entries: HistoryEntry[];
  existed: boolean;
  verified: boolean;
  want_legacy_local: boolean;
  /** The file did not decode and was set aside, or this signed-in scope has no
   *  file: its rows are not known to match the cloud copy. */
  recovered?: boolean;
}

function startLoad(scope: string, legacyScope: string | null, attempt = 0): void {
  const token = ++_token;
  if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
  cancelLegacyCleanup();
  _needsCloudMerge = false;
  if (attempt === 0) _loadError = null;
  _loaded = false;
  // A retry is the same scope, and all it could hold is what was written while
  // the file was unreadable. Keep showing that: Rust holds those appends, so a
  // load that succeeds replaces these rows with a list that includes them.
  if (attempt === 0) _entries = [];
  _confirmed = [];
  _log = [];
  _basesInFlight.clear();
  // Wake anyone waiting on the previous scope; they re-check and wait on this one.
  _ready.resolve(false);
  _ready = newReady();

  const local = readLegacyKey(scope);
  const seq = beginBase();
  const finish = () => {
    if (token !== _token) return;
    _loaded = true;
    _loadError = null;
    _ready.resolve(true);
    dispatchChange("hydrated");
  };
  const fail = (e: unknown) => {
    if (token !== _token) return;
    console.warn(`[history] load of ${scope} failed (attempt ${attempt + 1}):`, e);
    _loadError = String(e);
    _ready.resolve(false);
    // Never give up for good: a failed load is a file Aura could not read
    // (history_store.rs refuses to call that empty), and a play recorded
    // meanwhile is held in Rust until it can be.
    _retryTimer = setTimeout(() => {
      _retryTimer = null;
      if (token === _token) startLoad(scope, legacyScope, attempt + 1);
    }, attempt + 1 < LOAD_RETRIES ? LOAD_RETRY_MS : LOAD_RETRY_SLOW_MS);
    // The view shows "retrying" instead of "loading".
    dispatchChange("load-failed");
  };

  call<LoadResult>({ op: "load", scope, local, legacy_scope: legacyScope }).then((res) => {
    if (token !== _token) return;
    if (local !== null) {
      let removed = false;
      if (res.verified) {
        try { localStorage.removeItem(`${LEGACY_KEY_PREFIX}${scope}`); removed = true; } catch { /* retried below */ }
      }
      if (!removed) {
        _legacyCleanup = { scope, token, delay: LEGACY_CLEANUP_FIRST_MS, timer: null };
        scheduleLegacyCleanup(_legacyCleanup);
      }
    }
    if (res.recovered) {
      _needsCloudMerge = true;
      console.warn(`[history] ${scope}: no usable history file; the cloud copy is merged before anything is pushed`);
    }
    settleBase(seq, () => (Array.isArray(res.entries) ? res.entries : []));
    const legacy = res.want_legacy_local && legacyScope ? readLegacyKey(legacyScope) : null;
    if (!legacy || legacy.length === 0) { finish(); return; }
    const mseq = beginBase();
    call<{ entries: HistoryEntry[]; verified: boolean }>({ op: "migrate", scope, entries: legacy }).then(
      (r2) => {
        if (token !== _token) return;
        settleBase(mseq, () => (Array.isArray(r2.entries) ? r2.entries : null));
        finish();
      },
      (e) => {
        if (token !== _token) return;
        settleBase(mseq, () => null);
        console.warn("[history] legacy carry-over failed:", e);
        finish();
      },
    );
  }, (e) => {
    if (token !== _token) return;
    settleBase(seq, () => null);
    fail(e);
  });
}

function ensureStarted(): void {
  if (_started) return;
  _started = true;
  startLoad(_activeScope, null);
}

/** Switch the active scope. Called from App.tsx on auth state changes
 *  alongside the settings + manualWatched scope swaps.
 *
 *  `legacyScope` is the auth_key-derived scope this user had before the
 *  post-0.6.x switch to user_id-based scoping. Pre-fix Aura keyed history by
 *  `auth_key.slice(0, 12)`, but Stremio rotates auth_keys on every login, so
 *  any login effectively created a fresh scope and orphaned the prior
 *  session's history. For a scope with no history of its own, the legacy
 *  scope's rows are carried over once (see MIGRATION above). */
export function setHistoryScope(
  scope: string | null,
  opts?: { legacyScope?: string | null },
): void {
  const next = scope && scope.trim() ? scope : "guest";
  if (next === _activeScope && _started) return;
  _activeScope = next;
  _started = true;
  const legacy = opts?.legacyScope?.trim() || null;
  startLoad(next, legacy && legacy !== next ? legacy : null);
  dispatchChange("scope");
}

/** The scope history is CURRENTLY keyed by.
 *
 *  Exists because history's scope deliberately differs from every other
 *  per-account store's: it follows the stable `user_id` so a fresh login
 *  (Stremio rotates auth_keys) does not orphan the play log, while
 *  manual-watched, skip marks and the backup ledger stay on the auth_key
 *  prefix. Anything that addresses history by scope rather than going
 *  through this module has to ask, instead of deriving a scope of its own and
 *  silently addressing a file nothing writes. */
export function getHistoryScope(): string {
  return _activeScope;
}

/** True once the active scope's rows are in memory. Before that,
 *  `getHistory()` holds only writes made since startup, so a view must show
 *  a loading state rather than "no history". */
export function isHistoryLoaded(): boolean {
  ensureStarted();
  return _loaded;
}

/** Set while the active scope's load is failing (it keeps retrying), so a
 *  view can say "retrying" rather than "loading" forever. */
export function historyLoadError(): string | null {
  return _loadError;
}

/** True while the active scope's file was set aside as unreadable, or is
 *  missing, and no cloud merge has landed since. sync.ts then pulls history in full (no
 *  If-None-Match: a 304 would skip the merge) and nothing is pushed: the
 *  near-empty list would replace the cloud copy, the only one left. */
export function historyNeedsCloudMerge(): boolean {
  return _needsCloudMerge;
}

/** The pull found NO cloud history for this account, so there is nothing to
 *  wait for: release the push latch, here and in Rust (it outlives a restart). */
export function noteHistoryCloudAbsent(scope: string): void {
  clearCloudTrim(scope);
  if (_needsCloudMerge) {
    _needsCloudMerge = false;
    console.info("[history] no cloud copy to recover from; pushes resume");
    void call({ op: "cloud_absent", scope }).catch((e) => {
      console.warn("[history] cloud_absent failed:", e);
    });
  }
}

/** Resolves true once the ACTIVE scope is hydrated (following scope switches
 *  made while waiting), false if its load failed. Anything that would treat
 *  the in-memory list as authoritative (a cloud push or merge, a backup)
 *  awaits this: before it, the list is empty or partial, and pushing it would
 *  publish a near-empty history as if it were the whole one. */
export async function historyReady(): Promise<boolean> {
  ensureStarted();
  for (;;) {
    if (_loaded) return true;
    const token = _token;
    const ok = await _ready.promise;
    if (_loaded) return true;
    if (!ok && token === _token) return false;
  }
}

/** Resolves after every history call issued so far has been applied in Rust. */
export function afterPendingHistoryWrites(): Promise<void> {
  return enqueue(async () => undefined);
}

/** Write the file now (before an updater relaunch, which skips the exit path). */
export function flushHistoryNow(): Promise<void> {
  return call<unknown>({ op: "flush" }).then(() => undefined, () => undefined);
}

// ── Writes ─────────────────────────────────────────────────────────────────

/** Append a new history entry. Older identical (id, played_at) pairs
 *  are deduped: the same finished play emitted twice doesn't double
 *  up the list. Newest entry is kept at index 0 for fast view render. */
export function addHistoryEntry(entry: HistoryEntry): void {
  if (!entry?.id || !entry.played_at) return;
  mutate({ op: "append", entries: [entry] });
}

/** Many entries, ONE Rust call and ONE change event (marking a 60-episode
 *  arc skipped used to be 60 full serialises and 60 re-renders). */
export function addHistoryEntries(entries: HistoryEntry[]): void {
  const fresh = entries.filter((e) => e?.id && e.played_at);
  if (fresh.length === 0) return;
  mutate({ op: "append", entries: fresh });
}

/** Read the current scope's entries: newest first. The returned
 *  array is a fresh copy; callers can sort / filter without affecting
 *  the live state. */
export function getHistory(): HistoryEntry[] {
  ensureStarted();
  return _entries.slice();
}

/** Entry count without copying the list. */
export function historySize(): number {
  ensureStarted();
  return _entries.length;
}

/** Remove a single entry by its (id, played_at) pair. Used by the
 *  hover X on the history list. False when refused (see removeHistoryEntries). */
export function removeHistoryEntry(id: string, playedAt: string): boolean {
  return removeHistoryEntries([{ id, playedAt }]);
}

/** Remove MANY entries in one call and one change event. Keys are
 *  (id, played_at) pairs, the same primary key `removeHistoryEntry` uses.
 *
 *  False, with nothing changed, while the file cannot be read: Rust refuses the
 *  op then, and the retried load would bring the rows back to someone who was
 *  told they had gone. The caller says so instead. */
export function removeHistoryEntries(
  keys: Array<{ id: string; playedAt: string }>,
): boolean {
  if (keys.length === 0) return true;
  if (!_loaded && _loadError !== null) return false;
  const wire = keys.map((k) => ({ id: k.id, played_at: k.playedAt }));
  if (_loaded) {
    const drop = new Set(wire.map((k) => `${k.id}::${k.played_at}`));
    if (!_entries.some((e) => drop.has(`${e.id}::${e.played_at}`))) return true;
  }
  mutate({ op: "remove", keys: wire });
  return true;
}

/** Replace the entire history list for the current scope in one shot.
 *  `silent` skips the change event. Kept for callers that restore a list
 *  wholesale; the cloud merge no longer comes through here (it is
 *  `mergeHistoryFromCloud`, which ships only the delta). */
export function setAllHistory(entries: HistoryEntry[], opts?: { silent?: boolean }): void {
  const sanitized = Array.isArray(entries) ? entries.filter(isEntry) : [];
  mutate({ op: "replace", entries: sanitized }, opts);
}

/** Replace a scope's history from a backup. The snapshot's history scope can
 *  differ from the active one (see BackupPayload.historyScope); the active
 *  one also updates the in-memory list. */
export function replaceHistoryForScope(scope: string, entries: HistoryEntry[]): void {
  const sanitized = entries.filter(isEntry);
  if ((scope.trim() || "guest") === _activeScope) {
    mutate({ op: "replace", entries: sanitized });
    return;
  }
  void call({ op: "replace", scope, entries: sanitized }).catch((e) => {
    console.warn("[history] restore into another scope failed:", e);
  });
}

/** Clear every entry in the current scope. Rejects when the file cannot be
 *  read: Rust refuses the clear then, and the retried load would bring every
 *  row back to someone who believes they were wiped. It waits out a load in
 *  flight first, since a check before it would pass and be refused after it.
 *
 *  The clear is a local edit, so it PUBLISHES: the cloud copy becomes the empty
 *  list within seconds (a clear that skipped the push would only delay that to
 *  the next play, and one that dropped the etag would merge every row back). So
 *  it takes a snapshot first and does not clear without one: that is the only
 *  rollback a single-device user has. Its reason is "manual" because backup.rs
 *  prunes any other reason from the auto bucket, where ten snapshots of the
 *  emptied history (one binge) would delete it. */
export async function clearHistoryChecked(): Promise<void> {
  if (!(await historyReady())) {
    throw new Error("Aura can't read your history file right now (another program may have it open), so nothing was cleared. Try again in a moment.");
  }
  if (_entries.length === 0) return;
  const scope = _activeScope;
  // Dynamic: userDataBackup imports this module.
  const backup = await import("./userDataBackup");
  if (!(await backup.createSnapshot("manual", backup.getActiveBackupScope()))) {
    throw new Error("Aura couldn't take a snapshot of your history first, so nothing was cleared. Try again in a moment.");
  }
  if (scope !== _activeScope) {
    throw new Error("The account changed, so nothing was cleared.");
  }
  try {
    await mutate({ op: "clear" });
  } catch (e) {
    // Refused after all (a scope swap Rust could not make durable): memory
    // shows an empty list the file does not hold, so read it again.
    if (scope === _activeScope) startLoad(scope, null);
    throw e;
  }
}

export function onHistoryChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

// ── Cloud ──────────────────────────────────────────────────────────────────

export interface HistoryCloudPayload {
  /** The wire blob: plain newest rows, then one trailing envelope element
   *  (history_store.rs "WIRE SHAPE"). Opaque here. */
  payload: unknown;
  included: number;
  total: number;
  /** The history scope this was encoded from (added here, not by Rust): a
   *  412 retry merges the server copy into THIS scope or not at all. */
  scope: string;
}

/** The newest-N / total split of what the cloud holds, per history scope and
 *  only while it is trimmed, so a restart and an account switch both read the
 *  right answer. Written when a push LANDS: an encode can still fail or be dropped. */
const CLOUD_TRIM_PREFIX = "aura:sync:history-trim:";

function clearCloudTrim(scope: string): void {
  try { localStorage.removeItem(`${CLOUD_TRIM_PREFIX}${scope}`); } catch { /* best effort */ }
}

/** The active scope's split, for Settings. Null when the cloud holds it all. */
export function getHistoryCloudTrim(): { included: number; total: number } | null {
  try {
    const raw = localStorage.getItem(`${CLOUD_TRIM_PREFIX}${_activeScope}`);
    if (!raw) return null;
    const t = JSON.parse(raw) as { included?: unknown; total?: unknown };
    return typeof t?.included === "number" && typeof t.total === "number"
      ? { included: t.included, total: t.total }
      : null;
  } catch {
    return null;
  }
}

/** sync.ts: this payload is now what the cloud holds. */
export function noteHistoryCloudPushed(p: HistoryCloudPayload): void {
  if (p.included >= p.total) {
    clearCloudTrim(p.scope);
    return;
  }
  try {
    localStorage.setItem(`${CLOUD_TRIM_PREFIX}${p.scope}`, JSON.stringify({ included: p.included, total: p.total }));
  } catch { /* best effort: only the note on the Cloud Sync row */ }
}

/** The `history` sync blob for the active scope (see sync.ts for the wire
 *  contract), or null when the store is not hydrated (an empty pre-hydration
 *  list must never be pushed as if it were the whole history) or when a
 *  set-aside file still waits for its cloud merge (`historyNeedsCloudMerge`). */
export async function encodeHistoryForCloud(): Promise<HistoryCloudPayload | null> {
  if (!(await historyReady())) return null;
  if (_needsCloudMerge) return null;
  const scope = _activeScope;
  const res = await call<Omit<HistoryCloudPayload, "scope">>({ op: "cloud_encode", scope });
  return { ...res, scope };
}

export interface HistoryMergeOutcome {
  legacy: boolean;
  added: number;
  replaced: number;
  serverCount: number;
  localOnly: number;
}

/** Merge a pulled `history` blob (any shape) into the active scope.
 *
 *  `opts.scope` is the history scope the blob was fetched FOR, captured
 *  before the fetch. historyReady() follows scope switches on purpose, so
 *  without it a pull started for account A that resolves after a sign-out
 *  or a switch to B would merge A's rows into the guest's or B's file (and
 *  B's next push would publish them). A mismatch returns null, which leaves
 *  the etag unset so the right account's blob is fetched on the next pull.
 *
 *  Null when the store is not hydrated (the next pull retries). */
export async function mergeHistoryFromCloud(
  data: unknown,
  opts?: { scope?: string },
): Promise<HistoryMergeOutcome | null> {
  if (!(await historyReady())) return null;
  if (opts?.scope !== undefined && opts.scope !== _activeScope) {
    console.info(`[history] cloud copy fetched for ${opts.scope} not merged: the active scope is now ${_activeScope}`);
    return null;
  }
  const token = _token;
  const scope = _activeScope;
  const seq = beginBase();
  type Res = { replaced: HistoryEntry[]; added: HistoryEntry[]; legacy: boolean; server_count: number; local_only: number };
  let res: Res;
  try {
    res = await call<Res>({ op: "merge_cloud", scope, data });
  } catch (e) {
    if (token === _token) settleBase(seq, () => null);
    throw e;
  }
  if (token !== _token) {
    // The scope switched mid-merge. Rust applied it to the old scope's file;
    // the new scope's memory never contained it.
    return null;
  }
  // A set-aside file's scope has taken back what the cloud held; pushes may
  // resume (Rust cleared its own flag in the same call).
  _needsCloudMerge = false;
  const replaced = Array.isArray(res.replaced) ? res.replaced : [];
  const added = Array.isArray(res.added) ? res.added : [];
  settleBase(seq, (state) => applyMergeDelta(state, replaced, added));
  if (replaced.length > 0 || added.length > 0) dispatchChange("cloud");
  return {
    legacy: !!res.legacy,
    added: added.length,
    replaced: replaced.length,
    serverCount: res.server_count ?? 0,
    localOnly: res.local_only ?? 0,
  };
}
