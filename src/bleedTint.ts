// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// bleedTint.ts: the Home row titles take a soft tint from the hero bleed
// around them (round 11). The user: titles "should react to the bleeding
// colour around them and the cursor glow primarily" (the cursor glow is the
// `data-glass-light="text"` kind in glassGlint.ts; this file is the colour).
//
// HeroBleed hands over its glows (the same elliptical Gaussians it paints,
// in viewport space, the layer being fixed) and its scroll fade. For each
// registered title the bleed is evaluated at the title's own position (a
// point inside its first words): the colour is the glow-weighted mean, the
// strength k = fade x the summed glow alpha / the bleed strength, clamped
// to 0..1. Rows far down the page, or any row once the hero has scrolled
// away, fall to k ~ 0 and read neutral; with no bleed (no palette, another
// page, High Contrast) nothing is written and CSS draws neutral white.
//
// Written per title as two @property-registered NON-INHERITING properties
// (`--lg-bleed-tint` <color>, `--lg-bleed-tint-k` <number>, App.css), never on
// a shared ancestor: an inherited write there restyled the whole page on each
// scroll fade step. App.css transitions them, so a slide change or a settled
// scroll eases over.
//
// Cost: nothing per frame. An update reads one rect per registered title
// (a Home has at most a few dozen) and writes only values that changed
// (quantised: k in 0.05 steps, each channel in 6s). During a user-driven
// scroll (`<html data-aura-scrolling>`, scrollPause.ts) updates wait and run
// once when it settles: a scroll frame is the tightest budget and the tint
// transition would otherwise repaint titles while they move.

import type { Glow } from "./heroAmbient";

/** Titles that take the tint (`ref={bleedTitleRef}`); dropped on unmount. */
const titles = new Set<HTMLElement>();
/** What each title was last given, so an unchanged value writes nothing. */
const shown = new WeakMap<HTMLElement, { c: string; k: string }>();
let glows: Glow[] | null = null;
let strength = 0.2;
let fade = 1;
let raf = 0;
let pending = false;
let scrollMo: MutationObserver | null = null;

const scrolling = () =>
  typeof document !== "undefined" && document.documentElement.hasAttribute("data-aura-scrolling");

function flush(): void {
  raf = 0;
  if (scrolling()) { pending = true; watchScroll(); return; }
  pending = false;
  const G = glows;
  for (const el of titles) {
    if (!el.isConnected) { titles.delete(el); continue; }
    if (!G || G.length === 0) {
      if (shown.has(el)) {
        el.style.removeProperty("--lg-bleed-tint");
        el.style.removeProperty("--lg-bleed-tint-k");
        shown.delete(el);
      }
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // A point inside the first words (titles are left-aligned).
    const x = r.left + Math.min(r.width, 240) / 2;
    const y = r.top + r.height / 2;
    let a = 0, cr = 0, cg = 0, cb = 0;
    for (const g of G) {
      const dx = (x - g.cx) / g.sx, dy = (y - g.cy) / g.sy;
      const d = dx * dx + dy * dy;
      if (d > 9) continue; // the image cuts each glow at 3 sigma
      const w = g.p * Math.exp(-d / 2);
      a += w; cr += w * g.c[0]; cg += w * g.c[1]; cb += w * g.c[2];
    }
    const kv = Math.max(0, Math.min(1, (fade * a) / Math.max(1e-6, strength)));
    const k = (Math.round(kv * 20) / 20).toFixed(2);
    const prev = shown.get(el);
    // Too faint to tint: keep the last colour (only k falls), so a fade to
    // neutral does not swing the hue on its way out.
    const q = (v: number) => Math.min(255, Math.round(v / a / 6) * 6);
    const c = a > 1e-4 ? `rgb(${q(cr)} ${q(cg)} ${q(cb)})` : (prev?.c ?? "rgb(255 255 255)");
    if (prev && prev.c === c && prev.k === k) continue;
    if (!prev || prev.c !== c) el.style.setProperty("--lg-bleed-tint", c);
    if (!prev || prev.k !== k) el.style.setProperty("--lg-bleed-tint-k", k);
    shown.set(el, { c, k });
  }
}

function schedule(): void {
  if (typeof window === "undefined") return;
  if (scrolling()) { pending = true; watchScroll(); return; }
  if (!raf) raf = requestAnimationFrame(flush);
}

/** One observer on <html> while an update waits out a user scroll. */
function watchScroll(): void {
  if (scrollMo || typeof MutationObserver === "undefined") return;
  scrollMo = new MutationObserver(() => {
    if (scrolling() || !pending) return;
    scrollMo?.disconnect();
    scrollMo = null;
    schedule();
  });
  scrollMo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-aura-scrolling"] });
}

/** A ref callback for a title that takes the tint (stable identity, React 19
 *  cleanup return). */
export function bleedTitleRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  titles.add(el);
  if (glows) schedule();
  return () => { titles.delete(el); };
}

/** HeroBleed: the glows now shown (viewport space), or null for none. */
export function setBleedTint(next: Glow[] | null, bleedStrength: number): void {
  glows = next && next.length ? next : null;
  strength = bleedStrength;
  schedule();
}

/** HeroBleed: the scroll fade (1 at the top .. its floor). Titles also move
 *  with every scroll, so any scroll asks for an update (coalesced per frame,
 *  deferred while the user drives the scroll). */
export function setBleedFade(f: number): void {
  fade = f;
  if (glows) schedule();
}
