// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv2` — direct-FFI replacement for `tauri-plugin-libmpv`.
//!
//! This module is the foundation of the render-API rewrite described in
//! `docs/superpowers/specs/2026-05-20-render-api-rewrite-design.md`. The
//! shipped `tauri-plugin-libmpv` / `libmpv-wrapper.dll` path embeds mpv via
//! the `--wid=<HWND>` option, which means mpv owns the child-window
//! swapchain and DWM throttles its presentation whenever Aura is not the
//! foreground window — the documented root cause of off-focus frame drops.
//! The fix is to drive mpv through `mpv_render_context_*` so Aura owns the
//! swapchain. `libmpv-wrapper.dll` exports zero `mpv_render_context_*`
//! symbols, so we must bind `libmpv-2.dll` directly.
//!
//! ## Phase 1 — bindings layer + render-context hello-world
//!
//! [`ffi`] holds the raw `#[repr(C)]` FFI surface (opaque handles, enums,
//! structs, function-pointer typedefs) transcribed verbatim from mpv's
//! public headers, plus the [`ffi::Libmpv`] loader which resolves every
//! symbol out of `libmpv-2.dll` via `libloading` — mirroring the pattern
//! `win32.rs` already uses for user32/winmm/kernel32.
//!
//! [`hello`] (Windows-only) is the Phase-1 runtime half: a Win32 window +
//! WGL context + `mpv_render_context_create` + a short render loop, used
//! to verify the render-API path works on real hardware. It uses a
//! standalone top-level window so the result is visible above Aura's
//! opaque home screen; Phase 2's real render surface is a child window.
//!
//! **This module does not affect normal launches.** `hello` only runs
//! when the `AURA_MPV2_HELLO` environment variable is set; otherwise
//! nothing here is exercised and `player.rs` / `lib.rs` use
//! `tauri-plugin-libmpv` unchanged. `cargo check` compiles the whole
//! module so the FFI declarations stay honest.
//!
//! ## Deferred to later phases (NOT in this module yet)
//!
//! - Phase 2+: the safe high-level `Mpv` wrapper (typed `command()` /
//!   `set_property()` / `get_property()` / event pump), the persistent
//!   dual-mode present loop, and every Tauri command reroute.
//!
//! ## Correctness note
//!
//! The struct layouts and enum discriminants in [`ffi`] are an ABI
//! contract with the C library — a wrong field order or discriminant is a
//! silent mismatch `cargo check` cannot catch and that crashes at runtime.
//! They are transcribed directly from the mpv headers (see [`ffi`] for the
//! exact source revision).

// `dead_code`: the whole module is unreachable until Phase 2 wires it in.
// `non_camel_case_types`: every type in `ffi` deliberately keeps its exact
// C identifier (`mpv_handle`, `mpv_node`, `mpv_event`, the enum newtypes,
// ...) so the bindings read 1:1 against the mpv headers — the standard
// Rust-style lint does not apply to a verbatim FFI surface.
#![allow(dead_code, non_camel_case_types)]

pub mod ffi;

// Phase-1 runtime hello-world (Win32 child window + WGL + render context).
// Windows-only — the WGL path has no cross-platform meaning, and Aura ships
// Windows-only anyway.
#[cfg(target_os = "windows")]
pub mod hello;

// Phase-2.1 long-lived render engine — promotes the verified Phase-1 setup
// into a persistent owner with a real command channel. Still top-level and
// still without playback wiring; those land in Phase 2.2 / 2.4.
#[cfg(target_os = "windows")]
pub mod engine;

// Headless hover-seek thumbnail engine — a self-owned `vo=null` libmpv
// instance on a dedicated worker thread, replacing the plugin-backed
// "thumb" named instance the scrubber used to drive. No render context
// (headless), so it's independent of the main playback engine and of the
// `AURA_MPV2` gate. Removing the plugin from the thumbnail path is the
// blocker that retiring `tauri-plugin-libmpv` (Phase 7) was waiting on.
#[cfg(target_os = "windows")]
pub mod thumb;
