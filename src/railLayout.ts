// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// railLayout: geometry shared by the left rail (NavSidebar.tsx) and the
// surfaces that open from it or sit near it.
//
// The rail (Direction A, "Obsidian rail") is ONE floating glass surface, 204 px
// wide, 12 px from the window's left edge, centred in the body under the 36 px
// title bar. It is an in-flow flex item of the app body (`flex gap-3 p-3`), so
// the page column starts at 12 + 204 + 12 = 228 px without any page reserving
// that space by hand. Rows inside it (Notifications at the very top, then User
// Panel, Watch Party and the nav) open their popups BESIDE the rail
// (`railAnchorFor`), never over it.
// ---------------------------------------------------------------------------

import { useLayoutEffect, useState, type RefObject } from "react";

/** Clearance under the 36 px TitleBar for chrome panels pinned top-left (the
 *  Downloads panel, the service status popover). Anything above y = 36 covers
 *  the window drag region and breaks drag plus double-click-to-maximize. */
export const CHROME_TOP_PX = 44;
/** Left edge for chrome panels pinned top-left. */
export const CHROME_LEFT_PX = 20;

/** Gap between the rail's right edge and a popup opened from one of its rows. */
export const RAIL_POPUP_GAP_PX = 10;
/** Marks the rail element; popups find it with `closest()`. */
export const RAIL_SELECTOR = "[data-aura-rail]";

/** Where a popup opened from a rail row seats itself: `left` beside the rail,
 *  `top` level with the row's top (a panel that hangs down), `bottom` level
 *  with the row's bottom (from the viewport's bottom edge). `railTop` and
 *  `railBottom` are the rail's own top (from the viewport's top) and bottom
 *  (from the viewport's bottom), so a popup can line up with the whole rail
 *  (the Notifications sheet and bubble sit flush with its top, the sheet down
 *  to its bottom: NotificationsPanel `railPopupTop`). Without a rail they are
 *  the element's own. */
export interface RailAnchor { left: number; top: number; bottom: number; railTop: number; railBottom: number }

/** Anchor for a popup opened from `el`. Inside the rail it sits beside the
 *  rail's right edge; anywhere else beside the element itself. */
export function railAnchorFor(el: Element): RailAnchor {
  const r = el.getBoundingClientRect();
  const rail = el.closest(RAIL_SELECTOR);
  const rr = rail ? rail.getBoundingClientRect() : r;
  return {
    left: Math.round(rr.right + RAIL_POPUP_GAP_PX),
    top: Math.round(r.top),
    bottom: Math.round(window.innerHeight - r.bottom),
    // Unrounded: the rail's box can end on a half pixel, and a popup flush
    // with it must not miss by one.
    railTop: rr.top,
    railBottom: window.innerHeight - rr.bottom,
  };
}

/** Measures `ref`'s rail anchor while `active`, and again on window resize.
 *  A layout effect, so a popup mounting in the same commit seats itself
 *  before its first paint. Nothing runs while inactive. */
export function useRailAnchor(ref: RefObject<Element | null>, active: boolean): RailAnchor {
  const [anchor, setAnchor] = useState<RailAnchor>({ left: 228, top: 120, bottom: 24, railTop: 48, railBottom: 12 });
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const next = railAnchorFor(el);
      setAnchor((prev) =>
        prev.left === next.left && prev.top === next.top && prev.bottom === next.bottom
          && prev.railTop === next.railTop && prev.railBottom === next.railBottom ? prev : next);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active, ref]);
  return anchor;
}
