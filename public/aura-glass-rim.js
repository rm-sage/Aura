// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// aura-glass-rim.js: the CSS paint worklet `aura-rim` (registered by
// src/glassGlint.ts through CSS.paintWorklet.addModule). It draws the thin
// RIM of a glass surface: one ring along the border box, lit by
//
//   - the idle rim: two corner-anchored radials, top-left (--lg-idle-tl
//     fading to --lg-idle-mid) and bottom-right (--lg-idle-br fading to 0),
//     each over --rc = clamp(0.9 * min(w, h), 24px, 96px), scaled by the
//     document-wide --lg-idle-k (1 idle, 0.62 while the pointer is live,
//     0 on High Contrast);
//   - the lit rim (round 12, "physical glass, not a spotlight"): a crisp
//     SPECULAR GLINT on the part of the rim nearest the pointer, plus a soft
//     tail around it. The glint is a tight radial (CORE_R of the light's
//     radius) centred on the rim point nearest the pointer (--gx / --gy,
//     measured from the border box, may lie outside it), so it slides along
//     the edge facing the pointer and stays sharp however far the pointer
//     is; its strength falls as (1 - d / R)^2 with the pointer's distance d
//     to that point. With the pointer INSIDE the box it is centred on the
//     pointer instead, its radius grown by d, so every edge equally near
//     catches it (both long edges of a bar) and it fades deep inside a big
//     panel. It is a cool white (COOL). The tail is the round 11
//     radial at the pointer itself (radius --lg-rim-r) at TAIL of the peak,
//     with a bounce on the opposite side (radius 0.7 R at the point mirrored
//     through the centre, BOUNCE of the peak, 0 at 70%). Peak --lg-rim-peak
//     (0.46) times the user's "Edge highlights" --lg-glow-edge-k (default
//     1.25) times the light's fade --lg-glint-a;
//   - a soft HALO just inside the glint (round 11): the glint again on the
//     one device pixel right inside the hairline, at HALO, so the line has a
//     faint inner side instead of reading as a harder white outline;
//   - chromatic dispersion (--lg-disp 1): two copies of the glint offset one
//     device pixel along the pointer direction (--gnx / --gny), blue
//     70 150 255 inward on the lit side and red 255 70 90 outward, at DISP of
//     the glint, under the white one. A copy offset outward is clipped by the
//     border box (a background cannot paint outside it), so only the inward
//     fringe shows, on the pixel right inside the hairline.
//
// CORNERS (round 12, the user: "the bottom corners of some panels are
// missing the edge highlight"): a 1px stroke along a corner arc is split by
// antialiasing over two pixels and stippled by the raster, and the
// background's own rounded clip cuts the outer pixel, so the arc drew at
// about a third of a straight edge's light (measured on a Settings sheet,
// pointer 18 px left of its bottom-left corner: 22 levels over the face at
// the arc's 45 degree point against 65 on the left edge). The top corners hid
// it behind the idle rim's top-left radial; the bottom ones showed a lit edge
// that stopped dead at each arc. So the rings that carry the rim (idle, tail,
// glint) are 1.5px wide: an arc then covers a solid band and reads as bright
// as the straight edges (same sheet: 60 levels at the arc), and a straight
// edge keeps its crisp outer pixel with the next one at half (round 11's first halo ring
// was 30% there, so it is gone). Measured on test boxes at 10, 18 and 28 px
// radii: 2px read heavier than the edges. The faint rings (the halo 2px in,
// the dispersion copies, the bounce) stay 1px.
//
// HAIRLINE (round 14, the user: "a faint, thick translucent light band ...
// along the inside of the top and left rounded edges rather than a crisp 1px
// edge highlight", the Settings CONTENTS card and the Home Catalog Sources
// card). That 1.5px band was the band: on a straight edge it lit the outer
// pixel AND the next one at about 60% (Haze sheet, idle, the top-left radial:
// +12 and +7 over the face), and at 150% display scale 1.5 CSS px is 2.25
// device pixels, so two full rows plus a third (+13 +13 +3); lit, with the
// halo 2px in and the blue copy 1.6px in, the band was three pixels (left
// edge +67 +40 +11). Now every ring that carries the rim is the band from
// one device pixel OUTSIDE the border box to one device pixel inside it
// (`rim`): outside the box the stroke is cut by the canvas on a straight edge
// and by the background's rounded clip on an arc, so a straight edge lights
// exactly its outer device pixel, and an arc keeps its light because only
// the clip's antialiasing (not the stroke's as well) thins its outer pixel
// (lit bottom-left arc at 45 degrees: 70 levels against 90 on the left edge;
// a plain 1px stroke drew a third). The halo and the blue fringe sit on the
// one device pixel inside it, so a lit rim is at most two pixels (+90 +27).
// The device pixel comes from --lg-dpr (glassGlint.ts writes
// devicePixelRatio there; a worklet's own devicePixelRatio reads 1 here,
// while its canvas is device resolution), and a hairline is
// max(1, floor(dpr)) device pixels: one up to 200% scale, two from there. A
// box at a FRACTIONAL device position (common at 125%) has every edge
// antialiased over two pixels, its border included; the hairline there reads
// as one soft line at about half strength, never a band.
//
// THICKER GLINT (2026-11-24, the user: the lit edge got "pretty thin" after
// the band fix, "a few pixels thicker" without the band back). The GLINT
// alone is now four device pixels, outside in: white, white at BODY, the blue
// fringe, the halo. The idle rim and the tail still light one device pixel:
// they run along whole edges, and round 14's band was the idle rim's second
// pixel. The glint is a tight radial at the pointer's rim point, so the extra
// pixels only ever light a short, moving stretch of edge.
//
// A 1px line has no large smooth area, so it needs no dither (the 8-bit
// banding rule is about the interior light and the hero glows).
//
// Every input is read as a string and parsed, so registered and unregistered
// properties work alike. Plain JS in public/: the CSP allows worklet modules
// from 'self' only, and a worklet cannot import the app's TypeScript.

const num = (props, name, dflt) => {
  const v = props.get(name);
  const n = v == null ? NaN : parseFloat(String(v));
  return Number.isFinite(n) ? n : dflt;
};

/** One corner radius in px (a percentage is taken against the shorter side;
 *  an elliptical pair keeps its first value). */
const radius = (props, name, w, h) => {
  const s = String(props.get(name) || "0").trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return s.indexOf("%") > 0 ? (n / 100) * Math.min(w, h) : n;
};

/** The glint's radius as a share of the light's radius, and its bounds (px). */
const CORE_R = 0.2;
const CORE_MIN = 36;
const CORE_MAX = 84;
/** The glint's profile: a tight core and a short soft shoulder. */
const CORE_PROFILE = [[0, 1], [0.18, 0.78], [0.45, 0.32], [0.75, 0.08], [1, 0]];
/** The tail (the radial at the pointer): its share of the peak and profile. */
const TAIL = 0.34;
const TAIL_PROFILE = [[0, 1], [0.3, 0.5], [0.6, 0.2], [1, 0]];
/** The bounce on the far side, as a share of the peak. */
const BOUNCE = 0.24;
/** The glint's second device pixel, white, at this share of the glint
 *  (2026-11-24, the user: the lit edge "has been pretty thin since the clear
 *  light band fix", asked a few pixels thicker without the band back). Only
 *  the GLINT widens: it is a tight radial (36 to 84 px) around the rim point
 *  nearest the pointer, so this never lights a long stretch of edge. The idle
 *  rim and the tail, which run along whole edges (the band the user saw in
 *  round 14 was the IDLE rim's second pixel), stay one device pixel. */
const BODY = 0.6;
/** The soft halo: the glint at this share on the device pixel inside the
 *  blue fringe (2026-11-24: the fourth lit pixel; round 14 had it on the
 *  second, beside a one-pixel glint). */
const HALO = 0.12;
/** The dispersion copies' share of the glint. 0.805 since 2026-11-24 (was
 *  0.7; the user: the fringe "isn't as visible / at all visible anymore"):
 *  with --lg-rim-peak 0.46 the blue pixel inside the hairline reads about
 *  1.8x its old chroma and stays one pixel, +38 to +41 levels, under half of
 *  the outer pixel. More (or the copies over the white, or a 2 px offset)
 *  passed +44 on that pixel or lit a third one (frontend-ui.md). */
const DISP = 0.805;
/** A cool white: the glint and the tail (a slight blue, never a colour). */
const COOL = "232,241,255";
const TAIL_C = "240,245,255";
/** Round 12 performance: a ring whose BRIGHTEST point on the rim is under
 *  this alpha (0.77 of one 8-bit level, white over black) is not stroked.
 *  Every rounded stroke is a path the GPU raster draws on each pointer frame
 *  (a lit surface strokes up to eight), and a surface near the edge of the
 *  reach holds several rings that round to nothing: in-page A/B on Home at
 *  2575 x 1038, pointer sweeping the CW row, 106 to 113 fps, pixel for pixel
 *  the same light. Each ring's bound is conservative (its peak where the rim
 *  comes nearest its centre). */
const VIS = 0.003;
/** Distance from (x, y) to a w x h box (0 inside): a lower bound of the
 *  distance to the rounded outline, so a bound built on it never skips a
 *  visible ring. */
const boxDist = (x, y, w, h) =>
  Math.hypot(x < 0 ? -x : x > w ? x - w : 0, y < 0 ? -y : y > h ? y - h : 0);
/** The tail's profile at t = r / R (TAIL_PROFILE, piecewise linear). */
const tailAt = (t) => {
  for (let i = 1; i < TAIL_PROFILE.length; i++) {
    const [o1, s1] = TAIL_PROFILE[i];
    if (t <= o1) {
      const [o0, s0] = TAIL_PROFILE[i - 1];
      return s0 + (s1 - s0) * ((t - o0) / (o1 - o0));
    }
  }
  return 0;
};

registerPaint("aura-rim", class {
  static get inputProperties() {
    return [
      "--gx", "--gy", "--gnx", "--gny", "--lg-glint-a",
      "--lg-idle-tl", "--lg-idle-mid", "--lg-idle-br", "--lg-idle-k",
      "--lg-rim-peak", "--lg-rim-r", "--lg-disp", "--lg-glow-edge-k", "--lg-dpr",
      "border-top-left-radius", "border-top-right-radius",
      "border-bottom-right-radius", "border-bottom-left-radius",
    ];
  }

  paint(ctx, size, props) {
    const w = size.width, h = size.height;
    if (!(w >= 3 && h >= 3)) return;
    const half = Math.min(w, h) / 2;
    const r = [
      radius(props, "border-top-left-radius", w, h),
      radius(props, "border-top-right-radius", w, h),
      radius(props, "border-bottom-right-radius", w, h),
      radius(props, "border-bottom-left-radius", w, h),
    ].map((v) => Math.min(v, half));
    /** Strokes a ring `lw` px wide starting `inset` px inside the border
     *  box (the current transform carries any offset) with `style`: a
     *  stroke centred on the rounded rect lw / 2 in covers exactly the band
     *  between the outer rounded rect and the one lw inside it. Round 11:
     *  each light used to clip to that ring (two rounded rects, evenodd) and
     *  fill the whole box, ten times per lit surface. GPU raster has no fast
     *  path for such a clip, so each one became a coverage mask the size of
     *  the box, and the lit hero bezel (1450 x 620) alone cost about 3.5 ms
     *  of GPU-process time per frame while the pointer moved (measured on
     *  Home). A stroked rounded rect is the raster's own fast path (drawn
     *  analytically): keep every ring ONE plain roundRect, never a path with
     *  extra arcs (round 12 tried the corner arcs as a separate stroke: 13%
     *  fewer frames while the pointer moved over Home). Round 14: the lights
     *  that carry the rim go through `rim` (see the header, HAIRLINE). */
    const ring = (style, inset, lw) => {
      const c = inset + lw / 2;
      ctx.beginPath();
      ctx.roundRect(c, c, w - 2 * c, h - 2 * c, r.map((v) => Math.max(0, v - c)));
      ctx.lineWidth = lw;
      ctx.strokeStyle = style;
      ctx.stroke();
    };
    /** The hairline in CSS px: whole device pixels, at least one. */
    const dpr = Math.max(0.25, num(props, "--lg-dpr", 1));
    const H = Math.max(1, Math.floor(dpr)) / dpr;
    /** The rim hairline: the band from H outside the border box to H inside
     *  it, a stroke centred ON the outline. The outer half is cut by the
     *  canvas (straight edges) or the rounded background clip (arcs). */
    const rim = (style) => ring(style, -H, 2 * H);

    // Idle rim: corner-anchored, so the other two corners fade whatever the
    // aspect ratio.
    const k = Math.max(0, num(props, "--lg-idle-k", 1));
    const tl = num(props, "--lg-idle-tl", 0) * k;
    const mid = num(props, "--lg-idle-mid", 0) * k;
    const br = num(props, "--lg-idle-br", 0) * k;
    if (tl > 0 || mid > 0 || br > 0) {
      const rc = Math.max(24, Math.min(96, 0.9 * Math.min(w, h)));
      // A canvas radial gradient pads with its end colour, as a CSS one
      // does: --lg-idle-mid stays beyond --rc.
      const g1 = ctx.createRadialGradient(0, 0, 0, 0, 0, rc);
      g1.addColorStop(0, `rgba(255,255,255,${tl})`);
      g1.addColorStop(1, `rgba(255,255,255,${mid})`);
      rim(g1);
      if (br > 0) {
        const g2 = ctx.createRadialGradient(w, h, 0, w, h, rc);
        g2.addColorStop(0, `rgba(255,255,255,${br})`);
        g2.addColorStop(1, "rgba(255,255,255,0)");
        rim(g2);
      }
    }

    // Lit rim.
    const a = num(props, "--lg-glint-a", 0);
    if (!(a > 0.002)) return;
    const pk = num(props, "--lg-rim-peak", 0.46) * Math.max(0, Math.min(3, num(props, "--lg-glow-edge-k", 1.25)))
      * Math.min(1, a);
    if (!(pk > 0)) return;
    const R = Math.max(1, num(props, "--lg-rim-r", 300));
    const gx = num(props, "--gx", -999), gy = num(props, "--gy", -999);

    // The rim point nearest the pointer (on the rounded outline) and the
    // pointer's distance to it.
    const inside = gx > 0 && gx < w && gy > 0 && gy < h;
    let qx, qy;
    if (inside) {
      const m = Math.min(gx, w - gx, gy, h - gy);
      qx = m === gx ? 0 : m === w - gx ? w : gx;
      qy = m === gx || m === w - gx ? gy : m === gy ? 0 : h;
    } else {
      qx = Math.max(0, Math.min(w, gx));
      qy = Math.max(0, Math.min(h, gy));
    }
    for (let i = 0; i < 4; i++) {
      const rr = r[i];
      if (rr < 1) continue;
      const cx = i === 0 || i === 3 ? rr : w - rr;
      const cy = i < 2 ? rr : h - rr;
      const inX = i === 0 || i === 3 ? qx < cx : qx > cx;
      const inY = i < 2 ? qy < cy : qy > cy;
      if (!inX || !inY) continue;
      const vx = gx - cx, vy = gy - cy, vl = Math.hypot(vx, vy);
      if (vl > 0.001) { qx = cx + (vx / vl) * rr; qy = cy + (vy / vl) * rr; }
      break;
    }
    const d = Math.hypot(gx - qx, gy - qy);
    const rc = Math.max(CORE_MIN, Math.min(CORE_MAX, CORE_R * R));
    // Outside: the glint sits ON the rim point, at the core radius, and
    // weakens as (1 - d / R)^2 with the pointer's distance. Inside: it is
    // centred on the pointer with the radius grown by that distance, so
    // every edge equally near catches it (both long edges of the search bar,
    // not whichever side won a tie) and it fades as the pointer goes deep
    // into a big panel; the two agree on the rim (d = 0).
    const near = inside ? 1 : Math.max(0, 1 - d / R);
    const glint = Math.min(1, pk * near * near);
    const ox = inside ? gx : qx, oy = inside ? gy : qy, orad = inside ? rc + d : rc;

    const core = (rgb, mul) => {
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, orad);
      const p = glint * mul;
      for (const [o, s] of CORE_PROFILE) g.addColorStop(o, `rgba(${rgb},${p * s})`);
      return g;
    };

    if (glint * DISP > VIS && num(props, "--lg-disp", 0) > 0) {
      const nx = Math.max(-1, Math.min(1, num(props, "--gnx", 0)));
      const ny = Math.max(-1, Math.min(1, num(props, "--gny", 0)));
      if (nx !== 0 || ny !== 0) {
        // Blue INWARD on the lit side (offset against the pointer direction),
        // red outward: a background paints only inside the border box, so
        // the outward copy is clipped there and the visible inner fringe is
        // the mockup's blue one (measured, review round 9: red inward read
        // magenta-white on the focused search bar; the mockup's is blue).
        // Offset one device pixel (round 14; was 1.6px, which put the blue
        // fringe two and three pixels in and widened the lit rim).
        ctx.save();
        ctx.translate(nx * H, ny * H);
        rim(core("255,70,90", DISP));
        // The blue copy one device pixel further in than round 14 put it
        // (shifted 2 H, its band covers the second and third pixels; the
        // white body takes the second), so the fringe sits right inside the
        // two-pixel white glint instead of under it.
        ctx.translate(-nx * 3 * H, -ny * 3 * H);
        rim(core("70,150,255", DISP));
        ctx.restore();
      }
    }

    // The tail and its bounce: the soft light around the glint. Each is
    // stroked only when its brightest point on the rim clears VIS: the
    // bounce falls linearly to 0 at 0.49 R from the mirrored point, the tail
    // follows TAIL_PROFILE from the pointer.
    const tp = Math.min(1, pk * TAIL);
    const bx = w - gx, by = h - gy;
    if (pk * BOUNCE * (1 - boxDist(bx, by, w, h) / (0.49 * R)) > VIS) {
      const gb = ctx.createRadialGradient(bx, by, 0, bx, by, 0.7 * R);
      gb.addColorStop(0, `rgba(${TAIL_C},${pk * BOUNCE})`);
      gb.addColorStop(0.7, `rgba(${TAIL_C},0)`);
      gb.addColorStop(1, `rgba(${TAIL_C},0)`);
      rim(gb);
    }
    const tailD = inside ? Math.min(gx, w - gx, gy, h - gy) : boxDist(gx, gy, w, h);
    if (tp * tailAt(tailD / R) > VIS) {
      const gt = ctx.createRadialGradient(gx, gy, 0, gx, gy, R);
      for (const [o, s] of TAIL_PROFILE) gt.addColorStop(o, `rgba(${TAIL_C},${tp * s})`);
      rim(gt);
    }

    if (!(glint > VIS)) return;
    rim(core(COOL, 1));
    // The body (the glint's second pixel) and the halo (inside the blue
    // fringe) are tied to the rim's own size: a box too small for more rings
    // inside (a 6px dot) gets neither. So the lit edge reads, outside in:
    // white, white at BODY, the blue fringe, a faint halo; four device pixels
    // where it was two, all inside the glint's tight radial.
    if (w >= 12 && h >= 12) {
      if (glint * BODY > VIS) ring(core(COOL, BODY), H, H);
      if (glint * HALO > VIS) ring(core(COOL, HALO), 3 * H, H);
    }
  }
});
