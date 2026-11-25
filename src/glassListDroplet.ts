// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// useListDroplet: Liquid's shared hover droplet for a vertical list of rows
// (the recents dropdown, listboxes, pickers). One soft raised face
// (`.aura-glass-hl`) that slides between the rows under the pointer on the
// liquidGlass spring, instead of each row painting its own hover fill (App.css
// drops that fill inside a [data-glass-droplet] list in Liquid). The same
// pattern as NavSidebar's useRailDroplet, for any row selector.
//
// Usage: spread `listProps` on the list container (it must be
// position: relative and hold the rows), render
// `<span ref={ref} aria-hidden className="aura-glass-hl ..." />` as its FIRST
// child, and give each row `.aura-glass-row` (or the selector passed in).
//
// Inert in Frosted (rows keep their own hover fill there). Event driven: one
// rect pair per row CHANGE, nothing per frame and no listener of its own (React
// handlers on the container), so there is nothing to clean up beyond stopping
// a spring in flight on unmount.

import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { animateSpan, cancelSpan } from "./liquidGlass";
import { liquidActive } from "./glassStyle";

const SELECTED = '[aria-selected="true"], [aria-current="page"], [aria-current="true"], [aria-pressed="true"], [aria-checked="true"], .is-selected';

export function useListDroplet<T extends HTMLElement = HTMLDivElement>(rowSelector = ".aura-glass-row") {
  const ref = useRef<HTMLSpanElement>(null);
  const lastRow = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    return () => { if (el) cancelSpan(el); };
  }, []);

  /** Hides the droplet (pointer left, a click, or the rows changed under it). */
  const hide = useCallback(() => {
    lastRow.current = null;
    const hl = ref.current;
    if (!hl) return;
    // Stop a spring in flight where it is, so the fade runs (the flight holds
    // the CSS transitions off) instead of the droplet vanishing mid-move.
    cancelSpan(hl);
    hl.classList.remove("is-on");
  }, []);

  // Armed by the first REAL pointermove over the list. A list that opens (or
  // reflows) under a stationary pointer gets a pointerover from Chromium's
  // layout-driven hover re-test with no pointermove; lighting a row then shows
  // a highlight the user never pointed at. Never reset by hide().
  const moved = useRef(false);

  const track = useCallback((e: React.PointerEvent<T>) => {
    const hl = ref.current;
    if (!hl || !liquidActive()) return;
    const row = (e.target as Element).closest<HTMLElement>(rowSelector);
    if (!row || !e.currentTarget.contains(row)) return;
    if (row === lastRow.current) return;
    // A selected row already wears the raised face: no droplet over it.
    if (row.matches(SELECTED)) { hide(); return; }
    const box = e.currentTarget.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // Rects are in screen space, the span's translate is in the list's own
    // unscaled space: during an opening scale (Detail page, SeasonSelect pop)
    // divide the scale back out, or the droplet lands on the wrong row.
    const k = box.height > 0 ? e.currentTarget.offsetHeight / box.height : 1;
    const a = (r.top - box.top) * k + e.currentTarget.scrollTop;
    animateSpan(hl, "y", { a, b: a + r.height * k },{ snap: !hl.classList.contains("is-on"), spring: "hover" });
    hl.classList.add("is-on");
    lastRow.current = row;
  }, [rowSelector, hide]);

  const onPointerOver = useCallback((e: React.PointerEvent<T>) => {
    if (!moved.current) return;
    track(e);
  }, [track]);

  // Only the FIRST move tracks (it lights the row the pointer is resting on);
  // after that pointerover drives every row change, as before, so a row that
  // was hidden by a click stays dark until the pointer reaches another row.
  const onPointerMove = useCallback((e: React.PointerEvent<T>) => {
    if (moved.current) return;
    moved.current = true;
    track(e);
  }, [track]);

  return {
    ref,
    hide,
    listProps: {
      "data-glass-droplet": "",
      onPointerOver,
      onPointerMove,
      onPointerLeave: hide,
      onClick: hide,
    },
  };
}
