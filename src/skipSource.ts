// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { INTRODB_SINGLE_SOURCE, INTRODB_SOURCE } from "./introdb";

/** Where a skip window came from, in words. Shared by the AuraSkip menu's
 *  rows and the scrubber's hover card so the two always name a source the
 *  same way. An unknown id is shown as-is rather than hidden. */
export function skipSourceLabel(source: string): string {
  switch (source) {
    case "aniskip":             return "AniSkip";
    case INTRODB_SOURCE:        return "IntroDB";
    case INTRODB_SINGLE_SOURCE: return "IntroDB (single submission)";
    case "publicmetadb":        return "PublicMetaDB";
    case "chapter":             return "Chapter";
    case "chapter-heuristic":   return "Chapter guess";
    case "silencedetect":       return "Detected";
    case "aniskip-neighbour":   return "Other episodes";
    default:                    return source;
  }
}
