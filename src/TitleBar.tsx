// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import Tooltip from "./Tooltip";
import SyncStatusChip from "./SyncStatusChip";

// Movement (CSS px, either axis) before an armed press becomes a real drag.
// Below this a press-release stays a plain click, so double-click-to-maximize
// and single clicks never get captured or nudge the window.
const DRAG_THRESHOLD_PX = 4;

interface DragState {
  phase: "idle" | "armed" | "dragging";
  pointerId: number;
  el: HTMLElement | null;
  startScreenX: number;
  startScreenY: number;
  startWinX: number;
  startWinY: number;
  dpr: number;
  ready: boolean; // startWin{X,Y} resolved from outerPosition()
  target: { x: number; y: number } | null;
  raf: number | null;
}

function freshDragState(): DragState {
  return {
    phase: "idle", pointerId: -1, el: null,
    startScreenX: 0, startScreenY: 0, startWinX: 0, startWinY: 0,
    dpr: 1, ready: false, target: null, raf: null,
  };
}

// ---------------------------------------------------------------------------
// TitleBar
//
// Custom frameless title bar with:
//   • explicit onPointerDown drag (excludes [data-no-drag] children): native
//     OS caption drag on Win11, custom coalesced pointer-drag on Win10 — see
//     handlePointerDown for why the two paths diverge
//   • double-click → toggleMaximize, mirroring OS behavior
//   • Aura "Spectral Sweep": GPU-accelerated 20s gradient pass at low opacity
//   • Glass-styled minimize / maximize / close buttons; pointer-events:auto
//
// The sweep is purely a CSS animation on `transform: translate3d(...)` — the
// browser composites it on the GPU, so even with an upscaling shader running
// in MPV the title bar holds its frame rate.
// ---------------------------------------------------------------------------

const MinimizeIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <rect
      x="1.5"
      y="1.5"
      width="9"
      height="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    />
  </svg>
);

const RestoreIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    <path d="M3.5 3.5 V1.5 H10.5 V8.5 H8.5" fill="none" stroke="currentColor" strokeWidth="1" />
  </svg>
);

const CloseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <path
      d="M2 2 L10 10 M10 2 L2 10"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

interface Props {
  /** Optional headline shown to the right of the Aura wordmark. */
  subtitle?: string;
  /** When true, render the bar with a fully opaque background so the MPV
   *  video painted into the window's content area doesn't bleed through. */
  opaque?: boolean;
}

export default function TitleBar({ subtitle, opaque }: Props) {
  const [maximized, setMaximized] = useState(false);

  // Windows 10 needs a custom window-drag (see handlePointerDown). Detected
  // once at mount via the Rust RtlGetVersion probe; stays false (native drag)
  // until it resolves and on any non-Windows host / query failure.
  const isWin10Ref = useRef(false);
  useEffect(() => {
    invoke<boolean>("is_windows_10")
      .then((v) => { isWin10Ref.current = !!v; })
      .catch(() => {});
  }, []);

  // Transient state for the Win10 custom drag. A plain ref (never renders);
  // fully reset on every drag end.
  const dragRef = useRef<DragState>(freshDragState());
  // Last non-drag click (Win10 path) for synthesizing double-click → maximize,
  // since the native dblclick event is unreliable through pointer capture.
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Cancel any in-flight rAF if the bar unmounts mid-drag.
  useEffect(() => () => {
    const d = dragRef.current;
    if (d.raf != null) cancelAnimationFrame(d.raf);
  }, []);

  // Track maximize state so the icon flips between Maximize/Restore
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    win.isMaximized().then(setMaximized).catch(() => {});
    win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    }).then((un) => { unlisten = un; });
    return () => { unlisten?.(); };
  }, []);

  const minimize = useCallback(() => { getCurrentWindow().minimize(); }, []);
  const maximize = useCallback(() => { getCurrentWindow().toggleMaximize(); }, []);
  const close    = useCallback(() => { getCurrentWindow().close(); }, []);

  // Double-click on the drag region toggles maximize, matching standard OS
  // behaviour. The dblclick fires only on the drag region itself — buttons
  // intercept the event via stopPropagation in their own handlers.
  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    // Win10 synthesizes double-click in handlePointerUp (the native dblclick
    // event is unreliable through the custom pointer-capture drag); skip here
    // so the window can't toggle twice.
    if (isWin10Ref.current) return;
    getCurrentWindow().toggleMaximize();
  }, []);

  // Coalesced window reposition, one per animation frame. Reading the latest
  // cursor-derived target and issuing a single setPosition means moves can
  // never queue faster than the compositor presents them.
  const flushDragMove = useCallback(() => {
    const d = dragRef.current;
    d.raf = null;
    if (d.phase !== "dragging" || !d.ready || !d.target) return;
    getCurrentWindow()
      .setPosition(new PhysicalPosition(d.target.x, d.target.y))
      .catch(() => {});
  }, []);

  // Tear the drag fully down: cancel the pending frame, release capture, reset.
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d.raf != null) { cancelAnimationFrame(d.raf); d.raf = null; }
    if (d.phase === "dragging" && d.el && d.pointerId !== -1) {
      try { d.el.releasePointerCapture(d.pointerId); } catch { /* already gone */ }
    }
    dragRef.current = freshDragState();
  }, []);

  // Pointer-down starts a drag gesture. On Windows 11 (and any non-Windows /
  // unknown host, and whenever the window is maximized) we hand off to the OS
  // caption drag via `startDragging()` — it is smooth there and preserves Aero
  // Snap / snap-layouts / shake, and the maximized case restores-and-follows
  // the cursor natively.
  //
  // On Windows 10 the native caption drag posts WM_NCLBUTTONDOWN(HTCAPTION),
  // which enters DefWindowProc's modal SC_MOVE loop: it grabs mouse capture and
  // recomposites Aura's transparent WebView2 + child (mpv d3d11) swapchain on
  // every move step. On Win10's older DWM and weaker GPUs the loop can't keep
  // up, so move messages back up and the window crawls behind the captured
  // cursor (the reported "mouse locked, drags very slowly"). Instead we own the
  // gesture: capture the pointer in the webview once real movement begins (so
  // pointermove keeps flowing and pointerup / lostpointercapture give a
  // deterministic end — no modal loop), and reposition the window ourselves,
  // coalesced to one setPosition per frame. Capture is deferred until movement
  // crosses DRAG_THRESHOLD_PX so a plain click / double-click never captures
  // (double-click-to-maximize stays intact). Replaces the older
  // `data-tauri-drag-region` path, which stuck the cursor on simple clicks.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary button only
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;

    const win = getCurrentWindow();
    if (!isWin10Ref.current || maximized) {
      win.startDragging().catch(() => {});
      return;
    }

    // Arm the Win10 custom drag; don't capture or move until the pointer
    // actually travels (handlePointerMove promotes armed → dragging).
    const prev = dragRef.current;
    if (prev.raf != null) cancelAnimationFrame(prev.raf);
    const gesture: DragState = {
      ...freshDragState(),
      phase: "armed",
      pointerId: e.pointerId,
      el: e.currentTarget,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      dpr: window.devicePixelRatio || 1,
    };
    dragRef.current = gesture;
    // Anchor the window's current physical top-left. Until this resolves (a
    // few ms) pointermove no-ops, so the window never jumps at drag start.
    // Identity-match `gesture` (not pointerId, which a mouse reuses) so a late
    // resolve can't land on a subsequent drag.
    win.outerPosition()
      .then((p) => {
        if (dragRef.current === gesture && gesture.phase !== "idle") {
          gesture.startWinX = p.x;
          gesture.startWinY = p.y;
          gesture.ready = true;
        }
      })
      .catch(() => {});
  }, [maximized]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.phase === "idle" || e.pointerId !== d.pointerId) return;
    const dxCss = e.screenX - d.startScreenX;
    const dyCss = e.screenY - d.startScreenY;
    if (d.phase === "armed") {
      if (Math.abs(dxCss) < DRAG_THRESHOLD_PX && Math.abs(dyCss) < DRAG_THRESHOLD_PX) return;
      d.phase = "dragging";
      // Capturing now (still over the bar) keeps pointer events flowing even
      // as the window slides out from under the cursor.
      try { d.el?.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
    }
    if (!d.ready) return; // outerPosition() not back yet
    d.target = {
      x: Math.round(d.startWinX + dxCss * d.dpr),
      y: Math.round(d.startWinY + dyCss * d.dpr),
    };
    if (d.raf == null) d.raf = requestAnimationFrame(flushDragMove);
  }, [flushDragMove]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (e.pointerId !== d.pointerId) return;
    // A press that never crossed the drag threshold is a click, not a drag.
    const wasClick = d.phase === "armed";
    endDrag();
    // Win10 synthesizes double-click → maximize from two threshold-close clicks
    // within 400 ms (the native dblclick doesn't fire through the custom drag).
    // Win11 keeps the native onDoubleClick path (handleDoubleClick).
    if (!wasClick || !isWin10Ref.current) return;
    const now = performance.now();
    const last = lastClickRef.current;
    if (
      last &&
      now - last.t < 400 &&
      Math.abs(e.screenX - last.x) < DRAG_THRESHOLD_PX &&
      Math.abs(e.screenY - last.y) < DRAG_THRESHOLD_PX
    ) {
      lastClickRef.current = null;
      getCurrentWindow().toggleMaximize().catch(() => {});
    } else {
      lastClickRef.current = { t: now, x: e.screenX, y: e.screenY };
    }
  }, [endDrag]);

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== dragRef.current.pointerId) return;
    endDrag();
  }, [endDrag]);

  // Safety net: if the OS revokes capture (focus loss, driver hiccup, Esc),
  // tear the drag down so a missed pointerup can never wedge the gesture.
  const handleLostCapture = useCallback(() => { endDrag(); }, [endDrag]);

  return (
    <div
      className="relative flex items-center h-9 flex-shrink-0 select-none
                 border-b border-white/6 overflow-hidden"
      style={{
        // During playback we paint a fully opaque pure-black strip so MPV
        // doesn't bleed through the bar from below. Otherwise we leave it
        // semi-transparent so Mica / Acrylic shows through.
        background: opaque ? "rgba(0, 0, 0, 0.96)" : "rgba(0, 0, 0, 0.18)",
        transition: "background 300ms ease, box-shadow 300ms ease",
        // Cast a thin shadow downward when opaque so the boundary between
        // bar and video reads cleanly.
        boxShadow: opaque
          ? "0 6px 16px -8px rgba(0, 0, 0, 0.85)"
          : undefined,
        zIndex: 10000, // always on top of the player overlay
      }}
    >
      {/* Aura "Spectral Sweep" — GPU-composited gradient strip */}
      <div className="aura-sweep" aria-hidden />

      {/* Drag region — fills the bar but lets buttons receive clicks. We
          drive drag explicitly via onPointerDown rather than the legacy
          `data-tauri-drag-region` attribute (see comment on
          handlePointerDown above). */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostCapture}
        onDoubleClick={handleDoubleClick}
        className="absolute inset-0 cursor-default"
      />

      {/* Centered AURA wordmark — glass-textured letters that share the
          spectral gradient with the bar behind them, so the moving sweep
          appears to flow *through* the title. */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        aria-hidden={false}
      >
        <span className="aura-title">AURA</span>
        {subtitle && (
          <span className="ml-3 text-white/30 text-xs">· {subtitle}</span>
        )}
      </div>

      {/* Sync status chip — left of the spacer, anchored to the start of
          the bar. Reflects Aura Cloud connection + freshness at a glance
          (gray cloud = guest, green check = recently synced, amber alert
          = stale, rose X = error). Click jumps to Settings → Cloud Sync
          (sec-cloud-sync) once that section ships. */}
      <div className="relative flex items-stretch h-full pl-2" data-no-drag>
        <SyncStatusChip />
      </div>

      {/* Spacer pushes window controls to the right */}
      <div className="flex-1" />

      {/* Window controls — pointer-events forced auto so they sit above the drag layer */}
      <div className="relative flex items-stretch h-full" data-no-drag>
        <TitleBarButton onClick={minimize} label="Minimize" hover="rgba(255,255,255,0.10)">
          <MinimizeIcon />
        </TitleBarButton>
        <TitleBarButton onClick={maximize} label={maximized ? "Restore" : "Maximize"} hover="rgba(255,255,255,0.10)">
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </TitleBarButton>
        <TitleBarButton onClick={close} label="Close" hover="rgba(232, 17, 35, 0.85)" hoverColor="white">
          <CloseIcon />
        </TitleBarButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TitleBarButton
// ---------------------------------------------------------------------------

interface BtnProps {
  onClick: () => void;
  label: string;
  hover: string;
  hoverColor?: string;
  children: React.ReactNode;
}

function TitleBarButton({ onClick, label, hover, hoverColor, children }: BtnProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <Tooltip text={label} pos="bottom">
      <button
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={label}
        className="flex items-center justify-center w-11 h-full transition-colors duration-100"
        style={{
          background: hovered ? hover : "transparent",
          color: hovered && hoverColor ? hoverColor : "rgba(255,255,255,0.7)",
          pointerEvents: "auto",
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}
