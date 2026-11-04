// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// AppToast — global toast surface for non-player surfaces (Settings, Addons,
// Library, OAuth flows, etc.). The PlayerOverlay has its own in-player toast
// (FlyUpToast) anchored at the click location for volume / skip / pause
// feedback; that one is unchanged. This host renders at top-centre of the
// viewport so non-player toasts are immediately visible from any tab, with
// a brief flash + glow on entry to draw the eye.
//
// Trigger from any component via `showAppToast("message")`. The host below
// listens for the matching event and stacks up to MAX_VISIBLE toasts at a
// time. Older ones drop off the bottom as new ones arrive at the top.
// ---------------------------------------------------------------------------

const EVENT = "aura:app-toast";
const MAX_VISIBLE = 3;
/** Default visible duration. Bumped from the original 2.2s so users have
 *  comfortable read time on multi-line messages. The flash + glow on entry
 *  draws attention quickly; the longer dwell prevents a glance-away from
 *  missing the content. */
const DEFAULT_DURATION_MS = 4500;

export type ToastTone = "default" | "success" | "danger";

interface ShowOptions {
  /** Auto-dismiss timeout in ms. Default 2200. */
  duration?: number;
  /** Visual tone — picks a subtle accent stripe. */
  tone?: ToastTone;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
}

let nextId = 1;

/** Trigger a toast from anywhere in the React tree.
 *
 *  Stays available even before AppToastHost mounts — events are fired
 *  immediately, dropped silently if no host is listening yet (which only
 *  happens during the first render of the app shell). */
export function showAppToast(message: string, opts?: ShowOptions) {
  if (!message) return;
  window.dispatchEvent(
    new CustomEvent<ToastEntry>(EVENT, {
      detail: {
        id: nextId++,
        message,
        tone: opts?.tone ?? "default",
        duration: Math.max(800, opts?.duration ?? DEFAULT_DURATION_MS),
      },
    }),
  );
}

export default function AppToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      setToasts((prev) => {
        const next = [...prev, detail];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      // Auto-remove after the toast's own duration.
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== detail.id));
      }, detail.duration);
    };
    window.addEventListener(EVENT, onShow);
    return () => window.removeEventListener(EVENT, onShow);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[300] flex flex-col items-center gap-2 pointer-events-none"
      style={{
        // Top-centre, sat below the title bar (36px) with a small
        // gutter. Player overlay's FlyUpToast tracks the cursor so
        // they don't collide; if both happen to render together,
        // FlyUpToast at z-[250] sits behind this z-[300] surface.
        top: 56,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
      <style>{`
        @keyframes aura-app-toast-flash {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.94);
                 box-shadow: 0 0 0 0 rgba(91, 164, 255, 0); }
          18%  { opacity: 1; transform: translateY(0)     scale(1.04);
                 box-shadow: 0 8px 24px -4px rgba(91, 164, 255, 0.55),
                             0 0 0 6px rgba(91, 164, 255, 0.18); }
          32%  { transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(91, 164, 255, 0.40),
                             0 0 0 0 rgba(91, 164, 255, 0); }
          100% { opacity: 1; transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.55); }
        }
        @keyframes aura-app-toast-flash-success {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.94);
                 box-shadow: 0 0 0 0 rgba(110, 231, 183, 0); }
          18%  { opacity: 1; transform: translateY(0)     scale(1.04);
                 box-shadow: 0 8px 24px -4px rgba(110, 231, 183, 0.55),
                             0 0 0 6px rgba(110, 231, 183, 0.18); }
          32%  { transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(110, 231, 183, 0.40),
                             0 0 0 0 rgba(110, 231, 183, 0); }
          100% { opacity: 1; transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.55); }
        }
        @keyframes aura-app-toast-flash-danger {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.94);
                 box-shadow: 0 0 0 0 rgba(251, 113, 133, 0); }
          18%  { opacity: 1; transform: translateY(0)     scale(1.04);
                 box-shadow: 0 8px 24px -4px rgba(251, 113, 133, 0.55),
                             0 0 0 6px rgba(251, 113, 133, 0.18); }
          32%  { transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(251, 113, 133, 0.40),
                             0 0 0 0 rgba(251, 113, 133, 0); }
          100% { opacity: 1; transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.55); }
        }
      `}</style>
    </div>
  );
}

function ToastItem({ toast }: { toast: ToastEntry }) {
  const accent =
    toast.tone === "success"
      ? "border-emerald-300/45 bg-emerald-300/5"
      : toast.tone === "danger"
        ? "border-rose-300/45 bg-rose-300/5"
        : "border-ln-accent/35 bg-ln-accent/5";
  const animName =
    toast.tone === "success"
      ? "aura-app-toast-flash-success"
      : toast.tone === "danger"
        ? "aura-app-toast-flash-danger"
        : "aura-app-toast-flash";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto px-4 py-2.5 rounded-xl
                  bg-black/85 backdrop-blur-2xl
                  border ${accent}
                  text-white/90 text-[13px] tracking-wide leading-snug
                  min-w-[260px] max-w-[440px] text-center`}
      style={{
        // Flash entry: 520ms total. Longer than the old 220ms so the
        // glow halo registers; ramps to a quiet drop-shadow afterward
        // so multiple stacked toasts don't strobe.
        animation: `${animName} 520ms cubic-bezier(0.22, 1, 0.36, 1)`,
        animationFillMode: "both",
      }}
    >
      {toast.message}
    </div>
  );
}
