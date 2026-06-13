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
      // Tailwind's default opacity scale jumps in 5-point steps (..85/90/95/100)
      // — `bg-black/97` produced NO css at all so player overlay submenus
      // were rendering with a fully transparent background. Add the
      // intermediate values we actually use so the JIT compiler emits them.
      opacity: {
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
          accent: "#5BA4FF",
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
          "0 0 24px rgba(91, 164, 255, 0.35), 0 0 8px rgba(91, 164, 255, 0.2)",
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
