// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// autoBumped: local tracker for series that the recheck-watched flow
// auto-flipped from "watched" to "in-progress" when a new aired
// episode appeared.
//
// Why this exists: the watched-but-now-has-new-eps flow has to
// preserve two competing constraints:
//
//   1. The user wants the show to LOOK in-progress (not stuck on a
//      green checkmark when there's an unwatched aired episode).
//   2. The user does NOT want the show to suddenly appear in CW
//      tiles unless it was already there before the recheck. The
//      Stremio library's `state.timeOffset` may still be > 0 from
//      the user's most recent watch, so without a separate signal
//      the CW filter would re-include the show the moment we
//      cleared the manual-watched mark.
//
// We solve this with a side-channel set: the recheck records the
// series id here; CW excludes anything in the set; the flag clears
// when the user actually engages with the show again (either plays
// an episode, manually changes its state, or marks the new ep
// watched).
//
// PER ACCOUNT (since v2.4.0), like manual-state and skip-marks: stored under
// `aura:auto-bumped-series:<scope>` and swapped by `setAutoBumpedScope`. Up to
// v2.3.2 it was ONE device-wide key, union-merged into every signed-in
// account's cloud blob, so one account's bump hid the show from another
// account's Continue Watching. A clear is kept as a dated tombstone so it
// syncs (format and merge: autoBumpedWire.ts).
// ---------------------------------------------------------------------------

import {
  activeIds, fromWire, parseStored, pruneEntries, serializeStored, toWire,
  type AutoBumpedEntries,
} from "./autoBumpedWire";

const STORAGE_KEY_PREFIX = "aura:auto-bumped-series:";
/** The pre-v2.4.0 device-wide key. Migrated once, see `migrateLegacy`. */
export const LEGACY_STORAGE_KEY = "aura:auto-bumped-series:v1";
const CHANGE_EVENT = "aura:auto-bumped-changed";
/** UI refresh with no cloud push (a pull applying what it fetched). */
const REHYDRATE_EVENT = "aura:auto-bumped-rehydrated";

let _activeScope = "guest";
let _entries: AutoBumpedEntries = {};
let _active: Set<string> = new Set();
let _hydrated = false;

export function autoBumpedStorageKey(scope: string): string {
  // "v1" was the legacy key's suffix; no scope is called that ("guest" or
  // "user-<12 chars>"), but never let one collide with it.
  return `${STORAGE_KEY_PREFIX}${scope === "v1" ? "_v1" : scope}`;
}

function setEntries(next: AutoBumpedEntries): void {
  _entries = next;
  _active = new Set(activeIds(next));
}

function loadFromStorage(scope: string): AutoBumpedEntries {
  try {
    return parseStored(localStorage.getItem(autoBumpedStorageKey(scope)));
  } catch {
    return {};
  }
}

function ensureHydrated(): void {
  if (_hydrated) return;
  migrateLegacy(_activeScope);
  setEntries(loadFromStorage(_activeScope));
  _hydrated = true;
}

function persist(): void {
  try {
    localStorage.setItem(autoBumpedStorageKey(_activeScope), serializeStored(_entries));
  } catch { /* quota / private mode: non-fatal */ }
}

/**
 * One-time move of the old device-wide set. It holds every account's bumps
 * mixed together (the cloud union put them all on every device), so it can
 * only be handed to an account when it cannot belong to anyone else: on a
 * device where at most ONE signed-in account has ever kept watch state
 * (`aura:manual-state:user-*`), it goes to that account (or to the guest when
 * there is none), once that scope is active. With two or more accounts it is
 * dropped: those shows can come back into Continue Watching once, which beats
 * keeping them hidden from the wrong person indefinitely.
 */
function migrateLegacy(scope: string): void {
  let raw: string | null;
  try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); } catch { return; }
  if (raw == null) return;
  const owners = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("aura:manual-state:user-")) owners.add(k.slice("aura:manual-state:".length));
    }
  } catch { return; }
  const owner = owners.size === 0 ? "guest" : owners.size === 1 ? [...owners][0] : null;
  if (owner !== null && owner !== scope) return; // wait for that account
  if (owner !== null) {
    const legacy = parseStored(raw);
    if (Object.keys(legacy).length > 0) {
      const mine = loadFromStorage(scope);
      // Existing dated entries win over the undated legacy ones.
      const merged: AutoBumpedEntries = { ...legacy, ...mine };
      try { localStorage.setItem(autoBumpedStorageKey(scope), serializeStored(merged)); } catch { return; }
    }
    console.info(`[sync] auto-bumped: moved ${Object.keys(legacy).length} legacy entries to ${scope}`);
  } else {
    console.info(`[sync] auto-bumped: legacy device-wide set dropped (${owners.size} accounts on this device)`);
  }
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* retried next swap */ }
}

/** Swap the active account scope. Called alongside `setSkipMarksScope`. */
export function setAutoBumpedScope(scope: string | null): void {
  const next = scope || "guest";
  if (next === _activeScope && _hydrated) return;
  _activeScope = next;
  migrateLegacy(next);
  setEntries(loadFromStorage(next));
  _hydrated = true;
  window.dispatchEvent(new CustomEvent(REHYDRATE_EVENT));
}

/** True when the recheck flow auto-flipped this series. The CW
 *  filter calls this synchronously per item; backed by a Set lookup,
 *  so it's effectively free even on large libraries. */
export function isAutoBumped(seriesId: string): boolean {
  if (!seriesId) return false;
  ensureHydrated();
  return _active.has(seriesId);
}

function write(ids: string[], bumped: boolean): void {
  ensureHydrated();
  const now = Date.now();
  const next = { ..._entries };
  let changed = false;
  for (const id of ids) {
    if (!id) continue;
    if (bumped === _active.has(id)) continue;
    next[id] = bumped ? now : -now;
    changed = true;
  }
  if (!changed) return;
  setEntries(pruneEntries(next, now));
  persist();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Record a series as auto-bumped. Called by recheckSeriesWatchedFlag
 *  immediately after clearing the watched mark. Idempotent. */
export function markAutoBumped(seriesId: string): void {
  write([seriesId], true);
}

/** Clear a series from the auto-bumped set. Called when the user
 *  engages with the show: actually plays an episode (App.tsx's
 *  onPlayStream pre-load hook), manually changes its watched mark,
 *  or marks the new ep watched. Idempotent. */
export function clearAutoBumped(seriesId: string): void {
  write([seriesId], false);
}

/** Clear any auto-bumped series that `id` belongs to. `id` may be the series
 *  root itself OR one of its episode ids (e.g. "tt0903747:1:5" or
 *  "kitsu:46474:5") - we match by exact id or `<seriesId>:` prefix, so no
 *  id-shape parsing is needed and id-prefix collisions (tt0903747 vs
 *  tt09037479) can't false-match. This is the MANUAL counterpart to the
 *  play-time clear in onPlayStream: it fires when the user engages with a
 *  series by marking it (or one of its episodes) watched / in-progress, so a
 *  user who catches up WITHOUT playing doesn't leave the show stranded out of
 *  CW. Idempotent. */
export function clearAutoBumpedForVideo(id: string): void {
  if (!id) return;
  ensureHydrated();
  if (_active.size === 0) return;
  const hits: string[] = [];
  for (const seriesId of _active) {
    if (id === seriesId || id.startsWith(seriesId + ":")) hits.push(seriesId);
  }
  if (hits.length > 0) write(hits, false);
}

/** Subscribe to auto-bump changes. CW row uses this so the tile
 *  list refreshes the instant a series gets auto-bumped or cleared,
 *  without waiting on the next library re-fetch. */
export function onAutoBumpedChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener(REHYDRATE_EVENT, callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener(REHYDRATE_EVENT, callback);
  };
}

/** The active account's set in the cloud wire shape (sync.ts readLocal). */
export function getAutoBumpedWire(): string[] {
  ensureHydrated();
  return toWire(_entries);
}

/** Applies a merged cloud blob (sync.ts writeLocal). `push` re-publishes it
 *  (the merge differs from what the cloud holds); otherwise only the UI is
 *  refreshed, so a pull does not schedule a push of what it just fetched. */
export function replaceAutoBumpedFromWire(wire: unknown, opts: { push: boolean }): void {
  ensureHydrated();
  setEntries(pruneEntries(fromWire(wire), Date.now()));
  persist();
  window.dispatchEvent(new CustomEvent(opts.push ? CHANGE_EVENT : REHYDRATE_EVENT));
}

/** Force the in-memory cache to re-read from localStorage. Called after a
 *  local backup restore writes the scoped key directly; without this,
 *  `isAutoBumped` would still consult the pre-restore set. */
export function reloadAutoBumpedFromStorage(): void {
  setEntries(loadFromStorage(_activeScope));
  _hydrated = true;
  window.dispatchEvent(new CustomEvent(REHYDRATE_EVENT));
}
