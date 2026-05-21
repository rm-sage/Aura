# Aura — mpv_render_context Render-API Rewrite (feasibility + plan)

Status: DRAFT (2026-05-20). Branch `feat/render-api-rewrite` (rebased onto post-v0.8.0 main). **No code changes yet — architectural review wanted before any deps are added.**

## Motivation

Off-focus frame drops are the user-facing target. Root cause is architectural (documented in the v0.8.0 merge commit on main and in branch memory): DWM throttles presentation of the `--wid` child-HWND swapchain mpv currently owns whenever Aura is not the foreground window. Two evidence-based fixes were tried in the v0.8.0 cycle:

1. `win32::pin_process_scheduling` — `timeBeginPeriod(1)` + `ABOVE_NORMAL_PRIORITY_CLASS`, held for process lifetime. **Kept** — correct-and-complete remedy for the process-level timer/priority throttles, but proven insufficient on its own (drops persist).
2. `d3d11-flip=no` (BitBlt swap effect). **Reverted** in 82949d4 — did not fix drops AND caused the "paused frame deleted on menu/right-click while unfocused" regression because BitBlt has no retained surface when mpv is idle.

The remaining mechanism — DWM gating Present on a non-foreground composited window's swapchain — is unreachable from any mpv option or process knob. Three independent investigations converged on the same conclusion: it's architectural, the only real fix is to stop having mpv own the swapchain.

## The fix

Move mpv to **render-context mode**:

- `mpv_render_context_create(...)` returns a render handle that we drive ourselves.
- mpv renders frames into a GL (or D3D11) texture **we** provide, on **our** schedule (we call `mpv_render_context_render(...)` when we want a new frame).
- **Aura owns the swapchain.** Our Win32 child window (replacing the `--wid` child) has our own swapchain that we Present from a timer-pinned loop in our process.

Off-focus frame drops disappear because mpv's display-resample loop is no longer racing a DWM-governed child swapchain — it's just rendering frames into a texture on demand. We control present cadence directly.

## Feasibility — wrapper inspection (2026-05-20)

Read `~/.cargo/registry/src/index.crates.io-.../tauri-plugin-libmpv-0.3.2/src/wrapper.rs`. The only FFI symbols the wrapper (libmpv-wrapper.dll, from github.com/nini22P/libmpv-wrapper) exports:

- `mpv_wrapper_create` → returns `*mut MpvHandle`
- `mpv_wrapper_destroy`
- `mpv_wrapper_command`
- `mpv_wrapper_set_property`
- `mpv_wrapper_get_property`
- `mpv_wrapper_free`
- event-callback registration via the create call's userdata

**Zero `mpv_render_context_*` symbols.** The wrapper was designed for `--wid` embedding only. Render context is not reachable through the current plugin.

## Two paths forward

### Option A — Direct FFI to `libmpv-2.dll`, bypass the wrapper (RECOMMENDED)

Replace `tauri-plugin-libmpv` with a direct Rust binding to libmpv's standard client.h + render.h C API. Crate options to evaluate:

- **`libmpv-rs`** (crate name `libmpv`, current cached version 2.0.1 from ParadoxSpiral). Has a `render` feature declared but the `src/mpv/render.rs` in 2.0.1 is empty (license header only). May need a fork or a newer version. Repo: github.com/ParadoxSpiral/libmpv-rs. README claims libmpv 1.101+ (mpv 0.29.1+) supported; our mpv is v0.41 so should work for client.h.
- **`libmpv-sys`** (raw bindgen FFI). Used by libmpv-rs internally. Lowest level; we'd build our own thin wrapper. Did not investigate cache (not present locally).
- **Hand-rolled FFI via `libloading`** (matches how win32.rs already pulls user32.dll / winmm.dll symbols at runtime). Most surgical; no new dep, just declare the function signatures we need from libmpv-2.dll. Pros: full control, no version-skew risk against an upstream crate that may lag mpv. Cons: ~30-50 function signatures to declare; some are awkward (variadic-style `mpv_render_param[]`).

**Recommendation: hand-rolled libloading FFI.** Matches the codebase's existing pattern (win32.rs already uses libloading for user32/winmm/kernel32), no version-skew risk, no new transitive deps. We're forced to learn the C API closely anyway — owning the bindings keeps the surface tight.

#### Migration scope (Option A)

Files heavily impacted:
- `src-tauri/Cargo.toml` — remove `tauri-plugin-libmpv`; keep `libloading` (already present).
- `src-tauri/src/lib.rs` — every `app.mpv().command(...)` → `mpv_service::command(...)` (new module). Tauri command handlers all reroute. Event channel reimplemented.
- `src-tauri/src/player.rs` — `init_mpv` becomes our own mpv-create + initialize + DLL probe + WGL context create + `mpv_render_context_create` + Win32 child window create. The `--wid` option is removed.
- `src-tauri/src/win32.rs` — `resize_mpv_child_to_parent` still applies (we still resize a child HWND), but the child is now WGL-owned not mpv-owned. The `signal_fullscreen_to_shell` and native-fullscreen paths are unchanged.
- `src-tauri/permissions/player.toml` + `src-tauri/capabilities/default.json` — the registered command names stay the same from the frontend's perspective, so no edits expected.
- **Frontend (src/) — essentially untouched.** The Tauri command surface (`load_video`, `set_property`, `toggle_pause`, etc.) keeps the same names and shapes; only the Rust implementations change. This is a strict requirement: the rewrite must be a backend-only swap.

Files lightly impacted: removing `libmpv-wrapper.dll` from `src-tauri/lib/` and the DLL-probe in `player.rs::check_mpv_dll`.

### Option B — Fork the C wrapper, add render-context exports

Fork github.com/nini22P/libmpv-wrapper, add `mpv_wrapper_render_context_create / render / set_update_callback / free / get_proc_address` and the GL function-pointer trampoline. Rebuild libmpv-wrapper.dll. Then fork `tauri-plugin-libmpv` to expose the new symbols.

Pros: minimal disruption to existing `app.mpv().X(...)` call sites.

Cons: maintaining a fork of a C library + Rust plugin indefinitely (two repos vs zero). Bridging GL function-pointer callbacks across the C boundary is non-trivial. **Worse engineering hygiene than the clean direct-FFI path of Option A.**

## GL context — Windows specifics

mpv's render context accepts either an OpenGL or Vulkan/D3D11 context. On Windows the practical choices:

- **OpenGL via WGL + a Win32 child window we own (RECOMMENDED).** Cleanest. mpv's render-context GL path is the most battle-tested (Plex, IINA, official mpv test apps). We create a child HWND under the WebView2 parent (exactly where the `--wid` child sits today), bind WGL to it, hand its `get_proc_address` to mpv, and call `mpv_render_context_render(...)` per frame.
- **OpenGL via EGL+ANGLE.** mpv supports this (mpv's `--gpu-context=angle`). More portable but more moving parts. Reserve as a fallback if WGL fails on a specific GPU/driver combo (e.g., RDP sessions).
- **D3D11 native.** mpv's libplacebo can render directly to D3D11 textures, but the integration surface is less documented and the official render API doesn't natively bridge to D3D11 (the user code typically uses `MPV_RENDER_API_TYPE_OPENGL` and shares an interop surface).

**Recommendation: native WGL + a Win32 child HWND we own.** Behaviorally identical to today's architecture (still a child HWND beneath the transparent WebView2) — only the swapchain ownership changes from "mpv" to "Aura". WebView2 transparency stays as-is. No shared-texture-into-WebView2 (that's bleeding-edge and risky).

## Phased plan

**Phase 0** (this commit): feasibility + architectural plan. **No code changes.**

**Phase 1 — bindings scaffold + minimal hello-world.** Add the libloading FFI declarations for libmpv-2.dll's client.h + render.h symbols. Create a Win32 child window, bind WGL, call `mpv_create / mpv_initialize / mpv_render_context_create`, render a single frame of a static color clear. No file loading yet. Verify on the user's hardware before proceeding.

**Phase 2 — port `init_mpv` + `load_video`**. Just enough to play a stream into the new child window with no other features wired. Confirm off-focus drops are gone.

**Phase 3 — port observed properties + the event channel.** All property change emits to the frontend must work as today (pause / time-pos / duration / volume / speed; no additions — landmine #4).

**Phase 4 — port all the property setters Aura uses.** Volume, speed, audio-track, subtitle-track, glsl-shaders, video-zoom, audio-loudnorm, motion-interpolation toggle, panscan, HDR options, etc. (full grep of the codebase for `app.mpv().set_property` / `command`).

**Phase 5 — port `win32::resize_mpv_child_to_parent`, fullscreen, refresh_video.** Adapt for our owned child HWND.

**Phase 6 — regression test against the v0.8.0 feature set.** Off-focus playback is the primary acceptance criterion. EOS Spotlight, HDR, shaders, hwdec, fullscreen, scrubber thumbnails, all property toggles.

**Phase 7 — delete `libmpv-wrapper.dll` + tauri-plugin-libmpv dep**. Update DLL-probe + README + HANDOFF.md.

## Decisions (LOCKED — user-approved 2026-05-20)

1. **Direct FFI to `libmpv-2.dll` (Option A).** Bypass the wrapper entirely. Confirmed.
2. **WGL** + an Aura-owned Win32 child HWND (replacing the `--wid` child) as the GL context. ANGLE-EGL stays a fallback only if WGL fails for a specific user/GPU.
3. **Off-focus frame drops are the primary goal — AND broader improvements the rewrite enables are explicitly in-scope and to be prioritized.** Per the user: any architecture wins that fall out of owning the render path (cleaner shader pipeline, direct HDR display-tonemap control, removing the focus/resize `SetWindowPos` storm, simpler fullscreen) should be taken, not deferred. Don't treat this as a minimal port — treat it as the chance to do the render layer right.
4. **Hand-rolled `libloading` FFI** (no upstream wrapper crate, no new deps). Done — see Phase 1 below.

## Progress

- **v0.8.0 released** (2026-05-20), signed, published to GitHub (https://github.com/rm-sage/Aura/releases/tag/v0.8.0), latest.json uploaded.
- Branch `feat/render-api-rewrite` rebased onto post-v0.8.0 main.
- Wrapper feasibility spike: confirmed `tauri-plugin-libmpv 0.3.2` exposes NO render-context symbols.
- **Phase 1 (FFI bindings foundation) DONE.** New `src-tauri/src/mpv2/` module: `ffi.rs` (raw FFI — opaque `mpv_handle`/`mpv_render_context`, the 6 enums as `#[repr(transparent)]` newtypes, all `#[repr(C)]` event/render/node structs, 28 `unsafe extern "C"` fn typedefs for client.h + render.h, and a `Libmpv` loader mirroring win32.rs's libloading pattern + player.rs's DLL-search) and `mod.rs`. Transcribed verbatim from mpv `master` headers (`client.h` API v2.5, `render.h`, `render_gl.h`) so the `#[repr(C)]` layouts are ABI-exact. `#![allow(dead_code)]` — additive, compiles via `mod mpv2;` in lib.rs, runtime behavior of the app unchanged. `cargo check` exit 0.
- **Phase 1 runtime half (render-context hello-world) IMPLEMENTED — awaiting on-hardware verification.** New `src-tauri/src/mpv2/hello.rs` (Windows-only, ~470 lines): on its own `aura-mpv2-hello` thread it creates a Win32 child window under the main HWND, picks a pixel format + builds a legacy WGL context, then `mpv_create` / `set_property_string("vo","libmpv")` / `mpv_initialize` / `mpv_render_context_create` (two-tier `get_proc_address`: `wglGetProcAddress` → `GetProcAddress(opengl32.dll)`, with the `1/2/3/-1` ICD sentinels rejected), runs a 6 s render loop (3 s static teal clear, then 3 s of `mpv_render_context_render` into FBO 0 with `FLIP_Y`), drains the mpv event/log channel into the DevConsole, and tears everything down (render-context-free while GL still current → `terminate_destroy` → WGL/DC/window). Opt-in via the `AURA_MPV2_HELLO` env var — wired in `lib.rs` setup right after "MPV engine ready"; a normal launch is a no-op. `windows` crate gained the `Win32_Graphics_OpenGL` / `Win32_Graphics_Gdi` / `Win32_UI_WindowsAndMessaging` / `Win32_System_LibraryLoader` features (no new crate). `cargo check` + `tsc --noEmit` both exit 0.

## Next — verify Phase 1 on hardware, then Phase 2

**Verification (do this before Phase 2):** run `AURA_MPV2_HELLO=1` `pnpm tauri dev`. Expect, in the DevConsole `[mpv2]` source: child window created → WGL context current with a real `GL_VERSION`/`GL_RENDERER` → libmpv loaded → `mpv_render_context_create OK` → `first mpv_render_context_render → OK`, plus `mpv/...` log lines → clean teardown. Visually: a 480×270 teal panel inset 64 px from the main window's top-left for ~3 s, then mpv takes over the framebuffer for ~3 s, then it disappears. Any step failing logs the reason and the loop falls back to teal-only so the WGL layer is still confirmed.

Once that run is confirmed, Phase 2 ports `init_mpv` + `load_video` for minimum-viable playback (and is the point off-focus drops can first be measured).

### Phase-1 implementation notes (refinements, 2026-05-21)

- **Do NOT use `glutin`/`winit`** or any windowing/GL framework — they own the window + event loop and will fight tao/WebView2. We create our own child HWND.
- **Win32/WGL/GDI side → use the `windows` crate** (already a dep — `windows = "0.61"`; `win32.rs` uses it for COM). Add the `Win32_Graphics_OpenGL`, `Win32_Graphics_Gdi`, `Win32_UI_WindowsAndMessaging` features (no NEW crate). `ChoosePixelFormat` / `SetPixelFormat` / `wglCreateContext` / `wglMakeCurrent` / `SwapBuffers` / `CreateWindowExW` etc. come from there, type-safe. **Hand-rolled `libloading` FFI stays ONLY for libmpv-2.dll** (`mpv2/ffi.rs`, already done) — that correction supersedes the over-broad "hand-rolled FFI" in question 4 above, which was really about the libmpv bindings.
- **`get_proc_address` callback for `mpv_opengl_init_params` must be two-tier**: try `wglGetProcAddress(name)` first (extension / non-core-1.1 functions); on null **fall back to `GetProcAddress` on `opengl32.dll`** (core GL functions — `wglGetProcAddress` does NOT return these). Harden the wgl check against the `1/2/3/-1` "no such function" sentinels some drivers return, not just NULL. The callback must run on the thread holding the current GL context (it will — mpv invokes it inside `mpv_render_context_create`, called after `wglMakeCurrent`).
- **`mpv_render_param[]` arrays MUST be terminated** with a `{ type: MPV_RENDER_PARAM_INVALID (0), data: null }` sentinel — they are 0-terminated, not length-prefixed; omitting it → read past bounds → `STATUS_ACCESS_VIOLATION`. Same rule for mpv node/command arrays.
- **One dedicated render thread.** The GL context, `mpv_render_context_create`, and every `mpv_render_context_render` call live on a single non-UI render thread. mpv's render API is update-callback-driven: `mpv_render_context_set_update_callback` signals "new frame available", and `mpv_render_context_report_swap` after each Present is mpv's vsync-timing channel — that pair shapes the loop, don't poll blindly.
- **Dual-mode present loop.** Focused: vsync-blocked `SwapBuffers` (swap-interval 1) — the vblank wait is the clock. Unfocused: DWM throttles a non-foreground window's present, so present unthrottled (swap-interval 0) and pace `render` + `report_swap` from a precise timer so mpv's timing model stays fed steadily regardless of DWM — this is the actual off-focus-drop fix. `win32::pin_process_scheduling`'s held `timeBeginPeriod(1)` makes that timer reliable; a ~15-line sleep-then-spin is enough (or the `spin_sleep` crate).
- **Context version**: a legacy `wglCreateContext` context is usually enough for mpv's GL renderer (compat profile), but if mpv rejects it, the modern path is `wglCreateContextAttribsARB` (itself an extension — needs a throwaway context first to load it). The hello-world frame is where this gets confirmed.

## CLAUDE.md landmine implications (carry-forward)

The existing MPV landmines apply to the **main** mpv instance, which is what's getting rewritten. Most should resolve naturally under the new path because the wrapper is gone:

- **Landmine #1** (`set_property` vs `command("set_property", …)`): becomes irrelevant — we call libmpv's C API directly, which has separate `mpv_set_property` / `mpv_command` entrypoints.
- **Landmine #3** (no polling `get_property` during state transitions): still applies in principle (libmpv has internal critical sections); we keep the existing "gate polling on duration > 0" discipline. The thumb instance's seek-confirmation polling pattern (added in 837f850) is the template.
- **Landmine #4** (observed_properties locked to `pause / time-pos / duration / volume / speed`): may relax under direct FFI since the locked set was a symptom of the wrapper's event channel fragility. **MUST be re-validated empirically before extending** — start by observing only the existing 5 properties and add more only if confirmed stable on a real user run.
- **Landmines #2, #5, #6, #7, #8, #9, #10**: orthogonal to the rewrite (audio config, Mica, title bar, drag region, glsl-shaders path, mpv.destroy, render-context-reparent). Carry forward unchanged.
