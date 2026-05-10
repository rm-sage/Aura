// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem, MetaPreview } from "./types";
import { libraryItemSeriesId } from "./libraryNormalize";

// ---------------------------------------------------------------------------
// libraryActions — toggle membership of a meta in the user's Stremio library.
//
// Stremio's `libraryItem` collection wants per-item change objects keyed by
// `_id`. To "add", we emit the full item with `removed: false`. To "remove",
// we re-emit it with `removed: true` (Stremio uses tombstones — never DELETE).
//
// Both ctime and mtime are required ISO timestamps. If the item already exists
// we preserve its ctime and just bump mtime; otherwise both default to now.
//
// All this is best-effort — if the auth_key is missing or the request fails,
// we surface the error string but never throw past the caller.
// ---------------------------------------------------------------------------

const SESSION_EXPIRED = "SESSION_EXPIRED";

function nowIso(): string {
  return new Date().toISOString();
}

/** Build a Stremio library change record for a given meta. Genres are
 *  written into state so anime-only signals (which only the catalog
 *  meta carries) survive the round-trip through Stremio's library
 *  store. Without this, the right-click menu on a CW card had no way
 *  to know e.g. an IMDb-id'd Frieren entry was anime — the catalog's
 *  genres were lost the moment the user added it to their library. */
function buildChange(
  meta: MetaPreview,
  existing: LibraryItem | null,
  removed: boolean,
): Record<string, unknown> {
  const ctime = existing?.ctime ?? nowIso();
  const mtime = nowIso();
  const baseState = (existing?.state ?? {}) as Record<string, unknown>;
  const nextState: Record<string, unknown> = { ...baseState };
  if (Array.isArray(meta.genres) && meta.genres.length > 0) {
    nextState.genres = meta.genres;
  }
  return {
    _id:        meta.id,
    type:       meta.media_type,
    name:       meta.name,
    poster:     meta.poster ?? null,
    background: meta.background ?? null,
    logo:       meta.logo ?? null,
    year:       meta.release_info ?? null,
    removed,
    temp:       false,
    _ctime:     ctime,
    _mtime:     mtime,
    state:      nextState,
  };
}

export interface LibraryToggleResult {
  /** True after a successful add; false after a successful remove. */
  added: boolean;
}

/**
 * Toggle a meta in/out of the cloud library.
 *
 * @param authKey — Stremio session auth key. Required.
 * @param meta    — the catalog item being toggled.
 * @param library — current local library snapshot (drives existing detection).
 * @returns       — whether the item is now ADDED (true) or REMOVED (false).
 *
 * Side effects: dispatches `aura:library-changed` so the frontend can re-fetch
 * `library_get` and refresh dependent rows (Continue Watching, Calendar).
 */
export async function libraryToggle(
  authKey: string,
  meta: MetaPreview,
  library: LibraryItem[],
): Promise<LibraryToggleResult> {
  const existing = library.find((i) => i.id === meta.id) ?? null;
  // If it currently exists AND is not flagged removed → we're removing.
  const isCurrentlyIn = !!existing && !existing.removed;
  const change = buildChange(meta, existing, /* removed */ isCurrentlyIn);

  console.info(
    `[library] toggle ${isCurrentlyIn ? "REMOVE" : "ADD"} id=${meta.id} ` +
      `name="${meta.name}" prevExisting=${!!existing} prevRemoved=${existing?.removed === true}`,
  );

  try {
    await invoke("library_put", { authKey, changes: [change] });
    console.info(
      `[library] toggle ${isCurrentlyIn ? "REMOVE" : "ADD"} OK id=${meta.id}`,
    );
  } catch (err) {
    console.warn(`[library] toggle FAIL id=${meta.id} err=${String(err)}`);
    throw err;
  }
  window.dispatchEvent(new CustomEvent("aura:library-changed"));
  return { added: !isCurrentlyIn };
}

/**
 * Write playback progress back to the Stremio cloud library.
 *
 * - If the item already exists in the library, we update state.timeOffset and
 *   state.duration in place (preserving any other state keys).
 * - If it doesn't exist, we create a `temp: true` entry — Stremio's convention
 *   for auto-tracked items the user didn't explicitly "Add to Library".
 *
 * Best-effort: surfaces errors but never throws past the caller.
 */
export async function libraryWriteProgress(
  authKey: string,
  target: { id: string; series_id?: string; media_type: string; name: string },
  library: LibraryItem[],
  time: number,
  duration: number,
): Promise<void> {
  if (!authKey || !target || duration <= 0 || time < 0) return;

  // The library record is keyed at the series root (or movie root). The
  // `target.id` carries the EPISODE id for series — we route that into
  // state.video_id so it doubles as the resume hint. Without this:
  //   • CW cards render a blank detail page (clicking opens DetailView
  //     keyed by episode id, which addons can't resolve to series meta).
  //   • Series proliferate in the library — one entry per watched
  //     episode instead of one per series.
  const recordId = target.series_id ?? target.id;
  const isEpisode = target.series_id != null && target.series_id !== target.id;

  const existing = library.find((i) => i.id === recordId) ?? null;
  const ctime = existing?.ctime ?? nowIso();
  const mtime = nowIso();

  // Merge state — preserve unknown keys (Stremio round-trips opaque state).
  //
  // Stremio's protocol stores `timeOffset` and `duration` in
  // MILLISECONDS. Every first-party Stremio client (web, Android, TV)
  // writes ms-scale values. Aura historically wrote seconds (the
  // libmpv-native unit), which broke cross-client compatibility AND
  // fed the Resume-where-you-left-off popup numbers that were 1000x
  // too large when the record had been touched by another client (or
  // 1000x too small to other clients reading our writes). Multiply
  // here so every Aura write matches the convention; the read side
  // (libraryNormalize.ts) auto-converts inbound records of either
  // unit so legacy Aura-written-in-seconds records still display
  // correctly during the transition.
  const prevState = (existing?.state ?? {}) as Record<string, unknown>;
  const nextState: Record<string, unknown> = {
    ...prevState,
    timeOffset: Math.round(time * 1000),
    duration:   Math.round(duration * 1000),
  };
  if (isEpisode) {
    // Stremio's resume hint — picks the episode the user was last on.
    nextState.video_id = target.id;
  }

  const change: Record<string, unknown> = {
    _id:        recordId,
    type:       target.media_type,
    name:       existing?.name ?? target.name,
    poster:     existing?.poster ?? null,
    background: existing?.background ?? null,
    logo:       existing?.logo ?? null,
    year:       existing?.year ?? null,
    // Don't bring an item back from removed=true here — only progress writes.
    removed:    existing?.removed ?? false,
    // `temp: true` marks auto-tracked entries (vs explicit Add to Library).
    temp:       existing?.temp ?? true,
    _ctime:     ctime,
    _mtime:     mtime,
    state:      nextState,
  };

  await invoke("library_put", { authKey, changes: [change] });
}

/**
 * Remove an item from Continue Watching by clearing its playback state.
 *
 * Stremio's CW row is computed client-side from `state.timeOffset > 0`, so
 * resetting `timeOffset` (and `duration`) to 0 is enough to drop the card.
 * We deliberately DO NOT set `removed: true` here — the user may still want
 * the item in their Library (with notifications), just not in CW.
 *
 * For genuinely auto-tracked entries (temp: true and not in the user's
 * formal library), we mark removed:true so the Stremio cloud forgets them
 * entirely on next sync.
 */
/**
 * Stremio's "Rewind" — the action behind the small ✕ on a CW card.
 *
 * Critical: Stremio's official client (per stremio-core's
 * `RewindLibraryItem`) only mutates ONE field: `state.timeOffset = 0`.
 * Every other field — `removed`, `temp`, `duration`, `video_id`,
 * `lastWatched`, `overallTimeWatched`, etc. — is preserved verbatim.
 *
 * Why this matters:
 *   1. Stremio's server keys writes by `_mtime`. We MUST bump it; if our
 *      local copy has a stale mtime, the server's older-but-newer-mtime
 *      copy wins on the next sync and our zero is silently round-tripped.
 *   2. The CW filter is `time_offset > 0`. Zeroing that one field is
 *      sufficient to drop the row.
 *   3. Clearing `video_id` to null breaks Stremio's `LibraryItemDeepLinks`
 *      generator (the helper that turns a library item into a meta+stream
 *      URL) — that's what made Continue Watching click-through pages
 *      look blank: the deep-link route was malformed because `video_id`
 *      was missing AND there was no `behavior_hints.default_video_id`
 *      fallback. Keeping `video_id` intact preserves a clean re-watch
 *      path even after rewind.
 */
export async function libraryClearProgress(
  authKey: string,
  item: LibraryItem,
): Promise<void> {
  if (!authKey) return;
  const mtime = nowIso();
  const prevState = (item.state ?? {}) as Record<string, unknown>;
  const nextState = {
    ...prevState,
    timeOffset: 0,
  };
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
  console.info("[libraryClearProgress] rewind", { id: item.id, mtime });
  await invoke("library_put", { authKey, changes: [change] });
  // Intentionally NOT dispatching `aura:library-changed` here — the
  // App's clear handler does the optimistic local update, and triggering
  // a fresh library_get right after a write races with Stremio's
  // eventual consistency (the server's diff-by-mtime hasn't seen our
  // write yet, the pull would round-trip the OLD non-zero state back).
}

/**
 * Aggressive remove — sends `removed: true` for every entry in `rawLibrary`
 * whose series-root id matches `seriesId`. This is the antidote to phantom
 * library tiles: when an old per-episode record (`tt0903747:1:5`) survives
 * on Stremio's server alongside a fresh series-root record (`tt0903747`),
 * the normalizer collapses both into one UI tile but a vanilla
 * `libraryToggle` only marks the series root removed — the phantom
 * episode-level row stays unflagged and the next normalize re-surfaces
 * it as a tile with stale (often blank) metadata.
 *
 * Pass the RAW library (the un-normalized array straight from
 * `library_get`) so this function can see every contributing record.
 */
export async function libraryRemoveAll(
  authKey: string,
  seriesId: string,
  rawLibrary: LibraryItem[],
): Promise<{ removedCount: number }> {
  if (!authKey) return { removedCount: 0 };

  const matches = rawLibrary.filter((i) => libraryItemSeriesId(i.id) === seriesId);
  if (matches.length === 0) {
    console.warn(`[library] removeAll seriesId=${seriesId}: no matching raw entries`);
    return { removedCount: 0 };
  }

  const mtime = nowIso();
  const changes = matches.map((item) => ({
    _id:        item.id,
    type:       item.media_type,
    name:       item.name,
    poster:     item.poster ?? null,
    background: item.background ?? null,
    logo:       item.logo ?? null,
    year:       item.year ?? null,
    removed:    true,
    temp:       item.temp ?? false,
    _ctime:     item.ctime ?? mtime,
    _mtime:     mtime,
    state:      item.state ?? {},
  }));

  console.info(
    `[library] removeAll seriesId=${seriesId} (${matches.length} record${matches.length === 1 ? "" : "s"}): ` +
      matches.map((m) => m.id).join(", "),
  );
  try {
    await invoke("library_put", { authKey, changes });
    console.info(`[library] removeAll OK seriesId=${seriesId}`);
  } catch (err) {
    console.warn(`[library] removeAll FAIL seriesId=${seriesId} err=${String(err)}`);
    throw err;
  }
  window.dispatchEvent(new CustomEvent("aura:library-changed"));
  return { removedCount: matches.length };
}

export { SESSION_EXPIRED };
