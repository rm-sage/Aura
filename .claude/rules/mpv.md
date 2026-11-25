---
paths:
  - "src-tauri/src/mpv/**"
  - "src-tauri/src/player.rs"
  - "src-tauri/src/cinema.rs"
  - "src-tauri/src/subtitles.rs"
  - "src/PlayerOverlay.tsx"
  - "src/realGlass.ts"
  - "src/SubtitlePicker.tsx"
  - "src/SubtitleSyncPanel.tsx"
  - "src/subtitleLift.ts"
---

# The mpv engine and its landmines

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/mpv/*, the playback commands in src-tauri/src/lib.rs, win32.rs, any frontend code that reads mpv properties (PlayerOverlay.tsx, App.tsx track / chapter reads).

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
  the landmines below: extending this set carelessly kills the ENTIRE event channel.
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
   `onPointerDown` and **defers the real drag to the first `pointermove` past a 4px threshold** - a
   plain click / double-click then never starts a drag and reaches the webview as ordinary
   click / dblclick (native `onDoubleClick` -> `toggleMaximize`, no synthesis needed). Past that
   threshold the path forks by OS: Windows 11 (and any non-Windows / maximized window) calls
   `getCurrentWindow().startDragging()` (native caption drag, keeps Aero Snap); **Windows 10 uses a
   custom coalesced pointer-drag** (`setPointerCapture` + one `setPosition` per rAF) because the
   native modal loop recomposites the transparent WebView2 + mpv d3d11 child on every move step and
   stalls on Win10's older DWM + weak GPUs (window crawls behind a captured cursor). The gate is the
   `is_windows_10` command (`win32::is_windows_10`, `RtlGetVersion` build < 22000, the WebView2 UA
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
11. **Never hand mpv a remote URL for `sub-add`, and never let anything slow run on the engine
    thread.** The engine thread executes every mpv FFI call INLINE inside its command drain, and
    that drain runs to completion BEFORE `drain_mpv_events`. It is therefore the sole producer of
    `playback-update` and `cache-state`. Anything that blocks it freezes the clock, the scrubber,
    the pause icon, the buffer readout and the geometry pump, while mpv itself keeps decoding on its
    own threads, so the picture keeps moving and only the UI looks dead. `sub-add <https url>` makes
    libmpv do the HTTPS GET synchronously inside `mpv_command`: measured 1.4-3.2 s per subtitle, and
    a burst of picks blocked the pump for 9.07 s continuously. `subtitles.rs` now downloads to
    `app_data_dir()/subtitles` first and passes mpv a LOCAL path. Two corollaries: keep
    `submit_get_property`'s `recv_timeout` (a bare `recv()` parks the caller forever behind a wedged
    command), and remember that a stalled pump silently disarms App.tsx's stream-lost watchdog
    escape hatches -- `paused` and `lastBufferProgressAtRef` are fed by the SAME pump, so a long
    block can raise a "stream connection lost" modal on a perfectly healthy stream.

## Real glass over video (`mpv/glass.rs`, `mpv/aura_glass.glsl`, `src/realGlass.ts`)

**SHELVED (2026-11-18) behind `REAL_GLASS_AVAILABLE = false` in `src/realGlass.ts`.** After four
tuning rounds the user still reported it as "very off" over real video: dark spots on the lifted
glass, brightness (reported as too bright before the cap / lift retune below), and, after round 4,
horizontal banding / striping across the control bar. With the flag false the Settings row is hidden (so it is out of Settings
search too), the "New look options" notice does not name it, the player hook never measures, never
marks a surface `data-real-glass="on"` and NEVER invokes `player_glass` (no enable, update, clear or
status), even when `render.json` still holds `real_glass: true` from an earlier opt-in. The engine
loads the shader only on the frontend's `enable`, so `GlassState::path` stays `None` and every engine
path (`EnsureLast` after an upscaler change, the pump, the `vo-passes` check) is a no-op. Everything
else is KEPT, unchanged: the Rust command and its three registration sites, the shader and its
tests, the `real_glass` field in `render.json`, the `sync.ts` machine-local strip / pin, and the
`data-real-glass` CSS (dormant). Re-enabling is that one flag, but look at the real app over real
video first: the striping was never measured or explained (the dither note below is reasoning from
libplacebo's source, not a measurement), so find its source before another tuning round.

The rest of this section describes the feature as it is with the flag on.

An opt-in, OFF-by-default, MACHINE-LOCAL experiment (`real_glass`, kept in `render.json`, stripped
in `sync.ts`, not portable). An mpv user shader on `//!HOOK OUTPUT` blurs (dual-Kawase pyramid),
soft-caps bright luminance, adds a small white lift (a lit material) and lifts saturation (in linear
light) the live video under up to 4 rounded rects, and in the Liquid style bends it inward at the
rim (Frosted: `glass_refract` 0). The web layer keeps the rim, shading and content and drops most of
its baked fill only on surfaces marked `data-real-glass="on"`. The Settings row lives in Settings >
Appearance & Window > Theme, after Material style / Cursor glow; on High Contrast themes it can be
turned off but not on. Measured on this libmpv build by the ignored test `glass_shader_tests.rs`
(`cargo test --lib glass_shader_runtime -- --ignored --nocapture`): 0 px placement error, ~35 us at
1080p, no recompile per update.

**The cost that shapes everything:** every `glsl-shader-opts` change runs `update_render_options()`,
which on this build ends in `want_reset`: the renderer flushes its mixing cache and peak detection.
With HDR + `hdr-compute-peak` + interpolation that measured as about ONE late frame per update. So:

1. **The shader file** is embedded (`include_str!`) and written to
   `app_data_dir()/shaders/aura_glass_v3.glsl`. Its basename IS the option-key prefix
   (`aura_glass_v3/glass_n=...`), and mpv caches a parsed shader by PATH for the VO's life: a changed
   shader needs a new versioned name (`glass::SHADER_NAME`); `write_shader` deletes
   `aura_glass_v1.glsl` and `aura_glass_v2.glsl` best-effort. Loaded with `change-list glsl-shaders
   append` (forward slashes, `\\?\` stripped, landmine 8), LAST; removed with `change-list ... remove`.
   `cinema.rs` clears the list on every upscaler change: the engine sees the `clr` / `set`, re-appends,
   and `set_shader_profile` sends `GlassCmd::EnsureLast` to move it back to the end.
2. **One `change-list glsl-shader-opts add "<FULL key set>"` per update** (mpv resets every param it is
   not given), deduplicated against the last string, never per frame. Sent only on controls show /
   hide, menu open / close and layout change (the frontend coalesces to one rAF, layout after a 100 ms
   debounce). A real window resize or fullscreen switch turns the glass off (n = 0) until the geometry
   has held still 250 ms and the video rect was re-read.
3. **Never blocking the engine thread:** every glass command goes through `mpv_command_async`
   (`ffi.rs`, userdata `glass::REPLY_ID`); its `MPV_EVENT_COMMAND_REPLY` is drained and only an error
   is logged. A synchronous send waits 6 to 9 ms on the VO thread while playing (landmine 11). Async
   and sync commands share the core's one FIFO queue, so ordering holds.
4. **Coordinates:** `x = css_x*dpr - max(ml,0)`, `y = css_y*dpr - inset - max(mt,0)`, where `inset` is
   the host's top offset in PHYSICAL px (`TITLE_BAR_H` 36 windowed, 0 fullscreen; it is applied to
   `GetClientRect`, so it is NOT scaled by the DPR). `ml` / `mt` / `mr` / `mb` / `w` / `h` come from
   `osd-dimensions/*` (double sub-paths), `glass_ow` is the clipped output width, and `glass_pq` /
   `glass_gamma` from `video-target-params/gamma` (string: `pq` -> PQ, `bt.1886` -> 2.4, else 2.2).
   All reads are gated like the cache poll (file loaded, first frame, no seek, past the settle window,
   window shown) and happen only when invalidated: load / START_FILE / VIDEO_RECONFIG and a resize
   (glass off until re-read), a write to a property that moves the video (`glass_moves_video`, an
   explicit list: `video-sync` must not trigger it; re-read 120 ms later while the cached rect stays in
   use, because `refresh_video` nudges `video-zoom` there and back six times after every load) or to a
   `target-*` / tone-mapping property. Never observed (landmine 4). **Never read in the tick of the
   invalidating event**: `osd-dimensions` come from the last OSD render and `video-target-params` from
   the last drawn frame, so a same-tick read returns the OLD geometry / transfer and then caches it
   (a wrong `glass_ow` draws nothing while the surfaces still drop their fill). A resize reads only
   after the 250 ms hold, a load / reconfig 150 ms later, a target write 250 ms later.
5. **Fade:** the shader's fade runs on source `PTS`, which freezes while paused. A hide while playing
   fades 0.47 s from 30 ms on (scaled by speed: matched to the bar's 500 ms CSS opacity fade, so its
   text never fades over raw video) and drops the rects 0.75 s later; a hide while paused is
   immediate; a show always snaps in under the CSS fade. A frame more than 0.5 s before the fade start (a seek back)
   counts as a finished fade.
6. **Screenshots** (`screenshot-to-file ... window`) render WITH the user shaders: the engine sends n = 0
   (async, ahead of the synchronous screenshot in the same queue) and restores the last state after.
7. **Failure:** libplacebo silently disables a hook it cannot compile. 1.5 s after the first live send the
   engine reads `vo-passes` (string, gated) for `aura glass composite`; missing once, it drops the
   `glass_ow` guard (a rounding pixel) and retries; missing 3 times, it removes the shader, logs under
   `[mpv]`, and the Settings row says "Not available on this system" (the surfaces keep their fill).
   The read waits on the VO thread, so it runs once per enable: a later player mount neither retries
   a failure nor re-checks a pass; turning the setting off and on does both.

Letterbox / pillarbox bars are drawn AFTER the OUTPUT hook, so the shader cannot cover them: a
surface less than half over the video keeps its CSS fill and is NOT sent (so it is never shaded
under the fill), and Rust also skips a rect wholly over the bars. Legibility: the shader soft-caps
the blurred backdrop luminance (`glass_cap`, linear, relative to SDR white; PQ x `glass_white_nits`)
and lifts saturation (`glass_sat`). Order in the shader is dim -> cap -> lift -> sat. `glass_dim` is
1.0 (dark and mid pass through); `glass_lift` is an additive white lift after the cap (`l +
lift*(white - l)`, PQ white = `glass_white_nits`). `glass::look`: Frosted dim 1.0 / cap 0.15 / lift
0.002 / sat 1.30 / blur k, Liquid 1.0 / 0.14 / 0.004 / 1.50 / blur k*0.8 (lighter frost so video
reads softened rather than erased; the pyramid floor is about 8 px even at `glass_blur` 0). The CSS
face (`styles/glass-misc.css`: Frosted a FLAT black 0.045, Liquid only a FLAT white sheen 0.03 with a
lit rim; a vertical ramp stepped into horizontal bands over the smooth blur) and the vignette
(`.aura-player-vignette`, an eased smoothstep ramp scaled by `--aura-vignette-a`: 0 instead of 0.75
under `:has(~ * .aura-player-bar[data-real-glass=on])`) are tuned together with them: change all
three together. Modelled (the runtime test's `sdr_capped` math plus the CSS face, encoded /255):
a white frame lands at about 103 Frosted / 110 Liquid at 2.2 (111 / 118 at bt.1886), white text
about 5.6:1 / 5.1:1 (5.0:1 / 4.5:1 bt.1886) before the text shadow; a black frame at about 28
Liquid. The old cap 0.22 / 0.20 and Liquid lift 0.010 with a 0.05..0.02 sheen measured 123 / 130
over white (4.2:1 / 3.8:1) and 39 over black (a flat mid grey): reported as too bright. The bar's dim
12 px time text (white 0.55) is raised to white 0.8 under real glass (`.aura-player-time-dim`). The
optional next knob if mid-tone scenes still read bright is `dim` 1.0 -> 0.85. Under real glass the
web layer also drops what was tuned for the opaque bar and read as DARK SPOTS on the lifted glass:
the 8 px text halo (now one tight `0 1px 2px` 0.5 shadow), the wider icon drop shadow, the Liquid
flat buttons' dark tint and drop, the upscaler pill's dark pool, and the menu wells' deep insets
(lighter `.aura-glass-field` / `.aura-glass-seg`); and the cursor glint is OFF on real-glass
surfaces and their descendants (`glassGlint.ts` `usable()` skips `[data-real-glass="on"]`, plus a
CSS override): its 8-bit light and grain disc banded into rings over the blur. Banding from the
shader itself is unlikely: libplacebo runs the OUTPUT hook BEFORE `sh_dither` (renderer.c
`pass_output_target`), and this libmpv defaults to `dither-depth=auto`, `dither=fruit`; Aura sets
no dither option, and the pyramid textures are `fbo-format=auto` (16f on d3d11). The cap was
measured against its model by the runtime test at the OLD values (bt.1886 probe: Frosted 0x80
0.5020 -> 0.4958, 0xD0 0.8169 -> 0.5351; Liquid 0.4924 / 0.5195; each within 0.0003 of the model,
2026-11-18); it reads `look()`, so a rerun checks the new values. High Contrast themes
(`--lg-glint-off: 1`) never get the light face and send nothing. The engine emits `glass-state`
(`player-glass-state` to the frontend) with `active`, `available` and the video rect in CSS px
(whenever it is known, not only while drawing: it decides which surfaces are sent; the frontend
forgets a stale `active` when its last listener goes); the frontend clears the rects when the player
unmounts, while casting, before the first frame and when the setting is off. Not runtime-tested yet
in the real app: HDR anime with motion smoothing while the controls toggle, 150 % scaling, and the
web-rim vs glass lag (about 30 ms).

Subtitles: `blend-subtitles` is never set (lead decision), so mpv draws subs and OSD as target
overlays after libplacebo's OUTPUT hook; they stay crisp above every glass rect and keep the
letterbox bars. `blend-subtitles=yes` would bake them under the hook only through the interpolation
mixing cache, so they would cross-fade with interpolation and move off the letterbox bars. A
screenshot (`pl_render_image`, no mixing) always shows crisp subs, so it cannot test this.

Subtitle lift (`PlayerOverlay.tsx`, math in the import-free `src/subtitleLift.ts`
`subtitleLiftTarget`): while the controls show, the lift is only what the bar needs. With
`limit = 100 * (barTop - hostTop - 12) / hostH` (the sub-pos whose bottom edge sits 12 px above the
bar), `sub-pos = baseline` when `baseline <= limit` (no lift: subtitles already above the bar never
move), else `floor(limit)` (exactly enough to clear it), clamped to mpv's 0..150. There is no
minimum lift any more (it was `baseline - 12` at least, which made high subtitles jump for nothing).
Measured from the `.aura-player-bar` rect (`hostTop` is the 36 PHYSICAL px inset, so 36 / dpr CSS px
windowed, 0 fullscreen; `hostH = innerHeight - hostTop`); with no usable rect (no bar, `hostH <= 0`,
bar above the host top) it falls back to the old fixed `baseline - 12`. Re-measured on window resize
(a DPI change included) and bar resize. The drop back to the
baseline waits 520 ms (the bar's 500 ms fade and the shader's 0.47 s fade) and is cancelled if the
controls return. `liftTargetRef` holds the value last sent, and the seek /
`aura:subtitle-style-applied` re-asserts read it. DOM rects only, no `get_property`. While the Subtitle style menu is
open (`SubtitleStyleMenu` `onOpenChange`, PlayerOverlay `subStyleOpen`) the lift skips the bar clamp and sends
`max(0, baseline - 12)`, so each Vertical position step shows; closing re-applies the measured clamp.
