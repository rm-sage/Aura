// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Custom accent colour: the runtime half.
//
// The ONE place the active override is written to the document. The stored
// map (AuraSettings.themeAccents) is portable and cloud-synced; what is drawn
// is the entry for the theme on <html data-theme>, written as inline custom
// properties on <html> (they beat every `:root[data-theme]` block), or none.
//
//   - applyThemeAccent(theme): the committed value. Called by ThemeEngine's
//     applyTheme (before it caches the splash accent), at install, and on any
//     `aura:settings-changed` that names themeAccents (a pick, a reset, an
//     import, a cloud pull).
//   - previewAccent(hex): the picker's live drag. CSS variables only, at most
//     one write per frame, nothing saved, no React state outside the picker.
//
// Cold start: index.html's pre-paint script applies the `aura:accent-vars`
// cache (written here) when its theme matches `aura:theme`, so the first frame
// already has the custom accent, and `aura:accent-rgb` (the boot splash glow)
// is refreshed from the computed value after every apply.
//
// Accent-keyed caches follow without help: the glint (glassGlint.ts) resolves
// `--lg-glint-c` on every enter and keys its images by the resolved colour,
// toasts read `--ln-accent-rgb` when a bump starts, the History heat map when
// it opens. `aura:accent-changed` is dispatched after every apply and preview
// for anything that wants to re-read sooner.
// ---------------------------------------------------------------------------

import { ACCENT_VAR_NAMES, accentVars, hexToRgb, isLightAccent, normalizeHex } from "./accentColor";
import { loadAuraSettings } from "./auraSettings";

/** Pre-paint cache: `{ t: themeId, v: { "--ln-accent": ..., ... }, l?: 1 }`
 *  (`l`: a very light accent, see LIGHT_ACCENT_ATTR). Device local, derived;
 *  never synced. */
export const ACCENT_VARS_KEY = "aura:accent-vars";
/** The boot splash's accent triplet (index.html, ThemeEngine). */
const SPLASH_ACCENT_KEY = "aura:accent-rgb";
export const ACCENT_CHANGED_EVENT = "aura:accent-changed";
/** On <html> while a very light CUSTOM accent is drawn (isLightAccent): a
 *  switch's white knob takes a dark edge (App.css). Never set for a theme's
 *  own accent, so every built-in look is untouched. index.html's pre-paint
 *  script sets it from the cache's `l` flag. */
const LIGHT_ACCENT_ATTR = "data-accent-light";

function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") || "mica";
}

function writeVars(hex: string | null): void {
  const root = document.documentElement;
  const style = root.style;
  if (!hex) {
    for (const name of ACCENT_VAR_NAMES) style.removeProperty(name);
    root.removeAttribute(LIGHT_ACCENT_ATTR);
    return;
  }
  const vars = accentVars(hex);
  for (const name of ACCENT_VAR_NAMES) style.setProperty(name, vars[name]);
  if (isLightAccent(hexToRgb(hex))) root.setAttribute(LIGHT_ACCENT_ATTR, "");
  else root.removeAttribute(LIGHT_ACCENT_ATTR);
}

let previewRaf = 0;
let previewHex: string | null = null;

function cancelPreview(): void {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  previewRaf = 0;
}

/** The override stored for `theme`, or null for the theme's own accent. */
export function storedAccentFor(theme: string): string | null {
  return normalizeHex(loadAuraSettings().themeAccents[theme]);
}

/** Draw the committed accent for `theme` (default: the active one). */
export function applyThemeAccent(theme: string = currentTheme()): void {
  if (typeof document === "undefined") return;
  cancelPreview();
  const hex = storedAccentFor(theme);
  writeVars(hex);
  try {
    if (hex) {
      const entry: { t: string; v: Record<string, string>; l?: 1 } = { t: theme, v: accentVars(hex) };
      if (isLightAccent(hexToRgb(hex))) entry.l = 1;
      localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(entry));
    } else {
      localStorage.removeItem(ACCENT_VARS_KEY);
    }
    // Only when the theme is the drawn one: ThemeEngine calls this right
    // after stamping data-theme, so the computed triplet is the new one.
    if (theme === currentTheme()) {
      const rgb = getComputedStyle(document.documentElement).getPropertyValue("--ln-accent-rgb").trim();
      if (rgb) localStorage.setItem(SPLASH_ACCENT_KEY, rgb);
    }
  } catch { /* storage blocked: only the cold-start flash returns */ }
  window.dispatchEvent(new CustomEvent(ACCENT_CHANGED_EVENT, { detail: { preview: false } }));
}

/** Live preview while the picker is dragged: `hex` drawn on the next frame
 *  (coalesced), `null` previews the theme's own accent. Never saved; the
 *  picker commits on release, and closing it re-applies the stored value. */
export function previewAccent(hex: string | null): void {
  if (typeof document === "undefined") return;
  previewHex = hex ? normalizeHex(hex) : null;
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    writeVars(previewHex);
    window.dispatchEvent(new CustomEvent(ACCENT_CHANGED_EVENT, { detail: { preview: true } }));
  });
}

/** Before React mounts (main.tsx): draw the stored accent and follow every
 *  change to the map. Returns its cleanup (hot reload). */
export function installThemeAccent(): () => void {
  if (typeof window === "undefined") return () => {};
  applyThemeAccent();
  const onSettings = (e: Event) => {
    const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
    if (Array.isArray(keys) && !keys.includes("themeAccents")) return;
    applyThemeAccent();
  };
  window.addEventListener("aura:settings-changed", onSettings);
  return () => {
    window.removeEventListener("aura:settings-changed", onSettings);
    cancelPreview();
  };
}
