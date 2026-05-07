// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// AppToast — global toast surface for non-player surfaces (Settings, Addons,
// Library, etc.). The PlayerOverlay has its own in-player toast positioned
// over the video; this one renders in the bottom-right of the viewport
// where it's visible from any tab.
//
// Trigger from any component via `showAppToast("message")`. The host below
// listens for the matching event and stacks up to MAX_VISIBLE toasts at a
// time — older ones drop off the top as new ones arrive.
// ---------------------------------------------------------------------------

const EVENT = "aura:app-toast";
const MAX_VISIBLE = 3;
const DEFAULT_DURATION_MS = 2200;

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
      className="fixed z-[300] flex flex-col gap-2 pointer-events-none"
      style={{
        // Bottom-right with safe gutter; the PlayerOverlay toast sits at
        // top-center so the two never collide.
        right: 20,
        bottom: 20,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: ToastEntry }) {
  const accent =
    toast.tone === "success"
      ? "border-emerald-300/35 bg-emerald-300/5"
      : toast.tone === "danger"
        ? "border-rose-300/35 bg-rose-300/5"
        : "border-white/15 bg-white/5";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto px-4 py-2.5 rounded-xl
                  bg-black/85 backdrop-blur-2xl shadow-glass-edge
                  border ${accent}
                  text-white/90 text-[13px] tracking-wide leading-snug
                  min-w-[220px] max-w-[420px]`}
      style={{
        animation: "aura-app-toast-in 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      {toast.message}
      <style>{`
        @keyframes aura-app-toast-in {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0)   scale(1); }
        }
      `}</style>
    </div>
  );
}
