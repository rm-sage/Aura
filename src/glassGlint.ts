// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// glassGlint.ts: the cursor light (round 9, the "Obsidian" A direction).
// Both materials, setting `glassCursorGlow` (default on), never on the High
// Contrast themes (glassStyle.ts decides; <html data-glass-glint-mode>).
//
// Every surface within REACH (--lg-rim-r, 300 px) of the pointer is lit, not
// only the one under it (with hardware acceleration off: the hovered one and
// its nearest glass ancestor only). A lit surface gets two lights:
//
//   - the INTERIOR light (glass panels and controls, not rim-only surfaces):
//     a white radial of radius R = --lg-rim-r at the pointer, peak
//     --lg-light-peak (3.5%), falling linearly to 10.7% of it at 0.6 R and to
//     0 at R (the brief's profile; it replaced round 7's accent Gaussian
//     "rolling hill"). It is a dithered IMAGE (lightImage below): the 8-bit
//     compositor has no dither, so a CSS gradient of a 3.5% light bands into
//     1-code rings; the noise is summed into the SAME feComposite as the light
//     so the one rounding is dithered. ONE 2R x 2R image serves every surface
//     (the peak is per tier, equal today), placed at the pointer, which may be
//     outside the surface: the light then spills in from the near edge.
//   - the RIM light: the `aura-rim` paint worklet (public/aura-glass-rim.js)
//     draws a 1px ring with a crisp cool specular glint on the rim point
//     nearest the pointer (round 12), a soft tail around the pointer and a
//     bounce on the opposite edge, with chromatic dispersion and a soft 2px
//     halo inside (round 11); the corner arcs are drawn as bright as the
//     straight edges (round 12). The same worklet draws the
//     IDLE rim (corner-anchored radials) on surfaces that have one, which is
//     plain CSS (App.css), not this file: it stays with Cursor glow off.
//
// The pointer is LIVE while it is over the window, moving or resting (the
// mockup the user tuned keeps the light under a resting pointer; a resting
// pointer runs nothing, the light only repaints when something moves). Gone
// from the window or with the window blurred for IDLE_MS it is idle: every
// light fades out and <html data-glass-light-live> is removed, which lifts the
// idle rim from 0.62 back to full (App.css --lg-idle-k).
//
// What is written, on lit (or fading) elements only:
//   --gx / --gy     the smoothed pointer, px from the border box's top-left
//                   (NOT clamped: it may lie outside the element)
//   --gnx / --gny   its direction from the centre, clamped to -1..1
//                   (dispersion offset)
//   --lg-glint-a    the fade, 0..1, written by ONE rAF fade loop (260 ms
//                   ease-out cubic in, 600 ms in-out sine out). Never WAAPI or
//                   a CSS transition: a box-shadow transition's base style
//                   cannot see an animated value.
//   --lg-glint-img, --gw / --gh, --gr   the interior image, its half size
//                   (R) and the CSS fallback gradient's radius (R)
//   data-glint-lit  present while lit or fading
//
// Contract for other surfaces (Home catalog cards, badges): put
// `data-glass-light="rim"` on an element whose BACKGROUND can carry the ring
// (typically an absolutely positioned overlay, `inset: 0`, `border-radius:
// inherit`, `pointer-events: none`, above the art). App.css gives it the
// `paint(aura-rim) border-box` background; this file finds it, measures it
// and lights it like any glass. Idle rim strengths are optional per-element
// tokens (--lg-idle-tl / -mid / -br). `data-glass-light="panel" | "control"`
// on a glass element picks its interior-light tier explicitly. Rim-only
// surfaces cost one ring repaint per frame while in reach and nothing else.
//
// TEXT surfaces (round 11): `data-glass-light="text"` on a text element (the
// Home row titles, `.aura-row-title`) gets the same position writes and fade
// and no image; its own CSS draws a background-clip:text radial at --gx / --gy
// that brightens the glyphs near the pointer. Cheap like a rim surface (one
// text repaint per frame while in reach).
//
// The user's TUNING (Settings > Theme under Cursor glow, AuraSettings
// glassGlowTune: Edge highlights, Surface glow, Glow size) is applied here
// (applyGlowTune): three inline custom properties on <html>, written only
// when they differ from the default and only on a settings change or a
// slider preview (a root write restyles the document once, never per frame),
// then the interior image is rebuilt for the lit surfaces. The image cache
// is keyed on R and the peak, so it follows the tune (bounded, IMG_CAP).
//
// Cost model:
//   - ONE passive window pointermove listener; it stores the point and asks
//     for at most one animation frame.
//   - The candidate list (querySelectorAll(LIGHT_SELECTOR)) is rebuilt only
//     after a DOM change that adds, removes or (re)classes a candidate (one
//     MutationObserver on <body>, which only sets a flag; an ordinary class
//     flip on a non-candidate, a row's is-on, a toast, is ignored); their rects are re-read only
//     after a scroll, a resize, that rebuild, or every STALE_MS while the
//     pointer moves (catches transform-driven motion). A frame then costs a
//     distance test per candidate (math only) plus a fresh rect and four
//     writes for each element in reach (at most MAX_LIT), and a value is
//     written only when it changed.
//   - While the smoothed light still trails the pointer it asks for another
//     frame; settled, nothing runs. Idle, nothing runs.
//   - The fade loop runs only while a fade is in progress.
//   - Round 12 (frame rate with Cursor glow on): a surface out of sight
//     (IntersectionObserver) is never lit; a user-driven scroll holds the
//     light even while the pointer moves; the light runs at most once per
//     LIGHT_MIN_MS (every other frame at 240 Hz); far surfaces take their
//     position in coarser steps (LOD_*). Each light frame repaints and
//     re-rasters every lit surface, so these are the levers.
//   - Every written property is @property-registered NON-INHERITING (App.css),
//     so a write restyles the lit element alone, never its subtree.

import { getGlassState, subscribeGlass } from "./glassStyle";
import {
  DEFAULT_GLASS_GLOW_TUNE,
  loadAuraSettings,
  sanitizeGlassGlowTune,
  settingsChangeIncludes,
  type AuraSettings,
  type GlassGlowKey,
  type GlassGlowTune,
} from "./auraSettings";

/** Every glass element that can carry the light. App.css paints it from the
 *  same list (`--lg-glint` in the GLASS SYSTEM block). `[data-glass-glint]`
 *  opts in any other element whose background includes var(--lg-glint). */
export const GLINT_SELECTOR =
  ".aura-float-glass, .aura-glass-control, .aura-glass-flat, .aura-glass-field, .aura-glass-player, [data-glass-glint]:not(html)";
/** Every surface the light registry measures: the glass above plus any
 *  `[data-glass-light]` surface (rim-only cards and badges). */
export const LIGHT_SELECTOR = `${GLINT_SELECTOR}, [data-glass-light]:not(html)`;

/** Inline properties the light writes; all removed when a fade-out ends. */
const GLINT_PROPS = ["--gx", "--gy", "--gr", "--gw", "--gh", "--gnx", "--gny", "--lg-glint-a", "--lg-glint-img"] as const;
const LIT_ATTR = "data-glint-lit";
const LIVE_ATTR = "data-glass-light-live";
/** Full fade in / out; a partial fade takes its share of these. */
const FADE_IN_MS = 260;
const FADE_OUT_MS = 600;
const easeIn = (p: number) => 1 - (1 - p) ** 3;
/** In-out sine: an ease-out lost half the light in the first fifth (a cut). */
const easeOut = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);
/** Position smoothing time constant (ms): about 63% of the gap per 70 ms. */
const SMOOTH_MS = 70;
const MAX_DT_MS = 50;
/** A pointer gone from the window (or a blurred window) this long is idle:
 *  the lights fade and the idle rim returns. A resting pointer stays live. */
const IDLE_MS = 1000;
/** Candidate rects older than this are re-read on the next moving frame. */
const STALE_MS = 500;
/** The candidate list is re-queried at most this often after DOM changes. */
const LIST_MIN_MS = 100;
/** At most this many surfaces lit at once (the nearest win), and of them at
 *  most MAX_LIT_GLASS full glass surfaces: a glass element's style recalc is
 *  the expensive part of a frame (its var()-built background, box-shadow
 *  and backdrop-filter are re-resolved: about 0.2 ms each per frame,
 *  measured, against about 0.03 ms for a rim-only card overlay). */
const MAX_LIT = 64;
const MAX_LIT_GLASS = 12;
/** Level of detail for the position writes (lightStep): whole pixels while
 *  the pointer is within LOD_NEAR x the reach of a surface, then steps
 *  growing to LOD_MAX_STEP px at the edge of the reach. */
const LOD_NEAR = 0.25;
const LOD_MAX_STEP = 10;
/** The light's frame interval floor (ms): every frame on displays up to
 *  about 220 Hz, every other frame at 240 Hz (4.17 ms < 4.5). The floor sits
 *  well away from every common refresh interval (165 Hz 6.06, 180 Hz 5.56,
 *  240 Hz 4.17 and 8.33 ms for the frame after a skip), so rAF timestamp
 *  jitter never flips a display between running and skipping (a 5.5 ms floor
 *  sat on the 170 to 180 Hz intervals and gave an irregular cadence). */
const LIGHT_MIN_MS = 4.5;
/** Memoised light images (string building only; the raster is the browser's). */
const IMG_CAP = 8;
/** Gradient stops for the light's profile (linear segments; exact here, since
 *  the profile itself is piecewise linear). */
const STOPS = 20;

/** The brief's profile, 0..1 at t = r / R: 1 to 0.107 at 0.6, then to 0 at 1. */
const profile = (t: number) =>
  t < 0.6 ? 1 - 0.893 * (t / 0.6) : t < 1 ? 0.107 * (1 - (t - 0.6) / 0.4) : 0;

/** The interior light: the profile over radius R, centred in a 2R x 2R image,
 *  with zero-mean noise summed in the SAME arithmetic feComposite:
 *  out = peak * light + dither * (n - 0.5). That primitive is the only
 *  rounding to 8 bits, so the noise dithers it (a grain on its own layer
 *  cannot: each layer rounds on its own). fractalNoise at 0.7 is near-white
 *  (sd 0.108 around 0.5); 0.012 to 0.02 measured best, 0.03 reads as noise.
 *  The gradient is FULL range and scaled by `peak` inside the composite, so its
 *  own rasterisation error is scaled down with it. */
export function lightImage(R: number, peak: number, dither: number, rgb: string): string {
  return svgImageUrl(lightSvg(R, peak, dither, rgb));
}

/** A CSS url() for an SVG document: a SHORT `blob:` url where possible.
 *  Every glass `background` is a var()-substituted shorthand, which the
 *  engine re-tokenises on every style recalc of the element; a multi-KB
 *  `data:` url in it made each lit element's per-frame recalc cost 0.5 to
 *  1.8 ms (measured, round 9), a blob url a few microseconds. A blob url
 *  must be revoked once nothing shows it (releaseSvgImage). */
export function svgImageUrl(svg: string): string {
  try {
    if (typeof URL.createObjectURL === "function") {
      return `url("${URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))}")`;
    }
  } catch { /* fall through to a data url */ }
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
/** Revoke a url from svgImageUrl (a no-op for a data url or "none"). */
export function releaseSvgImage(css: string | null | undefined): void {
  const m = css && /^url\("(blob:[^"]+)"\)$/.exec(css);
  if (m) URL.revokeObjectURL(m[1]);
}

function lightSvg(R: number, peak: number, dither: number, rgb: string): string {
  let stops = "";
  for (let i = 0; i <= STOPS; i++) {
    const t = i / STOPS;
    stops += `<stop offset='${t.toFixed(3)}' stop-color='rgb(${rgb})' stop-opacity='${profile(t).toFixed(4)}'/>`;
  }
  const s = 2 * R;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'>`
    + `<radialGradient id='g' gradientUnits='userSpaceOnUse' cx='${R}' cy='${R}' r='${R}'>${stops}</radialGradient>`
    + `<filter id='d' x='0' y='0' width='1' height='1' color-interpolation-filters='sRGB'>`
    + `<feTurbulence type='fractalNoise' baseFrequency='0.7' seed='5'/>`
    + `<feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0'/>`
    + `<feComposite in='SourceGraphic' operator='arithmetic' k2='${peak.toFixed(4)}' k3='${dither.toFixed(4)}' k4='${(-dither / 2).toFixed(4)}'/>`
    + `</filter><rect width='100%' height='100%' fill='url(#g)' filter='url(#d)'/></svg>`;
  return svg;
}

/** The rim worklet, registered once per document. */
let workletAdded = false;
function addRimWorklet(): void {
  if (workletAdded) return;
  workletAdded = true;
  const pw = (globalThis.CSS as unknown as { paintWorklet?: { addModule(url: string): Promise<void> } } | undefined)?.paintWorklet;
  if (!pw) return;
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  // Same origin (the CSP allows worklet modules from 'self' only).
  pw.addModule(`${base}aura-glass-rim.js`).catch(() => { /* no rim light; the interior light still works */ });
}

/** The device pixel ratio for the rim worklet (round 14): the rim is a
 *  hairline one device pixel wide, and a paint worklet's own
 *  devicePixelRatio reads 1 here at any display scale (measured at 150%), so
 *  it reads `--lg-dpr` from <html> instead. Written inline only when it is
 *  not 1, and again only when the ratio changes (display scale, a monitor
 *  move, zoom): a root write restyles the document once. One media query
 *  listener, re-armed per change; the returned function removes it. */
function trackDevicePixelRatio(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let mq: MediaQueryList | null = null;
  let last = "";
  const write = () => {
    const dpr = Math.round((window.devicePixelRatio || 1) * 1000) / 1000;
    const v = String(dpr);
    if (v !== last) {
      last = v;
      const root = document.documentElement.style;
      if (dpr === 1) root.removeProperty("--lg-dpr");
      else root.setProperty("--lg-dpr", v);
    }
    mq?.removeEventListener("change", write);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", write);
  };
  write();
  return () => { mq?.removeEventListener("change", write); mq = null; };
}

// ---- the user's tuning -----------------------------------------------------

/** The root properties the tuning writes (App.css :root holds the defaults). */
const TUNE_VARS: { key: GlassGlowKey; prop: string; unit: string }[] = [
  { key: "edge", prop: "--lg-glow-edge-k", unit: "" },
  { key: "surface", prop: "--lg-glow-surface-k", unit: "" },
  { key: "size", prop: "--lg-rim-r", unit: "px" },
];
/** The installed light's re-read hook (null when not installed). */
let onTuneChanged: (() => void) | null = null;
let lastTuneKey = "";
let previewRaf = 0;
let previewPending: GlassGlowTune | null = null;

/** Writes a tune onto <html>: a value at its default is REMOVED (the App.css
 *  default applies), so an untouched install writes nothing on the root.
 *  No-op when unchanged; then the lit surfaces re-read it. */
function applyGlowTune(t: GlassGlowTune): void {
  if (typeof document === "undefined") return;
  const key = `${t.edge}:${t.surface}:${t.size}`;
  if (key === lastTuneKey) return;
  lastTuneKey = key;
  const root = document.documentElement.style;
  for (const v of TUNE_VARS) {
    if (t[v.key] === DEFAULT_GLASS_GLOW_TUNE[v.key]) root.removeProperty(v.prop);
    else root.setProperty(v.prop, `${t[v.key]}${v.unit}`);
  }
  onTuneChanged?.();
}

/** Live preview while a Settings slider drags (at most one root write per
 *  frame); `null` puts the stored tune back (a cancelled drag). The commit is
 *  an ordinary settings save, which applies through the change event. */
export function previewGlassGlow(t: GlassGlowTune | null): void {
  if (t === null) {
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
    previewPending = null;
    applyGlowTune(sanitizeGlassGlowTune(loadAuraSettings().glassGlowTune));
    return;
  }
  previewPending = sanitizeGlassGlowTune(t);
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    if (previewPending) applyGlowTune(previewPending);
    previewPending = null;
  });
}

/** One element's fade: `from` to `to` over `dur` ms from `t0`. */
interface Fade { from: number; to: 0 | 1; t0: number; dur: number; done: boolean }
/** What a lit element was last written (writes are skipped when unchanged). */
interface Lit { img: string; tier: Tier; gx: string; gy: string; gnx: string; gny: string }
/** "rim" and "text" surfaces take no interior image. */
type Tier = "rim" | "text" | "panel" | "control";
const imageless = (t: Tier) => t === "rim" || t === "text";

export function installGlassGlint(): () => void {
  addRimWorklet();
  const stopDpr = trackDevicePixelRatio();
  let enabled = getGlassState().glint;
  /** Hardware acceleration off: hover only (the element under the pointer and
   *  its nearest glass ancestor), as before round 9. */
  let nearby = !getGlassState().gpuOff;
  let lit: HTMLElement[] = [];
  let raf = 0;
  /** The light still has to move (pointer moved, or trailing, or a scroll). */
  let moving = false;
  let px = 0, py = 0;
  let sx = 0, sy = 0;
  let lastT = 0;
  let snap = true;
  let live = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const fades = new Map<HTMLElement, Fade>();
  const written = new Map<HTMLElement, Lit>();
  const images = new Map<string, string>();
  let tune = { R: 300, peakCtl: 0.035, peakPanel: 0.035, dither: 0.014, rgb: "255,255,255" };
  let tuned = false;

  // ---- candidate registry ------------------------------------------------
  let cands: HTMLElement[] = [];
  /** The same candidates as a set, for the MutationObserver's filter. */
  let candSet = new Set<HTMLElement>();
  let rects: DOMRect[] = [];
  /** Per candidate: drawn at all (own opacity above 0, not visibility:
   *  hidden). A transparent surface is never lit (round 11): the Home hero
   *  arrows and the CW remove buttons are `opacity-0` until hovered, and lit
   *  anyway they were repainted and re-rastered on every pointer frame for
   *  nothing (measured on Home, 2575 x 1038: pointer-move frames 94 fps with
   *  them lit, 165 with the arrows gone). Re-read with the rects and on
   *  every pointerover (a hover reveal is usually a :hover rule). Read
   *  LAZILY: only a candidate within reach is asked (undefined = not read
   *  since the last reset), so a pointerover on a dense page (Settings,
   *  Library's poster bezels, the Calendar) costs a computed-style read per
   *  NEARBY candidate, never one per candidate. */
  let shown: (boolean | undefined)[] = [];
  let shownDirty = true;
  const rectOf = new Map<HTMLElement, DOMRect>();
  let lastList = -Infinity;
  /** A lit element resizing (the search bar's width morph) re-measures. */
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
      // Only a real size change (observe() itself reports the current size).
      for (const e of entries) {
        const r = rectOf.get(e.target as HTMLElement);
        const b = e.borderBoxSize?.[0];
        if (!r || !b || Math.abs(b.inlineSize - r.width) > 0.5 || Math.abs(b.blockSize - r.height) > 0.5) {
          rectsDirty = true;
          kick();
          return;
        }
      }
    })
    : null;
  let listDirty = true;
  let rectsDirty = true;
  let lastMeasure = 0;
  /** Per candidate: false once an IntersectionObserver (implicit root, so
   *  clipped by every scrolling ancestor) reports it outside the visible
   *  page; undefined until the first report (treated as visible). Round 12
   *  performance: the reach is a distance to the BOX, so the poster row
   *  under the fold (inside the page scroller's clip, out of sight) was lit
   *  and repainted on every pointer frame while the pointer moved over the
   *  Continue Watching row, re-rastering tiles nobody could see. */
  const inView = new WeakMap<Element, boolean>();
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        if (inView.get(e.target) !== e.isIntersecting) { inView.set(e.target, e.isIntersecting); changed = true; }
      }
      // During a user-driven scroll the lights hold still (see onScroll);
      // the settle re-lights with the new visibility.
      if (changed && !document.documentElement.hasAttribute("data-aura-scrolling")) kick();
    })
    : null;
  const hidden = (el: Element) => inView.get(el) === false;

  let colourRaw = "";
  let colourCanvas: CanvasRenderingContext2D | null | undefined;
  /** --lg-glint-c as sRGB bytes (a 1 px canvas resolves any CSS colour). */
  const resolveColour = (raw: string): string => {
    if (raw === colourRaw) return tune.rgb;
    colourRaw = raw;
    try {
      if (colourCanvas === undefined) {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        colourCanvas = c.getContext("2d", { willReadFrequently: true });
      }
      const g = colourCanvas;
      if (!g || !raw) return "255,255,255";
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = "#fff";
      g.fillStyle = raw;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    } catch {
      return "255,255,255";
    }
  };
  /** The tunables, read when the pointer goes live (re-move after a live edit). */
  const readTune = () => {
    const cs = getComputedStyle(document.documentElement);
    const num = (name: string, dflt: number) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : dflt;
    };
    // Surface glow (the user's tune) scales both interior peaks; it is baked
    // into the image, so the image cache keys on it through the peak.
    const k = Math.max(0, Math.min(4, num("--lg-glow-surface-k", DEFAULT_GLASS_GLOW_TUNE.surface)));
    tune = {
      R: Math.round(Math.max(40, Math.min(800, num("--lg-rim-r", 300)))),
      peakCtl: Math.max(0, Math.min(0.5, num("--lg-light-peak-ctl", 0.035) * k)),
      peakPanel: Math.max(0, Math.min(0.5, num("--lg-light-peak-panel", 0.035) * k)),
      dither: Math.max(0, Math.min(0.1, num("--lg-glint-dither", 0.014))),
      rgb: resolveColour(cs.getPropertyValue("--lg-glint-c").trim()),
    };
    tuned = true;
  };
  const imageFor = (peak: number): string => {
    // A zero peak (Surface glow at 0%) needs no image at all.
    if (!(peak > 0)) return "";
    const key = `${tune.R}:${peak}:${tune.dither}:${tune.rgb}`;
    let url = images.get(key);
    if (url) images.delete(key);
    else url = lightImage(tune.R, peak, tune.dither, tune.rgb);
    images.set(key, url);
    // An evicted image is revoked only when no lit or fading element still
    // shows it (a tune change is the only way to evict, so this is rare).
    while (images.size > IMG_CAP) {
      const [k, old] = images.entries().next().value as [string, string];
      images.delete(k);
      let used = false;
      for (const w of written.values()) if (w.img === old) { used = true; break; }
      if (!used) releaseSvgImage(old);
    }
    return url;
  };
  /** The interior light's tier: none for rim-only surfaces; panel for the
   *  menu tier and big surfaces; control otherwise. */
  const tierOf = (el: HTMLElement, r: DOMRect): Tier => {
    const a = el.getAttribute("data-glass-light");
    if (a === "rim" || a === "text" || a === "panel" || a === "control") return a;
    if (el.classList.contains("aura-float-glass") && !el.classList.contains("aura-glass-control")) return "panel";
    return Math.min(r.width, r.height) >= 150 && Math.max(r.width, r.height) > 300 ? "panel" : "control";
  };

  const reducedMq = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  const reduced = () => {
    const a = document.documentElement.getAttribute("data-reduced-motion");
    if (a === "true") return true;
    if (a === "false") return false;
    return !!reducedMq?.matches;
  };

  const levelAt = (f: Fade, now: number) => {
    const p = Math.min(1, Math.max(0, (now - f.t0) / f.dur));
    return f.from + (f.to - f.from) * (f.to > f.from ? easeIn(p) : easeOut(p));
  };

  const drop = (el: HTMLElement) => {
    fades.delete(el);
    written.delete(el);
    ro?.unobserve(el);
    el.removeAttribute(LIT_ATTR);
    for (const p of GLINT_PROPS) el.style.removeProperty(p);
  };

  /** Writes --lg-glint-a on every fading element; true while any fade runs. */
  const fadeStep = (now: number): boolean => {
    let running = false;
    for (const [el, f] of fades) {
      if (f.done) continue;
      // Out of sight (scrolled away mid-fade): nothing to show, so no
      // repaint for the rest of the fade.
      if (!el.isConnected || hidden(el)) { drop(el); continue; }
      const end = now - f.t0 >= f.dur;
      if (end && f.to === 0) { drop(el); continue; }
      el.style.setProperty("--lg-glint-a", (end ? f.to : levelAt(f, now)).toFixed(4));
      if (end) f.done = true;
      else running = true;
    }
    return running;
  };

  const fadeTo = (el: HTMLElement, to: 0 | 1) => {
    const now = performance.now();
    const f = fades.get(el);
    const from = f ? levelAt(f, now) : 0;
    if (to === 0 && from <= 0.001) { drop(el); return; }
    const span = Math.abs(to - from);
    fades.set(el, {
      from, to, t0: now, done: false,
      dur: Math.max(1, (to > from ? FADE_IN_MS : FADE_OUT_MS) * span),
    });
    schedule();
  };

  const light = (el: HTMLElement, r: DOMRect) => {
    if (!el.hasAttribute(LIT_ATTR) || !written.has(el)) {
      el.setAttribute(LIT_ATTR, "");
      ro?.observe(el);
      const tier = tierOf(el, r);
      const img = writeImage(el, tier, "");
      written.set(el, { img, tier, gx: "", gy: "", gnx: "", gny: "" });
    }
    fadeTo(el, 1);
  };
  /** The interior image and its size on a glass surface (nothing on rim and
   *  text surfaces); returns the image written. `had` is the element's
   *  current image, cleared when the new tune needs none. */
  const writeImage = (el: HTMLElement, tier: Tier, had: string): string => {
    const img = imageless(tier) ? "" : imageFor(tier === "panel" ? tune.peakPanel : tune.peakCtl);
    if (img) {
      el.style.setProperty("--lg-glint-img", img);
      el.style.setProperty("--gw", `${tune.R}px`);
      el.style.setProperty("--gh", `${tune.R}px`);
      el.style.setProperty("--gr", `${tune.R}px`);
    } else if (had) {
      for (const p of ["--lg-glint-img", "--gw", "--gh", "--gr"]) el.style.removeProperty(p);
    }
    return img;
  };
  const unlight = (el: HTMLElement) => {
    if (!el.isConnected) { drop(el); return; }
    fadeTo(el, 0);
  };
  const dropAll = () => {
    for (const el of [...fades.keys()]) drop(el);
    for (const el of lit) drop(el);
    lit = [];
  };

  /** A surface the light may touch. Never the root or body (a write there
   *  restyles the page), never an opted-out element, never a real-glass
   *  player surface or anything inside one (the light banded over its blur),
   *  never one under a `[data-glass-covered]` ancestor (a page beneath the
   *  Detail overlay: the IntersectionObserver ignores occlusion). */
  const usable = (el: Element | null | undefined): HTMLElement | null =>
    el && el !== document.documentElement && el !== document.body
      && el.getAttribute("data-glass-glint") !== "off"
      && !el.closest('[data-real-glass="on"]')
      && !el.closest("[data-glass-covered]") ? el as HTMLElement : null;

  const measure = (now: number) => {
    if (listDirty && now - lastList >= LIST_MIN_MS) {
      lastList = now;
      cands = [];
      for (const el of document.querySelectorAll<HTMLElement>(LIGHT_SELECTOR)) {
        if (usable(el)) cands.push(el);
      }
      const prev = candSet;
      candSet = new Set(cands);
      if (io) {
        for (const el of prev) if (!candSet.has(el)) io.unobserve(el);
        for (const el of cands) if (!prev.has(el)) io.observe(el);
      }
      listDirty = false;
      rectsDirty = true;
    }
    if (rectsDirty || shownDirty || now - lastMeasure > STALE_MS) {
      shown = new Array(cands.length);
      shownDirty = false;
    }
    if (rectsDirty || now - lastMeasure > STALE_MS) {
      rects = cands.map((el) => el.getBoundingClientRect());
      rectOf.clear();
      cands.forEach((el, i) => rectOf.set(el, rects[i]));
      rectsDirty = false;
      lastMeasure = now;
    }
  };

  /** One light update: smoothing, reach, light / unlight, position writes.
   *  READS first (cached rects, re-measured only when dirty or stale), then
   *  writes, so the frame's lifecycle does one style recalc. True while the
   *  smoothed light still trails the pointer. */
  /** This step's squared pointer distance to each surface in reach (0 inside). */
  const dist = new Map<HTMLElement, number>();
  const lightStep = (t: number): boolean => {
    if (!tuned) readTune();
    dist.clear();
    const dt = Math.min(MAX_DT_MS, Math.max(0, t - lastT));
    lastT = t;
    const k = snap || reduced() ? 1 : 1 - Math.exp(-dt / SMOOTH_MS);
    snap = false;
    sx += (px - sx) * k;
    sy += (py - sy) * k;

    measure(t);
    let next: HTMLElement[];
    {
      // Nearby: within the reach. Hover only (no GPU): the pointer inside the
      // box (the glass under it and any glass or rim surface around it).
      const reach2 = nearby ? tune.R * tune.R : 0;
      const hits: { el: HTMLElement; d: number }[] = [];
      for (let i = 0; i < cands.length; i++) {
        const r = rects[i];
        if (!r || (r.width === 0 && r.height === 0)) continue;
        const dx = sx < r.left ? r.left - sx : sx > r.right ? sx - r.right : 0;
        const dy = sy < r.top ? r.top - sy : sy > r.bottom ? sy - r.bottom : 0;
        const d = dx * dx + dy * dy;
        if (d > reach2 || hidden(cands[i])) continue;
        let vis = shown[i];
        if (vis === undefined) {
          const cs = getComputedStyle(cands[i]);
          vis = shown[i] = parseFloat(cs.opacity) > 0.01 && cs.visibility !== "hidden";
        }
        if (vis) hits.push({ el: cands[i], d });
      }
      if (hits.length > MAX_LIT_GLASS) {
        hits.sort((a, b) => a.d - b.d);
        let glass = 0;
        next = [];
        for (const h of hits) {
          if (next.length >= MAX_LIT) break;
          const kind = h.el.getAttribute("data-glass-light");
          if (kind !== "rim" && kind !== "text" && ++glass > MAX_LIT_GLASS) continue;
          next.push(h.el);
          dist.set(h.el, h.d);
        }
      } else {
        next = hits.map((h) => h.el);
        for (const h of hits) dist.set(h.el, h.d);
      }
    }
    const boxes = next.map((el) => rectOf.get(el) ?? el.getBoundingClientRect());

    const keep = new Set(next);
    // Scrolled out of sight while lit: dropped at once (a fade there is a
    // repaint per frame nobody sees).
    for (const el of lit) if (!keep.has(el)) { if (hidden(el)) drop(el); else unlight(el); }
    for (const el of [...fades.keys()]) if (!keep.has(el) && !el.isConnected) drop(el);
    next.forEach((el, i) => {
      if (!el.hasAttribute(LIT_ATTR) || !written.has(el)) light(el, boxes[i]);
      else if (fades.get(el)?.to === 0) fadeTo(el, 1);
    });
    lit = next;

    lit.forEach((el, i) => {
      const r = boxes[i];
      const w = written.get(el);
      if (!w) return;
      // Whole pixels: the trailing tail of the smoothing then writes nothing.
      // LEVEL OF DETAIL (round 12 performance): every write repaints the
      // surface (and re-rasters its layer, and re-runs the backdrop pass of
      // a frost badge), so a surface far from the pointer, which only
      // catches a faint light (the glint falls as (1 - d / R)^2: 25% at half
      // the reach, 6% at three quarters), takes its position in coarser
      // steps: whole pixels within LOD_NEAR of the reach, then up to
      // LOD_MAX_STEP px at the edge of it. A slow pointer then repaints the
      // far surfaces a few times less often; the steps are under the
      // light's own 70 ms smoothing trail and invisible at that strength.
      const dd = Math.sqrt(dist.get(el) ?? 0) / tune.R;
      const q = dd <= LOD_NEAR ? 1 : Math.round(1 + (LOD_MAX_STEP - 1) * Math.min(1, (dd - LOD_NEAR) / (1 - LOD_NEAR)));
      const qx = Math.round((sx - r.left) / q) * q, qy = Math.round((sy - r.top) / q) * q;
      const lx = String(qx), ly = String(qy);
      const hw = r.width / 2 || 1, hh = r.height / 2 || 1;
      const nx = Math.max(-1, Math.min(1, (qx - hw) / hw)).toFixed(2);
      const ny = Math.max(-1, Math.min(1, (qy - hh) / hh)).toFixed(2);
      if (w.gx !== lx) { el.style.setProperty("--gx", `${lx}px`); w.gx = lx; }
      if (w.gy !== ly) { el.style.setProperty("--gy", `${ly}px`); w.gy = ly; }
      if (w.gnx !== nx) { el.style.setProperty("--gnx", nx); w.gnx = nx; }
      if (w.gny !== ny) { el.style.setProperty("--gny", ny); w.gny = ny; }
    });
    return Math.abs(px - sx) > 0.5 || Math.abs(py - sy) > 0.5;
  };

  /** The last frame the light ran (pacing, see tick). */
  let lastTickT = -Infinity;
  /** The ONE animation frame: the light (while live and moving or dirty),
   *  then the fades. Runs only while one of them has work. */
  const tick = (t: number) => {
    raf = 0;
    // PACING (round 12 performance): the light runs at most once per
    // LIGHT_MIN_MS. Every light frame repaints each lit surface (and
    // re-rasters it), so on a 240 Hz display it ran 240 times a second while
    // the pointer moved; it now runs on every other frame there (120 Hz),
    // and on every frame at about 220 Hz and below. A frame in between does
    // nothing (no damage, nothing redrawn). The position is smoothed over
    // 70 ms (SMOOTH_MS) anyway, so a step at 120 Hz sits inside the light's
    // own trail. In-page A/B on Home at 2575 x 1038 (240 Hz): pointer
    // sweeping the CW row 102 to 134 fps, moving slowly 158 to 179, over
    // the rail 124 to 139.
    if (t - lastTickT < LIGHT_MIN_MS) {
      raf = requestAnimationFrame(tick);
      return;
    }
    lastTickT = t;
    let again = false;
    // A user-driven scroll holds the light (the settle kicks it again): a
    // light already trailing the pointer, or a fade's frame with the rects
    // dirtied by the last scroll step, would otherwise re-measure every
    // candidate and repaint every lit surface on each scroll frame.
    if (enabled && live && (moving || rectsDirty) && !scrolling()) {
      moving = lightStep(t);
      again = moving;
    }
    if (fadeStep(t)) again = true;
    // A fade started inside this tick has already scheduled the next one:
    // never two callbacks per frame.
    if (again && !raf) raf = requestAnimationFrame(tick);
  };

  function schedule() { if (!raf) raf = requestAnimationFrame(tick); }
  const kick = () => { if (enabled && live) { moving = true; schedule(); } };
  const stopFrame = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const setLive = (v: boolean) => {
    if (v === live) return;
    live = v;
    document.documentElement.toggleAttribute(LIVE_ATTR, v);
    if (v) {
      snap = true;
      tuned = false;      // re-read the tunables once per live spell
      rectsDirty = true;
      return;
    }
    // Idle: fade every light out, never pop.
    stopFrame();
    for (const el of lit) unlight(el);
    lit = [];
  };
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = undefined; setLive(false); }, IDLE_MS);
  };
  const cancelIdle = () => {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
  };

  const onMove = (e: PointerEvent) => {
    if (!enabled || e.pointerType === "touch") return;
    px = e.clientX;
    py = e.clientY;
    cancelIdle();
    setLive(true);
    // A pointer moving DURING a user-driven scroll keeps the point and waits
    // for the settle (scrollMo kicks), like a scroll alone (round 12: the
    // light re-read every candidate's rect, about 50 a frame since each
    // scroll step dirties them, and repainted every lit surface on each
    // such frame). tick holds it too.
    if (!scrolling()) kick();
  };
  // A scroll moves every surface under a still pointer: re-measure and
  // re-light (the lights follow the content instead of fading out). While a
  // user-driven scroll runs (scrollPause.ts stamps <html data-aura-scrolling>)
  // the lights hold still and catch up when it settles: a scroll frame is the
  // tightest budget, and re-lighting a row of cards there costs style recalcs.
  const scrolling = () => document.documentElement.hasAttribute("data-aura-scrolling");
  const onScroll = () => {
    rectsDirty = true;
    if (live && !scrolling()) kick();
  };
  const scrollMo = new MutationObserver(() => { if (!scrolling() && live) { rectsDirty = true; kick(); } });
  scrollMo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-aura-scrolling"] });
  const onResize = () => { rectsDirty = true; };
  const onBlur = () => { if (live) armIdle(); };
  const onLeave = () => { if (live) armIdle(); };
  // Hidden: nothing is visible and rAF does not run (a fade would end in one
  // jump on return), so drop everything at once.
  const onVisibility = () => {
    if (!document.hidden) return;
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    setLive(false);
    stopFrame();
    dropAll();
  };

  // Dirty the list only when a mutation can change it: a candidate added or
  // removed (or a subtree holding one), a class change on an element that is
  // or becomes a candidate, or a light opt in / out. The rail's droplet and
  // pill, toasts and hovers flip classes constantly; a full re-query (plus a
  // rect per candidate) on each would run at 10 Hz during ordinary movement.
  const holdsCandidate = (n: Node): boolean =>
    n instanceof Element && (n.matches(LIGHT_SELECTOR) || n.querySelector(LIGHT_SELECTOR) !== null);
  const mo = new MutationObserver((records) => {
    if (listDirty) return;
    for (const r of records) {
      if (r.type === "childList") {
        for (const n of r.addedNodes) if (holdsCandidate(n)) { listDirty = true; return; }
        for (const n of r.removedNodes) {
          if (n instanceof HTMLElement && candSet.has(n)) { listDirty = true; return; }
          if (holdsCandidate(n)) { listDirty = true; return; }
        }
      } else if (r.attributeName !== "class") {
        listDirty = true;
        return;
      } else {
        const t = r.target as HTMLElement;
        if (candSet.has(t) || t.matches(LIGHT_SELECTOR)) { listDirty = true; return; }
      }
    }
  });
  if (document.body) {
    mo.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["class", "data-glass-light", "data-glass-glint", "data-glass-covered"],
    });
  }

  const unsub = subscribeGlass(() => {
    const s = getGlassState();
    enabled = s.glint;
    nearby = !s.gpuOff;
    if (!enabled) {
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
      setLive(false);
      stopFrame();
      dropAll();
    }
  });

  // The user's tuning: applied now and on every settings change naming it
  // (a pick, a reset, an import, a cloud pull). A change re-reads the
  // tunables and rewrites the images of the surfaces lit right now, so a
  // slider drag shows on the light under the pointer at once.
  onTuneChanged = () => {
    if (!tuned) return; // read fresh on the next live frame anyway
    readTune();
    for (const [el, w] of written) {
      if (!el.isConnected) continue;
      w.img = writeImage(el, w.tier, w.img);
    }
  };
  lastTuneKey = "";
  applyGlowTune(sanitizeGlassGlowTune(loadAuraSettings().glassGlowTune));
  const TUNE_KEY = new Set<keyof AuraSettings>(["glassGlowTune"]);
  const onSettings = (e: Event) => {
    if (!settingsChangeIncludes(e, TUNE_KEY)) return;
    applyGlowTune(sanitizeGlassGlowTune(loadAuraSettings().glassGlowTune));
  };
  window.addEventListener("aura:settings-changed", onSettings);

  const passive: AddEventListenerOptions = { passive: true };
  window.addEventListener("pointermove", onMove, passive);
  const onOver = () => { shownDirty = true; };
  window.addEventListener("pointerover", onOver, passive);
  window.addEventListener("blur", onBlur);
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onResize, passive);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    unsub();
    stopDpr();
    onTuneChanged = null;
    window.removeEventListener("aura:settings-changed", onSettings);
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
    mo.disconnect();
    scrollMo.disconnect();
    ro?.disconnect();
    io?.disconnect();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    stopFrame();
    dropAll();
    document.documentElement.removeAttribute(LIVE_ATTR);
    for (const url of images.values()) releaseSvgImage(url);
    images.clear();
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerover", onOver);
    window.removeEventListener("blur", onBlur);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
