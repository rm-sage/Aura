// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ThemeId, AppSettings } from "./types";

// ---------------------------------------------------------------------------
// ThemeEngine
//
// Single source of truth for the active theme. Sets `data-theme` on <html> so
// CSS can scope tokens by theme without per-component logic. Persists the
// choice via the Rust `set_theme` command on each change.
//
// Themes (canonical list — keep in sync with App.css `:root[data-theme=...]`
// blocks and `ThemeId` in `types.ts`):
//   • mica     — Windows 11 native translucent material (default)
//   • glass    — high-translucency frosted, custom CSS only
//   • midnight — pure black, OLED-optimised, no vibrancy
//   • ember    — warm amber on charcoal
//   • forest   — emerald accent on slate
//   • rose     — soft rose on plum-grey
//   • amethyst — violet on indigo-black
//   • ocean    — teal accent on midnight blue
//   • solar    — golden sunburst on warm dark
//   • crimson  — ruby-red accent on dark
//   • contrast — high-contrast: pure black + vivid yellow accent
//   • contrast-azure — high-contrast: pure black + vivid cyan accent
// ---------------------------------------------------------------------------

interface ThemeContext {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  ready: boolean;
}

const Ctx = createContext<ThemeContext>({
  theme: "mica",
  setTheme: () => {},
  ready: false,
});

export const useTheme = () => useContext(Ctx);

export const THEME_LABELS: Record<ThemeId, string> = {
  mica:     "Mica · Windows 11",
  glass:    "Glass · High Translucency",
  midnight: "Midnight · OLED Black",
  ember:    "Ember · Warm Amber",
  forest:   "Forest · Emerald Slate",
  rose:     "Rose · Plum Grey",
  amethyst: "Amethyst · Violet Indigo",
  ocean:    "Ocean · Teal Midnight",
  solar:    "Solar · Sunburst Dark",
  crimson:  "Crimson · Ruby Dark",
  contrast: "High Contrast · Gold",
  "contrast-azure": "High Contrast · Azure",
};

export const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  mica:     "Leverages the native Windows 11 translucent backdrop.",
  glass:    "Custom high-blur frosted layers, more vivid translucency.",
  midnight: "Pure black, high contrast — designed for OLED displays.",
  ember:    "Warm amber accent on charcoal — cosy late-evening palette.",
  forest:   "Emerald accent on deep slate — calm, naturalistic feel.",
  rose:     "Soft rose accent on plum-grey — muted and warm.",
  amethyst: "Violet accent on indigo-black — moody and saturated.",
  ocean:    "Teal accent on midnight blue — cool and crisp.",
  solar:    "Golden sunburst accent on warm dark — bright accent, dim base.",
  crimson:  "Ruby-red accent on a deep dark base — bold and warm.",
  contrast: "Maximum legibility — pure black, white text, vivid gold accent.",
  "contrast-azure": "Maximum legibility — pure black, white text, vivid cyan accent.",
};

const VALID_THEME_IDS: readonly ThemeId[] = [
  "mica", "glass", "midnight",
  "ember", "forest", "rose", "amethyst", "ocean", "solar",
  "crimson", "contrast", "contrast-azure",
];

function isValidThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (VALID_THEME_IDS as readonly string[]).includes(value);
}

const THEME_LS_KEY = "aura:theme";
const ACCENT_LS_KEY = "aura:accent-rgb";

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
  // Persist for the next cold start's pre-paint inline script (index.html) so
  // the app renders in the right theme from the first frame instead of
  // flashing the default until get_settings resolves. Cache the resolved
  // accent triplet too, so the boot splash glow matches the theme.
  try {
    localStorage.setItem(THEME_LS_KEY, theme);
    const rgb = getComputedStyle(document.documentElement)
      .getPropertyValue("--ln-accent-rgb").trim();
    if (rgb) localStorage.setItem(ACCENT_LS_KEY, rgb);
  } catch {
    /* private mode / quota — non-fatal; the flash just returns next cold start */
  }
}

interface Props {
  children: React.ReactNode;
}

export default function ThemeEngine({ children }: Props) {
  const [theme, setThemeState] = useState<ThemeId>("mica");
  const [ready, setReady] = useState(false);

  // Initial load — warm-start from the cached theme so there's no flash while
  // get_settings (which waits on the Rust backend to spin up) is in flight,
  // then reconcile with the authoritative backend value.
  useEffect(() => {
    try {
      const cached = localStorage.getItem(THEME_LS_KEY);
      if (isValidThemeId(cached)) { setThemeState(cached); applyTheme(cached); }
    } catch { /* ignore */ }

    invoke<AppSettings>("get_settings")
      .then((s) => {
        const t: ThemeId = isValidThemeId(s.theme) ? s.theme : "mica";
        setThemeState(t);
        applyTheme(t);
      })
      .catch(() => applyTheme("mica"))
      .finally(() => setReady(true));
  }, []);

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    applyTheme(next);
    invoke("set_theme", { theme: next }).catch(() => {});
  }, []);

  return <Ctx.Provider value={{ theme, setTheme, ready }}>{children}</Ctx.Provider>;
}
