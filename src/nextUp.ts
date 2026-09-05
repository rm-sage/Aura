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
import { streamQueryAddons } from "./auraSettings";
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

/** Filler / recap flags for an episode, read from its own AIOMetadata fields —
 *  the SAME signal `findNextEpisode`'s skip walk uses, so the tag shown on a
 *  next-up card always agrees with whether "skip to canon" would skip it. An
 *  episode can be flagged both (release-search-spec §6.3). */
export function episodeKindFlags(v: VideoEntry): { filler: boolean; recap: boolean } {
  return {
    filler: v.is_filler === true || v.episode_kind === "filler",
    recap:  v.is_recap  === true || v.episode_kind === "recap",
  };
}

/** Filler / recap flags with the Aura Cloud release signal merged in.
 *
 *  THE ONE PREDICATE every surface that shows or acts on a kind must use.
 *  `episodeKindFlags` reads the VideoEntry alone, which is only half the
 *  answer: the cloud signal's `episode_kinds` is the higher-priority source and
 *  is the ONLY source for a great many episodes (addons that ship no
 *  is_filler / episode_kind at all). The episode-row pill already merged both,
 *  while the right-click skip-run menu tested the VideoEntry alone, so an
 *  episode visibly badged FILLER could offer no skip-run options at all and,
 *  worse, silently TERMINATE a run scan that should have walked through it -
 *  the menu's own "continues until the next canon episode" promise, broken on
 *  an episode the same screen was calling filler.
 *
 *  `kinds` is the raw `cloudSignal?.episode_kinds ?? []` array; passing an
 *  empty one degrades exactly to `episodeKindFlags`. */
export function mergedKindFlags(
  v: VideoEntry,
  kinds: { id: string; kind: string }[],
): { filler: boolean; recap: boolean } {
  const base = episodeKindFlags(v);
  return {
    filler: base.filler || kinds.some((k) => k.id === v.id && k.kind === "filler"),
    recap:  base.recap  || kinds.some((k) => k.id === v.id && k.kind === "recap"),
  };
}

/** The user-facing noun for an episode's skip-worthy kind, or null when it is
 *  neither. Drives the next-up cards' "Play filler anyway" / "Play recap
 *  anyway" fallback button, which used to read a generic "Play it anyway" that
 *  never said WHAT it was about to play.
 *
 *  Filler wins when an episode carries BOTH flags, matching FillerRecapTags,
 *  which stacks the rose filler pill above the amber recap one. The button and
 *  the tag on the thumbnail beside it therefore always agree. */
export function episodeKindNoun(v: VideoEntry): "filler" | "recap" | null {
  const { filler, recap } = episodeKindFlags(v);
  if (filler) return "filler";
  if (recap) return "recap";
  return null;
}

/** True when an episode is filler or recap (skip-worthy for "skip to canon"). */
export function isFillerOrRecap(v: VideoEntry): boolean {
  const { filler, recap } = episodeKindFlags(v);
  return filler || recap;
}

export function findNextEpisode(
  detail: MetaDetail,
  currentEpisodeId: string,
  now: number = Date.now(),
  skipMode: SkipFillerRecapMode = "none",
  /** When true, the future-air gate is dropped so the FIRST episode after the
   *  current one in the same track is returned even if it hasn't aired yet. Used
   *  by the caught-up CW/Airing badge to pre-empt the next episode (e.g. next
   *  season's premiere) while still respecting the specials ↔ main-run split. */
  includeUnaired: boolean = false,
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
    if (!includeUnaired && !isEpisodeAired(candidate, now)) continue;
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
 * Pick the stream for the supplied episode: literally `streams[0]`.
 *
 * Addons return their list already ranked, and for AIOStreams users that
 * ranking is the sort criteria they configured themselves, so the top row IS
 * the answer. Aura must not second-guess it. This used to be
 * `streams.find(s => s.url || s.info_hash)`, a defensive skip that quietly
 * walked past entries the source switcher still displayed - so auto-advance
 * played the 3rd source while the user was looking at a list whose 1st source
 * was the one they wanted. `sanitize_stream` now guarantees every returned
 * entry is playable, so the skip has nothing left to defend against and the
 * displayed list and the picked entry cannot disagree.
 *
 * Scoped through `streamQueryAddons` so auto-advance queries exactly the
 * addons the switcher and the detail page do.
 *
 * Returns null when no playable stream is available - callers should
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
  const queryAddons = streamQueryAddons(addons);
  if (queryAddons.length === 0) return null;
  try {
    const result = await invoke<{ streams: StreamEntry[] }>("fetch_streams", {
      addons: queryAddons,
      mediaType,
      id: episodeId,
    });
    const streams = Array.isArray(result?.streams) ? result.streams : [];
    return streams[0] ?? null;
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

/**
 * Should the UNATTENDED countdown target the skip button rather than the play
 * button?
 *
 * This is the whole job of the filler / recap preference now. It used to be
 * fed into `resolveNextEpisode`, where it changed what "the next episode"
 * meant: the card said "Play next episode" and played a different one, the
 * user could not see what was being skipped or opt out for a single episode,
 * and because the skip happened inside the resolver, nothing downstream knew a
 * skip had occurred, so the jumped run was never marked. The card now always
 * shows the true next episode and offers both actions, and this decides only
 * which one a countdown with nobody watching should pick.
 *
 * Kind-specific on purpose: someone who set "filler" wants a recap played, not
 * silently jumped.
 */
export function autoSkipApplies(
  mode: SkipFillerRecapMode,
  nextEp: VideoEntry,
): boolean {
  if (mode === "none") return false;
  const { filler, recap } = episodeKindFlags(nextEp);
  if (mode === "both")   return filler || recap;
  if (mode === "filler") return filler;
  return recap;
}

/**
 * When `nextEp` is filler/recap, resolve the NEXT CANON episode (walking past
 * ALL upcoming filler AND recap via `findNextEpisode(..,"both")`) plus its
 * first stream, so a next-up card can offer a one-tap "skip to canon".
 *
 * Returns null when: `nextEp` isn't filler/recap, no canon episode lies ahead
 * (everything remaining is filler/recap, or `nextEp` is the last), or the
 * canon episode has no playable stream — in every such case the card falls
 * back to its normal single "play next" action, so the skip is only ever
 * offered when it's actually actionable.
 */
export async function resolveCanonSkipTarget(
  addons: AddonEntry[],
  detail: MetaDetail,
  mediaType: string,
  currentEpisodeId: string,
  nextEp: VideoEntry,
  now: number = Date.now(),
): Promise<{ episode: VideoEntry; stream: StreamEntry; skipped: VideoEntry[] } | null> {
  if (!isFillerOrRecap(nextEp)) return null;
  const canon = findNextEpisode(detail, currentEpisodeId, now, "both");
  if (!canon || canon.id === nextEp.id) return null;
  const stream = await pickFirstStreamForEpisode(addons, mediaType, canon.id);
  if (!stream) return null;
  return { episode: canon, stream, skipped: spanBetween(detail, currentEpisodeId, canon.id, now) };
}

/**
 * The episodes actually JUMPED between `fromId` and `toId`, in track order.
 *
 * The canon target alone is not enough to mark anything: the caller needs to
 * know which episodes it passed over. Walks the same next-episode chain the
 * skip itself follows, with skipping disabled, so the span is exactly what the
 * user would have watched had they not skipped, and specials never bridge into
 * the main run.
 *
 * Hard-bounded. A malformed episode list that loops would otherwise hang the
 * caller, and no legitimate filler run is anywhere near this long.
 */
export function spanBetween(
  detail: MetaDetail,
  fromId: string,
  toId: string,
  now: number = Date.now(),
): VideoEntry[] {
  const out: VideoEntry[] = [];
  let cursor = fromId;
  for (let i = 0; i < 200; i++) {
    const next = findNextEpisode(detail, cursor, now, "none");
    if (!next || next.id === toId) break;
    out.push(next);
    cursor = next.id;
  }
  return out;
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
