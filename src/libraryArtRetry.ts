// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import type { AddonEntry, LibraryItem } from "./types";
import { electMetaAddons } from "./addonElection";
import { getMetaDetail } from "./metaCache";

// ---------------------------------------------------------------------------
// libraryArtRetry — best-effort backfill of missing Library posters.
//
// Some Library items (often UNRELEASED titles synced from Stremio) have no
// poster yet; the addon gains one as the title approaches release. This hook
// retries, per-id, at most ~once an hour (throttle persisted to localStorage)
// and updates the in-memory Library item's poster on success. It NEVER mutates
// the Stremio cloud record — purely a UI enrichment, same as App's poster-warm.
//
// It asks the elected meta providers through metaCache, so it shares the
// single-flight with every other surface and a poster it finds lands in the
// shared cache. The normal TTL (up to 7 days for a movie) would pin a cached
// "no poster yet" answer across many hourly passes, so it reads with a short
// max age instead (RECHECK_MAX_AGE_MS): only an answer another surface fetched
// minutes ago is reused, and anything older is re-queried.
// ---------------------------------------------------------------------------

const KEY = "aura:art-retry:v1";
const HOUR_MS = 60 * 60 * 1000;
/** Well under the hourly cadence on purpose. The attempt is stamped BEFORE
 *  its fetch lands, so the cache entry that fetch writes is always slightly
 *  younger than the throttle says; a max age of a full hour would turn the
 *  next pass into a cache hit on the very answer it is retrying. */
const RECHECK_MAX_AGE_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;

function loadAttempts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>; }
  catch { return {}; }
}
function saveAttempts(a: Record<string, number>) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* quota — ignore */ }
}

/** Hourly retry: for Library items with a null poster whose last attempt was
 *  >= 1h ago, walk the elected meta providers until one returns a poster;
 *  call applyPoster(id, poster) on success. In-memory only. */
export function useLibraryArtRetry(
  library: LibraryItem[],
  addons: AddonEntry[] | undefined,
  applyPoster: (id: string, poster: string) => void,
) {
  const running = useRef(false);
  const libRef = useRef(library);
  libRef.current = library;
  const addonsRef = useRef(addons);
  addonsRef.current = addons;
  const applyRef = useRef(applyPoster);
  applyRef.current = applyPoster;

  useEffect(() => {
    const run = async () => {
      if (running.current) return;
      const items = libRef.current;
      const adds = addonsRef.current;
      if (!adds || adds.length === 0 || items.length === 0) return;

      const now = Date.now();
      const currentIds = new Set(items.map((i) => i.id));
      // Prune throttle entries for ids no longer in the library (removed /
      // unsynced) so the persisted map can't grow unbounded over time.
      const attempts: Record<string, number> = {};
      let prunedAny = false;
      for (const [id, ts] of Object.entries(loadAttempts())) {
        if (currentIds.has(id)) attempts[id] = ts; else prunedAny = true;
      }
      const due = items.filter((it) =>
        !it.poster && !it.removed && (now - (attempts[it.id] ?? 0) >= HOUR_MS));
      if (due.length === 0) {
        if (prunedAny) saveAttempts(attempts);
        return;
      }

      running.current = true;
      try {
        for (let i = 0; i < due.length; i += CONCURRENCY) {
          const batch = due.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (it) => {
            attempts[it.id] = Date.now();
            // getMetaDetail resolves null on any failure, so a dead addon
            // just moves the walk on to the next candidate.
            for (const a of electMetaAddons(adds, it.media_type, it.id)) {
              const d = await getMetaDetail(a, it.media_type, it.id, RECHECK_MAX_AGE_MS);
              if (d?.poster) { applyRef.current(it.id, d.poster); return; }
            }
          }));
        }
      } finally {
        saveAttempts(attempts);
        running.current = false;
      }
    };
    // Initial run shortly after mount, then hourly. Refs keep library/addons
    // fresh without resetting the timer.
    const t = setTimeout(run, 4000);
    const id = setInterval(run, HOUR_MS);
    return () => { clearTimeout(t); clearInterval(id); };
  }, []);
}
