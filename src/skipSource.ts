// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CONTINUITY_SOURCE, INTRODB_SINGLE_SOURCE, INTRODB_SOURCE, LAYER1_PROMPT_SOURCE,
  LAYER1_SOURCE, PAIRING_SOURCE,
} from "./skipWindows";

/** Where a skip window came from, in words. Shared by the AuraSkip menu's
 *  rows and the scrubber's hover card so the two always name a source the
 *  same way. An unknown id is shown as-is rather than hidden. */
export function skipSourceLabel(source: string): string {
  switch (source) {
    case LAYER1_SOURCE:         return "Theme match";
    case LAYER1_PROMPT_SOURCE:  return "Theme match (over the scene)";
    case PAIRING_SOURCE:        return "Other episodes (audio)";
    case CONTINUITY_SOURCE:     return "Detected";
    case "aniskip":             return "AniSkip";
    case INTRODB_SOURCE:        return "IntroDB";
    case INTRODB_SINGLE_SOURCE: return "IntroDB (single submission)";
    case "publicmetadb":        return "PublicMetaDB";
    case "chapter":             return "Chapter";
    case "chapter-heuristic":   return "Chapter guess";
    case "aniskip-neighbour":   return "Other episodes";
    default:                    return source;
  }
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
