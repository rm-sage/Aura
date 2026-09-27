// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// IntroDB - IMDb-keyed crowd-sourced skip segments (src-tauri/src/introdb.rs).
//
// Two jobs live here so App.tsx and AniSkipMenu share one definition of each:
//
//   1. WHICH NUMBERINGS TO ASK. IntroDB rows are keyed by whatever numbering
//      the submitter used (Bleach has rows under both S1E250 and S12E5, neither
//      complete). Aura asks in the addon's own numbering first, then in the
//      other numbering it already KNOWS (the id-string pair when it differs
//      from the VideoEntry pair, or the absolute number under season 1 that
//      App's scrobble enrichment computes the same way). It never invents an
//      offset, and it uses exactly ONE answer: the first with a usable segment.
//
//   2. THE TRUST SPLIT is made in Rust ("introdb" for >= 2 submissions at
//      >= 0.9 confidence, "introdb-single" otherwise); this file only carries
//      the names. App.tsx's dedupeSkipWindows ranks them, and applySkipModes
//      keeps "introdb-single" prompt-only.
//
// Log label `[introdb]`.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { PersistentCache } from "./persistentCache";
import type { MetaDetail } from "./types";

export const INTRODB_SOURCE = "introdb";
export const INTRODB_SINGLE_SOURCE = "introdb-single";

export function isIntroDbSource(source: string | null | undefined): boolean {
  return source === INTRODB_SOURCE || source === INTRODB_SINGLE_SOURCE;
}

/** One validated window from Rust. `kind` is "op" | "recap" | "ed". */
export interface IntroDbWindow {
  kind:             string;
  start:            number;
  end:              number;
  source:           string;
  confidence:       number;
  submission_count: number;
}

type IntroDbReply =
  | { result: "segments"; found: boolean; windows: IntroDbWindow[] }
  | { result: "submitted"; outcome: IntroDbSubmitOutcome; message: string }
  | { result: "status"; has_key: boolean };

export type IntroDbSubmitOutcome =
  | "ok" | "rate_limited" | "key_rejected" | "invalid" | "no_key" | "unsupported" | "failed";

// Positive answers only, 3 days / 600 entries: the same policy as the AniSkip
// cache in App.tsx. A miss is never persisted (Rust keeps it for 30 minutes),
// so a fresh community submission surfaces on the next watch.
const cache = new PersistentCache<IntroDbWindow[]>({
  storageKey: "aura:introdb-cache:v1",
  ttlMs:      3 * 24 * 60 * 60 * 1000,
  maxEntries: 600,
});

const IMDB_RE = /^tt\d{7,8}$/;

/** The series' IMDb id, or null when the title is not IMDb-rooted (IntroDB
 *  knows nothing else). */
export function introDbImdbRoot(target: { id: string; series_id?: string | null }): string | null {
  if (target.series_id && IMDB_RE.test(target.series_id)) return target.series_id;
  const head = target.id.split(":")[0];
  return IMDB_RE.test(head) ? head : null;
}

export interface IntroDbNumbering {
  season:  number;
  episode: number;
  /** Where the pair came from, for the log line. */
  label:   "addon" | "id" | "absolute";
}

const validPair = (s: unknown, e: unknown): s is number =>
  Number.isInteger(s) && Number.isInteger(e) && (s as number) >= 1 && (e as number) >= 1;

/** The addon's exact numbering: the VideoEntry pair when present, else the
 *  `tt..:S:E` id pair. Null for a movie, a season-0 special, or an id with no
 *  numbering. This is also the numbering a user submission is filed under. */
export function introDbPrimaryNumbering(
  target: { id: string; season?: number | null; episode_num?: number | null },
): IntroDbNumbering | null {
  if (validPair(target.season, target.episode_num)) {
    return { season: target.season as number, episode: target.episode_num as number, label: "addon" };
  }
  const parts = target.id.split(":");
  if (parts.length === 3 && IMDB_RE.test(parts[0])) {
    const s = Number(parts[1]);
    const e = Number(parts[2]);
    if (validPair(s, e)) return { season: s, episode: e, label: "addon" };
  }
  return null;
}

/** Every numbering to try, in order, deduplicated. See the header. */
export function introDbNumberings(
  target: { id: string; season?: number | null; episode_num?: number | null },
  detail: MetaDetail | null,
): IntroDbNumbering[] {
  const out: IntroDbNumbering[] = [];
  const push = (n: IntroDbNumbering | null) => {
    if (!n || !validPair(n.season, n.episode)) return;
    if (out.some((o) => o.season === n.season && o.episode === n.episode)) return;
    out.push(n);
  };
  const primary = introDbPrimaryNumbering(target);
  push(primary);
  // The id-string pair, when the VideoEntry disagrees with it (AIOMetadata's
  // cour patch: id `tt..:1:250`, video season 12 episode 5).
  const parts = target.id.split(":");
  if (parts.length === 3 && IMDB_RE.test(parts[0])) {
    push({ season: Number(parts[1]), episode: Number(parts[2]), label: "id" });
  }
  // Absolute under season 1, computed exactly as App's absolute-episode
  // enrichment does (prior main-run seasons' episode count + this one). Only
  // meaningful past season 1, and only with the video list in hand.
  if (primary && primary.season > 1 && Array.isArray(detail?.videos) && detail!.videos.length > 0) {
    const prior = detail!.videos.filter(
      (v) => (v.season ?? 0) > 0 && (v.season ?? 0) < primary.season,
    ).length;
    if (prior > 0) push({ season: 1, episode: prior + primary.episode, label: "absolute" });
  }
  return out;
}

const cacheKey = (imdb: string, n: { season: number; episode: number }) =>
  `${imdb}:${n.season}:${n.episode}`;

/** Ask each numbering in turn and return the FIRST answer with a usable
 *  segment, or nothing. Never throws. */
export async function fetchIntroDbWindows(
  imdb: string,
  numberings: IntroDbNumbering[],
): Promise<{ windows: IntroDbWindow[]; matched: IntroDbNumbering | null }> {
  for (const n of numberings) {
    const key = cacheKey(imdb, n);
    let windows = cache.get(key);
    if (!windows) {
      try {
        const reply = await invoke<IntroDbReply>("introdb", {
          action: { op: "fetch", imdb_id: imdb, season: n.season, episode: n.episode },
        });
        windows = reply.result === "segments" ? reply.windows : [];
      } catch (e) {
        console.warn(`[introdb] lookup failed for ${key}: ${String(e)}`);
        windows = [];
      }
      if (windows.length > 0) cache.set(key, windows);
    }
    if (windows.length > 0) {
      console.info(
        `[introdb] ${imdb} matched ${n.label} numbering s${n.season}e${n.episode}: `
        + windows.map((w) => `${w.kind} ${Math.round(w.start)}-${Math.round(w.end)}s ${w.source}`
          + ` (n=${w.submission_count})`).join(", "),
      );
      return { windows, matched: n };
    }
  }
  if (numberings.length > 0) {
    console.info(
      `[introdb] ${imdb}: no segments under `
      + numberings.map((n) => `${n.label} s${n.season}e${n.episode}`).join(", "),
    );
  }
  return { windows: [], matched: null };
}

/** Slack when checking a segment against the file, mirroring Rust's
 *  `DURATION_SLACK_SEC` in introdb.rs. */
const DURATION_SLACK_SEC = 2;

/** Drop IntroDB windows that do not fit THIS file, the same rule as Rust's
 *  `fit_to_duration`: must start inside the file, an end that overshoots by
 *  more than the slack is a different cut (dropped, never clamped onto the
 *  wrong edit), a smaller overshoot is clamped. Other sources pass through.
 *  Applied once the duration is known, which in the skip chain is after the
 *  fetch has already happened. */
export function fitIntroDbToDuration<T extends { source: string; start: number; end: number }>(
  windows: T[],
  duration: number,
): T[] {
  if (!(duration > 0)) return windows;
  const out: T[] = [];
  for (const w of windows) {
    if (!isIntroDbSource(w.source)) { out.push(w); continue; }
    if (w.start >= duration || w.end > duration + DURATION_SLACK_SEC) {
      console.info(
        `[introdb] dropped ${Math.round(w.start)}-${Math.round(w.end)}s: `
        + `does not fit this ${Math.round(duration)}s file`,
      );
      continue;
    }
    out.push(w.end > duration ? { ...w, end: duration } : w);
  }
  return out;
}

/** Whether a personal IntroDB key is stored. The key itself never leaves Rust
 *  on this path. */
export async function introDbHasKey(): Promise<boolean> {
  try {
    const reply = await invoke<IntroDbReply>("introdb", { action: { op: "status" } });
    return reply.result === "status" && reply.has_key;
  } catch {
    return false;
  }
}

/** Submit one user-entered segment. Only ever called from a user action. */
export async function submitToIntroDb(args: {
  imdb:     string;
  season:   number;
  episode:  number;
  kind:     string;
  start:    number;
  end:      number;
  tmdbId?:  number | null;
  tvdbId?:  number | null;
}): Promise<{ outcome: IntroDbSubmitOutcome; message: string }> {
  try {
    const reply = await invoke<IntroDbReply>("introdb", {
      action: {
        op: "submit",
        imdb_id: args.imdb,
        season:  args.season,
        episode: args.episode,
        kind:    args.kind,
        start:   args.start,
        end:     args.end,
        tmdb_id: args.tmdbId ?? null,
        tvdb_id: args.tvdbId ?? null,
      },
    });
    if (reply.result !== "submitted") return { outcome: "failed", message: "Unexpected reply" };
    if (reply.outcome === "ok") cache.delete(cacheKey(args.imdb, args));
    return { outcome: reply.outcome, message: reply.message };
  } catch (e) {
    return { outcome: "failed", message: String(e) };
  }
}
