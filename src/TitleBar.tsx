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

  // Whether a click on X only HIDES to tray. Drives the close button's
  // hold-to-quit affordance and its tooltip: hold-to-quit is offered ONLY when
  // a plain click would not exit, because otherwise it would just be a slower
  // way to do what the click already does. Re-read on `aura:settings-changed`
  // so toggling the setting updates the button without a restart.
  const [trayOnClose, setTrayOnClose] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => {
      invoke<{ minimize_to_tray_on_close?: boolean }>("get_settings")
        .then((s) => { if (alive) setTrayOnClose(!!s?.minimize_to_tray_on_close); })
        .catch(() => {});
    };
    read();
    window.addEventListener("aura:settings-changed", read);
    return () => {
      alive = false;
      window.removeEventListener("aura:settings-changed", read);
    };
  }, []);

  // Double-click on the drag region toggles maximize, matching standard OS
  // behaviour. Works on both platforms because the drag is deferred until the
  // pointer actually moves (see handlePointerDown), so a plain double-click is
  // never swallowed by the OS move loop and the native dblclick fires normally.
  // Buttons opt out via [data-no-drag].
  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    getCurrentWindow().toggleMaximize();
  }, []);

  // Coalesced window reposition (Win10 custom drag), one per animation frame.
  // Issuing a single setPosition to the latest cursor-derived target means
  // moves can never queue faster than the compositor presents them.
  const flushDragMove = useCallback(() => {
    const d = dragRef.current;
    d.raf = null;
    if (d.phase !== "dragging" || !d.ready || !d.target) return;
    getCurrentWindow()
      .setPosition(new PhysicalPosition(d.target.x, d.target.y))
      .catch(() => {});
  }, []);

  // Tear the gesture fully down: cancel the pending frame, release capture, reset.
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    if (d.raf != null) { cancelAnimationFrame(d.raf); d.raf = null; }
    if (d.phase === "dragging" && d.el && d.pointerId !== -1) {
      try { d.el.releasePointerCapture(d.pointerId); } catch { /* already gone */ }
    }
    dragRef.current = freshDragState();
  }, []);

  // Pointer-down only ARMS a gesture — the actual drag is deferred to the first
  // real movement (handlePointerMove). This is deliberate: calling
  // `startDragging()` on pointer-down enters the OS modal SC_MOVE loop
  // immediately and swallows the second click of a double-click, so
  // double-click-to-maximize silently stops working. Deferring means a plain
  // click / double-click never starts a drag and reaches the webview as
  // ordinary click / dblclick events. (Replaces the old `data-tauri-drag-region`
  // path, which stuck the cursor on simple clicks.)
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary button only
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;

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
    // The Win10 custom drag needs the window's current physical top-left.
    // Prefetch it now (harmless if the gesture turns out to be a click or a
    // native Win11 drag). Identity-match `gesture` (not pointerId, which a
    // mouse reuses) so a late resolve can't land on a later gesture.
    if (isWin10Ref.current && !maximized) {
      getCurrentWindow().outerPosition()
        .then((p) => {
          if (dragRef.current === gesture && gesture.phase !== "idle") {
            gesture.startWinX = p.x;
            gesture.startWinY = p.y;
            gesture.ready = true;
          }
        })
        .catch(() => {});
    }
  }, [maximized]);

  // First movement past the threshold promotes the armed gesture to a real
  // drag. Win11 (and any non-Windows / maximized window) hands off to the
  // native OS caption drag via `startDragging()` — smooth there and it keeps
  // Aero Snap / snap-layouts / shake, and restores-and-follows a maximized
  // window. Windows 10 instead runs a custom coalesced drag: the native modal
  // SC_MOVE loop recomposites Aura's transparent WebView2 + mpv d3d11 child on
  // every step and stalls on Win10's older DWM + weak GPUs (window crawls behind
  // a captured cursor), so we capture the pointer and reposition the window
  // ourselves, one setPosition per frame.
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d.phase !== "armed" && d.phase !== "dragging") return;
    if (e.pointerId !== d.pointerId) return;
    const dxCss = e.screenX - d.startScreenX;
    const dyCss = e.screenY - d.startScreenY;
    if (d.phase === "armed") {
      if (Math.abs(dxCss) < DRAG_THRESHOLD_PX && Math.abs(dyCss) < DRAG_THRESHOLD_PX) return;
      if (!isWin10Ref.current || maximized) {
        // Native OS drag from the current cursor position; the modal loop takes
        // over from here, so we stop tracking this gesture.
        getCurrentWindow().startDragging().catch(() => {});
        dragRef.current = freshDragState();
        return;
      }
      d.phase = "dragging";
      // Capture now (still over the bar) so pointer events keep flowing as the
      // window slides out from under the cursor.
      try { d.el?.setPointerCapture(e.pointerId); } catch { /* capture unavailable */ }
    }
    if (!d.ready) return; // outerPosition() not back yet
    d.target = {
      x: Math.round(d.startWinX + dxCss * d.dpr),
      y: Math.round(d.startWinY + dyCss * d.dpr),
    };
    if (d.raf == null) d.raf = requestAnimationFrame(flushDragMove);
  }, [flushDragMove, maximized]);

  const handlePointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== dragRef.current.pointerId) return;
    endDrag();
  }, [endDrag]);

  // Safety net: if the OS revokes capture (focus loss, driver hiccup, Esc),
  // tear the custom drag down so a missed pointerup can't wedge the gesture.
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
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
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
        <CloseButton onClose={close} holdToQuit={trayOnClose} />
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

/** How long the close button must be held to force a full quit. Kept in ONE
 *  place: it drives both the JS timer and the CSS fill's duration, so the bar
 *  reaching the far edge and the quit firing can never drift apart. */
const HOLD_TO_QUIT_MS = 1000;

/**
 * Close button. A normal click does whatever the setting says (quit, or hide to
 * tray). When `holdToQuit` is set - i.e. `minimize_to_tray_on_close` is ON, so a
 * click would only hide - pressing and HOLDING for HOLD_TO_QUIT_MS fully exits
 * instead. Without this there is no way to actually quit from a visible window:
 * X, Alt+F4 and every other close route all hide, and the tray icon (the only
 * other exit) is shown ONLY while the window is already hidden.
 *
 * The progress fill is a pure CSS one-shot rather than a rAF loop driving React
 * state, so holding does not re-render this button ~120 times.
 */
function CloseButton({ onClose, holdToQuit }: { onClose: () => void; holdToQuit: boolean }) {
  const [hovered, setHovered] = useState(false);
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Set when a hold completes, so the click that follows pointerup does not
  // ALSO run the ordinary close on top of the quit we just requested.
  const firedRef = useRef(false);

  const cancelHold = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
  }, []);

  // Never leave a timer behind if the title bar unmounts mid-hold (entering
  // true fullscreen unmounts it).
  useEffect(() => cancelHold, [cancelHold]);

  const beginHold = useCallback(() => {
    if (!holdToQuit) return;
    firedRef.current = false;
    setHolding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      setHolding(false);
      // Rust arms its force-quit flag and issues a normal close, so this gets
      // the full teardown (MPV/WASAPI, scrobble flush, cast stop) rather than
      // an abrupt exit.
      void invoke("request_quit").catch(() => {});
    }, HOLD_TO_QUIT_MS);
  }, [holdToQuit]);

  const label = holdToQuit ? "Close to tray (hold to quit Aura)" : "Close";

  return (
    <Tooltip text={label} pos="bottom">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (firedRef.current) { firedRef.current = false; return; }
          onClose();
        }}
        onPointerDown={beginHold}
        onPointerUp={cancelHold}
        onPointerLeave={() => { setHovered(false); cancelHold(); }}
        onPointerCancel={cancelHold}
        onMouseEnter={() => setHovered(true)}
        aria-label={label}
        className="relative overflow-hidden flex items-center justify-center w-11 h-full
                   transition-colors duration-100"
        style={{
          background: hovered ? "rgba(232, 17, 35, 0.85)" : "transparent",
          color: hovered ? "white" : "rgba(255,255,255,0.7)",
          pointerEvents: "auto",
        }}
      >
        {holding && (
          <span
            aria-hidden
            className="aura-hold-fill absolute inset-0 bg-white/25"
            style={{ animationDuration: `${HOLD_TO_QUIT_MS}ms` }}
          />
        )}
        <span className="relative"><CloseIcon /></span>
      </button>
    </Tooltip>
  );
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
