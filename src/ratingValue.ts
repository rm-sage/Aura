// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** True when a rating value string is worth showing as a tile.
 *
 *  Rejects empty/whitespace, explicit "no data" tokens, and any value
 *  whose numeric content is zero. The Letterboxd "0.0" the MDBList
 *  branch emits for a series/anime it has no movie data for is the
 *  canonical junk case. A real score (8.1/10, 94%, rank #42) always
 *  carries a non-zero leading number, so first-number-is-zero is a
 *  safe reject. Shared by DetailView and CatalogHoverCard so the two
 *  rating strips stay in lock-step. */
export function hasUsableRating(value: string | null | undefined): boolean {
  if (value == null) return false;
  const v = value.trim();
  if (v === "") return false;
  if (/^(n\/?a|tbd|null|undefined|[-–—])$/i.test(v)) return false;
  const m = v.match(/-?\d+(?:\.\d+)?/);
  if (m && Number(m[0]) === 0) return false;
  return true;
}
