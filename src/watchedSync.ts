// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// watchedSync.ts ──────────────────────────────────────────────────────────
//
// Push + pull bridge between Aura's local manualWatched store and the user's
// Stremio cloud library. Only the "watched" state syncs — "in-progress"
// and "planned" stay local per spec, since both are personal-use states
// the user doesn't expect to see propagated to other Stremio clients.
//
// SCOPE
//   • Movies: full sync. The library item carries `state.aura_watched` +
//     `state.timeOffset = state.duration` so any Stremio client that
//     looks at the standard 90 % "watched" threshold also recognises it.
//   • Series root: full sync via the same `state.aura_watched` flag.
//     state.timeOffset isn't bumped because it's per-LAST-EPISODE in
//     Stremio's model, not series-level.
//   • Episode-level marks (e.g. tt0903747:1:5): NOT synced. Stremio's
//     library is keyed at the series root; per-episode watched marks
//     have no canonical cloud field. They remain in localStorage and
//     don't propagate across devices.
//
// PUSH
//   Listens for the `aura:watched-sync` event the manualWatched module
//   emits on every state transition. When a series-root or movie id
//   crosses into or out of "watched", we round-trip the diff to the
//   cloud via `library_put`. Other transitions (planned ↔ null,
//   in-progress ↔ null) are local-only and ignored.
//
// PULL
//   Called once per `library_get` refresh. For every non-removed item
//   whose state.aura_watched is true (or — for movies — whose
//   timeOffset / duration ≥ 0.9), we mirror it into manualWatched as
//   "watched" IF the local mark is currently null. We never override
//   an explicit local "in-progress" / "planned" / "watched" with a
//   cloud-derived value — local user intent always wins over a stale
//   cross-device snapshot.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem } from "./types";
import {
  getManualWatchedState,
  setManualWatchedState,
} from "./manualWatched";

const WATCHED_THRESHOLD = 0.9;

function nowIso(): string {
  return new Date().toISOString();
}

/** Push a single library item's watched flag to Stremio. Used by the
 *  push half of the bridge wired up in App.tsx. Best-effort — caller
 *  should `.catch(() => {})` to swallow network errors. */
export async function pushItemWatched(
  authKey: string,
  item: LibraryItem,
  watched: boolean,
): Promise<void> {
  if (!authKey || !item) return;
  const mtime = nowIso();
  const prevState = (item.state ?? {}) as Record<string, unknown>;
  const nextState: Record<string, unknown> = { ...prevState };

  if (watched) {
    nextState.aura_watched = true;
    // For movies, also bump timeOffset to match duration so vanilla
    // Stremio clients (and Aura's own catalog overlay) see it as
    // watched via the 90 % threshold. For series the timeOffset is
    // per-last-episode, so we leave it alone — `aura_watched` is the
    // signal of record at series-root level.
    const t = (item.media_type ?? "").toLowerCase();
    const isMovie = t !== "series" && t !== "anime";
    if (isMovie && typeof prevState.duration === "number" && prevState.duration > 0) {
      nextState.timeOffset = prevState.duration;
    }
  } else {
    delete nextState.aura_watched;
    // Movie unmark — also clear timeOffset so the catalog overlay
    // stops showing the green check. For series we don't touch
    // timeOffset (still represents last-episode position).
    const t = (item.media_type ?? "").toLowerCase();
    const isMovie = t !== "series" && t !== "anime";
    if (isMovie) {
      nextState.timeOffset = 0;
    }
  }

  const change: Record<string, unknown> = {
    _id:        item.id,
    type:       item.media_type,
    name:       item.name,
    poster:     item.poster ?? null,
    background: item.background ?? null,
    logo:       item.logo ?? null,
    year:       item.year ?? null,
    removed:    item.removed ?? false,
    temp:       item.temp ?? false,
    _ctime:     item.ctime ?? mtime,
    _mtime:     mtime,
    state:      nextState,
  };

  await invoke("library_put", { authKey, changes: [change] });
}

/** Mirror cloud watched flags into the local manualWatched store.
 *  Idempotent — only sets a mark when the local state is currently
 *  null. Episodes are never touched (they live below the library's
 *  series-root resolution and have no cloud representation here).
 *
 *  Returns the count of ids that were freshly mirrored, primarily for
 *  diagnostic logging. Does not throw. */
export function mirrorWatchedFromCloud(library: LibraryItem[]): number {
  let mirrored = 0;
  for (const item of library) {
    if (item.removed) continue;
    const state = (item.state ?? {}) as Record<string, unknown>;
    const explicitWatched = state.aura_watched === true;
    const t = (item.media_type ?? "").toLowerCase();
    const isMovie = t !== "series" && t !== "anime";
    const timeOffset = typeof state.timeOffset === "number" ? state.timeOffset : 0;
    const duration   = typeof state.duration   === "number" ? state.duration   : 0;
    const positionWatched =
      isMovie && duration > 0 && timeOffset / duration >= WATCHED_THRESHOLD;

    if (!explicitWatched && !positionWatched) continue;
    // Only mirror when the local mark is null — never override an
    // explicit local "in-progress" / "planned" / "watched" with a
    // cloud-derived value (the local mark may have been set just now
    // via the push half before the library refetch round-trip).
    const current = getManualWatchedState(item.id);
    if (current !== null) continue;
    setManualWatchedState(item.id, "watched");
    mirrored += 1;
  }
  if (mirrored > 0) {
    console.info(`[watched-sync] mirrored ${mirrored} cloud watched mark(s) → local`);
  }
  return mirrored;
}
