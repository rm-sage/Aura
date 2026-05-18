// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// catalogHoverStore — singleton driving the Kai-style mini-meta panel that
// pops up when a catalog card is hovered.
//
// A SINGLE central host (CatalogHoverHost, mounted once in App) renders the
// panel, instead of one popup per card. That's what lets the popup stay open
// while the cursor travels OFF the card and ONTO the popup (and back): the
// card schedules open/close, the popup cancels the pending close on its own
// mouseenter. Open is delayed (hover intent) so a fast mouse sweep across a
// row doesn't fire a burst of meta fetches; close is delayed (leeway) so the
// card→popup gap doesn't dismiss it. Update pattern mirrors
// releaseSignalStore / manualWatched (useSyncExternalStore).
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import type { MetaPreview } from "./types";

export interface HoverTarget {
  meta: MetaPreview;
  /** The hovered card element. Retained so scroll/resize can RE-ANCHOR
   *  the panel to the card's current box instead of closing the popup
   *  (the popup only closes when the cursor leaves the card / panel). */
  el: HTMLElement;
  /** Viewport rect of the card. Recomputed from `el` on scroll/resize
   *  so the panel tracks the card while the cursor still hovers it. */
  rect: DOMRect;
}

let active: HoverTarget | null = null;
let version = 0;
const listeners = new Set<() => void>();
let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

// Hover-intent open delay + close leeway. 450 ms is long enough that
// sweeping the cursor across a 10-card row doesn't trigger ten fetches,
// short enough to feel responsive on a deliberate hover.
const OPEN_DELAY_MS = 450;
const CLOSE_DELAY_MS = 220;

function emit(): void {
  version += 1;
  for (const fn of listeners) fn();
}
function clearOpen(): void {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
}
function clearClose(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

/** Card pointer-enter: arm a delayed open (replaces any pending close).
 *  Takes the card element (not a snapshot rect) so the rect is captured
 *  fresh when the open actually fires, and so scroll/resize can later
 *  re-anchor to its live box. */
export function scheduleHoverOpen(meta: MetaPreview, el: HTMLElement): void {
  clearClose();
  clearOpen();
  openTimer = setTimeout(() => {
    openTimer = null;
    active = { meta, el, rect: el.getBoundingClientRect() };
    emit();
  }, OPEN_DELAY_MS);
}

/** Card pointer-leave before the open fired — abort the pending open. */
export function cancelHoverOpen(): void {
  clearOpen();
}

/** Card OR popup pointer-leave: arm a delayed close (the leeway). */
export function scheduleHoverClose(): void {
  clearOpen();
  clearClose();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    active = null;
    emit();
  }, CLOSE_DELAY_MS);
}

/** Popup (or re-entered card) pointer-enter — keep it open. */
export function cancelHoverClose(): void {
  clearClose();
}

/** Hard close — card click, route change. */
export function closeHoverNow(): void {
  clearOpen();
  clearClose();
  if (active) {
    active = null;
    emit();
  }
}

// While the cursor is over the popup itself, the user is reading it:
// scroll/resize must NOT re-anchor (that would slide the panel out
// from under the cursor) and must NOT close it. The panel toggles this
// on its own pointer enter/leave.
let pointerInPanel = false;
export function notePanelPointer(inside: boolean): void {
  pointerInPanel = inside;
}

// Scroll / resize handler. Instead of closing (the old behaviour the
// user disliked), re-anchor the panel to the card's CURRENT box so it
// stays glued while the cursor still hovers the card. The only things
// that close it now are leaving the card/panel (existing
// scheduleHoverClose) or the card scrolling out of the viewport /
// unmounting. rAF-coalesced — scroll fires hot.
let rafPending = false;
export function refreshHoverAnchor(): void {
  if (!active || pointerInPanel || rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const cur = active;
    if (!cur || pointerInPanel) return;
    const el = cur.el;
    if (!el || !el.isConnected) { closeHoverNow(); return; }
    const r = el.getBoundingClientRect();
    // Card scrolled fully out of view → nothing to anchor to.
    if (r.bottom <= 0 || r.top >= window.innerHeight ||
        r.right <= 0 || r.left >= window.innerWidth) {
      closeHoverNow();
      return;
    }
    active = { ...cur, rect: r };
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Host hook — re-renders the host when the active hover target changes. */
export function useHoverTarget(): HoverTarget | null {
  void useSyncExternalStore(subscribe, () => version, () => version);
  return active;
}
