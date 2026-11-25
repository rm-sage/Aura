// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Settings row controls, shared by SettingsView and the first-run setup so the
// two cannot drift apart. Every row keeps data-settings-row /
// data-settings-label / data-settings-description on its outermost element:
// the Settings search walks those attributes (see SettingsView's "Advanced
// settings" block comment).
//
// They are also the template for the glass system (App.css "GLASS SYSTEM"):
// buttons and selects are .aura-glass-flat, text inputs .aura-glass-field, the
// switch .aura-glass-toggle / .aura-glass-knob (ToggleSwitch, a rim-lit
// track; every switch in the app, decorative inside a role=switch row), the
// segmented control a rim-lit field-tier track with ONE sliding raised thumb
// (.aura-glass-seg-ind.aura-seg-thumb) on the --lg-springy spring (round 12).
// Both tracks and the thumb are cursor-light rim surfaces
// (data-glass-light="rim"). Frosted or Liquid is chosen by <html data-glass>,
// never here.
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef } from "react";
import { useGlassStyle } from "./glassStyle";

/** True inside a unit that is on screen only because of a search or a deep
 *  link, so its rows carry the "Advanced" tag. SettingsView's AdvancedOnly
 *  provides it; the default is false, so outside Settings no tag shows. */
export const AdvancedMarkContext = createContext(false);

export function AdvancedPill() {
  return (
    <span className="ml-2 inline-block align-middle px-1.5 py-0.5 rounded leading-none
                     text-[9px] font-mono font-medium uppercase tracking-wider
                     bg-ln-accent/15 text-ln-accent/90 border border-ln-accent/30">
      Advanced
    </span>
  );
}

/** Goes inline after a row's label: the "Advanced" tag while the row's unit
 *  is on screen only because of a search or a deep link, else nothing. */
export function AdvancedTag() {
  return useContext(AdvancedMarkContext) ? <AdvancedPill /> : null;
}

/** Track and knob per size (2 px inset). The knob travels 16 px on md and sm
 *  (App.css), 14 px on xs (`aura-toggle-xs`, glass-misc.css). */
const TOGGLE_SIZES = {
  /** 40 x 24: a Settings row. */
  md: { track: "w-10 h-6", knob: "w-5 h-5" },
  /** 36 x 20: a menu row (the player menus, the Detail stream formatting popover). */
  sm: { track: "w-9 h-5", knob: "w-4 h-4" },
  /** 32 x 18: a compact popover row or a pill (Library, Queue, the filter menu). */
  xs: { track: "aura-toggle-xs w-8 h-[18px]", knob: "w-[14px] h-[14px]" },
} as const;

export type ToggleSwitchSize = keyof typeof TOGGLE_SIZES;

type ToggleSwitchProps = {
  value: boolean;
  /** md (Settings, the default), sm (a menu row) or xs (a compact row or pill). */
  size?: ToggleSwitchSize;
  /** Extra layout classes for the track (margins). */
  className?: string;
} & (
  | {
      /** A real switch: a button with role="switch". */
      decorative?: false;
      onChange: (v: boolean) => void;
      disabled?: boolean;
      /** For a switch with no visible label beside it in a <label>. */
      ariaLabel?: string;
      /** Id of the element that describes the switch (a row's description). */
      ariaDescribedBy?: string;
    }
  | {
      /** Drawn inside a control that already carries role="switch" and
       *  aria-checked (a menu row, a pill): an aria-hidden span, so roles are
       *  never nested. The owner takes the click and the keyboard; its
       *  keyboard focus rings this track (App.css
       *  `[role="switch"]:focus-visible > .aura-toggle-deco`). */
      decorative: true;
      onChange?: never;
      disabled?: never;
      ariaLabel?: never;
      ariaDescribedBy?: never;
    }
);

/** The glass switch, the ONE switch in the app: SettingToggle's control, the
 *  Settings page's own "Show advanced settings" switch, and (decorative) the
 *  switch inside every role="switch" row or pill elsewhere (the filter menu's
 *  airing row, Library's auto-remove rows, Queue's pill, the Detail stream
 *  formatting row, the player menus' rows), so none can drift apart. In
 *  Liquid the knob stretches toward where it is going and settles (CSS
 *  keyframes; off under reduced motion). The track is a cursor-light rim
 *  surface (data-glass-light="rim", App.css "Toggle switch"): the light
 *  catches its rim like any glass edge, over the video too (material only:
 *  the track has no backdrop pass); the knob is a glass bead. On keeps the
 *  accent fill. */
export function ToggleSwitch(props: ToggleSwitchProps) {
  const { value, size = "md", className = "" } = props;
  const knobRef = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    const knob = knobRef.current;
    if (!knob) return;
    // Restart the stretch: drop the class, force one style flush, add it back.
    // The CSS only animates it in Liquid without reduced motion.
    knob.classList.remove("is-stretching");
    knob.style.transformOrigin = value ? "right center" : "left center";
    void knob.offsetWidth;
    knob.classList.add("is-stretching");
  }, [value]);
  const dims = TOGGLE_SIZES[size];
  const knob = (
    <span
      ref={knobRef}
      aria-hidden
      className={`aura-glass-knob absolute top-0.5 left-0.5 rounded-full ${dims.knob}`}
      onAnimationEnd={(e) => e.currentTarget.classList.remove("is-stretching")}
    />
  );
  if (props.decorative) {
    return (
      <span
        aria-hidden
        // Not a role: the CSS reads the state from aria-checked (App.css
        // .aura-glass-toggle), and aria-hidden keeps it out of the tree.
        aria-checked={value}
        data-glass-light="rim"
        className={`aura-glass-toggle aura-toggle-deco relative flex-shrink-0 rounded-full ${dims.track} ${className}`}
      >
        {knob}
      </span>
    );
  }
  const { onChange, disabled = false, ariaLabel, ariaDescribedBy } = props;
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onChange(!value); }}
      disabled={disabled}
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-glass-light="rim"
      // Keyboard focus is an outline in App.css (.aura-glass-toggle:focus-visible):
      // a focus-visible:ring utility lost to the Liquid track's and the High
      // Contrast floor's box-shadow, so it never showed there.
      className={`aura-glass-toggle relative rounded-full flex-shrink-0
                  disabled:cursor-default ${dims.track} ${className}`}
    >
      {knob}
    </button>
  );
}

interface DropdownProps {
  label: string;
  description: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  required?: boolean;
  disabled?: boolean;
  /** Optional badge rendered after the label (e.g., "Managed by AIOMetadata"). */
  badge?: React.ReactNode;
}

export function SettingDropdown({
  label, description, value, options, onChange, required, disabled, badge,
}: DropdownProps) {
  // The visible label is a bare <p>: name the control explicitly (aria-label,
  // not aria-labelledby, so the "Advanced" tag inside the label is not read).
  const descId = useId();
  return (
    <div
      className={`space-y-2 ${disabled ? "opacity-40" : ""}`}
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div>
        <div className="flex items-center gap-2">
          <p className="text-white/75 text-sm font-medium">{label}<AdvancedTag /></p>
          {badge}
        </div>
        <p id={descId} className="text-white/55 text-xs mt-0.5">{description}</p>
      </div>
      <select
        aria-label={label}
        aria-describedby={descId}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className={`aura-glass-flat aura-glass-select w-full rounded-xl px-4 py-2.5
                   text-sm outline-none appearance-none
                   ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        style={{ color: "var(--text-primary)" }}
      >
        {!required && <option value="">System default</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ToggleProps {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
  /** Greys the row out and refuses input - for a toggle whose parent switch is
   *  off, where flipping it would mean nothing. */
  disabled?: boolean;
}

export function SettingToggle({ label, description, value, onChange, disabled = false }: ToggleProps) {
  const descId = useId();
  return (
    <div
      className={`flex items-center justify-between gap-4 ${disabled ? "opacity-40" : ""}`}
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}<AdvancedTag /></p>
        <p id={descId} className="text-white/55 text-xs mt-0.5">{description}</p>
      </div>
      <ToggleSwitch
        value={value}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
        ariaDescribedBy={descId}
      />
    </div>
  );
}

/** Settings that only refine the row directly above them (a parent switch,
 *  dropdown or key), indented under it in one box instead of standing as
 *  peers. Each child keeps its own data-settings-* attributes, so search
 *  finds it like any row. Put a divider between two children; an advanced
 *  child goes in its own <AdvancedOnly> inside the box, and a box whose
 *  children are ALL advanced goes inside one <AdvancedOnly> so no empty box
 *  is left when they hide. */
export function AttachedSettings({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-5 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5 space-y-3">
      {children}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Inert (shown, not pickable): an option still loading, say. */
  disabled?: boolean;
  /** A small glyph before the label (a spinner while `disabled`). */
  adornment?: React.ReactNode;
  title?: string;
  busy?: boolean;
}

/** The segmented selector (round 12): a rim-lit field-tier track holding ONE
 *  raised glass thumb that slides under the selected option on the
 *  --lg-springy spring (CSS translate + width transitions on
 *  `.aura-seg-thumb`, both materials; reduced motion snaps it), with a short
 *  squash-and-settle in Liquid. Concentric A radii: md track 12 / padding 3 /
 *  thumb 9, sm 10 / 2 / 8. The track and the thumb are cursor-light rim
 *  surfaces (data-glass-light="rim"). Selected label white, the rest white
 *  0.62; the accent is only a faint tinted rim on the thumb.
 *
 *  A radiogroup with a roving tab stop: Tab lands on the selected option, the
 *  arrow keys (and Home / End) move AND select, skipping disabled options.
 *  `value` matching no option selects no segment (the first enabled option
 *  is then the tab stop). Shared by every segmented control (Settings, the
 *  episode grouping toggle, Airing, Live, the playlist form, onboarding, the
 *  AuraSkip menu's skip modes over the video), so selection reads the same
 *  everywhere. Inside a `.aura-glass-player` surface it needs nothing extra:
 *  it is material only (no backdrop pass) and glass-player.css gives its
 *  labels the player's colours (idle white 0.62, Liquid selected in the lit
 *  colour). `fill`: full width, equal segments. */
export function SegmentedControl<T extends string>({
  value, options, onChange, ariaLabel, size = "md", fill = false, className = "",
}: {
  value: T | null;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  /** "sm": the compact 24 px height of a list header. */
  size?: "md" | "sm";
  /** Stretch to the parent's width with equal segments (a tab pair). */
  fill?: boolean;
  /** Extra layout classes for the group (margins, alignment). */
  className?: string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const glass = useGlassStyle();
  const shown = useRef(false);
  const last = useRef<{ x: number; w: number } | null>(null);

  // Measures the selected segment (offsetLeft / offsetWidth, on a value or
  // material change, or a resize) and moves the thumb there: inline
  // `translate` + `width`, which the CSS transition springs. The first
  // placement, a resize and any placement after the thumb was hidden SNAP
  // (transition off for one style flush).
  const place = useRef((snap: boolean) => {
    const group = groupRef.current, thumb = thumbRef.current;
    if (!group || !thumb) return;
    const btn = group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!btn || btn.offsetWidth === 0) {
      thumb.style.opacity = "0";
      shown.current = false;
      last.current = null;
      return;
    }
    const x = btn.offsetLeft, w = btn.offsetWidth;
    const prev = last.current;
    if (shown.current && prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.w - w) < 0.5) return;
    const jump = snap || !shown.current || !prev;
    if (jump) thumb.style.transition = "none";
    thumb.style.translate = `${x}px 0`;
    thumb.style.width = `${w}px`;
    thumb.style.opacity = "";
    if (jump) {
      void thumb.offsetWidth;
      thumb.style.transition = "";
    } else {
      // The squash-and-settle (Liquid only, off under reduced motion: CSS).
      thumb.classList.remove("is-stretching");
      void thumb.offsetWidth;
      thumb.classList.add("is-stretching");
    }
    last.current = { x, w };
    shown.current = true;
  });

  // The option list is part of the key: an option added, removed or
  // reordered while `value` stays put moves the selected button, and with
  // `fill` (equal segments, the group's width set by its parent) the group
  // does not resize, so the ResizeObserver below would never see it.
  const optionsKey = options.map((o) => o.value).join("|");
  useLayoutEffect(() => { place.current(false); }, [value, glass, optionsKey]);

  // Re-snap when the control's own size changes (a font load, a label change).
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const ro = new ResizeObserver(() => place.current(true));
    ro.observe(group);
    return () => ro.disconnect();
  }, []);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const firstEnabled = options.findIndex((o) => !o.disabled);
  const tabStop = selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : firstEnabled;
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    let step = 0, from = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") step = 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step = -1;
    else if (e.key === "Home") { step = 1; from = -1; }
    else if (e.key === "End") { step = -1; from = n; }
    else return;
    e.preventDefault();
    // App's window keybindings ignore defaultPrevented: without this an arrow
    // on a copy over the player would also seek or change the volume.
    e.stopPropagation();
    for (let k = 1; k <= n; k++) {
      const j = (((from + step * k) % n) + n) % n;
      if (options[j].disabled) continue;
      groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[j]?.focus();
      if (options[j].value !== value) onChange(options[j].value);
      return;
    }
  };

  const sm = size === "sm";
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      data-glass-light="rim"
      className={`aura-glass-seg gap-0.5 ${fill ? "flex w-full" : "inline-flex flex-shrink-0"}
                  ${sm ? "p-[2px] rounded-[10px]" : "p-[3px] rounded-[12px]"} ${className}`}
      style={{ ["--seg-pad" as never]: sm ? "2px" : "3px", ["--seg-thumb-r" as never]: sm ? "8px" : "9px" }}
    >
      <span
        ref={thumbRef}
        aria-hidden
        data-glass-light="rim"
        className="aura-glass-seg-ind aura-seg-thumb"
        style={{ opacity: 0 }}
        onAnimationEnd={(e) => e.currentTarget.classList.remove("is-stretching")}
      />
      {options.map((o, i) => {
        const active = i === selectedIndex;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-busy={o.busy || undefined}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => { if (!o.disabled) onChange(o.value); }}
            onKeyDown={(e) => onKey(e, i)}
            className={`aura-glass-seg-btn font-medium tracking-wide inline-flex items-center justify-center gap-1
                       whitespace-nowrap disabled:cursor-default disabled:opacity-60
                       ${sm ? "px-2.5 h-6 text-[11px] rounded-[8px]" : "px-3 h-[26px] text-[11.5px] rounded-[9px]"}
                       ${fill ? "flex-1" : ""}`}
          >
            {o.adornment}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Small secondary text after the label (a technical term, say). */
  hint?: string;
  /** Trailing tags (a Recommended chip). Decorative to the radio itself:
   *  its text is part of the option's accessible name. */
  tags?: React.ReactNode;
}

/** A stacked radio choice: one bordered row per option, which (unlike a
 *  native <select>) can carry a styled tag. role=radiogroup / radio with a
 *  roving tab stop: Tab lands on the selected option, the arrow keys (and
 *  Home / End) move AND select, Space / Enter selects the focused one. A
 *  `value` matching no option leaves the first option as the tab stop. */
export function ChoiceList<T extends string>({
  value, options, onChange, ariaLabel, ariaDescribedBy, disabled = false,
}: {
  value: T | null;
  options: ChoiceOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;
  const move = (from: number, delta: number | "first" | "last", group: HTMLElement | null) => {
    if (options.length === 0) return;
    const next = delta === "first" ? 0
      : delta === "last" ? options.length - 1
      : (from + delta + options.length) % options.length;
    const el = group?.querySelectorAll<HTMLElement>("[role=radio]")[next];
    el?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-disabled={disabled || undefined}
      className={`aura-content-group ${disabled ? "opacity-40 pointer-events-none" : ""}`}
    >
      {options.map((o, i) => {
        const active = i === selectedIndex;
        return (
          <div
            key={o.value}
            role="radio"
            aria-checked={active}
            tabIndex={disabled ? -1 : i === tabStop ? 0 : -1}
            onClick={() => { if (!active) onChange(o.value); }}
            onKeyDown={(e) => {
              const group = e.currentTarget.parentElement;
              if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); move(i, 1, group); }
              else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); move(i, -1, group); }
              else if (e.key === "Home") { e.preventDefault(); move(i, "first", group); }
              else if (e.key === "End") { e.preventDefault(); move(i, "last", group); }
              else if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                if (!active) onChange(o.value);
              }
            }}
            className="aura-content-row flex items-center gap-3 px-3.5 py-2.5 cursor-pointer select-none"
          >
            <span
              aria-hidden
              className={`flex-shrink-0 h-4 w-4 rounded-full border flex items-center justify-center
                          ${active ? "border-[color:var(--ln-accent-mark)]" : "border-white/30"}`}
            >
              {active && <span className="h-2 w-2 rounded-full bg-[var(--ln-accent-mark)]" />}
            </span>
            <span className="flex-1 min-w-0 text-sm">
              <span className={`aura-glass-choice-label ${active ? "text-white/90" : "text-white/75"}`}>{o.label}</span>
              {o.hint && <span className="ml-2 text-white/40 text-xs">{o.hint}</span>}
            </span>
            {o.tags && <span className="flex-shrink-0 flex items-center gap-1.5">{o.tags}</span>}
          </div>
        );
      })}
    </div>
  );
}

interface TextInputProps {
  label: string;
  description: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
  /** Return "valid" | "invalid" | null (empty value → no indicator). */
  validate?: (v: string) => "valid" | "invalid" | null;
  validationHint?: string;
}

export function SettingText({
  label, description, value, placeholder, onChange, disabled, badge,
  validate, validationHint,
}: TextInputProps) {
  const validState = validate && value.length > 0 ? validate(value) : null;
  const descId = useId();
  return (
    <div
      className={`space-y-2 ${disabled ? "opacity-40" : ""}`}
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex items-center gap-2">
        <p className="text-white/75 text-sm font-medium">{label}<AdvancedTag /></p>
        {badge}
      </div>
      <p id={descId} className="text-white/55 text-xs -mt-1">{description}</p>
      <div className="relative">
        <input
          type="text"
          aria-label={label}
          aria-describedby={descId}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`aura-glass-field w-full rounded-xl px-4 py-2.5
                      text-sm font-mono placeholder:text-white/25 outline-none
                      ${validate ? "pr-9" : ""}
                      ${validState === "valid" ? "is-valid" : validState === "invalid" ? "is-invalid" : ""}
                      ${disabled ? "cursor-not-allowed" : ""}`}
          style={{ color: "var(--text-primary)" }}
        />
        {validState && (
          <span
            aria-hidden
            className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold
                         pointer-events-none select-none
                         ${validState === "valid" ? "text-emerald-400" : "text-red-400"}`}
          >
            {validState === "valid" ? "✓" : "✗"}
          </span>
        )}
      </div>
      {validState === "invalid" && validationHint && (
        <p className="text-red-400/70 text-xs">{validationHint}</p>
      )}
    </div>
  );
}
