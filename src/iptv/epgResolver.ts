// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EPG resolver (Live TV spec §1) — joins a channel to its EPG program
// list. Primary key is tvg-id; when several channels share one tvg-id
// (a common provider sloppiness: regional variants all stamped with the
// national id), a token-overlap guard demands the channel NAME also
// resemble the id before trusting the join, so "ESPN 2" doesn't show
// "ESPN" programming just because both carry tvg-id="espn.us".
// ---------------------------------------------------------------------------

import type { EpgIndex, EpgProgram, IptvChannel } from "./types";

/** Resolve the program list for `channel`, or null when no usable EPG
 *  row exists. `sharedTvgIds` = tvg-ids used by MORE than one channel
 *  in the playlist (precompute once with `findSharedTvgIds`). */
export function resolveChannelEpg(
  channel: IptvChannel,
  epg: EpgIndex,
  sharedTvgIds: Set<string>,
): EpgProgram[] | null {
  const id = channel.tvgId.trim();
  if (!id) return null;
  const programs = epg.byChannel.get(id);
  if (!programs || programs.length === 0) return null;

  // Unambiguous id → trust it.
  if (!sharedTvgIds.has(id)) return programs;

  // Ambiguous id → require token overlap between the channel name and
  // the id so only the variant the id was actually minted for matches.
  const nameTokens = tokens(channel.name);
  const idTokens = tokens(id.replace(/\.[a-z]{2,3}$/i, "")); // drop ".uk"/".us"
  if (idTokens.size === 0) return programs;
  for (const t of idTokens) {
    if (nameTokens.has(t)) return programs;
  }
  return null;
}

/** tvg-ids assigned to more than one channel in the playlist. */
export function findSharedTvgIds(channels: IptvChannel[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const ch of channels) {
    const id = ch.tvgId.trim();
    if (!id) continue;
    if (seen.has(id)) shared.add(id);
    else seen.add(id);
  }
  return shared;
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
  );
}
