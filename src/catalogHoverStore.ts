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
// card→popup gap doesn't dismiss it. While the panel is already up (or
// was a moment ago) moving to another card switches sooner, since the
// user is browsing with it open; see SWITCH_DELAY_MS. Update pattern mirrors
// releaseSignalStore / manualWatched (useSyncExternalStore).
//
// A panel that covers other cards lets the pointer through to them
// (CatalogHoverCard's `covers`), so the card under it can still be hovered.
// Holding Alt FREEZES it instead (setHoverFrozen): it takes the pointer and
// ignores the cards, so it can be reached across them. What the cards asked for
// meanwhile is kept, last request winning, and applied on release.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import type { MetaPreview } from "./types";
import { loadAuraSettings } from "./auraSettings";

export interface HoverTarget {
  meta: MetaPreview;
  /** The hovered card element. Retained so scroll/resize can RE-ANCHOR
   *  the panel to the card's current box instead of closing the popup
   *  (the popup only closes when the cursor leaves the card / panel). */
  el: HTMLElement;
  /** Viewport rect of the card. Recomputed from `el` on scroll/resize
   *  so the panel tracks the card while the cursor still hovers it. */
  rect: DOMRect;
  /** Where the cursor entered the card, which says which way it was going.
   *  Absent when the panel was not opened by a hover. */
  entry?: { x: number; y: number } | null;
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
// Once the panel is up the user is browsing WITH it, so the full intent
// delay is just lag: moving from one card to its neighbour waited 450 ms
// before the panel followed. A switch fires after SWITCH_DELAY_MS instead.
// It stays above a card's crossing time on a normal sweep (well under
// 150 ms per poster), so cards merely crossed still never fetch.
const SWITCH_DELAY_MS = 240;
// A card entered within SWEEP_GAP_MS of the previous one means the cursor
// is travelling across the grid rather than settling, so the switch waits
// a little longer for it to come to rest. The timer restarts on every
// enter, so this only decides how long the RESTING card waits.
const SWEEP_GAP_MS = 140;
const SWEEP_DELAY_MS = 380;
// A hover close that happened this recently still counts as "the panel is
// up": crossing a gutter between two cards closes it (the close leeway is
// shorter than a slow gutter crossing), and the next card should not then
// pay the full cold-open delay.
const WARM_AFTER_CLOSE_MS = 400;

let lastEnterAt = -Infinity;
let lastHoverCloseAt = -Infinity;

interface OpenRequest {
  kind: "open";
  meta: MetaPreview;
  el: HTMLElement;
  entry: HoverTarget["entry"];
}

let frozen = false;
/** What the cards asked for while frozen. */
let deferred: OpenRequest | { kind: "close" } | null = null;
/** The arguments of the open timer now running, to carry it into a freeze. */
let pendingOpen: OpenRequest | null = null;

function emit(): void {
  version += 1;
  for (const fn of listeners) fn();
}
function clearOpen(): void {
  if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  pendingOpen = null;
}
function clearClose(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

/** Card pointer-enter: arm a delayed open (replaces any pending close).
 *  Takes the card element (not a snapshot rect) so the rect is captured
 *  fresh when the open actually fires, and so scroll/resize can later
 *  re-anchor to its live box. */
export function scheduleHoverOpen(meta: MetaPreview, el: HTMLElement, entry?: HoverTarget["entry"]): void {
  if (frozen) {
    deferred = { kind: "open", meta, el, entry };
    return;
  }
  clearClose();
  clearOpen();
  const now = performance.now();
  const sweeping = now - lastEnterAt < SWEEP_GAP_MS;
  lastEnterAt = now;
  // Back onto the card whose panel is already up (the cursor went to the
  // panel or a gutter and returned): nothing to switch to. Re-anchor at
  // once instead of re-opening after a delay, since the card may have
  // scrolled while the cursor sat on the panel (no re-anchor then). The id
  // check covers a windowed grid that reuses one element for another title.
  if (active && active.el === el && active.meta.id === meta.id) {
    const r = el.getBoundingClientRect();
    const a = active.rect;
    if (r.left !== a.left || r.top !== a.top || r.width !== a.width || r.height !== a.height) {
      active = { ...active, rect: r };
      emit();
    }
    return;
  }
  const warm = active != null || now - lastHoverCloseAt < WARM_AFTER_CLOSE_MS;
  const delay = !warm ? OPEN_DELAY_MS : sweeping ? SWEEP_DELAY_MS : SWITCH_DELAY_MS;
  pendingOpen = { kind: "open", meta, el, entry };
  const fire = () => {
    // Still scrolling: this card only passed under a pointer that did not move. Wait
    // for the scroll to settle (src/scrollPause.ts); a real leave cancels this timer.
    if (document.documentElement.hasAttribute("data-aura-scrolling")) {
      openTimer = setTimeout(fire, 120);
      return;
    }
    openTimer = null;
    pendingOpen = null;
    // The card unmounted while waiting (no mouseleave comes from a removed
    // element). A plain return would strand a panel still up on another card:
    // this enter already cleared its close. Same for a context menu that is up:
    // the panel is portalled above the app shell and would cover it.
    if (!el.isConnected || document.querySelector("[data-aura-context-menu]")) {
      scheduleHoverClose();
      return;
    }
    active = { meta, el, rect: el.getBoundingClientRect(), entry };
    emit();
  };
  openTimer = setTimeout(fire, delay);
}

/** Card pointer-leave before the open fired — abort the pending open. */
export function cancelHoverOpen(): void {
  if (deferred?.kind === "open") deferred = null;
  clearOpen();
}

/** Card OR popup pointer-leave: arm a delayed close (the leeway).
 *
 *  No-op in the non-hover activation modes ("button" / "hold"): there the
 *  panel is opened/dismissed explicitly (bound-button toggle, long-press,
 *  click-outside, Esc, scroll-out), and the card has no onMouseEnter to
 *  cancel this timer — so honouring a panel/card pointer-leave here would
 *  self-close the panel the moment the user moves onto it to read and back.
 *  `loadAuraSettings()` is memoized and cache-busted on change, so cheap. */
export function scheduleHoverClose(): void {
  if (loadAuraSettings().metaPanelActivation !== "hover") return;
  if (frozen) {
    deferred = { kind: "close" };
    return;
  }
  clearOpen();
  clearClose();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (active) lastHoverCloseAt = performance.now();
    active = null;
    emit();
  }, CLOSE_DELAY_MS);
}

/** Popup (or re-entered card) pointer-enter — keep it open. */
export function cancelHoverClose(): void {
  if (deferred?.kind === "close") deferred = null;
  clearClose();
}

/** Alt held / released while the panel is up. A held panel stays where it is
 *  and takes the pointer, whatever the cursor crosses on the way to it. */
export function setHoverFrozen(on: boolean): void {
  if (on === frozen || (on && !active)) return;
  frozen = on;
  if (on) {
    // Whatever was about to happen still happens, on release.
    deferred = pendingOpen ?? (closeTimer ? { kind: "close" } : null);
    clearOpen();
    clearClose();
    emit();
    return;
  }
  const d = deferred;
  deferred = null;
  emit();
  if (d?.kind === "open") scheduleHoverOpen(d.meta, d.el, d.entry);
  else if (d?.kind === "close") scheduleHoverClose();
}

/** Hard close — card click, route change. */
export function closeHoverNow(): void {
  clearOpen();
  clearClose();
  frozen = false;
  deferred = null;
  if (active) {
    active = null;
    emit();
  }
}

/** Open the panel IMMEDIATELY (no hover-intent delay). Used by the
 *  optional mouse-button bind, where the open is an explicit user
 *  action rather than a hover so the 450 ms intent delay is wrong. */
export function openHoverNow(meta: MetaPreview, el: HTMLElement): void {
  if (!el.isConnected) return;
  clearClose();  // order mirrors scheduleHoverOpen's idiom (immaterial: independent timers)
  clearOpen();
  active = { meta, el, rect: el.getBoundingClientRect() };
  emit();
}

/** Bind pressed on a card: open it, or close if THAT card's panel is
 *  already open (press-again-to-dismiss). Identity is by element, so
 *  two cards sharing a meta id still toggle independently. */
export function toggleHoverNow(meta: MetaPreview, el: HTMLElement): void {
  if (active && active.el === el) {
    closeHoverNow();
  } else {
    openHoverNow(meta, el);
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

/** Panel hook: is Alt holding the panel? */
export function useHoverFrozen(): boolean {
  return useSyncExternalStore(subscribe, () => frozen, () => frozen);
}

/** Host hook — re-renders the host when the active hover target changes. */
export function useHoverTarget(): HoverTarget | null {
  void useSyncExternalStore(subscribe, () => version, () => version);
  return active;
}
