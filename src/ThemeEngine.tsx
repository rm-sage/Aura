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
// Themes:
//   • mica     — leverages Windows 11 native translucent material (default)
//   • glass    — high-translucency frosted effect, custom CSS only
//   • midnight — high-contrast pure-black, OLED-optimized, no vibrancy
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
  mica: "Mica · Windows 11",
  glass: "Glass · High Translucency",
  midnight: "Midnight · OLED Black",
};

export const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  mica: "Leverages the native Windows 11 translucent backdrop.",
  glass: "Custom high-blur frosted layers, more vivid translucency.",
  midnight: "Pure black, high contrast — designed for OLED displays.",
};

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute("data-theme", theme);
}

interface Props {
  children: React.ReactNode;
}

export default function ThemeEngine({ children }: Props) {
  const [theme, setThemeState] = useState<ThemeId>("mica");
  const [ready, setReady] = useState(false);

  // Initial load — pull from backend, fall back to default if unavailable
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        const t: ThemeId = s.theme === "glass" || s.theme === "midnight" ? s.theme : "mica";
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
