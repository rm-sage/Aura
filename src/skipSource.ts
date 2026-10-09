// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CONTINUITY_SOURCE, INTRODB_SINGLE_SOURCE, INTRODB_SOURCE, LAYER1_EARLY_SOURCE,
  LAYER1_PROMPT_SOURCE, LAYER1_SOURCE, LAYER1_TRANSITION_SOURCE, PAIRING_SOURCE, isPromptOnly,
  THEME_VERIFIED_MAX_SECONDS, skipConfidence, skipKindGroup, skipModeForKind,
  type SkipBasis, type SkipConfidence, type SkipHold, type SkipModes,
} from "./skipWindows";

/** Where a skip window came from, in words. Shared by the AuraSkip menu's
 *  rows and the scrubber's hover card so the two always name a source the
 *  same way. An unknown id is shown as-is rather than hidden. */
export function skipSourceLabel(source: string): string {
  switch (source) {
    case LAYER1_SOURCE:         return "Theme match";
    case LAYER1_PROMPT_SOURCE:  return "Theme match (over story in some versions)";
    case LAYER1_TRANSITION_SOURCE: return "Theme match (starts in story)";
    case LAYER1_EARLY_SOURCE:   return "Theme match (confirming)";
    case PAIRING_SOURCE:        return "Other episodes (audio)";
    case CONTINUITY_SOURCE:     return "Detected";
    case "aniskip":             return "AniSkip";
    case INTRODB_SOURCE:        return "IntroDB";
    case INTRODB_SINGLE_SOURCE: return "IntroDB (unconfirmed)";
    case "publicmetadb":        return "PublicMetaDB";
    case "chapter":             return "Chapter";
    case "chapter-heuristic":   return "Chapter guess";
    case "aniskip-neighbour":   return "Other episodes";
    default:                    return source;
  }
}

/** What a source name MEANS, for a hover on the AuraSkip menu's source line.
 *  One short clause each: the Tooltip is whitespace-nowrap. The scrubber's
 *  hover card cannot carry a tooltip (it is pointer-events-none), which is why
 *  the labels above are written to stand on their own. Empty for an unknown
 *  id, so the caller shows no tooltip rather than a guess. */
export function skipSourceHint(source: string): string {
  switch (source) {
    case LAYER1_SOURCE:         return "Found by matching the show's theme song in this audio";
    case LAYER1_PROMPT_SOURCE:  return "Theme song found, but some versions play it over story scenes";
    case LAYER1_TRANSITION_SOURCE: return "Ending song found; it starts while the story is still playing";
    case LAYER1_EARLY_SOURCE:   return "The theme song's start matched; the rest is still being checked";
    case PAIRING_SOURCE:        return "Matched against other episodes' audio";
    case CONTINUITY_SOURCE:     return "Guessed from this episode's audio";
    case "aniskip":             return "Community timings from AniSkip";
    case INTRODB_SOURCE:        return "IntroDB timings confirmed by several submissions";
    case INTRODB_SINGLE_SOURCE: return "IntroDB timings not yet confirmed by several submissions";
    case "publicmetadb":        return "Timings from the PublicMetaDB skip database";
    case "chapter":             return "Named by the file's own chapters";
    case "chapter-heuristic":   return "Guessed from an untitled chapter in the file";
    case "aniskip-neighbour":   return "Borrowed from AniSkip timings of nearby episodes";
    default:                    return "";
  }
}

/** The fields of a skip window these helpers read. */
type SkipWindowLike = {
  type: string; source: string; start: number; end: number;
  hold?: SkipHold | null; basis?: SkipBasis | null;
};

/** Why a window only ever prompts. `hint` is a tooltip clause (AuraSkip
 *  menu); `line` completes "Auto-skip is on, but ..." (the in-player prompt).
 *  Mirrors `isPromptOnly` in skipWindows.ts case for case, so a reason is
 *  never shown for a window that would in fact auto-skip. */
export interface SkipPromptOnlyReason { hint: string; line: string }

export function skipPromptOnlyReason(w: SkipWindowLike): SkipPromptOnlyReason | null {
  if (!isPromptOnly(w)) return null;
  if (skipKindGroup(w.type) === "preview") {
    return { hint: "Next-episode previews always ask first", line: "previews always ask" };
  }
  switch (w.hold) {
    case "l1-pending":
      return {
        hint: "Asks until the theme song match has checked these times",
        line: "the theme song match is still checking these times",
      };
    case "l1-abstain":
      return {
        hint: "The theme song is not where these times put it, so it asks first",
        line: "the theme song is not where these times put it",
      };
    case "other-cut":
      return {
        hint: "Timed on a different cut of this episode, so it asks first",
        line: "these times were made for a different cut of the episode",
      };
    case "weak-title":
      return {
        hint: "The chapter is only named Intro or Outro, so it asks first",
        line: "the chapter is only named Intro or Outro",
      };
    case "uncorroborated":
      return {
        hint: "Nothing else confirms these times, so it asks first",
        line: "nothing else confirms these times",
      };
    default:
      break;
  }
  switch (w.source) {
    case CONTINUITY_SOURCE:
      return { hint: "Guessed from the audio, so it asks first", line: "this is a guess" };
    case "chapter-heuristic":
      return { hint: "Guessed from the file's chapters, so it asks first", line: "this is a guess" };
    case "aniskip-neighbour":
      return { hint: "Borrowed from other episodes, so it asks first", line: "this was borrowed from other episodes" };
    case INTRODB_SINGLE_SOURCE:
      return { hint: "Not yet confirmed on IntroDB, so it asks first", line: "IntroDB has not confirmed it yet" };
    case LAYER1_PROMPT_SOURCE:
      return { hint: "Some versions play this song over story, so it asks first", line: "some versions play this song over story" };
    case LAYER1_TRANSITION_SOURCE:
      return {
        hint: "The ending song starts while the story is still playing, so it asks first",
        line: "the ending song starts while the story is still playing",
      };
    case LAYER1_EARLY_SOURCE:
      return {
        hint: "Asks until the whole theme song is confirmed",
        line: "the theme match is still confirming the rest of the song",
      };
    case "aniskip":
      if (skipKindGroup(w.type) === "ed") {
        return { hint: "AniSkip ending times can be off, so they ask first", line: "AniSkip ending times can be off" };
      }
      break;
    default:
      break;
  }
  // Prompt-only for its Risky level alone (isPromptOnly).
  if (w.basis && skipConfidence({ ...w, basis: w.basis }) === "risky") {
    if (w.basis === "chapter-tail") {
      return {
        hint: "The chapter runs to the end of the file, so it asks first",
        line: "it runs to the end of the file and may hold a scene after the credits",
      };
    }
    return { hint: "Risky timings always ask first", line: "these timings are marked Risky" };
  }
  return { hint: "This source always asks first", line: "this source always asks first" };
}

/** The reason a window PROMPTS although the user set its kind to Auto, or
 *  null when it is not being held back (its kind is not on Auto, or it is
 *  auto-eligible). A preview has no mode of its own: it follows the ENDING
 *  row, so "on Auto" means the ending is on Auto. Shared by the AuraSkip
 *  menu, the scrubber's hover card and the in-player prompt, so the three
 *  can never disagree. */
export function skipHeldReason(
  w: SkipWindowLike,
  modes: SkipModes,
): SkipPromptOnlyReason | null {
  const mode = skipKindGroup(w.type) === "preview" ? modes.ed : skipModeForKind(w.type, modes);
  if (mode !== "auto") return null;
  return skipPromptOnlyReason(w);
}

/** A window KIND in words ("Opening", "Preview", ...). Shared by the scrubber
 *  hover card, the skip prompt / toast and the AuraSkip menu. */
export function skipKindLabel(kind: string): string {
  switch (kind) {
    case "op":       return "Opening";
    case "mixed-op": return "Opening";
    case "ed":       return "Ending";
    case "mixed-ed": return "Ending";
    case "recap":    return "Recap";
    case "preview":  return "Preview";
    default:         return "Segment";
  }
}

// ---------------------------------------------------------------------------
// Confidence, in words
// ---------------------------------------------------------------------------

/** A confidence level's name. Short enough for a chip. */
export function skipConfidenceLabel(level: SkipConfidence): string {
  switch (level) {
    case "verified": return "Verified";
    case "likely":   return "Likely";
    case "risky":    return "Risky";
  }
}

/** What a level promises, for a tooltip on its chip and the Settings legend.
 *  One clause each (the Tooltip is whitespace-nowrap). */
export function skipConfidenceMeaning(level: SkipConfidence): string {
  switch (level) {
    case "verified": return "Found in this episode itself: cuts at most a second or two of story, but can stop short";
    case "likely":   return "Usually right, but its exact edges are not confirmed: it can be off";
    case "risky":    return "A guess or doubtful times: may cut into the story, so it always asks first";
  }
}

/** The one-line note under a prompt and in the AuraSkip menu: what this
 *  window's position rests on and, below the top level, what could go wrong.
 *  Written per basis (and kind, where the risk differs), so it says why THIS
 *  window got its level. Null without a basis. */
export function skipConfidenceNote(w: SkipWindowLike): string | null {
  const g = skipKindGroup(w.type);
  const song = g === "op" ? "opening song" : g === "ed" ? "ending song" : "theme song";
  const who = skipSourceLabel(w.source);
  const len = w.end - w.start;
  switch (w.basis) {
    case "theme":
      return len <= THEME_VERIFIED_MAX_SECONDS
        ? `Matched the ${song} in this episode's audio`
        : `Matched the ${song}, but it runs unusually long: worth a look`;
    case "theme-settling":   return `Matched the ${song}; still measuring its exact edges`;
    case "theme-partial":    return `Matched the ${song}, which plays over story scenes in some versions`;
    case "theme-transition": return "The song starts while the story is still playing: skipping from its start may cut into the story";
    case "theme-early":      return "The opening song's start matched; still confirming the rest";
    case "chapter":
      if (g === "op") {
        return len >= 20 && len <= 100
          ? "Marked as the opening by this file's own chapters"
          : "Marked as the opening by this file's own chapters, but an unusual length for one";
      }
      if (g === "preview") {
        return len <= 40
          ? "Marked as the preview by this file's own chapters"
          : "Marked as the preview by this file's own chapters; may run past it";
      }
      if (g === "ed") return "Marked as the ending by this file's own chapters, which are not always exact";
      if (g === "recap") return "Marked as the recap by this file's own chapters";
      return "Marked by this file's own chapters";
    case "chapter-tail":     return "This file's ending chapter runs to the very end: may hold a scene after the credits";
    case "chapter-weak":     return g === "op"
      ? "The chapter is only named Intro, which is often a cold open or story"
      : "The chapter is only named Outro, which can hold story or a preview";
    case "chapter-guess":    return "Guessed from an untitled chapter: may include story";
    case "crowd-agreed":     return g === "recap"
      ? "Confirmed by a second source, or by the opening song starting where it ends"
      : "Two separate sources agree on these times";
    case "crowd":            return g === "ed" && w.source === "aniskip"
      ? "AniSkip ending times are often off by tens of seconds"
      : `${who} times, not checked against this episode`;
    case "crowd-checking":   return `${who} times, not yet checked by the theme song match: may be wrong`;
    case "crowd-not-found":  return `The ${song} was not found at these ${who} times: they may be wrong`;
    case "crowd-other-cut":  return `${who} times from a different cut of this episode: may be well off or not apply`;
    case "crowd-lone":       return `Nothing else confirms these ${who} times: may cut into the story`;
    case "crowd-single":     return "IntroDB times not yet confirmed by several submissions: may cut into the story";
    case "neighbour":        return "Borrowed from other episodes' times: this episode's opening may differ or not exist";
    case "loudness":         return "Guessed from the audio: may cut into the story";
    default:                 return null;
  }
}

/** Level and note together, or null for a window with no basis. */
export function skipConfidenceInfo(
  w: SkipWindowLike,
): { level: SkipConfidence; label: string; meaning: string; note: string } | null {
  const level = skipConfidence(w);
  const note = skipConfidenceNote(w);
  if (!level || !note) return null;
  return { level, label: skipConfidenceLabel(level), meaning: skipConfidenceMeaning(level), note };
}
