// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

// `ResizeDirection` is declared in @tauri-apps/api/window's .d.ts but not
// re-exported, so we mirror the literal-union locally rather than reach
// into the module's internals.
type ResizeDirection =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

// ---------------------------------------------------------------------------
// ResizeHandles — invisible edge/corner regions that drive window resize on
// borderless windows.
//
// `tauri.conf.json` sets `decorations: false`, so Windows doesn't render the
// usual invisible OS-level resize borders. Without these handles, the user
// can't grab a window edge to resize at all. The eight regions (4 edges +
// 4 corners) cover the perimeter and call into Tauri's
// `startResizeDragging({direction})` API on pointer-down.
//
// Hit-area sizing: the original 4-px edges were too thin to reliably grab
// (especially on high-DPI displays and with a mouse moving fast off the
// window edge) — reported as "can't resize the window at all". Edges are now
// 6 px and corners a generous 16-px square (corners are the most-used resize
// grip and rarely overlap interactive content), which matches/exceeds the
// effective hit area Windows gives a normal sizing border.
//
// Z-index 9000 puts them above page content (so they always intercept the
// edge) but below the title bar (z-index 10000) so the title bar's drag
// region wins on the top edge.
// ---------------------------------------------------------------------------

interface HandleProps {
  className: string;
  cursor: string;
  direction: ResizeDirection;
}

function Handle({ className, cursor, direction }: HandleProps) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // startResizeDragging hands the gesture off to the OS — once the OS
      // takes ownership of the resize, no further pointer events come back
      // to us until release. We don't await; the call is fire-and-forget.
      getCurrentWindow().startResizeDragging(direction).catch(() => {});
    },
    [direction],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute z-[9000] ${className}`}
      style={{ cursor }}
    />
  );
}

export default function ResizeHandles() {
  return (
    <>
      {/* Edges — 6 px deep along each side, inset to leave the 16 px corners */}
      <Handle className="top-0 left-4 right-4 h-1.5"      cursor="ns-resize" direction="North" />
      <Handle className="bottom-0 left-4 right-4 h-1.5"   cursor="ns-resize" direction="South" />
      <Handle className="top-4 bottom-4 left-0 w-1.5"     cursor="ew-resize" direction="West"  />
      <Handle className="top-4 bottom-4 right-0 w-1.5"    cursor="ew-resize" direction="East"  />
      {/* Corners — 16 px squares (the primary resize grip) */}
      <Handle className="top-0 left-0 w-4 h-4"     cursor="nwse-resize" direction="NorthWest" />
      <Handle className="top-0 right-0 w-4 h-4"    cursor="nesw-resize" direction="NorthEast" />
      <Handle className="bottom-0 left-0 w-4 h-4"  cursor="nesw-resize" direction="SouthWest" />
      <Handle className="bottom-0 right-0 w-4 h-4" cursor="nwse-resize" direction="SouthEast" />
    </>
  );
}
