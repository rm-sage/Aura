// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// menuTracker — the shared "is any player menu open?" counter.
//
// PlayerOverlay freezes its control-bar auto-hide (and swallows the dismissing
// click) while any menu or panel is open. Every menu owns its own `open` state
// and reports transitions through this counter; the overlay just watches the
// total.
//
// This lives in its own module rather than inside PlayerOverlay because panels
// that render as SIBLINGS of the overlay (SubtitleSyncPanel) need the hook too,
// and importing it back out of PlayerOverlay would be a circular import. It
// happens to work (the hook is a hoisted declaration), but only by accident of
// evaluation order, and it is not a thing to rely on.
//
// ANY new menu or panel inside the overlay MUST call `useMenuOpenSync(open)` or
// the control bar will auto-hide out from under it.
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect } from "react";

export interface MenuTracker {
  notify: (delta: 1 | -1) => void;
}

export const MenuTrackerCtx = createContext<MenuTracker | null>(null);

/** Increment/decrement the overlay's open-menu counter as `open` flips. */
export function useMenuOpenSync(open: boolean): void {
  const tracker = useContext(MenuTrackerCtx);
  useEffect(() => {
    if (!tracker) return;
    if (!open) return;
    tracker.notify(1);
    return () => tracker.notify(-1);
  }, [open, tracker]);
}
