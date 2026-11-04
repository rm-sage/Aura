// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// FlyUpToast — small label that spawns at the click point and floats
// upward over a few seconds while fading out. Distinct from AppToast
// (bottom-right stack of persistent saved-state pills) — this one is for
// "you just did a thing right HERE" feedback like adding/removing a
// library item from a card / detail-page button.
// ---------------------------------------------------------------------------

const EVENT = "aura:flyup-toast";
const DURATION_MS = 2400;
const RISE_PX = 80;
/** Minimum gap from any viewport edge after clamping. Keeps the toast
 *  visually framed even when the click hugs a corner. */
const VIEWPORT_MARGIN_PX = 16;

export type FlyUpTone = "default" | "success" | "danger";

interface ShowOptions {
  /** Origin point (typically a click event's clientX / clientY). The
   *  toast spawns centered on this point and floats upward from it. */
  x: number;
  y: number;
  /** Visual accent. */
  tone?: FlyUpTone;
}

interface ToastEntry {
  id: number;
  message: string;
  x: number;
  y: number;
  tone: FlyUpTone;
}

let nextId = 1;

export function showFlyUpToast(message: string, opts: ShowOptions) {
  if (!message) return;
  window.dispatchEvent(
    new CustomEvent<ToastEntry>(EVENT, {
      detail: {
        id: nextId++,
        message,
        x: opts.x,
        y: opts.y,
        tone: opts.tone ?? "default",
      },
    }),
  );
}

export default function FlyUpToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      setToasts((prev) => [...prev, detail]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== detail.id));
      }, DURATION_MS);
    };
    window.addEventListener(EVENT, onShow);
    return () => window.removeEventListener(EVENT, onShow);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[250] pointer-events-none">
      {toasts.map((t) => (
        <FlyUpItem key={t.id} toast={t} />
      ))}
      <style>{`
        @keyframes aura-flyup {
          0%   { opacity: 0;    transform: translate(-50%, 4px)        scale(0.92); }
          12%  { opacity: 1;    transform: translate(-50%, 0)          scale(1); }
          85%  { opacity: 0.95; transform: translate(-50%, -${RISE_PX * 0.85}px) scale(1); }
          100% { opacity: 0;    transform: translate(-50%, -${RISE_PX}px)        scale(1); }
        }
      `}</style>
    </div>
  );
}

function FlyUpItem({ toast }: { toast: ToastEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  // Initial position uses the unclamped click point so the first paint
  // matches what the user expects (right where they clicked). After mount
  // we measure the toast's rendered size and re-anchor it inside the
  // viewport margins — this happens before the browser commits the next
  // frame (useLayoutEffect) so the user never sees the unclamped flash.
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: toast.x,
    top:  toast.y,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Toast renders with `transform: translate(-50%, …)` (per the keyframes
    // below) so its left/top is the BOTTOM-CENTER anchor, not its top-left
    // corner. Clamp accordingly:
    //   • horizontal: keep ±halfWidth inside the viewport
    //   • vertical: account for the box's own height AND the upward rise
    const halfW = w / 2;
    const minLeft = halfW + VIEWPORT_MARGIN_PX;
    const maxLeft = vw - halfW - VIEWPORT_MARGIN_PX;
    // The animation lifts the box by RISE_PX while the box's bottom edge
    // stays anchored to `top`. So the highest pixel of the box during the
    // animation reaches y = top - h - RISE_PX.
    const minTop = h + RISE_PX + VIEWPORT_MARGIN_PX;
    const maxTop = vh - VIEWPORT_MARGIN_PX;
    const left = Math.max(minLeft, Math.min(maxLeft, toast.x));
    const top  = Math.max(minTop,  Math.min(maxTop,  toast.y));
    setPos({ left, top });
  }, [toast.x, toast.y]);

  const accent =
    toast.tone === "success"
      ? "border-emerald-300/45 text-emerald-100"
      : toast.tone === "danger"
        ? "border-rose-300/45 text-rose-100"
        : "border-white/20 text-white/95";

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className={`absolute px-3.5 py-1.5 rounded-full
                  bg-black/85 backdrop-blur-2xl shadow-glass-edge
                  border ${accent}
                  text-[12.5px] font-medium tracking-wide whitespace-nowrap`}
      style={{
        left: pos.left,
        top:  pos.top,
        // Anchor + lift driven entirely by the keyframes — keeps the
        // component declarative and avoids any per-frame React renders.
        animation: `aura-flyup ${DURATION_MS}ms ease-out forwards`,
      }}
    >
      {toast.message}
    </div>
  );
}
