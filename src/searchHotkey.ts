// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// searchHotkey: Ctrl+F focuses the search box on screen, and WebView2's native
// find bar never opens. A search box opts in with the `data-aura-search`
// attribute on its <input>; nothing else registers, so a page costs no listener.
//
// Pages stay MOUNTED under the detail page, login overlays and dialogs, so
// being in the DOM says nothing. A box takes the key only if it is what is
// really on top at its own position, else the keystrokes after it would filter
// a hidden page and useKeybindings would go deaf behind a focused input. A page
// that has been scrolled past its box (Library, Queue) scrolls back to it, but
// only if that page is itself on top.
//
// Installed from main.tsx before React mounts, beside the contextmenu
// suppressor. Popup webviews load external pages, so they get the same block
// from an init script (POPUP_NO_FIND_SCRIPT, scrobble_auth.rs). Do not switch
// this to WebView2's AreBrowserAcceleratorKeysEnabled: that also kills F5 and
// the other browser keys.
// ---------------------------------------------------------------------------

import { isChordBound } from "./useKeybindings";

const SEARCH_INPUT = "input[data-aura-search]:not(:disabled)";

/** e.key is the layout's character (Cyrillic on a Russian layout) while Chromium's
 *  accelerators read the virtual key, so accept either. Not e.code: on Dvorak the
 *  physical KeyF is not the F the accelerator reads. */
function isLetter(e: KeyboardEvent, letter: string, virtualKey: number): boolean {
  return e.key.toLowerCase() === letter || e.keyCode === virtualKey;
}

/** The keys that open or drive the native find bar. */
function isNativeFindKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.altKey) return false;
  if (e.key === "F3") return !e.ctrlKey;
  if (!e.ctrlKey) return false;
  return isLetter(e, "g", 71) || (isLetter(e, "f", 70) && !e.shiftKey);
}

/** The topmost element at a point, looking through the hover panel and the
 *  Performance Monitor: they float over a page without being what its user is on. */
function topAt(x: number, y: number): Element | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest("[data-hover-panel], [data-perf-monitor]")) return el;
  }
  return null;
}

function isOnTop(input: HTMLElement): boolean {
  const r = input.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return topAt(r.left + r.width / 2, r.top + r.height / 2) === input;
}

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** Bring a box that is only scrolled away back into view. Checked BEFORE it
 *  scrolls, so a page hidden under an overlay is never moved behind it. */
function scrollBackTo(input: HTMLElement): boolean {
  const page = scrollParentOf(input);
  if (!page) return false;
  const r = page.getBoundingClientRect();
  const x = (Math.max(r.left, 0) + Math.min(r.right, window.innerWidth)) / 2;
  const y = (Math.max(r.top, 0) + Math.min(r.bottom, window.innerHeight)) / 2;
  const hit = topAt(x, y);
  if (!hit || !page.contains(hit)) return false;
  input.scrollIntoView({ block: "center" });
  return isOnTop(input);
}

function focusSearch(): void {
  const active = document.activeElement;
  const focused = active instanceof HTMLInputElement && active.matches(SEARCH_INPUT) ? active : null;
  if (focused && isOnTop(focused)) {
    focused.select();
    return;
  }
  // Last in DOM order first: a panel portalled to the body sits over the page.
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(SEARCH_INPUT)).reverse();
  const box = boxes.find(isOnTop) ?? boxes.find(scrollBackTo);
  if (!box) {
    // Covered by something with no box of its own: give the keys back to it.
    focused?.blur();
    return;
  }
  box.focus();
  box.select();
}

export function installSearchHotkey(): void {
  // Capture, and only preventDefault: this is what stops the find bar, so it
  // must run whatever a later handler does with the event. It does not stop
  // the key either, so a chord the user bound to F3 or Ctrl+G still works.
  window.addEventListener("keydown", (e) => {
    if (isNativeFindKey(e)) e.preventDefault();
  }, { capture: true });

  // Bubble: Settings' key capture stops the event at the window's capture phase
  // while a row is recording, so recording Ctrl+F does not also focus a box. A
  // user's own Ctrl+F keybinding wins over the search too.
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return;
    if (!isLetter(e, "f", 70) || isChordBound(e)) return;
    focusSearch();
  });
}
