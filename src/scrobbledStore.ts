// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { safeSetItem } from "./storageQuota";

// ---------------------------------------------------------------------------
// scrobbledStore — a local record of which History entries have already been
// pushed to which scrobble service, per account scope.
//
// WHY THIS IS NOT THE DUPE GATE. The real protection against double-scrobbling
// lives on the services themselves and is already exercised by the single-row
// buttons:
//   • Trakt  — /sync/history is idempotent on `watched_at`. Aura sends the
//     entry's exact `played_at`, so re-pushing the same row cannot create a
//     second play.
//   • AniList — save_progress returns AlreadyAhead when the entry's progress is
//     already at or past this episode, and writes nothing.
// This store is a local FAST-PATH on top of those: it lets a bulk run SKIP rows
// that are already done instead of spending a network round trip (and a slice of
// the rate-limit budget) re-confirming what the service would just no-op. It
// also drives the "done" tick on each row. If it is ever wrong (wiped, or a row
// scrobbled from another device), the worst case is a redundant call that the
// service's own gate absorbs — never a duplicate play.
//
// STORAGE — `aura:scrobbled:<scope>`, a flat array of "<service>::<id>::<played_at>"
// keys. Bounded at MAX_KEYS with oldest-first eviction (Set preserves insertion
// order), per the standing "never ship an unbounded cache" rule.
//
// Marks are deliberately KEPT when a history entry is removed or the history is
// cleared: cloud sync can re-add the very same (id, played_at) row later, and a
// surviving mark is what stops that row from being scrobbled a second time.
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "aura:scrobbled:";
const CHANGE_EVENT = "aura:scrobbled-changed";
const MAX_KEYS = 3000;

export type ScrobbleService = "trakt" | "anilist";

let _scope = "guest";
let _keys: Set<string> = new Set();
let _hydrated = false;

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

/** "<service>::<id>::<played_at>" — (id, played_at) is the same primary key the
 *  history store uses for a single play, so a re-watch (new timestamp) is a new
 *  row and correctly scrobbles again. */
function markKey(service: ScrobbleService, id: string, playedAt: string): string {
  return `${service}::${id}::${playedAt}`;
}

function hydrate(scope: string): void {
  if (_hydrated && _scope === scope) return;
  _scope = scope;
  _hydrated = true;
  try {
    const raw = localStorage.getItem(storageKey(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    _keys = new Set(
      Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [],
    );
  } catch {
    _keys = new Set();
  }
}

function persist(): void {
  safeSetItem(storageKey(_scope), JSON.stringify([..._keys]));
}

/** Has this entry already been pushed to this service on this scope? */
export function isScrobbled(
  scope: string, service: ScrobbleService, id: string, playedAt: string,
): boolean {
  hydrate(scope);
  return _keys.has(markKey(service, id, playedAt));
}

/** Record a SUCCESSFUL push. Only ever called after the command resolves Ok, so
 *  a failed attempt stays un-marked and is retried by the next run. */
export function markScrobbled(
  scope: string, service: ScrobbleService, id: string, playedAt: string,
): void {
  hydrate(scope);
  const key = markKey(service, id, playedAt);
  if (_keys.has(key)) return;
  _keys.add(key);
  if (_keys.size > MAX_KEYS) {
    // Set iterates in insertion order, so this drops the oldest marks first.
    const excess = _keys.size - MAX_KEYS;
    let dropped = 0;
    for (const k of _keys) {
      if (dropped++ >= excess) break;
      _keys.delete(k);
    }
  }
  persist();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Record MANY successful pushes with ONE persist and ONE change event.
 *
 *  `markScrobbled` serializes the whole key set and re-renders the History view
 *  on every call, so a bulk run that marked each row individually would do one
 *  localStorage write and one full re-render PER PUSH (up to 1000 rows x 2
 *  services). The bulk runner therefore accumulates its successes and flushes
 *  them through here in chunks. */
export function markScrobbledMany(
  scope: string,
  marks: Array<{ service: ScrobbleService; id: string; playedAt: string }>,
): void {
  if (marks.length === 0) return;
  hydrate(scope);
  let added = 0;
  for (const m of marks) {
    const key = markKey(m.service, m.id, m.playedAt);
    if (_keys.has(key)) continue;
    _keys.add(key);
    added++;
  }
  if (added === 0) return;
  if (_keys.size > MAX_KEYS) {
    const excess = _keys.size - MAX_KEYS;
    let dropped = 0;
    for (const k of _keys) {
      if (dropped++ >= excess) break;
      _keys.delete(k);
    }
  }
  persist();
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// ---------------------------------------------------------------------------
// Ineligible rows — items a service has definitively REFUSED.
//
// Trakt does not carry Frieren S02E10 under this numbering, and says so every
// time; AniList cannot resolve some titles at all. Those are verdicts about the
// ITEM, not about the attempt, so re-sending them on every run only burns
// rate-limit budget and re-reports the same failure. Rust marks such errors with
// `PERMANENT_PREFIX` (see scrobble.rs) and we retire the row here.
//
// Keyed by (service, id) WITHOUT played_at: if Trakt has no catalog entry for an
// episode, that is equally true of a re-watch of it. TTL'd, because a catalog can
// gain the entry later — a permanent-forever verdict would be wrong.
// ---------------------------------------------------------------------------

const INELIGIBLE_KEY_PREFIX = "aura:scrobble-ineligible:";
/** Long enough to stop the churn, short enough that a catalog fix lands. */
const INELIGIBLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_INELIGIBLE = 1000;

type IneligibleMap = Record<string, number>; // "service::id" -> marked-at (ms)

let _ineligibleScope = "guest";
let _ineligible: IneligibleMap = {};
let _ineligibleHydrated = false;

function ineligibleKey(scope: string): string {
  return `${INELIGIBLE_KEY_PREFIX}${scope}`;
}

function hydrateIneligible(scope: string): void {
  if (_ineligibleHydrated && _ineligibleScope === scope) return;
  _ineligibleScope = scope;
  _ineligibleHydrated = true;
  try {
    const raw = localStorage.getItem(ineligibleKey(scope));
    const parsed = raw ? JSON.parse(raw) : {};
    _ineligible = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    _ineligible = {};
  }
}

/** Has this service definitively refused this item (and not yet expired)? */
export function isIneligible(scope: string, service: ScrobbleService, id: string): boolean {
  hydrateIneligible(scope);
  const at = _ineligible[`${service}::${id}`];
  if (at == null) return false;
  return Date.now() - at < INELIGIBLE_TTL_MS;
}

/** Retire an item for a service after a PERMANENT_PREFIX failure. */
export function markIneligible(scope: string, service: ScrobbleService, id: string): void {
  hydrateIneligible(scope);
  const key = `${service}::${id}`;
  const now = Date.now();
  _ineligible[key] = now;
  const keys = Object.keys(_ineligible);
  if (keys.length > MAX_INELIGIBLE) {
    // Drop the oldest marks (and anything already expired) back under the cap.
    keys
      .filter((k) => now - _ineligible[k] >= INELIGIBLE_TTL_MS)
      .forEach((k) => delete _ineligible[k]);
    const still = Object.keys(_ineligible);
    if (still.length > MAX_INELIGIBLE) {
      still
        .sort((a, b) => _ineligible[a] - _ineligible[b])
        .slice(0, still.length - MAX_INELIGIBLE)
        .forEach((k) => delete _ineligible[k]);
    }
  }
  safeSetItem(ineligibleKey(_ineligibleScope), JSON.stringify(_ineligible));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function onScrobbledChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}
