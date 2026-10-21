// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SymbolTracer — the stream panel's loading animation.
//
// Replaces SpectralPulse (three blurred discs orbiting a point). That read as
// generic: it said "busy" but nothing else, and three soft blobs at 36px blur
// tended to merge into one bluish smear.
//
// Here, particles race along a path and leave long neon trails, so the symbol
// they are drawing only resolves after a second or so. A fetch that takes
// 7 to 12 seconds gets something worth looking at, and the symbol is different
// every time, so a user who refreshes twice can see that something actually
// restarted rather than wondering whether the same frozen loop is still up.
//
// Flat symbols hold still while they form; the 3D ones (knots, an atom, a
// globe, polyhedra) turn slowly. Those are projected with perspective and
// depth-cued (nearer strokes brighter and thicker), and drawn as vector
// strokes, so they stay crisp line art rather than shaded "CGI". No particle
// runs faster than a simple shape's (MAX_SPEED_LEN): the draw is meant to look
// deliberate, never frantic.
//
// FOUR THINGS THIS FILE HAS TO GET RIGHT, all of them recorded elsewhere as
// having burned someone before:
//
//  1. IT IS THE FIRST CANVAS IN THE APP, and the first perpetual rAF. Every
//     other loop here is a two-property CSS transform that the compositor
//     owns, and App.css says so explicitly. So this one carries its own gates:
//     it stops dead when the window is hidden, and it never starts at all
//     under reduced motion (where it renders the finished symbol instead).
//
//  2. IT MUST NOT MEASURE ITSELF ON MOUNT. The detail page plays a 380ms
//     entrance transform on its root, and getBoundingClientRect during that
//     returns the animating, scaled rect. That already froze the stream-meta
//     badges near screen centre once. Sizing comes from a ResizeObserver,
//     which re-fires after the transform settles.
//
//  3. THE TRAIL IS REDRAWN, NOT FADED. Neither of the two usual tricks works
//     here. Painting a low-alpha black rectangle each frame would turn the
//     translucent glass panel behind this into a dark box, and the fix for
//     THAT, a low-alpha `destination-out` fill, decays the destination alpha
//     by multiplication, which at 8-bit precision stops at a rounding floor
//     and never reaches zero. The leftover deposits built up into a permanent
//     grey ghost of the whole symbol under the coloured trails.
//
//     A particle's position is a pure function of distance along the path, so
//     its trail is simply the path segment behind it, and redrawing that from
//     scratch each frame gives an exact ramp to zero at the tail, no residue,
//     and no retained point history to bound.
//
//  4. EVERY PATH IS A CLOSED LOOP. Distance along a path wraps modulo its
//     length, so an OPEN path's end joins its start with a straight segment.
//     The old spiral was open: its last point sat on the rim and its first by
//     the centre, and once the trails had grown to cover the whole loop one of
//     them always straddled that seam, so a straight line from the rim to the
//     centre appeared and stayed for the rest of the animation. `closeLoop`
//     makes the last point the first, exactly, for every path.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";

import { useWindowHidden } from "./windowVisibility";

/** A point in symbol space: centred on the origin, y pointing DOWN (canvas
 *  convention), z toward the viewer. `normalize` fits every symbol to a sphere
 *  of radius `R`. Plain point lists rather than Path2D so a particle can be
 *  placed at an arbitrary distance along a path without the browser's help. */
type P3 = { x: number; y: number; z: number };

const R = 0.44;
const TAU = Math.PI * 2;

/** "still": a flat symbol, held upright (tilting one while its trails were
 *  still forming the shape looked wrong, and so did a random angle). "orbit": a near-planar 3D one (a torus knot) turning in its
 *  own plane while it rocks, so it never goes edge-on and collapses to a line.
 *  "tumble": a volumetric one (a globe) turning continuously about a tilted
 *  axis. */
type Motion = "still" | "orbit" | "tumble";

interface SymbolDef {
  id: string;
  loops: P3[][];
  motion: Motion;
}

// ── Path builders ───────────────────────────────────────────────────────────

const p3 = (x: number, y: number, z = 0): P3 => ({ x, y, z });

/** Make the last point EXACTLY the first (rule 4 in the header): a periodic
 *  curve's sampled end, a hair off its start in floating point, is replaced;
 *  a path that ends anywhere else gets the start appended. */
function closeLoop(pts: P3[]): P3[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const near = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6;
  return [...(near ? pts.slice(0, -1) : pts), { ...a }];
}

/** Sample a periodic curve over [t0, t1] into a closed loop. */
function curve(n: number, t1: number, f: (t: number) => P3): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= n; i += 1) out.push(f((i / n) * t1));
  return closeLoop(out);
}

function polygon(sides: number, rot = -Math.PI / 2): P3[] {
  const out: P3[] = [];
  for (let i = 0; i <= sides; i += 1) {
    const a = rot + (i / sides) * TAU;
    out.push(p3(Math.cos(a), Math.sin(a)));
  }
  return closeLoop(out);
}

function star(points: number, inner: number): P3[] {
  const out: P3[] = [];
  const steps = points * 2;
  for (let i = 0; i <= steps; i += 1) {
    const a = -Math.PI / 2 + (i / steps) * TAU;
    const r = i % 2 === 0 ? 1 : inner;
    out.push(p3(Math.cos(a) * r, Math.sin(a) * r));
  }
  return closeLoop(out);
}

/** A circle in the XY plane, for the multi-ring symbols to rotate into place. */
const circle = (r = 1, n = 120) => curve(n, TAU, (t) => p3(Math.cos(t) * r, Math.sin(t) * r));

/** Rotate a loop about X, then Y, then Z. */
function rotate(pts: P3[], ax: number, ay: number, az: number): P3[] {
  return pts.map(({ x, y, z }) => {
    let y1 = y * Math.cos(ax) - z * Math.sin(ax);
    let z1 = y * Math.sin(ax) + z * Math.cos(ax);
    const x2 = x * Math.cos(ay) + z1 * Math.sin(ay);
    z1 = -x * Math.sin(ay) + z1 * Math.cos(ay);
    const x3 = x2 * Math.cos(az) - y1 * Math.sin(az);
    y1 = x2 * Math.sin(az) + y1 * Math.cos(az);
    return p3(x3, y1, z1);
  });
}

/** Centre a symbol on its bounding box and scale it to fit radius R. */
function normalize(loops: P3[][]): P3[][] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const l of loops) for (const p of l) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let far = 0;
  for (const l of loops) for (const p of l) {
    far = Math.max(far, Math.hypot(p.x - cx, p.y - cy, p.z - cz));
  }
  const k = far > 0 ? R / far : 1;
  return loops.map((l) => l.map((p) => p3((p.x - cx) * k, (p.y - cy) * k, (p.z - cz) * k)));
}

/** A crescent: the outer arc of the unit circle from 60 to 300 degrees through
 *  the left, back along an inner arc bulging the same way, whose circle passes
 *  through both tips and reaches x = -0.3 (solved for its centre c on the x
 *  axis: (0.5 - c)^2 + 0.75 = (c + 0.3)^2). */
function crescent(): P3[] {
  const out: P3[] = [];
  const n = 90;
  for (let i = 0; i <= n; i += 1) {
    const a = (Math.PI / 3) + (i / n) * (TAU - (2 * Math.PI) / 3);
    out.push(p3(Math.cos(a), Math.sin(a)));
  }
  const c = 0.91 / 1.6;
  const rho = c + 0.3;
  const from = Math.atan2(-Math.sin(Math.PI / 3), 0.5 - c) + TAU;
  const to = Math.atan2(Math.sin(Math.PI / 3), 0.5 - c);
  for (let i = 1; i <= n; i += 1) {
    const a = from + (i / n) * (to - from);
    out.push(p3(c + Math.cos(a) * rho, Math.sin(a) * rho));
  }
  return closeLoop(out);
}

/** The edges of the cuboctahedron are exactly four hexagonal great circles,
 *  one perpendicular to each body diagonal, so it draws as four loops. */
function cuboctahedron(): P3[][] {
  const verts: P3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    verts.push(p3(a, b, 0), p3(a, 0, b), p3(0, a, b));
  }
  const normals = [p3(1, 1, 1), p3(1, 1, -1), p3(1, -1, 1), p3(-1, 1, 1)];
  return normals.map((n) => {
    const ring = verts.filter((v) => Math.abs(v.x * n.x + v.y * n.y + v.z * n.z) < 1e-9);
    // An in-plane basis to order the six vertices by angle.
    const u = ring[0];
    const w = p3(n.y * u.z - n.z * u.y, n.z * u.x - n.x * u.z, n.x * u.y - n.y * u.x);
    const ang = (v: P3) => Math.atan2(
      v.x * w.x + v.y * w.y + v.z * w.z,
      v.x * u.x + v.y * u.y + v.z * u.z,
    );
    return closeLoop([...ring].sort((a, b) => ang(a) - ang(b)));
  });
}

// ── The symbols ─────────────────────────────────────────────────────────────

/** A quarter turn, carrying a feature on the +x axis to the top (y is down). */
const upright = (pts: P3[]) => rotate(pts, 0, 0, -Math.PI / 2);

function flat(id: string, ...loops: P3[][]): SymbolDef {
  return { id, loops: normalize(loops), motion: "still" };
}
function solid(id: string, ...loops: P3[][]): SymbolDef {
  return { id, loops: normalize(loops), motion: "tumble" };
}
function knot(id: string, ...loops: P3[][]): SymbolDef {
  return { id, loops: normalize(loops), motion: "orbit" };
}

// None of these is a dense tangle. The 5:4 and 3D Lissajous curves, the 2-7
// torus knot, a 14-turn coil ring, a double helix, a 7-petal rose and a soft
// spirograph were tried and taken out (user's call, 2026-10-21): they read as
// fast and chaotic rather than deliberate. So was a spiral, on taste.
//
// Flat symbols are drawn UPRIGHT (they are never turned at random): a polygon
// or star stands on a point, and a curve with a lobe or petal on its x axis is
// built turned a quarter turn (`upright`) so that lobe points up.
const SYMBOLS: SymbolDef[] = [
  // Flat, held still and upright.
  flat("triangle", polygon(3)),
  flat("diamond", polygon(4)),
  flat("pentagon", polygon(5)),
  flat("hexagon", polygon(6)),
  flat("star5", star(5, 0.42)),
  flat("star6", star(6, 0.58)),
  flat("star8", star(8, 0.5)),
  flat("infinity", curve(200, TAU, (t) => {
    const d = 1 + Math.sin(t) * Math.sin(t);
    return p3(Math.cos(t) / d, (Math.sin(t) * Math.cos(t) / d) * 1.56);
  })),
  flat("lobed", upright(curve(240, TAU, (a) => {
    const r = 0.68 + 0.32 * Math.cos(3 * a);
    return p3(Math.cos(a) * r, Math.sin(a) * r);
  }))),
  flat("wave-ring", curve(260, TAU, (a) => {
    // cos, not sin, so a crest sits at the top.
    const r = 0.86 + 0.14 * Math.cos(8 * a);
    return p3(Math.cos(a) * r, Math.sin(a) * r);
  })),
  flat("heart", curve(240, TAU, (t) => p3(
    16 * Math.sin(t) ** 3,
    -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  ))),
  flat("rose5", upright(curve(300, Math.PI, (a) => {
    const r = Math.cos(5 * a);
    return p3(Math.cos(a) * r, Math.sin(a) * r);
  }))),
  // Its petals sit between the cusps, the first a fifth of a half turn past
  // the x axis, hence the extra turn.
  flat("flower", rotate(curve(300, TAU, (t) => p3(
    6 * Math.cos(t) - Math.cos(6 * t),
    6 * Math.sin(t) - Math.sin(6 * t),
  )), 0, 0, -Math.PI / 2 - Math.PI / 5)),
  flat("nephroid", curve(240, TAU, (t) => p3(
    3 * Math.cos(t) - Math.cos(3 * t),
    3 * Math.sin(t) - Math.sin(3 * t),
  ))),
  // A spirograph (hypotrochoid): R = 5, r = 3, d = 5, closing after
  // r / gcd(R, r) = 3 turns.
  flat("spirograph", upright(curve(600, 6 * Math.PI, (t) => p3(
    2 * Math.cos(t) + 5 * Math.cos((2 / 3) * t),
    2 * Math.sin(t) - 5 * Math.sin((2 / 3) * t),
  )))),
  flat("lissajous-3-2", curve(300, TAU, (t) => p3(Math.sin(3 * t + Math.PI / 2), Math.sin(2 * t)))),
  flat("lightning", closeLoop([
    p3(0.15, -1), p3(-0.5, 0.15), p3(-0.05, 0.15), p3(-0.2, 1),
    p3(0.5, -0.2), p3(0.05, -0.2), p3(0.15, -1),
  ])),
  flat("crescent", crescent()),
  flat("eye",
    closeLoop([
      ...Array.from({ length: 61 }, (_, i) => p3(-Math.cos((Math.PI * i) / 60), -0.52 * Math.sin((Math.PI * i) / 60))),
      ...Array.from({ length: 61 }, (_, i) => p3(Math.cos((Math.PI * i) / 60), 0.52 * Math.sin((Math.PI * i) / 60))),
    ]),
    circle(0.34, 80),
  ),

  // 3D: near-planar knots orbit, the rest tumble.
  knot("trefoil-knot", curve(400, TAU, (t) => p3(
    Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t),
  ))),
  knot("figure-eight-knot", curve(500, TAU, (t) => {
    const r = 2 + Math.cos(2 * t);
    return p3(r * Math.cos(3 * t), r * Math.sin(3 * t), Math.sin(4 * t));
  })),
  ...([[2, 5], [3, 4]] as const).map(([p, q]) =>
    knot(`torus-knot-${p}-${q}`, curve(600, TAU, (t) => {
      const r = Math.cos(q * t) + 2;
      return p3(r * Math.cos(p * t), r * Math.sin(p * t), -Math.sin(q * t));
    })),
  ),
  // The tennis / baseball seam: a closed curve on a sphere (a + b = 1).
  solid("seam", curve(300, TAU, (t) => p3(
    0.7 * Math.cos(t) + 0.3 * Math.cos(3 * t),
    0.7 * Math.sin(t) - 0.3 * Math.sin(3 * t),
    2 * Math.sqrt(0.21) * Math.sin(2 * t),
  ))),
  solid("viviani", curve(300, 4 * Math.PI, (t) => p3(
    1 + Math.cos(t), Math.sin(t), 2 * Math.sin(t / 2),
  ))),
  solid("sphere-wave", curve(400, TAU, (t) => {
    const lat = 0.55 * Math.sin(5 * t);
    return p3(Math.cos(lat) * Math.cos(t), Math.sin(lat), Math.cos(lat) * Math.sin(t));
  })),
  // Three circular orbits, each tilted well out of the page, a third of a
  // turn apart: a real 3D atom, which never flattens to a line.
  solid("atom", ...[0, 1, 2].map((i) => rotate(circle(), 1.2, 0, (i * Math.PI) / 3))),
  solid("gyroscope",
    circle(), rotate(circle(), Math.PI / 2, 0, 0), rotate(circle(), 0, Math.PI / 2, 0)),
  solid("globe",
    rotate(circle(), Math.PI / 2, 0, 0),
    ...[-0.5, 0.5].map((y) => rotate(circle(Math.sqrt(1 - y * y)), Math.PI / 2, 0, 0).map((p) => p3(p.x, p.y + y, p.z))),
    ...[0, 1, 2].map((i) => rotate(circle(), 0, (i * Math.PI) / 3, 0)),
  ),
  solid("octahedron",
    closeLoop([p3(1, 0, 0), p3(0, 1, 0), p3(-1, 0, 0), p3(0, -1, 0)]),
    closeLoop([p3(0, 1, 0), p3(0, 0, 1), p3(0, -1, 0), p3(0, 0, -1)]),
    closeLoop([p3(0, 0, 1), p3(1, 0, 0), p3(0, 0, -1), p3(-1, 0, 0)]),
  ),
  solid("cuboctahedron", ...cuboctahedron()),
  // Borromean rings: three ellipses in the three coordinate planes.
  solid("borromean",
    curve(160, TAU, (t) => p3(Math.cos(t), 0.5 * Math.sin(t), 0)),
    curve(160, TAU, (t) => p3(0, Math.cos(t), 0.5 * Math.sin(t))),
    curve(160, TAU, (t) => p3(0.5 * Math.sin(t), 0, Math.cos(t))),
  ),
];

/** Hue at a fraction `frac` of the way round a loop: the full rainbow. */
const hueAt = (frac: number) => (((frac % 1) + 1) % 1) * 360;

// ── Picking ─────────────────────────────────────────────────────────────────

/** Segments drawn per particle trail per frame. High enough that the trail
 *  reads as a continuous stroke, low enough that an eight-particle symbol stays
 *  well inside one frame's budget. */
const TRAIL_STEPS = 26;
/** Most particles any symbol gets, across all of its loops. */
const MAX_PARTICLES = 8;
/** The most path a particle covers in one lap time, so a long path runs no
 *  faster than a simple shape does (about a circle's length, which is what the
 *  original shapes ran). A loop longer than this laps more slowly instead, and
 *  gets enough particles that its trails still meet within the first lap time. */
const MAX_SPEED_LEN = 3;
/** The symbol shown most recently, so the next play never repeats it. ONE
 *  string, module scope: the rule needs exactly one id remembered and an
 *  ever-growing set of "seen" symbols would be the sort of quiet unbounded
 *  growth this codebase does not allow. */
let lastSymbolId: string | null = null;

function pickSymbol(): SymbolDef {
  const pool = SYMBOLS.filter((s) => s.id !== lastSymbolId);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastSymbolId = chosen.id;
  return chosen;
}

/** Cumulative arc lengths, so a particle can be positioned by DISTANCE along
 *  the path rather than by index. Without this, particles crawl through dense
 *  stretches of a curve and jump across sparse ones. */
function measure(pts: P3[]) {
  const acc: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
    acc.push(total);
  }
  return { acc, total };
}

function pointAt(pts: P3[], acc: number[], total: number, d: number): P3 {
  const target = ((d % total) + total) % total;
  let lo = 0;
  let hi = acc.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] <= target) lo = mid; else hi = mid;
  }
  const span = acc[hi] - acc[lo] || 1;
  const f = (target - acc[lo]) / span;
  return {
    x: pts[lo].x + (pts[hi].x - pts[lo].x) * f,
    y: pts[lo].y + (pts[hi].y - pts[lo].y) * f,
    z: pts[lo].z + (pts[hi].z - pts[lo].z) * f,
  };
}

function prefersReducedMotion(): boolean {
  // Read the ATTRIBUTE, not the media query: the Settings control offers
  // always / never / auto, and only the attribute reflects that choice.
  return document.documentElement.getAttribute("data-reduced-motion") === "true";
}

/** Camera distance in symbol units. Close enough for real perspective on a
 *  tumbling knot, far enough that nothing distorts. */
const CAMERA = 3.2;
/** Screen scale, chosen so the nearest possible point (z = R, magnified by
 *  CAMERA / (CAMERA - R)) still lands inside the canvas with room for the
 *  head's glow. */
const FIT = 0.48 / (R * (CAMERA / (CAMERA - R)));

interface Props {
  /** Expected fetch duration in seconds. Paces the draw so the symbol has
   *  resolved well before a typical fetch returns. */
  capSeconds?: number;
  label?: string;
}

export default function SymbolTracer({ capSeconds = 7, label = "Discovering streams" }: Props) {
  const hostRef   = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hidden    = useWindowHidden();

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const symbol = pickSymbol();
    const loops = symbol.loops.map((pts) => ({ pts, ...measure(pts) }));
    const sumLen = loops.reduce((s, l) => s + l.total, 0);
    // Particles: 3 to 5 on a single loop, spaced evenly around it; on a
    // multi-loop symbol, shared out by length with at least one per loop. A
    // loop longer than MAX_SPEED_LEN gets at least one per MAX_SPEED_LEN of it,
    // because its particles run slower but its trails still have to meet
    // within the first lap time (and a trail must never outgrow the distance
    // its particle has travelled).
    const budget = loops.length === 1
      ? 3 + Math.floor(Math.random() * 3)
      : Math.min(MAX_PARTICLES, Math.max(loops.length, 5));
    const counts = loops.map((l) => Math.max(
      1,
      Math.round((budget * l.total) / sumLen),
      Math.ceil(l.total / MAX_SPEED_LEN),
    ));
    // Where a 3D symbol starts turning and which way, so two plays of the same
    // one do not look identical. A flat symbol ignores these: it stays upright.
    const roll = Math.random() * TAU;
    const phase = Math.random() * TAU;
    const dir = Math.random() < 0.5 ? -1 : 1;
    // One lap in roughly a third of the expected wait, so the symbol is
    // legible early and then keeps redrawing over itself. A loop longer than
    // MAX_SPEED_LEN takes proportionally longer per lap (`lapFor`).
    const lapMs = Math.max(1600, (capSeconds * 1000) / 3);
    const lapFor = (total: number) => lapMs * Math.max(1, total / MAX_SPEED_LEN);

    let raf = 0;
    let start = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    // Reduced motion: draw the finished symbol once and stop. The SIGNAL is
    // kept (there is clearly something in progress here), the MOTION is not.
    // Same shape as the poster-retry dot's reduced-motion rule.
    const still = prefersReducedMotion();

    // The rotation for this frame, as a 3x3 matrix applied to every point.
    let m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const orient = (elapsed: number) => {
      const s = elapsed / 1000;
      let yaw: number, pitch: number, spin: number;
      if (symbol.motion === "still") {
        yaw = 0;
        pitch = 0;
        spin = 0;
      } else if (symbol.motion === "orbit") {
        // A full turn in its own plane every 18 s while it rocks in 3D.
        yaw = 0.62 * Math.sin(phase + (s * TAU) / 10);
        pitch = 0.42 + 0.22 * Math.sin(phase * 1.3 + (s * TAU) / 14);
        spin = roll + dir * (s * TAU) / 18;
      } else {
        // One full turn about a tilted axis every 16 s, with a slow nod.
        yaw = phase + dir * (s * TAU) / 16;
        pitch = 0.5 + 0.22 * Math.sin((s * TAU) / 11);
        spin = roll;
      }
      const cz = Math.cos(spin), sz = Math.sin(spin);
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cx = Math.cos(pitch), sx = Math.sin(pitch);
      // Rx(pitch) * Ry(yaw) * Rz(spin).
      const a = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
      const b = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
      const c = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
      const mul = (p: number[], q: number[]) => [
        p[0] * q[0] + p[1] * q[3] + p[2] * q[6], p[0] * q[1] + p[1] * q[4] + p[2] * q[7], p[0] * q[2] + p[1] * q[5] + p[2] * q[8],
        p[3] * q[0] + p[4] * q[3] + p[5] * q[6], p[3] * q[1] + p[4] * q[4] + p[5] * q[7], p[3] * q[2] + p[4] * q[5] + p[5] * q[8],
        p[6] * q[0] + p[7] * q[3] + p[8] * q[6], p[6] * q[1] + p[7] * q[4] + p[8] * q[7], p[6] * q[2] + p[7] * q[5] + p[8] * q[8],
      ];
      m = mul(c, mul(b, a));
    };

    /** Screen position plus a depth cue: 0 at the far side, 1 at the near. */
    const project = (p: P3) => {
      const x = m[0] * p.x + m[1] * p.y + m[2] * p.z;
      const y = m[3] * p.x + m[4] * p.y + m[5] * p.z;
      const z = m[6] * p.x + m[7] * p.y + m[8] * p.z;
      const size = Math.min(w, h);
      const k = (CAMERA / (CAMERA - z)) * FIT * size;
      return { x: w / 2 + x * k, y: h / 2 + y * k, depth: Math.min(1, Math.max(0, 0.5 + z / (2 * R))) };
    };

    /** Stroke the path from distance d0 to d1, through every vertex between
     *  them, so a run follows the curve and turns a polygon's corner instead
     *  of cutting a chord across it.
     *
     *  Runs of a trail ABUT (one ends exactly where the next begins) and use
     *  butt caps. They used to overlap by 60% with round caps, and under
     *  additive blending every overlap drew at double brightness, so a faint
     *  tail read as a string of beads. Only the head's glow keeps round caps. */
    const strokeRun = (
      loop: (typeof loops)[number], d0: number, d1: number,
      hue: number, alpha: number, width: number, cap: CanvasLineCap,
    ) => {
      const { pts, acc, total } = loop;
      let s = ((d0 % total) + total) % total;
      let left = d1 - d0;
      if (left <= 0) return;
      // First vertex strictly past s.
      let lo = 0;
      let hi = acc.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (acc[mid] <= s) lo = mid; else hi = mid;
      }
      let i = hi;
      const first = project(pointAt(pts, acc, total, s));
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      let depthSum = first.depth;
      let count = 1;
      // A run is a small fraction of the loop, so this ends long before the
      // guard; the guard only bounds a pathological span.
      for (let guard = 0; guard < pts.length * 2; guard += 1) {
        const toVertex = acc[i] - s;
        if (toVertex >= left) {
          const end = project(pointAt(pts, acc, total, s + left));
          ctx.lineTo(end.x, end.y);
          depthSum += end.depth;
          count += 1;
          break;
        }
        const v = project(pts[i]);
        ctx.lineTo(v.x, v.y);
        depthSum += v.depth;
        count += 1;
        left -= toVertex;
        s = acc[i];
        i += 1;
        // The last point IS the first (rule 4), so carry on from the start.
        if (i >= pts.length) { i = 1; s = 0; }
      }
      // Nearer strokes are brighter and thicker; the far side recedes without
      // vanishing, which is what reads as depth on a turning wireframe.
      const depth = depthSum / count;
      ctx.strokeStyle = `hsla(${hue}, 100%, 62%, ${alpha * (0.38 + 0.62 * depth)})`;
      ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${0.9 * (0.4 + 0.6 * depth)})`;
      ctx.lineWidth = width * (0.7 + 0.55 * depth);
      ctx.lineCap = cap;
      ctx.stroke();
    };

    const drawStatic = () => {
      if (w === 0) return;
      orient(0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineJoin = "round";
      ctx.shadowBlur = 10;
      loops.forEach((loop, li) => {
        const steps = Math.max(60, Math.round((260 * loop.total) / sumLen));
        const step = loop.total / steps;
        for (let i = 0; i < steps; i += 1) {
          const frac = i / steps;
          strokeRun(loop, i * step, (i + 1) * step, hueAt(frac + li * 0.13), 0.5, 2, "butt");
        }
      });
      ctx.globalCompositeOperation = "source-over";
      ctx.shadowBlur = 0;
    };

    const resize = () => {
      // offsetWidth / offsetHeight, NOT getBoundingClientRect.
      //
      // This is the trap named at the top of this file, and the first version
      // of this function walked straight into it. The detail page plays a
      // 380ms scale transform on its root when it opens. getBoundingClientRect
      // returns the VISUAL box, so measuring mid-transform reports a shrunken
      // size, while offsetWidth reports the LAYOUT box and is unaffected by
      // any ancestor transform.
      //
      // The second half of the trap is why it never recovered: a transform
      // does not change an element's content box, so the ResizeObserver had
      // nothing to report once the animation settled and the shrunken
      // measurement stuck for the whole life of the loader. That is the "works
      // the first time, tiny blob every time after" symptom: the first open
      // measured after the transform had finished, every re-open measured
      // while it was still running.
      const nextW = host.offsetWidth;
      const nextH = host.offsetHeight;
      if (nextW < 8 || nextH < 8) return;
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextW === w && nextH === h && nextDpr === dpr) return;
      dpr = nextDpr;
      w = nextW;
      h = nextH;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // Assigning width or height resets the context, so the DPR transform has
      // to be re-established after every resize.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (still) drawStatic();
    });
    ro.observe(host);
    resize();

    // A DPR change alone (dragging to a monitor with another scale, or changing
    // the display scale) leaves the CSS size unchanged, so the content-box
    // observer never fires. A resolution media query does; it matches only the
    // DPR it was built for, so it is re-armed after every change.
    let mq: MediaQueryList | null = null;
    const onDpr = () => {
      armDpr();
      resize();
      if (still) drawStatic();
    };
    const armDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", onDpr);
    };
    armDpr();
    const stopDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = null;
    };

    if (still) {
      drawStatic();
      return () => { ro.disconnect(); stopDpr(); };
    }

    // THE HIDDEN GATE, which this file already claimed to have. `hidden` was
    // listed in the dependency array but never actually tested, so going hidden
    // only tore the rAF loop down and immediately rebuilt an identical one: the
    // animation kept running at full rate behind a minimised window, which is
    // the exact cost the gate exists to avoid. The ResizeObserver stays live so
    // the canvas is correctly sized the instant the window comes back, and the
    // effect re-runs on restore with fresh locals, so `resize()` re-measures
    // and clears before any new loop starts.
    if (hidden) return () => { ro.disconnect(); stopDpr(); };

    const frame = (ts: number) => {
      if (!start) start = ts;
      const elapsed = ts - start;

      if (w > 0) {
        // FULL CLEAR every frame, and the trail is REDRAWN rather than left to
        // decay. The previous version faded the canvas with a low-alpha
        // `destination-out` fill, which is the usual trick and is wrong here:
        // it multiplies the destination alpha per frame, and at 8-bit
        // precision that multiplication hits a rounding floor (5 * 0.955 is
        // 4.77, which rounds back to 5). The residue therefore never reached
        // zero, and every lap deposited a little more of it until a permanent
        // grey outline of the whole symbol sat under the coloured trails.
        //
        // Redrawing sidesteps it entirely. A particle's position is a pure
        // function of distance along the path, so its trail is just the path
        // segment behind it. That means an EXACT alpha ramp to zero at the
        // tail, no residue, and no retained point history to bound. The trail
        // lives in symbol space and turns with the symbol, so a tumbling knot
        // carries what has been drawn on it rather than smearing it.
        ctx.clearRect(0, 0, w, h);
        orient(elapsed);

        // Additive, so overlapping trails bloom where they cross instead of
        // occluding each other. This is what makes it read as neon, and it
        // makes the draw order irrelevant, so nothing needs depth sorting.
        ctx.globalCompositeOperation = "lighter";
        ctx.lineJoin = "round";

        const grow = Math.min(1, elapsed / lapMs);
        loops.forEach((loop, li) => {
          const n = counts[li];
          const head = (elapsed / lapFor(loop.total)) * loop.total;
          // Trails grow over the first lap until they meet, so the symbol
          // ASSEMBLES out of the trails rather than being present from frame
          // one. `total / n` is the length at which n evenly spaced trails
          // exactly close the loop.
          const trailLen = (loop.total / n) * grow;
          // One run per trail step, each ending where the next begins.
          const step = trailLen / TRAIL_STEPS;
          // The head's glow: ONE round-capped run over the brightest stretch
          // (several overlapping ones left bright dots where their caps met),
          // with a minimum length so the head shows in the first frames while
          // the trail is still near zero length.
          const glowBack = trailLen * 0.14;
          const glowLen = Math.max(glowBack + step, loop.total * 0.004);

          for (let p = 0; p < n; p += 1) {
            const d = head + (p / n) * loop.total;
            for (let k = TRAIL_STEPS; k >= 1; k -= 1) {
              // t: 1 at the head, approaching 0 at the tail.
              const t = k / TRAIL_STEPS;
              const dd = d - trailLen * (1 - t);
              // Hue runs with distance travelled, so each particle lays down a
              // continuously shifting band rather than one flat colour.
              const hue = hueAt(dd / loop.total + p / n + li * 0.13);
              // Squared falloff: the head stays bright and readable while the
              // tail thins out quickly, which is what makes the direction of
              // travel obvious.
              const a = t * t;
              // Glow only near the head. shadowBlur is the expensive part of a
              // stroke, and applying it down the whole trail cost far more than
              // it added: the bloom is only legible where the trail is bright.
              ctx.shadowBlur = t > 0.72 ? 12 : 0;
              strokeRun(loop, dd, dd + step, hue, a * 0.95, 1 + t * 1.8, "butt");
            }
            ctx.shadowBlur = 12;
            const glowFrom = d - glowBack;
            strokeRun(loop, glowFrom, glowFrom + glowLen, hueAt(d / loop.total + p / n + li * 0.13), 0.42, 5.5, "round");
          }
        });

        ctx.globalCompositeOperation = "source-over";
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stopDpr();
    };
    // `hidden` is a dependency on purpose: going hidden tears the loop down
    // entirely and coming back builds a fresh one. Nothing is composited while
    // the window is hidden, and Chromium does NOT throttle a borderless
    // transparent WebView2 that is merely unfocused, so leaving an rAF running
    // there is exactly the idle-GPU burn the app's idle gates exist to stop.
  }, [capSeconds, hidden]);

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-5"
      role="status"
      aria-label={label}
      aria-live="polite"
    >
      <div
        ref={hostRef}
        // Sized to roughly the halo the previous loader threw (its 200px box
        // bloomed to about 356px of visible glow), so the panel's centre of
        // gravity does not move.
        style={{ width: "min(340px, 78%)", aspectRatio: "1 / 1" }}
        className="relative"
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          // Its own compositor layer: this repaints every frame inside an
          // ancestor carrying a 64px to 96px backdrop-filter, and without the
          // promotion WebView2 can re-run that blur over the panel per frame.
          style={{ display: "block", willChange: "transform" }}
        />
      </div>
      <p className="text-white/55 text-[12.5px] font-mono uppercase tracking-[0.28em]">
        Loading...
      </p>
    </div>
  );
}
