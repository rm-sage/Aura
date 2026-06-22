# Production prep checklist

This file tracks the production-release-readiness items the user opted
into. Items marked **[done]** are wired up in code; **[needs setup]**
items require external infra / secrets that aren't checked in.

---

## Done

- **CSP** — `tauri.conf.json:security.csp` set to a strict-but-Aura-aware
  policy. Allows `https:` for image / stream / connect (addons live on
  arbitrary HTTPS hosts), `http://127.0.0.1:*` for the local streaming
  bridge, `tauri:` + `ipc:` for Tauri's IPC channel, `'unsafe-inline'`
  for Tailwind's runtime style insertion. `frame-src 'none'` /
  `object-src 'none'` / `form-action 'none'` lock down the obvious XSS
  surfaces. Test extensively before shipping — a wrong CSP silently
  breaks images / streams.

- **Vite production build** — `target: "esnext"`, `sourcemap: false`,
  manual vendor chunk for React, `drop: ["debugger"]` on esbuild.
  `console.*` is intentionally NOT dropped — the F12 DevConsole
  intercepts it for user-visible diagnostics.

- **Bundle analyzer** — `pnpm build:analyze` runs the post-build
  `scripts/bundle-report.cjs` walker. Lists per-file sizes with soft
  600 KB warning threshold (matches vite.config.ts `chunkSizeWarningLimit`).

- **Rust panic hook** — `src/lib.rs::run` sets a panic hook before any
  Tauri builder runs. Captures every panic to `%USERPROFILE%\aura-panic.log`
  with thread, location, message, and a forced backtrace. Appends rather
  than truncates so the file accumulates a panic history users can
  ship in bug reports.

- **JS error capture** — `main.tsx` installs `error` and
  `unhandledrejection` handlers BEFORE React mounts. Forwards to the
  DevConsole and dispatches an `aura:fatal-error` CustomEvent that
  future surfaces (crash-report panel, Sentry adapter) can subscribe to.

- **MPV log rotation** — `aura-mpv.log` is rotated to `aura-mpv.log.old`
  on Aura startup when it exceeds 50 MB. Without this the file grew
  unbounded and the previous run's final lines (the most useful part
  for crash triage) got truncated by every fresh launch.

- **Library scroll perf** — `content-visibility: auto` with corrected
  `contain-intrinsic-size`, removed per-card hover scale transition
  (was creating a GPU layer per card), added scroll-debounced class
  that suspends transitions during active scroll bursts.

- **Catalog id denylist** — `calendar-videos` is filtered out of the
  per-row build loop in `HomeView.tsx`. Stops AIOMetadata's catalog
  handler from logging "unknown catalog prefix" warnings every home load.

- **Hero metadata fetch dedupe** — routes hero-logo lookups through
  `metaCache.getMetaDetail` (24 h module cache + dedupedInvoke). Earlier
  inline `invoke("fetch_meta_detail")` paired with `heroLogoCache`
  in the effect's deps caused the same 5 ids to fetch 8× in 700 ms.

- **AIOStreams notice partition** — pseudo-streams with
  `streamData.type === "statistic" | "error"` are pulled out of the
  `streams` array in Rust `partition_aio_pseudo_streams` before the
  sanitize loop drops them silently. Routes to existing
  `errors / warnings / info / stats` metadata buckets.

- **Dead code removed** — `names_from_objects` (unused since the rich
  `cast_members_from_objects` superseded it).

---

## Needs setup (outside this repo)

These require accounts / signing keys / hosted endpoints.

### Code signing

- **Goal**: Windows SmartScreen + macOS Gatekeeper trust chain.
- **Status**: User opted out — release will trip SmartScreen on first
  install. Acceptable for a small audience.
- **If revisited**: Apply for an EV or OV code-signing cert
  (DigiCert, Sectigo, etc.). Tauri's `tauri.conf.json` accepts
  `bundle.windows.certificateThumbprint` to sign the produced
  installer. Without it auto-update can't verify update payloads
  either.

### Auto-updater

- **Goal**: Push minor releases without users re-downloading.
- **Tauri plugin**: `tauri-plugin-updater`.
- **Blocked on**: Code signing — the updater rejects unsigned payloads.
- **Skipped for now**: deferred until/unless the user changes mind on
  signing.

### Streaming bridge — in-process (no sidecar to bundle)

The loopback byte-range / live HTTP proxy runs **in-process** as an axum
server on `127.0.0.1:11471`, started by `streaming::start_in_process()`
during Tauri setup (`src-tauri/src/streaming.rs`). There is **no sidecar
binary** to build, stage, or bundle anymore — it was re-internalised.

- **Release flow**: nothing bridge-specific. `pnpm bundle:release` is plain
  `tauri build`; there is no `externalBin`, no `scripts/stage-bridge.cjs`,
  and no `AURA_BRIDGE_BIN`.
- **Dev workflow**: nothing to place on disk — the server starts with the
  app. The `[bridge] in-process bridge listening on http://127.0.0.1:11471`
  DevConsole line confirms it bound. If the port is already taken (e.g. an
  orphaned `aura-bridge.exe` from a pre-internalisation build), the bind
  fails gracefully (logged; HTTPS/HLS streams are unaffected since they
  bypass the bridge).
- **Legacy**: the old private `aura-bridge` crate is retired; `aura-bridge/`
  is git-ignored and only old local checkouts may still exist.

### Crash reporting (remote)

- **Goal**: Aggregate panic / unhandled-error data without users
  emailing logs.
- **Hooks already in place**: `aura:fatal-error` CustomEvent on the JS
  side, `aura-panic.log` on the Rust side.
- **Wire-up**: pick an endpoint (Sentry, Bugsnag, or a self-hosted
  mini-receiver). On the JS side, listen for `aura:fatal-error` and
  POST to the endpoint. On the Rust side, on startup check whether
  `aura-panic.log` has new entries since the last upload and POST
  them.
- **Skipped for now**: requires an account / endpoint URL.

### Settings encryption

- **Goal**: Store Stremio auth tokens, OMDb API keys, and other
  per-user secrets in the OS keyring rather than localStorage / a
  plain JSON file.
- **Tauri plugin**: `tauri-plugin-stronghold` OR direct integration
  with the `keyring` crate (Windows Credential Manager, macOS Keychain,
  Linux Secret Service).
- **Migration**: read existing localStorage values, write to keyring,
  delete the localStorage entry. One-shot on first run after upgrade.
- **Skipped for now**: non-trivial migration; current threat model
  (single-user desktop app, OS-level filesystem trust) doesn't make
  this strictly necessary, but it'd be the right move for a multi-user
  / shared-PC scenario.

---

## Verifications

Pre-release checklist:

1. `pnpm exec tsc --noEmit` — clean.
2. `cargo check --message-format=short` — clean (one pre-existing
   warning about `names_from_objects` is now removed).
3. `pnpm build` — successful, no chunk-size warnings, total bundle
   under 1.5 MB on disk.
4. `pnpm build:analyze` — audit per-file sizes for unexpected creep.
5. Manual smoke test of CSP — verify posters / streams / subtitles
   load on the prod build (CSP applies only in production; dev mode
   is unrestricted).
6. Verify `%USERPROFILE%\aura-panic.log` is created on a forced panic
   (e.g. throw a panic from a debug-only command).

---

## Notes on the open repo and "anti-repurpose" strategy

The user's stated goal: keep the source open enough for hobbyists to
build / fork, but make commercial repurposing harder. See
the notes below for the full discussion;
short version:

- The libmpv DLLs are NOT in the repo (`src-tauri/lib/*.dll`) and
  the `.gitignore` ensures they stay out. Anyone building from
  source has to fetch them from the original upstreams. Documented
  in the README.
- Image assets / logos / branding are repo-checked. A commercial
  fork would have to strip these to avoid trademark / personality-
  rights issues — which is friction.
- The Stremio `auth_key` flows the user's account through the
  fork's network — a public commercial fork can't do this without
  exposing themselves to data-protection liability.
- Future option: extract the streaming-bridge or scrobble pipeline
  into a closed-source companion binary linked at runtime
  (mirrors what e.g. Soia does with libmpv). Adds friction to
  repurposing without locking out hobbyists who can build their own
  binary substitute.
