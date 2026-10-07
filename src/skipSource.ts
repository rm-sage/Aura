// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CONTINUITY_SOURCE, INTRODB_SINGLE_SOURCE, INTRODB_SOURCE, LAYER1_EARLY_SOURCE,
  LAYER1_PROMPT_SOURCE, LAYER1_SOURCE, PAIRING_SOURCE, isPromptOnly, skipKindGroup, skipModeForKind,
  type SkipModes,
} from "./skipWindows";

/** Where a skip window came from, in words. Shared by the AuraSkip menu's
 *  rows and the scrubber's hover card so the two always name a source the
 *  same way. An unknown id is shown as-is rather than hidden. */
export function skipSourceLabel(source: string): string {
  switch (source) {
    case LAYER1_SOURCE:         return "Theme match";
    case LAYER1_PROMPT_SOURCE:  return "Theme match (over story)";
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
    case LAYER1_PROMPT_SOURCE:  return "Theme song found, but it plays over story scenes";
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

/** Why a window only ever prompts. `hint` is a tooltip clause (AuraSkip
 *  menu); `line` completes "Auto-skip is on, but ..." (the in-player prompt).
 *  Mirrors `isPromptOnly` in skipWindows.ts case for case, so a reason is
 *  never shown for a window that would in fact auto-skip. */
export interface SkipPromptOnlyReason { hint: string; line: string }

export function skipPromptOnlyReason(
  w: { type: string; source: string },
): SkipPromptOnlyReason | null {
  if (!isPromptOnly(w)) return null;
  if (skipKindGroup(w.type) === "preview") {
    return { hint: "Next-episode previews always ask first", line: "previews always ask" };
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
      return { hint: "This opening plays over story, so it asks first", line: "this opening plays over story" };
    case LAYER1_EARLY_SOURCE:
      return {
        hint: "Asks until the whole theme song is confirmed",
        line: "the theme match is still confirming the rest of the song",
      };
    case "aniskip":
      return { hint: "AniSkip ending times can be off, so they ask first", line: "AniSkip ending times can be off" };
    default:
      return { hint: "This source always asks first", line: "this source always asks first" };
  }
}

/** The reason a window PROMPTS although the user set its kind to Auto, or
 *  null when it is not being held back (its kind is not on Auto, or it is
 *  auto-eligible). A preview has no mode of its own: it follows the ENDING
 *  row, so "on Auto" means the ending is on Auto. Shared by the AuraSkip
 *  menu, the scrubber's hover card and the in-player prompt, so the three
 *  can never disagree. */
export function skipHeldReason(
  w: { type: string; source: string },
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
