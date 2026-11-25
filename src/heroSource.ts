// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// heroSource: WHICH list the Home hero shows, decided once per row build.
//
// Pure and import-free, so a node check can load it directly.
//
// Why it exists (the "hero cycles through slides on load" report): the hero
// used to take its items from "the first row with items" on every render and
// was keyed on that row, so it remounted at a new slide 0 (new art, a new
// palette, a new bleed and underglow) every time that row changed while Home
// loaded:
//
//   1. Rows answer in COMPLETION order (four catalog requests in flight), so
//      row 2 filling before row 0 put row 2's first slide up, then row 0's.
//   2. Every rebuild of the row list (a new `addons` array: the cached list
//      at warm start, then the account sync's copy; a manifest refresh; a
//      settings tick) set the rows to [] first, which unmounted the hero
//      (and its bleed), then mounted it again once a row refilled.
//   3. A pinned hero catalog showed the first row's items until its own
//      fetch answered, then swapped.
//
// The rules:
//
//   - The default source is the first row with items, decided only once
//     every row BEFORE it has answered (or after HERO_SETTLE_MS since the
//     first row with items, so one slow addon cannot hold the hero for a
//     whole request timeout). A walked row (pending again after a failed
//     hero-walk request) counts as answered.
//   - One build, one hero: once a source is latched for a row build, a later
//     answer in that build never replaces it.
//   - While a build is not decided yet (a rebuild in flight) the latched
//     source stays up. A new build's decision replaces it, keeping the SAME
//     object (no remount, no state change) when it is the same row with the
//     same titles.
//   - A pinned catalog shows nothing until its own answer arrives; the
//     first row never stands in for it.
// ---------------------------------------------------------------------------

/** How long after the first row with items an earlier row still in flight
 *  may hold the hero back. Past it the first row with items wins and stays
 *  for the build, even if an earlier row fills later. */
export const HERO_SETTLE_MS = 1200;

export type HeroRowStatus = "pending" | "ok" | "failed";

export interface HeroRowLike<T> {
  key: string;
  gen: number;
  status: HeroRowStatus;
  walked?: boolean;
  items: readonly T[];
}

/** The settled default source of a row build: the row, `null` for "this
 *  build has no hero" (every row answered and none has items), or
 *  `undefined` for "not decided yet" (an earlier row may still fill). */
export function settledHeroRow<R extends HeroRowLike<unknown>>(
  rows: readonly R[],
  graceOver: boolean,
): R | null | undefined {
  for (const r of rows) {
    if (r.items.length > 0) return r;
    if (r.status === "pending" && !r.walked && !graceOver) return undefined;
  }
  return rows.some((r) => r.status === "pending" && !r.walked) ? undefined : null;
}

export interface HeroSource<T> {
  /** Carousel identity: the row key, or `pinned:<catalog>`. */
  key: string;
  /** The row build it was decided in (-1 for a pinned catalog or a source
   *  carried over from an earlier Home mount, which no build matches). */
  gen: number;
  pinned: boolean;
  label: string | null;
  items: readonly T[];
}

/** `undefined` = not decided yet (keep what is shown), `null` = no hero. */
export type HeroCandidate<T> = HeroSource<T> | null | undefined;

function sameIds<T extends { id: string }>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
  return true;
}

/** The source to show next. Returns `prev` itself whenever nothing the
 *  carousel shows would change, so a caller can compare by identity (and
 *  setting it during render converges in one pass). */
export function nextHeroSource<T extends { id: string }>(
  prev: HeroSource<T> | null,
  cand: HeroCandidate<T>,
): HeroSource<T> | null {
  if (cand === undefined) return prev;
  if (cand === null) return null;
  if (!prev) return cand;
  // One build, one hero.
  if (!prev.pinned && !cand.pinned && prev.gen === cand.gen) return prev;
  if (prev.key === cand.key && sameIds(prev.items, cand.items)) {
    if (prev.gen === cand.gen && prev.pinned === cand.pinned && prev.label === cand.label) return prev;
    // Same slides: keep the items array itself (no re-render of the slides).
    return { ...prev, gen: cand.gen, pinned: cand.pinned, label: cand.label };
  }
  return cand;
}
