// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { safeSetItem } from "./storageQuota";
import { setSkipped } from "./skipMarks";
import { showAppToast } from "./AppToast";

// ---------------------------------------------------------------------------
// manualWatched — local-only, per-account "I've watched / I'm watching /
// I'm planning to watch this" tracker.
//
// FOUR-STATE — distinct from Stremio's library `state.timeOffset` /
// 90 % auto-watched threshold. Per-id we record one of:
//
//   • "watched"      — green check overlay; excluded from Continue
//                      Watching; excluded from scrobble + history.
//   • "in-progress"  — yellow dot overlay; visual marker only, no
//                      scrobble side-effects.
//   • "planned"      — blue bookmark overlay; surfaces in the Queue
//                      tab (ordered list, drag-to-reorder); auto-adds
//                      to the user's library when set so it shows up
//                      everywhere they'd expect their saved-content
//                      list to.
//   • null           — no manual mark; visual state derives from
//                      library progress (state.timeOffset etc).
//
// ORDER MATTERS for the planned subset — the Queue tab shows them in
// insertion order, and drag-to-reorder rewrites that order via
// `setManualWatchedOrder`. JS Map preserves insertion order, so the
// underlying storage just round-trips ordered [id, state] pairs.
//
// Stored locally only:
//   • LOCAL: never written to Stremio's cloud. Stays on this device.
//   • SCOPED: keyed by the same scope id Aura's settings use
//     (auth_key hash → "user-<hex>", or "guest"). Switching accounts
//     swaps the active map; logging out → guest map.
//
// Backed by a localStorage entry holding the active scope's map plus
// an in-memory mirror so reads don't pay JSON parse on every call.
// ---------------------------------------------------------------------------

export type ManualWatchedState = "watched" | "in-progress" | "planned";

const STORAGE_KEY_PREFIX = "aura:manual-state:";
/** Legacy key from the binary version of this module. We migrate
 *  forward on first hydrate so existing marks survive the schema bump. */
const LEGACY_BINARY_PREFIX = "aura:manual-watched:";
const CHANGE_EVENT = "aura:manual-watched-changed";

let _activeScope: string = "guest";
let _activeMap: Map<string, ManualWatchedState> = new Map();
let _hydrated = false;

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function loadFromStorage(scope: string): Map<string, ManualWatchedState> {
  const next = new Map<string, ManualWatchedState>();
  // 1. Try the new shape first. Stored as an ARRAY of [id, state]
  //    pairs so insertion order survives the round-trip — the Queue
  //    needs that order. Earlier object form is still read for back-
  //    compat (object key order is implementation-defined but in
  //    practice V8 preserves it).
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (Array.isArray(entry) && entry.length === 2) {
            const [k, v] = entry;
            if (typeof k === "string" && (v === "watched" || v === "in-progress" || v === "planned")) {
              next.set(k, v);
            }
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (v === "watched" || v === "in-progress" || v === "planned") {
            next.set(k, v);
          }
        }
      }
      return next;
    }
  } catch { /* corrupted — fall through */ }
  // 2. One-shot migration from the legacy binary set so the user's
  //    existing "manually watched" marks aren't lost when we upgrade
  //    to 3-state. Treat every previous entry as "watched".
  try {
    const legacyRaw = localStorage.getItem(`${LEGACY_BINARY_PREFIX}${scope}`);
    if (legacyRaw) {
      const arr = JSON.parse(legacyRaw);
      if (Array.isArray(arr)) {
        for (const id of arr) {
          if (typeof id === "string") next.set(id, "watched");
        }
      }
      // Persist forward and clean up the legacy entry.
      saveToStorageDirect(scope, next);
      try { localStorage.removeItem(`${LEGACY_BINARY_PREFIX}${scope}`); } catch {}
    }
  } catch { /* legacy missing or corrupted — fine */ }
  return next;
}

/** Persist the map. Returns whether the write landed — via safeSetItem so a
 *  full origin evicts a disposable cache and retries (so an explicit watched
 *  mark is not silently lost on quota). Persists as an array of [id, state]
 *  pairs to preserve insertion order — the Queue tab depends on it. */
function saveToStorageDirect(scope: string, map: Map<string, ManualWatchedState>): boolean {
  const arr: Array<[string, ManualWatchedState]> = [];
  for (const [k, v] of map.entries()) arr.push([k, v]);
  return safeSetItem(storageKey(scope), JSON.stringify(arr));
}

function ensureHydrated(): void {
  if (_hydrated) return;
  _hydrated = true;
  _activeMap = loadFromStorage(_activeScope);
}

/** Switch the active scope. Called from App.tsx on auth state changes
 *  (mirroring set_settings_scope on the Rust side). */
export function setManualWatchedScope(scope: string | null): void {
  const next = scope && scope.trim() ? scope : "guest";
  if (next === _activeScope && _hydrated) return;
  _activeScope = next;
  _activeMap = loadFromStorage(next);
  _hydrated = true;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Re-read the localStorage-backed map for the current scope into the
 *  in-memory mirror. Called by the cloud sync layer (sync.ts) after it
 *  writes a merged blob: without this, `_activeMap` stays at its pre-
 *  pull contents and consumers of `getManualWatchedState` /
 *  `getPlannedQueue` see stale data until the next page reload. The
 *  function also fires the CHANGE_EVENT so subscribed components
 *  re-render with the freshly loaded values. */
export function reloadManualWatchedFromStorage(): void {
  _activeMap = loadFromStorage(_activeScope);
  _hydrated = true;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Returns "watched" / "in-progress" / null for `id`. */
export function getManualWatchedState(id: string): ManualWatchedState | null {
  if (!id) return null;
  ensureHydrated();
  return _activeMap.get(id) ?? null;
}

/** Convenience — pure boolean read for the CW filter / scrobble path. */
export function isManuallyWatched(id: string): boolean {
  return getManualWatchedState(id) === "watched";
}

/** Convenience — pure boolean read. */
export function isManuallyInProgress(id: string): boolean {
  return getManualWatchedState(id) === "in-progress";
}

/** Per-id transition payload emitted on the SYNC_EVENT. Listeners that
 *  push to external systems (e.g. Stremio's library, Trakt) read these
 *  to drive their own diff round-trip. */
export interface WatchedSyncDiff {
  id:       string;
  oldState: ManualWatchedState | null;
  newState: ManualWatchedState | null;
}

const SYNC_EVENT = "aura:watched-sync";

function emitSync(diff: WatchedSyncDiff[]): void {
  if (diff.length === 0) return;
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { diff } }));
}

/** Subscribe to per-id watched-state transitions. Use this instead of
 *  `onManualWatchedChange` when you need to know WHICH id changed and
 *  in what direction (e.g. for the cloud watched-status sync). */
export function onWatchedSync(
  callback: (diffs: WatchedSyncDiff[]) => void,
): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ diff: WatchedSyncDiff[] }>).detail;
    if (detail?.diff) callback(detail.diff);
  };
  window.addEventListener(SYNC_EVENT, handler);
  return () => window.removeEventListener(SYNC_EVENT, handler);
}

/** Set the manual state for `id`. Pass `null` to clear. */
export function setManualWatchedState(id: string, state: ManualWatchedState | null): void {
  if (!id) return;
  ensureHydrated();
  const current = _activeMap.get(id) ?? null;
  if (current === state) return; // no-op
  if (state == null) _activeMap.delete(id);
  else _activeMap.set(id, state);
  if (!saveToStorageDirect(_activeScope, _activeMap)) {
    // The in-memory map is updated, but the write didn't land even after a
    // cache eviction + retry. Tell the user so an explicit mark that silently
    // reverts on restart (and the stale value a sync push would then carry) is
    // at least visible instead of a mystery.
    showAppToast("Couldn't save your watched mark: local storage is full. It may not stick after a restart (clear space in Settings > Storage).", { duration: 5000 });
  }
  // A skip is an ANNOTATION OVER a watched mark, so it cannot outlive one.
  // Enforced here rather than at the call sites because there are four ways to
  // leave "watched" (Unmark Watched, the bulk unmark, the catalog fan-out, and
  // Mark as In Progress on an already-skipped episode) and only one of them
  // ever cleared the annotation. The orphan is visible: the progress bars test
  // the skip store FIRST, so they kept painting a purple "Skipped" band and
  // counting the episode as done, while WatchedBadge, which requires the
  // watched mark, showed it as unwatched.
  if (current === "watched" && state !== "watched") setSkipped([id], false);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  emitSync([{ id, oldState: current, newState: state }]);
}

/** Bulk variant — for the future episode-range "mark this and before /
 *  after" right-click options. */
export function setManualWatchedMany(
  ids: string[],
  state: ManualWatchedState | null,
): void {
  if (ids.length === 0) return;
  ensureHydrated();
  let mutated = false;
  const diffs: WatchedSyncDiff[] = [];
  for (const id of ids) {
    if (!id) continue;
    const current = _activeMap.get(id) ?? null;
    if (current === state) continue;
    if (state == null) _activeMap.delete(id);
    else _activeMap.set(id, state);
    mutated = true;
    diffs.push({ id, oldState: current, newState: state });
  }
  if (mutated) {
    saveToStorageDirect(_activeScope, _activeMap);
    // Same rule as the single-id setter above: leaving "watched" drops the skip
    // annotation with it. `setSkipped` is a no-op when nothing changes, so the
    // common bulk write costs one Set lookup per id and fires no extra event.
    const demoted = diffs
      .filter((d) => d.oldState === "watched" && d.newState !== "watched")
      .map((d) => d.id);
    if (demoted.length > 0) setSkipped(demoted, false);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    emitSync(diffs);
  }
}

/** Subscribe to changes. Fired on any successful mutation AND on
 *  scope switches. The callback receives no payload — components
 *  re-read via the synchronous helpers above. */
export function onManualWatchedChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

// ---------------------------------------------------------------------------
// React-friendly version counter
//
// Each call to `onManualWatchedChange` registers a fresh window event
// listener — fine in isolation, but a `for-each card` use-pattern (e.g.
// 50 SegmentedSeasonBar instances on the Continue Watching row) ends up
// with 50 listeners and 50 setState calls per mutation. React 18 batches
// those into one render pass, but the registration overhead and per-
// listener fan-out is still wasteful.
//
// `useSyncExternalStore` is React's purpose-built hook for this kind of
// external-store subscription: it deduplicates the snapshot read and
// only re-renders when the snapshot changes. We expose a single
// monotonically-increasing version number — bumped on every mutation —
// so consumers can treat `useManualWatchedVersion()` as "subscribe to
// any manual-watched change" with one line.
// ---------------------------------------------------------------------------

let _manualWatchedVersion = 0;
window.addEventListener(CHANGE_EVENT, () => {
  _manualWatchedVersion += 1;
});

const getManualWatchedVersionSnapshot = () => _manualWatchedVersion;

import { useSyncExternalStore } from "react";

/** Re-renders the calling component on any manual-watched change. The
 *  version itself is opaque — callers should still read state via
 *  `getManualWatchedState`/`isManuallyWatched` after the version flips. */
export function useManualWatchedVersion(): number {
  return useSyncExternalStore(
    onManualWatchedChange,
    getManualWatchedVersionSnapshot,
  );
}

// ---------------------------------------------------------------------------
// Queue helpers — derived views over the same store, exposing the
// "planned" subset as an ordered list.
// ---------------------------------------------------------------------------

/** Returns the ids currently marked as "planned", in queue order
 *  (insertion order; drag-to-reorder rewrites this sequence). */
export function getPlannedQueue(): string[] {
  ensureHydrated();
  const out: string[] = [];
  for (const [id, state] of _activeMap.entries()) {
    if (state === "planned") out.push(id);
  }
  return out;
}

/** Reorder the planned subset to match the supplied id list. Non-
 *  planned entries (`watched` / `in-progress`) keep their existing
 *  order; only the planned slots are re-shuffled. Ids not currently in
 *  the active map are silently ignored. */
export function setManualWatchedOrder(orderedPlannedIds: string[]): void {
  ensureHydrated();
  // Snapshot existing entries by category so we can rebuild the map.
  const nonPlanned: Array<[string, ManualWatchedState]> = [];
  const plannedSet = new Set<string>();
  for (const [id, state] of _activeMap.entries()) {
    if (state === "planned") plannedSet.add(id);
    else nonPlanned.push([id, state]);
  }
  // Filter the requested order to ids that are still in the planned
  // set, then append any planned ids the caller forgot (defensive — a
  // race could lose a just-added planned mark otherwise).
  const seen = new Set<string>();
  const reorderedPlanned: string[] = [];
  for (const id of orderedPlannedIds) {
    if (plannedSet.has(id) && !seen.has(id)) {
      seen.add(id);
      reorderedPlanned.push(id);
    }
  }
  for (const id of plannedSet) {
    if (!seen.has(id)) reorderedPlanned.push(id);
  }
  // Rebuild map: non-planned first (preserve their existing
  // ordering), then planned in the new order. Visual surfaces don't
  // care about non-planned ordering today, but keeping it stable
  // means we don't churn the persisted blob.
  const next = new Map<string, ManualWatchedState>();
  for (const [id, state] of nonPlanned) next.set(id, state);
  for (const id of reorderedPlanned) next.set(id, "planned");
  _activeMap = next;
  saveToStorageDirect(_activeScope, _activeMap);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
