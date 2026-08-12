// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// skipMarks — which episodes were SKIPPED rather than watched.
//
// WHY THIS IS NOT A FOURTH ManualWatchedState
//
// `ManualWatchedState` is a single-slot map: one value per id. Making "skipped"
// a member of that union would make it mutually exclusive with "watched", and
// the requirement is the opposite: a skipped episode must behave exactly like a
// watched one everywhere except its label. There are ~40 sites across 17 files
// that test `=== "watched"`, and TypeScript catches only two of them, so the
// other 38 would compile clean and fail silently. Four fail badly. The worst is
// `autoAdvance.ts`'s `aired.every(v => state(v) === "watched")`: a single
// skipped filler episode would permanently block the series-completion flag,
// pinning the show in Continue Watching forever and breaking auto-remove, in
// exactly the filler-heavy anime this feature exists for.
//
// So a skip is an ANNOTATION laid over a normal "watched" mark. Everything that
// already understands watched keeps working untouched, by construction rather
// than by 38 hand edits, and this store answers the one extra question: was it
// watched, or skipped?
//
// SCOPE + PERSISTENCE mirror manualWatched.ts exactly, including the per-account
// key, because the two stores are always read together and a skip whose watched
// mark lives in another scope would be a ghost.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import { safeSetItem } from "./storageQuota";

const STORAGE_KEY_PREFIX = "aura:skip-marks:";
const CHANGE_EVENT = "aura:skip-marks-changed";

let _activeScope = "guest";
let _activeSet: Set<string> = new Set();
let _hydrated = false;

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function loadFromStorage(scope: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    // Array of ids. Every element is re-validated: a corrupt blob must not
    // inject non-strings that later stringify into "[object Object]" keys.
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === "string" && !!v));
    }
  } catch { /* unreadable blob: start empty rather than throw on boot */ }
  return new Set();
}

function ensureHydrated(): void {
  if (_hydrated) return;
  _activeSet = loadFromStorage(_activeScope);
  _hydrated = true;
}

function persist(): void {
  // Unbounded like manualWatched, and for the same reason: these are explicit
  // user marks, and silently evicting one would resurface an episode the user
  // deliberately dismissed. Ids are short and the realistic ceiling is a few
  // thousand, which is well inside a localStorage budget.
  safeSetItem(storageKey(_activeScope), JSON.stringify([..._activeSet]));
}

function notify(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Swap the active account scope. Called alongside `setManualWatchedScope`. */
export function setSkipMarksScope(scope: string | null): void {
  const next = scope || "guest";
  if (next === _activeScope && _hydrated) return;
  _activeScope = next;
  _activeSet = loadFromStorage(next);
  _hydrated = true;
  notify();
}

/** Re-read from storage. Used after a cloud pull replaces the blob. */
export function reloadSkipMarksFromStorage(): void {
  _activeSet = loadFromStorage(_activeScope);
  _hydrated = true;
  notify();
}

export function isSkipped(id: string): boolean {
  ensureHydrated();
  return _activeSet.has(id);
}

/** Every skipped id in the active scope. Used by the sync layer and by the
 *  progress bars, which need the whole set rather than one lookup. */
export function getSkippedIds(): string[] {
  ensureHydrated();
  return [..._activeSet];
}

/** Add or clear the skip annotation. Does NOT touch the watched mark: callers
 *  set that through `manualWatched` so there is exactly one owner of watch
 *  state. See `markEpisodesSkipped` in skipActions.ts for the paired write. */
export function setSkipped(ids: string[], skipped: boolean): void {
  ensureHydrated();
  let changed = false;
  for (const id of ids) {
    if (!id) continue;
    if (skipped ? _activeSet.has(id) : !_activeSet.has(id)) continue;
    if (skipped) _activeSet.add(id); else _activeSet.delete(id);
    changed = true;
  }
  if (!changed) return;
  persist();
  notify();
}

/** Replace the whole set. Used by the cloud merge. */
export function replaceSkipMarks(ids: string[]): void {
  _activeSet = new Set(ids.filter((v) => typeof v === "string" && !!v));
  _hydrated = true;
  persist();
  notify();
}

export function onSkipMarksChange(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

let _version = 0;
window.addEventListener(CHANGE_EVENT, () => { _version += 1; });
const snapshot = () => _version;

/** Re-renders the caller on any skip-mark change. Opaque value; read through
 *  `isSkipped` / `getSkippedIds` after it flips. */
export function useSkipMarksVersion(): number {
  return useSyncExternalStore(onSkipMarksChange, snapshot);
}
