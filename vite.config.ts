import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Read package.json once at config time so VITE_APP_VERSION can tag
// Sentry releases (and any future telemetry) without each component
// having to import package.json directly. Falls back to "0.0.0" if
// the file ever moves; the fallback isn't shipped in production
// because the path is stable in this repo.
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // ── Sentry source map upload ────────────────────────────────────────────
  // The plugin runs only when (a) SENTRY_AUTH_TOKEN, SENTRY_ORG, and
  // SENTRY_PROJECT are all present, and (b) we're building (not serving
  // dev). All three live in `.env.local` (gitignored) — see `.env.example`
  // for the full key list. In dev, or when any var is missing, the plugin
  // is omitted entirely so `pnpm dev` and `pnpm build` keep working
  // offline / on a fresh clone with no Sentry creds.
  //
  // Source maps land in `dist/assets/*.map` during production build, get
  // uploaded to Sentry, then deleted from `dist/` so the final installer
  // never ships them to end users. The bundle keeps `sourcemap: 'hidden'`
  // so JS files have NO `//# sourceMappingURL=` comment — even if a user
  // tried to inspect the bundle they'd find no map references.
  //
  // `loadEnv(mode, cwd, "")` reads every var from .env / .env.local / .env.[mode]
  // (the empty prefix tells Vite "give me ALL env vars, not just VITE_*").
  const env = loadEnv(mode, process.cwd(), "");
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN ?? "";
  const sentryOrg       = env.SENTRY_ORG ?? "";
  const sentryProject   = env.SENTRY_PROJECT ?? "";
  // EU customers (DSN ending `*.ingest.de.sentry.io`) point this at
  // https://de.sentry.io/. Default sentry.io is the US region.
  const sentryUrl       = env.SENTRY_URL ?? "https://sentry.io/";

  const plugins: PluginOption[] = [react()];
  const sentryEnabled =
    mode === "production" &&
    sentryAuthToken !== "" &&
    sentryOrg !== "" &&
    sentryProject !== "";
  if (sentryEnabled) {
    plugins.push(
      sentryVitePlugin({
        authToken: sentryAuthToken,
        org: sentryOrg,
        project: sentryProject,
        url: sentryUrl,
        // Tag uploaded artifacts with the Aura version so Sentry can group
        // events by release. Matches `release:` in main.tsx::Sentry.init.
        release: { name: pkgVersion },
        sourcemaps: {
          // Strip maps from the output bundle after upload. Sentry has
          // them; end users don't need them — keeps the installer small
          // and the JS un-deobfuscatable in the field.
          filesToDeleteAfterUpload: ["./dist/assets/*.map"],
        },
        // `silent: false` so build output shows the upload step happening.
        // Flip to true once the integration is verified if the noise
        // bothers you.
        silent: false,
      }),
    );
  }
  return ({
  plugins,
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkgVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri ships with WebView2 (Chromium) on Windows, WKWebView on macOS, and
    // WebKitGTK on Linux — all evergreen. We can target modern syntax without
    // any transpile cost.
    target: "esnext",
    minify: "esbuild",
    // `'hidden'` produces source maps but omits the
    // `//# sourceMappingURL=…` comment from the JS bundle, so end users
    // can't load them in dev tools or download them by guessing the
    // filename. The Sentry vite plugin (when enabled) finds them by
    // their on-disk path, uploads to Sentry, and deletes them from
    // dist/ afterwards — see the `sentryVitePlugin(...)` block above.
    // When the plugin is disabled (no Sentry creds), the maps are
    // generated but never shipped because the Tauri bundler only
    // packages files referenced by index.html.
    sourcemap: "hidden",
    // Hand-tuned chunk split: React + react-dom split out so the framework
    // bundle stays cacheable across app updates. Tauri's IPC SDK is small
    // and tightly coupled to app code, so we leave it inline.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
    // Bumped warning threshold — the main app bundle clears 500 KB
    // minified before vendor split, which is reasonable for a
    // feature-rich SPA but would otherwise trip Vite's default warning
    // every build.
    chunkSizeWarningLimit: 600,
  },
  esbuild: {
    // CRITICAL: don't drop console.* in production. The F12 DevConsole
    // intercepts console.log/info/warn/error/debug at runtime (see
    // src/DevConsole.tsx) so users can capture diagnostics into bug
    // reports without dev-tooling experience. Stripping here would
    // silently kill that surface. `debugger` statements are still
    // dropped — those should never ship.
    drop: ["debugger"],
  },
  });
});