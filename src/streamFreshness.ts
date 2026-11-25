// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// How old a stream url may be when it is played.
//
// An addon url is not a fixed address. AIOStreams' proxy token never expires,
// and every request to it (mpv's header read, its Cues seek, each cluster read,
// each reconnect) re-runs the debrid lookup and, when it is on, the failover
// chain. Past its caches (the resolved link 1 h, the episode's metadata and the
// failover chain 1 day) two requests for one url can be answered from two
// different releases: a url held for a day in a Next-Up pick played H.264 +
// FLAC packets under an HEVC + EAC3 header and never showed a frame. Fetching
// the stream list again refreshes all of that upstream state, so a source whose
// url is older than this is read again before it plays (handlePlayStream), and
// while that re-read runs the play is pending (LinkRefreshPending below).
//
// Import-free so a node check can load it.

/** 2 h. The danger grows with age: past AIOStreams' 1-day metadata the file
 *  is chosen by size alone, and a debrid link from hours ago may be gone. A
 *  re-read costs a full fan-out (seconds, shown as a toast and a pending
 *  stream row) before the player opens, so the limit sits above the gap between a Next-Up
 *  pick (made halfway through an episode) and the advance on any normal
 *  episode, and catches a pick or a list held across a long hide. */
export const STREAM_URL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** True when `stream` carries a read time and its url is older than the
 *  limit. A read time in the future (a clock set back since) counts as old:
 *  its age cannot be known. Entries with no read time (built in the frontend)
 *  are never called stale. */
export function isStaleStreamUrl(
  stream: { resolved_at_ms?: number | null; url?: string | null },
  nowMs: number,
): boolean {
  const at = stream.resolved_at_ms;
  if (!stream.url || typeof at !== "number" || !Number.isFinite(at) || at <= 0) return false;
  const age = nowMs - at;
  return age > STREAM_URL_MAX_AGE_MS || age < -60_000;
}

/** The row of a freshly read list that is the SAME source as `pick`
 *  (`same`: SourceSwitcher's sameStreamSource, info hash else addon +
 *  filename), or null. A pick with a url only takes a row with a url: one
 *  release can come back as a debrid row and a P2P row (no url, an info hash
 *  the bridge answers 501), and the P2P row may sort first once the debrid
 *  copy went uncached. Among the rest, a row with the pick's exact title wins:
 *  the title carries the service tag, so the same file on another debrid
 *  service is the fallback, not the first choice. */
export function pickRefreshedSource<T extends { url?: string | null; title?: string | null }>(
  rows: readonly T[],
  pick: T,
  same: (row: T, pick: T) => boolean,
): T | null {
  const candidates = rows.filter((r) => same(r, pick) && (!pick.url || !!r.url));
  return candidates.find((r) => r.title === pick.title) ?? candidates[0] ?? null;
}

/** A play that is re-reading an old link: the title it is for and which
 *  source. While one is in flight, the control that started it shows it is
 *  working and a repeat of the SAME play is ignored (every click used to
 *  start another full fan-out); any other play supersedes it. */
export interface LinkRefreshPending {
  targetId: string;
  key: string;
}

/** The source identity `LinkRefreshPending.key` holds: the addon, the info
 *  hash (else the filename) and the whole title, else the url when there is
 *  neither. The title is always part of it: one file comes back as several
 *  rows of one addon (another debrid service, a P2P row with the same hash),
 *  told apart only by the title, and a name's first line ("[RD+]",
 *  "Torrentio") is shared by every row. Kept in memory only, never logged
 *  (a url carries tokens). */
export function linkRefreshKey(s: {
  addon_name?: string | null;
  info_hash?: string | null;
  filename?: string | null;
  title?: string | null;
  url?: string | null;
}): string {
  const id = s.info_hash || s.filename || "";
  const title = (s.title ?? "").trim();
  return `${s.addon_name ?? ""}\n${id}\n${title || (id ? "" : s.url ?? "")}`;
}

/** True when a play of `stream` for `targetId` repeats the refresh in flight. */
export function repeatsLinkRefresh(
  pending: LinkRefreshPending | null,
  targetId: string,
  stream: Parameters<typeof linkRefreshKey>[0],
): boolean {
  return !!pending && pending.targetId === targetId && pending.key === linkRefreshKey(stream);
}
