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

## Open questions (review before Phase 1)

1. **Direct-FFI (Option A — recommended) vs fork-the-wrapper (Option B)?** I strongly recommend A. Owning the FFI is cleaner long-term and matches the existing libloading pattern in win32.rs.
2. **WGL vs ANGLE-EGL?** I recommend WGL as the primary path; reserve ANGLE for a fallback only if WGL fails for a user.
3. **Is the off-focus drop the only goal, or also a render-architecture cleanup?** Option A enables future things — a cleaner shader pipeline, easier HDR display-tonemap integration, etc. Worth noting but doesn't change Phase 1's scope.
4. **`libmpv-rs` vs hand-rolled FFI?** I recommend hand-rolled FFI (matches existing pattern, no version-skew, ~30-50 functions). `libmpv-rs` is an alternative if you'd rather lean on an upstream wrapper despite its render.rs being empty in the cached version.

## What was done tonight (autonomously)

- v0.8.0 released, signed, published to GitHub (https://github.com/rm-sage/Aura/releases/tag/v0.8.0), latest.json uploaded.
- Branch `feat/render-api-rewrite` rebased onto post-v0.8.0 main and force-pushed.
- Wrapper feasibility spike: confirmed `tauri-plugin-libmpv 0.3.2` exposes NO render-context symbols. Direct FFI to libmpv-2.dll is required.
- This spec doc written + committed; awaiting user review of approach before any deps are added or code is written.

## CLAUDE.md landmine implications (carry-forward)

The existing MPV landmines apply to the **main** mpv instance, which is what's getting rewritten. Most should resolve naturally under the new path because the wrapper is gone:

- **Landmine #1** (`set_property` vs `command("set_property", …)`): becomes irrelevant — we call libmpv's C API directly, which has separate `mpv_set_property` / `mpv_command` entrypoints.
- **Landmine #3** (no polling `get_property` during state transitions): still applies in principle (libmpv has internal critical sections); we keep the existing "gate polling on duration > 0" discipline. The thumb instance's seek-confirmation polling pattern (added in 837f850) is the template.
- **Landmine #4** (observed_properties locked to `pause / time-pos / duration / volume / speed`): may relax under direct FFI since the locked set was a symptom of the wrapper's event channel fragility. **MUST be re-validated empirically before extending** — start by observing only the existing 5 properties and add more only if confirmed stable on a real user run.
- **Landmines #2, #5, #6, #7, #8, #9, #10**: orthogonal to the rewrite (audio config, Mica, title bar, drag region, glsl-shaders path, mpv.destroy, render-context-reparent). Carry forward unchanged.
