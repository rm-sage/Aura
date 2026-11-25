// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// wheelSmooth.ts: blends mouse wheel notches into one continuous motion.
//
// Chromium plays each notch as its own short curve that returns to rest. Measured
// on real notches at about 5 a second: speed swings between 0 and 4 px/ms, a run of
// separate shoves, and frame pacing is not the cause (frames drew at an even 4.2 ms).
// The durations are compile-time constants and the longer curve was removed from
// Chromium, so no browser flag can change this.
//
// A critically damped spring carries speed from one notch into the next: half of a
// notch lands in about the same time as Chromium's curve (92 ms vs 96 ms), so it does
// not feel late, but the motion no longer stops between notches.
//
// Only whole wheel notches are taken. A touchpad or a free-spin wheel reports fine
// deltas and already has its own momentum, so those stay native, and so does anything
// a nearer handler already claimed. Import-free so a node check can load it.

/** Spring stiffness (1/s). See the comparison above: lower floats, higher pulses. */
const OMEGA = 18;
/** Fine-delta input within this long means a touchpad stream: leave the rest of it. */
const FINE_INPUT_HOLD_MS = 400;
const NOTCH_UNITS = 120;
/** Chromium's wheel latch: a run of notches stays with one scroller. Cancelling every
 *  notch drops the browser's own latch, so this one has to be kept here. */
const LATCH_MS = 500;
const LATCH_SLOP_PX = 10;

export interface SpringState {
  x: number;
  v: number;
}

/** Exact critically damped step toward 0, so a long frame cannot overshoot or blow up. */
export function springStep(x: number, v: number, omega: number, h: number): SpringState {
  const e = Math.exp(-omega * h);
  const k = v + omega * x;
  return { x: (x + k * h) * e, v: (v - k * omega * h) * e };
}

/** How a run ends. The spring's own tail takes as long as the whole move and, with scroll
 *  offsets in whole pixels, plays as lone 1 px steps up to 46 ms apart. Closing that tail at a
 *  steady 240 px/s instead stopped dead from full speed, 57600 px/s^2 in one frame (the body
 *  brakes at about 3300): the eye, still tracking, read that stop as the whole page jiggling.
 *  So once the spring's own deceleration has grown to what stopping on the target needs, the
 *  rest of the move brakes at that one constant rate: speed falls to zero exactly on the target,
 *  the last pixels land 4 to 13 ms apart at 240 Hz (spreading out, never a lone long hold), and
 *  the last one lands when it did before (254 ms after the notch vs 250).
 *  From rest the hand-off falls at omega * t = sqrt(2), where speed and deceleration both match
 *  the spring's, so there is no seam in the motion either. */
export interface Step extends SpringState {
  /** The braking rate (px/s^2) once the run is braking, else null. */
  brake: number | null;
}

/** The next position and speed. `prevX` is the distance before this step; a new notch
 *  passes `brake` null, since the spring has to pick the run up again. */
export function nextStep(
  prevX: number, v: number, omega: number, h: number, brake: number | null,
): Step {
  if (brake === null && prevX * v < 0) {
    const decel = 2 * omega * Math.abs(v) - omega * omega * Math.abs(prevX);
    const need = (v * v) / (2 * Math.abs(prevX));
    if (decel >= need) brake = need;
  }
  if (brake === null) return { ...springStep(prevX, v, omega, h), brake };
  // Exact over the step, so a long frame cannot overshoot: `left` is the time to the stop.
  const left = Math.abs(v) / brake - h;
  if (left <= 0) return { x: 0, v: 0, brake };
  return { x: Math.sign(prevX) * brake * left * left / 2, v: Math.sign(v) * brake * left, brake };
}

/** Under half a pixel and this speed (px/s), a run that never braked counts as at rest. */
const REST_SPEED = 30;

/** A mouse notch, as opposed to the fine deltas of a touchpad or free-spin wheel. */
export function isWholeNotch(wheelDeltaY: number): boolean {
  return wheelDeltaY !== 0 && wheelDeltaY % NOTCH_UNITS === 0;
}

interface Run {
  el: Element;
  y: number;
  v: number;
  target: number;
  /** The braking rate once the run is braking to its target (see nextStep). */
  brake: number | null;
  /** Where the browser actually put it last frame, to notice anything else moving it. */
  landed: number;
}

/** The element this wheel should move, or null to leave the event alone. */
function scrollerFor(start: EventTarget | null, deltaY: number): Element | null {
  let el = start instanceof Element ? start : null;
  while (el && el !== document.documentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") {
      if (el.scrollHeight > el.clientHeight + 1) {
        const atEnd = deltaY > 0
          ? el.scrollTop + el.clientHeight >= el.scrollHeight - 1
          : el.scrollTop <= 0;
        // Same as native: a scroller at its end chains out only when it allows that.
        if (!atEnd || cs.overscrollBehaviorY !== "auto") return el;
      } else if (cs.overscrollBehaviorY !== "auto" && el.scrollWidth <= el.clientWidth + 1) {
        // A dropdown whose content fits still holds the wheel natively. Left to the
        // browser, the page behind it stays put. A horizontal row is let through: its
        // computed overflow-y is auto too, and a vertical notch over it should move the page.
        return null;
      }
    }
    // The native scroll chain follows the containing block: a fixed modal rendered inside
    // a page scroller does not scroll that page.
    if (cs.position === "fixed") return null;
    el = el.parentElement;
  }
  return null;
}

export function installWheelSmooth(isEnabled: () => boolean): () => void {
  const runs = new Map<Element, Run>();
  let raf: number | null = null;
  let lastTime = 0;
  let lastFineInput = -Infinity;
  let latch: { el: Element; at: number; x: number; y: number } | null = null;

  const frame = (now: number) => {
    const h = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    for (const [el, r] of runs) {
      // Anything else that moved it (scroll anchoring, a jump to a date) wins, and the
      // rest of the notch carries on from there rather than dragging it back.
      const moved = el.scrollTop - r.landed;
      if (Math.abs(moved) > 1) {
        r.y += moved;
        r.target += moved;
      }
      const s = nextStep(r.y - r.target, r.v, OMEGA, h, r.brake);
      r.y = r.target + s.x;
      r.v = s.v;
      r.brake = s.brake;
      const done = !el.isConnected
        || (s.x === 0 && s.v === 0)
        || (Math.abs(s.x) < 0.5 && Math.abs(s.v) < REST_SPEED);
      if (done) r.y = r.target;
      el.scrollTop = r.y;
      r.landed = el.scrollTop;
      if (done) runs.delete(el);
    }
    raf = runs.size > 0 ? requestAnimationFrame(frame) : null;
  };

  const onWheel = (e: WheelEvent) => {
    // An uncancellable event is scrolling natively already: taking it too would move twice.
    if (!e.cancelable || e.defaultPrevented) return;
    if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    if (e.deltaMode !== 0 || e.deltaX !== 0 || e.deltaY === 0) return;
    if (!isWholeNotch((e as WheelEvent & { wheelDeltaY: number }).wheelDeltaY)) {
      lastFineInput = e.timeStamp;
      return;
    }
    if (e.timeStamp - lastFineInput < FINE_INPUT_HOLD_MS) return;
    if (document.documentElement.getAttribute("data-reduced-motion") === "true") return;
    if (!isEnabled()) return;

    const held = latch
      && e.timeStamp - latch.at < LATCH_MS
      && Math.abs(e.clientX - latch.x) <= LATCH_SLOP_PX
      && Math.abs(e.clientY - latch.y) <= LATCH_SLOP_PX
      && latch.el.isConnected
      && (e.deltaY > 0
        ? latch.el.scrollTop + latch.el.clientHeight < latch.el.scrollHeight - 1
        : latch.el.scrollTop > 0);
    // A nested list carried under a still pointer does not take the run from the page.
    const el = held && latch ? latch.el : scrollerFor(e.target, e.deltaY);
    if (!el) return;
    latch = { el, at: e.timeStamp, x: e.clientX, y: e.clientY };
    e.preventDefault();

    const max = el.scrollHeight - el.clientHeight;
    let r = runs.get(el);
    if (!r) {
      r = { el, y: el.scrollTop, v: 0, target: el.scrollTop, brake: null, landed: el.scrollTop };
      runs.set(el, r);
    }
    // Turning back answers at once instead of first working off what was still to come.
    const reversing = (r.target - r.y) * e.deltaY < 0;
    const from = reversing ? r.y : r.target;
    r.target = Math.max(0, Math.min(max, from + e.deltaY));
    r.brake = null;
    if (raf === null) {
      lastTime = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  // Taking the scrollbar or the keyboard takes the scroll.
  const stop = () => {
    runs.clear();
    latch = null;
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };

  // Bubble phase on window: a nearer handler that scrolls for itself (the player menus)
  // has already run and marked the event. Not passive: this event replaces the native scroll.
  const wheelOpts: AddEventListenerOptions = { passive: false };
  const stopOpts: AddEventListenerOptions = { passive: true, capture: true };
  window.addEventListener("wheel", onWheel, wheelOpts);
  window.addEventListener("pointerdown", stop, stopOpts);
  window.addEventListener("keydown", stop, stopOpts);
  return () => {
    window.removeEventListener("wheel", onWheel, wheelOpts);
    window.removeEventListener("pointerdown", stop, stopOpts);
    window.removeEventListener("keydown", stop, stopOpts);
    stop();
  };
}
