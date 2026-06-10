# Engine consolidation — one mpv engine: direct FFI driving `--wid`

> **Status:** implemented on `feat/engine-consolidation` (2026-06-10), pending hardware smoke test.
> **Supersedes:** `2026-06-03-mpv2-hdr-dxgi-interop-design.md` (the DXGI/`WGL_NV_DX_interop2` HDR plan) and `2026-06-02-d3d11-hdr-passthrough-deferred.md` — both solved problems the render-context path created for itself; with the render path gone they are moot.
> **Decision trail:** per the hybrid-player-engine spec (`2026-06-09-hybrid-player-engine.md`), the HTML5 `<video>` backend was confirmed not worth building on Windows-only Aura. The user then decided: drop the mpv2 *renderer* entirely and reuse the already-written FFI for the `--wid` path — avoids bundling `libmpv-wrapper.dll`, keeps one engine, leaves presentation optimisation for later.

## What changed

One engine remains: `mpv2::engine`, the direct-FFI (`libmpv-2.dll` via `mpv2/ffi.rs`) instance that previously drove `mpv_render_context_*` into a WGL surface. Its video-out is now classic `--wid` embedding:

- The engine thread still owns a Win32 **host child window** under the Tauri main HWND (black class brush, `HWND_BOTTOM` below the WebView2, `WS_CLIPCHILDREN`), but no WGL/GL context. mpv gets `wid=<host hwnd>` pre-init and creates its own child + d3d11 swapchain inside it.
- `vo=gpu-next` (the renderer the legacy plugin path always used). Under the d3d11 GPU context, `target-colorspace-hint=yes` is honoured → **"passthrough" HDR mode is real HDR/DV passthrough now**, which the render API could never reach (`vo=libmpv` is hardcoded to `gl_video`).
- The render loop became a **pump loop** (5 ms tick): drain mpv events → drain the command channel → geometry resync → visibility telemetry. All PresentMode machinery (swap-interval, report_swap, framedrop policy) is gone; mpv owns presentation. `PresentMode` survives as telemetry-only for the debug panel.
- **Geometry**: the engine polls the parent's client rect + `win32::is_in_native_fullscreen()` per tick; on change it `SetWindowPos`es the host (title-bar inset 36 px windowed / 0 fullscreen) and snaps mpv's inner child via `win32::resize_mpv_child_to_parent(host, 0)`. mpv's child is created at the host's current (always-correct) size, so first-frame geometry is right by construction. The degenerate-rect guard skips minimised 0×0 states (the old "restore lands on a dead vo" landmine).
- **The FSO 1px inset + App.tsx black strip are removed**: mpv's own DXGI swapchain opts out of Win11 Independent-Flip/MPO promotion (`SetFullscreenState(FALSE)`), which is why the original legacy child never had the UI-vanish problem.
- **Teardown** (engine thread, joined from `CloseRequested` via the message-pumping join): mute → stop → `mpv_terminate_destroy` → `DestroyWindow(host)` — the WASAPI-release discipline formerly in `window_logic::shutdown_mpv_sync`.

## What was removed

- `tauri-plugin-libmpv` (Cargo dep, `.plugin()` registration, `libmpv:default` capability) and with it the `libmpv-wrapper.dll` runtime requirement. `check_mpv_dll` now only pre-flights `libmpv-2.dll`.
- `player::init_mpv` (its option set moved verbatim into the engine's `INIT_OPTS`, plus settings-gated audio passthrough, `volume=50`, subtitle styling defaults, and the `aura-mpv.log` log-file + rotation — restoring legacy parity the render engine lacked).
- `mpv2::hello` (Phase-1 render-API scaffolding) and every `enabled()`/legacy dual-path gate in lib.rs / window_logic / subtitles / cinema / aniskip / debug_panel. `AURA_MPV2` is parsed-but-ignored with a startup warning.
- The window_logic Focused/Resized resize backstops (engine self-resizes) and the explicit resize calls in `set_native_fullscreen` / `refresh_video` (the latter keeps only the video-zoom nudge).

## Deliberate behaviour holds (not regressions)

- **AniSkip Lua stays dormant.** The mpv2 engine never loaded `skip-windows.lua` (since v0.9.0); the React-side skip logic is what users exercise. The installer/loader code was deleted; the lua file + `user-data/aura/skip-windows` writes remain.
- **Off-focus DWM throttling of the `--wid` child returns** (the original motivation for the render rewrite). Accepted per the user's decision; the FFI foundation is the basis for optimising presentation later.

## Hardware smoke checklist

1. Playback start/stop/seek/pause/volume/speed/tracks/subtitles (every command now routes through the engine channel unconditionally).
2. Windowed ↔ native fullscreen toggles: video fills, no 36 px drift after alt-tab, no taskbar regressions, **no UI-vanish / vivid colours in fullscreen** (FSO inset removed — verify the promotion really doesn't fire with mpv's swapchain).
3. HDR: "Passthrough" on an HDR display actually lights up HDR; "Tone-map for SDR" unchanged.
4. Minimise → restore mid-playback (degenerate-rect guard).
5. Clean exit: WASAPI released (other apps can play audio after a play → close cycle), `aura-mpv.log` written.
6. Hover thumbnails still work (thumb engine untouched, shares the FFI loader).
7. Audio passthrough setting (if equipment available) applies at init.
