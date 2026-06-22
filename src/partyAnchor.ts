// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// partyAnchor — shared positioning helper for the Watch-Together surfaces that
// spawn FROM the party affordance: the PartyToast stack and the
// WatchTogetherPanel. Both anchor to whichever party button is currently on
// screen — the home/browse PartyButton (top-left) or the in-player presence
// cluster (top-right). Both carry `data-party-anchor`; exactly one is laid out
// at a time (the other goes display:none under the playback `hidden` class).
//
// Keeping the lookup in one place means the toast and the panel always agree
// on where "the party" lives, so the panel grows out of the same icon the
// toasts emerge from.
// ---------------------------------------------------------------------------

export type PartyAnchor =
  | { side: "left"; top: number; left: number }
  | { side: "right"; top: number; right: number };

/** Derive a `PartyAnchor` from a trigger's box: seat the surface a hair BELOW
 *  the icon (so it reads as hanging from it) and pick the side by which half of
 *  the screen the icon's center sits in — a left-half icon hugs its left edge
 *  and grows rightward (into the screen), a right-half icon hugs its right edge
 *  and grows leftward. That flip is what keeps the surface on-screen
 *  horizontally; consumers clamp the vertical extent against `top`.
 *  Shared by `readPartyAnchor` (party surfaces) and the AccountButton popover. */
export function anchorFromRect(r: DOMRect): PartyAnchor {
  const center = r.left + r.width / 2;
  const top = Math.round(r.bottom + 10);
  if (center < window.innerWidth / 2) {
    return { side: "left", top, left: Math.round(r.left) };
  }
  return { side: "right", top, right: Math.round(window.innerWidth - r.right) };
}

/** Locate the visible party affordance and derive where + which way to spawn.
 *  Multiple `[data-party-anchor]` nodes can exist (the PartyButton stays in the
 *  DOM but goes display:none during playback) — pick the first with a real box;
 *  fall back to the top-right corner if none is laid out yet. */
export function readPartyAnchor(): PartyAnchor {
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-party-anchor]"));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return anchorFromRect(r);
  }
  return { side: "right", top: 70, right: 16 };
}
