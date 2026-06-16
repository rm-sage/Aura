# Aura — Linux Port

Status: **in progress** (`feat/linux-port`). X11-first. The Windows build is unaffected
(the port is purely additive — see "Why Windows stays green" below).

This doc is the authoritative roadmap. It was synthesised from a full map of every
Windows-specific touchpoint in the tree (Win32 window + mpv embedding, the mpv engine /
build / bundling, and OS integrations). Execute the phases **in order** — Phase L1 is a
hard gate that can only be validated in a Linux VM.

---

## TL;DR for the VM

- **Distro:** Ubuntu 24.04 LTS. **Not Kali** (security distro, non-representative desktop).
- **Session:** log in to **"Ubuntu on Xorg" (X11)**, *not* the Wayland default. X11 is the
  ship target; Wayland is deferred (Phase L5) because mpv `wid` embedding doesn't work there.
- **VM specs:** **8 GB RAM, 4 vCPU, 60 GB disk**, and **enable 3D acceleration with generous
  video memory**. Prefer **bare-metal or GPU-passthrough** over a software-rendered VM — the
  L1 compositing spike depends on real GL compositing and `llvmpipe`/virtio-GL can give false
  negatives. Hardware video decode won't pass through a VM, so **test at 1080p** (software
  decode), not 4K. Your current Kali VM (2 GB) is too small and the wrong distro.
- **Build-host packages** (Ubuntu 24.04):
  ```
  sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev pkg-config \
                      libmpv-dev libsecret-1-dev libayatana-appindicator3-dev \
                      build-essential curl wget file libx11-dev
  # Rust: rustup (stable). Node/pnpm as on Windows.
  ```
  Note: webkit2gtk **4.1** (not 4.0). `libmpv-dev` provides `libmpv.so.2` (Ubuntu 24.04 ships
  an *older* libmpv (~0.37) than the v0.41/API-2.5 the FFI in `mpv/ffi.rs` was transcribed
  against — see the libmpv ABI note in Phase L4).
- **Run/build:** `pnpm install && pnpm tauri dev` (or `pnpm tauri build` for a `.deb`/AppImage).
  Headless/CI needs `dbus-run-session` (keyring + MPRIS need D-Bus) — but the **L1 spike cannot
  be headless**.

---

## Why Windows stays green (the port is additive)

Platform isolation already exists, so nothing has to be *removed*:

- `mod win32` is `#[cfg(target_os = "windows")]` (`lib.rs`).
- `mpv::engine` / `mpv::thumb` are gated in `mpv/mod.rs`.
- The `windows` crate is under `[target.'cfg(target_os = "windows")'.dependencies]` (`Cargo.toml`).
- Every playback `#[tauri::command]` already has a `#[cfg(not(target_os = "windows"))]` arm
  returning `Err("playback engine is Windows-only")` (`lib.rs`).

A Linux `cargo build` **already compiles today** and yields an app with zero playback. The port
provides Linux **implementations** behind that existing seam. The Windows verification gate is
unchanged: `cd src-tauri && cargo check --message-format=short` (run on Windows after every
edit). The one thing Windows `cargo check` **cannot** verify is the `#[cfg(target_os="linux")]`
code and the non-Windows `build.rs` branch — those only compile on a Linux toolchain, so a typo
there is invisible until the in-VM build.

---

## Architecture

### Platform-abstraction layer (`src-tauri/src/platform/`)
Replaces today's scattered `#[cfg]` brackets with one typed seam:

```
platform/mod.rs          — declares the public free-fn surface; cfg-selects the impl:
                           #[cfg(windows)] use windows_impl as imp;
                           #[cfg(target_os="linux")] use linux_impl as imp;
                           #[cfg(not(any(windows, target_os="linux")))] use stub as imp;
platform/windows_impl.rs — thin re-exports of today's win32::* (no logic moves).
platform/linux_impl.rs   — X11/EWMH/GTK/D-Bus code (mostly no-ops / one-liners).
platform/stub.rs         — no-op/Err for macOS + other (workspace stays buildable everywhere).
```

The interface is **flat free functions** (not a `dyn` trait — these are process-global, like the
existing `win32` free fns). `NativeWindowId = i64` (HWND-as-i64 on Windows, X11 `Window` XID on
Linux — both fit `i64`, matching the existing `hwnd.0 as i64` cast into mpv `wid`). Surface:

```
native_window_id(&WebviewWindow) -> Option<i64>
enter_native_fullscreen(id) / exit_native_fullscreen(id) / is_in_native_fullscreen() -> bool
resize_video_child(id, y_offset)
parent_display_refresh_hz(id) -> Option<f64>
set_display_sleep_inhibited(bool)
apply_vibrancy(&window)        // no-op on Linux (no Mica)
apply_mpo_poison(id)           // no-op on Linux (DWM/DXGI-only)
pin_process_scheduling()       // no-op on Linux (EcoQoS/timeBeginPeriod-only)
recover_window_state(id)       // no-op on Linux
ensure_taskbar_visible()       // no-op on Linux (WM owns the panel)
```
Windows bodies = today's `win32.rs` fns; Linux bodies = EWMH/GTK/D-Bus (mostly no-ops). The
~6 current `#[cfg(windows)] win32::foo(...)` / `#[cfg(not)] {..}` pairs collapse to one
unconditional `platform::foo(...)`.

### The engine seam (the hard part)
`mpv/ffi.rs` stays the platform-neutral C-ABI core — **only the dlopen name changes**
(`libmpv-2.dll` → `libmpv.so.2`). Add `#[cfg(target_os="linux")] pub mod engine_x11;` in
`mpv/mod.rs`, mirroring `engine.rs`'s **public `submit_*` surface** (`submit_load_file`,
`submit_command`, `submit_toggle_pause`, `submit_set_property`, `submit_get_property`,
`submit_set_volume`, `set_display_awake_desired`, `parent_display_refresh_hz`) so `lib.rs`
per-OS arms select the module with **zero change** to the command set, `generate_handler!`,
`player.toml`, or `default.json`. `EngineCommand`/`EngineEmit`/`PropValue`/`GetFormat` and all
mpv command/property/observed-property/event-bridge logic are reused **verbatim** — only the
window glue differs.

### Layer model on X11 (the embed)
```
GTK ApplicationWindow (WebviewWindow::gtk_window())
  └─ WebKitGTK webview  — made TRANSPARENT (set_app_paintable(true) + RGBA visual +
  │                       WebKit transparent background), stacked ABOVE
  └─ mpv-owned X11 child window — stacked BELOW via gdk_window_lower / XLowerWindow;
                                  mpv owns its own GL + presentation inside it (we write
                                  ZERO GL code — mpv `wid` = the child's XID).
```
This is the direct analogue of today's Windows model (transparent WebView2 above an
`HWND_BOTTOM` mpv host child). Tauri 2 exposes the native handle on Linux via
`WebviewWindow::gtk_window()` (`gtk::ApplicationWindow` + `default_vbox()`), and
`raw-window-handle` 0.5 (already a dep) yields `RawWindowHandle::Xlib`/`Xcb { window }`.

---

## THE blocker (Phase L1) — read before investing

Aura's entire UI is a transparent webview composited **over** the video surface. On Linux this
is **unproven and cannot be tested on the Windows dev machine**. The whole port hinges on it.

**Recommended approach:** X11-first, mpv owns its own GL via `wid=XID` (no GL code to write).
**Fallback ladder** if a clean transparent overlay can't be achieved:
1. **`GtkOverlay`** — mpv `GtkDrawingArea` as the base child, WebKitGTK webview as an overlay
   child; let GTK composite rather than relying on X11 stacking + a compositing WM.
2. **Reserved-bar layout** — non-transparent: UI chrome in reserved bars, mpv fills the
   remaining opaque rect. Loses the full-bleed-under-UI look but ships.
3. **Last resort** — `vo=libmpv` + `mpv_render_context` into an EGL/GLX surface we composite
   (the Wayland-style path; a multi-week render rewrite that the engine consolidation
   deliberately removed). Avoid unless 1 and 2 both fail.

Front-load L1 as a standalone spike **before** any other Linux investment.

---

## Phased plan

| Phase | Title | Difficulty | Where verified |
|---|---|---|---|
| **L0** | Platform-abstraction scaffold + cfg-gates (Windows byte-identical) | moderate | **Windows `cargo check`** |
| **L1** | X11 compositing proof-of-concept (transparent webview over mpv child) | **blocker** | VM (X11; Mesa + NVIDIA) |
| **L2** | Linux mpv engine (`engine_x11.rs`) behind the `submit_*` seam | **blocker** | VM |
| **L3** | Native chrome, fullscreen, OS integrations on X11 | hard | VM |
| **L4** | Runtime deps, bundling, packaging (`.deb`/AppImage) | moderate | VM |
| **L5** | *(deferred)* Wayland + Linux HDR | blocker | VM |

### L0 — scaffold + cfg-gates (this branch, Windows-verifiable) — STARTED
- Create `platform/{mod.rs,windows_impl.rs,linux_impl.rs,stub.rs}`; `NativeWindowId=i64` + the
  flat free-fn surface. `windows_impl.rs` re-exports `win32::*` unchanged; `linux_impl.rs` +
  `stub.rs` are no-op/best-effort.
- Replace the ~6 scattered `#[cfg(windows)]`/`#[cfg(not)]` call-site pairs (`lib.rs`,
  `debug_panel.rs`, `media_controls.rs`) with unconditional `platform::*`.
- `build.rs`: cfg-gate the `WindowsAttributes`/app-manifest block so non-Windows calls plain
  `tauri_build::build()`; **keep the `cargo:rustc-env` secret-baking lines OUTSIDE the gate**
  (they must run on every OS).
- `tauri.conf.json`: move `lib/libmpv-2.dll` into a Windows-only bundle override; keep
  `shaders/**/*` shared; add `bundle.linux` (deb/appimage) targets.
- Add a cfg-split `LIBMPV_NAME` const (`libmpv-2.dll` / `libmpv.so.2` / `libmpv.2.dylib`) used by
  `ffi.rs` and `player.rs::check_mpv_dll`.
- Relax the `mpv::thumb` gate to include Linux (it's a `vo=null` headless extractor, pure client
  API — no Win32).
- **Gate:** Windows `cargo check` unchanged; a Linux build compiles with playback stubbed.

### L1 — X11 compositing spike (VM, gates everything)
Standalone: transparent WebKitGTK webview composited above an X11 child that mpv renders into
via `wid` (the XID), with pointer/keyboard input passing through to the webview. Play any stream;
confirm video shows through transparent regions **and** the React UI is clickable over it. Test
on **Mesa and NVIDIA**, X11 session. **If this can't be made clean, the port stops here.**

### L2 — `engine_x11.rs`
Mirror `engine.rs`'s public `submit_*` surface; reuse all mpv logic verbatim; replace only the
window glue (`gtk_window()` → child `GtkDrawingArea` → `gdk_x11_window_get_xid()` → the same
INT64 `wid` FFI path; `vo=gpu-next`; **drop the d3d11-only init opts**). Resize on GTK
`size-allocate`/`configure-event` (replaces the 5 ms `GetClientRect` poll). **Critical threading
redesign:** GDK/GTK calls must run on the GTK main thread via `glib::MainContext`/`g_idle_add` —
the Win32 dedicated-thread message pump + `MsgWaitForMultipleObjects` teardown-join have no GTK
analogue (mpv's own threads stay; only window-management glue is marshalled). `lib.rs`
`#[cfg(not(windows))]` arms become `#[cfg(target_os="linux")] engine_x11::submit_*`.

### L3 — chrome / fullscreen / integrations
- Fullscreen: `gtk_window_fullscreen()` or `_NET_WM_STATE_FULLSCREEN` (the WM hides the panel —
  **much simpler** than the Win32 `WS_POPUP`/style-strip/`ITaskbarList2` dance).
- `parent_display_refresh_hz`: `gdk_monitor_get_refresh_rate`.
- `set_display_sleep_inhibited`: `org.freedesktop.ScreenSaver`/`login1` Inhibit or
  `gtk_application_inhibit` (or rely on mpv's `stop-screensaver` under `wid`).
- `apply_mpo_poison` / `pin_process_scheduling` / `recover_window_state` / `apply_vibrancy`: stay
  **no-op** (DWM/DXGI/EcoQoS/Mica have no Linux equivalent).
- Verify already-cross-platform integrations in-VM: `souvlaki` → MPRIS, `keyring` → Secret
  Service, Discord RPC unix socket, tray → StatusNotifierItem (libayatana-appindicator),
  deep-link `aura://` via xdg-mime desktop-file MimeType, panic-log `HOME` fallback (a path
  currently hardcodes `USERPROFILE` — add `HOME`).

### L4 — runtime deps / bundling
- `runtime_deps.rs` DEPS are Windows `.exe` URLs+hashes. On Linux prefer the **existing PATH
  fallback** (silencedetect/cast already fall back to bare `ffmpeg`/`ffprobe`) — cfg-gate DEPS to
  empty on Linux relying on apt `ffmpeg`, or cfg-split to a Linux static-build table.
- Tauri Linux bundle: `bundle.linux` deb `depends = [libmpv2, libwebkit2gtk-4.1-0, libgtk-3-0]`
  (+ libayatana-appindicator3-1 for tray, libsecret for keyring).
- **libmpv distribution decision:** bundle a known-good `libmpv.so.2` (AppImage; mirrors the
  Windows DLL approach, avoids the distro-version lottery) **vs** deb-depend on apt `libmpv2`
  (older → add a runtime `client_api_version` check). Recommend bundling for AppImage.
- **native-tls → OpenSSL** on Linux (`Cargo.toml`): re-verify the cast LAN self-signed-cert
  `accept_invalid_certs` path under OpenSSL (differs from SChannel); needs `libssl-dev`+pkg-config.

### L5 — Wayland + HDR (deferred)
Wayland has no `wid` embedding; needs `vo=libmpv` + `mpv_render_context` + an EGL surface under
the WebKitGTK surface via `wl_subsurface` — a separate multi-week workstream. Linux HDR is also
deferred (PQ-capable compositor dependency; the DWM/DXGI HDR + MPO stack stays Windows-only).
X11-only is the realistic ship target.

---

## Portable as-is (no/low change)
- The entire React frontend (`src/**`) — WebView2→WebKitGTK is Tauri's concern; only cosmetic
  items (the 36 px windowed title-bar offset, any Windows-worded copy) may need tweaks.
- `streaming.rs` (axum loopback bridge), all Stremio/addon/meta/ratings/subtitle networking
  (reqwest+rustls), Discord RPC (unix socket on Linux), `api_keyring.rs` (keyring v3 Secret
  Service), `media_controls.rs` (souvlaki already routes to MPRIS off-Windows), `mpv/ffi.rs`
  (C-ABI; only the dlopen name), `mpv/thumb.rs` (`vo=null`, just relax the gate).
- `Cargo.toml` is already platform-split correctly. `devlog.rs`/`crash_reporting.rs`/deep-link
  already have Linux branches.

## Needs in-VM verification (cannot be checked on Windows)
- **L1 spike** (gates everything): transparent webview over mpv X11 child + input pass-through,
  on Mesa **and** NVIDIA, X11.
- mpv `wid=XID` producing visible video under `gpu-next` (GLX/EGL auto-select).
- The GTK threading redesign (glib `MainContext`) with clean engine shutdown (no deadlock).
- Event-driven resize via GTK `size-allocate`.
- EWMH fullscreen filling the monitor with the panel auto-hidden.
- souvlaki→MPRIS, keyring→Secret Service, Discord RPC, deep-link xdg-mime, tray→SNI — all with
  a running D-Bus.
- native-tls→OpenSSL cast self-signed path.
- `build.rs` non-Windows branch + the secret-baking env still running on Linux.
- libmpv ABI/version (apt libmpv2 ~0.37 vs the FFI's v0.41/API-2.5) — runtime version check.
- AppImage/`.deb` launches + plays on a clean Ubuntu 24.04 (X11) with no manual lib install.
