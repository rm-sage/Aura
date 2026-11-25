// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { readPartyAnchor } from "./partyAnchor";
import { GLASS_SHADOW, useLiveAnnouncer } from "./AppToast";

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

export default function PartyToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const { announce, regions } = useLiveAnnouncer();
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      setToasts((prev) => {
        const next = [...prev, detail];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });
      announce(detail.message);
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
  }, [announce]);

  if (toasts.length === 0) return <>{regions}</>;

  const anchor = readPartyAnchor();
  const positioning =
    anchor.side === "left"
      ? { top: anchor.top, left: anchor.left }
      : { top: anchor.top, right: anchor.right };

  return (
    <>
    {regions}
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
        /* The entry flash: a halo in the THEME accent (default and success
           toasts; var() in keyframes resolves on the toast, so a theme
           switch is honoured) that settles to the bare glass list. A host
           change flashes amber, the colour of its crown and hairline.
           Every frame carries the glass list (AppToast GLASS_SHADOW). */
        @keyframes aura-party-toast-flash {
          0%   { box-shadow: 0 0 0 0 rgb(var(--ln-accent-rgb) / 0), 0 0 0 0 rgb(var(--ln-accent-rgb) / 0), ${GLASS_SHADOW}; }
          22%  { box-shadow: 0 6px 20px -4px rgb(var(--ln-accent-rgb) / 0.50),
                             0 0 0 5px rgb(var(--ln-accent-rgb) / 0.16), ${GLASS_SHADOW}; }
          40%  { box-shadow: 0 6px 20px -4px rgb(var(--ln-accent-rgb) / 0.36),
                             0 0 0 0 rgb(var(--ln-accent-rgb) / 0), ${GLASS_SHADOW}; }
          100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0), ${GLASS_SHADOW}; }
        }
        @keyframes aura-party-toast-flash-leader {
          0%   { box-shadow: 0 0 0 0 rgb(251 191 36 / 0), 0 0 0 0 rgb(251 191 36 / 0), ${GLASS_SHADOW}; }
          22%  { box-shadow: 0 6px 20px -4px rgb(251 191 36 / 0.45),
                             0 0 0 5px rgb(251 191 36 / 0.14), ${GLASS_SHADOW}; }
          40%  { box-shadow: 0 6px 20px -4px rgb(251 191 36 / 0.32),
                             0 0 0 0 rgb(251 191 36 / 0), ${GLASS_SHADOW}; }
          100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0), ${GLASS_SHADOW}; }
        }
      `}</style>
    </div>
    </>
  );
}

function PartyToastItem({ toast, side }: { toast: ToastEntry; side: "left" | "right" }) {
  // No persistent coloured hairline on a default or success toast (the same
  // call as AppToast): the accent / green ring read as a line of colour round
  // the edge for the whole dwell, and the neutral glass edge already defines
  // the shape. The colour lives only in the entry flash, in the THEME accent.
  // A host change keeps its faint amber hairline (the crown's colour, a
  // semantic tone like an error's red, src/styles/glass-settings.css).
  const leader = toast.tone === "leader";
  const toneRing = leader ? "aura-glass-tone-warning" : "";
  const flash = leader ? "aura-party-toast-flash-leader" : "aura-party-toast-flash";
  const glyph = leader ? "♛" : toast.tone === "success" ? "›" : "·";
  return (
    <div
      // Not a live region: the host announces through useLiveAnnouncer.
      // The tooltip tier of the shared glass: cheap, never refracted.
      className={`aura-float-glass aura-glass-tip ${toneRing} pointer-events-none flex items-center gap-2
                  px-3.5 py-2 rounded-xl text-white/90 text-[12.5px] tracking-wide leading-snug
                  max-w-[320px]`}
      style={{
        // The slide (opacity + transform) and the flash (box-shadow) run
        // side by side; the fill modes live IN the shorthand, so React never
        // resets them to "none".
        animation: `aura-party-toast-in-${side} 360ms cubic-bezier(0.22, 1, 0.36, 1) both, `
          + `${flash} 560ms cubic-bezier(0.22, 1, 0.36, 1) both`,
      }}
    >
      <span aria-hidden className="text-ln-accent/80 text-[13px] leading-none">{glyph}</span>
      <span className="truncate">{toast.message}</span>
    </div>
  );
}
