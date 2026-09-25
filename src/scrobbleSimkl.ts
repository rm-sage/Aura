// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { HISTORY_COMMAND } from "./scrobbleConn";
import type { HistoryEntry } from "./historyStore";

// ---------------------------------------------------------------------------
// scrobbleSimkl - the frontend half of `scrobble_history_simkl`.
//
// Simkl's History command is the one BATCHED sibling of the per-row Trakt /
// AniList commands: Simkl allows about one POST per second (plus a 20 s
// per-user write lock), so a bulk run of one call per row is unsafe. It takes
// every row in ONE call, sends them in chunks of 100 at Simkl's pace, and
// answers with one result per row, in input order. Every caller (the History
// row button, the bulk runner, skip actions) goes through `pushSimklHistory`,
// so none of them can build the batch differently or read the answer
// differently.
// ---------------------------------------------------------------------------

/** One row, in the camelCase keys `SimklHistoryItem` (scrobble_simkl.rs)
 *  deserializes. The same fields the per-row commands take, minus `scope`. */
export interface SimklHistoryItem {
  id: string;
  parentId: string | null;
  mediaType: string;
  season: number | null;
  episode: number | null;
  name: string;
  /** The original watch time, ISO 8601 UTC, that the row is backdated to. */
  playedAt: string;
  anilistId: number | null;
  anilistEpisode: number | null;
}

/** `added` counts as scrobbled. `not_found` and `skipped` are verdicts about
 *  the ITEM (no catalog match, no usable id), so a retry changes nothing and
 *  the row is retired like a Trakt / AniList permanent failure. `failed` is
 *  about the attempt and is left for the next run. */
export type SimklItemStatus = "added" | "not_found" | "failed" | "skipped";

export interface SimklItemResult {
  status: SimklItemStatus;
  message: string;
}

/** A u32 / u64 for the Rust side, or null. One malformed number would fail
 *  deserialization of the WHOLE batch, taking every other row down with it,
 *  so anything that is not a non-negative integer is sent as "absent". */
function wireInt(n: number | null | undefined, max: number): number | null {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

const U32_MAX = 0xffff_ffff;

export function simklItemFromEntry(entry: HistoryEntry): SimklHistoryItem {
  return {
    id: entry.id,
    parentId: entry.parent_id ?? null,
    mediaType: entry.media_type ?? "",
    season: entry.season ?? null,
    episode: entry.episode ?? null,
    name: entry.name ?? "",
    playedAt: entry.played_at,
    anilistId: entry.anilist_id ?? null,
    anilistEpisode: entry.anilist_episode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Eligibility: "is there anything here Simkl can key on?"
//
// A mirror of `targets` in scrobble_simkl.rs, which is the authority: a row
// this accepts and Rust cannot place comes back `skipped`, so a drift here
// costs one wasted row, never a wrong write. Keep the two in step anyway.
//   - movie: an IMDb id (the row's own, or the parent's), or a bare anime /
//     TMDB / TVDB id with no trailing numbers.
//   - episode: EITHER the addon's AniList pair (anilistId + anilistEpisode),
//     or an anime-database id carrying exactly one episode number
//     (`kitsu:46474:5`); OR show-level ids (a parent IMDb id, or an
//     IMDb / TMDB / TVDB video id) plus a season and a positive episode number.
// ---------------------------------------------------------------------------

/** Stremio id prefixes naming one anime entry, episodes local to it. */
const ANIME_ID_KEYS = ["anilist", "anidb", "kitsu", "mal"];
/** Stremio id prefixes naming a whole show (or a movie). */
const SHOW_ID_KEYS = ["tmdb", "tvdb"];

function isImdb(s: string): boolean {
  return s.length <= 16 && /^tt\d+$/.test(s);
}

/** A Stremio id split into its database key and trailing numbers
 *  (`tt0903747:1:5` -> imdb [1, 5]; `kitsu:46474:5` -> kitsu [5]). Null for
 *  anything not well-formed, exactly as Rust's `parse_stremio_id`. */
function parseStremioId(id: string): { key: string; rest: number[] } | null {
  const parts = id.trim().split(":");
  const head = parts[0];
  let key: string;
  let tail: string[];
  if (isImdb(head)) {
    key = "imdb";
    tail = parts.slice(1);
  } else {
    if (!ANIME_ID_KEYS.includes(head) && !SHOW_ID_KEYS.includes(head)) return null;
    const value = parts[1];
    if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) return null;
    key = head;
    tail = parts.slice(2);
  }
  const rest: number[] = [];
  for (const p of tail) {
    if (!/^\d+$/.test(p) || Number(p) > U32_MAX) return null;
    rest.push(Number(p));
  }
  return { key, rest };
}

export function simklCanIdentify(item: SimklHistoryItem): boolean {
  const video = parseStremioId(item.id);
  const parentImdb = item.parentId != null && isImdb(item.parentId.trim());

  if (item.mediaType === "movie") {
    return (video !== null && video.rest.length === 0) || parentImdb;
  }

  const cour =
    ((item.anilistId ?? 0) > 0 && (item.anilistEpisode ?? 0) > 0)
    || (video !== null && ANIME_ID_KEYS.includes(video.key)
        && video.rest.length === 1 && video.rest[0] > 0);
  if (cour) return true;

  const showVideo =
    video !== null && (video.key === "imdb" || SHOW_ID_KEYS.includes(video.key)) ? video : null;
  if (!parentImdb && !showVideo) return false;
  // The row's own season / episode win over the id-parsed ones, as in Rust.
  const number = item.season != null && item.episode != null
    ? item.episode
    : showVideo && showVideo.rest.length === 2 ? showVideo.rest[1] : null;
  return number != null && number > 0;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

interface WireResult {
  id: string;
  played_at: string;
  status: string;
  message: string;
}

const STATUSES: readonly SimklItemStatus[] = ["added", "not_found", "failed", "skipped"];

/**
 * Push `items` to Simkl's history in ONE command call and return one result
 * per item, `results[i]` answering `items[i]`. Rejects (with Rust's message)
 * only for whole-batch conditions: Simkl not set up in this build, not
 * connected, or its sign-in gone.
 *
 * Mapped back by INDEX, as the command promises, and each answer's echoed
 * (id, played_at) is checked against the row it claims to answer: a result
 * that does not match, or is missing, is reported `failed` rather than marking
 * the wrong row scrobbled.
 */
export async function pushSimklHistory(
  scope: string,
  items: SimklHistoryItem[],
): Promise<SimklItemResult[]> {
  if (items.length === 0) return [];
  const wire = items.map((item) => ({
    ...item,
    season: wireInt(item.season, U32_MAX),
    episode: wireInt(item.episode, U32_MAX),
    anilistId: wireInt(item.anilistId, Number.MAX_SAFE_INTEGER),
    anilistEpisode: wireInt(item.anilistEpisode, U32_MAX),
  }));
  const results = await invoke<WireResult[]>(HISTORY_COMMAND.simkl, { scope, items: wire });
  return items.map((item, i): SimklItemResult => {
    const r = Array.isArray(results) ? results[i] : undefined;
    if (!r || r.id !== item.id || r.played_at !== item.playedAt) {
      return { status: "failed", message: "Simkl sent no answer for this item. Try again." };
    }
    const status = (STATUSES as readonly string[]).includes(r.status)
      ? (r.status as SimklItemStatus)
      : "failed";
    return { status, message: r.message };
  });
}
