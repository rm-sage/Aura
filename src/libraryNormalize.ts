// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LibraryItem } from "./types";

// ---------------------------------------------------------------------------
// libraryNormalize — collapse the raw Stremio library_get response into a
// clean view that Library / Calendar / Continue Watching can all consume.
//
// Earlier Aura builds (before the `series_id` split in libraryActions.ts)
// wrote per-episode library entries for series — `_id = "tt0903747:1:5"`.
// Those entries:
//   • appear as duplicate ghost cards in the Library grid (one per watched
//     episode, all called "Frieren: Beyond Journey's End", no posters
//     because the per-episode write didn't carry one)
//   • make Calendar fetch /meta/series/<episode-id>.json which returns
//     name="?" / videos=[] (addons key meta off the series root id)
//   • make DetailView open at episode-id where the addon either 404s or
//     returns an empty videos array → "No episode list" message
//
// Fix: we never show the raw library to the UI. We normalise at App's
// load_library boundary so each series shows up as ONE canonical entry,
// keyed by the series root id, with the most-recent per-episode entry's
// playback state hoisted to `state.timeOffset` / `state.video_id`.
// ---------------------------------------------------------------------------

/**
 * Strip an episode-level Stremio id back to its series root.
 *
 * Examples:
 *   tt0903747         → tt0903747          (already root)
 *   tt0903747:1:5     → tt0903747          (IMDb episode, no prefix)
 *   kitsu:12345       → kitsu:12345        (already root)
 *   kitsu:12345:5     → kitsu:12345        (anime episode, with prefix)
 *   mal:42:7          → mal:42             (anime episode, with prefix)
 *
 * Heuristic: 3+ segments (2+ colons) means episode-level. The FIRST
 * segment discriminates a pure-alpha namespace prefix (`kitsu`, `mal`,
 * `tmdb`, …) from an alphanumeric IMDb id (`tt0903747`): a prefixed id
 * keeps its `<prefix>:<id>` root, a bare IMDb id is the root by itself.
 */
export function libraryItemSeriesId(id: string): string {
  const parts = id.split(":");
  if (parts.length <= 2) return id;
  const hasPrefix = /^[a-zA-Z]+$/.test(parts[0]);
  return hasPrefix ? `${parts[0]}:${parts[1]}` : parts[0];
}

/** Compare ISO timestamps lexicographically — empty string < any real
 *  timestamp so newly-written items always win the merge. */
function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "") > (b ?? "");
}

/**
 * Collapse per-episode rows into a single canonical entry per series root.
 *
 * Merge rules:
 *   • Series-level row (id matches its own series id) wins for the static
 *     metadata (name, poster, background, logo, year, ctime, removed, temp).
 *     The user's "Add to Library" creates that record.
 *   • Most-recent row by `_mtime` provides the playback state — timeOffset,
 *     duration, video_id (so resume jumps straight to the right episode).
 *   • If only episode-level rows exist (auto-tracked by old Aura builds,
 *     no explicit Add), we promote the newest one's metadata too — that
 *     way we still have a poster / name to render.
 */
export function normalizeLibrary(raw: LibraryItem[]): LibraryItem[] {
  const groups = new Map<string, LibraryItem[]>();
  for (const item of raw) {
    if (!item || !item.id) continue;
    const key = libraryItemSeriesId(item.id);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const out: LibraryItem[] = [];
  for (const [seriesId, list] of groups.entries()) {
    // Find the canonical metadata source — prefer an explicit series-root
    // entry, fall back to the most-recently-touched episode-level entry.
    const seriesRoot = list.find((i) => i.id === seriesId) ?? null;
    const newest = list.reduce<LibraryItem | null>(
      (best, i) => (best == null || newer(i.mtime, best.mtime) ? i : best),
      null,
    );
    const metaSource = seriesRoot ?? newest!;

    // The state we surface to the UI is the most-recent NON-ZERO playback
    // state across the group — so a freshly cleared episode (timeOffset=0)
    // doesn't mask an older one that's still in progress, and the most
    // recent watched episode wins for resume.
    let stateSource: LibraryItem | null = null;
    let stateMtime = "";
    for (const i of list) {
      const s = (i.state ?? {}) as { timeOffset?: number };
      const off = typeof s.timeOffset === "number" ? s.timeOffset : 0;
      if (off <= 0) continue;
      if ((i.mtime ?? "") > stateMtime) {
        stateSource = i;
        stateMtime = i.mtime ?? "";
      }
    }

    // Build the merged record. State comes from stateSource if we found
    // one; otherwise from the canonical row (which may have timeOffset=0).
    const baseState = (metaSource.state ?? {}) as Record<string, unknown>;
    let state: Record<string, unknown> = baseState;
    if (stateSource && stateSource.id !== seriesId) {
      // Hoist the per-episode state to the series root and stamp the
      // resume hint so DetailView can jump straight to streams.
      const incoming = (stateSource.state ?? {}) as Record<string, unknown>;
      state = {
        ...baseState,
        ...incoming,
        video_id: incoming.video_id ?? stateSource.id,
      };
    } else if (stateSource) {
      state = stateSource.state as Record<string, unknown>;
    }
    // Canonicalize state.timeOffset and state.duration to SECONDS.
    //
    // Stremio's official protocol stores these in MILLISECONDS — every
    // first-party client (web, Android, TV) writes ms-scale values.
    // Aura historically wrote seconds (the libmpv-native unit), so a
    // mixed library can carry both. The Resume-where-you-left-off
    // popup was reading the raw ms values as seconds and showing
    // "9:10:33 / 683:23:12 - 1% in" for a 41-minute episode (ratio
    // correct, magnitudes 1000x off).
    //
    // Heuristic: a real `duration` for any media doesn't exceed
    // ~24 hours in seconds (86,400). When duration crosses that, the
    // record is in ms; convert both fields together so the ratio is
    // preserved. Aura-written-in-seconds records pass through
    // unchanged. The write side now writes ms too (libraryActions),
    // so over time every record converges to the Stremio convention
    // and this heuristic becomes a no-op for that account.
    const SECONDS_IN_DAY = 86_400;
    const rawDuration = typeof state.duration === "number" ? state.duration : 0;
    const rawOffset   = typeof state.timeOffset === "number" ? state.timeOffset : 0;
    if (rawDuration > SECONDS_IN_DAY) {
      state = {
        ...state,
        duration:   rawDuration / 1000,
        timeOffset: rawOffset   / 1000,
      };
    }

    out.push({
      id:         seriesId,
      media_type: metaSource.media_type,
      name:       metaSource.name,
      poster:     metaSource.poster,
      background: metaSource.background,
      logo:       metaSource.logo,
      year:       metaSource.year,
      removed:    metaSource.removed ?? false,
      temp:       metaSource.temp ?? false,
      ctime:      metaSource.ctime ?? null,
      mtime:      stateMtime || metaSource.mtime || null,
      state:      state as LibraryItem["state"],
    });
  }
  return out;
}
