// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StreamEntry } from "../types";

/** A stable-ish identity for a stream that survives across different members'
 *  freshly-fetched lists (debrid URLs differ per user, so the URL is useless).
 *  info_hash is best (content identity); filename / first title line are the
 *  fallbacks. Used to broadcast the leader's pick + highlight the matching row
 *  in each member's own stream list. */
export function streamMatchKey(s: StreamEntry): string | null {
  const firstLine = s.title ? s.title.split("\n")[0].trim() : "";
  return s.info_hash || s.filename || firstLine || null;
}

/** Human-readable label for the leader's chosen stream
 *  ("Comet · Frieren.S01E03.1080p.BluRay"). */
export function streamLabel(s: StreamEntry): string {
  const name = s.filename || (s.title ? s.title.split("\n")[0].trim() : "") || "stream";
  return ((s.addon_name ? `${s.addon_name} · ` : "") + name).slice(0, 120);
}
