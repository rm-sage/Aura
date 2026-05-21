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
//! ## Phase 1 (this commit) — bindings layer only
//!
//! [`ffi`] holds the raw `#[repr(C)]` FFI surface (opaque handles, enums,
//! structs, function-pointer typedefs) transcribed verbatim from mpv's
//! public headers, plus the [`ffi::Libmpv`] loader which resolves every
//! symbol out of `libmpv-2.dll` via `libloading` — mirroring the pattern
//! `win32.rs` already uses for user32/winmm/kernel32.
//!
//! **This module is ADDITIVE and currently dead.** Nothing here is wired
//! into any runtime path; `player.rs` / `lib.rs` still use
//! `tauri-plugin-libmpv` unchanged. `cargo check` compiles this module so
//! the FFI declarations are kept honest, but it is not exercised until
//! Phase 2 ports `init_mpv` + `load_video` onto it.
//!
//! ## Deferred to later phases (NOT in this module yet)
//!
//! - Phase 1 runtime half: the Win32 child window, the WGL context, and
//!   the `mpv_render_context_create` + render-loop wiring (needs hardware
//!   verification).
//! - Phase 2+: the safe high-level `Mpv` wrapper (typed `command()` /
//!   `set_property()` / `get_property()` / event pump), and every Tauri
//!   command reroute.
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
