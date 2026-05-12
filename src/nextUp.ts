// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// nextUp — finds the next playable episode of a series/anime and (optionally)
// fetches the highest-priority stream for it so the player can transition
// without bouncing through the DetailView.
//
// Triggers (App.tsx wires both):
//   • Anime with chapter-detected ED        → fire when current_time
//                                              >= ed_end + small grace (~1.5s)
//   • Anything else (or anime without ED)   → fire when duration - time
//                                              <= leadSeconds (default 60).
//
// Skips:
//   • The current episode is the LAST aired episode in the series  → no CTA.
//   • Next episode's release date is in the future                  → no CTA.
//
// Cross-season rollover (S01E12 → S02E01) is supported by walking the
// (season, episode)-sorted episode list past the current id. Specials
// (season 0) are NOT auto-advanced into or out of — main-run viewing
// shouldn't redirect the user into specials, and a user watching specials
// shouldn't get bumped onto the main run.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaDetail, StreamEntry, VideoEntry } from "./types";
import { getMetaDetailFallback } from "./metaCache";
import { getSortedEpisodes as sortedEpisodes } from "./episodeSort";

/** True when the episode's release date is in the past (or unknown).
 *  Mirrors autoAdvance.ts:isEpisodeAired. */
function isEpisodeAired(v: VideoEntry, now = Date.now()): boolean {
  if (!v.released) return true;
  const t = Date.parse(v.released);
  if (Number.isNaN(t)) return true;
  return t <= now;
}

/**
 * Walk the sorted episode list past `currentEpisodeId` and return the
 * first AIRED episode. Returns null when:
 *   • the current id isn't in the list (something's drifted; bail)
 *   • there are no more episodes after the current one
 *   • every subsequent episode has a future release date
 *
 * SPECIALS HANDLING — out-of-band: when the current episode is in
 * season 0, we look for the next aired SPECIAL only (don't bridge into
 * the main run). When the current episode is in seasons ≥ 1, we look
 * for the next aired MAIN-RUN episode only (skip past specials in the
 * sorted list). This matches the inference rule in LibraryContext:
 * specials and main run are independent watch tracks.
 */
/** Episode-kind filter governing whether filler / recap episodes are
 *  eligible candidates for "next up". Sourced from
 *  `AuraSettings.nextUpSkipFillerRecap`; passed in so this module
 *  stays settings-agnostic. */
export type SkipFillerRecapMode = "none" | "filler" | "recap" | "both";

/** Does the candidate's `episode_kind` pass the user's skip filter? */
function passesKindFilter(kind: string | null | undefined, mode: SkipFillerRecapMode): boolean {
  if (mode === "none") return true;
  if (!kind) return true;
  // Normalised AIOMetadata vocabulary: filler / recap / canon / normal / mixed.
  if (mode === "filler") return kind !== "filler";
  if (mode === "recap")  return kind !== "recap";
  return kind !== "filler" && kind !== "recap";
}

export function findNextEpisode(
  detail: MetaDetail,
  currentEpisodeId: string,
  now: number = Date.now(),
  skipMode: SkipFillerRecapMode = "none",
): VideoEntry | null {
  if (!detail || !Array.isArray(detail.videos) || detail.videos.length === 0) {
    return null;
  }
  const sorted = sortedEpisodes(detail);
  const idx = sorted.findIndex((v) => v.id === currentEpisodeId);
  if (idx < 0) return null;
  const currentSeason = sorted[idx].season ?? 0;
  const currentInSpecials = currentSeason === 0;
  for (let i = idx + 1; i < sorted.length; i += 1) {
    const candidate = sorted[i];
    const cs = candidate.season ?? 0;
    const candidateInSpecials = cs === 0;
    // Cross-track jump (specials ↔ main run) — skip.
    if (candidateInSpecials !== currentInSpecials) continue;
    if (!isEpisodeAired(candidate, now)) continue;
    // User-driven filler / recap skip. When the user has the toggle
    // off (skipMode === "none") the filter is a no-op; when on, we
    // walk forward until a non-skipped candidate appears, falling off
    // the end → null when everything remaining is filler/recap.
    if (!passesKindFilter(candidate.episode_kind, skipMode)) continue;
    return candidate;
  }
  return null;
}

/** Mirror of findNextEpisode walking BACKWARD. Used by the SMTC
 *  Previous media-key handler so OS-level Back lands on the
 *  previous episode in the same track (specials/main-run). Aired-
 *  only filtering doesn't apply going backward — every entry past
 *  the current one has already aired by definition. */
export function findPreviousEpisode(
  detail: MetaDetail,
  currentEpisodeId: string,
): VideoEntry | null {
  if (!detail || !Array.isArray(detail.videos) || detail.videos.length === 0) {
    return null;
  }
  const sorted = sortedEpisodes(detail);
  const idx = sorted.findIndex((v) => v.id === currentEpisodeId);
  if (idx <= 0) return null;
  const currentSeason = sorted[idx].season ?? 0;
  const currentInSpecials = currentSeason === 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    const candidate = sorted[i];
    const cs = candidate.season ?? 0;
    const candidateInSpecials = cs === 0;
    if (candidateInSpecials !== currentInSpecials) continue;
    return candidate;
  }
  return null;
}

/**
 * Pick the highest-priority stream for the supplied episode by
 * delegating to the existing `fetch_streams` command and returning
 * `streams[0]` (addons return ranked best-first).
 *
 * Returns null when no playable stream is available — callers should
 * surface a soft toast in that case ("No streams found for next
 * episode") rather than silently ignore.
 */
export async function pickFirstStreamForEpisode(
  addons: AddonEntry[],
  mediaType: string,
  episodeId: string,
): Promise<StreamEntry | null> {
  if (!addons || addons.length === 0) return null;
  if (!mediaType || !episodeId) return null;
  try {
    const result = await invoke<{ streams: StreamEntry[] }>("fetch_streams", {
      addons,
      mediaType,
      id: episodeId,
    });
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    return streams.find((s) => !!s.url || !!s.info_hash) ?? null;
  } catch (err) {
    console.warn("[next-up] fetch_streams failed:", err);
    return null;
  }
}

/** Convenience: fetch the meta detail (cached) AND resolve the next ep
 *  in one call. Used by App.tsx's Next-Up trigger so the wiring stays
 *  tight. Returns null if no next episode exists. */
export async function resolveNextEpisode(
  addons: AddonEntry[],
  mediaType: string,
  seriesId: string,
  currentEpisodeId: string,
  skipMode: SkipFillerRecapMode = "none",
): Promise<{ detail: MetaDetail; next: VideoEntry } | null> {
  const detail = await getMetaDetailFallback(addons, mediaType, seriesId);
  if (!detail) return null;
  const next = findNextEpisode(detail, currentEpisodeId, Date.now(), skipMode);
  if (!next) return null;
  return { detail, next };
}

/** Format an SxxEyy / Sxx tag for the Next-Up button label. Falls back
 *  to bare "Episode N" when season parsing isn't available. */
export function formatEpisodeTag(v: VideoEntry): string {
  const s = v.season != null ? Math.max(0, v.season) : null;
  const e = v.episode != null ? Math.max(0, v.episode) : null;
  if (s != null && e != null) {
    return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
  }
  if (e != null) return `Episode ${e}`;
  return "Next";
}
