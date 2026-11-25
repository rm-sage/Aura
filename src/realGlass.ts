// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// realGlass: "Real glass over video" on the frontend side (experimental,
// opt-in, machine-local backend setting `real_glass`).
//
// The video is a native mpv window under the webview, so the player's glass
// surfaces cannot blur it in CSS. With the setting on, an mpv shader does it
// (src-tauri/src/mpv/glass.rs): this module tells Rust WHERE the surfaces are
// (CSS px + devicePixelRatio, at most 4: the control bar and open docked
// menus) through the ONE `player_glass` command, and marks each surface
// `data-real-glass="on"` while the shader draws under it, which drops most
// of its baked dark fill (styles/glass-misc.css). A surface mostly over the
// letterbox / pillarbox bars keeps its fill: the shader cannot reach there.
//
// Cost discipline (every shader update resets mpv's renderer, one late frame
// on HDR with motion smoothing): measure in ONE rAF, round, dedupe, and send
// only on change. Show / hide and menu open / close go out at once, layout
// changes (resize observers, window resize) after a 100 ms trailing debounce.
// Every observer, timer and listener is torn down with the hook.
//
// SHELVED (2026-11-18) behind REAL_GLASS_AVAILABLE below: after four tuning
// rounds the look over real video was still wrong (dark spots, brightness,
// horizontal banding / striping across the bar). Every piece is kept (the
// Rust command, the shader and its tests, the render.json field and the
// sync.ts machine-local plumbing), so re-enabling is this one flag.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getGlassState } from "./glassStyle";

/** Shader rect slots (glass.rs MAX_RECTS). */
const MAX_RECTS = 4;
/** Trailing debounce for layout-driven re-measures. */
const LAYOUT_DEBOUNCE_MS = 100;
/** Extra re-measures after a menu mounts (pop-in scale animations). */
const SETTLE_REMEASURE_MS = [140, 360];
/** Below this share over the video a surface keeps its normal fill. */
const MIN_VIDEO_SHARE = 0.5;
const PANEL_SELECTOR = "[data-player-menu-panel]";
const MARK_ATTR = "data-real-glass";

/**
 * The feature switch for "Real glass over video". While false the feature is
 * shelved: the Settings row is hidden, the player never marks a surface
 * `data-real-glass="on"`, and nothing ever sends `player_glass`, even when
 * render.json still says `real_glass: true` (the engine loads the shader only
 * on the frontend's `enable`, so it stays unloaded). Flip to true to restore
 * the feature as it was.
 */
export const REAL_GLASS_AVAILABLE: boolean = false;

export interface GlassVideoRect { x: number; y: number; w: number; h: number }
export interface GlassUiState {
  /** The shader is drawing under the surfaces right now. */
  active: boolean;
  /** False once this GPU was found unable to run the shader. */
  available: boolean;
  /** The video rect in CSS px (null when not active). */
  video: GlassVideoRect | null;
}

// ── The setting (backend `real_glass`), shared by every reader ─────────────

/** null until the first read lands, so a mount never flips the shader off
 *  and back on while the setting is still being read. */
let settingOn: boolean | null = null;
const settingSubs = new Set<() => void>();
let settingListener: ((e: Event) => void) | null = null;

function readSetting(): void {
  invoke<Record<string, unknown>>("get_settings")
    .then((s) => {
      const v = s?.real_glass === true;
      if (v !== settingOn) {
        settingOn = v;
        settingSubs.forEach((f) => f());
      }
    })
    .catch(() => {});
}

function subscribeSetting(cb: () => void): () => void {
  // Shelved: no settings read, no listener; the snapshot is a fixed false.
  if (!REAL_GLASS_AVAILABLE) return () => {};
  settingSubs.add(cb);
  if (!settingListener) {
    settingListener = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (!Array.isArray(keys) || keys.includes("real_glass")) readSetting();
    };
    window.addEventListener("aura:backend-settings-changed", settingListener);
    readSetting();
  }
  return () => {
    settingSubs.delete(cb);
    if (settingSubs.size === 0 && settingListener) {
      window.removeEventListener("aura:backend-settings-changed", settingListener);
      settingListener = null;
    }
  };
}

/** The `real_glass` backend setting, live (null while unknown). */
export function useRealGlassSetting(): boolean | null {
  return useSyncExternalStore(
    subscribeSetting,
    () => (REAL_GLASS_AVAILABLE ? settingOn : false),
    () => null,
  );
}

// ── The engine's glass state (`player-glass-state` events) ──────────────────

let uiState: GlassUiState = { active: false, available: true, video: null };
const uiSubs = new Set<() => void>();
let uiUnlisten: Promise<UnlistenFn> | null = null;

function subscribeUi(cb: () => void): () => void {
  // Shelved: the shader never runs, so there is no engine state to hear.
  if (!REAL_GLASS_AVAILABLE) return () => {};
  uiSubs.add(cb);
  if (!uiUnlisten) {
    uiUnlisten = listen<GlassUiState>("player-glass-state", ({ payload }) => {
      if (!payload || typeof payload !== "object") return;
      uiState = {
        active: payload.active === true,
        available: payload.available !== false,
        video: payload.video ?? null,
      };
      uiSubs.forEach((f) => f());
    });
  }
  return () => {
    uiSubs.delete(cb);
    if (uiSubs.size === 0 && uiUnlisten) {
      const p = uiUnlisten;
      uiUnlisten = null;
      void p.then((un) => un()).catch(() => {});
      // Nobody hears the engine's `active: false` (sent after the player's
      // clear) once the listener is gone, and Rust emits on change only: a
      // kept `active: true` would strip the next player's fill over sharp
      // video before the engine draws. Forget it; keep `available`.
      uiState = { active: false, available: uiState.available, video: null };
    }
  };
}

/** The engine's glass state, live. */
export function useRealGlassState(): GlassUiState {
  return useSyncExternalStore(subscribeUi, () => uiState, () => uiState);
}

/** Ask Rust whether the shader is available on this system (false after the
 *  composite-pass check failed). */
export async function realGlassAvailable(): Promise<boolean> {
  if (!REAL_GLASS_AVAILABLE) return false;
  try {
    const r = await invoke<{ available: boolean }>("player_glass", { action: { kind: "status" } });
    return r?.available !== false;
  } catch {
    return true;
  }
}

/** Follow the setting: on writes and loads the shader, off removes it. */
export function setRealGlassEnabled(on: boolean): void {
  if (!REAL_GLASS_AVAILABLE) return;
  invoke("player_glass", { action: { kind: "enable", on } }).catch(() => {});
}

// ── Measuring ──────────────────────────────────────────────────────────────

interface Measured { el: HTMLElement; x: number; y: number; w: number; h: number; r: number }

function measure(el: HTMLElement): Measured | null {
  const b = el.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return null;
  const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  return {
    el,
    x: Math.round(b.left),
    y: Math.round(b.top),
    w: Math.round(b.width),
    h: Math.round(b.height),
    r: Math.round(r),
  };
}

/** High Contrast themes keep the full fill (an accessibility floor, see
 *  frontend-ui.md). glassStyle.ts reads the root `--lg-glint-off` flag back on
 *  every theme change (no theme id named), so this costs no style read. */
function contrastFloor(): boolean {
  return getGlassState().contrastFloor;
}

function videoShare(m: Measured, v: GlassVideoRect): number {
  const iw = Math.min(m.x + m.w, v.x + v.w) - Math.max(m.x, v.x);
  const ih = Math.min(m.y + m.h, v.y + v.h) - Math.max(m.y, v.y);
  if (iw <= 0 || ih <= 0) return 0;
  return (iw * ih) / (m.w * m.h);
}

/** Mark the surfaces the shader draws under; the rest keep their fill (a
 *  surface mostly over the letterbox bars, or no live glass at all). */
function applyMarks(measured: Measured[], st: GlassUiState): void {
  const floor = measured.length > 0 && contrastFloor();
  for (const m of measured) {
    const keep = !floor && st.active && st.video != null && videoShare(m, st.video) >= MIN_VIDEO_SHARE;
    if (keep) m.el.setAttribute(MARK_ATTR, "on");
    else m.el.removeAttribute(MARK_ATTR);
  }
}

/**
 * Drive the real-glass shader for the player's surfaces.
 *
 * `active` is the overlay's own gate: the setting is on, the first frame is
 * up and nothing is being cast. While it is false the engine is told to
 * clear (n = 0) and every surface keeps its normal fill.
 */
export function useRealGlass({
  rootRef, barRef, active, controlsVisible,
}: {
  rootRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  active: boolean;
  controlsVisible: boolean;
}): void {
  const setting = useRealGlassSetting();
  const glass = useRealGlassState();
  // The latest inputs, read by the long-lived measuring closure.
  const visibleRef = useRef(controlsVisible);
  const scheduleRef = useRef<(() => void) | null>(null);
  const lastMeasuredRef = useRef<Measured[]>([]);
  const glassRef = useRef(glass);
  glassRef.current = glass;

  // Follow the setting into the engine (idempotent on the Rust side).
  useEffect(() => {
    if (REAL_GLASS_AVAILABLE && setting != null) setRealGlassEnabled(setting);
  }, [setting]);

  // Show / hide goes out at once.
  useEffect(() => {
    visibleRef.current = controlsVisible;
    scheduleRef.current?.();
  }, [controlsVisible]);

  // Shelved: never on, so no measuring, no `player_glass` update / clear and
  // no `data-real-glass` mark, whatever render.json says.
  const on = REAL_GLASS_AVAILABLE && setting === true && active;

  useEffect(() => {
    if (!on) return;
    const root = rootRef.current;
    if (!root) return;
    let raf = 0;
    let layoutTimer: ReturnType<typeof setTimeout> | null = null;
    const settleTimers = new Set<ReturnType<typeof setTimeout>>();
    let lastKey = "";
    let panels: HTMLElement[] = [];

    const flush = () => {
      raf = 0;
      const els: HTMLElement[] = [];
      if (barRef.current) els.push(barRef.current);
      for (const p of panels) if (els.length < MAX_RECTS) els.push(p);
      const measured = els.map(measure).filter((m): m is Measured => m != null);
      // A surface that left the set loses its mark.
      for (const old of lastMeasuredRef.current) {
        if (!measured.some((m) => m.el === old.el)) old.el.removeAttribute(MARK_ATTR);
      }
      lastMeasuredRef.current = measured;
      // Send only the surfaces that will drop their fill: one mostly over
      // the letterbox bars (or any surface on a High Contrast theme) keeps
      // it, and shading the strip under it would leave a seam and cost a
      // renderer reset for nothing. Until the engine knows the video rect,
      // every surface goes (its answer re-runs this).
      const video = glassRef.current.video;
      const sendable = contrastFloor()
        ? []
        : video
          ? measured.filter((m) => videoShare(m, video) >= MIN_VIDEO_SHARE)
          : measured;
      const rects = sendable.map(({ x, y, w, h, r }) => ({ x, y, w, h, r }));
      const dpr = Math.round((window.devicePixelRatio || 1) * 1000) / 1000;
      const style = document.documentElement.dataset.glass === "liquid" ? "liquid" : "frosted";
      // Open menus hold the controls visible, so `visible` is the bar's state.
      const visible = visibleRef.current;
      const key = JSON.stringify([rects, dpr, visible, style]);
      if (key !== lastKey) {
        lastKey = key;
        invoke("player_glass", { action: { kind: "update", rects, dpr, visible, style } }).catch(() => {});
      }
      applyMarks(measured, glassRef.current);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const scheduleLayout = () => {
      if (layoutTimer) clearTimeout(layoutTimer);
      layoutTimer = setTimeout(() => { layoutTimer = null; schedule(); }, LAYOUT_DEBOUNCE_MS);
    };
    scheduleRef.current = schedule;

    const ro = new ResizeObserver(scheduleLayout);
    const observeAll = () => {
      ro.disconnect();
      if (barRef.current) ro.observe(barRef.current);
      for (const p of panels) ro.observe(p);
    };
    // Menus mount and unmount inside the overlay, and a submenu can be
    // portalled straight to <body> (the Anime4K modes): watch both, and send
    // a change at once (plus a couple of re-measures for pop-in animations).
    const findPanels = (): HTMLElement[] => {
      const found = Array.from(root.querySelectorAll<HTMLElement>(PANEL_SELECTOR));
      for (const el of Array.from(document.body.children)) {
        if (el instanceof HTMLElement && el.matches(PANEL_SELECTOR)) found.push(el);
      }
      return found;
    };
    const refreshPanels = () => {
      const next = findPanels().slice(0, MAX_RECTS - 1);
      const same = next.length === panels.length && next.every((p, i) => p === panels[i]);
      if (same) return;
      panels = next;
      observeAll();
      schedule();
      for (const ms of SETTLE_REMEASURE_MS) {
        const t = setTimeout(() => { settleTimers.delete(t); schedule(); }, ms);
        settleTimers.add(t);
      }
    };
    const mo = new MutationObserver(refreshPanels);
    mo.observe(root, { childList: true, subtree: true });
    // Direct children only: a portalled panel is one, and a subtree watch
    // on <body> would wake for every DOM change in the app.
    mo.observe(document.body, { childList: true });
    // The material (cloud pull, the Hardware acceleration fallback) and the
    // theme (High Contrast floor) change the shader's look and the set sent.
    const rootMo = new MutationObserver(schedule);
    rootMo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-glass", "data-theme"] });
    window.addEventListener("resize", scheduleLayout);
    refreshPanels();
    observeAll();
    schedule();

    return () => {
      scheduleRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      if (layoutTimer) clearTimeout(layoutTimer);
      settleTimers.forEach((t) => clearTimeout(t));
      settleTimers.clear();
      mo.disconnect();
      rootMo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", scheduleLayout);
      for (const m of lastMeasuredRef.current) m.el.removeAttribute(MARK_ATTR);
      lastMeasuredRef.current = [];
      // Unmount, casting, no file, setting off: no rects.
      invoke("player_glass", { action: { kind: "clear" } }).catch(() => {});
    };
  }, [on, rootRef, barRef]);

  // The engine's answer (drawing or not, the video rect) moves the marks,
  // and a new video rect can change which surfaces are sent (a re-measure
  // that finds nothing new sends nothing: the key dedupes it).
  useEffect(() => {
    if (!on) return;
    applyMarks(lastMeasuredRef.current, glass);
    scheduleRef.current?.();
  }, [glass, on]);
}
