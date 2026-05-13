// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";
import { fetchReleaseSignals, type ReleaseSignal, type ReleaseSignalItem } from "./releaseSearch";
import { loadAuraSettings } from "./auraSettings";

// ---------------------------------------------------------------------------
// Release-signal store — module-level Map<imdb_id, signal-or-null>
// populated by `reconcileLibraryReleaseSignals(library, session)` and
// consumed by React via `useReleaseSignal(imdbId)`.
//
// The store is intentionally a separate concern from `releaseSearch.ts`:
// that module owns the wire calls + per-call cache; this module owns
// the cross-component view and the reconcile-on-library-load lifecycle.
//
// Update pattern mirrors manualWatched.ts:
//   • Mutations dispatch a `version` bump.
//   • `useSyncExternalStore` exposes a stable subscribe-and-snapshot
//     pair so components that only need to know "did the signal for
//     id X change?" can subscribe with one line.
//
// Guarded by `releaseSearchEnabled` + signed-in scope. Guest sessions
// and opted-out users bypass every code path here — the existing per-
// user addon probe surfaces still run unchanged.
// ---------------------------------------------------------------------------

const store = new Map<string, ReleaseSignal | null>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Reactive store version — React components subscribed via the
 *  hook below re-render when it changes. */
export function useReleaseSignalsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** Direct read for non-React code paths (autoAdvance, notifications
 *  scanner, etc.). Returns the signal when one's cached, `null` when
 *  the cloud returned null (queued/no record), or `undefined` when
 *  the store hasn't seen this id at all yet. Callers should treat
 *  `undefined` as "haven't checked" — different from `null` which
 *  means "checked, no signal". */
export function getReleaseSignal(imdbId: string): ReleaseSignal | null | undefined {
  if (!imdbId) return undefined;
  return store.has(imdbId) ? store.get(imdbId) ?? null : undefined;
}

/** React hook — subscribes the calling component to release-signal
 *  changes AND returns the current signal for `imdbId`. Re-renders
 *  on any signal change (cheap; usually 0-1 per library reconcile).
 *
 *  Returns `undefined` for ids not yet in the store. */
export function useReleaseSignal(imdbId: string | null | undefined): ReleaseSignal | null | undefined {
  void useReleaseSignalsVersion();
  if (!imdbId) return undefined;
  return store.has(imdbId) ? store.get(imdbId) ?? null : undefined;
}

interface LibraryLikeItem {
  id: string;
  media_type: string;
  /** Mirrored from the cloud spec's media-type enum — only "series"
   *  and "movie" are valid wire values. We filter out anime / channel
   *  / tv / etc. (those route via Stremio's series channel but the
   *  cloud's poller only knows series + movie). */
}

/** Coerce a library item's `media_type` to the cloud's enum, or null
 *  when neither maps cleanly. "anime" → "series" because the cloud's
 *  poller treats anime as series for episode-listing purposes. */
function coerceMediaType(raw: string): "series" | "movie" | null {
  const t = (raw ?? "").toLowerCase();
  if (t === "anime") return "series";
  if (t === "series" || t === "movie") return t;
  return null;
}

/** Idempotent guard so a flurry of library updates (sync pull,
 *  scope change, focus reload) doesn't trigger overlapping batch
 *  calls. Per-reconcile epoch — if a newer call starts before an
 *  older one finishes, the older one's writes are discarded. */
let reconcileEpoch = 0;

/**
 * Batch-fetch release signals for the entire library + write them
 * into the store. Intended to fire on:
 *   • Initial library load after sign-in.
 *   • Library refresh (sync pull, focus refetch).
 *   • Settings toggle from off → on.
 *
 * Bails (without firing the network call) when:
 *   • `releaseSearchEnabled` is false (user opt-out).
 *   • `isGuest` is true (cloud endpoints require a scope hash).
 *   • `library` is empty.
 *
 * Errors are surfaced to the console but never thrown — the existing
 * per-user addon probe path remains the fallback.
 */
export async function reconcileLibraryReleaseSignals(
  library: LibraryLikeItem[],
  isGuest: boolean,
): Promise<void> {
  if (isGuest) return;
  if (!loadAuraSettings().releaseSearchEnabled) return;
  if (!library || library.length === 0) return;

  const items: ReleaseSignalItem[] = [];
  for (const it of library) {
    if (!it.id) continue;
    if (!it.id.startsWith("tt")) continue; // cloud poller is imdb-keyed
    const t = coerceMediaType(it.media_type);
    if (!t) continue;
    items.push({ id: it.id, type: t });
  }
  if (items.length === 0) return;

  const myEpoch = ++reconcileEpoch;
  try {
    const result = await fetchReleaseSignals(items);
    // Stale-write guard — a newer reconcile may have started while we
    // awaited; let its writes win.
    if (myEpoch !== reconcileEpoch) return;
    let mutated = false;
    for (const [id, sig] of result.entries()) {
      const prev = store.get(id);
      if (prev !== sig) {
        store.set(id, sig);
        mutated = true;
      }
    }
    if (mutated) bump();
  } catch (err) {
    console.warn(`[release-signals] reconcile failed: ${String(err)}`);
  }
}

/** Drop everything. Called on session change so signals from a prior
 *  account don't leak. */
export function clearReleaseSignalStore(): void {
  if (store.size === 0) return;
  store.clear();
  bump();
}
