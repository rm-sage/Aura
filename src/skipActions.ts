// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// skipActions — the ONE place that knows what marking an episode "skipped"
// means. Every trigger routes through here so the rules cannot drift between
// the right-click menu, the Next-Up card and the end-of-stream spotlight.
//
// THE RULES, and why each is what it is:
//
//   1. A skip sets the normal `watched` mark AND the skip annotation. The
//      annotation alone would leave the episode looking unwatched to the ~40
//      places that test `=== "watched"`; the watched mark alone loses the
//      label. See skipMarks.ts for why these are two stores and not one union.
//
//   2. Scrobbling is gated on the skip being USER-INITIATED. Any skip the user
//      performed themselves pushes, whether from the right-click menu or the
//      Skip-to-canon button, because a skip states the episode is finished
//      with and the services have no way to record that other than as watched.
//      An unattended countdown firing the same button with nobody watching
//      does NOT: waking to a dozen Trakt plays you cannot easily undo is worse
//      than a missing scrobble. (Manual mark-as-WATCHED still never scrobbles;
//      that path does not come through here.)
//
//   3. `auto_scrobble_enabled` still gates the push, so a user who turned
//      scrobbling off never gets one from this path either.
//
//   4. History rows are written for every skip regardless of scrobbling, so a
//      skip is always re-scrobblable by hand from the History tab later.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

import { isAnimeMeta } from "./aiometadata";
import { getManualWatchedState, setManualWatchedMany } from "./manualWatched";
import { isSkipped, setSkipped } from "./skipMarks";
import { addHistoryEntries, type HistoryEntry } from "./historyStore";
import { markScrobbled } from "./scrobbledStore";

/** One episode being marked skipped, with everything History and the scrobble
 *  services need. Callers assemble these from a VideoEntry plus the series. */
export interface SkipTarget {
  id: string;
  parentId: string | null;
  name: string;
  mediaType: string;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  poster: string | null;
  background: string | null;
  anilistId: number | null;
  anilistEpisode: number | null;
}

export interface SkipOptions {
  /** True when a human clicked something to cause this. Drives scrobbling and
   *  nothing else: an unattended auto-advance still marks and still writes
   *  history, it just does not push. */
  userInitiated: boolean;
  /** The user's auto-scrobble preference. Passed in rather than read here so
   *  this module stays free of settings plumbing and stays testable. */
  autoScrobbleEnabled: boolean;
  /** Active scrobble scope, or null when not signed in to anything. */
  scrobbleScope: string | null;
  /** Services with a live connection. Empty means nothing to push to. */
  services?: ("trakt" | "anilist")[];
}

/**
 * Mark episodes skipped: watched mark, skip annotation, history rows, and a
 * scrobble when the rules above allow one.
 *
 * Batched deliberately. A skip-to-canon across a filler run can be a dozen
 * episodes, and `setManualWatchedMany` / `setSkipped` each persist once for the
 * whole set rather than once per id.
 */
/** The subset of `ids` that is not already annotated, i.e. what a mark would
 *  actually act on. Exported so a caller can size its confirmation toast off
 *  the same set the write uses instead of off everything it offered. */
export function unskippedOf(ids: string[]): string[] {
  return ids.filter(isSkipMarkable);
}

/** Whether marking `id` skipped would actually write anything.
 *
 *  TWO conditions, and the second is an OWNERSHIP rule that keeps the
 *  mark/unmark round trip lossless.
 *
 *  A skip lays its annotation over a watched mark it also creates, and
 *  `clearEpisodesSkipped` removes both on the strength of that. But
 *  `setManualWatchedMany(ids, "watched")` is a silent no-op for an episode the
 *  user had ALREADY marked watched by hand, so annotating one of those made the
 *  annotation a lie about ownership: unmarking then deleted a watched mark the
 *  skip never created. Marking a half-watched 40-episode arc skipped and
 *  changing your mind unwatched everything you had genuinely watched in it,
 *  with no undo and no cloud copy to restore from (per-episode marks are
 *  local-only - Stremio stores one resume pointer per series, not per-episode
 *  flags). That is the same harm the `annotated` filter in
 *  `clearEpisodesSkipped` was added to stop; this closes the other half of it.
 *
 *  Note this tests the MANUAL mark specifically. An episode watched by actually
 *  playing it carries no manual mark, so the skip does create one and owns it,
 *  and the round trip stays lossless there too. */
export function isSkipMarkable(id: string): boolean {
  return !isSkipped(id) && getManualWatchedState(id) !== "watched";
}

export async function markEpisodesSkipped(
  targets: SkipTarget[],
  opts: SkipOptions,
): Promise<void> {
  if (targets.length === 0) return;

  // ALREADY-SKIPPED EPISODES ARE A NO-OP, and this filter is what makes the
  // batch idempotent. Every bulk caller offers the action the moment ONE
  // episode in the run or arc is unskipped, so re-running it over a mostly
  // already-skipped set used to re-stamp all of them with a fresh `playedAt`.
  // That is three separate harms: a duplicate History row per episode (the
  // dedupe key is (id, played_at), so a new timestamp is a new row), those
  // duplicates evicting genuine plays off the 1000-entry tail, and a genuinely
  // duplicate Trakt play, because Trakt dedupes on `watched_at` and a new one
  // is a new play the user has to delete by hand.
  // ONE predicate, shared with `unskippedOf`, so a caller's toast count can
  // never disagree with what was actually written.
  const fresh = targets.filter((t) => isSkipMarkable(t.id));
  if (fresh.length === 0) return;
  targets = fresh;

  const ids = targets.map((t) => t.id);
  // Watched first. If persistence fails, the episode is still marked watched,
  // which is the safer half to keep: a skipped episode that lost its label
  // looks watched, whereas a label with no watched mark would resurface in
  // Continue Watching.
  setManualWatchedMany(ids, "watched");
  setSkipped(ids, true);

  // Stamped ONCE for the whole batch. Trakt dedupes on watched_at, so reusing
  // one timestamp makes re-marking the same run idempotent there instead of
  // creating a fresh play per attempt.
  const playedAt = new Date().toISOString();
  const entries: HistoryEntry[] = targets.map((t) => {
    const entry: HistoryEntry = {
      id: t.id,
      parent_id: t.parentId ?? undefined,
      name: t.name,
      media_type: t.mediaType,
      poster: t.poster,
      background: t.background,
      season: t.season,
      episode: t.episode,
      episode_title: t.episodeTitle,
      played_at: playedAt,
      // No watched_seconds on purpose. Nothing was played, and the stats
      // surfaces sum that field: a fabricated duration would inflate lifetime
      // watch time with hours nobody spent.
      skipped: true,
      anilist_id: t.anilistId,
      anilist_episode: t.anilistEpisode,
    };
    return entry;
  });
  // One write for the whole batch. Per-entry, this serialised the entire
  // history store and dispatched a change event once per episode.
  addHistoryEntries(entries);

  const services = opts.services ?? [];
  if (!opts.userInitiated || !opts.autoScrobbleEnabled
      || !opts.scrobbleScope || services.length === 0) {
    return;
  }

  const push = async (t: SkipTarget, service: "trakt" | "anilist") => {
    const command = service === "trakt"
      ? "scrobble_history_trakt"
      : "scrobble_history_anilist";
    try {
      await invoke<string>(command, {
        id: t.id,
        parentId: t.parentId,
        mediaType: t.mediaType,
        season: t.season,
        episode: t.episode,
        name: t.name,
        scope: opts.scrobbleScope,
        playedAt,
        anilistId: t.anilistId,
        anilistEpisode: t.anilistEpisode,
      });
      return true;
    } catch (e) {
      console.warn(`[skip] ${service} scrobble failed for ${t.id}: ${String(e)}`);
      return false;
    }
  };

  // TRAKT records one PLAY per episode, so it needs a request each. Sequential
  // on purpose: these are the same per-row commands the History tab uses, and
  // firing a dozen episodes concurrently would hammer the API for no gain. A
  // failure on one row must not abort the rest.
  if (services.includes("trakt")) {
    for (const t of targets) {
      // Recorded so the History row reads as pushed and a later bulk run does
      // not send it a second time.
      if (await push(t, "trakt")) markScrobbled(opts.scrobbleScope!, "trakt", t.id, playedAt);
    }
  }

  // ANILIST is different in kind, and treating it the same was a real cost. It
  // records a single MONOTONIC progress number per media, and its save returns
  // "already ahead" for anything at or below the current value, so sending
  // every episode fires N mutations plus N resolver runs to reach the state
  // that ONE call for the highest episode already reaches. Across a 60-episode
  // arc that is 60 requests against a per-minute budget instead of one.
  if (services.includes("anilist")) {
    // ANILIST IS ANIME-ONLY, and this gate was missing.
    //
    // `connectedServices` answers "is there a token", nothing more, so a skip
    // on a LIVE-ACTION series (the Netflix One Piece, Cowboy Bebop 2021, Yu Yu
    // Hakusho 2023) pushed to AniList too. `scrobble_history_anilist` hardcodes
    // is_anime=true on the strength of its doc comment "the frontend only
    // offers this for anime rows", which was true of the History tab and never
    // of this path, so with no explicit anilistId the Rust side fell through to
    // its heuristic title search and wrote progress onto whatever ANIME entry
    // the title happened to match. The user's AniList list gained episodes of a
    // show they were not watching.
    //
    // Same predicate the History tab uses (`servicesFor`), not a new one. An
    // explicit anilistId is direct addon evidence and outranks the heuristic,
    // exactly as `save_progress` documents, so those pass regardless.
    const animeTargets = targets.filter((t) =>
      t.anilistId != null
      || isAnimeMeta({ media_type: t.mediaType, id: t.parentId ?? t.id, genres: [] }));
    if (animeTargets.length === 0) return;
    // ONE CALL PER MEDIA, and only where "same media" is PROVABLE.
    //
    // Collapsing is worth doing: AniList keeps a single monotonic progress
    // number per entry, so for a 60-episode arc the 59 lower calls each resolve,
    // find progress already ahead and do nothing, while still costing a GraphQL
    // round trip against a ~90/min budget.
    //
    // But it is only safe when two targets are known to be the SAME entry, and
    // the only proof of that is an explicit anilistId. Bucketing by season is
    // NOT proof: a split-cour show files each cour as its own AniList entry
    // inside one Cinemeta season, and the Rust resolver picks between them using
    // the episode number. Collapsing those would push progress for the later
    // cour, silently leave the earlier one at zero, and then mark every id
    // scrobbled, which suppresses the manual re-send that would have fixed it.
    // So a target with no anilistId is sent on its own, exactly as before.
    const rank = (t: SkipTarget) => t.anilistEpisode ?? t.episode ?? 0;
    const buckets = new Map<number, SkipTarget[]>();
    const solo: SkipTarget[] = [];
    for (const t of animeTargets) {
      if (t.anilistId == null) { solo.push(t); continue; }
      const bucket = buckets.get(t.anilistId);
      if (bucket) bucket.push(t); else buckets.set(t.anilistId, [t]);
    }
    for (const bucket of buckets.values()) {
      const top = bucket.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      if (!(await push(top, "anilist"))) continue;
      // Every id in the bucket is recorded, not just the one sent: they ARE all
      // covered by that one progress number, and marking only the top would
      // leave the rest looking unpushed and invite a manual re-send from
      // History that would do nothing.
      for (const t of bucket) {
        markScrobbled(opts.scrobbleScope!, "anilist", t.id, playedAt);
      }
    }
    for (const t of solo) {
      if (await push(t, "anilist")) {
        markScrobbled(opts.scrobbleScope!, "anilist", t.id, playedAt);
      }
    }
  }
}

/** Clear the skip annotation, and the watched mark that goes with it.
 *
 *  ONLY for ids that actually carry the annotation. The bulk callers pass a
 *  whole filler run or a whole arc and are armed as soon as ONE episode in it
 *  is skipped, so an unfiltered clear wiped the watched marks off everything
 *  else in the set: one skipped recap inside a finished 22-episode arc was
 *  enough to unwatch the entire arc, silently and with no undo. */
export function clearEpisodesSkipped(ids: string[]): void {
  const annotated = ids.filter(isSkipped);
  if (annotated.length === 0) return;
  setSkipped(annotated, false);
  setManualWatchedMany(annotated, null);
}
