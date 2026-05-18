// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// invokeDedupe — single-flight wrapper for Tauri invoke calls.
//
// React StrictMode (and any transient remount) double-invokes effects in
// dev mode. Without dedupe, the second invocation fires a duplicate
// network round-trip that the consumer immediately discards via its
// `cancelled` cleanup flag — but the addon / ratings API / etc. still pays
// the cost. Logs show pairs of identical requests within ~1 ms,
// matching the StrictMode pattern.
//
// Strategy: keep a Map keyed by a caller-provided string. While the
// promise is in flight, every caller for the same key gets handed the
// SAME promise. On settle the key clears so a fresh call after the
// fact still does real work.
//
// Used by:
//   • SearchView — global_search_grouped (already had its own copy;
//     this module exists to share the pattern instead of duplicating)
//   • DetailView — fetch_meta_detail, fetch_streams, ratings fan-out
//   • anywhere else that double-fire shows up
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

/** Run `factory()` at most once per `key` while the prior call is still
 *  pending. The promise is shared between concurrent callers; each gets
 *  the same resolved value. Once the promise settles, the key is
 *  cleared so a fresh call picks up new state. */
export function dedupedInvoke<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = factory().finally(() => {
    // Only clear if this is still the slot's promise. A newer call with
    // the same key would have replaced it; clearing the slot here
    // would let an even-newer call kick off another fetch.
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
