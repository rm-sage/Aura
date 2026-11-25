// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// liquidGlass.ts: the Liquid material's per-size SVG filters, and the spring that
// morphs sliding indicators (nav pill, segmented thumb, hover droplets).
//
// WHY ONE FILTER PER SIZE. The Liquid look (ported from the glass study mockup,
// variant B) is four layers: the blurred backdrop bent near the rim
// (feDisplacementMap), then darkened (saturate, brightness), a face (tint, milky
// sheen, inner meniscus shading), and a caustic pickup: a SEPARATE, lightly
// blurred and brightened sample of the raw backdrop pooled along the bottom inner
// curve. The mockup stacked those as three child elements. Aura cannot: the class
// is applied to inputs, scroll containers and fixed panels that own their
// pseudo-elements, and a second backdrop layer inside an element that already
// has backdrop-filter samples only that element (it is a Backdrop Root). So the
// face and the pickup are baked INTO the element's one backdrop-filter:
//
//   backdrop-filter: blur(--lg-<tier>-pickup-blur) url(#lg-N)
//   #lg-N body:   blur up to the tier blur -> displace -> saturate -> brightness
//                 -> tone map (menu tier, glassStyle.ts glassToneNodes)
//                 -> face image over it
//   #lg-N pickup: the pickup-blurred source itself (only while a tier's rim > 0) ->
//                 saturate 1.6 -> lift + softclip ->
//                 masked by the rim band -> merged on top
//
// Neither tier has a pickup today (--lg-menu-rim 0 since round 8, --lg-ctl-rim
// 0 since round 16: on the control tier it read as a light band inside the
// hairline over a light page). The menu tier's story: a raw backdrop sample along
// the edge read as a brighter, more translucent band around a darker body, so
// its body is the one uniform translucent material instead (App.css "The menu
// body"), and its whole blur runs in the CSS chain (pickup blur = tier blur).
//
// Glass over page content (BASE_SELECTOR) also stacks the solid base under the
// body blur (glassStyle.ts glassBaseNodes), so its result is opaque.
//
// The darkening lives INSIDE the filter on the body branch only. With it in the
// CSS chain (the first cut), the pickup read a body already dimmed to 0.62 and
// covered by the menu face, so the pooled colour the mockup shows came out near
// invisible. The element's own background carries only the glint and the lift.
// Until an element is bound (first frame, an oversized panel, a tooltip) App.css
// draws the same face and meniscus with plain CSS, so binding is an upgrade, never
// a pop from nothing.
//
// The maps depend only on (tier, lens, W, H, radius), so elements of one size share
// one filter. Sizes round UP to 2 px (a map smaller than the box leaves an unmapped
// strip the filter reads as a full-strength shift). Cache: CACHE_CAP filters, LRU,
// only unreferenced ones evicted, and at most KEEP_BIG idle large ones kept.
// Elements over MAX_AREA are never bound (CSS fallback, plain blur).
// The exception is width-morphing glass (MORPH_SELECTOR, the Home search bar): it
// takes a SLICED filter keyed by height alone (makeFilter), which covers every
// width from sliceMinW up (two end caps and a stretched middle column), so it stays bound through
// its width spring and never swaps between its CSS face and the lens.
//
// BUILDS ARE OFF THE CRITICAL PATH. A new size is a per-pixel JS loop plus two PNG
// encodes (tens of ms for a large panel), so a ResizeObserver callback never builds:
// it queues a job and the element keeps its current filter while that still covers
// the box (or the CSS fallback while it does not). Jobs run one at a time in idle
// callbacks, a job nobody waits for any more is dropped, and maps over RES_AREA are
// built at half resolution (feImage stretches them; the shapes are smooth).
//
// DISCOVERY. Only while Liquid is drawn on a blurring theme: one MutationObserver
// on <body> (childList + class / data-liquid / data-glass-base attributes) finds glass elements, one
// ResizeObserver sizes them (borderBoxSize, no layout reads). Switching to Frosted
// disconnects both, unbinds everything and drops every filter.

import {
  getGlassState, glassBaseNodes, glassToneNodes, liquidActive, readToneTable, reducedMotionActive, subscribeGlass, syncMenuToneFilter,
} from "./glassStyle";

const NS = "http://www.w3.org/2000/svg";

/** Elements that refract in Liquid. `data-liquid="off"` opts one out,
 *  `data-liquid` (any other value) opts any element in, `data-liquid="rim"`
 *  keeps the face (and the caustic pickup, on a tier whose rim is above 0;
 *  none is today) but no displacement. */
const BIND_SELECTOR = [
  '.aura-float-glass:not(.aura-glass-tip):not(.aura-glass-player):not(.aura-perf-monitor):not([data-liquid="off"])',
  '.aura-glass-control:not(.aura-glass-player):not([data-liquid="off"])',
  ".aura-glow",
  '[data-liquid]:not([data-liquid="off"])',
].join(",");
/** The dense tier (menus, panels, popovers). Everything else is the control tier. */
const MENU_TIER_SELECTOR = ".aura-float-glass:not(.aura-glass-control)";
/** Glass that page content can move under: its filter stacks the solid base
 *  (glassStyle.ts glassBaseNodes) under the blurred backdrop, as its CSS face
 *  does (App.css `url(#aura-glass-base)`). The menu tier always (menus,
 *  popovers, panels open over the page), a control only when it opts in with
 *  `data-glass-base` (the Home search bar, the detail page's Back / Close).
 *  The side pills, the nav pill (.aura-glow) and other chrome keep the
 *  see-through blur: the base there only swapped the real Mica for the
 *  darker estimate. Must match the App.css chains exactly. */
const BASE_SELECTOR = `${MENU_TIER_SELECTOR}, .aura-glass-control[data-glass-base]`;
/** Glass whose WIDTH animates (App.css .aura-glass-morph-w: the Home search
 *  bar). Only these take the sliced, width-independent filter (makeFilter):
 *  two end caps and a 1 px column per image, smaller than a per-size
 *  filter's two box-size images (it could serve any wide glass; it stays
 *  limited to morphing glass so the per-size look is untouched elsewhere). */
const MORPH_SELECTOR = ".aura-glass-morph-w";

const MAX_AREA = 360_000;   // about 600 x 600: larger panels keep the CSS fallback
const MAX_SIDE = 1400;
/** The widest box a sliced (width-morphing) filter serves; its canvas is
 *  only 2E + 1 wide, so MAX_SIDE does not bound it (MAX_AREA still does). */
const SLICE_MAX_W = 4096;
const MIN_SIDE = 6;
const CACHE_CAP = 40;
const BIG_AREA = 150_000;
const KEEP_BIG = 2;
const SETTLE_MS = 140;
const RES_AREA = 60_000;    // above this a map is built at half resolution
const IDLE_TIMEOUT_MS = 250;

type Tier = "ctl" | "menu";

interface TierTune {
  sheenTop: number; sheenBottom: number;
  tint: [number, number, number]; tintTop: number; tintBottom: number;
  /** The body's backdrop chain, moved inside the filter (CSS px / factors). */
  blur: number; sat: number; bright: number;
  /** The CSS blur a bound element of this tier starts its chain with
   *  (`--lg-<tier>-pickup-blur`); the caustic pickup reads it, and the body
   *  is blurred on from it to `blur`. Per tier, so a low control blur never
   *  changes the menu caustic. */
  pickup: number;
  /** The caustic pickup's opacity (`--lg-<tier>-rim`, else `--lg-rim`). The
   *  menu tier's is lower: its body is darkened far more than the raw pickup,
   *  so at the control value its rim over a bright poster read about twice
   *  as bright as the interior (a dark centre slab with lit edges). 0 drops
   *  the pickup branch from the filter (the menu tier, see App.css
   *  --lg-menu-rim). */
  rim: number;
  /** A tone map after the brightness (`--lg-<tier>-tone`, the gain table of
   *  glassStyle.ts readToneTable / glassToneNodes), or null for none. The CSS
   *  face applies the same map through url(#aura-glass-menu-tone). */
  tone: string | null;
  /** The baked meniscus strength (`--lg-<tier>-meniscus-k`, else
   *  `--lg-meniscus-k`). */
  meniscus: number;
  /** The baked outer hairline's strength (`--lg-<tier>-hairline-k`, else the
   *  global `--lg-meniscus-k`). 0 on the control tier since round 9 (the A
   *  face has no dark edge; its idle rim is the edge). */
  hairline: number;
  /** How much the caustic band pools low (`--lg-<tier>-rim-pool`, 0..1, default
   *  1): 1 is the round 4/5 band, dark at the top and pooled along the bottom
   *  plus a faint wash on the lower face; 0 an even band all round (round 9's
   *  A control tier: an even face, like the mockup's lensed rim). */
  pool: number;
}
interface Tunables {
  refract: number; rim: number; rimLift: number; meniscus: number;
  ctl: TierTune; menu: TierTune;
}

/** `W` is the widest box the filter covers and `minW` the narrowest (0 for a
 *  per-size filter, 2 * slice + 2 for a sliced one). */
interface Entry { id: string; node: SVGFilterElement; refs: number; area: number; W: number; H: number; minW: number }
interface Bound {
  w: number; h: number;
  radius: number | null;
  tier: Tier;
  lens: boolean;
  /** Stacks the solid base under the blur (BASE_SELECTOR). */
  base: boolean;
  key: string | null;
  mapW: number; mapH: number;
  /** The narrowest width the bound filter covers (a sliced filter needs its
   *  two caps clear of each other); 0 for a per-size filter. */
  minW: number;
  /** Width-morphing glass (MORPH_SELECTOR): takes the sliced filter. */
  morph: boolean;
  /** A key queued for an idle build that this element is waiting on. */
  want: string | null;
}
/** `slice` > 0: a sliced filter (makeFilter) whose end caps are `slice` px
 *  wide (sliceSpan, plus CAP_PAD), covering widths from sliceMinW up to
 *  SLICE_MAX_W; `W` is then the build width, 2 * slice + 1. */
interface Job { key: string; W: number; H: number; R: number; tier: Tier; lens: boolean; base: boolean; slice: number }

let active = false;
let svg: SVGSVGElement | null = null;
let defs: SVGDefsElement | null = null;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let tun: Tunables | null = null;
let idSeq = 0;
let settleTimer: number | null = null;
let idleHandle: number | null = null;
const cache = new Map<string, Entry>();
const jobs = new Map<string, Job>();
const bound = new Map<HTMLElement, Bound>();
const pending = new Set<HTMLElement>();
const morphTimers = new WeakMap<HTMLElement, number>();
/** Elements in a POP hold (holdLensDuringPop), as opposed to a morph hold:
 *  their size is final from the first ResizeObserver callback, so a cached
 *  filter for it can bind at once (onResize). */
const popHolds = new WeakSet<HTMLElement>();

// ---------------------------------------------------------------------------
// Tunables (CSS custom properties on :root, App.css "GLASS SYSTEM")
// ---------------------------------------------------------------------------

function readTunables(): Tunables {
  const cs = getComputedStyle(document.documentElement);
  const num = (name: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  const rgb = (name: string, fallback: [number, number, number]): [number, number, number] => {
    const parts = cs.getPropertyValue(name).trim().split(/[\s,]+/).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2]] : fallback;
  };
  const tier = (p: string, d: TierTune): TierTune => ({
    sheenTop: num(`--lg-${p}-sheen-top`, d.sheenTop),
    sheenBottom: num(`--lg-${p}-sheen-bottom`, d.sheenBottom),
    tint: rgb(`--lg-${p}-tint-rgb`, d.tint),
    tintTop: num(`--lg-${p}-tint-top`, d.tintTop),
    tintBottom: num(`--lg-${p}-tint-bottom`, d.tintBottom),
    blur: num(`--lg-${p}-blur`, d.blur),
    sat: num(`--lg-${p}-sat`, d.sat),
    bright: num(`--lg-${p}-bright`, d.bright),
    pickup: num(`--lg-${p}-pickup-blur`, d.pickup),
    rim: num(`--lg-${p}-rim`, d.rim),
    tone: readToneTable(cs, `--lg-${p}-tone`),
    meniscus: num(`--lg-${p}-meniscus-k`, d.meniscus),
    hairline: num(`--lg-${p}-hairline-k`, d.hairline),
    pool: Math.max(0, Math.min(1, num(`--lg-${p}-rim-pool`, d.pool))),
  });
  const rim = num("--lg-rim", 0.55);
  const meniscus = num("--lg-meniscus-k", 1);
  return {
    refract: num("--lg-refract", 2),
    rim,
    rimLift: num("--lg-rim-lift", 1.25),
    meniscus,
    ctl: tier("ctl", {
      sheenTop: 0.125, sheenBottom: 0.06, tint: [14, 16, 24], tintTop: 0.10, tintBottom: 0.26,
      blur: 10, sat: 1.6, bright: 0.9, pickup: 7, rim, tone: null, meniscus, hairline: meniscus, pool: 1,
    }),
    menu: tier("menu", {
      sheenTop: 0.015, sheenBottom: 0.015, tint: [8, 10, 15], tintTop: 0.58, tintBottom: 0.58,
      blur: 22, sat: 1.5, bright: 1, pickup: 22, rim: 0, tone: null, meniscus: 0.35, hairline: meniscus, pool: 1,
    }),
  };
}

// ---------------------------------------------------------------------------
// Map builders (ported from the glass study's buildMap / buildRim)
// ---------------------------------------------------------------------------

function sdRR(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Normal CDF, logistic approximation: how a CSS blur falls off. */
const phi = (x: number) => 1 / (1 + Math.exp(-1.702 * x));
/** |v| with its kink at 0 rounded off (log-cosh): equals |v| to within
 *  k*e^-4 beyond 2k, and k*ln2 at 0. */
const softAbs = (v: number, k: number) => {
  const a = Math.abs(v) / k;
  return k * (a + Math.log1p(Math.exp(-2 * a)));
};
/** sdRR with its medial-axis creases rounded: the |p| fold on the centre line
 *  and the max(qx, qy) seam on the corner diagonals. For the caustic band only:
 *  a band that fades on the plain distance has a cusp on the centre line of any
 *  element thinner than band * 3.2, which reads as a faint dark line (the Home
 *  search bar, the nav pill). */
function sdRRSoft(px: number, py: number, hw: number, hh: number, r: number, k: number): number {
  const qx = softAbs(px, k) - (hw - r), qy = softAbs(py, k) - (hh - r);
  const m = 0.5 * (qx + qy + softAbs(qx - qy, k)); // smooth max(qx, qy)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(m, 0) - r;
}

/** The CSS meniscus (App.css --lg-meniscus), top of the list first. */
const MENISCUS = [
  { dy: 8, blur: 12, spread: -10, c: 1, a: 0.06 },
  { dy: 10, blur: 14, spread: -12, c: 0, a: 0.40 },
  { dy: -12, blur: 18, spread: -10, c: 0, a: 0.60 },
] as const;
const MENISCUS_REACH = 60;

function toUrl(c: HTMLCanvasElement): string {
  return c.toDataURL("image/png");
}

/** The end-cap width E of a sliced (width-independent) filter for a box of
 *  height H and radius R: past it from either end every map and shade pixel
 *  depends on the row only (the corners end within R, the caustic band's
 *  reach from an end, band * 1.6 plus its softening, within 34 px, the
 *  meniscus within R). At least H / 2, so the build width 2E + 1 is never the
 *  short side (bezel, band and softening are sized from the short side). */
function sliceSpan(H: number, R: number): number {
  return Math.ceil(Math.max(R, 34, H / 2) + 8);
}
/** How far each end cap of a sliced image runs past E: the middle column
 *  repeated, its blend weight falling 1, 1, 0.5, 0 (CAP_WEIGHT, inner end
 *  last), so the cap hands over to the stretched middle inside pixels that
 *  hold the same column. */
const CAP_PAD = 4;
const CAP_WEIGHT = [255, 255, 128, 0];
/** The narrowest box a slice of span E covers: its two caps (E + CAP_PAD
 *  each) must not overlap, or their weights would add past 1. */
const sliceMinW = (E: number) => 2 * (E + CAP_PAD) + 2;

/** The three pieces of a sliced image, from a build 2E + 1 wide: the left cap
 *  (columns [0, E), then the middle column E repeated CAP_PAD times), the
 *  middle column alone (1 px wide, stretched across the box), and the right
 *  cap (the middle column CAP_PAD times, then columns [E + 1, 2E + 1)).
 *  `weight` (the map): the caps' alpha carries the blend weight (255 over the
 *  cap, ramping to 0 across the pad; the map is opaque, so its alpha is
 *  free), which makeFilter uses for both the map and the shade. Pixels are
 *  copied, never resampled. Round 11: the old pieces were each 1.5 x the box
 *  wide (four 1536 x 42 images for the Home search bar), and a backdrop
 *  filter's images are re-sent to the GPU process with EVERY frame the page
 *  draws, so they cost about 3 ms of compositor time and 1.5 ms in viz per
 *  frame (measured); the caps are about 50 x 42. */
function slicePieces(img: ImageData, E: number, weight: boolean): string[] {
  const H = img.height, src = img.data, sw = img.width, C = E + CAP_PAD;
  const left = new ImageData(C, H), right = new ImageData(C, H), middle = new ImageData(1, H);
  const l = left.data, r = right.data;
  for (let y = 0; y < H; y++) {
    const row = y * sw * 4, out = y * C * 4;
    const mid = src.subarray(row + E * 4, row + E * 4 + 4);
    middle.data.set(mid, y * 4);
    l.set(src.subarray(row, row + E * 4), out);
    for (let j = 0; j < CAP_PAD; j++) {
      l.set(mid, out + (E + j) * 4);
      r.set(mid, out + j * 4);
      if (weight) {
        l[out + (E + j) * 4 + 3] = CAP_WEIGHT[j];
        r[out + j * 4 + 3] = CAP_WEIGHT[CAP_PAD - 1 - j];
      }
    }
    r.set(src.subarray(row + (E + 1) * 4, row + (2 * E + 1) * 4), out + CAP_PAD * 4);
  }
  return [left, middle, right].map((d) => {
    const c = document.createElement("canvas");
    c.width = d.width; c.height = d.height;
    const g = c.getContext("2d");
    if (!g) throw new Error("no 2d context");
    g.putImageData(d, 0, 0);
    const u = toUrl(c);
    c.width = c.height = 0;
    return u;
  });
}

/** Two images for one size:
 *  map   R,G = displacement (128 neutral), B = caustic rim band alpha, A = 255
 *  shade the face: tint + sheen + meniscus, straight alpha.
 *  `res` < 1 builds both at that fraction of W x H (geometry stays in CSS px).
 *  `slice` > 0 (with W = 2 * slice + 1, res 1): each image comes back as the
 *  three pieces of makeFilter's sliced form, [left cap, middle column, right
 *  cap] (slicePieces); otherwise as one. */
function buildImages(W: number, H: number, R: number, t: TierTune, lens: boolean, k: number, res: number, slice = 0):
  { map: string[]; shade: string[]; bezel: number } {
  const hw = W / 2, hh = H / 2;
  const bezel = Math.max(6, Math.min(14, Math.min(W, H) * 0.32));
  const band = Math.max(8, Math.min(18, Math.min(W, H) * 0.45));
  // Softening for the caustic band's distance (sdRRSoft). At most a quarter of
  // the half-side, so the edge distance stays within ~0.001 px of the exact one.
  const kSoft = Math.min(5, Math.min(hw, hh) / 4);
  const CW = Math.max(2, Math.round(W * res));
  const CH = Math.max(2, Math.round(H * res));
  const ux = W / CW, uy = H / CH;  // CSS px per map pixel
  const mc = document.createElement("canvas");
  mc.width = CW; mc.height = CH;
  const sc = document.createElement("canvas");
  sc.width = CW; sc.height = CH;
  const mctx = mc.getContext("2d");
  const sctx = sc.getContext("2d");
  if (!mctx || !sctx) throw new Error("no 2d context");
  const mi = mctx.createImageData(CW, CH), md = mi.data;
  const si = sctx.createImageData(CW, CH), sd = si.data;
  const [tr, tg, tb] = [t.tint[0] / 255, t.tint[1] / 255, t.tint[2] / 255];
  const hair = Math.min(ux, uy);

  for (let y = 0; y < CH; y++) {
    const sy = (y + 0.5) * uy - hh;
    const vy = (y + 0.5) / CH;
    const tintA = t.tintTop + (t.tintBottom - t.tintTop) * vy;
    const sheenA = t.sheenTop + (t.sheenBottom - t.sheenTop) * vy;
    for (let x = 0; x < CW; x++) {
      const sx = (x + 0.5) * ux - hw;
      const di = -sdRR(sx, sy, hw, hh, R);
      const i = (y * CW + x) * 4;
      let dx = 0, dy = 0, rim = 0;
      let pr = 0, pg = 0, pb = 0, pa = 0;
      if (di > 0) {
        // Displacement: inward vectors in a convex bezel, faded to neutral over
        // the outermost 2.5 px so the very edge never shifts.
        const tt = di / bezel;
        if (lens && tt < 1) {
          let nx = sdRR(sx + 0.5, sy, hw, hh, R) - sdRR(sx - 0.5, sy, hw, hh, R);
          let ny = sdRR(sx, sy + 0.5, hw, hh, R) - sdRR(sx, sy - 0.5, hw, hh, R);
          const l = Math.hypot(nx, ny) || 1;
          nx /= l; ny /= l;
          const f = Math.min(1, di / 2.5), feather = f * f * (3 - 2 * f);
          const m = (1 - tt) * (1 - tt) * feather;
          dx = -nx * m; dy = -ny * m;
        }
        // Caustic band: soft from the edge, nearly dark at the top, pooled along
        // the bottom curve, plus a faint wash on the lower face.
        // On the rounded distance (sdRRSoft), so the band has no cusp on the centre line.
        const dr = -sdRRSoft(sx, sy, hw, hh, R, kSoft);
        rim = smooth(0, band * 0.55, dr) * (1 - smooth(band * 0.6, band * 1.6, dr));
        rim *= (1 - t.pool) + t.pool * (0.08 + 0.92 * vy * vy);
        rim += 0.22 * t.pool * smooth(0.45, 1, vy) * smooth(0, band, dr);
        rim = Math.min(1, rim);

        // Face, bottom layer first, composited premultiplied.
        const over = (c: number, cg: number, cb: number, a: number) => {
          if (a <= 0) return;
          pr = c * a + pr * (1 - a); pg = cg * a + pg * (1 - a); pb = cb * a + pb * (1 - a);
          pa = a + pa * (1 - a);
        };
        over(tr, tg, tb, tintA);
        over(1, 1, 1, sheenA);
        over(0, 0, 0, 0.30 * k * Math.min(1, Math.max(0, 1 - di / hair)));
        if (di < MENISCUS_REACH) {
          for (let s = MENISCUS.length - 1; s >= 0; s--) {
            const sh = MENISCUS[s];
            const sigma = sh.blur / 2;
            const d = sdRR(sx, sy - sh.dy, hw - sh.spread, hh - sh.spread, Math.max(0, R - sh.spread));
            over(sh.c, sh.c, sh.c, sh.a * t.meniscus * phi(d / sigma));
          }
        }
      }
      md[i] = Math.round(128 + dx * 127);
      md[i + 1] = Math.round(128 + dy * 127);
      md[i + 2] = Math.round(rim * 255);
      md[i + 3] = 255;
      if (pa > 0) {
        sd[i] = Math.round((pr / pa) * 255);
        sd[i + 1] = Math.round((pg / pa) * 255);
        sd[i + 2] = Math.round((pb / pa) * 255);
        sd[i + 3] = Math.round(Math.min(1, pa) * 255);
      }
    }
  }
  let out: { map: string[]; shade: string[]; bezel: number };
  if (slice > 0) {
    out = { map: slicePieces(mi, slice, true), shade: slicePieces(si, slice, false), bezel };
  } else {
    mctx.putImageData(mi, 0, 0);
    sctx.putImageData(si, 0, 0);
    out = { map: [toUrl(mc)], shade: [toUrl(sc)], bezel };
  }
  // Release the canvas backing stores now rather than at the next GC.
  mc.width = mc.height = 0;
  sc.width = sc.height = 0;
  return out;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/** The caustic pickup's curve: lift, then cap every channel near 72% so a white
 *  poster under the rim never turns into a glare band. */
function softclipTable(lift: number): string {
  const knots = [0, 0.42, 0.62, 0.72];
  const out: string[] = [];
  for (let s = 0; s <= 10; s++) {
    const v = Math.min(1, (s / 10) * lift) * 3;
    const j = Math.min(2, Math.floor(v));
    out.push((knots[j] + (knots[j + 1] - knots[j]) * (v - j)).toFixed(3));
  }
  return out.join(" ");
}

/** An feImage of a data URL. */
function img(href: string, attrs: Record<string, string | number>): SVGFEImageElement {
  const n = el("feImage", attrs);
  n.setAttribute("href", href);
  return n;
}

/** `slice` 0: one filter for one size, the map and shade at the box's
 *  top-left at map size. `slice` > 0 (W = 2 * slice + 1): ONE filter for
 *  every width of this height from sliceMinW up, so a width morph (the Home
 *  search bar widening on focus) stays bound the whole way and never swaps
 *  its look (the CSS face has no stand-in for the caustic, so the old
 *  unbound hold dimmed the lower half about 12 levels over a bright page and
 *  it popped back at the rebind). The filter region's x and width are the
 *  border box (objectBoundingBox 0 / 1), and an feImage with no x / width
 *  takes the region's. Three pieces per image (slicePieces): the left cap
 *  pinned to the box's left edge (`xMinYMin meet`: never scaled, the explicit
 *  height is its own), the right cap to the right edge (`xMaxYMin meet`), and
 *  the 1 px middle column stretched across the box (`none`). They are summed
 *  with disjoint weights that add to 1 everywhere: each cap in its weight
 *  (the map cap's alpha: 1 over the cap, ramping to 0 over its last pixels,
 *  which hold the middle column), the middle out of both. The weights hand
 *  over only inside pixels that are the same column in every piece, so the
 *  blend is exact (8-bit rounding aside), and a cap's inner image edge sits
 *  where its weight is already 0, so it draws nothing even on a fractional
 *  device pixel. That edge rule is the one that matters: an internal edge
 *  where an image still has weight (a right cap pinned on its own at
 *  width - E, or any cap edge under a scale transform or a 125% display) drew
 *  a bright line along the caustic (measured: about 6 levels bright at
 *  fractional widths, a visible line through a scaled panel). Percent or bbox
 *  primitive units are no alternative: in a backdrop-filter a percent
 *  subregion draws nothing, and bbox primitive units would scale the blurs
 *  with the width (measured in Chromium). Round 11: replaces two pieces 1.5 x
 *  the box wide blended by a stretched ramp (same look, about 17 x the image
 *  pixels, which a backdrop filter re-sends with every frame). */
function makeFilter(
  id: string, W: number, H: number, R: number, tier: Tier, lens: boolean, base: boolean, t: Tunables,
  slice = 0,
): SVGFilterElement {
  const tt = tier === "menu" ? t.menu : t.ctl;
  const res = slice > 0 || W * H <= RES_AREA ? 1 : 0.5;
  const { map, shade, bezel } = buildImages(W, H, R, tt, lens, tt.hairline, res, slice);
  let f: SVGFilterElement;
  if (slice > 0) {
    f = el("filter", { id, "color-interpolation-filters": "sRGB", filterUnits: "objectBoundingBox", x: 0, width: 1 });
    const L = { y: 0, height: H, preserveAspectRatio: "xMinYMin meet" };
    const Rt = { y: 0, height: H, preserveAspectRatio: "xMaxYMin meet" };
    const M = { y: 0, height: H, preserveAspectRatio: "none" };
    // The map caps' alpha is the blend weight (the map itself is opaque):
    // each cap in its weight, the middle out of both, summed (premultiplied,
    // disjoint weights). mL / mR are already "in" their own alpha.
    f.append(
      img(map[0], { ...L, result: "mL" }), img(map[2], { ...Rt, result: "mR" }), img(map[1], { ...M, result: "mM" }),
      el("feComposite", { in: "mM", in2: "mL", operator: "out", result: "mMa" }),
      el("feComposite", { in: "mMa", in2: "mR", operator: "out", result: "mMb" }),
      el("feComposite", { in: "mL", in2: "mR", operator: "arithmetic", k2: 1, k3: 1, result: "mLR" }),
      el("feComposite", { in: "mLR", in2: "mMb", operator: "arithmetic", k2: 1, k3: 1, result: "m" }),
      img(shade[0], { ...L, result: "sL" }), img(shade[2], { ...Rt, result: "sR" }), img(shade[1], { ...M, result: "sM" }),
      el("feComposite", { in: "sL", in2: "mL", operator: "in", result: "sLi" }),
      el("feComposite", { in: "sR", in2: "mR", operator: "in", result: "sRi" }),
      el("feComposite", { in: "sM", in2: "mL", operator: "out", result: "sMa" }),
      el("feComposite", { in: "sMa", in2: "mR", operator: "out", result: "sMb" }),
      el("feComposite", { in: "sLi", in2: "sRi", operator: "arithmetic", k2: 1, k3: 1, result: "sLR" }),
      el("feComposite", { in: "sLR", in2: "sMb", operator: "arithmetic", k2: 1, k3: 1, result: "sh" }),
    );
  } else {
    f = el("filter", { id, "color-interpolation-filters": "sRGB" });
    const box = { x: 0, y: 0, width: W, height: H, preserveAspectRatio: "none" };
    f.append(img(map[0], { ...box, result: "m" }), img(shade[0], { ...box, result: "sh" }));
  }

  // ---- Body: the CSS chain already blurred SourceGraphic by the tier's
  // pickup blur, so blur the rest of the way to the tier blur here (Gaussian
  // blurs add in quadrature: round 9 ctl sqrt(20^2 - 12^2) = 16). Today both
  // tiers' pickup blur IS the tier blur, so no pass is added. The blur is used
  // as is, NEVER composited over SourceGraphic:
  // "over" adds the alpha of two copies of the backdrop, so wherever the page
  // behind is see-through (Haze's --ln-bg is alpha 0.45 over the window
  // backdrop) a bound panel came out about 6% more opaque than its CSS face
  // and read clearly darker the moment a menu's pop settled and bound
  // (measured alpha 0.934 bound vs 0.879 unbound; 0.881 without the over).
  // Over an opaque backdrop the over changed nothing, not even at the
  // viewport edge: Chromium feeds the filter the backdrop beyond the box, so
  // the blur never fades out at the border (measured identical pixels).
  let body = "SourceGraphic";
  const extra = Math.sqrt(Math.max(0, tt.blur * tt.blur - tt.pickup * tt.pickup));
  if (extra >= 0.5) {
    f.append(el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: extra.toFixed(2), result: "bx" }));
    body = "bx";
  }
  // The solid base under the blurred body, at the same point of the chain as
  // the CSS face's `blur(tier) url(#aura-glass-base) saturate brightness`, so
  // bound and unbound stack the same opaque result. Over a see-through page
  // (Mica, Haze) the body alone is see-through, and Chromium draws a
  // backdrop-filter's result OVER the unfiltered page, so the crisp titles
  // under the search bar showed through it (glassStyle.ts explains).
  if (base) {
    f.append(...glassBaseNodes(body, "bo"));
    body = "bo";
  }
  if (lens) {
    const circle = Math.abs(W - H) < 2 && R >= Math.min(W, H) / 2 - 1;
    const scale = circle ? Math.min(bezel * t.refract, R * 1.2) : bezel * t.refract;
    f.append(el("feDisplacementMap", {
      in: body, in2: "m", scale: scale.toFixed(1),
      xChannelSelector: "R", yChannelSelector: "G", result: "d",
    }));
    body = "d";
  }
  // The mockup's order after the map: saturate, then brightness (CSS
  // brightness() is a linear slope on RGB).
  f.append(el("feColorMatrix", { in: body, type: "saturate", values: tt.sat.toFixed(3), result: "bs" }));
  const br = el("feComponentTransfer", { in: "bs", result: "bb" });
  for (const ch of ["feFuncR", "feFuncG", "feFuncB"] as const) {
    br.append(el(ch, { type: "linear", slope: tt.bright.toFixed(3) }));
  }
  f.append(br);
  let toned = "bb";
  if (tt.tone) {
    // The tier's tone map, at the same point as the CSS face's
    // url(#aura-glass-menu-tone) step (after brightness), so they match.
    f.append(...glassToneNodes("bb", "bt", tt.tone).nodes);
    toned = "bt";
  }
  f.append(el("feComposite", { in: "sh", in2: toned, operator: "over", result: "f" }));
  // No pickup (the menu tier): the face over the body is the whole result.
  if (tt.rim <= 0) return f;

  // ---- Caustic pickup: the RAW lightly blurred backdrop (the mockup's .gr
  // layer: the tier's pickup blur, saturate 1.6, brightness + softclip), never the darkened
  // body or the face. Rim band alpha lives in the map's blue channel.
  f.append(el("feColorMatrix", {
    in: "m", type: "matrix", result: "rm",
    values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0",
  }));
  f.append(el("feColorMatrix", { in: "SourceGraphic", type: "saturate", values: "1.6", result: "fs" }));
  const ct = el("feComponentTransfer", { in: "fs", result: "fc" });
  const table = softclipTable(t.rimLift);
  for (const ch of ["feFuncR", "feFuncG", "feFuncB"] as const) ct.append(el(ch, { type: "table", tableValues: table }));
  f.append(ct);
  f.append(el("feComposite", { in: "fc", in2: "rm", operator: "in", result: "r" }));
  const ra = el("feComponentTransfer", { in: "r", result: "ra" });
  ra.append(el("feFuncA", { type: "linear", slope: tt.rim.toFixed(3) }));
  f.append(ra);
  const merge = el("feMerge", {});
  merge.append(el("feMergeNode", { in: "f" }), el("feMergeNode", { in: "ra" }));
  f.append(merge);
  return f;
}

// ---------------------------------------------------------------------------
// Filter cache
// ---------------------------------------------------------------------------

/** `stepH` rounds the height on its own (default: `step`), so a width-only
 *  morph can keep the exact height map. */
function geomOf(w: number, h: number, r: number, step: number, stepH = step) {
  const W = Math.max(2, Math.ceil(w / step) * step);
  const H = Math.max(2, Math.ceil(h / stepH) * stepH);
  const R = Math.round(Math.max(0, Math.min(r, w / 2, h / 2)));
  return { W, H, R };
}

/** Takes a reference on a cached filter (and marks it most recently used). */
function take(key: string, e: Entry): void {
  cache.delete(key);
  cache.set(key, e);
  e.refs++;
}

/** Builds one queued filter. False when the build failed (no 2d context). */
function build(job: Job): boolean {
  if (!defs || !tun) return false;
  const id = `aura-lg-${++idSeq}`;
  let node: SVGFilterElement;
  try {
    node = makeFilter(id, job.W, job.H, job.R, job.tier, job.lens, job.base, tun, job.slice);
  } catch {
    return false;
  }
  defs.append(node);
  cache.set(job.key, {
    // A slice holds two small caps and a column per image, and covers every
    // width up to SLICE_MAX_W.
    id, node, refs: 0, area: job.W * job.H, H: job.H,
    W: job.slice > 0 ? SLICE_MAX_W : job.W,
    minW: job.slice > 0 ? sliceMinW(job.slice) : 0,
  });
  return true;
}

function waitersOf(key: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const [t, b] of bound) if (b.want === key && t.isConnected) out.push(t);
  return out;
}

type IdleDeadlineLike = { timeRemaining(): number; didTimeout: boolean };

function runJobs(deadline: IdleDeadlineLike): void {
  idleHandle = null;
  if (!active) return;
  let built = 0;
  for (const [key, job] of jobs) {
    // Always at least one per callback (a timed-out callback has no slack and
    // would otherwise starve), then only while the frame still has idle time.
    if (built > 0 && deadline.timeRemaining() < 12) break;
    jobs.delete(key);
    const waiting = waitersOf(key);
    if (waiting.length === 0) continue;
    if (!cache.has(key) && !build(job)) {
      for (const t of waiting) { const b = bound.get(t); if (b) b.want = null; }
      continue;
    }
    built++;
    const e = cache.get(key);
    if (!e) continue;
    for (const t of waiting) {
      const b = bound.get(t);
      if (b) bindEntry(t, b, key, e);
    }
  }
  evict();
  if (jobs.size) scheduleJobs();
}

function scheduleJobs(): void {
  if (idleHandle !== null) return;
  if (typeof window.requestIdleCallback === "function") {
    idleHandle = window.requestIdleCallback(runJobs, { timeout: IDLE_TIMEOUT_MS });
  } else {
    idleHandle = window.setTimeout(() => runJobs({ timeRemaining: () => 0, didTimeout: true }), 16);
  }
}

function cancelJobs(): void {
  if (idleHandle !== null) {
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
    else clearTimeout(idleHandle);
    idleHandle = null;
  }
  jobs.clear();
}

function release(key: string | null): void {
  if (!key) return;
  const e = cache.get(key);
  if (e) e.refs = Math.max(0, e.refs - 1);
}

function evict(): void {
  const idle: [string, Entry][] = [];
  for (const kv of cache) if (kv[1].refs === 0) idle.push(kv);
  if (idle.length === 0) return;
  const bigIdle = idle.filter(([, e]) => e.area > BIG_AREA);
  const dropBig = new Set(bigIdle.slice(0, Math.max(0, bigIdle.length - KEEP_BIG)).map(([k]) => k));
  for (const [k, e] of idle) {
    if (dropBig.has(k) || cache.size > CACHE_CAP) {
      e.node.remove();
      cache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function radiusOf(target: HTMLElement, b: Bound): number {
  if (b.radius !== null) return b.radius;
  const raw = getComputedStyle(target).borderTopLeftRadius.split(" ")[0] ?? "0";
  const v = parseFloat(raw) || 0;
  b.radius = raw.endsWith("%") ? (v / 100) * Math.min(b.w, b.h) : v;
  return b.radius;
}

/** Makes a bind / unbind swap of the edge as instant as the filter's. The
 *  filter's baked meniscus, caustic and outer hairline come and go with one
 *  url() swap, but the CSS face's twin (--lg-meniscus vs --lg-meniscus-clear,
 *  the --lg-face-ring border) would fade through the element's box-shadow /
 *  border-color transition: an unbind showed a flat, too bright face for about
 *  100 ms, a rebind a doubled, too dark meniscus for about 150 ms. So the
 *  transitions the swap just started are finished on the spot. Only those
 *  properties: a width spring, an opacity fade or a scale keep running, and
 *  the inline `transition` is never blanked (that would jump them all). One
 *  forced style read per swap (rare, never per frame). */
function snapEdge(target: HTMLElement): void {
  if (typeof CSSTransition === "undefined" || !target.isConnected) return;
  void getComputedStyle(target).boxShadow;
  for (const a of target.getAnimations()) {
    if (!(a instanceof CSSTransition)) continue;
    const p = a.transitionProperty;
    if (p === "box-shadow" || (p.startsWith("border-") && p.endsWith("-color"))) a.finish();
  }
}

/** Drops the filter. `snap` (the default) snaps the edge back to the CSS face
 *  (snapEdge; a no-op on a detached element). deactivate() passes false: a
 *  material switch restyles every surface anyway, and N forced reads would
 *  cost more than a fade. */
function clearFilter(target: HTMLElement, b: Bound, snap = true): void {
  release(b.key);
  b.key = null;
  b.mapW = b.mapH = b.minW = 0;
  target.style.removeProperty("--lg-filter");
  if (!target.hasAttribute("data-lg-bound")) return;
  target.removeAttribute("data-lg-bound");
  if (snap) snapEdge(target);
}

function bindEntry(target: HTMLElement, b: Bound, key: string, e: Entry): void {
  b.want = null;
  if (key === b.key) return;
  take(key, e);
  release(b.key);
  b.key = key;
  b.mapW = e.W;
  b.mapH = e.H;
  b.minW = e.minW;
  target.style.setProperty("--lg-filter", `url(#${e.id})`);
  if (!target.hasAttribute("data-lg-bound")) {
    target.setAttribute("data-lg-bound", "");
    snapEdge(target);
  }
}

/** Gives `target` the filter for a box of w x h (rounded up by `step`): at once
 *  when that size is cached, otherwise queued for an idle build. Meanwhile the
 *  current filter stays only while its map still covers w x h. A box at least
 *  width-morphing box (MORPH_SELECTOR) at least sliceMinW wide takes the
 *  sliced filter for its height (makeFilter), shared by every width up to its
 *  `wide`, so its width can change without a rebind.
 *  `cachedOnly`: bind only a filter that is already built, and otherwise
 *  change nothing (no job, no unbind). True when a covering filter is bound. */
function applySize(target: HTMLElement, b: Bound, w: number, h: number, step: number, stepH = step, cachedOnly = false): boolean {
  if (!active) return false;
  // A sliced filter's canvas is only 2E + 1 wide, so a width-morphing box may
  // be wider than MAX_SIDE (the Home search bar focused on a large window is
  // --hero-max-w, up to 1773 px); the per-size guard is applied below once we
  // know it cannot take a slice.
  const tooBig = (ww: number) => w * h > MAX_AREA || Math.max(ww, h) > MAX_SIDE;
  if (w < MIN_SIDE || h < MIN_SIDE || tooBig(b.morph ? Math.min(w, MAX_SIDE) : w) || w > SLICE_MAX_W) {
    if (cachedOnly) return false;
    b.want = null;
    clearFilter(target, b);
    return false;
  }
  const g = geomOf(w, h, radiusOf(target, b), step, stepH);
  const kind = `${b.tier}|${b.lens ? "L" : "R"}${b.base ? "B" : ""}`;
  // Sliced: any filter of this kind, height and radius whose width range
  // holds w serves (the bound one first, so a morph never re-keys).
  const sliced = `${kind}|S${g.H}r${g.R}w`;
  const fits = (k: string | null, e: Entry | undefined) =>
    b.morph && k !== null && e !== undefined && k.startsWith(sliced) && e.minW <= w && w <= e.W;
  if (fits(b.key, b.key ? cache.get(b.key) : undefined)) { b.want = null; return true; }
  for (const [k, e] of cache) {
    if (fits(k, e)) { bindEntry(target, b, k, e); evict(); return true; }
  }
  const span = sliceSpan(g.H, g.R);
  // A slice covers every width from sliceMinW up to SLICE_MAX_W (its middle
  // column stretches), never MAX_SIDE: at MAX_SIDE a bar resting near 1000 px
  // could not cover its focus width on a large window (2560 x 1380: 1206 to
  // 1773 px), so it unbound for the whole focus and rebound at the end of the
  // shrink, the bottom-half shift this filter exists to remove.
  const slice = b.morph && w >= sliceMinW(span) && (2 * span + 1) * g.H <= MAX_AREA ? span : 0;
  if (slice === 0 && tooBig(w)) {
    if (cachedOnly) return false;
    b.want = null;
    clearFilter(target, b);
    return false;
  }
  const key = slice > 0 ? `${sliced}${SLICE_MAX_W}` : `${kind}|${g.W}x${g.H}r${g.R}`;
  if (key === b.key) { b.want = null; return true; }
  const e = cache.get(key);
  if (e) {
    bindEntry(target, b, key, e);
    evict();
    return true;
  }
  if (cachedOnly) return false;
  b.want = key;
  if (!jobs.has(key)) {
    jobs.set(key, {
      key, W: slice > 0 ? 2 * slice + 1 : g.W, H: g.H, R: g.R, tier: b.tier, lens: b.lens, base: b.base,
      slice,
    });
  }
  if (b.key !== null && (b.mapW < w || b.mapH < h || b.minW > w)) clearFilter(target, b);
  scheduleJobs();
  return false;
}

function flushPending(): void {
  settleTimer = null;
  for (const t of pending) {
    const b = bound.get(t);
    if (b && !t.hasAttribute("data-moving")) applySize(t, b, b.w, b.h, 2);
  }
  pending.clear();
}

function scheduleSettle(target: HTMLElement): void {
  pending.add(target);
  if (settleTimer === null) settleTimer = window.setTimeout(flushPending, SETTLE_MS);
}

function onResize(entries: ResizeObserverEntry[]): void {
  for (const entry of entries) {
    const target = entry.target as HTMLElement;
    const b = bound.get(target);
    if (!b) continue;
    const box = entry.borderBoxSize?.[0];
    b.w = box ? box.inlineSize : target.offsetWidth;
    b.h = box ? box.blockSize : target.offsetHeight;
    if (target.hasAttribute("data-moving")) {
      // A popping panel whose filter is already built (a menu reopened at
      // the same size) binds now, before its first frame, and stays bound
      // through the pop: the hold's later bind showed the caustic band
      // appearing on a still panel (the lower half about 6 levels brighter
      // over a bright page, the last 30 rows about 14). Still no build
      // mid-pop: a size with no built filter (first open, or the card
      // growing mid-pop) draws the CSS face until the hold ends, and the
      // hold keeps its timer either way.
      if (popHolds.has(target) && !applySize(target, b, b.w, b.h, 2, 2, true) && b.key !== null) {
        clearFilter(target, b);
      }
      continue;
    }
    if (b.key === null) {
      applySize(target, b, b.w, b.h, 2);
    } else if (b.w > b.mapW || b.h > b.mapH) {
      // Growing past the map: ask for one with generous headroom (a smaller
      // map would shift the uncovered strip, so the old one is dropped until
      // it is built, and a CSS size transition would otherwise queue a build
      // every few pixels), settle to the exact size after. A queued size
      // nobody waits for any more is skipped by the idle builder.
      applySize(target, b, b.w, b.h, 64);
      scheduleSettle(target);
    } else if (b.w < b.minW) {
      // Narrower than a sliced filter covers (its caps would overlap): the
      // per-size filter now (applySize drops the slice while it
      // builds).
      applySize(target, b, b.w, b.h, 2);
    } else {
      scheduleSettle(target);
    }
  }
}

function tierOf(target: Element): Tier {
  return target.matches(MENU_TIER_SELECTOR) ? "menu" : "ctl";
}

function bind(target: HTMLElement): void {
  if (bound.has(target)) return;
  bound.set(target, {
    w: 0, h: 0, radius: null,
    tier: tierOf(target),
    lens: target.getAttribute("data-liquid") !== "rim",
    base: target.matches(BASE_SELECTOR),
    morph: target.matches(MORPH_SELECTOR),
    key: null, mapW: 0, mapH: 0, minW: 0, want: null,
  });
  ro?.observe(target);
  // A panel that pops in keeps its CSS face until the pop has settled. bind()
  // runs from the MutationObserver microtask, before the first ResizeObserver
  // callback, so that first size is recorded but no job is queued.
  if (target.matches(POP_SELECTOR)) holdLensDuringPop(target);
}

function unbind(target: HTMLElement): void {
  const b = bound.get(target);
  if (!b) return;
  ro?.unobserve(target);
  clearFilter(target, b);
  bound.delete(target);
  pending.delete(target);
}

function scan(root: Element): void {
  if (root.matches(BIND_SELECTOR)) bind(root as HTMLElement);
  root.querySelectorAll<HTMLElement>(BIND_SELECTOR).forEach(bind);
}

function onMutations(records: MutationRecord[]): void {
  let removed = false;
  for (const r of records) {
    if (r.type === "childList") {
      if (r.removedNodes.length) removed = true;
      r.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n as Element); });
    } else if (r.type === "attributes" && r.target.nodeType === 1) {
      const target = r.target as HTMLElement;
      const should = target.matches(BIND_SELECTOR);
      const b = bound.get(target);
      if (should && !b) bind(target);
      else if (!should && b) unbind(target);
      else if (b) {
        // A class change can move the radius, the tier or the lens: re-key on
        // the next settle (the current filter stays until then; an unchanged
        // key is a no-op there).
        b.tier = tierOf(target);
        b.lens = target.getAttribute("data-liquid") !== "rim";
        b.base = target.matches(BASE_SELECTOR);
        b.morph = target.matches(MORPH_SELECTOR);
        b.radius = null;
        scheduleSettle(target);
      }
    }
  }
  if (removed) {
    for (const t of [...bound.keys()]) if (!t.isConnected) unbind(t);
  }
}

function activate(): void {
  active = true;
  tun = readTunables();
  // The CSS face's tone step reads the same token (a live retune lands here).
  syncMenuToneFilter();
  svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
  svg.setAttribute("data-aura-liquid-defs", "");
  defs = document.createElementNS(NS, "defs");
  svg.append(defs);
  document.body.append(svg);
  ro = new ResizeObserver(onResize);
  mo = new MutationObserver(onMutations);
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-liquid", "data-glass-base"] });
  scan(document.body);
}

function deactivate(): void {
  active = false;
  mo?.disconnect();
  ro?.disconnect();
  mo = null;
  ro = null;
  if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
  cancelJobs();
  pending.clear();
  for (const [t, b] of bound) clearFilter(t, b, false);
  bound.clear();
  for (const e of cache.values()) e.node.remove();
  cache.clear();
  svg?.remove();
  svg = null;
  defs = null;
  tun = null;
}

function syncActive(): void {
  const s = getGlassState();
  const want = s.style === "liquid" && !s.zeroBlurTheme;
  if (want && !active) activate();
  else if (!want && active) deactivate();
}

/** Installs the binder; it runs only while Liquid is drawn. Returns the cleanup. */
export function installLiquidGlass(): () => void {
  syncActive();
  const unsub = subscribeGlass(syncActive);
  return () => {
    unsub();
    if (active) deactivate();
  };
}

/** Re-reads the --lg-* tunables and rebuilds every filter (for live tuning from
 *  the DevConsole: `window.__auraLiquidRetune?.()`). */
export function refreshLiquidTunables(): void {
  if (!active) return;
  deactivate();
  activate();
}
if (typeof window !== "undefined") {
  (window as unknown as { __auraLiquidRetune?: () => void }).__auraLiquidRetune = refreshLiquidTunables;
}

/** The one hold both morph helpers share: drops `target` to its CSS face now
 *  (no filter, nothing queued), keeps it there for `ms` (`data-moving` stops
 *  the ResizeObserver from re-keying it), then binds the exact settled size,
 *  normally from the cache. A later hold on the same element replaces the
 *  earlier timer (one `morphTimers` slot).
 *
 *  Why unbound and not a larger map: a filter's map and shade sit at the
 *  element's top-left at the MAP's size, so an element smaller than its map
 *  loses the rim, meniscus and pooled colour along its far edge, and they
 *  popped back in one url() swap after the motion. The CSS face tracks the box
 *  exactly. The bound --lg-edge is a zero-alpha meniscus of the same shape
 *  (App.css), and both swaps are SNAPPED (clearFilter / bindEntry call
 *  snapEdge), never faded: the filter's edge swaps in one frame, so a fading
 *  CSS twin left the bar too bright on unbind and too dark on rebind. */
function holdUnbound(target: HTMLElement, ms: number): void {
  const b = bound.get(target);
  if (!b || !active) return;
  popHolds.delete(target);
  target.setAttribute("data-moving", "");
  b.want = null;
  clearFilter(target, b);
  const prev = morphTimers.get(target);
  if (prev) clearTimeout(prev);
  morphTimers.set(target, window.setTimeout(() => {
    morphTimers.delete(target);
    popHolds.delete(target);
    target.removeAttribute("data-moving");
    const nb = bound.get(target);
    if (nb && nb.w > 0 && nb.h > 0) applySize(target, nb, nb.w, nb.h, 2);
  }, ms));
}


/** Keeps a bound element correct through a CSS WIDTH transition (a search bar
 *  widening on focus). On a sliced filter (applySize: a MORPH_SELECTOR box at
 *  least sliceMinW wide) nothing is needed: the filter covers every width of
 *  that height up to SLICE_MAX_W, so the element stays
 *  bound through the morph and nothing swaps (the ResizeObserver settle finds
 *  the same filter, or a per-size one if the width ends below the slice
 *  minimum). Otherwise it draws its CSS face for `ms`, then rebinds at the
 *  settled size. `maxW` / `maxH` are no longer read; the signature stays for
 *  callers. */
export function holdLensForMorph(target: HTMLElement, _maxW: number, _maxH: number, ms = 380): void {
  const b = bound.get(target);
  if (b && b.key !== null && b.minW > 0 && !target.hasAttribute("data-moving")) return;
  holdUnbound(target, ms);
}

/** Elements that open with a pop: the `.aura-glass-pop-in` keyframe, an inline
 *  transition flagged `data-lg-pop` (ProfilePopover, WatchTogetherPanel, the
 *  Notifications side sheet and arrival bubble), or a chrome panel's own
 *  entrance class (styles/glass-chrome.css: the Downloads and Service status
 *  panels). */
const POP_SELECTOR =
  ".aura-glass-pop-in, [data-lg-pop], .aura-dl-panel-in";
const POP_HOLD_MS = 500; // covers the bouncy spring (--aura-spring-bouncy-dur, 480 ms) every Liquid pop rides

/** Keeps a freshly opened panel on its CSS face through its open animation: no
 *  filter build or bind (a build is a main-thread pixel loop plus two PNG
 *  encodes, a bind swaps the backdrop pass mid-flight), then binds at the
 *  settled size. Called from bind() for POP_SELECTOR matches. The same hold as
 *  holdLensForMorph (holdUnbound), so the two compose on one element. When the
 *  filter for the panel's size is already built, the first ResizeObserver
 *  callback (before the first frame) binds it for the whole pop (onResize). */
export function holdLensDuringPop(target: HTMLElement, ms = POP_HOLD_MS): void {
  holdUnbound(target, ms);
  if (active && bound.has(target)) popHolds.add(target);
}

// ---------------------------------------------------------------------------
// Spring span: a sliding indicator that stretches toward its target and settles
// ---------------------------------------------------------------------------

export interface Span { a: number; b: number }
type Axis = "x" | "y";

const spans = new WeakMap<HTMLElement, Span>();
const flights = new WeakMap<HTMLElement, number>();
// Default pair (nav pill, segmented thumbs): zeta 0.75 lead, 0.89 trail.
const LEAD = { k: 520, c: 34 };
const TRAIL = { k: 250, c: 28 };
// Hover droplets: snappier and bouncier. Lead zeta 0.60 (about 9.5% overshoot
// at 131 ms, settled by 330 ms), trail zeta 0.68 (5.6% at 180 ms, 410 ms).
const HOVER_LEAD = { k: 900, c: 36 };
const HOVER_TRAIL = { k: 560, c: 32 };

/** Writes the span as the individual `translate` property (never `transform`,
 *  so a CSS `scale` on the element, the droplet's grow, scales about its own
 *  centre instead of scaling the offset too) plus width or height. */
function writeSpan(target: HTMLElement, axis: Axis, a: number, b: number): void {
  spans.set(target, { a, b });
  target.style.translate = axis === "y" ? `0 ${a.toFixed(2)}px` : `${a.toFixed(2)}px 0`;
  target.style[axis === "y" ? "height" : "width"] = `${Math.max(0, b - a).toFixed(2)}px`;
}

function endFlight(target: HTMLElement): void {
  if (!target.hasAttribute("data-moving")) return;
  target.removeAttribute("data-moving");
  const b = bound.get(target);
  if (b) applySize(target, b, b.w, b.h, 2);
}

/** Stops a running span animation where it is (unmount cleanup). */
export function cancelSpan(target: HTMLElement): void {
  const id = flights.get(target);
  if (id === undefined) return;
  cancelAnimationFrame(id);
  flights.delete(target);
  target.style.transition = "";
  endFlight(target);
}

/** Moves `target` (absolutely positioned at left/top 0) to cover [to.a, to.b]
 *  on `axis`, writing `translate` plus width or height inline (so any CSS
 *  transition on it must name `translate`, not `transform`).
 *  - snap, first call, or reduced motion: jumps there.
 *  - Frosted: one write; the element's CSS transition animates it.
 *  - Liquid: two springs, the leading edge fast and the trailing edge slow, so
 *    the shape stretches toward the target and settles. A bound lens is
 *    dropped to its CSS face for the flight and rebound at rest (holdUnbound
 *    explains why it is never held on a larger map).
 *  - `spring: "hover"`: the snappier, bouncier pair for hover droplets. */
export function animateSpan(
  target: HTMLElement, axis: Axis, to: Span, opts: { snap?: boolean; spring?: "hover" } = {},
): void {
  cancelSpan(target);
  const cur = spans.get(target);
  if (opts.snap || !cur || reducedMotionActive()) {
    target.style.transition = "none";
    writeSpan(target, axis, to.a, to.b);
    void target.offsetWidth;
    target.style.transition = "";
    endFlight(target);
    return;
  }
  if (!liquidActive()) {
    target.style.transition = "";
    writeSpan(target, axis, to.a, to.b);
    return;
  }
  const c0 = (cur.a + cur.b) / 2, c1 = (to.a + to.b) / 2;
  if (Math.abs(c1 - c0) < 0.5 && Math.abs((cur.b - cur.a) - (to.b - to.a)) < 0.5) {
    writeSpan(target, axis, to.a, to.b);
    return;
  }
  // No inline `transition: none` here: that would also cancel the target's
  // running opacity / scale transitions (the droplet's bouncy grow, a fade-in)
  // and jump them to their end values. Span targets name no translate, width
  // or height transition in Liquid (App.css), so the per-frame writes are
  // never transitioned anyway.
  const b = bound.get(target);
  if (b && active) {
    // The CSS face for the flight; endFlight rebinds the exact (cached) size.
    target.setAttribute("data-moving", "");
    b.want = null;
    clearFilter(target, b);
  }
  const [lead, trail] = opts.spring === "hover" ? [HOVER_LEAD, HOVER_TRAIL] : [LEAD, TRAIL];
  const dir = Math.sign(c1 - c0) || 1;
  const A = { x: cur.a, v: 0, t: to.a, ...(dir < 0 ? lead : trail) };
  const B = { x: cur.b, v: 0, t: to.b, ...(dir > 0 ? lead : trail) };
  const minSize = Math.min(to.b - to.a, cur.b - cur.a) * 0.7;
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
    last = now;
    for (const e of [A, B]) {
      const f = -e.k * (e.x - e.t) - e.c * e.v;
      e.v += f * dt;
      e.x += e.v * dt;
    }
    if (B.x - A.x < minSize) {
      const m = (A.x + B.x) / 2;
      A.x = m - minSize / 2;
      B.x = m + minSize / 2;
    }
    writeSpan(target, axis, A.x, B.x);
    if (Math.abs(A.x - A.t) < 0.25 && Math.abs(B.x - B.t) < 0.25 && Math.abs(A.v) < 4 && Math.abs(B.v) < 4) {
      writeSpan(target, axis, A.t, B.t);
      flights.delete(target);
      target.style.transition = "";
      endFlight(target);
      return;
    }
    flights.set(target, requestAnimationFrame(step));
  };
  flights.set(target, requestAnimationFrame(step));
}
