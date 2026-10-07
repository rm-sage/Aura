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
// The layered detector (Rust `skipdetect/`) stamps four sources:
//   "animethemes"       Layer 1, an AnimeThemes theme located in the episode's
//                       audio. HIGH trust: it outranks every other source and,
//                       for its kind, removes any window that disagrees with
//                       it by more than LAYER1_CONFLICT_SECONDS at either edge.
//   "animethemes-over"  Layer 1 for a theme that overlaps the scene ("Over" in
//                       AnimeThemes: an opening, or an ending whose audio
//                       also has a clean video): same location trust, but
//                       prompt-only (never auto-eligible).
//   "animethemes-transition"
//                       Layer 1 for a Transition-only ENDING: the song starts
//                       over episode content, so its matched START is not the
//                       ending's (Cowboy Bebop 13: 280 s of story under
//                       "Space Lion"). Its END is trusted: the conflict drop
//                       keeps another ending only when its end agrees AND it
//                       starts no earlier than the song (a real ending cannot
//                       start before its song does), and such an ending then
//                       outranks it. Prompt-only, unless a chapter or crowd
//                       ending STARTS within LAYER1_CONFLICT_SECONDS of it,
//                       which promotes it to plain "animethemes". Its end
//                       counts as the trusted ending end for Next-Up.
//   "animethemes-early" the PROVISIONAL opening: the first 12 s of the theme
//                       matched while the rest is still decoding. Prompt-only,
//                       NOT Layer 1 (it never drops another source's window,
//                       so withdrawing it loses nothing), and replaced by the
//                       full match or withdrawn within about a minute.
//   "continuity"        Layer 3, loudness continuity between silences. LOW
//                       trust: prompt-only and never a Next-Up trigger.
// "pairing" (Layer 2) is reserved in the priority table and not produced yet.
// ---------------------------------------------------------------------------

export const LAYER1_SOURCE = "animethemes";
export const LAYER1_PROMPT_SOURCE = "animethemes-over";
export const LAYER1_TRANSITION_SOURCE = "animethemes-transition";
/** The provisional opening (Rust EARLY_SOURCE). Deliberately not in
 *  `isLayer1Source`: it must not trigger the conflict drop. */
export const LAYER1_EARLY_SOURCE = "animethemes-early";
export const PAIRING_SOURCE = "pairing";
export const CONTINUITY_SOURCE = "continuity";
/** IntroDB's two trust tiers (decided in introdb.rs). Defined here so this
 *  module stays import-free; `introdb.ts` re-exports them. */
export const INTRODB_SOURCE = "introdb";
export const INTRODB_SINGLE_SOURCE = "introdb-single";
export const PUBLICMETADB_SOURCE = "publicmetadb";

/** Crowd-sourced timings: recorded by people against SOME release of the
 *  episode, never measured in this file. */
export const CROWD_SKIP_SOURCES: ReadonlySet<string> = new Set([
  "aniskip", INTRODB_SOURCE, INTRODB_SINGLE_SOURCE, PUBLICMETADB_SOURCE,
]);

/** Why a window may only PROMPT although its source and kind would allow
 *  auto. Carried on the window (and through the Rust payload as `hold`), so
 *  the mid-play re-stamp, which recomputes `auto` from the payload, can never
 *  re-arm it.
 *   - "l1-pending": a crowd opening or ending while the theme match is still
 *     deciding the kind (a crowd opening at 0-90 s auto-skipped 89 s of JJK
 *     S2E10's cold open before the match placed the real one at 183 s).
 *   - "l1-abstain": the cour HAS themes of the kind and none is in this file.
 *   - "other-cut": an AniSkip row recorded against a different episode length.
 *   - "weak-title": a chapter titled only "Intro" / "Outro" (releases use them
 *     for cold opens, previews and story).
 *   - "uncorroborated": a lone crowd opening on a title with no theme match
 *     (live action), or a lone crowd recap: nothing in the file checks it. */
export type SkipHold = "l1-pending" | "l1-abstain" | "other-cut" | "weak-title" | "uncorroborated";
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
  /** Set when the window may only prompt for a reason its source alone does
   *  not carry (see SkipHold). Mirrors Rust's PreparedWindow::hold. */
  hold?: SkipHold | null;
  /** "aniskip" windows only: the episode length (s) the submitter recorded,
   *  0 or absent when unknown. Read once by `fitCrowdToDuration`. */
  episode_length?: number | null;
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
  const t = foldTitle(title);
  if (!t) return null;
  if (/\b(recap|previously|previously on|last time|story so far|summary)\b/.test(t)) return "recap";
  if (STRONG_OP_TITLE.test(t) || WEAK_OP_TITLE.test(t)) return "op";
  if (PREVIEW_TITLE.test(t)) return "preview";
  if (STRONG_ED_TITLE.test(t) || WEAK_ED_TITLE.test(t)) return "ed";
  return null;
}

/** Lower-cased, trimmed, accents folded ("Avant-premiere" == "Avant-première",
 *  "Proximo episodio" == "Próximo episodio"). Never NFKC: titles are only
 *  matched here, never turned into paths. */
function foldTitle(title: string): string {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const STRONG_OP_TITLE = /^op(\b|\d| |$)|\b(opening|theme song|main theme|title sequence)\b/;
const STRONG_ED_TITLE = /^ed(\b|\d| |$)|\b(ending|closing|end credits|credits|end theme|closing theme)\b/;
// "Intro" / "Outro" alone: releases use them for cold opens (Made in Abyss
// 1:13, Demon Slayer 1:2, Bocchi 8), previews and story (Re:Zero S4E5's
// "Intro" 0-136 and "Outro" 1182-1420 are both story). 9 of the 11 such
// chapters across both corpora were wrong.
const WEAK_OP_TITLE = /\b(intro|introduction)\b/;
const WEAK_ED_TITLE = /\boutro\b/;
// English plus the common localized words (One Piece 8's "Adelanto"). Only a
// chapter in the outro region counts as a preview (mergeChapterSkipWindows).
const PREVIEW_TITLE = new RegExp(
  "\\b(preview|next episode|next time|coming up|adelanto|avance|avant-premiere|prochain episode"
  + "|vorschau|anteprima|proximo episodio|yokoku)\\b",
);
// Story chapters that must never feed the untitled-OP heuristic: a "Prologue"
// chapter became TYBW 1:1's 80 s chapter-heuristic opening on an episode with
// no opening at all.
const STORY_TITLE = /\b(prologue|prolog|avant|avant-title|avant title|cold open|cold-open|teaser|pre-title|epilogue)\b/;

/** A chapter that classifies as an opening or ending ONLY through "Intro" /
 *  "Outro". Such a chapter is dropped when the same file has a strongly titled
 *  chapter of that kind, and otherwise prompts unless a crowd row agrees. */
export function isWeakChapterTitle(title: string): boolean {
  const t = foldTitle(title);
  const kind = classifyChapterTitle(title);
  if (kind === "op") return !STRONG_OP_TITLE.test(t);
  if (kind === "ed") return !STRONG_ED_TITLE.test(t);
  return false;
}

/** A chapter title that names STORY (prologue, cold open, teaser...). */
export function isStoryChapterTitle(title: string): boolean {
  return STORY_TITLE.test(foldTitle(title));
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

/** Layer 1's minimum accepted run (Rust `matcher::ACCEPT_LEN_S`, 30 s): a theme overlapping
 *  the searched audio by less could never have matched there. */
export const LAYER1_MIN_RUN_SECONDS = 30;
/** The audio the detector searches by default: HEAD is 0-600 s, TAIL the
 *  last 480 s of media (Rust probe::HEAD_SECS / TAIL_SECS). */
export const HEAD_SEARCH_SECONDS = 600;
export const TAIL_SEARCH_SECONDS = 480;

/** Fraction of [aStart,aEnd) that overlaps [bStart,bEnd). */
export function windowOverlapFraction(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  return inter / Math.max(0.001, aEnd - aStart);
}

export const isLayer1Source = (source: string): boolean =>
  source === LAYER1_SOURCE || source === LAYER1_PROMPT_SOURCE || source === LAYER1_TRANSITION_SOURCE;

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
  [PAIRING_SOURCE]: 5, [PUBLICMETADB_SOURCE]: 5,
  // Below a chapter or crowd ending whose END agrees with it and that starts
  // no earlier than the song (the conflict drop already removed every other
  // one): its start is the song's, theirs is the ending's.
  [LAYER1_TRANSITION_SOURCE]: 4.75,
  // Below every source that may auto-skip, so a crowd or chapter opening keeps
  // working while the theme match is still confirming; above every guess.
  [LAYER1_EARLY_SOURCE]: 4.5,
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
export function dedupeSkipWindows(windowsIn: PreparedWindow[]): PreparedWindow[] {
  const group = skipKindGroup;
  const windows = promoteCorroboratedTransitions(windowsIn);
  const layer1 = new Map<string, PreparedWindow>();
  for (const w of windows) {
    if (isLayer1Source(w.source) && !layer1.has(group(w.type))) layer1.set(group(w.type), w);
  }
  const agreed = windows.filter((w) => {
    const l1 = layer1.get(group(w.type));
    if (!l1) return true;
    if (isLayer1Source(w.source)) return w === l1;
    const endAgrees = Math.abs(w.end - l1.end) <= LAYER1_CONFLICT_SECONDS;
    // A Transition-only ending's start is the song's, not the ending's, so a
    // later start does not contradict it. An EARLIER one does: a real ending
    // cannot start before its song does, and a row that starts in story
    // before the song (a crowd ending fitted to the file's end) would
    // otherwise outrank the match and skip that story.
    if (l1.source === LAYER1_TRANSITION_SOURCE) {
      return endAgrees && w.start >= l1.start - LAYER1_CONFLICT_SECONDS;
    }
    return Math.abs(w.start - l1.start) <= LAYER1_CONFLICT_SECONDS && endAgrees;
  });

  const prio = (src: string) => SKIP_SOURCE_PRIORITY[src] ?? 0;
  // Last tie-break between equal-priority sources (AniSkip vs trusted IntroDB):
  // AniSkip describes a MAL-keyed episode and has per-row votes.
  const tieBreak = (src: string) => (src === "aniskip" ? 1 : 0);
  const l1Rank = (w: PreparedWindow) =>
    (isLayer1Source(w.source) && w.source !== LAYER1_TRANSITION_SOURCE ? 1 : 0);
  // A chapter held for its weak title ("Intro" / "Outro" alone, no crowd row
  // agreeing) that sits in a DIFFERENT region from every other window of its
  // kind ranks below them, ABOVE source priority: it is as likely to be a
  // cold open or story as the real thing, so it must not win the one-opening
  // election over a crowd opening elsewhere. One that covers the same region
  // as another window (overlap past half the shorter) keeps the chapter's
  // rank: both then describe the same opening, and the file's own marker
  // places it in THIS cut (Arcane S2E9: an "Intro" chapter 192.5-255.2 vs
  // IntroDB and PublicMetaDB rows both 5.8 s early). With nothing else of
  // its kind it still survives, as a prompt. Scoped to this hold only: the
  // other holds (l1-pending, other-cut...) are already weighed by the trust
  // rules.
  const isWeak = (w: PreparedWindow) => w.source === "chapter" && w.hold === "weak-title";
  const sameRegion = (a: PreparedWindow, b: PreparedWindow) => {
    const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    return inter / Math.max(0.001, Math.min(a.end - a.start, b.end - b.start)) > 0.5;
  };
  const strayWeak = new Set(agreed.filter((w) => isWeak(w) && !agreed.some(
    (o) => o !== w && !isWeak(o) && group(o.type) === group(w.type) && sameRegion(o, w))));
  const weak = (w: PreparedWindow) => (strayWeak.has(w) ? 0 : 1);
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
           || weak(b) - weak(a)
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
  return withoutRecapUnderMatchedOpening(withoutCrossKindOverlap(kept, (w) => l1Rank(w) * 100 + prio(w.source)))
    .sort((a, b) => a.start - b.start);
}

/** A recap never plays under the opening theme. A crowd recap lying inside a
 *  Layer 1 opening (within LAYER1_CONFLICT_SECONDS at its start) is the
 *  opening's own audio misfiled, so it goes: Spy x Family E2's single IntroDB
 *  "recap" 0-30 s sits inside the matched opening 0.46-89.68 s, and once the
 *  opening started at the theme's audible start instead of 0 s, the recap was
 *  the first window at 0 s and prompted a skip of 21 s of the opening. A
 *  chapter recap (authored by the release) is left alone. */
function withoutRecapUnderMatchedOpening(windows: PreparedWindow[]): PreparedWindow[] {
  const ops = windows.filter((w) => skipKindGroup(w.type) === "op" && isLayer1Source(w.source));
  if (ops.length === 0) return windows;
  return windows.filter((w) => skipKindGroup(w.type) !== "recap" || w.source === "chapter"
    || !ops.some((op) => w.start >= op.start - LAYER1_CONFLICT_SECONDS && w.end <= op.end + LAYER1_CONFLICT_SECONDS));
}

/** An ending never shares time with the opening. When an OP-group and an
 *  ED-group window overlap, the better-ranked one stays; on a tie, or when
 *  both are Layer 3 guesses (Kaiju No. 8's 224 s Narumi special published one
 *  in-story block as both), both go: precision first. */
function withoutCrossKindOverlap(
  windows: PreparedWindow[],
  rank: (w: PreparedWindow) => number,
): PreparedWindow[] {
  const drop = new Set<PreparedWindow>();
  for (const op of windows) {
    if (skipKindGroup(op.type) !== "op") continue;
    for (const ed of windows) {
      if (skipKindGroup(ed.type) !== "ed") continue;
      if (Math.min(op.end, ed.end) - Math.max(op.start, ed.start) <= 0) continue;
      const bothGuesses = op.source === CONTINUITY_SOURCE && ed.source === CONTINUITY_SOURCE;
      const ro = rank(op), re = rank(ed);
      if (bothGuesses || ro === re) { drop.add(op); drop.add(ed); }
      else drop.add(ro > re ? ed : op);
    }
  }
  return drop.size === 0 ? windows : windows.filter((w) => !drop.has(w));
}

/** Sources that may confirm where an ENDING starts: a strongly titled chapter
 *  or a crowd row that fits this cut. */
function confirmsEndingStart(w: PreparedWindow): boolean {
  if (skipKindGroup(w.type) !== "ed" || w.hold === "other-cut" || w.hold === "weak-title") return false;
  return w.source === "chapter" || (CROWD_SKIP_SOURCES.has(w.source) && w.source !== INTRODB_SINGLE_SOURCE);
}

/** A Transition-only ending (prompt-only) whose START an independent source
 *  confirms is an ordinary Layer 1 ending: Cowboy Bebop 26's "Blue" and Bocchi
 *  12's ED4 each have a titled chapter starting within 0.3 s of the match. */
function promoteCorroboratedTransitions(windows: PreparedWindow[]): PreparedWindow[] {
  if (!windows.some((w) => w.source === LAYER1_TRANSITION_SOURCE)) return windows;
  return windows.map((w) => {
    if (w.source !== LAYER1_TRANSITION_SOURCE) return w;
    const confirmed = windows.some((o) => o !== w && confirmsEndingStart(o)
      && Math.abs(o.start - w.start) <= LAYER1_CONFLICT_SECONDS);
    return confirmed ? { ...w, source: LAYER1_SOURCE } : w;
  });
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
  INTRODB_SINGLE_SOURCE, LAYER1_PROMPT_SOURCE, LAYER1_TRANSITION_SOURCE,
]);

/** Windows that are still being confirmed: the provisional opening. They only
 *  prompt until the source that confirms them replaces them. */
export const PROVISIONAL_SKIP_SOURCES: ReadonlySet<string> = new Set([
  LAYER1_EARLY_SOURCE,
]);

/** Whether a window may only ever prompt, whatever the user's mode says.
 *  Beyond the guess / low-trust / provisional sources: every preview, and AniSkip ENDING rows
 *  (TYBW 3:9-3:11 rows were 32-38 s early with a matching episodeLength, so an
 *  AniSkip ED auto-seek would cut into the episode; when Layer 1 found the
 *  ending it has already replaced the row). IntroDB keeps its own tiers. */
export function isPromptOnly(w: Pick<PreparedWindow, "type" | "source" | "hold">): boolean {
  if (w.hold) return true;
  if (
    GUESS_SKIP_SOURCES.has(w.source) || LOW_TRUST_SKIP_SOURCES.has(w.source)
    || PROVISIONAL_SKIP_SOURCES.has(w.source)
  ) return true;
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

// ---------------------------------------------------------------------------
// Crowd rows against THIS file
// ---------------------------------------------------------------------------

/** Slack when checking a crowd row against the file (Rust's
 *  `DURATION_SLACK_SEC` in introdb.rs). */
export const CROWD_DURATION_SLACK_SECONDS = 2;
/** An AniSkip row whose recorded episode length differs from the file by more
 *  than this was timed on another cut, and is demoted to prompt-only. Measured
 *  over all 74 AniSkip rows of both corpora: 10, 15 and 20 s catch the same 20
 *  of 36 wrong rows (all 4 that auto-skipped story: Gintama's OAD opening,
 *  Re:Zero S3E1's opening, Bleach 266's and One Piece 8's recaps) and demote
 *  the same 6 correct ones, each of which a theme match or a chapter replaces. */
export const ANISKIP_CUT_TOLERANCE_SECONDS = 15;

/** Fit every crowd row to the file once its duration is known. A row that
 *  starts past the end belongs to another cut and is dropped, so it can no
 *  longer count as supplying its kind (House of the Dragon S2E1's PublicMetaDB
 *  and IntroDB endings both started past the end, which kept the detector from
 *  ever looking for one). IntroDB keeps its own stricter rule (an end more than
 *  the slack past the file is a different cut: dropped); other ends are
 *  clamped. An AniSkip row recorded against a different episode length is
 *  held prompt-only ("other-cut"), never dropped: correct rows often come from
 *  a cut whose container length differs. `notes` are for the log. */
export function fitCrowdToDuration(
  windows: PreparedWindow[],
  duration: number,
): { windows: PreparedWindow[]; notes: string[] } {
  const notes: string[] = [];
  if (!(duration > 0)) return { windows, notes };
  const out: PreparedWindow[] = [];
  for (const w of windows) {
    if (!CROWD_SKIP_SOURCES.has(w.source)) { out.push(w); continue; }
    const span = `${w.source} ${w.type} ${Math.round(w.start)}-${Math.round(w.end)}s`;
    const introDb = w.source === INTRODB_SOURCE || w.source === INTRODB_SINGLE_SOURCE;
    if (w.start >= duration || (introDb && w.end > duration + CROWD_DURATION_SLACK_SECONDS)) {
      notes.push(`dropped ${span}: does not fit this ${Math.round(duration)}s file`);
      continue;
    }
    let fitted = w.end > duration ? { ...w, end: duration } : w;
    const len = w.source === "aniskip" ? w.episode_length ?? 0 : 0;
    if (len > 0 && Math.abs(len - duration) > ANISKIP_CUT_TOLERANCE_SECONDS && !fitted.hold) {
      notes.push(`held ${span} prompt-only: recorded on a ${Math.round(len)}s cut of this ${Math.round(duration)}s file`);
      fitted = { ...fitted, hold: "other-cut", auto: false };
    }
    if (fitted.end - fitted.start < MIN_WINDOW_SECONDS) continue;
    out.push(fitted);
  }
  return { windows: out, notes };
}

// ---------------------------------------------------------------------------
// Chapters (the pure half of App.tsx's mergeChapterSkipWindows)
// ---------------------------------------------------------------------------

export interface ChapterMark { time?: number | null; title?: string | null }

/** Windows from the file's chapters, beside the crowd rows already fitted to
 *  the file (`existing`). Returns `existing` plus every chapter window
 *  UNDEDUPED: the stamp elects one window per region over every source at
 *  once, which keeps the evidence a later rule needs (a second provider that
 *  corroborates a crowd opening, a chapter that confirms a theme's start). */
export function windowsFromChapters(
  existing: PreparedWindow[],
  chapters: ChapterMark[] | null,
  duration: number,
  modeFor: (kind: string) => SkipMode,
): { windows: PreparedWindow[]; note: string } {
  if (!chapters || chapters.length === 0) {
    return { windows: existing, note: "no chapters in file" };
  }
  // Sort by start time so adjacent-chapter end derivation is stable.
  const sorted = [...chapters]
    .filter((c) => typeof c.time === "number")
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  // Derive [start,end) for every chapter once (end = next chapter's start, or
  // duration for the last). Drop sub-MIN_WINDOW_SECONDS slivers.
  const spans = sorted
    .map((c, i) => {
      const start = c.time ?? 0;
      const end   = ((sorted[i + 1]?.time) ?? (duration || start)) - 0.001;
      return { title: (c.title ?? "").toString(), start, end };
    })
    .filter((s) => s.end > s.start + MIN_WINDOW_SECONDS);

  const derived: PreparedWindow[] = [];
  // Any-overlap guard (vs `existing` AND already-derived), used for the
  // heuristic windows so a guess can never double-stamp a region a precise
  // source already owns.
  const free = (start: number, end: number): boolean =>
    !existing.some((e) => windowOverlapFraction(start, end, e.start, e.end) > 0.0001) &&
    !derived.some((d) => windowOverlapFraction(start, end, d.start, d.end) > 0.0001);

  // 1. TITLED chapters: honour the user's per-kind mode (may be auto, except
  //    a preview, which is prompt-only by construction). Length-capped so a
  //    mis-titled monster chapter can't nuke real content. A "Preview" /
  //    "Next episode" chapter only counts when it actually sits in the outro
  //    region (an EARLY "Preview" chapter is story, not a preview: Steins;Gate
  //    24's cold open is titled exactly that).
  //    A WEAK title ("Intro" / "Outro" alone) is dropped when the file also
  //    has a strongly titled chapter of that kind (those releases use it for
  //    the cold open or the preview), and otherwise prompts unless a crowd row
  //    that fits this cut agrees within LAYER1_CONFLICT_SECONDS at both edges.
  const strongKinds = new Set(
    spans.filter((s) => !isWeakChapterTitle(s.title)).map((s) => classifyChapterTitle(s.title)),
  );
  for (const s of spans) {
    const kind = classifyChapterTitle(s.title);
    if (!kind) continue;
    if (modeFor(kind) === "off") continue;
    const len = s.end - s.start;
    if (len > (kind === "ed" ? ED_MAX_SECONDS : TITLED_OP_MAX_SECONDS)) continue;
    if (
      kind === "preview" && duration > 0 &&
      s.start < duration * (1 - OUTRO_FRACTION) - 1
    ) continue;
    let hold: SkipHold | null = null;
    if (isWeakChapterTitle(s.title)) {
      if (strongKinds.has(kind)) continue;
      const agreed = existing.some((e) =>
        skipKindGroup(e.type) === kind && CROWD_SKIP_SOURCES.has(e.source) && e.hold !== "other-cut"
        && Math.abs(e.start - s.start) <= LAYER1_CONFLICT_SECONDS
        && Math.abs(e.end - s.end) <= LAYER1_CONFLICT_SECONDS);
      if (!agreed) hold = "weak-title";
    }
    // Always add the titled chapter: cross-source overlap (incl. vs AniSkip)
    // is resolved centrally by dedupeSkipWindows, which PREFERS the
    // encoder-set chapter over every crowd source (and Layer 1 over it).
    derived.push({
      type:   kind,
      start:  s.start,
      end:    s.end,
      source: "chapter",
      auto:   hold == null && modeFor(kind) === "auto",
      ...(hold ? { hold } : {}),
    });
  }

  // 2. PROLOGUE FIX: when nothing gave us an OP, pick the untitled chapter in
  //    the leading INTRO_FRACTION whose length is closest to the ~90 s
  //    industry-standard OP (tie -> the LATER chapter, so a short cold-open
  //    prologue loses to the real OP). Prompt-only: never auto-skip a guess.
  //    A chapter whose title names story (Prologue, Cold open, Teaser) is
  //    never a candidate.
  if (duration > 0 && modeFor("op") !== "off") {
    const hasOp =
      existing.some((e) => skipKindGroup(e.type) === "op") ||
      derived.some((d) => d.type === "op");
    if (!hasOp) {
      const introLimit = duration * INTRO_FRACTION;
      const cands = spans
        .filter((s) => classifyChapterTitle(s.title) === null && !isStoryChapterTitle(s.title)
          && s.start < introLimit)
        .map((s) => ({ s, len: s.end - s.start }))
        .filter(({ len }) => len >= OP_MIN_SECONDS && len <= OP_MAX_SECONDS)
        .sort((a, b) => {
          const da = Math.abs(a.len - TARGET_OP_SECONDS);
          const db = Math.abs(b.len - TARGET_OP_SECONDS);
          return Math.abs(da - db) <= 5 ? b.s.start - a.s.start : da - db;
        });
      const pick = cands[0]?.s;
      if (pick && free(pick.start, pick.end)) {
        derived.push({
          type: "op", start: pick.start, end: pick.end,
          source: "chapter-heuristic", auto: false,
        });
      }
    }
  }

  // 3. Untitled OUTRO: exactly one untitled chapter wholly inside the
  //    trailing OUTRO_FRACTION, >= 20 s, when nothing else gave an ED.
  //    Prompt-only. NEVER the last chapter when it runs to the end of the
  //    file: an untitled final chapter can hold the ending AND an
  //    after-credits scene AND a preview, and an ED ending at EOF is exactly
  //    how those were skipped.
  if (duration > 0 && modeFor("ed") !== "off") {
    const hasEd =
      existing.some((e) => skipKindGroup(e.type) === "ed") || derived.some((d) => d.type === "ed");
    if (!hasEd) {
      const outroStart = duration * (1 - OUTRO_FRACTION);
      const outroCands = spans.filter(
        (s) =>
          classifyChapterTitle(s.title) === null &&
          !isStoryChapterTitle(s.title) &&
          s.start >= outroStart &&
          s.end < duration - 1 &&
          s.end - s.start >= 20 &&
          s.end - s.start <= ED_MAX_SECONDS,
      );
      if (outroCands.length === 1 && free(outroCands[0].start, outroCands[0].end)) {
        const o = outroCands[0];
        derived.push({
          type: "ed", start: o.start, end: o.end,
          source: "chapter-heuristic", auto: false,
        });
      }
    }
  }

  if (derived.length === 0) {
    return { windows: existing, note: "chapters yielded no windows" };
  }
  return {
    windows: [...existing, ...derived],
    note: `${derived.length} chapter window(s) beside ${existing.length} other(s)`,
  };
}

// ---------------------------------------------------------------------------
// The stamp: every source of a load, plus what the theme match concluded
// ---------------------------------------------------------------------------

/** What Layer 1 concluded for a kind on this load (Rust `L1State`, plus "off"
 *  when Layer 1 is not deciding the kind at all: no MAL id, detection off, or
 *  the kind switched off). */
export type Layer1State = "off" | "pending" | "matched" | "informative" | "no_themes" | "unavailable";
export interface Layer1Status {
  op: Layer1State;
  ed: Layer1State;
  /** The audio Layer 1 actually searched for the opening, in media seconds
   *  (Rust `Snapshot::op_region`: 0 to the end HEAD decoded). Absent until
   *  HEAD has run; read as 0-600 s (HEAD's span) meanwhile. */
  opRegion?: [number, number] | null;
  /** The same for the ending (TAIL origin to the final media end). Absent
   *  until TAIL has run; read as the last 480 s before the media end. */
  edRegion?: [number, number] | null;
}

/** Map a Rust snapshot's per-kind state onto the load's. A value that says
 *  nothing about this kind ("unknown", "not_requested", absent) releases a
 *  pending kind instead of leaving it held. */
export function layer1StateFrom(wire: string | null | undefined, current: Layer1State): Layer1State {
  switch (wire) {
    case "pending":     return current === "off" ? "off" : "pending";
    case "matched":     return "matched";
    case "informative": return "informative";
    case "no_themes":   return "no_themes";
    case "unavailable": return "unavailable";
    default:            return current === "pending" ? "unavailable" : current;
  }
}

/** Every pending kind released (the detect ended without deciding it). */
export function releasePendingLayer1(s: Layer1Status): Layer1Status {
  return {
    ...s,
    op: s.op === "pending" ? "unavailable" : s.op,
    ed: s.ed === "pending" ? "unavailable" : s.ed,
  };
}

export interface SkipComposeInput {
  /** Crowd, chapter and borrowed windows (fitted to the file, undeduped). */
  base: PreparedWindow[];
  /** The detector's current windows (Layer 1, the provisional opening, or
   *  Layer 3), already mapped to their frontend sources. */
  detected: PreparedWindow[];
  mediaEnd: number | null;
  layer1: Layer1Status;
  /** The title resolved a cour MAL id. Without one there is no theme match,
   *  so a lone crowd opening has nothing in the file to check it. */
  hasMal: boolean;
}

/** The trust rules that depend on more than one source, applied to `base`
 *  before the dedupe. Strongly titled chapters are exempt from the Layer 1
 *  rules; a chapter held for its WEAK title ("Intro" / "Outro" alone) is
 *  dropped while Layer 1 is pending for its kind or after an informative
 *  abstain (9 of the 11 such chapters in both corpora were cold opens,
 *  previews or story; measured over all 89 episodes this changes only
 *  Re:Zero S4E5, whose two story chapters stop prompting).
 *   1. Layer 1 PENDING for a kind: its crowd rows in the searched region only
 *      prompt ("l1-pending"),
 *      unless the provisional opening already starts within
 *      LAYER1_CONFLICT_SECONDS of the row. When Layer 1 settles they are
 *      released (a match then confirms or drops them through the conflict
 *      drop; no themes, or no decision, trusts them as before).
 *   2. Layer 1 INFORMATIVE abstain (themes exist, none in the searched
 *      region): the kind's auto-eligible crowd rows there only prompt
 *      ("l1-abstain"); its
 *      guesses and its prompt-only crowd rows (single-submission IntroDB, an
 *      AniSkip ending) are dropped: all 8 such rows in both corpora were
 *      wrong, and every correct window of such a kind was a titled chapter.
 *      "The searched region" for rules 1 and 2: a row overlapping the audio
 *      Layer 1 searched for its kind (HEAD for an opening, TAIL for an
 *      ending) by at least LAYER1_MIN_RUN_SECONDS (all of a shorter row). A
 *      theme overlapping it by less could never have passed Layer 1's
 *      minimum run, so the abstain says nothing about such a row (an opening
 *      at 640 s, past HEAD's 600 s): it is not held, as if the kind had no
 *      themes. Rule 2's drop of guesses and prompt-only crowd rows still
 *      applies to it (low trust, where the kind almost never is).
 *   3. No MAL id (live action): a crowd OPENING auto-skips only when a second
 *      independent source agrees within LAYER1_CONFLICT_SECONDS at both edges
 *      (IntroDB vs PublicMetaDB, or a strongly titled chapter); otherwise it
 *      prompts ("uncorroborated"). 5 of the 9 lone live-action crowd openings
 *      in the corpora cut into story (131 s). Endings keep their trust.
 *   4. A crowd RECAP (any title) needs the same second source ("uncorroborated"
 *      otherwise); rows identical to the 0.05 s count as one. The opening
 *      Layer 1 located in the file also corroborates it when that opening
 *      starts within LAYER1_CONFLICT_SECONDS of the recap's END (a recap that
 *      runs right up to a matched theme): evidence from the file itself,
 *      where a second crowd row is often the same submitter twice. Black
 *      Clover 2:1 (recap end 178.0, theme 176.05) and DBZ Kai 26 (40.13,
 *      39.01) auto-skip again; JJK S1E3's 0.5-41.6 "recap" (theme at 191.84)
 *      stays held. Layer 1 places the opening some 10-17 s into a load, so
 *      such a recap at 0 s turns auto only then: the SkipController still
 *      skips the rest of it when that is before its midpoint, and offers it
 *      as a prompt after. */
export function applyCrossSourceHolds(
  base: PreparedWindow[],
  detected: PreparedWindow[],
  layer1: Layer1Status,
  hasMal: boolean,
  /** The detector's media end (for the ending's default searched region). */
  mediaEnd: number | null = null,
): PreparedWindow[] {
  const near = (a: PreparedWindow, b: PreparedWindow) =>
    Math.abs(a.start - b.start) <= LAYER1_CONFLICT_SECONDS
    && Math.abs(a.end - b.end) <= LAYER1_CONFLICT_SECONDS;
  const early = detected.find((w) => w.source === LAYER1_EARLY_SOURCE && skipKindGroup(w.type) === "op");
  // A row that already only prompts keeps its own (more lasting) reason.
  const hold = (w: PreparedWindow, why: SkipHold): PreparedWindow =>
    (isPromptOnly(w) ? w : { ...w, hold: why, auto: false });
  const out: PreparedWindow[] = [];
  for (const w of base) {
    const g = skipKindGroup(w.type);
    const crowd = CROWD_SKIP_SOURCES.has(w.source);
    if (g === "recap" && crowd && !isPromptOnly(w)) {
      // 4. A crowd RECAP is checked by nothing in the file (no detector
      //    finds one), so it auto-skips only when a titled chapter or a
      //    SECOND provider agrees within LAYER1_CONFLICT_SECONDS at both
      //    edges. Rows identical to the 0.05 s are one submitter twice, not
      //    two sources: JJK S1E3's AniSkip and IntroDB "recap" 0.5-41.6 are
      //    the same numbers, and frames show 30 s of that span is the
      //    episode's own dorm scene, not a recap.
      const same = (o: PreparedWindow) =>
        Math.abs(o.start - w.start) < 0.05 && Math.abs(o.end - w.end) < 0.05;
      const provider = (s: string) => (s === INTRODB_SINGLE_SOURCE ? INTRODB_SOURCE : s);
      const corroborated = base.some((o) => o !== w && skipKindGroup(o.type) === "recap" && near(o, w) && (
        (o.source === "chapter" && !o.hold)
        || (CROWD_SKIP_SOURCES.has(o.source) && provider(o.source) !== provider(w.source) && !same(o))))
        || detected.some((d) => skipKindGroup(d.type) === "op"
          && (d.source.startsWith(LAYER1_SOURCE) || d.source === LAYER1_EARLY_SOURCE)
          && Math.abs(d.start - w.end) <= LAYER1_CONFLICT_SECONDS);
      out.push(corroborated ? w : hold(w, "uncorroborated"));
      continue;
    }
    if (g !== "op" && g !== "ed") { out.push(w); continue; }
    // Rules 1 and 2 hold only rows inside the audio Layer 1 searched: a theme
    // at the row's place needs LAYER1_MIN_RUN_SECONDS inside that audio to
    // be found (all of a shorter row).
    const region = g === "op"
      ? layer1.opRegion ?? [0, HEAD_SEARCH_SECONDS]
      : layer1.edRegion ?? (mediaEnd != null && mediaEnd > 0
        ? [Math.max(0, mediaEnd - TAIL_SEARCH_SECONDS), mediaEnd] : null);
    const judged = region == null
      || Math.min(w.end, region[1]) - Math.max(w.start, region[0])
        >= Math.min(LAYER1_MIN_RUN_SECONDS, w.end - w.start) - 0.001;
    // Rule 2's DROP of guesses and prompt-only crowd rows applies wherever
    // the row sits: outside the searched audio the abstain is no evidence,
    // but such a row there is low trust placed where the kind almost never
    // is (Spy x Family E2: a single-submission IntroDB "ending" at
    // 905-995 s of a 1451 s episode with no ending at all). Precision first.
    if (!judged && layer1[g] === "informative"
      && (GUESS_SKIP_SOURCES.has(w.source) || (crowd && isPromptOnly(w) && !w.hold))) continue;
    const state = judged ? layer1[g] : "no_themes";
    // A chapter held for its weak title is dropped while Layer 1 decides the
    // kind and after it abstained informatively (rules 1 and 2): Re:Zero
    // S4E5's "Intro" 0-136 and "Outro" 1182-1420 are both story, and while
    // pending the "Intro" prompt was already on screen at 0.6 s.
    const weakChapter = w.source === "chapter" && w.hold === "weak-title";
    if (weakChapter && (state === "pending" || state === "informative")) continue;
    if (state === "informative") {
      if (GUESS_SKIP_SOURCES.has(w.source) || (crowd && isPromptOnly(w) && !w.hold)) continue;
      out.push(crowd ? hold(w, "l1-abstain") : w);
      continue;
    }
    if (state === "pending" && crowd) {
      const confirmed = g === "op" && early != null
        && Math.abs(early.start - w.start) <= LAYER1_CONFLICT_SECONDS;
      out.push(confirmed ? w : hold(w, "l1-pending"));
      continue;
    }
    if (!hasMal && g === "op" && crowd && !isPromptOnly(w)) {
      const introDb = w.source === INTRODB_SOURCE || w.source === INTRODB_SINGLE_SOURCE;
      const corroborated = base.some((o) => o !== w && skipKindGroup(o.type) === "op" && near(o, w) && (
        (o.source === "chapter" && !o.hold)
        || (introDb ? o.source === PUBLICMETADB_SOURCE
                    : o.source === INTRODB_SOURCE || o.source === INTRODB_SINGLE_SOURCE)));
      out.push(corroborated ? w : hold(w, "uncorroborated"));
      continue;
    }
    out.push(w);
  }
  return out;
}

/** The Next-Up gate's TRUSTED ending end for a published window list, or
 *  null. A published Layer 1 ending's end (an auto-eligible match, or a
 *  partially Over one: prompt-only, but its LOCATION is the same Layer 1
 *  evidence, so Pop Team Epic 1:5's ED4 holds the card until 1406.26 instead
 *  of raising it 28 s inside the ending); else the end of the published
 *  ending that took the place of the detector's own Layer 1 ending (a
 *  Transition-only match, published as itself or replaced by a chapter or
 *  crowd ending that outranked it) when the two ends agree within
 *  LAYER1_CONFLICT_SECONDS: the theme's END is trusted even where its start
 *  is not (Solo Leveling E1, Cowboy Bebop 13). Read from the PUBLISHED window,
 *  so the media-end clamp still applies. Never a crowd, chapter or Layer 3
 *  end on its own. */
export function trustedEndingEnd(
  published: PreparedWindow[],
  detectedEd: PreparedWindow | null,
): number | null {
  const ends = published.filter((w) => skipKindGroup(w.type) === "ed");
  const l1 = ends.find((w) => w.source === LAYER1_SOURCE || w.source === LAYER1_PROMPT_SOURCE);
  if (l1) return l1.end;
  const d = detectedEd;
  if (d == null || (d.source !== LAYER1_SOURCE && d.source !== LAYER1_PROMPT_SOURCE && d.source !== LAYER1_TRANSITION_SOURCE)) return null;
  const agreed = ends.find((w) => Math.abs(w.end - d.end) <= LAYER1_CONFLICT_SECONDS);
  return agreed ? agreed.end : null;
}

/** A window the SkipController already handled (auto-skipped, demoted to a
 *  prompt, or skipped with X / Shift+X). */
export interface HandledWindow { type: string; start: number; end: number }

/** Whether `w` is a window in `handled`: the same kind with BOTH edges within
 *  LAYER1_CONFLICT_SECONDS. Not exact edges: the detector refines a Layer 1
 *  window while it decodes (an edge moving by more than 5 ms republishes it),
 *  and an exact-edge key turned every refinement into a new window, so an
 *  opening the user had already skipped, or sought back into on purpose,
 *  was auto-skipped again or re-prompted. Both edges must agree, so a
 *  genuinely different window of the kind is never swallowed. */
export function handledIn(handled: readonly HandledWindow[], w: HandledWindow): boolean {
  const g = skipKindGroup(w.type);
  return handled.some((h) => skipKindGroup(h.type) === g
    && Math.abs(h.start - w.start) <= LAYER1_CONFLICT_SECONDS
    && Math.abs(h.end - w.end) <= LAYER1_CONFLICT_SECONDS);
}

/** THE stamp's window list: holds, then the dedupe (Layer 1 conflict drop,
 *  one opening, region overlap, no ending over the opening), then the media
 *  end clamp. Both writers of a load (App.tsx's stamp and the e2e harness)
 *  call this one function. Modes are applied after it (`applySkipModes`). */
export function composeSkipWindows(inp: SkipComposeInput): SkipDedupe {
  // Layer 3 is a last resort: a continuity window never joins a kind another
  // source supplied. Layer 1 always passes, so its conflict drop keeps working.
  const covered = new Set(inp.base.map((w) => skipKindGroup(w.type)));
  const detected = inp.detected.filter(
    (w) => !(w.source === CONTINUITY_SOURCE && covered.has(skipKindGroup(w.type))),
  );
  const held = applyCrossSourceHolds(inp.base, detected, inp.layer1, inp.hasMal, inp.mediaEnd);
  const deduped = dedupeSkipWindowsDetailed([...held, ...detected]);
  return {
    kept: clampWindowsToMediaEnd(deduped.kept, inp.mediaEnd),
    superseded: deduped.superseded,
  };
}
