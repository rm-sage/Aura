// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { bindingMatches, isKeyCaptureActive, isTypingTarget, parseBinding } from "./useKeybindings";
import { downloadsSnapshot } from "./downloadsStore";
import { isWindowHidden, subscribeWindowVisibility } from "./windowVisibility";
import {
  clampGeometry, formatBytes, formatPercent, formatRate, niceCeil, pushPoint, resizeBy,
  seriesMax, WINDOW_MS, type Geometry, type Point, type ResizeEdges,
} from "./perfSeries";

// ---------------------------------------------------------------------------
// PerfMonitor: the floating window behind Alt+~ (the `perf-monitor` keybinding).
// Live graphs of what Aura is using, from perf_monitor.rs plus what only the page
// can see (its own frame times, the download rate).
//
// A monitor must not be what it measures, so while it is closed NOTHING runs: the
// panel unmounts, and Rust holds no thread, query or timer. While open:
// - The readings poll once a second, skipped while the window is hidden.
// - The canvas redraws at 15 Hz, which at a minute per graph width still moves
//   under a pixel per draw. The bars animate on the compositor (transform).
// - React re-renders once per reading. Frame figures are written straight to the
//   DOM, four times a second.
// - The panel has no backdrop blur: it would re-blur on every canvas draw, and
//   the video is not in the webview, so there is nothing behind it to refract.
//
// It is portalled to <body> above every z-index in the app. The one thing it can
// not cover is a native child webview (the source popup): that is a separate
// surface the page does not composite.
// ---------------------------------------------------------------------------

interface Sample {
  cpu: { core: number; ui: number; helpers: number };
  system_cpu: number | null;
  mem: { core: number; ui: number; helpers: number };
  mem_total: number;
  io_read_bps: number;
  io_write_bps: number;
  processes: number;
  gpu: { util: number; decode: number; vram_used: number; vram_total: number | null } | null;
  /** False on the first sample: CPU, GPU, Decode and I/O have no interval yet. */
  primed: boolean;
  media_loaded: boolean;
  video: {
    fps: number | null;
    stream_bps: number | null;
    cache_secs: number | null;
    /** The engine's live cache-secs: how much it is trying to buffer. */
    cache_target_secs: number | null;
    cache_bytes: number | null;
  } | null;
  drops_vo: number;
  drops_decoder: number;
}

/** A reading with the figures the window derives from it. */
interface Reading extends Sample {
  cpuTotal: number;
  memTotal: number;
  /** Null while a loaded file's rate is unknown (a slow seek or load). */
  streamBps: number | null;
  downloadBps: number;
  netBps: number | null;
  ioBps: number;
  jsHeap: number | null;
}

type MetricKey = "frame" | "cpu" | "mem" | "gpu" | "vram" | "decode" | "net" | "buffer" | "io";

/** The engine's default cache-secs, for a reading without its live value. */
const DEFAULT_BUFFER_CEILING_S = 180;
const MB = 1024 * 1024;
const GB = 1024 * MB;

interface Metric {
  key: Exclude<MetricKey, "frame">;
  label: string;
  color: string;
  /** Lowest top-of-graph, in the metric's own unit. */
  floor: number;
  /** Null when there is no reading (no GPU counters, nothing playing). */
  value: (r: Reading) => number | null;
  text: (v: number) => string;
  /** How full the bar is, 0-1. `peak` is the top of the line's own scale. */
  fill: (v: number, r: Reading, peak: number) => number;
  detail: (r: Reading) => string;
}

const METRICS: Metric[] = [
  {
    key: "cpu", label: "CPU", color: "#e5484d", floor: 10,
    value: (r) => (r.primed ? r.cpuTotal : null),
    text: formatPercent,
    fill: (v) => v / 100,
    detail: (r) =>
      `Aura's processes, as a share of every core${r.system_cpu != null ? `. The whole machine is at ${formatPercent(r.system_cpu)}` : ""}`,
  },
  {
    key: "mem", label: "Memory", color: "#2dd4bf", floor: GB,
    value: (r) => r.memTotal,
    text: formatBytes,
    fill: (v, r) => (r.mem_total > 0 ? v / r.mem_total : 0),
    detail: (r) =>
      `Private working set of ${r.processes} processes, the figure Task Manager shows, out of ${formatBytes(r.mem_total)}`,
  },
  {
    key: "gpu", label: "GPU", color: "#4c8dff", floor: 25,
    value: (r) => (r.primed ? r.gpu?.util ?? null : null),
    text: formatPercent,
    fill: (v) => v / 100,
    detail: () => "Aura's share of the GPU's busiest engine, video rendering and the interface together",
  },
  {
    key: "vram", label: "VRAM", color: "#f59e0b", floor: GB,
    value: (r) => r.gpu?.vram_used ?? null,
    text: formatBytes,
    fill: (v, r) => (r.gpu?.vram_total ? v / r.gpu.vram_total : 0),
    detail: (r) =>
      `Dedicated GPU memory${r.gpu?.vram_total ? `, out of ${formatBytes(r.gpu.vram_total)}` : ""}`,
  },
  {
    key: "decode", label: "Decode", color: "#a78bfa", floor: 25,
    value: (r) => (r.primed ? r.gpu?.decode ?? null : null),
    text: formatPercent,
    fill: (v) => v / 100,
    detail: () => "The GPU's video decoder. Zero while a file plays means it is decoding in software",
  },
  {
    key: "net", label: "Network", color: "#84cc16", floor: 5 * MB,
    value: (r) => r.netBps,
    text: formatRate,
    fill: (v, _r, peak) => v / peak,
    detail: (r) =>
      `Playing stream ${r.streamBps != null ? formatRate(r.streamBps) : "unknown during a seek or load"}, downloads ${formatRate(r.downloadBps)}. Windows cannot report the rest per process without admin rights`,
  },
  {
    key: "buffer", label: "Buffer", color: "#f472b6", floor: 60,
    value: (r) => r.video?.cache_secs ?? null,
    text: (v) => `${Math.round(v)} s`,
    fill: (v, r) => v / (r.video?.cache_target_secs || DEFAULT_BUFFER_CEILING_S),
    detail: (r) =>
      `Video buffered ahead of the playhead${r.video?.cache_bytes ? `, holding ${formatBytes(r.video.cache_bytes)} of memory` : ""}`,
  },
  {
    key: "io", label: "I/O", color: "#9ca3af", floor: 5 * MB,
    value: (r) => (r.primed ? r.ioBps : null),
    text: formatRate,
    fill: (v, _r, peak) => v / peak,
    detail: (r) =>
      `${r.primed ? `Reads ${formatRate(r.io_read_bps)}, writes ${formatRate(r.io_write_bps)}. ` : ""}Files and pipes across Aura's processes, so this is not only disk`,
  },
];

const FRAME_COLOR = "#f4f4f5";
const DROP_COLOR = "#fb7185";
const FRAME_FLOOR_MS = 33.4;
const GROUPS = [
  { key: "core", label: "Player & app", detail: "aura.exe: the Rust host and mpv, which decodes, renders and buffers the video, plus the crash reporter if crash reporting is on" },
  { key: "ui", label: "Interface", detail: "The WebView2 processes that draw everything but the video" },
  { key: "helpers", label: "Helpers", detail: "ffmpeg and yt-dlp, while skip detection, casting or trailers use them" },
] as const;

function videoHoverText(r: Reading): string {
  const what = "The video's own frame rate, from its timestamps, not what reaches the screen";
  if (r.video) {
    return `${what}. Triangles on the graph mark dropped frames: ${r.drops_vo} late to the screen, ${r.drops_decoder} at the decoder, since the last seek or load`;
  }
  return r.media_loaded ? `${what}. It reports nothing during a seek or load` : `${what}. Nothing is playing`;
}

function groupHoverText(g: (typeof GROUPS)[number], r: Reading): string {
  return g.key === "ui" && r.jsHeap != null
    ? `${g.detail}. The page's own JavaScript holds ${formatBytes(r.jsHeap)}`
    : g.detail;
}

const DEFAULT_W = 390;
const MIN_W = 350;
const DEFAULT_GRAPH_H = 124;
const SAMPLE_MS = 1000;
const FRAME_BUCKET_MS = 250;
/** A main-thread task this long goes on the Frame line itself. Under loop()'s
 *  1 s cutoff, since a 900 ms task plus its render is a delta loop() discards. */
const STALL_TASK_MS = 500;
const DRAW_MS = 1000 / 15;
/** A hole in the readings this long is drawn as a hole, not a straight line. */
const GAP_MS = 3500;
/** Grip thickness, and how far it reaches outside the panel. */
const EDGE = 8;
const OUT = -3;

const STORE_KEY = "aura:perf-monitor:v1";
const OPEN_KEY = "aura:perf-monitor:open";

interface Stored extends Partial<Geometry> {
  /** Lines the user turned off. Every line starts on. */
  hiddenLines?: MetricKey[];
}

function loadStored(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveStored(s: Stored): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* a convenience: the window just reopens at its default */ }
}

/** Survives F5 (sessionStorage), and a cold start begins closed so a monitor
 *  nobody is looking at is not left running. */
function wasOpen(): boolean {
  try { return sessionStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}

function rememberOpen(open: boolean): void {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, "1");
    else sessionStorage.removeItem(OPEN_KEY);
  } catch { /* see saveStored */ }
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function toReading(s: Sample): Reading {
  // A loaded file with no fresh poll is mid seek or load: unknown, not idle.
  const streamBps = s.video ? s.video.stream_bps ?? 0 : s.media_loaded ? null : 0;
  const downloadBps = downloadsSnapshot().total_speed_bps ?? 0;
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return {
    ...s,
    cpuTotal: s.cpu.core + s.cpu.ui + s.cpu.helpers,
    memTotal: s.mem.core + s.mem.ui + s.mem.helpers,
    streamBps,
    downloadBps,
    netBps: streamBps == null && downloadBps === 0 ? null : (streamBps ?? 0) + downloadBps,
    ioBps: s.io_read_bps + s.io_write_bps,
    jsHeap: finite(memory?.usedJSHeapSize) ? memory.usedJSHeapSize : null,
  };
}

// ---------------------------------------------------------------------------
// The panel. Mounted only while open.
// ---------------------------------------------------------------------------

type Hover = { metric?: Metric; frame?: boolean; text: string | ((r: Reading) => string) } | null;

function Panel({ onClose }: { onClose: () => void }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [off, setOff] = useState<Set<MetricKey>>(() => {
    const stored = loadStored().hiddenLines;
    return new Set(Array.isArray(stored) ? stored : []);
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const graphRowRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const graphBoxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameMsRef = useRef<HTMLSpanElement>(null);
  const frameFpsRef = useRef<HTMLSpanElement>(null);

  // Everything the draw loop reads. Refs, so a redraw is not a React render.
  const series = useRef<Record<MetricKey, Point[]>>({
    frame: [], cpu: [], mem: [], gpu: [], vram: [], decode: [], net: [], buffer: [], io: [],
  });
  const dropMarks = useRef<Point[]>([]);
  const lastDrops = useRef<number | null>(null);
  const shownCeil = useRef<Partial<Record<MetricKey, number>>>({});
  const offRef = useRef(off);
  offRef.current = off;
  const hoverKey = useRef<MetricKey | null>(null);
  hoverKey.current = hover?.frame ? "frame" : hover?.metric?.key ?? null;

  // ── Geometry: written straight to the element while dragging ─────────────

  const geom = useRef<Geometry>({ x: 0, y: 0, w: DEFAULT_W, h: 0 });

  const apply = useCallback((g: Geometry) => {
    geom.current = g;
    const el = panelRef.current;
    if (!el) return;
    el.style.left = `${g.x}px`;
    el.style.top = `${g.y}px`;
    el.style.width = `${g.w}px`;
    el.style.height = `${g.h}px`;
  }, []);

  /** Everything but the graph, which takes whatever height is left, so this is
   *  what "large enough for its contents" means in pixels. */
  const minHeight = useCallback(() => {
    const panel = panelRef.current;
    const row = graphRowRef.current;
    const left = leftColRef.current;
    if (!panel || !row || !left) return 0;
    return panel.offsetHeight - row.offsetHeight + left.offsetHeight;
  }, []);

  const persist = useCallback(() => {
    saveStored({ ...geom.current, hiddenLines: Array.from(offRef.current) });
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const row = graphRowRef.current;
    const left = leftColRef.current;
    if (!panel || !row || !left) return;
    const stored = loadStored();
    const w = finite(stored.w) ? stored.w : DEFAULT_W;
    panel.style.width = `${w}px`;
    // Height follows the content on first open: nothing but the rows it needs
    // and a graph of a sensible height. Under this the graph row has no height
    // of its own, so the panel is measured at its natural size.
    panel.style.height = "auto";
    const chrome = panel.offsetHeight - row.offsetHeight;
    const min = chrome + left.offsetHeight;
    const h = finite(stored.h) ? stored.h : chrome + DEFAULT_GRAPH_H;
    const x = finite(stored.x) ? stored.x : window.innerWidth - w - 16;
    const y = finite(stored.y) ? stored.y : 48;
    apply(clampGeometry({ x, y, w, h }, MIN_W, min, window.innerWidth, window.innerHeight));
  }, [apply]);

  useEffect(() => {
    const onResize = () => {
      apply(clampGeometry(geom.current, MIN_W, minHeight(), window.innerWidth, window.innerHeight));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [apply, minHeight]);

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-no-drag]")) return;
    const start = geom.current;
    const [px, py] = [e.clientX, e.clientY];
    track(e, (ev) => {
      apply(clampGeometry(
        { ...start, x: start.x + ev.clientX - px, y: start.y + ev.clientY - py },
        MIN_W, 0, window.innerWidth, window.innerHeight,
      ));
    });
  };

  const startResize = (e: React.PointerEvent, edges: ResizeEdges) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const start = geom.current;
    const min = minHeight();
    const [px, py] = [e.clientX, e.clientY];
    track(e, (ev) => {
      apply(resizeBy(
        start, edges, ev.clientX - px, ev.clientY - py,
        MIN_W, min, window.innerWidth, window.innerHeight,
      ));
    });
  };

  /** Pointer capture, so a fast drag cannot outrun the panel and lose it. */
  const track = (e: React.PointerEvent, onMove: (ev: PointerEvent) => void) => {
    const el = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    el.setPointerCapture(id);
    const up = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      persist();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // ── Readings ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let inFlight: Promise<unknown> = Promise.resolve();

    const ingest = (r: Reading) => {
      const now = performance.now();
      for (const m of METRICS) {
        const v = m.value(r);
        if (v != null) pushPoint(series.current[m.key], now, v);
      }
      const drops = r.drops_vo + r.drops_decoder;
      const prev = lastDrops.current;
      if (prev != null && drops > prev) pushPoint(dropMarks.current, now, drops - prev);
      else if (dropMarks.current.length) pushPoint(dropMarks.current, now, 0);
      lastDrops.current = drops;
      setReading(r);
    };

    const tick = async () => {
      if (stopped) return;
      if (!document.hidden && !isWindowHidden()) {
        const call = invoke<Sample | null>("perf_monitor", { action: { op: "sample" } });
        inFlight = call.catch(() => null);
        try {
          const s = await call;
          if (!stopped && s) {
            setFailed(null);
            ingest(toReading(s));
          }
        } catch (err) {
          if (!stopped) setFailed(String(err));
        }
      }
      if (!stopped) timer = window.setTimeout(tick, SAMPLE_MS);
    };
    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      // After any sample still running: that one would recreate what this frees.
      void inFlight.then(() => invoke("perf_monitor", { action: { op: "stop" } }).catch(() => {}));
    };
  }, []);

  // ── Frame times and drawing ──────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = graphBoxRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !box || !ctx) return;

    let cssW = 0;
    let cssH = 0;
    const size = () => {
      // Layout size, not getBoundingClientRect: the panel's entry animation
      // scales it, and no resize event follows when that ends.
      const dpr = window.devicePixelRatio || 1;
      cssW = box.clientWidth;
      cssH = box.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = new ResizeObserver(() => { size(); draw(performance.now()); });
    ro.observe(box);

    // Moving to a display of another scale keeps the CSS size, so the observer
    // above stays quiet.
    let dprQuery: MediaQueryList | null = null;
    const onDpr = () => { armDpr(); size(); draw(performance.now()); };
    const armDpr = () => {
      dprQuery?.removeEventListener("change", onDpr);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener("change", onDpr);
    };
    armDpr();

    const line = (
      points: Point[], key: MetricKey, floor: number, color: string, width: number,
      now: number, from: number, focus: MetricKey | null,
    ) => {
      const target = niceCeil(seriesMax(points, from), floor);
      // Eased, so a new peak rescales the line instead of snapping it.
      const shown = shownCeil.current[key] ?? target;
      const ceil = shown + (target - shown) * 0.15;
      shownCeil.current[key] = ceil;
      if (points.length === 0) return;
      ctx.beginPath();
      let prevT = -Infinity;
      for (const p of points) {
        const x = cssW - ((now - p.t) / WINDOW_MS) * cssW;
        const y = cssH - 3 - Math.min(p.v / ceil, 1) * (cssH - 8);
        if (p.t - prevT > GAP_MS) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevT = p.t;
      }
      ctx.globalAlpha = focus == null || focus === key ? 1 : 0.18;
      ctx.lineWidth = focus === key ? width + 0.5 : width;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    const draw = (now: number) => {
      if (cssW <= 0 || cssH <= 0) return;
      const from = now - WINDOW_MS;
      const focus = hoverKey.current;
      ctx.clearRect(0, 0, cssW, cssH);

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath();
      for (const f of [0.25, 0.5, 0.75]) {
        const y = Math.round(cssH * f) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
      }
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.moveTo(0, cssH - 0.5);
      ctx.lineTo(cssW, cssH - 0.5);
      ctx.moveTo(0.5, 0);
      ctx.lineTo(0.5, cssH);
      ctx.stroke();

      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const m of METRICS) {
        if (offRef.current.has(m.key) && focus !== m.key) continue;
        line(series.current[m.key], m.key, m.floor, m.color, 1.25, now, from, focus);
      }
      line(series.current.frame, "frame", FRAME_FLOOR_MS, FRAME_COLOR, 1.5, now, from, focus);

      ctx.fillStyle = DROP_COLOR;
      for (const p of dropMarks.current) {
        if (p.v <= 0) continue;
        const x = cssW - ((now - p.t) / WINDOW_MS) * cssW;
        ctx.beginPath();
        ctx.moveTo(x, cssH - 7);
        ctx.lineTo(x - 3.5, cssH);
        ctx.lineTo(x + 3.5, cssH);
        ctx.closePath();
        ctx.fill();
      }
    };

    let raf = 0;
    let last = performance.now();
    let armedAt = last;
    let bucketAt = last;
    let count = 0;
    let sum = 0;
    let worst = 0;
    let drawnAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = now - last;
      last = now;
      // Past a second the delta alone cannot tell a stall from a page that was
      // simply not asked to draw. A real stall is plotted by the observer below.
      if (dt > 0 && dt < 1000) {
        count++;
        sum += dt;
        if (dt > worst) worst = dt;
      }
      if (now - bucketAt >= FRAME_BUCKET_MS) {
        // The WORST frame of the bucket goes on the graph, or a single 200 ms
        // hitch would average away into a flat line.
        if (count > 0 || worst > 0) pushPoint(series.current.frame, now, worst);
        if (count > 0) {
          const ms = sum / count;
          if (frameMsRef.current) frameMsRef.current.textContent = `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
          if (frameFpsRef.current) frameFpsRef.current.textContent = `${Math.round(1000 / ms)} fps`;
        }
        bucketAt = now;
        count = 0;
        sum = 0;
        worst = 0;
      }
      if (now - drawnAt >= DRAW_MS) {
        drawnAt = now;
        draw(now);
      }
    };
    // WebView2 keeps producing frames for a minimized or unparked tray window, so
    // stop asking for them. This store also fires on focus changes, hence the
    // raf check: only a real hidden-to-visible edge restarts the loop and stats.
    const syncVisibility = () => {
      if (isWindowHidden()) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        last = performance.now();
        armedAt = last;
        bucketAt = last;
        count = 0;
        sum = 0;
        worst = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    syncVisibility();
    const unsubscribe = subscribeWindowVisibility(syncVisibility);

    // The browser's own witness that the main thread was blocked. No timers, and
    // the worst only: one stall would swing the average text for a single bucket.
    // A task from before the last hidden edge says nothing about the page now.
    const stalls = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (raf !== 0 && e.startTime >= armedAt && e.duration >= STALL_TASK_MS && e.duration > worst) {
          worst = e.duration;
        }
      }
    });
    stalls.observe({ type: "longtask" });

    return () => {
      unsubscribe();
      stalls.disconnect();
      cancelAnimationFrame(raf);
      ro.disconnect();
      dprQuery?.removeEventListener("change", onDpr);
    };
  }, []);

  const toggleLine = (key: MetricKey) => {
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      offRef.current = next;
      persist();
      return next;
    });
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const video = reading?.video ?? null;
  const drops = reading ? reading.drops_vo + reading.drops_decoder : 0;
  const now = performance.now();
  const topOf = hover?.metric
    ? shownCeil.current[hover.metric.key]
    : hover?.frame ? shownCeil.current.frame : undefined;

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // Most words carry live figures, so they follow the readings while hovered.
  const hoverText = typeof hover?.text === "function" ? (reading ? hover.text(reading) : "") : hover?.text;

  return (
    <div
      ref={panelRef}
      data-perf-monitor
      role="dialog"
      aria-label="Performance Monitor"
      className="aura-float-glass aura-perf-monitor fixed flex flex-col rounded-xl
                 select-none text-white/90 cursor-move"
      style={{ zIndex: 2147483000 }}
      onPointerDown={(e) => { e.stopPropagation(); startMove(e); }}
      // Keeps focus where it is, so clicking the window neither blurs a search
      // box nor leaves a button focused for Space to press instead of pausing.
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      // The portal still bubbles through React's tree: none of this may reach
      // what is mounted around it, or a click here would pause the player.
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onWheel={stop}
    >
      {/* Clipped on this inner box, not the panel: clipping there would round off
          the corner grips, and a press in the very corner would land on the page. */}
      <div className="flex-1 min-h-0 flex flex-col p-2.5 gap-2 rounded-xl overflow-hidden">
      <div ref={graphRowRef} className="flex-1 min-h-0 flex gap-2.5">
        <div ref={leftColRef} className="shrink-0 w-[76px] self-start text-right leading-none">
          <div
            onMouseEnter={() => setHover({
              frame: true,
              text: "How long the interface takes to draw a frame. The white line is the slowest frame in each quarter second",
            })}
            onMouseLeave={() => setHover(null)}
          >
            <div className="text-[10px] tracking-[0.14em] uppercase text-white/55">Frame</div>
            <div className="mt-1 text-[17px] font-semibold tabular-nums">
              <span ref={frameMsRef}>-</span>
            </div>
            <div className="mt-1 text-[12px] tabular-nums text-white/60">
              <span ref={frameFpsRef}>-</span>
            </div>
          </div>
          <div
            className="mt-2.5"
            onMouseEnter={() => setHover({ text: videoHoverText })}
            onMouseLeave={() => setHover(null)}
          >
            <div className="text-[10px] tracking-[0.14em] uppercase text-white/55">Video</div>
            <div className="mt-1 text-[12px] tabular-nums">
              {video?.fps != null ? `${video.fps.toFixed(video.fps < 100 ? 2 : 0)} fps` : "-"}
            </div>
            <div className={`mt-1 text-[11px] tabular-nums ${video && drops > 0 ? "text-rose-300" : "text-white/45"}`}>
              {video ? `${drops} dropped` : reading && !reading.media_loaded ? "not playing" : "-"}
            </div>
          </div>
        </div>

        <div ref={graphBoxRef} className="relative flex-1 min-w-0">
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
          {hover && hoverText && (
            <div className="absolute left-1.5 right-1.5 top-1 pointer-events-none rounded bg-black/75 px-1.5 py-1
                            text-[10.5px] leading-snug text-white/85">
              {hoverText}
              {topOf != null && hover.metric && (
                <span className="text-white/50">. Top of the graph: {hover.metric.text(topOf)}</span>
              )}
              {hover.metric && (
                <span className="text-white/50">. Click to {off.has(hover.metric.key) ? "show" : "hide"} its line</span>
              )}
              {topOf != null && hover.frame && (
                <span className="text-white/50">. Top of the graph: {Math.round(topOf)} ms</span>
              )}
            </div>
          )}
          <button
            type="button"
            data-no-drag
            aria-label="Close the Performance Monitor"
            onClick={onClose}
            className="absolute -right-1 -top-1 w-5 h-5 rounded text-white/40 hover:text-white
                       hover:bg-white/10 flex items-center justify-center cursor-pointer"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
      </div>

      {failed ? (
        <div className="text-[11px] text-rose-300 leading-snug">Could not read the figures: {failed}</div>
      ) : (
        <>
          <div className="shrink-0 grid grid-cols-2 gap-x-2 gap-y-1">
            {METRICS.map((m) => {
              const v = reading ? m.value(reading) : null;
              const peak = niceCeil(seriesMax(series.current[m.key], now - WINDOW_MS), m.floor);
              const fill = v != null && reading ? Math.max(0, Math.min(1, m.fill(v, reading, peak))) : 0;
              const lineOn = !off.has(m.key);
              return (
                <button
                  key={m.key}
                  type="button"
                  data-no-drag
                  onClick={() => toggleLine(m.key)}
                  onMouseEnter={() => setHover({ metric: m, text: m.detail })}
                  onMouseLeave={() => setHover(null)}
                  aria-pressed={lineOn}
                  aria-label={`${m.label}: click to ${lineOn ? "hide" : "show"} its line on the graph`}
                  className="relative h-[21px] rounded-[3px] overflow-hidden bg-white/[0.05] cursor-pointer text-left"
                >
                  <span
                    className="aura-perf-bar absolute inset-0 origin-left"
                    style={{ background: m.color, transform: `scaleX(${fill})` }}
                  />
                  <span className="relative flex items-center gap-1.5 h-full px-1.5 text-[11.5px] whitespace-nowrap
                                   [text-shadow:0_1px_2px_rgba(0,0,0,0.9)]">
                    <span className="text-white/90">{m.label}</span>
                    <span className="ml-auto font-semibold tabular-nums">{v != null ? m.text(v) : "-"}</span>
                    <span
                      className="shrink-0 w-[7px] h-[7px] rounded-full"
                      style={lineOn
                        ? { background: m.color, boxShadow: "0 0 0 1px rgba(0,0,0,0.6)" }
                        : { boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.45)" }}
                    />
                  </span>
                </button>
              );
            })}
          </div>

          {/* Side by side, each label over its own figures, so widening the
              window spreads the groups instead of parting a name from its values. */}
          <div className="shrink-0 grid grid-cols-3 gap-x-3 border-t border-white/10 pt-1.5
                          text-[11px] leading-tight tabular-nums">
            {GROUPS.map((g) => (
              <div
                key={g.key}
                className="min-w-0"
                onMouseEnter={() => setHover({ text: (r) => groupHoverText(g, r) })}
                onMouseLeave={() => setHover(null)}
              >
                <div className="truncate text-white/50">{g.label}</div>
                <div className="mt-0.5 flex gap-2 whitespace-nowrap text-white/85">
                  <span>{reading?.primed ? formatPercent(reading.cpu[g.key]) : "-"}</span>
                  <span>{reading ? formatBytes(reading.mem[g.key]) : "-"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      </div>

      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.id}
          data-no-drag
          aria-hidden
          className="absolute"
          style={h.style}
          onPointerDown={(e) => startResize(e, h.edges)}
        />
      ))}
    </div>
  );
}

function handle(
  id: string, style: React.CSSProperties, edges: Partial<ResizeEdges>,
): { id: string; style: React.CSSProperties; edges: ResizeEdges } {
  return {
    id, style,
    edges: { left: false, right: false, top: false, bottom: false, ...edges },
  };
}

const RESIZE_HANDLES = [
  handle("n", { left: EDGE, right: EDGE, top: OUT, height: EDGE, cursor: "ns-resize" }, { top: true }),
  handle("s", { left: EDGE, right: EDGE, bottom: OUT, height: EDGE, cursor: "ns-resize" }, { bottom: true }),
  handle("w", { top: EDGE, bottom: EDGE, left: OUT, width: EDGE, cursor: "ew-resize" }, { left: true }),
  handle("e", { top: EDGE, bottom: EDGE, right: OUT, width: EDGE, cursor: "ew-resize" }, { right: true }),
  handle("nw", { left: OUT, top: OUT, width: EDGE * 2, height: EDGE * 2, cursor: "nwse-resize" }, { left: true, top: true }),
  handle("ne", { right: OUT, top: OUT, width: EDGE * 2, height: EDGE * 2, cursor: "nesw-resize" }, { right: true, top: true }),
  handle("sw", { left: OUT, bottom: OUT, width: EDGE * 2, height: EDGE * 2, cursor: "nesw-resize" }, { left: true, bottom: true }),
  handle("se", { right: OUT, bottom: OUT, width: EDGE * 2, height: EDGE * 2, cursor: "nwse-resize" }, { right: true, bottom: true }),
];

// ---------------------------------------------------------------------------
// The host: the hotkey, and whether the panel exists at all.
// ---------------------------------------------------------------------------

/** Strict like every binding, except that ~ is Shift+` on most layouts: someone
 *  pressing "Alt+~" literally holds Shift too, and both must work, unless another
 *  action holds the Shift chord, which is then that action's key. */
function pressesMonitorKey(spec: string, e: KeyboardEvent, bindings: Record<string, string>): boolean {
  if (bindingMatches(spec, e)) return true;
  const chord = e.shiftKey ? parseBinding(spec) : null;
  return chord != null && !chord.shift && chord.code === "Backquote" && e.code === "Backquote"
    && chord.ctrl === e.ctrlKey && chord.alt === e.altKey && chord.meta === e.metaKey
    && !Object.values(bindings).some((other) => bindingMatches(other, e));
}

/** Memoized: App re-renders with every time-pos event, and a re-render here
 *  would re-render the panel with it. */
function PerfMonitorHost({ bindings }: { bindings: Record<string, string> }) {
  const [open, setOpen] = useState(wasOpen);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    // Not through useKeybindings: "anywhere" includes a focused text box, and the
    // sign-in screen, which that hook sits out. Capture, because some surfaces
    // stop the keys they see. A row recording a new key gets it instead.
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isKeyCaptureActive()) return;
      // Undefined until settings load; "" is a user who unbound it.
      const spec = bindingsRef.current["perf-monitor"] ?? "Alt+Backquote";
      if (!pressesMonitorKey(spec, e, bindingsRef.current)) return;
      // A plain or Shift-only key could never be typed in a text box otherwise.
      if (!e.ctrlKey && !e.altKey && !e.metaKey && isTypingTarget(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => { rememberOpen(open); }, [open]);

  if (!open) return null;
  return createPortal(<Panel onClose={() => setOpen(false)} />, document.body);
}

export default memo(PerfMonitorHost);
