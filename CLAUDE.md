# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Aura is

Tauri 2 + React 19 + libmpv desktop media player on Windows that consumes the Stremio addon ecosystem. Native Win32 chrome (no decorations), transparent webview, MPV embedded as a child window.

## Commands

```bash
# Frontend
pnpm dev                          # Vite dev server (HMR)
pnpm build                        # tsc + vite production build
pnpm exec tsc --noEmit            # type-check only (no emit)
pnpm exec vite build              # bundle without type-check

# Tauri
pnpm tauri dev                    # full app with hot reload (Rust restarts on .rs change)
pnpm tauri build                  # bundled installer

# Rust
cargo check --message-format=short    # FROM src-tauri/  -- fast Rust check
cargo build --release                 # FROM src-tauri/

# Verification cycle (run after every meaningful edit)
cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit
```

There are no tests, no ESLint, no Prettier — `cargo check` + `tsc --noEmit` are the only correctness gates. Use them.

When inspecting bundle output for confirmed CSS rules (e.g. verifying a Tailwind class actually emitted), `dist/assets/index-*.css` is the artifact.

## Architecture

### Two-process model with a transparent overlay

- **Rust host** owns: MPV instance, axum streaming bridge on `127.0.0.1:11471`, Stremio account API, addon fan-out, OS integrations (SMTC, Discord RPC, keyring), Win32 fullscreen.
- **WebView2 webview** is the React UI. Configured `decorations: false`, `transparent: true`, `shadow: false` in `tauri.conf.json`.
- **MPV** is rendered as a CHILD window via `--wid=<main_hwnd>` from `tauri-plugin-libmpv`. It sits as a sibling of the WebView2 inside the main window. The webview's transparency is what lets the MPV layer show through; never paint a non-transparent background on the app shell.

### Streaming bridge — HTTPS bypass is intentional

`src-tauri/src/streaming.rs` runs an axum server on `:11471` that proxies HTTP and (will) handle magnets. **HTTPS streams BYPASS the bridge entirely** and go straight to MPV. Don't undo that — many addon hosts (e.g. `stremthru.animasec.dev`) have TLS certs that don't match `127.0.0.1`, and routing through the local proxy breaks playback.

### Tauri command registration is three places, all required

Every new Rust `#[tauri::command]` must be:
1. Declared in `src-tauri/src/lib.rs` `tauri::generate_handler![...]`
2. Allowed in `src-tauri/permissions/player.toml` (`commands.allow = [...]`)
3. Listed in `src-tauri/capabilities/default.json`

Skip any of those and the command silently 401s at runtime.

### Frontend ↔ Rust serialization quirk

`#[serde(rename = "...")]` applies to BOTH directions. Tauri sends struct fields back to the frontend using the renamed key. **For structs that flow Rust → React, use `#[serde(rename(deserialize = "..."))]`** (deserialize-only) so wire-format names map into snake_case Rust on read, but Tauri's outgoing JSON uses the Rust field names that match TS interfaces. `LibraryItem` was the canonical hit — bidirectional renames left React reading `undefined` for `id` and `media_type`, breaking Library / CW / Calendar simultaneously.

### Library normalization at the loadLibrary boundary

Earlier Aura builds wrote per-episode library entries (e.g. `_id: "tt0903747:1:5"`). Stremio's official client keys library records at the SERIES root with `state.video_id` storing the episode. `src/libraryNormalize.ts` collapses every per-episode row into one canonical series-rooted entry at `App.loadLibrary` so Library, Calendar, and Continue Watching all read clean data — none of them repeat the dedup logic. New writes use `target.series_id` from `targetForPlay`; legacy data is fixed up by the normalizer.

### Continue Watching shape

`ActiveScrobbleTarget` carries both `id` (stream-fetch target — episode id for series) and `series_id` (library record key — series root for series, equal to `id` for movies). `libraryWriteProgress` writes `_id = series_id ?? id` and stamps `state.video_id = id` when they differ. `libraryClearProgress` is Stremio's "Rewind" — only zeroes `state.timeOffset`, preserves `video_id` and everything else.

### Tailwind opacity scale gotcha

Default Tailwind opacity steps are 0/5/10/.../85/90/95/100. Anything else (`bg-black/97`, `bg-white/12`, etc.) silently emits NO CSS — the JIT skips unrecognized values without warning. Custom intermediate values (92/93/96/97/98) are extended in `tailwind.config.ts`. When adding new Tailwind opacity utilities, either pick from the scale or extend `theme.extend.opacity`.

## MPV stability landmines (DO NOT re-introduce)

These are mistakes that have specific, hard-to-diagnose symptoms. The HANDOFF.md has the full forensic detail; this is the cheat sheet:

1. **Use `mpv.set_property(name, &value)`, never `mpv.command("set_property", [name, value])`.** The latter silently no-ops on this libmpv build → "volume slider snaps back" / "speed doesn't change".
2. **Never enable `audio-exclusive=yes` or `audio-spdif=…` by default.** Locks WASAPI device system-wide; other media apps can't open the device until reboot if Aura crashes.
3. **Do not poll `get_property` during libmpv state transitions.** Three manifestations of the same race: (a) before `duration > 0` libmpv is still inside its loadfile critical section; gate polling on `playbackReady`/`duration > 0`. (b) During a seek (e.g. AniSkip's Lua script issuing `seek` to clear an OP/ED), a concurrent `get_property` poll lands inside libmpv's seek critical section and crashes at `libmpv_wrapper!mpv_wrapper_get_property+0xa71` — `movsxd rax, [rcx+rax*4]` dereferences -1. (c) Even a single `get_tracks` invoke fans out to ~7 `get_property` calls (track-list/count + 6 per-track subprops); a 500 ms `setInterval` of those was the dominant AniSkip-skip crash for several builds — replaced with a one-shot read after `duration > 0` + 1.5 s grace, then refresh only on `aura:tracks-refresh` window events fired from track-mutating actions (`set_audio_track`, `set_subtitle_track`, `add_subtitle_to_mpv`). The earlier `sub-visibility` poll was removed for the same reason; both deletions are required. Same rule applies to `chapter-list` reads in `App.tsx::mergeChapterSkipWindows` — the 600 ms × 10-iteration polling MUST use `string` format only; `node` format on this libmpv build hits the same dispatch-table fault as `track-list/node`.
4. **Do not extend `observed_properties` casually.** On this libmpv build, requesting `track-list (node)`, `aid (string)`, `sid (string)`, `core-idle (flag)`, or `paused-for-cache (flag)` breaks the ENTIRE event channel — no property events fire at all. Trimmed working set: `pause`, `time-pos`, `duration`, `volume`, `speed`. Everything else is polled.
5. **Do not reapply Mica on every pause.** DWM backdrop ends up over the MPV child surface — looks like "MPV renders behind everything".
6. **Do not unmount `<TitleBar>` during windowed playback.** Stays visible (with `opaque` prop) in windowed; only unmount in true OS fullscreen. PlayerOverlay's top action bar must offset 36 px in windowed mode to avoid overlapping it.
7. **Do not use `data-tauri-drag-region` for the title bar.** It leaves the cursor stuck on simple clicks. Use explicit `onPointerDown → getCurrentWindow().startDragging()`.
8. **Do not set `glsl-shaders` via `set_property`.** Use `change-list glsl-shaders set "<forward-slash-path>"` and strip `\\?\` UNC prefixes from the path string first.
9. **Use `mpv.destroy("main")` synchronously in `CloseRequested`.** `tauri::async_runtime::spawn_blocking` returns immediately; the process can exit before WASAPI is released. `window_logic.rs::shutdown_mpv_sync` does the right sequence (mute → stop → destroy).
10. **Do not reparent the MPV child to top-level.** Tried (`SetParent(NULL)` + `WS_POPUP`) for "true exclusive fullscreen" — libmpv's render context didn't survive the reparent and video disappeared. Stick with the child-window architecture; `win32::enter_native_fullscreen` resizes the PARENT to monitor rect with `WS_POPUP` + `HWND_TOPMOST` instead.

## Win32 fullscreen reality check

`win32::enter_native_fullscreen` is the canonical fullscreen path — `setFullscreen` from Tauri's API lands at the work-area rect (taskbar showing through), not the full monitor. The Win32 path does `WS_POPUP` + monitor `rcMonitor` + `HWND_TOPMOST` + `SWP_FRAMECHANGED` + `BringWindowToTop` + `SetForegroundWindow`. Even with all of that, the taskbar bleed-through on the user's "always show taskbar" setting is a Windows compositor heuristic limitation — the auto-hide only triggers for users with "Automatically hide the taskbar" enabled in Windows Settings. The `Shell_TrayWnd` `SW_HIDE` workaround was tried and reverted because it broke secondary-monitor tray icons. True DXGI exclusive fullscreen would require a render rewrite (mpv_render_context); this is documented in HANDOFF.md as deferred.

## Caching boundaries

- **Library**: localStorage warm-start in `App.loadLibrary` (keyed by `auth_key.slice(0, 12)`). Plus a 5-minute focus-refetch debounce, plus a 5-minute `recentlyCleared` overlay that re-zeroes `state.timeOffset` for ids cleared in the last window — Stremio's `datastoreGet` is eventually consistent on `_mtime` and a fresh fetch within the window can return stale non-zero state.
- **Calendar meta**: 24-hour module-level `Map` cache keyed by `${addonUrl}::${type}::${id}` so re-mounting Calendar doesn't re-fetch every library item's meta.
- **Addon manifest fields**: `AddonEntry.stream_types`, `id_prefixes`, `stream_id_prefixes` are populated at install/sync time. `fetch_streams` reads them directly — never re-fetches manifests per stream request (a transient network failure during that re-probe used to kill all stream lookups).

## Where to look first by symptom

- "Volume slider snaps back" / "speed doesn't change" → `lib.rs` setters; verify `mpv.set_property(...)` not `mpv.command("set_property", ...)`.
- "MPV renders behind UI" / black bar at top → `App.tsx` TitleBar `opaque` prop, body `hidden` class while playing, `.aura-app-shell` background must be transparent always.
- "MPV doesn't fill window after fullscreen toggle" → `refresh_video` in `lib.rs` + `win32::resize_mpv_child_to_parent`. Frontend triggers double-fire at +80 ms / +240 ms, plus the duration-armed series at 0/80/200/500/1000/2000 ms.
- "App crashes on play" (STATUS_ACCESS_VIOLATION) → MPV property race; check polling and observed-property formats.
- "Native browser context menu appears" → `main.tsx` capture-phase `contextmenu` listener; must install BEFORE React mounts.
- "Streams from addon X don't appear" → DevConsole filter for `[X]`; `fetch_streams` logs manifest gate decisions.
- "Ratings missing/sparse" → `ratings.rs` aggregator: MDBList branch needs a `tt`-prefixed IMDb id (key baked at build via `build.rs` from git-ignored `src-tauri/mdblist.key`; empty key → branch no-ops); MAL+AniList branch needs a resolvable anime id. Non-tt non-anime ⇒ only addon-supplied `detail.ratings`.
- "Library page blank" → `<ErrorBoundary scope="Library">` will surface the render error.

## Conventions

- F12 opens the in-app DevConsole (ring buffer, level filters, search). Rust logs come through via `crate::devlog!` macro which mirrors to stderr AND emits a `dev-log` Tauri event.
- Rust log labels: `[bridge]`, `[player]`, `[streams]`, `[meta]`, `[catalog]`, `[search]`, `[subtitles]`, `[ratings]`, `[rpc]`, `[win32]`, `[smtc]`, `[scrobble]` — grep these in DevConsole or `aura-mpv.log`.
- libmpv writes its own verbose log to `%USERPROFILE%\aura-mpv.log` (truncated each MPV init). The last few lines usually pinpoint a STATUS_ACCESS_VIOLATION.
- Discord RPC uses application ID `1499651271357890610` (in `window_logic.rs`). Browse states are gated on `discord_rpc_browse_states` setting; playback states honor `discord_rpc_show_titles` + the per-title blocklist.
- Libmpv DLLs in `src-tauri/lib/` (`libmpv-2.dll` + `libmpv-wrapper.dll`) are git-ignored (>100 MB). Keep them present locally; downloads are at `github.com/zhongfly/mpv-winbuild` and `github.com/nini22P/libmpv-wrapper`.

## Memory & docs to consult

- `HANDOFF.md` — extended forensic notes, full phase history, full landmines list.
- `ROADMAP.md` — feature phases (5.7 entries are stale; the file stops at 5.8 and most "TODO" items there have shipped).
- `src-tauri/permissions/player.toml` + `src-tauri/capabilities/default.json` — the permission ledger (often the silent failure mode for new commands).
