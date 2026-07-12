# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
It is the single source of truth for project context: the former `HANDOFF.md` was consolidated into it.

## What Aura is

Tauri 2 + React 19 + libmpv desktop media player on Windows that consumes the Stremio addon
ecosystem. Native Win32 chrome (no decorations), transparent WebView2, MPV embedded as a child
window beneath the webview. Aura is Stremio-addon-only (used with Debrid for streams): there is no
native torrent engine and none is planned. Playback, account sync, ratings, scrobbling, casting,
live TV, and synced "watch together" rooms are all built on top of that addon model.

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

# Rust (run FROM src-tauri/)
cargo check --message-format=short    # fast Rust check
cargo build --release

# Verification cycle (run after every meaningful edit)
cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit
```

There are no tests, no ESLint, no Prettier. `cargo check` + `tsc --noEmit` are the only correctness
gates; use them. For a TS-only change, `tsc --noEmit` is sufficient; touch Rust and you also need
`cargo check`.

When inspecting bundle output for confirmed CSS rules (e.g. verifying a Tailwind class actually
emitted), `dist/assets/index-*.css` is the artifact. It is git-ignored, so build first.

## Tech constraints and invariants

| Area | Constraint |
|------|------------|
| HTTP client | `reqwest 0.12`, default-features off, `rustls-tls` backend. Auth / account clients enforce `https_only(true)`. Do not add a plaintext-HTTP fallback: every one removed was the result of a real wire-capture incident. |
| TLS exception | Casting (`cast/`) uses `native-tls` (SChannel) on purpose, to accept self-signed CASTV2 device certs on the LAN. This is the only deliberate divergence from the rustls posture. |
| Credentials | Platform-native keyring (`keyring 3`, `windows-native` / `apple-native` / `linux-native-sync-persistent`). Native backends are MANDATORY (an in-memory mock silently lost OpenSubtitles keys between launches). Passwords wrapped in `Zeroizing<String>` (`zeroize 1`). |
| Secrets at rest | Stremio session (`auth_key` + email), user-supplied API keys (OpenSubtitles, PublicMetaDB), and Xtream passwords all live in the OS keyring (`auth.rs`, `api_keyring.rs`, `iptv.rs`). Build-time default keys (`AURA_MDBLIST_KEY`, `AURA_PUBLICMETADB_KEY`) are baked by `build.rs` from a git-ignored `.env.local` (see "Build-time secrets"). |
| File I/O | Scoped to `app_data_dir()`. Downloaded subtitles must land inside `app_data_dir()/subtitles`; `add_subtitle_to_mpv` enforces path containment before handing a local path to mpv. |
| Search safety | All poster URLs validated; text fields capped before returning to the frontend. |
| HTTP servers | `axum 0.7` (the in-process streaming bridge). Pinned at 0.7: 0.8 changed wildcard route syntax. |
| Async | `tokio 1` multi-thread runtime, shared by the bridge, addon fan-out, and cast servers. |

## Architecture

### Two-process model with a transparent overlay

- **Rust host** owns: the MPV engine, an in-process axum streaming bridge on `127.0.0.1:11471`, the
  Stremio account + sync API, addon fan-out, ratings aggregation, scrobbling, casting, live-TV /
  EPG, and OS integrations (SMTC, Discord RPC, keyring, system tray, Win32 fullscreen).
- **WebView2 webview** is the React UI. Configured `decorations: false`, `transparent: true`,
  `shadow: false` in `tauri.conf.json`. The webview's transparency is what lets the MPV layer show
  through; NEVER paint a non-transparent background on the app shell (`.aura-app-shell` must stay
  transparent at all times).

### The MPV engine (`src-tauri/src/mpv/`)

One engine, one DLL (`libmpv-2.dll`), one event channel. Driven by direct FFI in
`mpv/ffi.rs` (raw symbol loader + C structs/enums) and orchestrated by `mpv/engine.rs`.

- **Embedding** is via `--wid=<host hwnd>`: the engine thread creates a black host child window of
  the Tauri main window at `HWND_BOTTOM` (below the WebView2) and embeds mpv into it. mpv owns
  rendering entirely through `vo=gpu-next` on a d3d11 GPU context.
- **The engine thread owns** the mpv handle, a command channel (every playback Tauri command submits
  an `EngineCommand`: `LoadFile`, `TogglePause`, `SetVolume`, `Command(Vec<String>)`,
  `SetProperty{typed}`, `GetProperty{sync reply}`, `Shutdown`), the event drain
  (mpv events -> `mpv-event-main` -> the lib.rs observer bridge -> `playback-update` / `osd-update`),
  and a geometry pump that tracks the parent client rect and resizes the host + mpv child
  (36 px title-bar inset windowed, 0 in fullscreen). The pump cadence is three-tier: `TICK` 5 ms
  while a file is loaded (playing OR paused), `IDLE_TICK` 33 ms when visible with no file loaded
  (idle Home/menu), `HIDDEN_TICK` 150 ms while minimized/occluded. Keyed on file-loaded
  (`playback_ready`), NOT pause state, so a paused file and background audio keep the fast tick.
  Parent-visibility (`PresentMode`) is detected at most every `MODE_POLL_INTERVAL` (120 ms), not per
  tick, to avoid a per-tick DWM round-trip.
- **Observed properties (the only safe set on this libmpv build):** `pause`, `time-pos`, `duration`,
  `volume`, `speed`, `frame-drop-count`, `decoder-frame-drop-count`. Everything else is polled. See
  the landmines: extending this set carelessly kills the ENTIRE event channel.
- **Init options of note** (`INIT_OPTS` in `engine.rs`): `hwdec=auto`, `keepaspect=yes`,
  `background=none`, `d3d11-output-format=rgb10_a2` (10-bit swapchain for HDR10 eligibility),
  `volume=50` (headphone-safe), `keep-open=yes` + `keep-open-pause=yes` (retain last frame at EOF),
  and the buffer tuning: `cache-secs=180`, `demuxer-readahead-secs=120`, `demuxer-max-bytes=768 MiB`,
  `demuxer-max-back-bytes=128 MiB`, `network-timeout=60`, plus
  `demuxer-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=4`.
- **HDR** is REAL via `gpu-next` + d3d11 with a per-file `target-colorspace-hint` (PQ/DV passthrough
  on HDR streams, SDR otherwise), applied by `apply_hdr_settings`. `hdr_target_peak_nits` exists to
  curb OLED True-Black blow-out.
- **What was removed (do not reintroduce):** `tauri-plugin-libmpv` and `libmpv-wrapper.dll` (the
  legacy plugin) are gone; so is the render-context (`mpv_render_context`) path, because it could not
  reach `vo=gpu-next` and therefore had no HDR passthrough. `lib.rs` actively deletes orphaned
  `mpv.dll` / `libmpv-wrapper.dll` left by older installs on startup. A separate, on-demand FFI
  instance in `mpv/thumb.rs` extracts hover thumbnails and is torn down when idle (do not keep a
  second resident libmpv).

### Streaming bridge (`src-tauri/src/streaming.rs`) - the bypasses are intentional

An **in-process** axum server on `:11471`, started by `streaming::start_in_process()` in `lib.rs`
setup (no sidecar; the old `aura-bridge.exe` was internalised). `resolve_stream` routes by scheme:

- **`magnet:`** -> bridge `/magnet/*` endpoint -> **permanently `501 NOT_IMPLEMENTED`.** Aura is
  Stremio-addon-only with Debrid; there is no torrent engine and none is planned. Do not try to wire
  one.
- **HLS (`.m3u8` / `.m3u`, ANY scheme including plain HTTP)** -> **DIRECT to MPV.** A proxied
  manifest breaks mpv's relative segment-URI resolution (absolute-path segments like
  `/live/.../seg.ts` would resolve against `127.0.0.1` -> 404) and trips provider User-Agent gating.
- **`https://`** -> **DIRECT to MPV.** Many addon hosts (e.g. `stremthru.animasec.dev`) have TLS
  certs that do not match `127.0.0.1`; bypassing also avoids double-buffering through the local
  server.
- **`http://`** -> bridge `/proxy/*` (byte-range forwarding, preserves the client User-Agent so
  mpv's Lavf UA reaches the host), EXCEPT when a per-file `via_proxy` flag is set (live-TV playlists
  that mpv tunnels via its own `http-proxy` setting) in which case it goes direct.
- Anything else -> passthrough (mpv decides).

Do not undo either the HTTPS or the HLS bypass.

### Tauri command registration is three places, all required

Every new Rust `#[tauri::command]` must be:
1. Declared in `src-tauri/src/lib.rs` `tauri::generate_handler![...]`
2. Allowed in `src-tauri/permissions/player.toml` (`commands.allow = [...]`)
3. Listed in `src-tauri/capabilities/default.json`

Skip any of those and the command silently 401s at runtime. There are ~90 registered commands;
`lib.rs` is the canonical list.

### Frontend <-> Rust serialization quirk

`#[serde(rename = "...")]` applies to BOTH directions. Tauri sends struct fields back to the frontend
using the renamed key. For structs that flow Rust -> React, use
`#[serde(rename(deserialize = "..."))]` (deserialize-only) so wire-format names map into snake_case
Rust on read, but Tauri's outgoing JSON uses the Rust field names that match the TS interfaces.
`LibraryItem` was the canonical hit: bidirectional renames left React reading `undefined` for `id`
and `media_type`, breaking Library / Continue Watching / Calendar simultaneously.

### Library normalization at the loadLibrary boundary

Earlier Aura builds wrote per-episode library entries (e.g. `_id: "tt0903747:1:5"`). Stremio's
official client keys library records at the SERIES root with `state.video_id` storing the episode.
`src/libraryNormalize.ts` collapses every per-episode row into one canonical series-rooted entry at
`App.loadLibrary` so Library, Calendar, and Continue Watching all read clean data; none of them
repeat the dedup logic. New writes use `target.series_id` from `targetForPlay`; legacy data is fixed
up by the normalizer. Library state is shared through `LibraryContext`.

### Continue Watching shape

`ActiveScrobbleTarget` carries both `id` (stream-fetch target: episode id for series) and `series_id`
(library record key: series root for series, equal to `id` for movies). `libraryWriteProgress`
writes `_id = series_id ?? id` and stamps `state.video_id = id` when they differ.
`libraryClearProgress` is Stremio's "Rewind": only zeroes `state.timeOffset`, preserving `video_id`
and everything else.

### Story arcs: NEVER join TMDB arcs to episodes by number

Arcs come from TMDB episode groups (`type == 5`), which define an arc as a set of TMDB
`(season, episode)` pairs. Aura's episode ids come from Stremio meta addons (Cinemeta / TVDB
numbering). **The two numbering systems disagree, and not by a constant.** Do not "fix" this with a
season join, an absolute-episode join, or a hardcoded offset. All three are wrong:

- TMDB's season boundaries are not Cinemeta's (One Piece: TMDB S1 = 61 episodes, Cinemeta S1 = 8).
- TMDB promotes a Toriko crossover special into One Piece's MAIN RUN at absolute 590; Cinemeta files
  it as special S0E39. So TMDB abs N == Cinemeta abs N up to 589 and N-1 from 591 on. A naive
  absolute-index join misplaces **579 of 1168 episodes (49.6%)**: every arc from Punk Hazard onward
  starts and ends one episode late, and it *looks correct*. That offset is one TMDB editorial
  decision, not a constant, and it grows over time.
- Air date alone is not a key (weekly anime repeat dates: 40 of Naruto Shippuden's air dates carry
  two episodes). Title alone is not a key (TVDB and TMDB use different English translations of the
  same episode; some true pairs score 0.00 on bigram similarity).

`arc_align.rs` is the answer: a banded Needleman-Wunsch alignment over air date + title with
broadcast order as a hard constraint, which absorbs a promotion/demotion as a single gap. Measured
100% correct on One Piece (1168/1168) and Naruto Shippuden (500/500). It has real `#[cfg(test)]`
tests, including a regression test for exactly the off-by-one above; keep them. Any arc containing a
sub-0.5-confidence pair is DROPPED and logged rather than rendered. Fail visible, never fail
off-by-one. Season 0 is excluded on both sides (the two databases' specials do not correspond).

### Build-time secrets

`build.rs` parses `../.env.local` (git-ignored) or real environment variables and bakes three keys
via `cargo:rustc-env`: `AURA_MDBLIST_KEY` (used by `ratings.rs`), `AURA_PUBLICMETADB_KEY` (used by
`publicmetadb.rs`), and `AURA_TMDB_KEY` (used by `arcs.rs`). An empty/missing key makes that feature
cleanly no-op (no error, just empty ratings, no skip windows, or no Arcs toggle). A user-supplied key
in the OS keyring overrides the baked one where supported (`api_keyring::SUPPORTED_KEYS` is
`opensubtitles` + `tmdb`). Per-account cloud sync scopes by a SHA-256 hash of the Stremio `auth_key`
(`sync.rs`); each account's blob is isolated.

## Codebase map

Dense pointers; grep the file for specifics. The repo is large (Rust ~27k LOC over ~37 files;
frontend ~40k LOC over ~70 files + ~13 views).

### Rust (`src-tauri/src/`)

- **Engine + window**: `mpv/engine.rs` (FFI engine), `mpv/ffi.rs` (raw bindings), `mpv/thumb.rs`
  (on-demand thumbnail extractor), `win32.rs` (native fullscreen, mpv-child resize, display-refresh
  query, power-throttling opt-out, windowed MPO poison), `window_logic.rs` (window events, native
  fullscreen toggle, Discord RPC presence), `player.rs` (HDR mode resolution, audio passthrough,
  subtitle styling defaults), `cinema.rs` (GLSL shader profiles).
- **Stremio + streaming**: `stremio.rs` (catalog / search / library / meta / stream aggregation /
  external subs; the biggest module), `streaming.rs` (axum bridge), `auth.rs` (Stremio login /
  session), `sync.rs` (cloud library sync + release-signal polling), `addons.rs`.
- **Metadata + ratings**: `ratings.rs` (MDBList + Jikan + AniList aggregator, anime-aware weights),
  `publicmetadb.rs` (OP/ED skip source + TMDB id resolution), `anime_id_map.rs`, `silencedetect.rs`
  (outro boundary via ffmpeg), `trailer.rs` (YouTube trailer resolve).
- **Skip / scrobble**: `aniskip.rs` (OP/ED timing, vote/submit, id resolution), `scrobble.rs` +
  `scrobble_auth.rs` + `scrobble_anilist.rs` (Trakt + AniList OAuth, heartbeat).
- **Subtitles + media**: `subtitles.rs` (OpenSubtitles v1: search incl. moviehash, download,
  add-to-mpv), `subsync.rs` (Live Sync cue lists: SRT / WebVTT / ASS parsing for external tracks,
  WINDOWED ffmpeg extraction for embedded ones), `media_controls.rs` (SMTC via souvlaki),
  `per_title.rs` (per-id volume / shader / track memory).
- **Story arcs**: `arcs.rs` (TMDB episode groups -> arcs, grouping selection, the command),
  `arc_align.rs` (the join; see the landmine below), `arc_art.rs` (Fandom arc key art, curated
  TMDB-id -> wiki table). Devlog label `[arcs]`.
- **Casting + live TV**: `cast/mod.rs` + `cast/castv2.rs` + `cast/dlna.rs` + `cast/hls.rs` +
  `cast/media_server.rs` (Chromecast via hand-rolled CASTV2 + DLNA + on-the-fly HLS transcode),
  `iptv.rs` (EPG fetch + Xtream password keyring).
- **Settings + infra**: `settings.rs` (per-scope AppSettings + theme + HDR resolver), `api_keyring.rs`
  (user API keys in keyring), `backup.rs` (user-data export), `storage.rs`, `stats.rs`,
  `crash_reporting.rs` (Sentry + minidump self-spawn), `runtime_deps.rs` (on-demand binary fetch),
  `tray.rs`, `popup_nav.rs` (in-app browser webview nav), `devlog.rs`, `log_export.rs`,
  `debug_panel.rs`.

### Frontend (`src/`)

- **Shell + router**: `App.tsx` (~7k LOC orchestrator: router, `usePlayback`, library load/normalize,
  auth, fullscreen, notifications, watch-together room state, scrobble + auto-advance, chapter-skip
  merge, session-route restore), `main.tsx` (entry; installs the capture-phase contextmenu
  suppressor BEFORE React mounts), `TitleBar.tsx`, `NavSidebar.tsx`, `ThemeEngine.tsx`,
  `ErrorBoundary.tsx`, `pageLayout.ts` (shared `PAGE_CONTENT_MAX_W`).
- **Player**: `PlayerOverlay.tsx` (~4.3k LOC in-player UI), `SourceSwitcher.tsx`, `SubtitlePicker.tsx`,
  `AniSkipMenu.tsx`, `EosSpotlight.tsx` (end-of-stream next-up / end-card), `NextUpCta.tsx`,
  `ResumePrompt.tsx`, `PlaybackEngineGate.tsx`.
- **Views (`src/views/`)**: Home, Library, Queue, Discover, Live, Calendar, History, Detail, Search,
  Addons, Settings, Onboarding, CatalogPage. Live subviews in `src/views/live/`
  (Guide, MultiView, PlaylistForm).
- **Subsystem modules**: live TV in `src/iptv/*` (M3U / Xtream / XMLTV parse, EPG store + worker),
  watch-together in `src/watchTogether/*` (WebSocket to the `watch-relay/` Cloudflare Workers + DO
  relay), casting via `cast.ts` + `useCastSession.ts`, notifications in `Notifications*.tsx`
  (ring buffer + background scanner), updater in `updater*.ts` + `UpdatePopup.tsx` + `Changelog.tsx`.
- **Data / caching**: `metaCache.ts`, `persistentCache.ts`, `libraryNormalize.ts`, `auraSettings.ts`,
  `settingsTransfer.ts`, `sessionRoute.ts`, `catalogHoverStore.ts`, `releaseSignalStore.ts`,
  `historyStore.ts`, `streamMeta.ts`, `aiometadata.ts`. See "Caching boundaries".

## Tailwind theme-scale gotchas (silent no-op classes)

`tailwind.config.ts` REPLACES the `maxWidth` scale and EXTENDS `opacity`. Two classes of utility
silently emit NO CSS (the JIT skips unrecognized scale values without warning), and both have bitten
the UI:

1. **maxWidth**: only `none` / `full` / `screen` survive. Every NAMED token (`max-w-md`, `max-w-6xl`,
   `max-w-prose`, `max-w-screen-*`, fractions, ...) emits nothing, so the element gets no cap and
   stretches to its parent. Arbitrary values (`max-w-[42rem]`, `max-w-[65ch]`, `max-w-[1800px]`) DO
   emit. For the main scrollable pages use the shared inline cap:
   `style={{ maxWidth: PAGE_CONTENT_MAX_W }}` from `src/pageLayout.ts` (Library, Queue, Discover,
   Catalog, Search all route through it so the centered column can never drift again; Library's
   row-windowing column math reads the same constant). For one-offs (modals, prose) use an arbitrary
   value.
2. **opacity**: the default scale is 5-point steps (`/5 /10 /15 ... /95 /100`). Any off-scale bare
   modifier (`/8`, `/12`, `/6`, `/97`, ...) emits nothing: `bg-white/8` renders no fill and
   `border border-white/8` falls back to the preflight gray-200 hairline instead of subtle white.
   The fix is to register every off-scale value the app uses under `theme.extend.opacity`. The
   current registered extras are `2 3 4 6 8 12 14 16 18 72 82 92 93 96 97 98`. When you introduce a
   new off-scale opacity, ADD it there (or use an arbitrary `/[0.07]`), then rebuild and confirm it
   emitted by grepping `dist/assets/index-*.css`.

## MPV stability landmines (DO NOT re-introduce)

These are mistakes with specific, hard-to-diagnose symptoms.

1. **Property writes go through a dedicated set-property path, never `command("set_property", [name, value])`.**
   The command form silently no-ops on this libmpv build ("volume slider snaps back" / "speed does
   not change"). In the engine that means submitting `EngineCommand::SetProperty{...}` (a typed
   `mpv_set_property`), not `Command(vec!["set_property", ...])`.
2. **Never enable `audio-exclusive=yes` or `audio-spdif=...` by default.** Locks the WASAPI device
   system-wide; other media apps cannot open it until reboot if Aura crashes. (They may return as
   explicit Settings opt-ins.)
3. **Do not poll `get_property` during libmpv state transitions.** Three faces of one race:
   (a) before `duration > 0` libmpv is still inside its loadfile critical section; gate polling on
   `playbackReady` / `duration > 0`. (b) During a seek (e.g. an AniSkip Lua `seek` clearing an
   OP/ED) a concurrent `get_property` poll lands in libmpv's seek critical section and crashes with a
   `-1` dispatch-table deref. (c) A single `get_tracks` fans out to ~7 `get_property` calls; a 500 ms
   `setInterval` of those was the dominant AniSkip-skip crash for several builds. Track reads are now
   a one-shot after `duration > 0` + 1.5 s grace, refreshed only on `aura:tracks-refresh` window
   events fired by track-mutating actions (`set_audio_track`, `set_subtitle_track`,
   `add_subtitle_to_mpv`). The old `sub-visibility` poll was removed for the same reason; both
   deletions are required. The same rule applies to `chapter-list` reads in
   `App.tsx::mergeChapterSkipWindows`: the 600 ms x 10 polling MUST use `string` format only; `node`
   format hits the same dispatch-table fault as `track-list/node`.
4. **Do not extend `observed_properties` casually.** On this libmpv build, requesting
   `track-list (node)`, `aid (string)`, `sid (string)`, `core-idle (flag)`, or
   `paused-for-cache (flag)` breaks the ENTIRE event channel: no property events fire at all. Working
   set: `pause`, `time-pos`, `duration`, `volume`, `speed`, `frame-drop-count`,
   `decoder-frame-drop-count`. Everything else is polled.
5. **Do not reapply Mica on every pause.** The DWM backdrop ends up over the MPV child surface; looks
   like "MPV renders behind everything".
6. **Do not unmount `<TitleBar>` during windowed playback.** It stays visible (with the `opaque`
   prop) in windowed; only unmount in true OS fullscreen. PlayerOverlay's top action bar must offset
   36 px in windowed mode to avoid overlapping it.
7. **Do not use `data-tauri-drag-region` for the title bar, and do not start the drag on
   `pointerdown`.** `data-tauri-drag-region` leaves the cursor stuck on simple clicks. Starting the
   drag (either `startDragging()` OR the custom capture) on `pointerdown` enters the OS modal
   `SC_MOVE` loop / captures the pointer immediately and **swallows the second click of a
   double-click**, silently breaking double-click-to-maximize. So `TitleBar.tsx` only ARMS on
   `onPointerDown` and **defers the real drag to the first `pointermove` past a 4px threshold** — a
   plain click / double-click then never starts a drag and reaches the webview as ordinary
   click / dblclick (native `onDoubleClick` -> `toggleMaximize`, no synthesis needed). Past that
   threshold the path forks by OS: Windows 11 (and any non-Windows / maximized window) calls
   `getCurrentWindow().startDragging()` (native caption drag, keeps Aero Snap); **Windows 10 uses a
   custom coalesced pointer-drag** (`setPointerCapture` + one `setPosition` per rAF) because the
   native modal loop recomposites the transparent WebView2 + mpv d3d11 child on every move step and
   stalls on Win10's older DWM + weak GPUs (window crawls behind a captured cursor). The gate is the
   `is_windows_10` command (`win32::is_windows_10`, `RtlGetVersion` build < 22000 — the WebView2 UA
   can't tell Win10 from Win11). Do NOT move drag initiation back to `pointerdown` (re-breaks
   double-click) and do NOT collapse the Win10 custom path back to `startDragging` (re-introduces the
   Win10 lag).
8. **Do not set `glsl-shaders` via `set_property`.** Use `change-list glsl-shaders set "<forward-slash-path>"`
   and strip `\\?\` UNC prefixes from the path first. Same class of bug applies to other option-list
   properties.
9. **Tear mpv down synchronously in `CloseRequested`.** `tauri::async_runtime::spawn_blocking` returns
   immediately; the process can exit before WASAPI is released. The engine shutdown joins the engine
   thread, whose teardown does the right sequence (mute -> stop -> `mpv_terminate_destroy`).
10. **Do not reparent the MPV child to top-level.** Tried (`SetParent(NULL)` + `WS_POPUP`) for "true
    exclusive fullscreen"; libmpv's context did not survive the reparent and video disappeared. Stick
    with the child-window architecture; `win32::enter_native_fullscreen` resizes the PARENT to the
    monitor rect with `WS_POPUP` + monitor `rcMonitor` instead.

## Win32 fullscreen reality check

`win32::enter_native_fullscreen` is the canonical fullscreen path: Tauri's `setFullscreen` lands at
the work-area rect (taskbar showing through), not the full monitor. The Win32 path resolves the
monitor via `MonitorFromWindow`, `SetWindowPos` to its full `rcMonitor` (covers the taskbar area),
`SWP_FRAMECHANGED` + bring-to-front. Companion helpers in `win32.rs`:

- `resize_mpv_child_to_parent` dynamically loads user32, enumerates children, skips WebView2 hosts by
  class name (`Chrome_WidgetWin_*`, `Microsoft.UI.Content.*`, `Intermediate D3D Window`, `tauri_*`,
  `wry_*`), and resizes the remaining (mpv VO) child to the parent client area minus the title-bar
  inset.
- Windowed mode applies an MPO "poison" clip to the mpv child so it is disqualified from a hardware
  overlay plane and DWM-composites instead, which restores true black on OLED in windowed playback.
- `parent_display_refresh_hz` reads the monitor's real refresh from `DEVMODEW.dmDisplayFrequency`;
  `set_motion_interpolation` uses it to pin mpv's `display-fps-override` (an embedded `--wid` mpv
  cannot estimate refresh on its own).
- `apply_playback_perf_opts` (and `pin_process_scheduling`) clear Win11 EcoQoS execution-speed
  throttling + raise the process priority class. They NO LONGER pin `timeBeginPeriod(1)` for the
  process lifetime: 1 ms timer resolution is now demand-scoped to active playback via
  `win32::set_high_timer_resolution(bool)`, which the engine pump asserts while a file is loaded and
  releases when idle (so a menu-bound / tray Aura returns to the OS-default ~15 ms timer and idles
  deeper). It is ref-count-safe (one outstanding claim); do NOT re-pin `timeBeginPeriod(1)` at startup.

Note: the historical "off-focus frame drops" (worse with motion interpolation on) were NOT a DWM or
render-path limitation. They were root-caused to the NVIDIA Control Panel "Background Application Max
Frame Rate" setting misclassifying `aura.exe` as a background app and capping its frame rate when it
loses foreground. The fix is a per-app NVIDIA profile (or turning that global setting off); it is a
per-machine driver config, not an Aura bug, and needs no render rewrite. The opt-outs above and the
`display-fps-override` pin are sound but were never the fix for those drops.

The taskbar bleed-through on an "always show taskbar" setting is a Windows compositor heuristic limit:
auto-hide only triggers for users with "Automatically hide the taskbar" enabled. The `Shell_TrayWnd`
`SW_HIDE` workaround was tried and reverted (broke secondary-monitor tray icons). True DXGI exclusive
fullscreen would require a render rewrite and is deferred.

## Caching boundaries

Bound every cache (see Performance & memory).

- **Library**: localStorage warm-start in `App.loadLibrary` (keyed by `auth_key.slice(0, 12)`), plus
  a 5-minute focus-refetch debounce, plus a 5-minute `recentlyCleared` overlay that re-zeroes
  `state.timeOffset` for ids cleared in the last window (Stremio's `datastoreGet` is eventually
  consistent on `_mtime`, so a fresh fetch within the window can return stale non-zero state).
- **metaCache.ts** (`aura:meta-cache:v1`): TTL 4 h series/anime, 7 d movies, 90 s nulls; cap ~800
  entries (~1.5 MB); 500 ms write debounce; null entries not persisted.
- **persistentCache.ts**: generic TTL + size-capped store (AniSkip uses it at 3 days / 600 entries,
  dropping the oldest 25% on overflow; negative misses are never cached).
- **Calendar meta**: 24-hour module-level `Map` keyed by `${addonUrl}::${type}::${id}`.
- **sessionRoute.ts** (`sessionStorage`): active nav tab + open detail target so Ctrl+R/F5 restores
  the page you were on; cleared on app close (cold start opens Home).
- **Notifications** (`aura:notifications:v1`): ring buffer capped at 200 entries.
- **EPG** (`src/iptv/epgStore.ts`): localStorage, ~4-week retention, parsed off-thread in a worker.
- **Story arcs**: `aura:story-arcs:v1` (24 h TTL, cap 60) holds the joined arcs per series; the TTL is
  short deliberately because an ongoing show gains an episode weekly and a stale arc would be missing
  it. `aura:arc-mode:v1` (cap 200) remembers the Seasons/Arcs choice per series. Rust side:
  `arcs-cache-v1.json` (TMDB payloads, 24 h, cap 40) and `arc-art-v1.json` (Fandom art, 30 d, cap 60;
  an empty map is a cached MISS and is honoured, so a show with no art does not re-probe every visit).
- **Addon manifest fields**: `AddonEntry.stream_types`, `id_prefixes`, `stream_id_prefixes` are
  populated at install/sync time; `fetch_streams` reads them directly and never re-fetches manifests
  per stream request (a transient failure during that re-probe used to kill all stream lookups).

## Performance and memory (build every feature memory-conscious)

RAM discipline is a standing requirement: Aura is a long-running WebView2 + libmpv app and memory
creep degrades the experience. When adding ANY feature:

- **Bound every cache.** A module-level `Map` / object cache needs a size cap AND eviction or TTL
  (mirror `metaCache.ts`). Never ship a "never cleared" Map. Persisted blobs (localStorage) need a
  cap too.
- **Images are the top consumer.** Pass server-resize width hints (like `landscapeArt`'s `w=640`)
  instead of pulling full-size masters into small tiles; keep offscreen images unmounted (the
  `ImageLoader` IntersectionObserver pattern); virtualize / cap visible card counts
  (`useRowWindow.ts`).
- **Tear down idle native resources.** Do not keep a second resident libmpv (the thumb extractor is
  on-demand create + idle teardown). Fetch runtime binaries on demand (`runtime_deps.rs`).
- **Always clean up.** `addEventListener` / `setInterval` in an effect must return a cleanup;
  `useSyncExternalStore` subscribers must unsubscribe. And never add `get_property` polling during
  MPV state transitions (landmines).
- **Tune buffers consciously.** The demuxer read-ahead and any in-memory stream buffer have deliberate
  caps (see the engine init options); surface the UX tradeoff when changing them.

## Where to look first by symptom

- "Volume slider snaps back" / "speed does not change" -> the `set_*` Tauri commands in `lib.rs`;
  verify they submit a typed `SetProperty`, not `Command(vec!["set_property", ...])`.
- "MPV renders behind UI" / black bar at top -> `App.tsx` TitleBar `opaque` prop, body `hidden` class
  while playing, and `.aura-app-shell` background must be transparent always.
- "MPV does not fill window after fullscreen toggle" -> the engine's geometry pump in `mpv/engine.rs`
  (polls parent rect + fullscreen state every ~5 ms and resizes host + child via
  `win32::resize_mpv_child_to_parent`). `refresh_video` only does the video-zoom nudge now.
- "App crashes on play" (STATUS_ACCESS_VIOLATION) -> MPV property race; check polling and
  observed-property formats. The tail of `%USERPROFILE%\aura-mpv.log` usually pinpoints it.
- "Native browser context menu appears" -> `main.tsx` capture-phase `contextmenu` listener; must
  install BEFORE React mounts.
- "Streams from addon X do not appear" -> DevConsole filter for `[X]`; `fetch_streams` logs the
  manifest gate decisions.
- "Ratings missing/sparse" -> `ratings.rs`: the MDBList branch needs a `tt`-prefixed IMDb id and a
  non-empty `AURA_MDBLIST_KEY` (baked from `.env.local`); the MAL/AniList branch needs a resolvable
  anime id. Non-tt non-anime ids get only addon-supplied `detail.ratings`. OMDb is fully removed.
- "Skip windows missing" -> `aniskip.rs` / `publicmetadb.rs`; `AURA_PUBLICMETADB_KEY` must be baked.
- "No Seasons/Arcs toggle on an anime" -> `arcs.rs`. In order: `AURA_TMDB_KEY` baked (or a user key in
  the keyring), a resolvable TMDB id (`MetaDetail.tmdb_id`, else the `/find` by IMDb id), and a TMDB
  episode group of `type == 5` that clears the coverage bar. Most shows have no arcs at all: arcs are
  a property of long-running manga, so the toggle is *supposed* to be absent nearly everywhere.
  DevConsole `[arcs]` logs the grouping choice and the alignment score.
- "Arc shows the wrong episodes" / "arc is off by one" -> read the story-arcs section above. This is
  the failure the aligner exists to prevent; check the `[arcs]` min-score log before touching
  anything else.
- "Live Sync cue list is empty / will not scroll" -> `subsync.rs` for the cue source (bitmap PGS /
  VobSub tracks can never yield text and are a deliberate disabled state), and the non-passive wheel
  handler in the panel: the overlay's volume-wheel handler steals wheel events without it.
- "Subtitle download fails / path rejected" -> `subtitles.rs`; downloads must land in
  `app_data_dir()/subtitles` and `add_subtitle_to_mpv` enforces containment.
- "A Tailwind class has no effect" -> check the theme-scale gotchas; confirm against
  `dist/assets/index-*.css`.
- "Library page blank" -> `<ErrorBoundary scope="Library">` surfaces the render error.

## Conventions

- F12 opens the in-app DevConsole (ring buffer, level filters, search). Rust logs arrive via the
  `crate::devlog!` macro, which mirrors to stderr AND emits a `dev-log` Tauri event.
- Rust log labels to grep in the DevConsole or `aura-mpv.log`: `[bridge]`, `[player]`, `[streams]`,
  `[meta]`, `[catalog]`, `[search]`, `[subtitles]`, `[ratings]`, `[rpc]`, `[win32]`, `[smtc]`,
  `[scrobble]`, `[publicmetadb]`, `[mpv]` (the playback engine), `[cast]`, `[iptv]`, `[sync]`,
  `[aniskip]`, `[arcs]`, `[subsync]`.
- libmpv writes its own verbose log to `%USERPROFILE%\aura-mpv.log` (truncated each MPV init, rotated
  to `.old` past 50 MB). The last few lines usually pinpoint a STATUS_ACCESS_VIOLATION.
- Discord RPC uses application ID `1499651271357890610` (`window_logic.rs`). Browse states are gated
  on the `discord_rpc_browse_states` setting; playback states honor `discord_rpc_show_titles` + the
  per-title blocklist.
- Themes are driven by `data-theme` on `<html>` (round-tripped through the Rust `set_theme` command).
  The valid set lives in `ThemeEngine.tsx`; do not hardcode it elsewhere.
- No em-dashes (or en-dashes) anywhere: code comments, commit messages, UI copy, release notes,
  prose. Use a hyphen, colon, parentheses, or a sentence break.
- Any Settings-page change must be evaluated for export/import (`PORTABLE_AURA_FIELDS` /
  `PORTABLE_BACKEND_FIELDS` in `settingsTransfer.ts`) and cloud-sync sharability, to stop the drift
  that left prefs unsharable.

### Native dependencies and runtime binaries

- `src-tauri/lib/` is git-ignored (>100 MB). `libmpv-2.dll` is REQUIRED there for dev (download from
  `github.com/zhongfly/mpv-winbuild`). `libmpv-wrapper.dll` is no longer used and is actively cleaned
  up as an orphan.
- `ffmpeg` (silencedetect + cast HLS transcode), `ffprobe` (cast), and `yt-dlp` (trailers) are
  NOT bundled. They are fetched on demand from a GitHub `runtime-deps` prerelease, SHA-verified
  (`runtime_deps.rs`). Absent -> the dependent feature ships inert rather than crashing.

## Network tuning notes for power users (host-level, cannot ship from inside the app)

Most users need none of this; Aura's defaults work on a stock Windows install. Try these only on a
high-BDP link (>=100 Mbps x >=30 ms RTT) that rebuffers mid-playback despite the demuxer cache.

- **Windows** (admin `cmd`/PowerShell; inspect with `netsh int tcp show global`):
  `netsh int tcp set global autotuninglevel=experimental` (higher receive-window ceiling);
  `netsh int tcp set supplemental Internet congestionprovider=bbr2` (helps on lossy-but-fast links;
  revert with `cubic`); confirm Receive-Side Scaling is enabled; optionally
  `netsh int tcp set global ecncapability=enabled` for ECN-honoring (e.g. Cloudflare) origins.
- **Linux** (Wine / unofficial build), `/etc/sysctl.conf`: `net.core.default_qdisc=fq`,
  `net.ipv4.tcp_congestion_control=bbr`, and raise `rmem_max` / `wmem_max` / `tcp_rmem` / `tcp_wmem`
  to 16 MiB; `sudo sysctl -p`.
- **Router**: Smart Queue Management (cake / fq_codel) kills buffer bloat; a fast resolver
  (1.1.1.1 / NextDNS) speeds the cold-start DNS lookup. Aura's preheat fetch (`Range: bytes=0-65535`
  in `App.handlePlayStream`) warms the TLS session but cannot help DNS.
- **What NOT to do**: do not disable `https_only`; do not lower `network-timeout` below 60 s (debrid
  hosts can take 30+ s to mux a fresh chunk); do not watch on a Windows "metered connection" (it
  disables TCP autotuning).

## Log files and sensitive data

- `%USERPROFILE%\aura-mpv.log` (verbose libmpv) records every loaded URL verbatim, including
  `?token=` / `auth=` query params (debrid, signed CDN). Treat it like your debrid auth; redact URLs
  before sharing. The DevConsole "Export logs" button is safer (it captures only Aura's own labelled
  lines, not libmpv internals).
- `%USERPROFILE%\aura-panic.log` (Rust panic backtraces) is smaller surface (no URL leakage in normal
  operation).
- Both inherit the `%USERPROFILE%` DACL, which on a default install grants only the owning user (plus
  Administrators / SYSTEM). Aura does not tighten the DACL beyond inheritance (admin-level threats
  cannot be defended from user space). On an unusual `%USERPROFILE%` ACL, redirect the data dir via
  `LOCALAPPDATA` or run
  `icacls "%USERPROFILE%\aura-*.log" /inheritance:r /grant:r "%USERNAME%:F"` after first launch.

## Docs to consult

- `ROADMAP.md` for feature phases (note: it stops around 5.8 and many "TODO" items there have since
  shipped; trust the code over the roadmap).
- `src-tauri/permissions/player.toml` + `src-tauri/capabilities/default.json`: the permission ledger,
  and the usual silent failure mode for a new command.
- `docs/research/` for one-off forensic deep-dives (e.g. the off-focus frame-drop analysis).
