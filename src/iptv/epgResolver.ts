// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EPG resolver (Live TV spec §1) — joins a channel to its EPG program
// list. Primary key is tvg-id; when several channels share one tvg-id
// (a common provider sloppiness: regional variants all stamped with the
// national id), a token-overlap guard demands the channel NAME also
// resemble the id before trusting the join, so "ESPN 2" doesn't show
// "ESPN" programming just because both carry tvg-id="espn.us".
//
// FALLBACK: when the tvg-id matches no EPG channel id at all — the common
// case when a playlist and an EPG come from different sources and use
// different id schemes (e.g. iptv-org streams + a third-party XMLTV) — we
// fall back to matching the channel's NAME against the EPG's
// `<display-name>` index (built in xmltv.ts, with ambiguous names already
// dropped). This is what turns an "empty guide" into a populated one when
// the ids don't line up.
// ---------------------------------------------------------------------------

import type { EpgIndex, EpgProgram, IptvChannel } from "./types";
import { normalizeChannelName } from "./xmltv";

/** Resolve the program list for `channel`, or null when no usable EPG
 *  row exists. `sharedTvgIds` = tvg-ids used by MORE than one channel
 *  in the playlist (precompute once with `findSharedTvgIds`). */
export function resolveChannelEpg(
  channel: IptvChannel,
  epg: EpgIndex,
  sharedTvgIds: Set<string>,
): EpgProgram[] | null {
  const id = channel.tvgId.trim();
  if (id) {
    const programs = epg.byChannel.get(id);
    if (programs && programs.length > 0) {
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
      // Token guard failed — fall through to the name-based fallback rather
      // than returning the (likely-wrong) ambiguous match.
    }
  }

  // Fallback: normalized channel name → EPG display-name → channel id.
  const nameKey = normalizeChannelName(channel.name);
  if (nameKey) {
    const mappedId = epg.nameToId.get(nameKey);
    if (mappedId) {
      const programs = epg.byChannel.get(mappedId);
      if (programs && programs.length > 0) return programs;
    }
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
