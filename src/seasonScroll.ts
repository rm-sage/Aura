// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// seasonScroll.ts: where an episode list or arc grid lands when it is opened.
//
// A season pick swaps the rows inside one scroller, which keeps its scrollTop, so
// without this the bottom of S01 opens as the bottom of S02. The arc grid and an open
// arc follow the same rule. Import-free so a node check can load it.

/**
 * The row to land on: the latest watched episode, meaning the last one in list order
 * that `isWatched` accepts, the predicate behind the rows' badges. Not the most
 * recently watched: history has times, but a manual mark or a position-implied episode
 * has no row there. Null means the top of the list, for a season with nothing watched
 * and for a fully watched one, since there is nothing left to pick up in either.
 *
 * Unaired episodes count as unwatched, so a season you are caught up on lands on the
 * latest episode you saw, with the next one to air right below it.
 */
export function seasonScrollAnchor(
  episodes: readonly { id: string }[],
  isWatched: (id: string) => boolean,
): string | null {
  let latest: string | null = null;
  let allWatched = true;
  for (const { id } of episodes) {
    if (isWatched(id)) latest = id;
    else allWatched = false;
  }
  return allWatched ? null : latest;
}

/**
 * The same rule for the arc grid: the id of the arc holding the latest watched episode.
 * Null means the top. `episodes` is the show in BROADCAST order, and "latest" is read
 * there rather than by walking the tiles: an arc need not be contiguous or in order.
 * Naruto's "Various Filler" is the last tile and scatters from E101 to E208, so one
 * watched filler would otherwise land on it, past every arc the user has not reached.
 * An episode in two arcs answers with the first, as arcPositionOf does.
 */
export function arcScrollAnchor(
  arcs: readonly { id: string; episode_ids: readonly string[] }[],
  episodes: readonly { id: string }[],
  isWatched: (id: string) => boolean,
): string | null {
  const inArcs = new Set(arcs.flatMap((a) => a.episode_ids));
  const latest = seasonScrollAnchor(episodes.filter((e) => inArcs.has(e.id)), isWatched);
  if (latest === null) return null;
  return arcs.find((a) => a.episode_ids.includes(latest))?.id ?? null;
}
