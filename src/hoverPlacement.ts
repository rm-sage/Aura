// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// hoverPlacement: which side of its card the mini-meta panel opens on. Pure and
// import-free, so a node check can load it; CatalogHoverCard does the measuring.
//
// In order: a side that does not fit is out. A side that covers no other card
// wins. A side covering clearly less wins. Otherwise both sides cover something
// (a card mid-row) and no placement is clear, so the panel goes BEHIND the
// cursor's travel: entering a card from the left puts it on the left, and the
// next card along the way stays uncovered. Decided once per card and never
// flipped while on it: a panel that dodged the cursor live could not be reached.
// ---------------------------------------------------------------------------

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A card covered by less than this fraction is still usable: a side-placed
 *  panel is taller than a poster, so it clips the rows above and below. */
export const MIN_COVER = 0.15;
/** How many cards' worth one side must cover less by to win outright. */
const CLEARLY_LESS = 0.5;

/** How much of `card` the panel covers, 0 to 1. Under MIN_COVER counts as 0. */
export function coverOf(panel: Box, card: Box): number {
  const w = Math.min(panel.right, card.right) - Math.max(panel.left, card.left);
  const h = Math.min(panel.bottom, card.bottom) - Math.max(panel.top, card.top);
  if (w <= 0 || h <= 0) return 0;
  const area = (card.right - card.left) * (card.bottom - card.top);
  if (area <= 0) return 0;
  const f = (w * h) / area;
  return f < MIN_COVER ? 0 : f;
}

export function pickPanelSide(o: {
  fitsLeft: boolean;
  fitsRight: boolean;
  /** Cards' worth covered on each side (the sum of `coverOf`). */
  coverLeft: number;
  coverRight: number;
  card: Box;
  /** Where the cursor entered the card; null when it was not a hover. */
  entry: Point | null;
  /** The side the panel is on now, when it is moving from another card. */
  prevSide: "left" | "right" | "center" | null;
}): "left" | "right" {
  const { fitsLeft, fitsRight, coverLeft, coverRight, card, entry, prevSide } = o;
  if (!fitsLeft || !fitsRight) return fitsLeft ? "left" : "right";

  if (coverLeft === 0 && coverRight === 0) return "right";
  if (coverLeft === 0) return "left";
  if (coverRight === 0) return "right";
  if (Math.abs(coverLeft - coverRight) >= CLEARLY_LESS) {
    return coverLeft < coverRight ? "left" : "right";
  }

  const kept = prevSide === "left" || prevSide === "right" ? prevSide : null;
  if (!entry) return kept ?? "right";
  const fromSide = Math.min(entry.x - card.left, card.right - entry.x);
  const fromEnd = Math.min(entry.y - card.top, card.bottom - entry.y);
  // Came in through the top or bottom: moving along a column, so nothing says
  // which neighbour is next. Staying put saves a glide across the cursor.
  if (fromEnd < fromSide && kept) return kept;
  return entry.x < (card.left + card.right) / 2 ? "left" : "right";
}
