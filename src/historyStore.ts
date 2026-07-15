// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { safeSetItem } from "./storageQuota";

// ---------------------------------------------------------------------------
// historyStore — local-only, per-account watch-history log.
//
// SCOPE — keyed by the same scope id Aura's settings + manualWatched use
// (auth_key.slice(0, 12) → "user-<prefix>" or "guest"). Each entry
// captures one AUTOMATIC watch event — i.e. the user actually played
// content and either crossed the 90 % threshold or watched 5+ minutes.
// Manual marks (mark-as-watched from the right-click menu) are NOT
// recorded here, by contract: the user explicitly set state without
// playing, so there's nothing to log.
//
// STORAGE — localStorage entry per scope: `aura:history:<scope>`. Cap
// at 1000 entries per scope; older entries roll off when the cap is
// hit. Each entry's primary key for removal purposes is `played_at`
// (ISO timestamp) + `id` — re-watching the same episode produces a new
// entry with a distinct timestamp.
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "aura:history:";
const CHANGE_EVENT = "aura:history-changed";
const MAX_ENTRIES = 1000;

export interface HistoryEntry {
  /** The canonical id played — episode id for series/anime, movie id
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
  /** ISO 8601 — when the user finished watching (or exited playback).
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
}

let _activeScope: string = "guest";
let _entries: HistoryEntry[] = [];
let _hydrated = false;

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function loadFromStorage(scope: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is HistoryEntry =>
      e && typeof e === "object" && typeof e.id === "string" && typeof e.played_at === "string"
    );
  } catch {
    return [];
  }
}

function saveToStorage(scope: string, entries: HistoryEntry[]): void {
  // safeSetItem first: on a full origin it evicts the DISPOSABLE caches
  // (metaCache, ratings, etc.) and retries, so watch history (a genuine record)
  // yields space LAST, not first. Only if it STILL won't fit do we drop the
  // oldest half of history and try once more (the in-memory list stays intact
  // this session; a dropped tail re-hydrates from the cloud merge if those rows
  // still exist server-side). safeSetItem already emits a one-shot "storage
  // full" warning, so a trim is not silent.
  if (safeSetItem(storageKey(scope), JSON.stringify(entries))) return;
  const trimmed = entries.slice(0, Math.floor(entries.length / 2));
  safeSetItem(storageKey(scope), JSON.stringify(trimmed));
}

function ensureHydrated(): void {
  if (_hydrated) return;
  _hydrated = true;
  _entries = loadFromStorage(_activeScope);
}

/** Switch the active scope. Called from App.tsx on auth state changes
 *  alongside the settings + manualWatched scope swaps.
 *
 *  `legacyScope` is the auth_key-derived scope this user had before
 *  the post-0.6.x switch to user_id-based scoping. Pre-fix Aura keyed
 *  every per-scope localStorage entry by `auth_key.slice(0, 12)`, but
 *  Stremio rotates auth_keys on every login — so any login (and every
 *  cross-device install) effectively created a fresh scope and left
 *  the prior session's history orphaned. When `legacyScope` is
 *  supplied AND the new scope's localStorage entry is empty AND the
 *  legacy scope has data, we copy it over once so the user doesn't
 *  see "history wiped". The old entry stays in place so a downgrade
 *  to an older Aura build can still read it. */
export function setHistoryScope(
  scope: string | null,
  opts?: { legacyScope?: string | null },
): void {
  const next = scope && scope.trim() ? scope : "guest";
  if (next === _activeScope && _hydrated) return;

  // One-shot legacy-scope migration. Only runs when the new scope's
  // localStorage entry doesn't exist yet (so re-running is a no-op
  // once the user has any new entries written).
  const legacy = opts?.legacyScope?.trim();
  if (legacy && legacy !== next) {
    const newKey = storageKey(next);
    if (!localStorage.getItem(newKey)) {
      const oldKey = storageKey(legacy);
      const carried = localStorage.getItem(oldKey);
      if (carried) {
        try {
          localStorage.setItem(newKey, carried);
        } catch {
          // Quota or disabled storage — non-fatal; history will just
          // appear empty until the user plays something on the new
          // scope.
        }
      }
    }
  }

  _activeScope = next;
  _entries = loadFromStorage(next);
  _hydrated = true;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Append a new history entry. Older identical (id, played_at) pairs
 *  are deduped — the same finished play emitted twice doesn't double
 *  up the list. Newest entry is kept at index 0 for fast view render. */
export function addHistoryEntry(entry: HistoryEntry): void {
  if (!entry?.id || !entry.played_at) return;
  ensureHydrated();
  const dupeIdx = _entries.findIndex(
    (e) => e.id === entry.id && e.played_at === entry.played_at,
  );
  if (dupeIdx >= 0) {
    _entries[dupeIdx] = entry;
  } else {
    _entries.unshift(entry);
    if (_entries.length > MAX_ENTRIES) {
      _entries.length = MAX_ENTRIES;
    }
  }
  saveToStorage(_activeScope, _entries);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Read the current scope's entries — newest first. The returned
 *  array is a fresh copy; callers can sort / filter without affecting
 *  the live state. */
export function getHistory(): HistoryEntry[] {
  ensureHydrated();
  return _entries.slice();
}

/** Remove a single entry by its (id, played_at) pair. Used by the
 *  hover X on the history list. */
export function removeHistoryEntry(id: string, playedAt: string): void {
  ensureHydrated();
  const before = _entries.length;
  _entries = _entries.filter((e) => !(e.id === id && e.played_at === playedAt));
  if (_entries.length === before) return;
  saveToStorage(_activeScope, _entries);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Remove MANY entries in one write and one change event. The single-entry
 *  path above persists and dispatches per call, so clearing a 200-row
 *  multi-selection through it would hit localStorage 200 times and re-render
 *  the History view 200 times. Keys are (id, played_at) pairs, the same
 *  primary key `removeHistoryEntry` uses. */
export function removeHistoryEntries(
  keys: Array<{ id: string; playedAt: string }>,
): void {
  ensureHydrated();
  if (keys.length === 0) return;
  const drop = new Set(keys.map((k) => `${k.id}::${k.playedAt}`));
  const before = _entries.length;
  _entries = _entries.filter((e) => !drop.has(`${e.id}::${e.played_at}`));
  if (_entries.length === before) return;
  saveToStorage(_activeScope, _entries);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Replace the entire history list for the current scope in one
 *  shot. Used by the cloud-sync merger: the merge layer fetches
 *  server + local, unions them, and writes the result back through
 *  this function. Skips the change-event dispatch when `silent` is
 *  set so the writer can avoid bouncing through the
 *  `aura:history-changed` → debouncedPush → re-pull loop. */
export function setAllHistory(entries: HistoryEntry[], opts?: { silent?: boolean }): void {
  ensureHydrated();
  const sanitized = Array.isArray(entries)
    ? entries.filter((e): e is HistoryEntry =>
        e != null && typeof e === "object" &&
        typeof e.id === "string" && typeof e.played_at === "string",
      )
    : [];
  _entries = sanitized.slice(0, MAX_ENTRIES);
  saveToStorage(_activeScope, _entries);
  if (!opts?.silent) window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Clear every entry in the current scope. Wired to a confirm-button
 *  on the history view. */
export function clearHistory(): void {
  ensureHydrated();
  if (_entries.length === 0) return;
  _entries = [];
  saveToStorage(_activeScope, _entries);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function onHistoryChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}
