// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useRef, useState } from "react";

/** Mount / enter / exit for a card animated by an inline CSS transition
 *  between a collapsed style (`visible` false) and its open style.
 *
 *  The collapsed style is resolved ON THE MOUNTED CARD (a forced style read)
 *  before `visible` flips, in the same pre-paint pass. A double rAF started in
 *  the effect that requested the mount counted its frames from the REQUEST, not
 *  from the card reaching the DOM: when the deferred mount render landed after
 *  the second frame, React batched the mount and the flip into one commit, the
 *  card's first style was already the open one and the transition was skipped
 *  (the panel appeared at once). State set in a layout effect re-renders
 *  synchronously before paint, so the first painted frame is frame 1 of the
 *  transition, and there are no rAF handles left to leak on a fast close.
 *
 *  Reopening mid-exit reverses from the current style (the exit timer is
 *  cleared and `render` never went false).
 *
 *  A caller that also needs state set on open (an anchor snapshot) declares that
 *  layout effect BEFORE calling this hook, so it batches into the same sync
 *  render as the mount. Attach `ref` to the transitioned card. */
export function usePopPresence<T extends HTMLElement>(open: boolean, exitMs: number) {
  const ref = useRef<T | null>(null);
  const [render, setRender] = useState(open);
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    setVisible(false);
    const t = window.setTimeout(() => setRender(false), exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);

  useLayoutEffect(() => {
    if (!open || !render) return;
    const el = ref.current;
    if (!el) return;
    // Commit the collapsed (or mid-exit) style as the transition's start. One
    // forced style + layout pass per open: never copy this into per-frame code.
    void el.offsetHeight;
    setVisible(true);
  }, [open, render]);

  return { ref, render, visible };
}
