// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// playerMenu: the one look for the player's menus.
//
// The Switch source panel and the AuraSkip menu set the standard: a glass card
// with a real title row, 13.5 px rows at 90% white with a rounded hover, an
// accent fill plus a check on the selected row, 11 px section labels at 55%
// white, chips the size of the stream-quality chips and a footer line for
// hints. Every menu docked to the control bar (speed, audio, subtitles,
// upscaler, subtitle style, more, trailer quality) is built from these pieces
// so they read alike and cannot drift apart again; the centred dialogs
// (Switch source, Cast, AuraSkip) share the same type scale. Every docked menu
// that owns its open state calls useMenuEscape, or Esc exits playback under it.
//
// Legibility over video is the point: a docked menu has no scrim, so nothing
// here goes below 55% white for text a user has to read, and nothing below
// 10.5 px.
//
// Glass: every panel is `.aura-glass-player` (App.css GLASS SYSTEM, the A
// face in styles/glass-player.css), the chosen material with no backdrop
// pass, because the video is a native mpv window under the webview and a
// backdrop filter would sample nothing. 18 px corners (12 px rows 6 px in, so
// the corners are concentric, as the rail's). Rows are `.aura-glass-row`
// (selection marked with `is-selected`, never an accent fill; the selected row
// wears the rail's active-pill face and takes the cursor light's rim), under
// one sliding hover droplet per panel in Liquid (useListDroplet), switches
// `ToggleSwitch` (decorative, size sm), buttons `.aura-glass-flat`. Small grey text is white
// 0.6 or more: 4.5:1 over a pure white frame on the 0.86 face.
// ---------------------------------------------------------------------------

import { useEffect, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { useListDroplet } from "./glassListDroplet";
import { ToggleSwitch } from "./settingsControls";

/** Mouse wheel over an open menu scrolls the menu: the overlay's volume-wheel
 *  handler would otherwise take the event. Needs a NON-passive listener, so it
 *  is attached by hand. */
export function useMenuWheelScroll(open: boolean, ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.scrollBy({ top: e.deltaY, behavior: "auto" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, ref]);
}

/** Esc closes an open docked menu. Capture phase, and stopped there: App's
 *  window-level handler would exit playback and the overlay's would leave
 *  fullscreen. `setOpen` is the menu's state setter (stable). Not for the
 *  hover-opened volume slider, which must not eat the key. */
export function useMenuEscape(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);
}

/** A menu docked above its control-bar button. `position` replaces the
 *  default anchor (above the button, right-aligned) when a menu needs another
 *  one; `bodyRef` is the scrolling body (for a non-passive wheel handler). */
export function PlayerMenuPanel({
  title, meta, width, position, maxBodyHeight = "60vh", bodyRef, footer, children, className, style,
  panelRef, onMouseEnter, onMouseLeave,
}: {
  title: ReactNode;
  /** Right side of the title row: a count, the current value, a key hint. */
  meta?: ReactNode;
  /** Tailwind width class, e.g. "w-[340px]". */
  width: string;
  /** Position AND z-index classes (default: above the button, right-aligned,
   *  z-50). */
  position?: string;
  maxBodyHeight?: string;
  bodyRef?: Ref<HTMLDivElement>;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  panelRef?: Ref<HTMLDivElement>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  // Liquid's sliding hover droplet over the body's rows (inert in Frosted).
  const droplet = useListDroplet();
  return (
    <div
      ref={panelRef}
      data-player-menu-panel=""
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // A wheel over the title row or footer must not reach the overlay's
      // window-level volume-wheel handler (the body scrolls on its own).
      onWheel={(e) => e.stopPropagation()}
      className={`${position ?? "absolute bottom-full mb-2 right-0 z-50"} ${width} flex flex-col
                  rounded-[18px] aura-glass-player overflow-hidden ${className ?? ""}`}
      style={style}
    >
      <div className="flex items-center justify-between gap-3 pl-4 pr-3 pt-3 pb-2.5 border-b border-white/8 flex-shrink-0">
        <h3 className="text-white text-[14px] font-semibold tracking-tight truncate">{title}</h3>
        {meta != null && (
          <span className="text-white/60 text-[12px] font-mono tabular-nums flex-shrink-0">{meta}</span>
        )}
      </div>
      <div
        ref={bodyRef}
        className="relative p-1.5 overflow-y-auto overflow-x-hidden"
        style={{
          maxHeight: maxBodyHeight,
          overscrollBehavior: "contain",
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,0.25) transparent",
        }}
        {...droplet.listProps}
      >
        <span ref={droplet.ref} aria-hidden className="aura-glass-hl aura-player-hl" />
        {children}
      </div>
      {footer != null && (
        <div className="px-4 py-2 border-t border-white/8 text-[12px] text-white/60 flex-shrink-0">
          {footer}
        </div>
      )}
    </div>
  );
}

/** A small uppercase label above a group of rows. */
export function PlayerMenuSection({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-white/60 text-[11px] font-semibold uppercase tracking-wider">
      {children}
    </p>
  );
}

export function PlayerMenuDivider() {
  return <div className="my-1.5 mx-2 h-px bg-white/8" aria-hidden />;
}

/** The check shown on the selected row. */
export function MenuCheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** One selectable or actionable row. `selected` marks it the glass way
 *  (Frosted: bright bold label; Liquid: a raised face with the accent on the
 *  icon and label) and shows an accent check (unless `trailing` replaces it);
 *  `description` is a second, dimmer line. */
export function PlayerMenuRow({
  label, description, icon, trailing, selected = false, disabled = false, onClick, title,
  role, ariaChecked, mono = false, onMouseEnter, onMouseLeave, rowRef, ariaHasPopup, ariaExpanded,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  role?: string;
  ariaChecked?: boolean;
  /** Monospace label with tabular figures (speeds, resolutions). */
  mono?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  rowRef?: Ref<HTMLButtonElement>;
  ariaHasPopup?: boolean;
  ariaExpanded?: boolean;
}) {
  // Hover and the selected face come from .aura-glass-row; the selected
  // label colour too (white in Frosted, the accent in Liquid).
  const tone = disabled
    ? "text-white/55 cursor-not-allowed"
    : selected
      ? "is-selected"
      : "text-white/90 hover:text-white";
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      role={role}
      aria-checked={ariaChecked}
      // The selected option of a pick-one list, for assistive tech (the
      // check icon is decorative).
      aria-current={!role && selected ? "true" : undefined}
      aria-haspopup={ariaHasPopup || undefined}
      aria-expanded={ariaExpanded}
      // The selected row is a rim-only light surface (the rail's active pill):
      // the cursor light draws its rim (styles/glass-player.css).
      data-glass-light={selected ? "rim" : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`aura-glass-row w-full text-left rounded-xl px-3 py-2 flex items-center gap-3
                  focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${tone}`}
    >
      {icon && (
        <span className={`flex-shrink-0 ${selected ? "" : disabled ? "text-white/30" : "text-white/70"}`}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={`block text-[13.5px] font-medium leading-snug break-words
                          ${mono ? "font-mono tabular-nums" : ""}`}>
          {label}
        </span>
        {description && (
          <span className={`block text-[12px] leading-snug mt-0.5
                            ${selected ? "opacity-75" : disabled ? "text-white/45" : "text-white/60"}`}>
            {description}
          </span>
        )}
      </span>
      {trailing ?? (selected && <span className="flex-shrink-0 text-ln-accent"><MenuCheckIcon /></span>)}
    </button>
  );
}

/** An on / off row with a switch, for settings mirrored into the player. */
export function PlayerMenuToggle({
  label, icon, on, onToggle, disabled = false, title,
}: {
  label: ReactNode;
  icon?: ReactNode;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <PlayerMenuRow
      label={label}
      icon={icon}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      role="switch"
      ariaChecked={on && !disabled}
      trailing={
        // The shared glass switch, decorative (the row carries the switch
        // role, the click and the keyboard). Material only like the rest of
        // the player (the track has no backdrop pass); the cursor light still
        // rings it.
        <ToggleSwitch decorative size="sm" value={on && !disabled} />
      }
    />
  );
}

type ChipTone = "neutral" | "accent" | "good";
const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-white/6 text-white/80 border-white/14",
  accent:  "bg-ln-accent/15 text-ln-accent border-ln-accent/30",
  // A suggestion, kept apart from the accent that marks the selection.
  good:    "bg-emerald-400/12 text-emerald-200 border-emerald-300/30",
};

/** A small tag, the size and shape of the stream-quality chips. */
export function PlayerMenuChip({ tone = "neutral", children, title, className, style }: {
  tone?: ChipTone; children: ReactNode; title?: string; className?: string; style?: CSSProperties;
}) {
  return (
    <span
      title={title}
      className={`inline-block px-1.5 py-[1px] rounded border text-[10.5px] font-medium tracking-wide
                  font-mono ${CHIP_TONES[tone]} ${className ?? ""}`}
      style={style}
    >
      {children}
    </span>
  );
}

/** A compact secondary button inside a menu (nudges, resets). */
export function PlayerMenuButton({
  children, onClick, disabled = false, accent = false, className, title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`aura-glass-flat h-8 px-2.5 rounded-lg text-[12.5px] font-medium active:scale-95
                  disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100
                  ${accent ? "is-primary" : "text-white/90 hover:text-white"}
                  ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** A labelled slider row on the shared `aura-slider` track. */
export function PlayerMenuSlider({
  label, value, min, max, step = 1, display, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** The value as shown (defaults to the number). */
  display?: ReactNode;
  onChange: (v: number) => void;
}) {
  const span = Math.max(1e-9, max - min);
  const frac = Math.max(0, Math.min(1, (value - min) / span));
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-white/85 text-[13px]">{label}</span>
        <span className="text-white/70 text-[12px] font-mono tabular-nums">{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="aura-slider w-full"
        style={{
          ["--val" as never]:      `${(frac * 100).toFixed(2)}%`,
          ["--val-frac" as never]: frac.toFixed(3),
        }}
      />
    </div>
  );
}
