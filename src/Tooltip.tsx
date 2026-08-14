// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ---------------------------------------------------------------------------
// Tooltip — glass-styled, portal-rendered with viewport-edge collision.
//
// Wraps any single child element. On hover/focus, mounts a glass pill into
// document.body and positions it with `position: fixed` using the trigger's
// bounding rect. The previous CSS-only positioning ("right-full mr-2 top-1/2")
// silently clipped at viewport edges and at any ancestor with `overflow:
// hidden` — common on the title bar (drag region), stream rows (truncate
// containers), and the nav rail (clip-path / overflow). Portaling sidesteps
// all of that — the tip lays out in viewport coordinates, immune to
// ancestor clipping, and flips to the opposite side when its preferred
// placement would collide with a viewport edge.
//
// Click behaviour: clicking the wrapped element dismisses the tooltip
// immediately (it does NOT linger over a button the user has just
// activated). The dismissed state resets when the cursor leaves and
// re-enters, so the next hover shows it again.
//
// Safe for buttons inside `data-tauri-drag-region`: pointer-events on the
// floating tip are explicitly `none`, so it never interferes with the host
// button's hit-testing or with drag-region detection.
// ---------------------------------------------------------------------------

export type TooltipPos = "right" | "left" | "top" | "bottom";

interface Props {
  text: string;
  /** Optional rich content rendered INSTEAD of `text` (e.g. coloured count
   *  spans). `text` is still required as the plain fallback / measurement key. */
  content?: ReactNode;
  pos?: TooltipPos;
  /** Show keyboard hint after the label (e.g. "Sign in · S"). */
  shortcut?: string;
  /** Display delay in ms. Default 0: these appear INSTANTLY on hover, which is
   *  the whole reason they exist rather than a native `title`. The OS tooltip
   *  waits about a second, which is long enough that a hint explaining what a
   *  bulk action will do never arrived before the user had already clicked.
   *  Pass a value to re-introduce a delay for a trigger that needs one. */
  delay?: number;
  /** Extra classes merged into the wrapper span. The wrapper is `inline-flex`
   *  (shrink-to-fit) by default; pass e.g. `w-full` when the trigger should
   *  fill its container instead of collapsing to the child's content width. */
  className?: string;
  children: ReactNode;
}

const VIEWPORT_PAD = 8;
const TIP_GAP      = 8;

function clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let nx = x;
  let ny = y;
  if (nx + w + VIEWPORT_PAD > vw) nx = vw - w - VIEWPORT_PAD;
  if (ny + h + VIEWPORT_PAD > vh) ny = vh - h - VIEWPORT_PAD;
  if (nx < VIEWPORT_PAD) nx = VIEWPORT_PAD;
  if (ny < VIEWPORT_PAD) ny = VIEWPORT_PAD;
  return { x: nx, y: ny };
}

/** Rects of every menu surface currently on screen.
 *
 *  A tooltip is z-[400] and a context menu is z-[200]/z-[210], so a tip that
 *  lands on a menu covers it. That matters most where these two actually meet:
 *  a menu row's hint, whose trigger is INSIDE a menu and whose preferred
 *  placement is straight into the submenu that row just opened. Both menu roots
 *  carry role="menu", so they are addressable without a new global. */
function openMenuRects(): DOMRect[] {
  const out: DOMRect[] = [];
  document.querySelectorAll('[role="menu"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(r);
  });
  return out;
}

function overlaps(
  left: number, top: number, w: number, h: number, rects: DOMRect[],
): boolean {
  for (const r of rects) {
    if (left < r.right && left + w > r.left && top < r.bottom && top + h > r.top) {
      return true;
    }
  }
  return false;
}

function computePos(
  preferred: TooltipPos,
  anchor: DOMRect,
  tipW: number,
  tipH: number,
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Compute the four candidate positions.
  const candidates: Record<TooltipPos, { left: number; top: number; fits: boolean }> = {
    top: {
      left: anchor.left + anchor.width / 2 - tipW / 2,
      top:  anchor.top - tipH - TIP_GAP,
      fits: anchor.top - tipH - TIP_GAP >= VIEWPORT_PAD,
    },
    bottom: {
      left: anchor.left + anchor.width / 2 - tipW / 2,
      top:  anchor.bottom + TIP_GAP,
      fits: anchor.bottom + tipH + TIP_GAP + VIEWPORT_PAD <= vh,
    },
    left: {
      left: anchor.left - tipW - TIP_GAP,
      top:  anchor.top + anchor.height / 2 - tipH / 2,
      fits: anchor.left - tipW - TIP_GAP >= VIEWPORT_PAD,
    },
    right: {
      left: anchor.right + TIP_GAP,
      top:  anchor.top + anchor.height / 2 - tipH / 2,
      fits: anchor.right + tipW + TIP_GAP + VIEWPORT_PAD <= vw,
    },
  };

  // Try preferred first; if it fits, use it. Otherwise flip to the opposite
  // axis-mate, then fall back to whichever candidate fits.
  const opposite: Record<TooltipPos, TooltipPos> = {
    top: "bottom", bottom: "top", left: "right", right: "left",
  };
  const order: TooltipPos[] = [preferred, opposite[preferred], "top", "bottom", "left", "right"];
  let chosen = candidates[preferred];

  // PASS 1: a placement that fits the viewport AND clears every open menu.
  // This is what stops a menu row's hint from landing on the submenu that same
  // row just opened, which is where the tip is least readable and most in the
  // way.
  const menus = openMenuRects();
  let picked = false;
  if (menus.length > 0) {
    for (const p of order) {
      const c = candidates[p];
      if (c.fits && !overlaps(c.left, c.top, tipW, tipH, menus)) {
        chosen = c;
        picked = true;
        break;
      }
    }
  }
  // PASS 2: fall back to fit alone. A tip that is covering a menu still beats
  // a tip that is off-screen, and on a small window every side can be blocked.
  if (!picked) {
    for (const p of order) {
      if (candidates[p].fits) { chosen = candidates[p]; break; }
    }
  }

  // Final clamp keeps the tip inside the viewport even when no candidate
  // fits perfectly (e.g. trigger glued to a corner with a wide tooltip).
  const clamped = clampToViewport(chosen.left, chosen.top, tipW, tipH);
  return { left: clamped.x, top: clamped.y };
}

export default function Tooltip({ text, content, pos = "right", shortcut, delay = 0, className, children }: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef     = useRef<HTMLSpanElement>(null);
  const [open, setOpen]         = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [coords, setCoords]     = useState<{ left: number; top: number; ready: boolean }>({
    left: 0, top: 0, ready: false,
  });
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelShow = () => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
  };

  const scheduleShow = () => {
    cancelShow();
    // Synchronous when there is no delay: a zero-length timeout still costs a
    // macrotask, which is a visible beat on a fast pointer sweep.
    if (delay <= 0) { setOpen(true); return; }
    showTimer.current = setTimeout(() => setOpen(true), delay);
  };

  const handleClickLike = () => {
    setDismissed(true);
    setOpen(false);
    cancelShow();
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (el instanceof HTMLElement) el.blur();
    });
  };

  // Position computation. Re-runs whenever the tip is opened, the text
  // changes (which can change the tip's measured width), or the window
  // resizes. We render with `opacity:0` until the first measurement so
  // the tip never visibly jumps from (0,0) to its real spot.
  useLayoutEffect(() => {
    if (!open || dismissed) {
      setCoords((c) => c.ready ? { ...c, ready: false } : c);
      return;
    }
    const trigger = triggerRef.current;
    const tip     = tipRef.current;
    if (!trigger || !tip) return;
    const r = tip.getBoundingClientRect();
    const a = trigger.getBoundingClientRect();
    const { left, top } = computePos(pos, a, r.width, r.height);
    setCoords({ left, top, ready: true });
  }, [open, dismissed, pos, text, content, shortcut]);

  // Keep position correct on resize / scroll while open.
  useEffect(() => {
    if (!open || dismissed) return;
    const reposition = () => {
      const trigger = triggerRef.current;
      const tip     = tipRef.current;
      if (!trigger || !tip) return;
      const r = tip.getBoundingClientRect();
      const a = trigger.getBoundingClientRect();
      const { left, top } = computePos(pos, a, r.width, r.height);
      setCoords({ left, top, ready: true });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, dismissed, pos]);

  return (
    <span
      ref={triggerRef}
      className={`relative inline-flex${className ? ` ${className}` : ""}`}
      onClick={handleClickLike}
      onContextMenu={handleClickLike}
      onMouseEnter={() => { setDismissed(false); scheduleShow(); }}
      onMouseLeave={() => { setDismissed(false); cancelShow(); setOpen(false); }}
      onFocusCapture={() => { setDismissed(false); scheduleShow(); }}
      onBlurCapture={() => { cancelShow(); setOpen(false); }}
    >
      {children}
      {open && !dismissed && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          // aura-float-glass, not glass-panel-elevated: that composites
          // --ln-glass-3, which is TINTED per theme, so a tooltip over key art
          // picked up an accent-coloured wash. This is the same surface the
          // search bar and the menus use.
          className="aura-float-glass fixed z-[400] pointer-events-none whitespace-nowrap
                     px-2.5 py-1.5 rounded-lg
                     text-[11px] font-medium tracking-wide
                     transition-opacity duration-150"
          style={{
            color: "var(--text-primary)",
            left: coords.left,
            top:  coords.top,
            opacity: coords.ready ? 1 : 0,
          }}
        >
          {content ?? text}
          {shortcut && (
            <span className="ml-2 opacity-60 font-mono">{shortcut}</span>
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}
