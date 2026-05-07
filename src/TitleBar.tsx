// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Tooltip from "./Tooltip";

// ---------------------------------------------------------------------------
// TitleBar
//
// Custom frameless title bar with:
//   • data-tauri-drag-region for native drag (excludes child interactive elems)
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
    getCurrentWindow().toggleMaximize();
  }, []);

  // Explicit pointer-down → startDragging. Replaces `data-tauri-drag-region`
  // because that CSS-only path was getting stuck on simple clicks: any
  // single-click could leave the cursor "attached" to the title bar until
  // the next pointer event because Tauri waits for movement to commit the
  // drag and the WebView2 surface didn't always send the release back.
  // Calling `startDragging()` directly forces the OS to take ownership of
  // the gesture, and standard click/double-click behaviour stays intact.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // primary button only
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }, []);

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

      {/* Spacer pushes window controls to the right (left side intentionally blank) */}
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
