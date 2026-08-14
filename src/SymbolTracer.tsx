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
// THREE THINGS THIS FILE HAS TO GET RIGHT, all of them recorded elsewhere as
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
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";

import { useWindowHidden } from "./windowVisibility";

/** A symbol, as a closed path in normalised coordinates centred on (0.5, 0.5).
 *  Kept as plain point lists rather than Path2D so a particle can be placed at
 *  an arbitrary distance along the path without the browser's help. */
type Pt = { x: number; y: number };

function polygon(sides: number, rot = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= sides; i += 1) {
    const a = rot + (i / sides) * Math.PI * 2;
    out.push({ x: 0.5 + Math.cos(a) * 0.42, y: 0.5 + Math.sin(a) * 0.42 });
  }
  return out;
}

function star(points: number, inner = 0.42): Pt[] {
  const out: Pt[] = [];
  const steps = points * 2;
  for (let i = 0; i <= steps; i += 1) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const r = i % 2 === 0 ? 0.44 : 0.44 * inner;
    out.push({ x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r });
  }
  return out;
}

/** Sample a parametric curve into a point list. */
function sample(n: number, f: (t: number) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i += 1) out.push(f(i / n));
  return out;
}

const SYMBOLS: { id: string; pts: Pt[] }[] = [
  { id: "triangle", pts: polygon(3, -Math.PI / 2) },
  { id: "diamond",  pts: polygon(4, -Math.PI / 2) },
  { id: "pentagon", pts: polygon(5, -Math.PI / 2) },
  { id: "hexagon",  pts: polygon(6, -Math.PI / 2) },
  { id: "star5",    pts: star(5) },
  { id: "star6",    pts: star(6, 0.58) },
  {
    id: "infinity",
    pts: sample(160, (t) => {
      const a = t * Math.PI * 2;
      const d = 1 + Math.sin(a) * Math.sin(a);
      return { x: 0.5 + (Math.cos(a) / d) * 0.46, y: 0.5 + (Math.sin(a) * Math.cos(a) / d) * 0.72 };
    }),
  },
  {
    id: "spiral",
    pts: sample(220, (t) => {
      const a = t * Math.PI * 6;
      const r = 0.06 + t * 0.38;
      return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r };
    }),
  },
  {
    id: "trefoil",
    pts: sample(200, (t) => {
      const a = t * Math.PI * 2;
      const r = 0.30 + 0.14 * Math.cos(3 * a);
      return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r };
    }),
  },
  {
    id: "wave-ring",
    pts: sample(200, (t) => {
      const a = t * Math.PI * 2;
      const r = 0.38 + 0.06 * Math.sin(8 * a);
      return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r };
    }),
  },
];

/** Segments drawn per particle trail per frame. High enough that the trail
 *  reads as a continuous stroke, low enough that a five-particle symbol stays
 *  well inside one frame's budget. */
const TRAIL_STEPS = 26;
/** The symbol shown most recently, so the next play never repeats it. ONE
 *  string, module scope: the rule needs exactly one id remembered and an
 *  ever-growing set of "seen" symbols would be the sort of quiet unbounded
 *  growth this codebase does not allow. */
let lastSymbolId: string | null = null;

function pickSymbol() {
  const pool = SYMBOLS.length > 1
    ? SYMBOLS.filter((s) => s.id !== lastSymbolId)
    : SYMBOLS;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastSymbolId = chosen.id;
  return chosen;
}

/** Cumulative arc lengths, so a particle can be positioned by DISTANCE along
 *  the path rather than by index. Without this, particles crawl through dense
 *  stretches of a curve and jump across sparse ones. */
function measure(pts: Pt[]) {
  const acc: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    acc.push(total);
  }
  return { acc, total };
}

function pointAt(pts: Pt[], acc: number[], total: number, d: number): Pt {
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
  };
}

function prefersReducedMotion(): boolean {
  // Read the ATTRIBUTE, not the media query: the Settings control offers
  // always / never / auto, and only the attribute reflects that choice.
  return document.documentElement.getAttribute("data-reduced-motion") === "true";
}

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
    const { acc, total } = measure(symbol.pts);
    // A whole rotation of the symbol, randomised, so two plays of the same
    // shape still do not look identical.
    const spin = Math.random() * Math.PI * 2;
    // 3 to 5 particles, spaced evenly around the path.
    const particles = 3 + Math.floor(Math.random() * 3);
    // One lap in roughly a third of the expected wait, so the symbol is
    // legible early and then keeps redrawing over itself.
    const lapMs = Math.max(1600, (capSeconds * 1000) / 3);

    let raf = 0;
    let start = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    // Reduced motion: draw the finished symbol once and stop. The SIGNAL is
    // kept (there is clearly something in progress here), the MOTION is not.
    // Same shape as the poster-retry dot's reduced-motion rule.
    const still = prefersReducedMotion();

    const project = (p: Pt) => {
      const size = Math.min(w, h);
      const cx = w / 2;
      const cy = h / 2;
      const dx = (p.x - 0.5) * size;
      const dy = (p.y - 0.5) * size;
      return {
        x: cx + dx * Math.cos(spin) - dy * Math.sin(spin),
        y: cy + dx * Math.sin(spin) + dy * Math.cos(spin),
      };
    };

    const strokeAt = (
      d: number, hue: number, alpha: number, width: number, span: number,
    ) => {
      const a = project(pointAt(symbol.pts, acc, total, d));
      const b = project(pointAt(symbol.pts, acc, total, d + span));
      ctx.strokeStyle = `hsla(${hue}, 100%, 62%, ${alpha})`;
      ctx.shadowColor = `hsla(${hue}, 100%, 60%, 0.9)`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };

    const drawStatic = () => {
      if (w === 0) return;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      ctx.shadowBlur = 10;
      const steps = 260;
      for (let i = 0; i < steps; i += 1) {
        strokeAt((i / steps) * total, (i / steps) * 360, 0.5, 2, (total / steps) * 1.6);
      }
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

    if (still) {
      drawStatic();
      return () => { ro.disconnect(); };
    }

    // THE HIDDEN GATE, which this file already claimed to have. `hidden` was
    // listed in the dependency array but never actually tested, so going hidden
    // only tore the rAF loop down and immediately rebuilt an identical one: the
    // animation kept running at full rate behind a minimised window, which is
    // the exact cost the gate exists to avoid. The ResizeObserver stays live so
    // the canvas is correctly sized the instant the window comes back, and the
    // effect re-runs on restore with fresh locals, so `resize()` re-measures
    // and clears before any new loop starts.
    if (hidden) return () => { ro.disconnect(); };

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
        // tail, no residue, and no retained point history to bound.
        ctx.clearRect(0, 0, w, h);

        // Additive, so overlapping trails bloom where they cross instead of
        // occluding each other. This is what makes it read as neon.
        ctx.globalCompositeOperation = "lighter";
        ctx.lineCap = "round";

        const head = (elapsed / lapMs) * total;
        // Trails grow over the first lap until they meet, so the symbol
        // ASSEMBLES out of the trails rather than being present from frame
        // one. `total / particles` is the length at which N evenly spaced
        // trails exactly close the loop.
        const trailLen = (total / particles) * Math.min(1, elapsed / lapMs);
        // Each drawn segment has to be at least as long as the gap between
        // consecutive trail steps, or the trail renders as a dashed line. The
        // gap scales with both the trail length and the particle count, so the
        // span is derived rather than fixed; the floor keeps the head visible
        // in the first frames while the trail is still near zero length.
        const segSpan = Math.max((trailLen / TRAIL_STEPS) * 1.6, total * 0.004);

        for (let p = 0; p < particles; p += 1) {
          const offset = (p / particles) * total;
          const d = head + offset;
          for (let k = TRAIL_STEPS; k >= 1; k -= 1) {
            // t: 1 at the head, approaching 0 at the tail.
            const t = k / TRAIL_STEPS;
            const dd = d - trailLen * (1 - t);
            // Hue runs with distance travelled, so each particle lays down a
            // continuously shifting rainbow rather than one flat colour.
            const hue = (((dd / total) * 360) + p * (360 / particles)) % 360;
            // Squared falloff: the head stays bright and readable while the
            // tail thins out quickly, which is what makes the direction of
            // travel obvious.
            const a = t * t;
            // Glow only near the head. shadowBlur is the expensive part of a
            // stroke, and applying it down the whole trail cost far more than
            // it added: the bloom is only legible where the trail is bright.
            ctx.shadowBlur = t > 0.72 ? 12 : 0;
            strokeAt(dd, hue, a * 0.95, 1 + t * 1.8, segSpan);
            if (t > 0.86) strokeAt(dd, hue, a * 0.5, 5.5, segSpan);
          }
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.shadowBlur = 0;
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
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
