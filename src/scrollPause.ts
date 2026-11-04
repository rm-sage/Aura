// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// scrollPause.ts: holds every CSS keyframe animation still while something scrolls.
//
// Aura's decorative loops (the row title sweep, image shimmers, glows) repaint on
// the main thread each frame. Together they took wheel scrolling from 240 fps to
// 50-90 with spikes past 50 ms on the real pages, although none of them matters
// alone and no script was slow. Paused, the same scroll holds 205-235 fps. They are
// slow enough that stopping for the length of a scroll does not read as a stop. The
// rule lives in App.css (`data-aura-scrolling`) and names each loop: flipping an
// attribute that a universal selector hangs off recalculates the whole document.
//
// `scroll` rather than `wheel`: a wheel over the player changes the volume, and only
// real movement should stop anything. Capture phase, because scroll does not bubble.
//
// Only a scroll the user is driving starts it. A list that scrolls itself (the DevConsole
// tail on a burst of logs, a panel centring its current row as it opens) would otherwise
// freeze a slide-in halfway, or hold every animation in the app still for as long as the
// burst lasts. A pause that has started runs until the movement stops, which covers a
// fling and the tail of a wheel spring.

const QUIET_MS = 160;
const INPUT_RECENT_MS = 300;

export function installScrollPause(): () => void {
  const root = document.documentElement;
  let timer: number | null = null;
  let lastScroll = 0;
  let lastInput = -Infinity;
  let pointerHeld = false;

  // One timer per gesture rather than one per scroll event: this runs every frame.
  const settle = () => {
    const left = QUIET_MS - (performance.now() - lastScroll);
    if (left > 0) {
      timer = window.setTimeout(settle, left);
      return;
    }
    timer = null;
    root.removeAttribute("data-aura-scrolling");
  };
  const onScroll = () => {
    lastScroll = performance.now();
    if (timer !== null) return;
    if (!pointerHeld && lastScroll - lastInput > INPUT_RECENT_MS) return;
    root.setAttribute("data-aura-scrolling", "");
    timer = window.setTimeout(settle, QUIET_MS);
  };

  const onInput = () => { lastInput = performance.now(); };
  const onPointerDown = () => { pointerHeld = true; };
  const onPointerUp = () => { pointerHeld = false; };

  const opts: AddEventListenerOptions = { passive: true, capture: true };
  window.addEventListener("scroll", onScroll, opts);
  window.addEventListener("wheel", onInput, opts);
  window.addEventListener("keydown", onInput, opts);
  window.addEventListener("pointerdown", onPointerDown, opts);
  window.addEventListener("pointerup", onPointerUp, opts);
  window.addEventListener("pointercancel", onPointerUp, opts);
  return () => {
    window.removeEventListener("scroll", onScroll, opts);
    window.removeEventListener("wheel", onInput, opts);
    window.removeEventListener("keydown", onInput, opts);
    window.removeEventListener("pointerdown", onPointerDown, opts);
    window.removeEventListener("pointerup", onPointerUp, opts);
    window.removeEventListener("pointercancel", onPointerUp, opts);
    if (timer !== null) window.clearTimeout(timer);
    root.removeAttribute("data-aura-scrolling");
  };
}
