// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv` — Aura's direct-FFI libmpv layer (the only playback path).
//!
//! Replaced `tauri-plugin-libmpv` / `libmpv-wrapper.dll` entirely: [`ffi`]
//! binds `libmpv-2.dll` directly via `libloading` (mirroring the pattern
//! `win32.rs` uses for user32/winmm/kernel32), [`engine`] drives playback
//! by embedding mpv via `--wid` into an engine-owned host child window,
//! and [`thumb`] runs the headless hover-seek thumbnail instance.
//!
//! The module name is a leftover from its origin as the "render-API
//! rewrite" (mpv 2nd engine); the render-context path itself was
//! consolidated away — see the history note in [`engine`]'s module doc.
//!
//! ## Correctness note
//!
//! The struct layouts and enum discriminants in [`ffi`] are an ABI
//! contract with the C library — a wrong field order or discriminant is a
//! silent mismatch `cargo check` cannot catch and that crashes at runtime.
//! They are transcribed directly from the mpv headers (see [`ffi`] for the
//! exact source revision).

// `dead_code`: parts of the FFI surface (e.g. the render-context bindings)
// are currently unused but kept as the complete transcription of mpv's
// public headers.
// `non_camel_case_types`: every type in `ffi` deliberately keeps its exact
// C identifier (`mpv_handle`, `mpv_node`, `mpv_event`, the enum newtypes,
// ...) so the bindings read 1:1 against the mpv headers — the standard
// Rust-style lint does not apply to a verbatim FFI surface.
#![allow(dead_code, non_camel_case_types)]

pub mod ffi;

// Aura's playback engine — direct-FFI libmpv embedded via `--wid` into an
// engine-owned host child window, with a command channel + event bridge.
// (Formerly the render-context engine; see the consolidation history in
// `engine.rs`'s module doc. The Phase-1 `hello` render-API scaffolding was
// deleted with the render path.)
#[cfg(target_os = "windows")]
pub mod engine;

// Headless hover-seek thumbnail engine — a self-owned `vo=null` libmpv
// instance on a dedicated worker thread, replacing the cold ffmpeg-per-hover
// path. Warm (open stream + decoder reused across hovers) and never-stale
// (each seek's screenshot is gated on mpv's `playback-restart` event). No
// render context (headless), so it's independent of the main playback engine.
#[cfg(target_os = "windows")]
pub mod thumb;
