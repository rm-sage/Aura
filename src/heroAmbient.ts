// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// heroAmbient.ts: the Home hero's ambient light (round 9, the A direction).
//
//   heroPalette(url)    the dominant colours of a hero slide: left, centre,
//                       right and top thirds (made vivid) plus the raw middle
//   bleedImage(...)     the AMBIENT BLEED: up to six large soft glows tinted
//                       by those colours, behind the upper viewport and the
//                       rail (HeroBleed.tsx shows it)
//   underglowImage(...) the hero's UNDERGLOW: an art-tinted contact shadow
//                       plus a faint coloured halo (HeroCarousel.tsx)
//
// Every large soft gradient here is a DITHERED IMAGE, the technique of
// glassGlint.ts lightImage: the webview composites at 8 bits with no dither,
// so a CSS gradient (or a box-shadow) of a faint glow bands into 1-code
// rings, and a grain on its own layer cannot fix that (each layer rounds on
// its own). Each image is an SVG whose shapes are drawn at FULL range, scaled
// down inside one arithmetic feComposite with a zero-mean noise summed in, so
// the one rounding to 8 bits is dithered (and the full-range shapes' own
// rounding is scaled down with them).
//
// Colour readback. The hero art is a cross-origin image, so it cannot be read
// from the <img>. It is read from Aura's own resize proxy on the loopback
// bridge (`http://127.0.0.1:11471/img`), which reflects the WebView's origin
// in Access-Control-Allow-Origin on the image bytes (img_proxy.rs, round 9),
// fetched with `cache: "no-store"` (the <img>'s cached copy has no CORS
// header) at the SAME url the hero shows, so the proxy answers from its disk
// cache and nothing is fetched upstream twice. createImageBitmap decodes and
// shrinks it off the main thread. A url that is not the proxy's, or a proxy
// that degraded to a redirect, gives no palette: the bleed then stays off and
// the underglow keeps a neutral contact shadow (never a guessed colour).

import { svgImageUrl } from "./glassGlint";

export type RGB = [number, number, number];
export interface HeroPalette {
  left: RGB;
  center: RGB;
  right: RGB;
  top: RGB;
  /** The raw (not vivid) middle of the art: the contact shadow's tint. */
  raw: RGB;
}

const PROXY_PREFIX = "http://127.0.0.1:11471/img?";
/** Palettes by url, LRU. A Home session cycles a few dozen slides at most. */
const PALETTE_CAP = 32;
const palettes = new Map<string, HeroPalette>();
const inflight = new Map<string, Promise<HeroPalette | null>>();
/** The sample grid (the mockup's 15 x 6), each cell averaged from 4 x 4. */
const GX = 15, GY = 6, SUB = 4;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
/** A colour pushed to at least 0.55 saturation at lightness L (the mockup's
 *  vivid()), so a glow reads as light of that hue, not a grey wash. */
function vivid(c: RGB, L: number): RGB {
  const [h, s] = rgbToHsl(c[0], c[1], c[2]);
  return hslToRgb(h, Math.max(s, 0.55), L);
}

/** True when `url` is the loopback resize proxy (the only CORS-readable art). */
export function isReadableArt(url: string | null | undefined): url is string {
  return !!url && url.startsWith(PROXY_PREFIX);
}

/** The palette already computed for `url`, or null. */
export function peekHeroPalette(url: string | null | undefined): HeroPalette | null {
  return url ? palettes.get(url) ?? null : null;
}

/** The dominant colours of a hero slide (see the header), or null when the
 *  art cannot be read. Cached by url; concurrent asks share one read. */
export function heroPalette(url: string | null | undefined): Promise<HeroPalette | null> {
  if (!isReadableArt(url)) return Promise.resolve(null);
  const hit = palettes.get(url);
  if (hit) {
    palettes.delete(url);
    palettes.set(url, hit);
    return Promise.resolve(hit);
  }
  const running = inflight.get(url);
  if (running) return running;
  const job = readPalette(url)
    .catch(() => null)
    .then((p) => {
      inflight.delete(url);
      if (p) {
        palettes.set(url, p);
        while (palettes.size > PALETTE_CAP) palettes.delete(palettes.keys().next().value as string);
      }
      return p;
    });
  inflight.set(url, job);
  return job;
}

async function readPalette(url: string): Promise<HeroPalette | null> {
  if (typeof createImageBitmap !== "function") return null;
  const res = await fetch(url, { mode: "cors", cache: "no-store", credentials: "omit" });
  if (!res.ok) return null;
  const blob = await res.blob();
  const w = GX * SUB, h = GY * SUB;
  const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  try {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, w, h).data;
    c.width = c.height = 0;
    const avg = (x0: number, x1: number, y0: number, y1: number): RGB => {
      let r = 0, gg = 0, b = 0, n = 0;
      for (let y = y0 * SUB; y < y1 * SUB; y++) {
        for (let x = x0 * SUB; x < x1 * SUB; x++) {
          const o = (y * w + x) * 4;
          r += d[o]; gg += d[o + 1]; b += d[o + 2]; n++;
        }
      }
      return n ? [r / n, gg / n, b / n] : [0, 0, 0];
    };
    return {
      left: vivid(avg(0, 5, 0, 6), 0.52),
      center: vivid(avg(5, 10, 0, 6), 0.56),
      right: vivid(avg(10, 15, 0, 6), 0.56),
      top: vivid(avg(0, 15, 0, 3), 0.5),
      raw: avg(4, 11, 1, 6).map(Math.round) as RGB,
    };
  } finally {
    bmp.close();
  }
}

// ---- dithered images -----------------------------------------------------

/** A short blob: url (glassGlint.ts svgImageUrl: a long data: url in a
 *  var()-substituted background costs every style recalc of the element).
 *  The caller releases it (releaseSvgImage) once nothing shows it. */
const enc = (svg: string) => svgImageUrl(svg);
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
const NOISE = "<feTurbulence type='fractalNoise' baseFrequency='0.7' seed='7' result='n0'/>"
  + "<feColorMatrix in='n0' values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0' result='n'/>";

export interface Glow {
  /** Centre and sigmas (px, viewport space). */
  cx: number; cy: number; sx: number; sy: number;
  c: RGB;
  /** Peak alpha. */
  p: number;
}

/** The mockup's bleedGlows(): centre, left (under the rail), top, right,
 *  plus a flank glow on each side when the hero leaves more than 200 px
 *  there (ultrawide). `hero` is the hero's box in viewport space AT SCROLL 0;
 *  `strength` is the bleed (0.20 = the user's 20%); `mainL` is where the
 *  content column starts (right of the rail). */
export function bleedGlows(
  hero: { x: number; y: number; w: number; h: number },
  pal: HeroPalette, W: number, H: number, strength: number, mainL: number,
): Glow[] {
  const a = strength, f = H / 900, hs = hero.w / 1050;
  const cx = hero.x + hero.w / 2, cy = hero.y + hero.h / 2;
  const G: Glow[] = [
    { cx, cy, sx: hero.w * 0.55, sy: 240 * f, c: pal.center, p: a },
    { cx: 118, cy: 330 * f, sx: 230, sy: 380 * f, c: pal.left, p: a * 0.9 },
    { cx, cy: 40 * f, sx: Math.max(hero.w * 0.7, W * 0.38), sy: 120 * f, c: pal.top, p: a * 0.7 },
    { cx: hero.x + hero.w * 0.9, cy: cy - 60 * f, sx: 320 * hs, sy: 220 * f, c: pal.right, p: a * 0.6 },
  ];
  const flL = hero.x - mainL, flR = W - (hero.x + hero.w);
  if (flL > 200) G.push({ cx: mainL + flL * 0.55, cy, sx: flL * 0.55, sy: hero.h * 0.6, c: pal.left, p: a * 0.7 });
  if (flR > 200) G.push({ cx: W - flR * 0.55, cy, sx: flR * 0.55, sy: hero.h * 0.6, c: pal.right, p: a * 0.7 });
  return G.slice(0, 6);
}

/** The bleed as ONE W x H dithered image. Each glow is an elliptical
 *  Gaussian (exp(-d^2 / 2), cut at 3 sigma) at alpha p / K, SUMMED with the
 *  others at full range (`mix-blend-mode: plus-lighter` inside the filtered,
 *  so isolated, group: premultiplied colour and alpha add, as the mockup's
 *  straight sum; plain over-compositing read 10 to 15% weak where glows
 *  overlap, measured in review round 9), then the whole is scaled by K = sum
 *  of the peaks (at most 0.95) in the one feComposite that adds the noise.
 *  The alphas at full range sum to at most 1, so nothing clamps. */
export function bleedImage(glows: Glow[], W: number, H: number, dither = 0.014): string {
  const K = Math.min(0.95, glows.reduce((s, g) => s + g.p, 0));
  if (!(K > 0) || W < 2 || H < 2) return "none";
  const STOPS = 12;
  const tail = Math.exp(-4.5);
  let defs = "";
  let rects = "";
  glows.forEach((g, i) => {
    const a = g.p / K;
    let stops = "";
    for (let s = 0; s <= STOPS; s++) {
      const t = s / STOPS;
      const v = Math.max(0, (Math.exp(-4.5 * t * t) - tail) / (1 - tail)) * a;
      stops += `<stop offset='${t.toFixed(3)}' stop-color='rgb(${g.c.join(",")})' stop-opacity='${v.toFixed(4)}'/>`;
    }
    const r = 3 * g.sx;
    const ky = g.sy / g.sx;
    defs += `<radialGradient id='g${i}' gradientUnits='userSpaceOnUse' cx='${f2(g.cx)}' cy='${f2(g.cy)}' r='${f2(r)}' `
      + `gradientTransform='translate(0 ${f2(g.cy)}) scale(1 ${ky.toFixed(4)}) translate(0 ${f2(-g.cy)})'>${stops}</radialGradient>`;
    rects += `<rect width='${W}' height='${H}' fill='url(#g${i})' style='mix-blend-mode:plus-lighter'/>`;
  });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>`
    + `<defs>${defs}<filter id='d' x='0' y='0' width='1' height='1' color-interpolation-filters='sRGB'>${NOISE}`
    + `<feComposite in='SourceGraphic' in2='n' operator='arithmetic' k2='${K.toFixed(4)}' k3='${dither.toFixed(4)}' k4='${(-dither / 2).toFixed(4)}'/>`
    + `</filter></defs><g filter='url(#d)'>${rects}</g></svg>`;
  return enc(svg);
}

export interface UnderglowSpec {
  /** Hero size, px. */
  w: number; h: number;
  /** Room past each hero edge (px, at most PAD): the image is that much
   *  larger than the hero on each side, and fades to 0 at every image edge
   *  (over FADE_K x PAD, or over all of the room on a side short of PAD,
   *  where a clip box would otherwise cut the halo). */
  left: number; right: number; top: number; bottom: number;
  shadow: RGB; halo: RGB;
  /** Contact shadow alpha (0.55) and halo alpha (min(0.3, bleed x 1.4)). */
  aS: number; aH: number;
  /** Geometry scale (default 1, the hero): the insets, both sigmas and the
   *  pad a side is measured against all scale by it. The Home cards' hover
   *  underglow (cardGlow.ts) uses 0.6. */
  scale?: number;
}
/** The pad the underglow wants past every hero edge (the mockup's UG_PAD). */
export const UNDERGLOW_PAD = 110;
/** A side with the full pad fades to 0 over its outer FADE_K x pad. */
const FADE_K = 0.6;

/** The underglow as one dithered image, (left + w + right) x (top + h + bottom):
 *  a contact shadow (a box inset 14 px at the sides, 24 px down from the top,
 *  20 px past the bottom, blurred at sigma 26) in `shadow` at aS, plus a halo
 *  (the hero box blurred at sigma 62) in `halo` at aH. A Gaussian blur of a
 *  box IS the mockup's erf product. The halo carries the noise at full range
 *  (amplitude dither / aH), and the final feComposite sums
 *  aS x shadow + aH x halo, so the one rounding is dithered. With no halo
 *  (aH under 0.01) the shadow carries the noise instead (dither / aS). */
export function underglowImage(s: UnderglowSpec, dither = 0.014): string {
  const W = Math.round(s.left + s.w + s.right), H = Math.round(s.top + s.h + s.bottom);
  if (W < 4 || H < 4 || !(s.aH > 0 || s.aS > 0)) return "none";
  const ox = s.left, oy = s.top;
  const k = s.scale && s.scale > 0 ? s.scale : 1;
  const sh = { x: ox + 14 * k, y: oy + 24 * k, w: Math.max(1, s.w - 28 * k), h: Math.max(1, s.h - 4 * k) };
  const aH = Math.max(0.001, s.aH);
  const nk = dither / aH;
  const shadowOnly = s.aH < 0.01 && s.aS >= 0.01;
  const region = `x='0' y='0' width='${W}' height='${H}'`;
  // EVERY side fades to 0 at the image edge. The halo (sigma 62) is still
  // about 4% of its peak at the pad (110 px, 1.8 sigma), so an image edge cut
  // there drew a hard 2-level vertical line in the soft light beside the hero
  // (the round 11 "banding next to the hero" report, measured at 3456 px:
  // the one step in the gap between the rail and the hero) and a horizontal
  // one between the row cards under it. A side with the full pad fades over
  // its outer FADE_K x pad (the look within 0.4 pad of the hero is
  // unchanged); a side short of the pad (a clip box closer) fades over all of
  // its room, as before. Eased (smoothstep) ramps, so the product has no
  // crease; the halo is a few levels there, and the mask multiplies the
  // already dithered result, so the noise survives.
  const pad = UNDERGLOW_PAD * k;
  const fadeLen = (room: number) => Math.max(1, room < pad - 0.5 ? room : pad * FADE_K);
  const fl = fadeLen(s.left), fr = fadeLen(s.right), ft = fadeLen(s.top), fb = fadeLen(s.bottom);
  // One gradient per axis: a smoothstep rise over [0, near], flat, a
  // smoothstep fall over [len - far, len] (stop offsets ascending).
  const axis = (id: string, vertical: boolean, near: number, far: number, len: number) => {
    const n = Math.min(near, len / 2), f = Math.min(far, len / 2);
    let stops = "";
    const stop = (px: number, v: number) => {
      stops += `<stop offset='${Math.min(1, Math.max(0, px / len)).toFixed(5)}' stop-color='#fff' stop-opacity='${v.toFixed(4)}'/>`;
    };
    for (let i = 0; i <= 8; i++) { const t = i / 8; stop(t * n, t * t * (3 - 2 * t)); }
    for (let i = 0; i <= 8; i++) { const t = i / 8; stop(len - f + t * f, 1 - t * t * (3 - 2 * t)); }
    return `<linearGradient id='${id}' gradientUnits='objectBoundingBox' x1='0' y1='0' x2='${vertical ? 0 : 1}' y2='${vertical ? 1 : 0}'>`
      + stops + `</linearGradient>`;
  };
  const mask = axis("fh", false, fl, fr, W) + axis("fv", true, ft, fb, H)
    + `<mask id='mv' maskUnits='userSpaceOnUse' ${region}><rect width='${W}' height='${H}' fill='url(#fv)'/></mask>`
    + `<mask id='m' maskUnits='userSpaceOnUse' ${region}><g mask='url(#mv)'><rect width='${W}' height='${H}' fill='url(#fh)'/></g></mask>`;
  const maskRef = " mask='url(#m)'";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><defs>${mask}`
    + `<filter id='u' filterUnits='userSpaceOnUse' ${region} color-interpolation-filters='sRGB'>`
    + `<feFlood flood-color='rgb(${s.shadow.join(",")})' x='${f2(sh.x)}' y='${f2(sh.y)}' width='${f2(sh.w)}' height='${f2(sh.h)}' result='s0'/>`
    + `<feGaussianBlur in='s0' stdDeviation='${f2(26 * k)}' ${region} result='s'/>`
    + `<feFlood flood-color='rgb(${s.halo.join(",")})' x='${ox}' y='${oy}' width='${s.w}' height='${s.h}' result='h0'/>`
    + `<feGaussianBlur in='h0' stdDeviation='${f2(62 * k)}' ${region} result='h'/>`
    + NOISE.replace("<feTurbulence ", `<feTurbulence ${region} `).replace("<feColorMatrix ", `<feColorMatrix ${region} `)
    + (shadowOnly
      // No halo (a card with no palette): the shadow branch carries the
      // noise, or it would reach the output at aH (0.001) and the contact
      // shadow would round with no dither.
      ? `<feComposite in='s' in2='n' operator='arithmetic' k2='1' k3='${(dither / s.aS).toFixed(4)}' k4='${(-dither / (2 * s.aS)).toFixed(4)}' ${region} result='sn'/>`
        + `<feComposite in='sn' in2='h' operator='arithmetic' k2='${s.aS.toFixed(4)}' k3='0' ${region}/>`
      : `<feComposite in='h' in2='n' operator='arithmetic' k2='1' k3='${nk.toFixed(4)}' k4='${(-nk / 2).toFixed(4)}' ${region} result='hn'/>`
        + `<feComposite in='s' in2='hn' operator='arithmetic' k2='${s.aS.toFixed(4)}' k3='${aH.toFixed(4)}' ${region}/>`)
    + `</filter></defs><rect width='${W}' height='${H}' fill='#000' filter='url(#u)'${maskRef}/></svg>`;
  return enc(svg);
}
