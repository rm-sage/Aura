// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// PartyToast — a SEPARATE toast surface for Watch-Together activity (joins,
// leaves, leadership changes). Unlike AppToast (top-centre) these spawn from
// the party icon's side and stack downward, so party chatter reads as coming
// "from the party" rather than as a generic app notification.
//
// The anchor is whichever party affordance is currently on screen — the
// home/browse PartyButton (left) or the in-player presence cluster (right).
// Both carry `data-party-anchor`; exactly one is visible at a time. Toasts
// emerge horizontally OUT of that icon toward the screen interior (icon on the
// left half → slide in from the left; right half → from the right), which also
// keeps the right-side stack clear of the top-right PartyVotesOverlay column.
//
// Trigger from anywhere via `showPartyToast("…")`.
// ---------------------------------------------------------------------------

const EVENT = "aura:party-toast";
const MAX_VISIBLE = 4;
const DEFAULT_DURATION_MS = 4200;

export type PartyToastTone = "default" | "success" | "leader";

interface ShowOptions {
  duration?: number;
  tone?: PartyToastTone;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: PartyToastTone;
  duration: number;
}

let nextId = 1;

/** Fire a party-activity toast from anywhere. Dropped silently if no host is
 *  mounted yet (only during the app shell's first render). */
export function showPartyToast(message: string, opts?: ShowOptions) {
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

type Anchor =
  | { side: "left"; top: number; left: number }
  | { side: "right"; top: number; right: number };

/** Locate the visible party affordance and derive where + which way to spawn.
 *  Multiple `[data-party-anchor]` nodes can exist (the PartyButton stays in the
 *  DOM but goes display:none during playback) — pick the first with a real box;
 *  fall back to the top-right corner if none is laid out yet. */
function readAnchor(): Anchor {
  const els = Array.from(document.querySelectorAll<HTMLElement>("[data-party-anchor]"));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      const center = r.left + r.width / 2;
      const top = Math.round(r.bottom + 10);
      if (center < window.innerWidth / 2) {
        return { side: "left", top, left: Math.round(r.left) };
      }
      return { side: "right", top, right: Math.round(window.innerWidth - r.right) };
    }
  }
  return { side: "right", top: 70, right: 16 };
}

export default function PartyToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      setToasts((prev) => {
        const next = [...prev, detail];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      const t = window.setTimeout(() => {
        timers.current.delete(t);
        setToasts((prev) => prev.filter((x) => x.id !== detail.id));
      }, detail.duration);
      timers.current.add(t);
    };
    window.addEventListener(EVENT, onShow);
    const pending = timers.current;
    return () => {
      window.removeEventListener(EVENT, onShow);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  const anchor = readAnchor();
  const positioning =
    anchor.side === "left"
      ? { top: anchor.top, left: anchor.left }
      : { top: anchor.top, right: anchor.right };

  return (
    <div
      className={[
        "fixed z-[10050] flex flex-col gap-2 pointer-events-none max-w-[78vw]",
        anchor.side === "left" ? "items-start" : "items-end",
      ].join(" ")}
      style={positioning}
    >
      {toasts.map((t) => (
        <PartyToastItem key={t.id} toast={t} side={anchor.side} />
      ))}
      <style>{`
        @keyframes aura-party-toast-in-left {
          0%   { opacity: 0; transform: translateX(-18px) scale(0.96); }
          60%  { opacity: 1; transform: translateX(2px)   scale(1.01); }
          100% { opacity: 1; transform: translateX(0)     scale(1); }
        }
        @keyframes aura-party-toast-in-right {
          0%   { opacity: 0; transform: translateX(18px)  scale(0.96); }
          60%  { opacity: 1; transform: translateX(-2px)  scale(1.01); }
          100% { opacity: 1; transform: translateX(0)     scale(1); }
        }
      `}</style>
    </div>
  );
}

function PartyToastItem({ toast, side }: { toast: ToastEntry; side: "left" | "right" }) {
  const accent =
    toast.tone === "success"
      ? "border-emerald-300/45 bg-emerald-300/[0.06]"
      : toast.tone === "leader"
        ? "border-amber-300/45 bg-amber-300/[0.06]"
        : "border-ln-accent/35 bg-ln-accent/[0.06]";
  const glyph = toast.tone === "leader" ? "♛" : toast.tone === "success" ? "›" : "·";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none flex items-center gap-2 px-3.5 py-2 rounded-xl
                  bg-black/85 backdrop-blur-2xl border ${accent}
                  text-white/90 text-[12.5px] tracking-wide leading-snug
                  max-w-[320px] shadow-[0_8px_24px_-6px_rgba(0,0,0,0.65)]`}
      style={{
        animation: `aura-party-toast-in-${side} 360ms cubic-bezier(0.22, 1, 0.36, 1)`,
        animationFillMode: "both",
      }}
    >
      <span aria-hidden className="text-ln-accent/80 text-[13px] leading-none">{glyph}</span>
      <span className="truncate">{toast.message}</span>
    </div>
  );
}
