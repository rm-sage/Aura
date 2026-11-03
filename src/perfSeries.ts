// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// perfSeries: the Performance Monitor's arithmetic. Pure and import-free, so a
// node check can load it; PerfMonitor.tsx does the sampling and the drawing.
// ---------------------------------------------------------------------------

export interface Point {
  /** performance.now() of the reading. */
  t: number;
  v: number;
}

/** How far back the graph reaches. */
export const WINDOW_MS = 60_000;
/** A reading is kept this much past the left edge, so a line runs off the side
 *  instead of stopping short of it. */
const KEEP_MS = WINDOW_MS + 3_000;

/** Append and drop what has scrolled off. This is the bound on every series:
 *  it holds a minute of readings however long the window stays open. */
export function pushPoint(series: Point[], t: number, v: number): void {
  series.push({ t, v });
  let stale = 0;
  while (stale < series.length && t - series[stale].t > KEEP_MS) stale++;
  if (stale > 0) series.splice(0, stale);
}

/** The next 1 / 2 / 5 x 10^n at or above `v`, never below `floor`. Each line has
 *  its own scale so a flat 2 GB does not squash a busy 4%, and the floor stops
 *  idle noise being stretched to fill the graph. */
export function niceCeil(v: number, floor: number): number {
  if (!(v > floor)) return floor;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 2, 5, 10]) {
    if (step * mag >= v) return step * mag;
  }
  return 10 * mag;
}

export function seriesMax(series: Point[], from: number): number {
  let max = 0;
  for (const p of series) {
    if (p.t >= from && p.v > max) max = p.v;
  }
  return max;
}

/** Binary units, the ones Task Manager's figures are in. */
export function formatBytes(n: number): string {
  if (!(n > 0)) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatRate(bps: number): string {
  if (!(bps > 0)) return "0 MB/s";
  const mb = bps / (1024 * 1024);
  if (mb < 0.1) return `${Math.round(bps / 1024)} KB/s`;
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
}

export function formatPercent(p: number): string {
  return `${p > 0 && p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fit inside the app: shrink first (never below the minimum, unless the app
 *  itself is smaller), then slide back in. */
export function clampGeometry(
  g: Geometry, minW: number, minH: number, viewW: number, viewH: number,
): Geometry {
  const w = Math.min(Math.max(g.w, minW), Math.max(viewW, 1));
  const h = Math.min(Math.max(g.h, minH), Math.max(viewH, 1));
  return {
    w,
    h,
    x: Math.max(0, Math.min(g.x, viewW - w)),
    y: Math.max(0, Math.min(g.y, viewH - h)),
  };
}

export interface ResizeEdges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** A drag on an edge or corner moves only that side. The opposite side stays
 *  put when the minimum or the app's edge stops the drag. */
export function resizeBy(
  start: Geometry, edges: ResizeEdges, dx: number, dy: number,
  minW: number, minH: number, viewW: number, viewH: number,
): Geometry {
  let { x, y, w, h } = start;
  if (edges.right) w = Math.min(Math.max(start.w + dx, minW), viewW - start.x);
  if (edges.bottom) h = Math.min(Math.max(start.h + dy, minH), viewH - start.y);
  if (edges.left) {
    const right = start.x + start.w;
    x = Math.max(0, Math.min(start.x + dx, right - minW));
    w = right - x;
  }
  if (edges.top) {
    const bottom = start.y + start.h;
    y = Math.max(0, Math.min(start.y + dy, bottom - minH));
    h = bottom - y;
  }
  return { x, y, w, h };
}
