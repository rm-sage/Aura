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
//   2. Scrobbling is gated on the skip being USER-INITIATED, not on it being
//      "automatic". Aura has never scrobbled a manual mark, so a right-click
//      skip does not either. A skip the user CLICKED (Skip to canon) does,
//      because it is part of a playback flow. An unattended countdown that
//      fires the same button with nobody watching does NOT: waking to a dozen
//      Trakt plays you cannot easily undo is worse than a missing scrobble.
//
//   3. `auto_scrobble_enabled` still gates the push, so a user who turned
//      scrobbling off never gets one from this path either.
//
//   4. History rows are written for every skip regardless of scrobbling, so a
//      skip is always re-scrobblable by hand from the History tab later.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

import { setManualWatchedMany } from "./manualWatched";
import { setSkipped } from "./skipMarks";
import { addHistoryEntry, type HistoryEntry } from "./historyStore";
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
export async function markEpisodesSkipped(
  targets: SkipTarget[],
  opts: SkipOptions,
): Promise<void> {
  if (targets.length === 0) return;

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
  for (const t of targets) {
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
    addHistoryEntry(entry);
  }

  const services = opts.services ?? [];
  if (!opts.userInitiated || !opts.autoScrobbleEnabled
      || !opts.scrobbleScope || services.length === 0) {
    return;
  }

  // Sequential on purpose: these are the same per-row commands the History tab
  // uses, and firing a dozen episodes x two services concurrently would hammer
  // both APIs for no gain. A failure on one row must not abort the rest.
  for (const t of targets) {
    for (const service of services) {
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
        // Recorded so the History row shows as already pushed and a later bulk
        // run does not send it a second time.
        markScrobbled(opts.scrobbleScope, service, t.id, playedAt);
      } catch (e) {
        console.warn(`[skip] ${service} scrobble failed for ${t.id}: ${String(e)}`);
      }
    }
  }
}

/** Clear the skip annotation and the watched mark together. Used by the
 *  right-click toggle, so un-skipping returns the episode to unwatched rather
 *  than leaving it silently watched. */
export function clearEpisodesSkipped(ids: string[]): void {
  setSkipped(ids, false);
  setManualWatchedMany(ids, null);
}
