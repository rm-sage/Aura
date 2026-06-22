import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    // Remove all default max-width constraints — Aura targets fluid ultrawide layouts.
    maxWidth: {
      none: "none",
      full: "100%",
      screen: "100vw",
    },
    extend: {
      // The default opacity scale only has 5-point steps (5/10/15/.../95/100),
      // so any off-scale modifier like `bg-black/97` or `border-white/8` emits
      // NO css and silently renders transparent (player-overlay submenus showed
      // through; subtle glass borders fell back to the preflight gray hairline).
      // Register every off-scale value the app actually uses so the JIT emits
      // them. Keep this in sync when introducing a new off-scale opacity.
      opacity: {
        2: "0.02",
        3: "0.03",
        4: "0.04",
        6: "0.06",
        8: "0.08",
        12: "0.12",
        14: "0.14",
        16: "0.16",
        18: "0.18",
        72: "0.72",
        82: "0.82",
        92: "0.92",
        93: "0.93",
        96: "0.96",
        97: "0.97",
        98: "0.98",
      },
      colors: {
        // Luminous Neutral — visionOS / Apple TV+ cinematic palette.
        // Solid values for opaque surfaces; glass variants live as CSS vars in App.css.
        ln: {
          void: "#000000",
          base: "#080808",
          raised: "#0f0f0f",
          // CSS-var-backed glass tokens (see App.css) — referenced via arbitrary values.
          // e.g. bg-[var(--ln-glass-1)]
          // Accent is backed by the per-theme `--ln-accent-rgb` triplet so EVERY
          // `ln-accent` utility (text/bg/border/ring/…/opacity) recolours with the
          // active theme. The `<alpha-value>` placeholder lets `/opacity` suffixes
          // (e.g. `bg-ln-accent/15`) keep working. See App.css `:root[data-theme]`.
          accent: "rgb(var(--ln-accent-rgb) / <alpha-value>)",
          "accent-dim": "#3D7FCC",
          text: "#EAEAEA",
          "text-dim": "#8E8E8E",
          "text-ghost": "#4A4A4A",
          "rim-subtle": "#181818",
          "rim-default": "#242424",
          "rim-luminous": "#3D3D3D",
        },
      },
      backdropBlur: {
        glass: "32px",
        heavy: "64px",
      },
      boxShadow: {
        "glass-lift":
          "0 0 0 1px var(--ln-rim-default), 0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
        "glass-edge":
          "0 0 0 1px var(--ln-rim-luminous), 0 16px 48px rgba(0,0,0,0.8)",
        "accent-glow":
          "0 0 24px rgb(var(--ln-accent-rgb) / 0.35), 0 0 8px rgb(var(--ln-accent-rgb) / 0.2)",
      },
      fontFamily: {
        sans: [
          "SF Pro Display",
          "SF Pro Text",
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      transitionTimingFunction: {
        "spatial": "cubic-bezier(0.34, 1.56, 0.64, 1)",
        "cinematic": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
