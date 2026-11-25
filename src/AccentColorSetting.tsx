// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// Settings > Theme > "Accent colour": a custom accent for the CURRENT theme.
//
// The value lives in AuraSettings.themeAccents (theme id -> "#rrggbb"), so it
// is portable (PORTABLE_AURA_FIELDS) and cloud-synced with the rest of that
// blob; src/themeAccent.ts draws it. Each theme remembers its own: switching
// theme shows that theme's accent (custom or default).
//
// The picker is a glass popover (.aura-float-glass, portalled to
// document.body): a saturation / brightness square, a hue slider, a hex field,
// the theme's default and suggested swatches. Dragging PREVIEWS through CSS
// variables only (previewAccent: one write per frame, no React state outside
// this popover); releasing COMMITS (one save, one sync push). Keyboard: arrows
// on the square (left / right saturation, up / down brightness) and the hue
// slider, Shift for 10x steps, committed on key release; Enter in the hex
// field. Escape closes (window capture listener, stopped there); a click
// outside closes, except on a context menu or the Performance Monitor.
//
// Contrast: measured against the theme's base colour (THEME_SWATCHES.base).
// Below 3:1 (4.5:1 on the High Contrast themes, whose accent also colours
// small labels) the row and the picker WARN; nothing is blocked. The High
// Contrast themes take a custom accent like any other, and their suggested
// swatches are only those that clear 4.5:1 there.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThemeId } from "./types";
import { THEME_LABELS, THEME_SWATCHES } from "./ThemeEngine";
import {
  accentContrastFloor, contrastRatio, hexToRgb, hsvToRgb, inkFor, normalizeHex,
  parseTriplet, rgbToHex, rgbToHsv, type Hsv, type Rgb,
} from "./accentColor";
import { applyThemeAccent, previewAccent } from "./themeAccent";
import { useGlassState } from "./glassStyle";
import { AdvancedTag } from "./settingsControls";

export const ACCENT_COLOUR_LABEL = "Accent colour";
export const ACCENT_COLOUR_DESCRIPTION =
  "The colour of highlights, selections, progress bars and buttons in the current theme. "
  + "Each theme remembers its own, and it syncs to your other devices.";

const PANEL_W = 288;
const EDGE = 12;
const GAP = 8;

function themeName(theme: ThemeId): string {
  return THEME_LABELS[theme].split(" · ")[0];
}

/** The theme's own accent as "#rrggbb". */
export function themeDefaultAccent(theme: ThemeId): string {
  const t = parseTriplet(THEME_SWATCHES[theme].accent);
  return t ? rgbToHex(t) : "#5ba4ff";
}

function themeBase(theme: ThemeId): Rgb {
  return hexToRgb(THEME_SWATCHES[theme].base);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

const hsvHex = (hsv: Hsv) => rgbToHex(hsvToRgb(hsv));

/** Hex to HSV, keeping `keepHue` when the colour has no hue of its own
 *  (grey, black), so the square does not jump to red. */
function hexHsv(hex: string, keepHue?: number): Hsv {
  const hsv = rgbToHsv(hexToRgb(hex));
  if ((hsv.s === 0 || hsv.v === 0) && keepHue !== undefined) hsv.h = keepHue;
  return hsv;
}

// ---------------------------------------------------------------------------
// The Settings row
// ---------------------------------------------------------------------------

export function AccentColorRow({
  theme, value, onChange,
}: {
  theme: ThemeId;
  /** The stored override for `theme`, or null. */
  value: string | null;
  /** null resets to the theme's own accent. */
  onChange: (hex: string | null) => void;
}) {
  const glass = useGlassState();
  const highContrast = glass.contrastFloor;
  const def = themeDefaultAccent(theme);
  const stored = normalizeHex(value);
  const current = stored ?? def;
  const base = themeBase(theme);
  const floor = accentContrastFloor(highContrast);
  const ratio = contrastRatio(hexToRgb(current), base);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A theme switch while the picker is open: it was editing the old theme.
  useEffect(() => { setOpen(false); }, [theme]);

  const commit = useCallback((hex: string | null) => {
    const n = hex ? normalizeHex(hex) : null;
    const next = n && n !== def ? n : null;
    if (next === stored) {
      // Nothing to save, so no change event will redraw: drop any preview.
      applyThemeAccent();
      return;
    }
    onChange(next);
  }, [def, stored, onChange]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div
      // Wraps the action cluster under the text in a narrow column (a 900 px
      // window leaves the text about 40 px beside both buttons otherwise).
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2"
      data-settings-row=""
      data-settings-label={ACCENT_COLOUR_LABEL}
      data-settings-description={`${ACCENT_COLOUR_DESCRIPTION} Accent color, colour picker, color picker, highlight colour, custom theme colour.`}
    >
      <div className="flex-1 min-w-[12rem]">
        <p className="text-white/75 text-sm font-medium">{ACCENT_COLOUR_LABEL}<AdvancedTag /></p>
        <p className="text-white/35 text-xs mt-0.5">{ACCENT_COLOUR_DESCRIPTION}</p>
        <p className="text-white/45 text-xs mt-1.5 flex items-center gap-1.5 flex-wrap">
          <span>{themeName(theme)} default</span>
          <span aria-hidden className="inline-block w-3 h-3 rounded-full border border-white/20" style={{ background: def }} />
          <span className="font-mono">{def}</span>
          {stored && <span className="text-white/35">(custom colour in use)</span>}
        </p>
        {ratio < floor && (
          <p className="text-amber-300/80 text-xs mt-1.5">
            {contrastWarning(ratio, highContrast)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {stored && (
          <button
            type="button"
            className="aura-glass-flat aura-glass-press rounded-xl px-3 py-2 text-xs text-white/80"
            onClick={() => { setOpen(false); commit(null); }}
          >
            Reset to default
          </button>
        )}
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${ACCENT_COLOUR_LABEL}: ${current}. Change`}
          className="aura-glass-flat aura-glass-press rounded-xl pl-2 pr-3 py-1.5 flex items-center gap-2"
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden className="w-6 h-6 rounded-lg border border-white/25" style={{ background: current }} />
          <span className="font-mono text-xs text-white/80">{current}</span>
        </button>
      </div>
      {open && (
        <AccentPicker
          anchorRef={triggerRef}
          theme={theme}
          committed={current}
          def={def}
          base={base}
          floor={floor}
          highContrast={highContrast}
          onCommit={commit}
          onClose={close}
        />
      )}
    </div>
  );
}

function contrastWarning(ratio: number, highContrast: boolean): string {
  const r = `${ratio.toFixed(1)}:1`;
  return highContrast
    ? `Low contrast for a High Contrast theme (${r}, under 4.5:1): accent labels may be hard to read.`
    : `Low contrast on this theme (${r}, under 3:1): highlights and accent text may be hard to see.`;
}

// ---------------------------------------------------------------------------
// The picker popover
// ---------------------------------------------------------------------------

type Drag = "sv" | "hue" | null;

function AccentPicker({
  anchorRef, theme, committed, def, base, floor, highContrast, onCommit, onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  theme: ThemeId;
  committed: string;
  def: string;
  base: Rgb;
  floor: number;
  highContrast: boolean;
  onCommit: (hex: string | null) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexHsv(committed));
  const hsvRef = useRef(hsv);
  const frame = useRef(0);
  const drag = useRef<{ kind: Drag; rect: DOMRect | null }>({ kind: null, rect: null });
  const [hexText, setHexText] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>({ left: -9999, top: -9999, origin: "50% 0%" });
  const previewed = useRef<string | null>(null);

  const hex = hsvHex(hsv);
  const rgb = hexToRgb(hex);
  const ratio = contrastRatio(rgb, base);
  const ink = inkFor(rgb);

  // ── Placement: under the trigger, right-aligned; above it when there is no
  // room below. Measured before paint, again on resize.
  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!a || !panel) return;
    const h = panel.offsetHeight;
    const left = Math.max(EDGE, Math.min(a.right - PANEL_W, window.innerWidth - PANEL_W - EDGE));
    let top = a.bottom + GAP;
    let above = false;
    if (top + h > window.innerHeight - EDGE && a.top - GAP - h >= EDGE) {
      top = a.top - GAP - h;
      above = true;
    }
    top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));
    const ox = Math.round(a.left + a.width / 2 - left);
    setPos({ left, top, origin: `${ox}px ${above ? "100%" : "0%"}` });
  }, [anchorRef]);
  useLayoutEffect(() => {
    place();
    const onResize = () => place();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [place]);

  // ── Live preview: state and CSS variables at most once per frame.
  const show = useCallback((next: Hsv) => {
    hsvRef.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setHsv(hsvRef.current);
    });
    const h = hsvHex(next);
    previewed.current = h;
    previewAccent(h);
  }, []);
  const commitNow = useCallback(() => {
    onCommit(hsvHex(hsvRef.current));
    previewed.current = null;
  }, [onCommit]);

  // ── Close: Escape (capture, stopped), outside press, a wheel elsewhere.
  // Unmount drops an uncommitted preview (the stored value is redrawn).
  useEffect(() => {
    const returnTo = anchorRef.current;
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (!!panelRef.current?.contains(t) || !!anchorRef.current?.contains(t));
    const exempt = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest("[data-aura-context-menu], [data-perf-monitor]");
    const onDown = (e: PointerEvent) => {
      if (inside(e.target) || exempt(e.target)) return;
      onClose();
    };
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target) && !exempt(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("keydown", onKey, true);
    // The square takes focus so the arrows work at once.
    svRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKey, true);
      if (frame.current) cancelAnimationFrame(frame.current);
      if (previewed.current !== null) applyThemeAccent();
      const active = document.activeElement;
      if (active && panelRef.current?.contains(active) && returnTo?.isConnected) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, [anchorRef, onClose]);

  // ── Pointer: capture on the square / slider, commit on release.
  const fromPointer = (kind: Drag, x: number, y: number) => {
    const r = drag.current.rect;
    if (!r || !kind) return;
    const cur = hsvRef.current;
    if (kind === "sv") {
      show({ h: cur.h, s: clamp01((x - r.left) / r.width), v: 1 - clamp01((y - r.top) / r.height) });
    } else {
      show({ ...cur, h: Math.min(359.9, clamp01((x - r.left) / r.width) * 360) });
    }
  };
  const onPointerDown = (kind: Exclude<Drag, null>) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, rect: e.currentTarget.getBoundingClientRect() };
    setHexText(null);
    fromPointer(kind, e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current.kind) fromPointer(drag.current.kind, e.clientX, e.clientY);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current.kind) return;
    drag.current = { kind: null, rect: null };
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    commitNow();
  };

  // ── Keyboard.
  const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
  const onSvKey = (e: React.KeyboardEvent) => {
    if (!KEYS.includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.01;
    const c = hsvRef.current;
    let { s, v } = c;
    if (e.key === "ArrowLeft") s -= step;
    else if (e.key === "ArrowRight") s += step;
    else if (e.key === "ArrowUp" || e.key === "PageUp") v += e.key === "PageUp" ? 0.1 : step;
    else if (e.key === "ArrowDown" || e.key === "PageDown") v -= e.key === "PageDown" ? 0.1 : step;
    else if (e.key === "Home") s = 0;
    else if (e.key === "End") s = 1;
    setHexText(null);
    show({ h: c.h, s: clamp01(s), v: clamp01(v) });
  };
  const onHueKey = (e: React.KeyboardEvent) => {
    if (!KEYS.includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey || e.key === "PageUp" || e.key === "PageDown" ? 10 : 1;
    const c = hsvRef.current;
    let h = c.h;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown") h -= step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp") h += step;
    else if (e.key === "Home") h = 0;
    else if (e.key === "End") h = 359;
    setHexText(null);
    show({ ...c, h: Math.max(0, Math.min(359.9, h)) });
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (KEYS.includes(e.key) && previewed.current !== null) commitNow();
  };

  // ── Hex field: previews as soon as it parses, commits on Enter or blur.
  const hexShown = hexText ?? hex;
  const onHexChange = (text: string) => {
    setHexText(text);
    const n = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text.trim()) ? normalizeHex(text) : null;
    if (n) show(hexHsv(n, hsvRef.current.h));
  };
  const finishHex = () => {
    const n = hexText !== null ? normalizeHex(hexText) : null;
    setHexText(null);
    if (n && previewed.current !== null) commitNow();
    else if (!n && hexText !== null && previewed.current !== null) {
      // The text stopped parsing after a prefix of it previewed ("#1a2" then
      // "#1a2b"): drop that preview, or the field would show it as if chosen
      // and Done would then snap back to the stored colour.
      const c = hexHsv(committed);
      hsvRef.current = c;
      setHsv(c);
      previewed.current = null;
      applyThemeAccent();
    }
  };

  const pick = (h: string) => {
    setHexText(null);
    show(hexHsv(h, hsvRef.current.h));
    commitNow();
  };

  // Swatches: the theme default first, then every other theme's accent
  // (de-duplicated). On a High Contrast theme only the ones that clear its
  // floor are suggested.
  const swatches: { hex: string; name: string }[] = [{ hex: def, name: `${themeName(theme)} default` }];
  for (const id of Object.keys(THEME_SWATCHES) as ThemeId[]) {
    const t = parseTriplet(THEME_SWATCHES[id].accent);
    if (!t) continue;
    const h = rgbToHex(t);
    if (swatches.some((s) => s.hex === h)) continue;
    if (highContrast && contrastRatio(t, base) < floor) continue;
    swatches.push({ hex: h, name: themeName(id) });
  }

  const hueColour = `hsl(${hsv.h.toFixed(1)} 100% 50%)`;
  const focusRing = "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80";

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${ACCENT_COLOUR_LABEL} for ${themeName(theme)}`}
      className="aura-float-glass aura-glass-pop-in fixed z-[10045] rounded-2xl p-3 flex flex-col gap-3 select-none"
      style={{
        left: pos.left,
        top: pos.top,
        width: PANEL_W,
        maxWidth: "calc(100vw - 24px)",
        "--lg-origin": pos.origin,
      } as React.CSSProperties}
      // App's window keybindings do not check defaultPrevented: keep the
      // arrows and Space here. Function keys go through (F12: DevConsole).
      onKeyDown={(e) => { if (!/^F\d{1,2}$/.test(e.key)) e.stopPropagation(); }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-white/85">{ACCENT_COLOUR_LABEL}</h2>
        <span className="text-[11px] text-white/45">{themeName(theme)} theme</span>
      </div>

      {/* Saturation (x) / brightness (y). A full-range colour field, so its
          gradients step about one code per pixel: no banding to dither. */}
      <div
        ref={svRef}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        className={`relative h-[148px] rounded-xl cursor-crosshair touch-none ${focusRing}`}
        style={{
          background: `linear-gradient(to top, #000, rgb(0 0 0 / 0)), linear-gradient(to right, #fff, ${hueColour})`,
          boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.12)",
        }}
        onPointerDown={onPointerDown("sv")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onSvKey}
        onKeyUp={onKeyUp}
      >
        <span
          aria-hidden
          className="absolute w-4 h-4 rounded-full pointer-events-none"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            translate: "-50% -50%",
            background: hex,
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgb(0 0 0 / 0.35), 0 2px 6px rgb(0 0 0 / 0.45)",
          }}
        />
      </div>

      {/* Hue */}
      <div
        ref={hueRef}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`Hue ${Math.round(hsv.h)} degrees`}
        className={`relative h-3 mx-1.5 rounded-full cursor-pointer touch-none ${focusRing}`}
        style={{
          background: "linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%)",
          boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.12)",
        }}
        onPointerDown={onPointerDown("hue")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onHueKey}
        onKeyUp={onKeyUp}
      >
        <span
          aria-hidden
          className="absolute top-1/2 w-4 h-4 rounded-full pointer-events-none"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            translate: "-50% -50%",
            background: hueColour,
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgb(0 0 0 / 0.35), 0 2px 6px rgb(0 0 0 / 0.45)",
          }}
        />
      </div>

      {/* Preview (accent text on glass, ink on a solid fill) + hex */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="w-9 h-9 rounded-lg flex items-center justify-center text-[13px] font-bold border border-white/20"
          style={{ background: hex, color: `rgb(${ink.join(" ")})` }}
        >
          Aa
        </span>
        <label className="flex-1 min-w-0">
          <span className="sr-only">Hex colour</span>
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            maxLength={7}
            value={hexShown}
            onChange={(e) => onHexChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); finishHex(); }
            }}
            onBlur={finishHex}
            className="aura-glass-field w-full rounded-lg px-3 py-2 font-mono text-xs text-white/90 outline-none"
          />
        </label>
        <span className="text-xs font-semibold" style={{ color: hex }}>Accent</span>
      </div>

      {/* Swatches */}
      <div role="group" aria-label="Suggested colours" className="grid grid-cols-6 gap-2 justify-items-center">
        {swatches.map((s) => (
          <button
            key={s.hex}
            type="button"
            title={`${s.name} ${s.hex}`}
            aria-label={`${s.name} ${s.hex}`}
            aria-pressed={s.hex === hex}
            onClick={() => pick(s.hex)}
            className={`w-7 h-7 rounded-full border ${s.hex === hex ? "border-white" : "border-white/20"} ${focusRing}`}
            style={{
              background: s.hex,
              boxShadow: s.hex === hex ? "0 0 0 2px rgb(0 0 0 / 0.5) inset" : undefined,
            }}
          >
            {s.hex === def && (
              <span aria-hidden className="block w-1.5 h-1.5 mx-auto rounded-full" style={{ background: `rgb(${inkFor(hexToRgb(def)).join(" ")})` }} />
            )}
          </button>
        ))}
      </div>

      <p className={`text-[11px] ${ratio < floor ? "text-amber-300/85" : "text-white/45"}`} aria-live="polite">
        {ratio < floor
          ? contrastWarning(ratio, highContrast)
          : `Contrast ${ratio.toFixed(1)}:1 on the ${themeName(theme)} background.`}
      </p>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={hex === def}
          className="aura-glass-flat aura-glass-press rounded-lg px-3 py-1.5 text-xs text-white/80 disabled:opacity-40"
          onClick={() => pick(def)}
        >
          Reset to default
        </button>
        <button
          type="button"
          // Neutral on purpose: an accent-tinted label here would be the
          // first thing a low-contrast pick makes unreadable.
          className="aura-glass-flat aura-glass-press rounded-lg px-3 py-1.5 text-xs font-semibold text-white/90"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
