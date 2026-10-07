// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// skipWindows: the PURE half of AuraSkip's window pipeline.
//
// Everything here is a function of its arguments: what a chapter title means,
// how windows from several sources are ranked and collapsed, how the user's
// per-kind modes apply, and how a window is clamped to the media end. The
// async half (AniSkip / IntroDB / PublicMetaDB fetches, the chapter poll, the
// skip_detect job, the one stamp per load) stays in App.tsx.
//
// This module has NO runtime imports on purpose, so a node check can load it
// directly (`node scratch-check.ts`) without a bundler or the Tauri runtime.
//
// The layered detector (Rust `skipdetect/`) stamps three sources:
//   "animethemes"       Layer 1, an AnimeThemes theme located in the episode's
//                       audio. HIGH trust: it outranks every other source and,
//                       for its kind, removes any window that disagrees with
//                       it by more than LAYER1_CONFLICT_SECONDS at either edge.
//   "animethemes-over"  Layer 1 for an opening whose theme overlaps the scene
//                       ("Over" in AnimeThemes): same location trust, but
//                       prompt-only (never auto-eligible).
//   "continuity"        Layer 3, loudness continuity between silences. LOW
//                       trust: prompt-only and never a Next-Up trigger.
// "pairing" (Layer 2) is reserved in the priority table and not produced yet.
// ---------------------------------------------------------------------------

export const LAYER1_SOURCE = "animethemes";
export const LAYER1_PROMPT_SOURCE = "animethemes-over";
export const PAIRING_SOURCE = "pairing";
export const CONTINUITY_SOURCE = "continuity";
/** IntroDB's two trust tiers (decided in introdb.rs). Defined here so this
 *  module stays import-free; `introdb.ts` re-exports them. */
export const INTRODB_SOURCE = "introdb";
export const INTRODB_SINGLE_SOURCE = "introdb-single";

export type SkipMode = "off" | "prompt" | "auto";
export interface SkipModes { op: SkipMode; ed: SkipMode; recap: SkipMode }

export interface PreparedWindow {
  type:   string;
  start:  number;
  end:    number;
  source: string;
  auto:   boolean;
  /** The song playing in this window, stamped from the MAL theme list.
   *  Absent whenever the join was not certain: see stampThemeSongs (App.tsx).
   *  Mirrors Rust's PreparedWindow; PlayerOverlay and AniSkipMenu carry their
   *  own copies of this shape and must change with it. */
  song_title?:  string | null;
  song_artist?: string | null;
  /** "aniskip" windows only: `"{malId}:{episode}"`, the AniSkip entry the
   *  window was fetched for. Mirrors Rust's PreparedWindow::skip_ref. */
  skip_ref?: string | null;
  /** "aniskip" windows only: the AniSkip row id (votes). */
  skip_id?: string | null;
}

/** Window kinds collapse into groups: a mixed opening is an opening, a mixed
 *  ending (should AniSkip ever be asked for one) is an ending under the same
 *  Layer 1 cross-check. Recap and preview are their own groups. */
export function skipKindGroup(kind: string): string {
  if (kind === "mixed-op") return "op";
  if (kind === "mixed-ed") return "ed";
  return kind;
}

/** The ONE mode resolver, used by both writers of the payload (the skip chain's
 *  `modeFor` and the mid-play re-stamp's `modeForKind`) so they can never
 *  disagree about what a kind means.
 *
 *  `preview` (a next-episode preview) has no Settings row: it is HARD-CODED to
 *  prompt, never auto, and off whenever the ED mode is off. A preview is story
 *  the user may want; it only ever goes away on an explicit press. */
export function skipModeForKind(kind: string, m: SkipModes): SkipMode {
  switch (skipKindGroup(kind)) {
    case "op":      return m.op;
    case "ed":      return m.ed;
    case "recap":   return m.recap;
    case "preview": return m.ed === "off" ? "off" : "prompt";
    default:        return "off";
  }
}

// ---------------------------------------------------------------------------
// Chapter titles
// ---------------------------------------------------------------------------

/** What a chapter title says it is. Matched case-insensitively.
 *
 *  - Recap first: "Previously on..." intros sometimes precede an opening.
 *  - "Cold open" / "teaser" are DELIBERATELY not openings: usually story.
 *  - "Epilogue" is NOT an ending: it is story (after-credits scenes are often
 *    titled exactly that), and treating it as an ED is how an after-credits
 *    scene got skipped.
 *  - Preview / next episode / next time / coming up are their own `preview`
 *    kind, never merged into the ED. A combined title ("ED + Preview") is a
 *    preview too: a preview always plays unless the user explicitly skips it,
 *    so a chapter carrying one must never ride an ED auto-skip. */
export function classifyChapterTitle(title: string): "op" | "ed" | "recap" | "preview" | null {
  const t = title.toLowerCase().trim();
  if (!t) return null;
  if (/\b(recap|previously|previously on|last time|story so far|summary)\b/.test(t)) return "recap";
  if (
    /^op(\b|\d| |$)/.test(t) ||
    /\b(opening|intro|introduction|theme song|main theme|title sequence)\b/.test(t)
  ) return "op";
  if (/\b(preview|next episode|next time|coming up)\b/.test(t)) return "preview";
  if (
    /^ed(\b|\d| |$)/.test(t) ||
    /\b(ending|outro|closing|end credits|credits|end theme|closing theme)\b/.test(t)
  ) return "ed";
  return null;
}

// Kai-derived chapter heuristics (live-action + anime where nothing else has
// data). Industry-standard OP length is ~90 s; an UNTITLED chapter inside the
// leading INTRO_FRACTION whose length is closest to that (within OP_MIN..OP_MAX)
// is treated as the opening, prompt-only.
export const INTRO_FRACTION       = 0.20;
export const OUTRO_FRACTION       = 0.20;
export const TARGET_OP_SECONDS    = 90;
export const OP_MIN_SECONDS       = 30;
export const OP_MAX_SECONDS       = 130;
// Sanity caps so a mis-titled / coarse chapter can't nuke real content. A real
// opening is ~90 s; a titled "Opening" chapter much longer than that is a coarse
// marker that runs until the NEXT marker (The Punisher S01E13 shipped one
// spanning 4:53-9:37). ED can legitimately run long (a full credits roll).
export const TITLED_OP_MAX_SECONDS = 150;
export const ED_MAX_SECONDS        = 900;
export const MIN_WINDOW_SECONDS    = 2;
// Plausible length band for an OP window, used ONLY to rank competing OP
// candidates against each other in dedupeSkipWindows (never to drop one).
// Below the floor is a title card (Hell's Paradise S02's 15 s "Intro" chapter);
// above the ceiling is a coarse marker that swallowed the cold open.
export const OP_PLAUSIBLE_MIN_SECONDS = 20;
export const OP_PLAUSIBLE_MAX_SECONDS = TITLED_OP_MAX_SECONDS;

/** When a Layer 1 window exists for a kind, every other window of that kind
 *  whose start OR end differs from it by more than this is DROPPED. Measured:
 *  AniSkip ED rows were 32-38 s early on TYBW 3:9, 3:10 and 3:11 even with a
 *  matching episodeLength, and an "ED" chapter was 10 s late. */
export const LAYER1_CONFLICT_SECONDS = 3;

/** Fraction of [aStart,aEnd) that overlaps [bStart,bEnd). */
export function windowOverlapFraction(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  return inter / Math.max(0.001, aEnd - aStart);
}

export const isLayer1Source = (source: string): boolean =>
  source === LAYER1_SOURCE || source === LAYER1_PROMPT_SOURCE;

/** Source trust. A release group's EXPLICIT titled chapter beats AniSkip (Dr.
 *  STONE S04E18: the chapter OP was right, AniSkip's was off); Layer 1 beats
 *  both, because it locates the actual theme audio in THIS file. IntroDB is
 *  split by trust in introdb.rs: "introdb" ranks with AniSkip, "introdb-single"
 *  sits between PublicMetaDB and the neighbour borrow. Aura's own low-trust
 *  guesses rank last. */
export const SKIP_SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  [LAYER1_SOURCE]: 8, [LAYER1_PROMPT_SOURCE]: 8,
  chapter: 7,
  aniskip: 6, [INTRODB_SOURCE]: 6,
  [PAIRING_SOURCE]: 5, publicmetadb: 5,
  [INTRODB_SINGLE_SOURCE]: 4,
  "aniskip-neighbour": 3,
  "chapter-heuristic": 2,
  [CONTINUITY_SOURCE]: 1,
};

/** Collapse overlapping skip windows of the SAME kind across sources so a
 *  region never gets two segments. The higher-trust source wins the region;
 *  the loser is dropped WHOLE, never merged into a union (a coarse chapter must
 *  not extend a precise window).
 *
 *  Two passes:
 *   1. Layer 1 conflict drop. For a group that has a Layer 1 window, every
 *      other window of that group whose start or end is more than
 *      LAYER1_CONFLICT_SECONDS away from it is removed. Overlap alone is not
 *      the test: a crowd ED 32 s early still overlaps the real one by 60%.
 *   2. The single OP slot is elected on Layer 1 first, plausible length
 *      second and source trust third (see `opLengthScore`); ED / recap /
 *      preview keep only same-region overlap dedup (a real ED plus a separate
 *      preview are both legitimately skippable). */
export function dedupeSkipWindows(windows: PreparedWindow[]): PreparedWindow[] {
  const group = skipKindGroup;
  const layer1 = new Map<string, PreparedWindow>();
  for (const w of windows) {
    if (isLayer1Source(w.source) && !layer1.has(group(w.type))) layer1.set(group(w.type), w);
  }
  const agreed = windows.filter((w) => {
    const l1 = layer1.get(group(w.type));
    if (!l1) return true;
    if (isLayer1Source(w.source)) return w === l1;
    return Math.abs(w.start - l1.start) <= LAYER1_CONFLICT_SECONDS
        && Math.abs(w.end - l1.end) <= LAYER1_CONFLICT_SECONDS;
  });

  const prio = (src: string) => SKIP_SOURCE_PRIORITY[src] ?? 0;
  // Last tie-break between equal-priority sources (AniSkip vs trusted IntroDB):
  // AniSkip describes a MAL-keyed episode and has per-row votes.
  const tieBreak = (src: string) => (src === "aniskip" ? 1 : 0);
  const l1Rank = (w: PreparedWindow) => (isLayer1Source(w.source) ? 1 : 0);
  // An OP whose LENGTH is plausible outranks one whose length is not, ABOVE
  // source priority (a 15 s or a 158 s "opening" is self-evidently not one).
  // A ranking key, never a filter. 0 for every non-OP window.
  const opPlausible = (w: PreparedWindow): number => {
    if (group(w.type) !== "op") return 0;
    const len = w.end - w.start;
    return len >= OP_PLAUSIBLE_MIN_SECONDS && len <= OP_PLAUSIBLE_MAX_SECONDS ? 1 : 0;
  };
  // Closeness to the industry-standard length, bucketed to 20 s. Below source
  // priority, so it only separates candidates the trust order cannot (two
  // chapters of one release: a 25 s title card and a 90 s opening).
  const opCloseness = (w: PreparedWindow): number => {
    if (group(w.type) !== "op") return 0;
    return -Math.round(Math.abs((w.end - w.start) - TARGET_OP_SECONDS) / 20);
  };
  const ordered = [...agreed].sort(
    (a, b) => l1Rank(b) - l1Rank(a)
           || opPlausible(b) - opPlausible(a)
           || prio(b.source) - prio(a.source)
           || opCloseness(b) - opCloseness(a)
           || tieBreak(b.source) - tieBreak(a.source)
           || a.start - b.start,
  );
  const kept: PreparedWindow[] = [];
  let opTaken = false;
  for (const w of ordered) {
    const g = group(w.type);
    // An episode has exactly ONE opening: when two sources disagree on WHERE
    // it is (NON-overlapping, so the overlap test cannot catch them), keep
    // only the best-ranked.
    if (g === "op") {
      if (opTaken) continue;
      opTaken = true;
      kept.push(w);
      continue;
    }
    const wLen = Math.max(0.001, w.end - w.start);
    const clashes = kept.some((k) => {
      if (group(k.type) !== g) return false;
      const inter = Math.max(0, Math.min(k.end, w.end) - Math.max(k.start, w.start));
      const kLen = Math.max(0.001, k.end - k.start);
      // Overlap past ~a quarter of the SHORTER window = the same region.
      return inter / Math.min(wLen, kLen) > 0.25;
    });
    if (!clashes) kept.push(w);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** `dedupeSkipWindows` plus the AniSkip rows a Layer 1 window replaced. */
export interface SkipDedupe {
  kept: PreparedWindow[];
  /** AniSkip rows of a kind that has a Layer 1 window, which did not survive
   *  the dedupe (dropped by the conflict pass, or beaten to the kind's slot).
   *  DISPLAY-ONLY: they ride the `set_skip_windows` payload's `superseded`
   *  list, which neither the Lua script nor the SkipController reads, so the
   *  AuraSkip menu can still offer their vote arrows (a wrong row is the one
   *  that most needs a downvote). `auto` is always false. */
  superseded: PreparedWindow[];
}

export function dedupeSkipWindowsDetailed(windows: PreparedWindow[]): SkipDedupe {
  const kept = dedupeSkipWindows(windows);
  const layer1Groups = new Set(
    windows.filter((w) => isLayer1Source(w.source)).map((w) => skipKindGroup(w.type)),
  );
  const superseded = windows
    .filter((w) => w.source === "aniskip" && layer1Groups.has(skipKindGroup(w.type)) && !kept.includes(w))
    .map((w) => (w.auto ? { ...w, auto: false } : w));
  return { kept, superseded };
}

/** Sources whose windows are INFERRED rather than authored. Never auto: "auto"
 *  means "trust a real OP/ED marker", not "trust anything Aura guessed". */
export const GUESS_SKIP_SOURCES: ReadonlySet<string> = new Set([
  "chapter-heuristic", "aniskip-neighbour", CONTINUITY_SOURCE,
]);

/** Real data for THIS episode that is too thinly backed to seek on its own:
 *  an IntroDB segment with a single submission (or under 0.9 confidence), and
 *  a Layer 1 opening whose theme overlaps the scene. */
export const LOW_TRUST_SKIP_SOURCES: ReadonlySet<string> = new Set([
  INTRODB_SINGLE_SOURCE, LAYER1_PROMPT_SOURCE,
]);

/** Whether a window may only ever prompt, whatever the user's mode says.
 *  Beyond the guess / low-trust sources: every preview, and AniSkip ENDING rows
 *  (TYBW 3:9-3:11 rows were 32-38 s early with a matching episodeLength, so an
 *  AniSkip ED auto-seek would cut into the episode; when Layer 1 found the
 *  ending it has already replaced the row). IntroDB keeps its own tiers. */
export function isPromptOnly(w: PreparedWindow): boolean {
  if (GUESS_SKIP_SOURCES.has(w.source) || LOW_TRUST_SKIP_SOURCES.has(w.source)) return true;
  const g = skipKindGroup(w.type);
  if (g === "preview") return true;
  if (g === "ed" && w.source === "aniskip") return true;
  return false;
}

/** Re-apply the user's CURRENT per-kind modes to a window list on its way out
 *  to `set_skip_windows`: drop kinds now switched off, recompute `auto`.
 *  Unknown kinds resolve to "off" and are dropped. */
export function applySkipModes(
  windows: PreparedWindow[],
  modeFor: (kind: string) => SkipMode,
): PreparedWindow[] {
  return windows
    .filter((w) => modeFor(w.type) !== "off")
    .map((w) => {
      const auto = isPromptOnly(w) ? false : modeFor(w.type) === "auto";
      return auto === w.auto ? w : { ...w, auto };
    });
}

/** Clamp every window to the MEDIA end (the last decoded audio, from the
 *  detector), dropping what collapses. The container duration is never the
 *  end of an inferred ending: it can run ~29 s past the media (Spy x Family
 *  E2, Demon Slayer S1E2, TYBW 3:14). No-op without a media end. */
export function clampWindowsToMediaEnd(
  windows: PreparedWindow[],
  mediaEnd: number | null | undefined,
): PreparedWindow[] {
  if (mediaEnd == null || !Number.isFinite(mediaEnd) || mediaEnd <= 0) return windows;
  return windows
    .map((w) => (w.end > mediaEnd ? { ...w, end: mediaEnd } : w))
    .filter((w) => w.end - w.start >= MIN_WINDOW_SECONDS);
}
