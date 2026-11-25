// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// HeroBleed: the Home hero's AMBIENT BLEED (round 9, the A direction, the
// user's 20%). Large soft glows tinted by the current slide's dominant
// colours (heroAmbient.ts), FIXED behind the page content and under the rail
// and the search bar, crossfading on a slide change and fading to 30% as the
// hero scrolls away. Mounted by HeroCarousel, so it exists only while the
// Home hero does; portalled into `.aura-app-shell` as its LOWEST layer
// (z-index -2 inside the shell's stacking context: under the title bar, the
// rail, the page and the hero underglow at -1, over the shell's transparent
// background), and hidden under html.playing-video (styles/glass-hero.css).
// Not <body>: html, body and #root paint the theme's `--ln-bg`, and every
// theme but Mica (and, faintly, Haze) painted it opaque OVER a body-level
// layer, so the bleed showed on Mica only while its tint still coloured the
// Home row titles (bleedTint.ts) on every theme.
//
// Banding under fixed glass. The bleed is dithered in its own pixels, but a
// glass surface over it blurs the noise away and rounds the smooth result to
// 8 bits again, so it would band INSIDE the glass. So, as the mockup does:
// the bleed is CUT OUT under every fixed glass surface marked
// `data-glass-bleed` (a rectangular hole per element in the layer's mask,
// whose corners and edge the element paints back itself: cutHoles), and the
// same dithered image is drawn inside that surface's face instead (its
// `--lg-bleed` background layer, `background-attachment: fixed`, so it lines
// up with the bleed around it whatever the element's size or position), at
// (1 - tint) of the bleed's own strength (--lg-bleed-face, glass-hero.css),
// x 0.3 while a focused search bar dims the page under it.
//
// Cost: one viewport-sized SVG image per slide (rasterised once; two only
// during a crossfade), a scroll listener that writes two opacities (in 0.02
// steps) and the face crop and corner patch on the few marked elements, and
// a ResizeObserver on those elements and their ancestors (holes: they follow
// an element that MOVES at the same size too, see the geometry effect). No
// React state changes after a slide's image is built.

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { bleedGlows, bleedImage, UNDERGLOW_PAD, type Glow, type HeroPalette } from "./heroAmbient";
import { releaseSvgImage } from "./glassGlint";
// The Home row titles take their tint from these glows (bleedTint.ts).
import { setBleedFade, setBleedTint } from "./bleedTint";

/** The user's pick: ambient hero bleed 20%. */
export const BLEED_STRENGTH = 0.2;
/** Where the content column starts (the rail: 12 + 204 + 12). */
const MAIN_L = 228;
/** The bleed keeps this much of itself once the hero has scrolled away. */
const BLEED_FLOOR = 0.3;
const CROSSFADE_MS = 900;
/** Leaving Home: the bleed fades out over this, on the `ease` curve, instead
 *  of vanishing with the page (2026-11-24; the user: the switch back to the
 *  theme's own colour was jarring). The same 900 ms `ease` as the ambient
 *  sweep's return from its 30% dim (glass-hero.css), so one falls as the
 *  other rises. */
const LEAVE_MS = 900;
/** The fade-out of a HeroBleed that already unmounted (see the unmount
 *  effect). A new HeroBleed ends it at once, before it paints anything. */
let leaving: { finish: () => void; handOver: () => void } | null = null;
/** HeroBleed instances mounted right now (counted in the layout effect). */
let mounted = 0;
/** A running fade with a newer image waiting finishes within this (build). */
const HURRY_MS = 200;
/** Fixed glass the bleed is cut out under: anything marked, plus the left
 *  rail (NavSidebar's `data-aura-rail`), which always sits over it. */
const BLEED_SELECTOR = "[data-glass-bleed], [data-aura-rail]";
/** Set on a marked element while it paints the corner patch (glass-hero.css:
 *  only then are the patch children shown and its drop shadow moved onto
 *  one of them). */
const PATCH_ATTR = "data-bleed-patch";

interface Props {
  palette: HeroPalette | null;
  /** The hero box (the bleed is laid out from it at scroll 0). */
  heroRef: React.RefObject<HTMLElement | null>;
}

/** While a bleed image shows, the app-wide spectral sweep (AmbientAura) drops
 *  to 30% (glass-hero.css): the bleed supplies the ambient colour now, the
 *  mockup the user tuned has no sweep, and under the full sweep the A rail
 *  read violet-grey instead of neutral with an art tint (measured, review
 *  round 9). A class on the one sweep element, so only it restyles. */
function dimAmbient(on: boolean) {
  document.querySelector(".aura-ambient")?.classList.toggle("is-under-bleed", on);
}

/** CSS `ease` (cubic-bezier(0.25, 0.1, 0.25, 1)), the curve the bleed's
 *  crossfade has always used. */
function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (s: number) => 3 * s * (1 - s) * (1 - s) * 0.25 + 3 * s * s * (1 - s) * 0.25 + s * s * s;
  const by = (s: number) => 3 * s * (1 - s) * (1 - s) * 0.1 + 3 * s * s * (1 - s) + s * s * s;
  let lo = 0, hi = 1, s = t;
  for (let k = 0; k < 30; k++) {
    s = (lo + hi) / 2;
    if (bx(s) < t) lo = s; else hi = s;
  }
  return by(s);
}

/** The corner patch's geometry, per element: how far its hole reaches past
 *  the border box on each side (top, right, bottom, left), and the layout it
 *  was cut at. */
interface CornerGeom { nums: number[]; top: number; height: number; dpr: number }
const cornerGeom = new WeakMap<HTMLElement, CornerGeom>();
/** Each element's left edge at its last cut (how far it moved per frame). */
const lastLeft = new WeakMap<HTMLElement, number>();
/** The smallest whole number of CSS px that is also a whole number of device
 *  px (1 at 100% and 200%, 4 at 125%, 2 at 150%), up to 20. */
function pixelGrid(dpr: number): number {
  for (let g = 1; g <= 20; g++) if (Math.abs(g * dpr - Math.round(g * dpr)) < 1e-3) return g;
  return 1;
}
const px = (v: number) => `${Math.round(v * 1000) / 1000}px`;
/** Where the page bleed and an element's patch meet at a scale whose grid is
 *  more than 1 CSS px (125%, 150%, 175%), they cross-fade over this many CSS
 *  px (the hole's outer ring): the element's layer is drawn a fraction of a
 *  device pixel off there (see cutHoles), so a hard edge between the two
 *  would leave a row of neither. At 100% and 200% the edge is hard. */
const FEATHER = 4;
const G = "linear-gradient(#000 0 0)";
/** A hole's two edge ramps over its box, F px each side: the patch's (0 at
 *  the hole's edge, 1 from F px in; INTERSECTED, so fx x fy) or, `page`, the
 *  page bleed's (their inverses; a mask layer ADDS as source-over, so the two
 *  give 1 - fx x fy). One gradient per axis across the whole box: the patch
 *  is drawn a fraction of a pixel off, and two pieces meeting inside it left
 *  a -4 level row where they met (measured, 125%). */
function edgeRamps(F: number, page: boolean): [string, string] {
  const f = px(F), e = page ? "#000" : "transparent", m = page ? "transparent" : "#000";
  return [`linear-gradient(to right, ${e}, ${m} ${f}, ${m} calc(100% - ${f}), ${e})`,
    `linear-gradient(to bottom, ${e}, ${m} ${f}, ${m} calc(100% - ${f}), ${e})`];
}
/** The corner patch (glass-hero.css): two empty children HeroBleed puts
 *  first in each marked element, the patch itself and, over it, the element's
 *  drop shadow; their values are their own inline styles, written only when
 *  they change. Children, not pseudo-elements: a pseudo-element is styled
 *  again with its element (the cursor light, many times a second; the search
 *  bar's focus morph, every frame), these only when its inherited style
 *  changes. */
interface Patch { fill: HTMLSpanElement; drop: HTMLSpanElement; box: string; mask: string; img: string; radius: string }
const patches = new Map<HTMLElement, Patch>();
function patchOf(el: HTMLElement): Patch {
  for (const [e, p] of patches) if (!e.isConnected) { p.fill.remove(); p.drop.remove(); patches.delete(e); }
  let q = patches.get(el);
  if (!q || q.fill.parentElement !== el) {
    const fill = document.createElement("span"), drop = document.createElement("span");
    fill.className = "aura-bleed-patch"; drop.className = "aura-bleed-drop";
    fill.setAttribute("aria-hidden", "true"); drop.setAttribute("aria-hidden", "true");
    el.prepend(fill, drop);
    q = { fill, drop, box: "", mask: "", img: "none", radius: "" };
    patches.set(el, q);
  }
  return q;
}
function writePatch(q: Patch, box: string, mask: string, img: string) {
  const s = q.fill.style;
  if (box !== q.box) { q.box = box; s.inset = box; }
  if (mask !== q.mask) { q.mask = mask; s.mask = mask; }
  if (img !== q.img) { q.img = img; s.background = img; }
}
/** Marked elements that lie partly or wholly over the hero, its underglow or
 *  the page content below them right now (see measureOverHero). */
const overHero = new WeakMap<HTMLElement, boolean>();
/** Elements that changed sides and still owe a shadow snap (paintFaces). */
const flipped = new Set<HTMLElement>();
/** Finish an element's running box-shadow transition: its drop shadow moves
 *  between itself and its patch child in one frame when it changes sides, and
 *  the element's own 200 ms shadow transition otherwise shows it missing, then
 *  doubled, for about 100 ms (measured in the harness: +5 to +7 levels around
 *  the bar, then -8 to -11 under it). The same snap as liquidGlass.ts's. */
function snapShadow(el: HTMLElement) {
  if (typeof CSSTransition === "undefined" || !el.isConnected) return;
  void getComputedStyle(el).boxShadow;
  for (const a of el.getAnimations()) {
    if (a instanceof CSSTransition && a.transitionProperty === "box-shadow") a.finish();
  }
}
/** Take the face crop and the corner patch off an element. */
function clearFace(el: HTMLElement) {
  el.style.removeProperty("--lg-bleed");
  const q = patches.get(el);
  if (q) writePatch(q, q.box, q.mask, "none");
  if (el.hasAttribute(PATCH_ATTR)) el.removeAttribute(PATCH_ATTR);
}

export default function HeroBleed({ palette, heroRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const layerRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  /** Which layer is in front, and each layer's image. */
  const front = useRef(0);
  const urls = useRef<[string, string]>(["none", "none"]);
  /** The bleed's scroll fade (1 .. BLEED_FLOOR), each layer's crossfade
   *  opacity (0..1), and the crossfade's eased progress toward the front
   *  layer (0..1, the face crop's mix). */
  const fade = useRef(1);
  const op = useRef<[number, number]>([0, 0]);
  /** Each layer's opacity as written (crossfade x scroll fade, rounded): the
   *  page layers and the corner patch read the same two numbers. */
  const shown = useRef<[number, number]>([0, 0]);
  const mix = useRef(1);
  const mixRaf = useRef(0);
  /** The page bleed's mask as last written (a cut that changes nothing writes
   *  nothing). */
  const lastMask = useRef("");
  /** A slide-change fade is running, and the newest image waiting for it to
   *  end (build). */
  const fading = useRef(false);
  const queued = useRef<{ next: string; glows: Glow[] | null } | null>(null);
  /** A build was skipped because the hero had no layout (see build). */
  const deferred = useRef(false);

  // ---- the page layers --------------------------------------------------
  // Each layer's opacity is its crossfade share times the scroll fade (the
  // root itself stays at 1), written from the same clock as the corner patch.
  const paintLayers = () => {
    for (let i = 0; i < 2; i++) {
      const q = Math.round(op.current[i] * fade.current * 10000) / 10000;
      shown.current[i] = q;
      const l = layerRefs[i].current;
      if (l) l.style.opacity = String(q);
    }
  };

  // ---- over the hero art -------------------------------------------------
  // The bleed lies UNDER the hero, so where a marked element sits over the
  // hero's art (the search bar once the page scrolls the hero up under it)
  // there is no bleed to continue, and its face crop and corner patch drew a
  // flat slab of the bleed's colour over the art (2026-11-24, the user: the
  // search bar "looks off now when on top of the hero item"). Scaling them by
  // the share over the art was not enough: across the hero's top or bottom
  // edge part of the bar is over the bleed and part over the art, and one
  // background layer cannot follow that line (the user's video: a flat dark
  // bar half over the green bleed). So an element over the hero at all takes
  // NO hole, face crop or patch: its glass then reads the real page, bleed
  // and art alike, as any glass does. The banding the cut prevents is a blur
  // of the bleed alone; here the art is in the same blur.
  //
  // The area is not the hero box alone but everything from the hero's
  // underglow down (2026-11-25, the user: "I still very faintly see the sharp
  // corners next to the search bar when scrolling slowly near the hero
  // item"). The patch is exact only where nothing but the bleed lies under
  // the element: it paints the bleed OVER whatever the page draws there,
  // where the page draws it UNDER (the underglow at -1, the rows). The
  // underglow reaches 110 px past the hero (HeroCarousel useUnderglow; up to
  // the top of the page content where that is nearer), so at rest the search
  // bar already sits in it, and its four box corners showed the underglow's
  // shadow painted over by the bleed: a sharp-edged corner off by about 1
  // level, up to 4, growing as the hero came up (harness, scratchpad sbv/r3).
  // Below the hero everything under the bar is page content, so the area runs
  // on to the scroller's bottom: no switch back over the rows (the one-frame
  // 8-level step over the first row's posters that an area ending with the
  // underglow showed, sbv/r2). The rail lies outside the scroller and never
  // changes sides.
  //
  // With the hero GONE (the leave fade, after Home's rows unmounted) a marked
  // element still on screen is over page content too: a search swaps the rows
  // for its results inside Home and the search bar stays (2026-11-25, the
  // user: "the search bar leaves behind rectangles when something is actually
  // searched"). The leave fade took it for clear of everything, cut it a hole
  // and painted its patch; the bar then morphed from its focused width to its
  // rest width with nothing re-cutting the hole, and the wide hole showed the
  // window as a dark box either side of it for the fade's 900 ms. The rail
  // lies outside the page and keeps its hole. Returns whether any element
  // changed sides.
  const measureOverHero = (): boolean => {
    const hero = heroRef.current;
    const gone = !hero || !hero.isConnected;
    let hl = 0, ht = 0, hr = 0, hb = 0;
    if (!gone) {
      const r = hero.getBoundingClientRect();
      const scroller = hero.closest<HTMLElement>(".aura-page-scroller");
      // Only the part the page scroller shows (the bar floats outside it).
      const sc = scroller?.getBoundingClientRect();
      // The top of the page content, where the underglow stops short of its
      // full reach (useUnderglow's room).
      const contentTop = sc ? sc.top - scroller!.scrollTop : -Infinity;
      hl = Math.max(r.left - UNDERGLOW_PAD, sc?.left ?? -Infinity);
      ht = Math.max(r.top - UNDERGLOW_PAD, contentTop, sc?.top ?? -Infinity);
      hr = Math.min(r.right + UNDERGLOW_PAD, sc?.right ?? Infinity);
      hb = sc?.bottom ?? Infinity;
    }
    let changed = false;
    for (const el of document.querySelectorAll<HTMLElement>(BLEED_SELECTOR)) {
      // No hero: the page under a marked element is content (see above).
      let over = gone && el.hasAttribute("data-glass-bleed");
      if (!over && hr > hl && hb > ht) {
        const r = el.getBoundingClientRect();
        over = Math.min(r.right, hr) - Math.max(r.left, hl) > 0 && Math.min(r.bottom, hb) - Math.max(r.top, ht) > 0;
      }
      if ((overHero.get(el) ?? false) !== over) { overHero.set(el, over); flipped.add(el); changed = true; }
    }
    return changed;
  };

  // ---- face crops and corner patches on [data-glass-bleed] ---------------
  const paintFaces = () => {
    // A change of sides seen here re-cuts the holes too (cutHoles' own look
    // then finds nothing new, so this does not recurse).
    if (measureOverHero()) cutHoles();
    const cur = urls.current[front.current];
    const prev = urls.current[1 - front.current];
    const m = mix.current;
    // The corner patch (glass-hero.css): the page bleed itself, its two
    // layers in their stacking order (layer 1 over layer 0) at exactly the
    // opacity the page layers have now, so the patch and the page bleed
    // around it are one image through a crossfade and the scroll fade.
    const pimg: string[] = [];
    for (const i of [1, 0]) {
      const u = urls.current[i], q = shown.current[i];
      if (u === "none" || q <= 0) continue;
      pimg.push(q >= 1
        ? `${u} 0 0 / 100vw 100vh no-repeat fixed`
        : `-webkit-cross-fade(linear-gradient(transparent, transparent), ${u}, ${(q * 100).toFixed(2)}%) 0 0 / 100vw 100vh no-repeat fixed`);
    }
    const patch = pimg.length ? pimg.join(", ") : "none";
    // A fade to or from no bleed crosses with a transparent image. The patch
    // and the attribute stay while any page layer still shows: the hole is
    // still cut then, so clearing them on the first frame of a fade out left
    // the box corners and the band showing the window (black) for 0.8 s.
    const T0 = "linear-gradient(transparent, transparent)";
    for (const el of document.querySelectorAll<HTMLElement>(BLEED_SELECTOR)) {
      if (!pimg.length || overHero.get(el)) { clearFace(el); continue; }
      // The focus dim is ONLY for a surface that rises above the search dim
      // while it holds focus (the Home search bar, `data-glass-bleed`): the
      // page's bleed around it is under the 0.7 black dim then. The rail sits
      // UNDER that dim, so its crop never dims: keyed on `:focus-within`
      // alone, a click on a rail row (which focuses the row) dropped the
      // rail's crop to 0.3 until a click elsewhere blurred it (the "rail goes
      // darker and loses the bleed until I click the page" report).
      const k = el.hasAttribute("data-glass-bleed") && el.matches(":focus-within") ? 0.3 : 1;
      // The face strength is a CSS token (per material), times the scroll
      // fade and the focus dim. Through a slide change the new image is its
      // OWN layer over the old one, never one -webkit-cross-fade(old, new)
      // (2026-11-24; the user: "the menu & search bars flash occasionally,
      // quite consistently, when the hero item is being switched"): Chromium
      // paints a cross-fade as nothing while either image is not ready, and a
      // fresh blob url is not ready on its first frame (measured: 0 against
      // 140 on the first frame, ten of ten), so for a frame or two the rail
      // and the search bar lost the whole bleed and showed the bare face over
      // their hole (41 / 43 against 57 to 65 in the user's video). As layers,
      // a new image that is not ready leaves only its own layer empty, and
      // that layer is near 0 then. The alphas are exact for the cross-fade's
      // mix: new at a x m on top, old at a (1 - m) / (1 - a m) under it.
      const F = (fade.current * k).toFixed(3);
      const A = `var(--lg-bleed-face, 0.7) * ${F}`;
      const lay = (u: string, alpha: string) =>
        `-webkit-cross-fade(${T0}, ${u}, calc(${alpha} * 100%)) 0 0 / 100vw 100vh no-repeat fixed`;
      const layers: string[] = [];
      const ms = m.toFixed(4);
      if (cur !== "none") layers.push(lay(cur, m >= 1 ? A : `${A} * ${ms}`));
      if (prev !== "none" && m < 1) {
        layers.push(lay(prev, cur === "none" ? `${A} * (1 - ${ms})` : `${A} * (1 - ${ms}) / (1 - ${A} * ${ms})`));
      }
      el.style.setProperty("--lg-bleed", layers.length ? layers.join(", ") : `${T0} 0 0 / 100vw 100vh no-repeat fixed`);
      // No focus factor in the patch: the search dim the page bleed lies
      // under is followed in CSS, in step with the dim's own fade.
      const q = patchOf(el);
      writePatch(q, q.box, q.mask, patch);
      if (!el.hasAttribute(PATCH_ATTR)) el.setAttribute(PATCH_ATTR, "");
    }
    for (const el of flipped) snapShadow(el);
    flipped.clear();
  };

  // ---- holes under [data-glass-bleed] ------------------------------------
  // RECTANGULAR holes, and the element paints the bleed back over the part of
  // its hole it does not cover itself (round 18). A hole rounded like the
  // element leaked: backdrop-filter reads the element's whole rectangular
  // border box, so the bleed left in the four box corners outside the radius
  // was pulled into the blur, a light, cool lift over the last 20 to 30 px of
  // the search bar's rounded ends and inside the rail's corners. With the box
  // cut, the blur sees no bleed, and the element's patch child (glass-hero.css)
  // draws the bleed in the four corners outside the radius and in the band
  // between its painted edge and the hole's edge (an element's own painting
  // is never part of its backdrop), under its drop shadow, moved onto a
  // second child over it.
  //
  // Where the page bleed and the patch meet (round 19):
  //  - the page bleed's mask is a union of plain rectangles (mask layers add
  //    as source-over): the layer minus each hole. Round 18 EXCLUDED each hole
  //    from a full-layer image, and Chromium composites that soft and a
  //    fraction of a pixel wide at 125%: 26% of the bleed missing from the
  //    device column just outside the rail's hole (-6 levels on the
  //    transparent window), 3% from the row outside every top and left edge.
  //    (A clip-path is softer still: 75 / 25% edge rows, a quarter pixel off.)
  //    Rectangles on whole device pixels come out exact;
  //  - the hard part of the hole runs from the painted box out to at least
  //    1 CSS px past it (the blur also samples a partly covered edge pixel
  //    and, at 125%, one more: +1.4 to +2 levels with the hole on the box's
  //    own outer pixel), on a grid whole in CSS px and in device px
  //    (pixelGrid), and each band from the hole's edge to the element's
  //    painted edge, taken as the INNER of the CSS px and the device px snap,
  //    so it never stops short of the face where it is known (the first round
  //    18 cut ended on the box's outer pixel with no band: the rail's top is
  //    at 103.5 px and painted from 104, so row 103 was painted by no one, a
  //    black line along the rail's top on the transparent window);
  //  - at 100% and 200% the edge is hard: both layers land on the same
  //    device pixels and nothing outside the shape changes. At 125%, 150% and
  //    175% the element's layer has a fractional origin (the drop shadow's
  //    reach, a whole number of CSS px, decides it) and is drawn resampled, a
  //    fraction of a pixel off, so the page bleed and the patch cross-fade
  //    over FEATHER px instead (one ramp per axis; a hard edge left a -7 to
  //    -15 level row there). Moving the layer onto whole pixels would sharpen
  //    the element's own face and border too, which it has always been drawn
  //    without.
  // The geometry is written only when a value changes, and not at all while
  // only the width moves (the search bar's focus morph): then the patch keeps
  // its reach and the hole follows it, and one exact cut follows 150 ms after
  // the last frame.
  const cutHoles = (settle = true) => {
    const root = rootRef.current;
    if (!root) return;
    const dpr = window.devicePixelRatio || 1;
    const g = pixelGrid(dpr);
    const snapC = (v: number) => Math.round(v + 1e-4);
    const snapD = (v: number) => Math.round(v * dpr + 1e-4) / dpr;
    const gridDown = (v: number) => Math.floor(v / g + 1e-6) * g;
    const gridUp = (v: number) => Math.ceil(v / g - 1e-6) * g;
    const F = g > 1 ? FEATHER : 0;
    const holes: [number, number, number, number][] = [];
    const tiles: string[] = [];
    // An element that changed sides since the last look (a resize, a slide
    // build) changes its face in step with its hole.
    if (measureOverHero()) paintFaces();
    for (const el of document.querySelectorAll<HTMLElement>(BLEED_SELECTOR)) {
      // Over the hero: no hole (measureOverHero).
      if (overHero.get(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      let L: number, T: number, R: number, B: number;
      const prev = cornerGeom.get(el);
      // The left edge's move since the last cut, per frame of a resize.
      const moved = Math.abs(r.left - (lastLeft.get(el) ?? r.left - 1));
      lastLeft.set(el, r.left);
      if (!settle && moved >= 1 && prev && prev.dpr === dpr && prev.top === r.top && prev.height === r.height) {
        // Only the width moved (the search bar's focus morph, every frame,
        // growing from its centre, so its left edge moves too): keep the
        // patch as written, its reach measured from the box, and cut the hole
        // to it, on whole device px (a hole edge a fraction of a device px
        // off left a column the page's rectangles only partly cover: a dark
        // seam beside the bar's end, measured at a 1366 px window, 125%). No
        // style write on the element per frame while it moves fast; once it
        // moves under 1 CSS px a frame (the spring's tail, about 100 ms that
        // reads as still) every frame is the exact cut below, or the patch
        // keeps the corners it was cut with for the open bar and the arc
        // beside the rim is off until the settle (the user's 2026-11-24
        // video: a dark line at the left end for about 170 ms after the bar
        // came to rest, -7 levels, -25 on the first frame).
        const [ot, or, ob, ol] = prev.nums;
        const d = (v: number) => Math.round(v * dpr) / dpr;
        L = d(r.left - ol); T = d(r.top - ot); R = d(r.right + or); B = d(r.bottom + ob);
      } else {
        const cs = getComputedStyle(el);
        const rad = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
        // The painted edges under either snap: the outer of them (and of the
        // box itself) for the hole, the inner for the bands.
        const oL = Math.min(snapC(r.left), snapD(r.left), r.left), iL = Math.max(snapC(r.left), snapD(r.left));
        const oT = Math.min(snapC(r.top), snapD(r.top), r.top), iT = Math.max(snapC(r.top), snapD(r.top));
        const oR = Math.max(snapC(r.right), snapD(r.right), r.right), iR = Math.min(snapC(r.right), snapD(r.right));
        const oB = Math.max(snapC(r.bottom), snapD(r.bottom), r.bottom), iB = Math.min(snapC(r.bottom), snapD(r.bottom));
        L = gridDown(oL - 1) - F; T = gridDown(oT - 1) - F; R = gridUp(oR + 1) + F; B = gridUp(oB + 1) + F;
        const ot = r.top - T, or = R - r.right, ob = B - r.bottom, ol = r.left - L;
        const bt = iT - T, br = R - iR, bb = B - iB, bl = iL - L;
        // The patch's inset (from the padding box: past the border too).
        const bw = (s: string) => parseFloat(s) || 0;
        const box = [ot + bw(cs.borderTopWidth), or + bw(cs.borderRightWidth), ob + bw(cs.borderBottomWidth), ol + bw(cs.borderLeftWidth)]
          .map((v) => px(-v)).join(" ");
        // The four bands, then the four corner tiles, each opaque outside a
        // circle of the element's radius about the corner's centre, with the
        // edge's own antialiasing ramp (one device px across the radius).
        const a = 0.5 / dpr;
        const stops = `transparent ${px(Math.max(0, rad - a))}, #000 ${px(rad + a)}`;
        const mask = [
          // The feather (fx x fy over the union below), then the four bands
          // and the four corner tiles.
          ...(F ? edgeRamps(F, false).map((s) => `${s} intersect`) : []),
          `${G} 0 0 / 100% ${px(bt)} no-repeat`,
          `${G} 0 100% / 100% ${px(bb)} no-repeat`,
          `${G} 0 0 / ${px(bl)} 100% no-repeat`,
          `${G} 100% 0 / ${px(br)} 100% no-repeat`,
          `radial-gradient(circle at 100% 100%, ${stops}) 0 0 / ${px(bl + rad)} ${px(bt + rad)} no-repeat`,
          `radial-gradient(circle at 0 100%, ${stops}) 100% 0 / ${px(br + rad)} ${px(bt + rad)} no-repeat`,
          `radial-gradient(circle at 100% 0, ${stops}) 0 100% / ${px(bl + rad)} ${px(bb + rad)} no-repeat`,
          `radial-gradient(circle at 0 0, ${stops}) 100% 100% / ${px(br + rad)} ${px(bb + rad)} no-repeat`,
        ].join(", ");
        const q = patchOf(el);
        writePatch(q, box, mask, q.img);
        // The shadow's own radius, as a value (never `inherit`: a child that
        // inherits a non-inherited property makes Blink restyle every child of
        // the element whenever the element restyles, every frame of the
        // search bar's focus morph).
        if (q.radius !== cs.borderRadius) { q.radius = cs.borderRadius; q.drop.style.borderRadius = q.radius; }
        cornerGeom.set(el, { nums: [ot, or, ob, ol], top: r.top, height: r.height, dpr });
      }
      holes.push([L, T, R, B]);
      // The page bleed's share of the feather ring, at the same points.
      if (F) for (const s of edgeRamps(F, true)) tiles.push(`${s} ${px(L)} ${px(T)} / ${px(R - L)} ${px(B - T)} no-repeat`);
    }
    // The page bleed's mask: the layer minus the holes, as a union of plain
    // rectangles (bands between the holes' top and bottom edges, each split
    // around the holes it crosses; a band equal to the one above it joins it).
    if (holes.length) {
      const ys = [...new Set([0, ...holes.flatMap(([, T, , B]) => [Math.max(0, T), Math.max(0, B)])])].sort((p, q) => p - q);
      const span = (a: number, b: number) => b === Infinity ? `calc(100% - ${px(a)})` : px(b - a);
      let run: { y0: number; xs: [number, number][]; key: string } | null = null;
      const flush = (y1: number) => {
        if (!run) return;
        for (const [x0, x1] of run.xs) {
          tiles.push(`linear-gradient(#000 0 0) ${px(x0)} ${px(run.y0)} / ${span(x0, x1)} ${span(run.y0, y1)} no-repeat`);
        }
      };
      for (let k = 0; k < ys.length; k++) {
        const y0 = ys[k], y1 = k + 1 < ys.length ? ys[k + 1] : Infinity;
        if (y1 <= y0) continue;
        const cut = holes.filter(([, T, , B]) => T <= y0 && B >= y1).map(([L, , R]) => [Math.max(0, L), Math.max(0, R)] as [number, number])
          .filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
        const xs: [number, number][] = [];
        let x = 0;
        for (const [a, b] of cut) { if (a > x) xs.push([x, a]); x = Math.max(x, b); }
        xs.push([x, Infinity]);
        const key = xs.map(([a, b]) => `${a},${b}`).join(";");
        if (run && run.key === key) continue;
        flush(y0);
        run = { y0, xs, key };
      }
      flush(Infinity);
    }
    const m = tiles.join(", ");
    if (m !== lastMask.current) { lastMask.current = m; root.style.mask = m; }
  };

  // ---- build the image for the current palette / geometry -----------------
  const build = () => {
    const hero = heroRef.current;
    const root = rootRef.current;
    if (!hero || !root) return;
    let next = "none";
    let glows: ReturnType<typeof bleedGlows> | null = null;
    if (palette) {
      const r = hero.getBoundingClientRect();
      // No layout: the whole app body is display:none while a video plays
      // (App.tsx), and Home stays mounted under it. A window resize then (a
      // fullscreen switch, a move to another monitor) or a palette landing
      // built the glows around a 0 x 0 hero at the top left, and nothing
      // rebuilt them on the way back: a broken bleed and title tint until
      // the next slide. Keep the image shown and build once the hero has a
      // size again (the hero's own ResizeObserver below).
      if (r.width < 1 || r.height < 1) { deferred.current = true; return; }
      deferred.current = false;
      const scroller = hero.closest<HTMLElement>(".aura-page-scroller");
      const st = scroller?.scrollTop ?? 0;
      const W = Math.max(1, Math.round(window.innerWidth)), H = Math.max(1, Math.round(window.innerHeight));
      glows = bleedGlows({ x: r.left, y: r.top + st, w: r.width, h: r.height }, palette, W, H, BLEED_STRENGTH, MAIN_L);
      next = bleedImage(glows, W, H);
    }
    // A new image while a fade still runs WAITS for it to end, and the
    // running fade then finishes within HURRY_MS (2026-11-24;
    // the user: "occasionally an item that causes a sudden shift in color
    // instead of a gradual fade-in", every time on one slide whose palette
    // landed twice in quick succession). With two layers the new image had
    // to go on the back one, which early in a fade is the OUTGOING image,
    // still mostly shown: it was replaced in place, a jump (harness, two
    // changes 150 ms apart: one frame carried 24.7 of a 32.8 level shift).
    // Only the newest waiting image is kept. Waiting out the whole fade
    // (up to 0.9 s) made the bleed trail the slides when clicking through
    // them (the user: "the delay seems to still be happening, somewhat
    // inconsistently"); hurried, the new image starts within 200 ms and
    // the hurried stretch moves at most about 1/12 of the change per 60 Hz
    // frame (a jump moved 3/4 in one).
    if (fading.current) {
      if (queued.current && queued.current.next !== next) releaseSvgImage(queued.current.next);
      queued.current = { next, glows };
      return;
    }
    swap(next, glows);
  };
  const swap = (next: string, glows: ReturnType<typeof bleedGlows> | null) => {
    setBleedTint(next === "none" ? null : glows, BLEED_STRENGTH);
    const cur = urls.current[front.current];
    if (next === cur) return;
    dimAmbient(next !== "none");
    // The new image goes on the back layer, which then fades in over the old.
    const back = 1 - front.current;
    // The back layer's old image is two slides old: nothing shows it now.
    const stale = urls.current[back];
    urls.current[back] = next;
    const nb = layerRefs[back].current;
    if (nb) nb.style.backgroundImage = next;
    if (stale !== cur) releaseSvgImage(stale);
    const oldFront = front.current;
    front.current = back;
    // One clock for the page layers, the face crops and the corner patches
    // (the `ease` curve over CROSSFADE_MS, from wherever an interrupted fade
    // had got to), a short rAF loop; nothing runs once it ends.
    cancelAnimationFrame(mixRaf.current);
    const reduced = document.documentElement.getAttribute("data-reduced-motion") === "true";
    const sIn = op.current[back], sOut = op.current[oldFront];
    const set = (e: number) => {
      op.current[back] = sIn + (1 - sIn) * e;
      op.current[oldFront] = sOut * (1 - e);
      mix.current = e;
      paintLayers();
      paintFaces();
    };
    // From no bleed too: the bleed's first appearance on Home fades in over
    // CROSSFADE_MS, as the old CSS opacity transition did.
    if (reduced) { set(1); cutHoles(); return; }
    set(0);
    fading.current = true;
    let t0 = -1, last = 0, hurryAt = -1, hurryFrom = 0;
    const step = (t: number) => {
      if (t0 < 0) t0 = t;
      let e = ease((t - t0) / CROSSFADE_MS);
      // A newer image is waiting (build): finish this fade over HURRY_MS
      // from where it is, linearly, so the new one starts within that.
      if (queued.current) {
        if (hurryAt < 0) { hurryAt = t; hurryFrom = last; }
        e = Math.max(e, hurryFrom + (1 - hurryFrom) * Math.min(1, (t - hurryAt) / HURRY_MS));
      }
      last = e;
      set(e);
      if (e < 1) { mixRaf.current = requestAnimationFrame(step); return; }
      fading.current = false;
      const q = queued.current;
      queued.current = null;
      if (q) swap(q.next, q.glows);
    };
    mixRaf.current = requestAnimationFrame(step);
    cutHoles();
  };
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => { buildRef.current(); }, [palette]);

  // Geometry: window resize (debounced) rebuilds; marked elements resizing
  // (the search bar's focus morph) move the holes; focus moves the dim.
  // A hole must follow its element's POSITION too, and an element can move
  // without resizing: the Home search bar sits in a column capped at
  // --hero-max-w and centred (mx-auto) inside a container whose right padding
  // carries the page scrollbar's width (HomeView), so when the rows fill the
  // page and the scrollbar appears (10 px), the bar slides 5 px left at the
  // same size. Observing the element alone missed that: the hole stayed where
  // it was cut and the window behind showed through as a dark crescent past
  // the bar's right end, until a slide change cut the holes again (the user's
  // "weird black section of the search bar"). So every ancestor up to the
  // bleed's host is observed as well (content box: a padding change fires):
  // whatever moves a marked element without resizing it resizes one of them.
  // Only real size changes fire; each callback is one cut per frame, before
  // the paint (the cheap one: see cutHoles), and an exact one after the last.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      cutHoles();
      if (t) clearTimeout(t);
      t = setTimeout(() => buildRef.current(), 200);
    };
    // Per frame of a resize (the focus morph): the cheap cut; 150 ms after
    // the last one, the exact cut (the patch's snapped bands).
    let settleT: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      cutHoles(false);
      if (settleT) clearTimeout(settleT);
      settleT = setTimeout(() => cutHoles(), 150);
    });
    let watched: HTMLElement[] = [];
    const watch = () => {
      const now = Array.from(document.querySelectorAll<HTMLElement>(BLEED_SELECTOR));
      if (now.length === watched.length && now.every((el, i) => el === watched[i])) return false;
      watched = now;
      ro.disconnect();
      const host = rootRef.current?.parentElement ?? null;
      const seen = new Set<Element>();
      for (const el of now) {
        ro.observe(el);
        for (let a = el.parentElement; a && a !== host && a !== document.documentElement; a = a.parentElement) {
          // A shared ancestor (and so everything above it) is observed already.
          if (seen.has(a)) break;
          seen.add(a);
          ro.observe(a);
        }
      }
      return true;
    };
    watch();
    // A marked element mounting later is picked up: DOM changes are coalesced
    // into one check per frame, which acts only when the set changed.
    let moRaf = 0;
    const mo = new MutationObserver(() => {
      if (moRaf) return;
      moRaf = requestAnimationFrame(() => {
        moRaf = 0;
        if (watch()) { cutHoles(); paintFaces(); }
      });
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-glass-bleed", "data-aura-rail"] });
    // A build skipped while the hero had no layout runs when it gets one back
    // (it fires on the way out of display:none); nothing otherwise.
    const heroRo = new ResizeObserver(() => {
      if (deferred.current) buildRef.current();
    });
    if (heroRef.current) heroRo.observe(heroRef.current);
    const onFocus = () => paintFaces();
    window.addEventListener("resize", onResize);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
      if (t) clearTimeout(t);
      if (settleT) clearTimeout(settleT);
      ro.disconnect();
      heroRo.disconnect();
      mo.disconnect();
      cancelAnimationFrame(moRaf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll fade: 1 at the top, down to BLEED_FLOOR once the hero (plus 60 px)
  // has scrolled away; 0.02 steps, so a long scroll writes ~35 values.
  useEffect(() => {
    const hero = heroRef.current;
    const scroller = hero?.closest<HTMLElement>(".aura-page-scroller");
    if (!hero || !scroller) return;
    const onScroll = () => {
      const span = hero.offsetHeight + 60;
      const v = 1 - Math.min(1 - BLEED_FLOOR, Math.max(0, scroller.scrollTop / Math.max(1, span)));
      const q = Math.round(v * 50) / 50;
      // The titles move with every scroll, so they re-read even when the fade
      // holds (bleedTint.ts coalesces and waits out a user-driven scroll).
      setBleedFade(q);
      // The hero moves under the search bar with every scroll step: when an
      // element changes sides, its hole and face change in this same frame.
      const moved = measureOverHero();
      if (moved) cutHoles();
      if (q === fade.current && !moved) return;
      fade.current = q;
      paintLayers();
      paintFaces();
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [heroRef]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A copy of the bleed's root, made the moment Home starts unmounting (see
   *  the layout effect below), that carries the fade-out. */
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // A HeroBleed still fading out from the last visit to Home hands its shared
  // state over now, before this one paints (layout effects run before the
  // build's passive effect), and keeps fading only its own page layers.
  //
  // Its cleanup copies the bleed's root into the shell right beside the
  // original, in the commit that unmounts Home, before React removes the
  // original: so whenever the passive cleanup below runs (a click flushes it
  // before the paint; a navigation from a timer or an event may flush it one
  // frame later), the same picture is on screen in between. The passive
  // cleanup then fades the copy out, or drops it at once when nothing was
  // unmounted after all (a StrictMode re-run in dev keeps the original, and
  // all of it runs before any paint).
  useLayoutEffect(() => {
    mounted++;
    leaving?.handOver();
    const rootEl = rootRef.current;
    return () => {
      mounted--;
      ghostRef.current = null;
      const html = document.documentElement;
      const showing = urls.current.some((u, i) => u !== "none" && shown.current[i] > 0.001);
      if (
        !rootEl || !rootEl.isConnected || !showing
        || html.getAttribute("data-reduced-motion") === "true"
        || html.classList.contains("playing-video")
      ) return;
      const ghost = rootEl.cloneNode(true) as HTMLDivElement;
      rootEl.after(ghost);
      ghostRef.current = ghost;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Unmount: take the face crops and patches off again. On a real unmount the
  // bleed fades out over LEAVE_MS first (leaveFade, on the copy above); a
  // StrictMode re-run in dev and reduced motion take it off at once.
  const teardown = () => {
    cancelAnimationFrame(mixRaf.current);
    dimAmbient(false);
    setBleedTint(null, BLEED_STRENGTH);
    for (const el of document.querySelectorAll<HTMLElement>(BLEED_SELECTOR)) {
      clearFace(el);
      cornerGeom.delete(el);
    }
    for (const q of patches.values()) { q.fill.remove(); q.drop.remove(); }
    patches.clear();
    releaseSvgImage(urls.current[0]);
    releaseSvgImage(urls.current[1]);
    if (queued.current) releaseSvgImage(queued.current.next);
    queued.current = null;
    // Leave the refs as a fresh mount would find them. The same instance can
    // mount again: StrictMode in dev runs every effect, its cleanup, then the
    // effect again. Left as they were, `fading` stayed true with its rAF
    // cancelled above, so every later build queued behind a fade that never
    // ended, and the layers kept the urls just revoked: no bleed at all after
    // coming back to Home (the palette is cached then, so the very first
    // build already started a fade before the StrictMode cleanup).
    fading.current = false;
    urls.current = ["none", "none"];
    front.current = 0;
    op.current = [0, 0];
    shown.current = [0, 0];
    mix.current = 1;
    lastMask.current = "";
    deferred.current = false;
    for (const l of layerRefs) {
      if (l.current) { l.current.style.backgroundImage = ""; l.current.style.opacity = "0"; }
    }
  };

  /** The fade-out after Home unmounted, on the copy of the root (unmanaged by
   *  React), with the refs pointed at it: the painters then work on it exactly
   *  as they did on the original, and only the scroll-fade factor moves, from
   *  where it was to 0. That one factor scales the page layers, the rail's
   *  face crop and its corner patch together, the same way the scroll fade
   *  does, so they cannot drift apart. */
  const leaveFade = (rootEl: HTMLDivElement) => {
    leaving?.finish();
    // A slide change in flight stops where it is and fades out as it stands.
    cancelAnimationFrame(mixRaf.current);
    fading.current = false;
    if (queued.current) { releaseSvgImage(queued.current.next); queued.current = null; }
    const f0 = fade.current;
    const opAt: [number, number] = [op.current[0], op.current[1]];
    const ghostLayers = [rootEl.children[0], rootEl.children[1]] as (HTMLElement | undefined)[];
    let raf = 0, t0 = -1;
    /** Handed over: a new HeroBleed owns the shared state now (the rail's
     *  face and patch, the tint, the sweep dim), and this copy only fades its
     *  own two layers, holding the urls they show until it ends. */
    let alone = false;
    let kept: string[] = [];
    const end = () => {
      cancelAnimationFrame(raf);
      if (leaving === handle) leaving = null;
      rootEl.remove();
      if (alone) { for (const u of kept) releaseSvgImage(u); kept = []; }
      else teardown();
    };
    const handOver = () => {
      if (alone) return;
      alone = true;
      if (leaving === handle) leaving = null;
      kept = [...urls.current];
      urls.current = ["none", "none"];
      // Detach the refs first, so teardown's reset leaves the copy's layers.
      rootRef.current = null;
      layerRefs[0].current = null;
      layerRefs[1].current = null;
      teardown();
    };
    /** `finish` ends it now (a later leave); `handOver` keeps the page layers
     *  fading under the new bleed, so coming back to Home mid-fade, or the
     *  carousel remounting on a new source while Home stays, crossfades
     *  instead of dropping to nothing (or, the remount case, instead of this
     *  fade's teardown later wiping the new bleed's rail and search-bar
     *  state: review 2026-11-24). */
    const handle = { finish: end, handOver };
    leaving = handle;
    if (mounted > 0) {
      // Another HeroBleed is already mounted (the carousel remounted in this
      // same commit, Home still up). Passive unmounts run before passive
      // mounts, so this hands over before its first build.
      handOver();
    } else {
      rootRef.current = rootEl;
      layerRefs[0].current = (ghostLayers[0] ?? null) as HTMLDivElement | null;
      layerRefs[1].current = (ghostLayers[1] ?? null) as HTMLDivElement | null;
      // The row titles left with Home. The sweep starts its own 900 ms
      // return from the 30% dim now, in step with this.
      setBleedTint(null, BLEED_STRENGTH);
      dimAmbient(false);
      // Only the rail is left to cut a hole for: the search bar's hole went
      // with Home, and left in the mask it would show as a dark box.
      cutHoles();
    }
    const step = (t: number) => {
      if (t0 < 0) t0 = t;
      const e = ease((t - t0) / LEAVE_MS);
      if (alone) {
        for (let i = 0; i < 2; i++) {
          const l = ghostLayers[i];
          if (l) l.style.opacity = String(Math.round(opAt[i] * f0 * (1 - e) * 10000) / 10000);
        }
      } else {
        fade.current = f0 * (1 - e);
        paintLayers();
        paintFaces();
      }
      if (e < 1) { raf = requestAnimationFrame(step); return; }
      end();
    };
    raf = requestAnimationFrame(step);
  };

  useEffect(() => {
    const rootEl = rootRef.current;
    return () => {
      const ghost = ghostRef.current;
      ghostRef.current = null;
      // React removes a real unmount's portal before this runs; a StrictMode
      // re-run leaves it in place.
      if (ghost && rootEl && !rootEl.isConnected) { leaveFade(ghost); return; }
      ghost?.remove();
      teardown();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (typeof document === "undefined") return null;
  // The shell is mounted for as long as Home is (the hero renders inside it);
  // <body> is only a fallback (there the theme background covers it again).
  const host = document.querySelector<HTMLElement>(".aura-app-shell") ?? document.body;
  return createPortal(
    <div ref={rootRef} aria-hidden className="aura-hero-bleed">
      <div ref={layerRefs[0]} className="aura-hero-bleed-layer" />
      <div ref={layerRefs[1]} className="aura-hero-bleed-layer" />
    </div>,
    host,
  );
}
