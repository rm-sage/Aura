// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Custom accent colour: the pure half (no imports, no DOM).
//
// The user can give any theme its own accent (AuraSettings.themeAccents, a map
// theme id -> "#rrggbb"). Everything accent-tinted in the app reads two tokens,
// `--ln-accent` (hex) and `--ln-accent-rgb` (an "r g b" triplet), plus the ink
// token for text ON a solid accent fill, `--ln-accent-ink-rgb`; every other
// accent token (glow, hover, pressed, on-glass label, the glint colour) is a
// CSS derivation of the triplet in App.css. So an override is exactly these
// three custom properties written inline on <html> (src/themeAccent.ts).
//
// This module holds the parsing, validation, colour maths and the token set,
// and is import-free so it runs under node for hand-written checks.
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** Inline custom properties an override writes on <html>. index.html's
 *  pre-paint script applies only names matching ACCENT_VAR_RE. */
export const ACCENT_VAR_NAMES = ["--ln-accent", "--ln-accent-rgb", "--ln-accent-ink-rgb"] as const;
export const ACCENT_VAR_RE = /^--ln-accent(-rgb|-ink-rgb)?$/;

/** At most this many overrides are kept. There are 12 themes today; the
 *  slack keeps the accents of themes a NEWER build adds (synced from it) so
 *  this build does not delete them on its next push, while still bounding a
 *  junk blob. */
export const MAX_THEME_ACCENTS = 32;
/** A theme id as the app spells them ("contrast-azure"). Anything else in a
 *  stored map is dropped. An id this build does not know is KEPT (above) but
 *  never applied: the override is looked up by the active theme only. */
const THEME_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** "#rgb", "#rrggbb" (with or without the #, any case) to "#rrggbb" lower
 *  case; anything else (alpha, names, rgb()) is null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return null;
}

/** A stored / synced / imported map, validated: plain object, theme-id keys,
 *  valid hex values (normalized), at most MAX_THEME_ACCENTS entries. */
export function sanitizeThemeAccents(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_THEME_ACCENTS) break;
    if (!THEME_KEY_RE.test(k)) continue;
    const hex = normalizeHex(v);
    if (!hex) continue;
    out[k] = hex;
    n += 1;
  }
  return out;
}

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex) ?? "#000000";
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/** "91 164 255" (a THEME_SWATCHES / --ln-accent-rgb triplet) to an Rgb. */
export function parseTriplet(s: string): Rgb | null {
  const p = s.trim().split(/[\s,/]+/).map(Number);
  if (p.length < 3 || !p.slice(0, 3).every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) return null;
  return [p[0], p[1], p[2]];
}

/** h in [0, 360), s and v in [0, 1]. */
export interface Hsv { h: number; s: number; v: number }

export function rgbToHsv([r8, g8, b8]: Rgb): Hsv {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x]
      : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** WCAG 2 relative luminance. */
export function luminance(rgb: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

/** Text colour for a SOLID accent fill: black or white, whichever has the
 *  higher contrast (ties go black, which every built-in accent gets: they are
 *  all light, and the old markup hard-coded `text-black`). */
export function inkFor(accent: Rgb): Rgb {
  return contrastRatio(accent, BLACK) >= contrastRatio(accent, WHITE) ? BLACK : WHITE;
}

/** A custom accent at or above this WCAG luminance is "very light": the white
 *  knob of a switch that is on all but vanishes into the accent-filled track,
 *  so the knob takes a dark edge (App.css `html[data-accent-light]`). 0.6 sits
 *  above every built-in accent outside High Contrast (the lightest, Ocean, is
 *  0.53, a white knob 1.8:1 on it raw) and below the two High Contrast accents
 *  (cyan 0.61, gold 0.75), which already needed the same edge on Matte. Near
 *  white (#f5f5f0, 0.91) or a pale yellow (#fff3a0, 0.88) is about 1.1:1. */
export const LIGHT_ACCENT_LUMINANCE = 0.6;

export function isLightAccent(rgb: Rgb): boolean {
  return luminance(rgb) >= LIGHT_ACCENT_LUMINANCE;
}

/** The inline token set for an override. */
export function accentVars(hex: string): Record<(typeof ACCENT_VAR_NAMES)[number], string> {
  const h = normalizeHex(hex) ?? "#000000";
  const rgb = hexToRgb(h);
  return {
    "--ln-accent": h,
    "--ln-accent-rgb": rgb.join(" "),
    "--ln-accent-ink-rgb": inkFor(rgb).join(" "),
  };
}

/** Contrast floor below which the picker WARNS (it never blocks): 3:1, the
 *  WCAG non-text / large-text floor, against the theme's base colour. The High
 *  Contrast themes exist for legibility and their accent also colours small
 *  labels, so there the warning starts below 4.5:1 (the normal-text floor). */
export function accentContrastFloor(highContrast: boolean): number {
  return highContrast ? 4.5 : 3;
}
