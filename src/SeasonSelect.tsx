// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// SeasonSelect — custom popover dropdown for the episode panel's season
// picker. Replaces a native <select> for two reasons:
//
//   1. Direction control. Windows native combo-boxes open upward when
//      the trigger is near the bottom of the screen, which on a multi-
//      monitor setup with the app at the bottom of the primary display
//      stretches the popup onto a different monitor (or off-screen).
//      We always prefer downward and only flip up when there's no room
//      below (rare; the popover is short).
//   2. Visible-count cap. Native <select> shows ~30 items by default
//      on Windows; the user wants up to 10 visible with scroll for
//      anime / long-running shows. A custom list trivially caps via
//      max-height + overflow-y: auto.
//
// Behaviour:
//   • Click trigger → open popover positioned just below the trigger
//     button. Width matches the trigger.
//   • Click outside / press Escape / pick a season → close.
//   • Up/Down keys move highlight; Enter selects.
//   • Highlights the current season; clicking the same one is a no-op
//     close.
//
// EXTRACTED VERBATIM from views/DetailView.tsx (EOS Spotlight spec
// 2026-05-19, Phase 3) so the EOS EpisodePanel and DetailView share one
// byte-identical implementation. Behaviour must not change — DetailView
// now imports this; the EpisodePanel reuses it as-is.
// ---------------------------------------------------------------------------

const SEASON_VISIBLE_CAP = 10;

export default function SeasonSelect({
  seasons, value, onChange, names,
}: {
  seasons: number[];
  value: number;
  onChange: (s: number) => void;
  /** Optional per-season display names keyed by season number (string).
   *  When a season has a MEANINGFUL name (not just a restatement of
   *  "Season N"), it's folded into the label as a dimmer suffix
   *  ("Season 2 · Stone Wars"). Redundant names are suppressed so a
   *  plain "Season 1" doesn't render as "Season 1 · Season 1". */
  names?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Map<number, HTMLButtonElement>>(new Map());

  const baseLabel = (s: number) => (s === 0 ? "Specials" : `Season ${s}`);
  // The season's display name, but ONLY when it adds real information
  // beyond the base label. Suppressed:
  //   • empty / whitespace
  //   • an exact "Specials" / "Season N" restatement of THIS season
  //   • ANY generic season label — "Season 7", "Season 02", "S3", or a
  //     bare number — regardless of which season it's attached to. Some
  //     providers (observed: AIOMetadata on certain TMDB-backed anime like
  //     Hitori no Shita) stamp a generic/wrong name on every season, which
  //     surfaced as "Season 2 · Season 1". A generic season label carries
  //     no cour information, so it's noise on any season.
  // Real cour titles ("Stone Wars", "New World", "Part 2", "2nd Season")
  // don't match the generic shape and still render.
  const extraName = (s: number): string | null => {
    const raw = names?.[String(s)]?.trim();
    if (!raw) return null;
    if (raw.toLowerCase() === baseLabel(s).toLowerCase()) return null;
    if (/^(?:season\s*\d+|s\s*\d+|\d+)$/i.test(raw)) return null;
    return raw;
  };

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => {
          const idx = seasons.indexOf(h);
          const next = seasons[(idx + 1) % seasons.length];
          itemsRef.current.get(next)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => {
          const idx = seasons.indexOf(h);
          const prev = seasons[(idx - 1 + seasons.length) % seasons.length];
          itemsRef.current.get(prev)?.scrollIntoView({ block: "nearest" });
          return prev;
        });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onChange(highlight);
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, seasons, highlight, onChange]);

  // Reset highlight when opening so the cursor lands on the current season.
  useEffect(() => {
    if (!open) return;
    setHighlight(value);
    // Defer the scroll until the popover has actually mounted with the
    // current item visible — without this, scrollIntoView runs against
    // the just-mounted container before its height is final.
    requestAnimationFrame(() => {
      itemsRef.current.get(value)?.scrollIntoView({ block: "nearest" });
    });
  }, [open, value]);

  // Decide direction: prefer downward. Flip upward only when there's
  // genuinely no room below (rare given the popover caps at ~10 rows).
  // Recomputed every time the popover opens so a different season
  // count or window resize doesn't keep a stale orientation.
  const [direction, setDirection] = useState<"down" | "up">("down");
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const itemH = 36;
    const padding = 12;
    const wantH = Math.min(seasons.length, SEASON_VISIBLE_CAP) * itemH + padding;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= wantH || spaceBelow >= spaceAbove) {
      setDirection("down");
    } else {
      setDirection("up");
    }
  }, [open, seasons.length]);

  const popoverStyle: React.CSSProperties = {
    maxHeight: `${SEASON_VISIBLE_CAP * 36 + 8}px`,
    minWidth: triggerRef.current?.offsetWidth ?? 160,
    // Cap the width so a long cour title ("Season 3 · Mushoku Tensei: Jobless
    // Reincarnation Season 3") can't blow the popover out. The options are
    // `truncate` (white-space: nowrap), so their min-content width is the WHOLE
    // string; with no cap the absolutely-positioned popover shrink-wraps far
    // past the panel, overflows it, and adds a horizontal scroll that shoves
    // the episode list sideways until the dropdown closes. max-width clamps it
    // so the per-option truncate engages instead (full name stays in `title`).
    maxWidth: "min(88vw, 360px)",
    ...(direction === "down" ? { top: "100%", marginTop: 4 } : { bottom: "100%", marginBottom: 4 }),
  };

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="bg-black/45 border border-white/16 rounded-lg px-5 py-2.5
                   text-[16px] font-mono tracking-wide outline-none
                   focus:border-ln-accent/45 transition-colors cursor-pointer
                   appearance-none pr-10 inline-flex items-center max-w-[340px] min-w-0"
        style={{
          color: "var(--text-primary)",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='rgba(255,255,255,0.55)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 10px center",
        }}
      >
        <span className="truncate min-w-0">
          {baseLabel(value)}
          {extraName(value) && (
            <span className="text-white/55"> · {extraName(value)}</span>
          )}
        </span>
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          className="absolute left-0 z-40 overflow-y-auto
                     bg-black/85 backdrop-blur-2xl
                     border border-white/15 rounded-lg
                     shadow-[0_18px_48px_-12px_rgba(0,0,0,0.85)]
                     py-1"
          style={{ ...popoverStyle, scrollbarWidth: "thin",
                   scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {seasons.map((s) => {
            const isActive    = s === value;
            const isHighlight = s === highlight;
            return (
              <button
                key={s}
                ref={(el) => {
                  if (el) itemsRef.current.set(s, el);
                  else    itemsRef.current.delete(s);
                }}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange(s);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                onMouseEnter={() => setHighlight(s)}
                className={`block w-full text-left px-4 py-2 text-[14px] font-mono tracking-wide
                            truncate transition-colors
                            ${isActive ? "text-ln-accent" : "text-white/85"}
                            ${isHighlight ? "bg-white/10" : "hover:bg-white/8"}`}
                title={extraName(s) ? `${baseLabel(s)} · ${extraName(s)}` : baseLabel(s)}
              >
                {baseLabel(s)}
                {extraName(s) && (
                  <span className={isActive ? "text-ln-accent/70" : "text-white/50"}>
                    {" "}· {extraName(s)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
