// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// autoBumped — local tracker for series that the recheck-watched flow
// auto-flipped from "watched" to "in-progress" when a new aired
// episode appeared.
//
// Why this exists: the watched-but-now-has-new-eps flow has to
// preserve two competing constraints —
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
// watched). The set is persisted in localStorage so it survives
// reloads — fresh starts after a recheck shouldn't re-introduce the
// show into CW.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "aura:auto-bumped-series:v1";
const CHANGE_EVENT = "aura:auto-bumped-changed";

let _cache: Set<string> | null = null;

function load(): Set<string> {
  if (_cache) return _cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      _cache = new Set();
      return _cache;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _cache = new Set(parsed.filter((s): s is string => typeof s === "string"));
      return _cache;
    }
  } catch { /* corrupted — fall through */ }
  _cache = new Set();
  return _cache;
}

function save(): void {
  if (!_cache) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([..._cache]));
  } catch { /* quota / private mode — non-fatal */ }
}

/** True when the recheck flow auto-flipped this series. The CW
 *  filter calls this synchronously per item; backed by a Set lookup,
 *  so it's effectively free even on large libraries. */
export function isAutoBumped(seriesId: string): boolean {
  if (!seriesId) return false;
  return load().has(seriesId);
}

/** Record a series as auto-bumped. Called by recheckSeriesWatchedFlag
 *  immediately after clearing the watched mark. Idempotent. */
export function markAutoBumped(seriesId: string): void {
  if (!seriesId) return;
  const set = load();
  if (set.has(seriesId)) return;
  set.add(seriesId);
  save();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Clear a series from the auto-bumped set. Called when the user
 *  engages with the show — actually plays an episode (App.tsx's
 *  onPlayStream pre-load hook), manually changes its watched mark,
 *  or marks the new ep watched. Idempotent. */
export function clearAutoBumped(seriesId: string): void {
  if (!seriesId) return;
  const set = load();
  if (!set.has(seriesId)) return;
  set.delete(seriesId);
  save();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Subscribe to auto-bump changes. CW row uses this so the tile
 *  list refreshes the instant a series gets auto-bumped or cleared,
 *  without waiting on the next library re-fetch. */
export function onAutoBumpedChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

/** Force the in-memory cache to re-read from localStorage. Called by
 *  the cloud sync layer (sync.ts) after it merges a pulled blob into
 *  storage; without this, `isAutoBumped` would still consult the
 *  pre-pull `_cache` and consumers (CW filter) would show stale
 *  inclusion / exclusion state until reload. */
export function reloadAutoBumpedFromStorage(): void {
  _cache = null;
  load();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
