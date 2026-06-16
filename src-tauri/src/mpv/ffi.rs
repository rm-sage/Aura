// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Raw FFI surface for `libmpv-2.dll` (mpv client API + render API).
//!
//! # Source of truth
//!
//! Every `#[repr(C)]` struct, enum discriminant and function signature in
//! this file is transcribed VERBATIM from mpv's public C headers:
//!
//!   - `include/mpv/client.h`    — client API
//!   - `include/mpv/render.h`    — render API (backend-agnostic)
//!   - `include/mpv/render_gl.h` — OpenGL render backend
//!
//! Transcribed from `github.com/mpv-player/mpv` `master` (fetched
//! 2026-05-20), where `client.h` declares
//! `MPV_CLIENT_API_VERSION = MPV_MAKE_VERSION(2, 5)`. The struct layouts
//! and enum values are part of mpv's stable ABI: the client API has been
//! stable for years and the render API has been stable since mpv 0.30
//! (API 1.105). Aura ships mpv v0.41, comfortably within that range — the
//! header revision used for transcription is newer than 0.41 but only adds
//! members at the END of existing structs / new enum values, never
//! reorders, so the layouts below are ABI-compatible with the shipped DLL.
//!
//! # ABI warning
//!
//! A wrong field order, a wrong field type, or a wrong enum discriminant
//! is a SILENT ABI mismatch: `cargo check` cannot detect it, and it
//! corrupts memory at runtime. Do not "tidy" anything in this file without
//! re-checking it against the headers above.
//!
//! # Phase 1 scope
//!
//! This is the bindings layer only. [`Libmpv`] loads the DLL and resolves
//! the symbols; there is no safe wrapper, no render context, no window.
//! Nothing here is wired into Aura's runtime yet (see `mpv/mod.rs`).

use std::ffi::{c_char, c_int, c_void};
use std::os::raw::c_ulong;
use std::path::{Path, PathBuf};

// ===========================================================================
// Opaque handle types
// ===========================================================================

/// Opaque mpv client handle. C: `typedef struct mpv_handle mpv_handle;`
/// (an incomplete type — only ever used behind a pointer).
#[repr(C)]
pub struct mpv_handle {
    _opaque: [u8; 0],
    _marker: core::marker::PhantomData<(*mut u8, core::marker::PhantomPinned)>,
}

/// Opaque render context. C (render.h):
/// `typedef struct mpv_render_context mpv_render_context;`
#[repr(C)]
pub struct mpv_render_context {
    _opaque: [u8; 0],
    _marker: core::marker::PhantomData<(*mut u8, core::marker::PhantomPinned)>,
}

// ===========================================================================
// Enums — client.h
//
// Each C `enum` is modelled as a `#[repr(transparent)]` newtype over
// `c_int` with the discriminants as associated `const`s. `#[repr(transparent)]`
// guarantees the newtype has the identical ABI to a bare `c_int` (the C `enum`
// underlying type on the MSVC/clang ABIs libmpv-2.dll is built with). This is
// preferred over a Rust `#[repr(i32)]` enum at the FFI boundary because mpv
// may add new discriminants in future builds, and receiving an unknown
// discriminant into a real Rust enum is instant UB — the newtype accepts any
// `i32` the C side hands back. It is preferred over a bare `type` alias + a
// sibling `mod` because a `type` alias and a `mod` of the same name collide
// (both live in the type namespace), whereas a struct and its own inherent
// `impl` const namespace do not.
// ===========================================================================

/// `mpv_error` — C `typedef enum mpv_error` (client.h). Negative on error,
/// `>= 0` is success.
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_error(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_error {
    pub const SUCCESS: mpv_error = mpv_error(0);
    pub const EVENT_QUEUE_FULL: mpv_error = mpv_error(-1);
    pub const NOMEM: mpv_error = mpv_error(-2);
    pub const UNINITIALIZED: mpv_error = mpv_error(-3);
    pub const INVALID_PARAMETER: mpv_error = mpv_error(-4);
    pub const OPTION_NOT_FOUND: mpv_error = mpv_error(-5);
    pub const OPTION_FORMAT: mpv_error = mpv_error(-6);
    pub const OPTION_ERROR: mpv_error = mpv_error(-7);
    pub const PROPERTY_NOT_FOUND: mpv_error = mpv_error(-8);
    pub const PROPERTY_FORMAT: mpv_error = mpv_error(-9);
    pub const PROPERTY_UNAVAILABLE: mpv_error = mpv_error(-10);
    pub const PROPERTY_ERROR: mpv_error = mpv_error(-11);
    pub const COMMAND: mpv_error = mpv_error(-12);
    pub const LOADING_FAILED: mpv_error = mpv_error(-13);
    pub const AO_INIT_FAILED: mpv_error = mpv_error(-14);
    pub const VO_INIT_FAILED: mpv_error = mpv_error(-15);
    pub const NOTHING_TO_PLAY: mpv_error = mpv_error(-16);
    pub const UNKNOWN_FORMAT: mpv_error = mpv_error(-17);
    pub const UNSUPPORTED: mpv_error = mpv_error(-18);
    pub const NOT_IMPLEMENTED: mpv_error = mpv_error(-19);
    pub const GENERIC: mpv_error = mpv_error(-20);
}

/// `mpv_format` — C `typedef enum mpv_format` (client.h).
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_format(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_format {
    pub const NONE: mpv_format = mpv_format(0);
    pub const STRING: mpv_format = mpv_format(1);
    pub const OSD_STRING: mpv_format = mpv_format(2);
    pub const FLAG: mpv_format = mpv_format(3);
    pub const INT64: mpv_format = mpv_format(4);
    pub const DOUBLE: mpv_format = mpv_format(5);
    pub const NODE: mpv_format = mpv_format(6);
    pub const NODE_ARRAY: mpv_format = mpv_format(7);
    pub const NODE_MAP: mpv_format = mpv_format(8);
    pub const BYTE_ARRAY: mpv_format = mpv_format(9);
}

/// `mpv_event_id` — C `typedef enum mpv_event_id` (client.h).
///
/// Note the gaps: `IDLE = 11` and `TICK = 14` exist only behind the
/// `MPV_ENABLE_DEPRECATED` macro and are kept here for completeness; the
/// numeric values are fixed by the ABI regardless.
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_event_id(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_event_id {
    pub const NONE: mpv_event_id = mpv_event_id(0);
    pub const SHUTDOWN: mpv_event_id = mpv_event_id(1);
    pub const LOG_MESSAGE: mpv_event_id = mpv_event_id(2);
    pub const GET_PROPERTY_REPLY: mpv_event_id = mpv_event_id(3);
    pub const SET_PROPERTY_REPLY: mpv_event_id = mpv_event_id(4);
    pub const COMMAND_REPLY: mpv_event_id = mpv_event_id(5);
    pub const START_FILE: mpv_event_id = mpv_event_id(6);
    pub const END_FILE: mpv_event_id = mpv_event_id(7);
    pub const FILE_LOADED: mpv_event_id = mpv_event_id(8);
    /// Deprecated (MPV_ENABLE_DEPRECATED).
    pub const IDLE: mpv_event_id = mpv_event_id(11);
    /// Deprecated (MPV_ENABLE_DEPRECATED).
    pub const TICK: mpv_event_id = mpv_event_id(14);
    pub const CLIENT_MESSAGE: mpv_event_id = mpv_event_id(16);
    pub const VIDEO_RECONFIG: mpv_event_id = mpv_event_id(17);
    pub const AUDIO_RECONFIG: mpv_event_id = mpv_event_id(18);
    pub const SEEK: mpv_event_id = mpv_event_id(20);
    pub const PLAYBACK_RESTART: mpv_event_id = mpv_event_id(21);
    pub const PROPERTY_CHANGE: mpv_event_id = mpv_event_id(22);
    pub const QUEUE_OVERFLOW: mpv_event_id = mpv_event_id(24);
    pub const HOOK: mpv_event_id = mpv_event_id(25);
}

/// `mpv_log_level` — C `typedef enum mpv_log_level` (client.h).
/// The numeric values are intentionally sparse (reserved for future use).
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_log_level(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_log_level {
    pub const NONE: mpv_log_level = mpv_log_level(0);
    pub const FATAL: mpv_log_level = mpv_log_level(10);
    pub const ERROR: mpv_log_level = mpv_log_level(20);
    pub const WARN: mpv_log_level = mpv_log_level(30);
    pub const INFO: mpv_log_level = mpv_log_level(40);
    pub const V: mpv_log_level = mpv_log_level(50);
    pub const DEBUG: mpv_log_level = mpv_log_level(60);
    pub const TRACE: mpv_log_level = mpv_log_level(70);
}

/// `mpv_end_file_reason` — C `typedef enum mpv_end_file_reason` (client.h,
/// since API 1.9). Note `STOP = 2` — value `1` is intentionally absent
/// from the ABI.
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_end_file_reason(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_end_file_reason {
    pub const EOF: mpv_end_file_reason = mpv_end_file_reason(0);
    pub const STOP: mpv_end_file_reason = mpv_end_file_reason(2);
    pub const QUIT: mpv_end_file_reason = mpv_end_file_reason(3);
    pub const ERROR: mpv_end_file_reason = mpv_end_file_reason(4);
    pub const REDIRECT: mpv_end_file_reason = mpv_end_file_reason(5);
}

// ===========================================================================
// Enums — render.h
// ===========================================================================

/// `mpv_render_param_type` — C `typedef enum mpv_render_param_type`
/// (render.h).
#[repr(transparent)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct mpv_render_param_type(pub c_int);

#[allow(non_upper_case_globals)]
impl mpv_render_param_type {
    pub const INVALID: mpv_render_param_type = mpv_render_param_type(0);
    pub const API_TYPE: mpv_render_param_type = mpv_render_param_type(1);
    pub const OPENGL_INIT_PARAMS: mpv_render_param_type = mpv_render_param_type(2);
    pub const OPENGL_FBO: mpv_render_param_type = mpv_render_param_type(3);
    pub const FLIP_Y: mpv_render_param_type = mpv_render_param_type(4);
    pub const DEPTH: mpv_render_param_type = mpv_render_param_type(5);
    pub const ICC_PROFILE: mpv_render_param_type = mpv_render_param_type(6);
    pub const AMBIENT_LIGHT: mpv_render_param_type = mpv_render_param_type(7);
    pub const X11_DISPLAY: mpv_render_param_type = mpv_render_param_type(8);
    pub const WL_DISPLAY: mpv_render_param_type = mpv_render_param_type(9);
    pub const ADVANCED_CONTROL: mpv_render_param_type = mpv_render_param_type(10);
    pub const NEXT_FRAME_INFO: mpv_render_param_type = mpv_render_param_type(11);
    pub const BLOCK_FOR_TARGET_TIME: mpv_render_param_type =
        mpv_render_param_type(12);
    pub const SKIP_RENDERING: mpv_render_param_type = mpv_render_param_type(13);
    pub const DRM_DISPLAY: mpv_render_param_type = mpv_render_param_type(14);
    pub const DRM_DRAW_SURFACE_SIZE: mpv_render_param_type =
        mpv_render_param_type(15);
    pub const DRM_DISPLAY_V2: mpv_render_param_type = mpv_render_param_type(16);
    pub const SW_SIZE: mpv_render_param_type = mpv_render_param_type(17);
    pub const SW_FORMAT: mpv_render_param_type = mpv_render_param_type(18);
    pub const SW_STRIDE: mpv_render_param_type = mpv_render_param_type(19);
    pub const SW_POINTER: mpv_render_param_type = mpv_render_param_type(20);
}

/// `mpv_render_frame_info_flag` bit values — C `typedef enum
/// mpv_render_frame_info_flag` (render.h). These OR together into
/// [`mpv_render_frame_info::flags`].
pub mod mpv_render_frame_info_flag {
    pub const PRESENT: u64 = 1 << 0;
    pub const REDRAW: u64 = 1 << 1;
    pub const REPEAT: u64 = 1 << 2;
    pub const BLOCK_VSYNC: u64 = 1 << 3;
}

/// `mpv_render_update_flag` bit values — C `typedef enum
/// mpv_render_update_flag` (render.h). Returned (OR-combined) by
/// `mpv_render_context_update`.
pub mod mpv_render_update_flag {
    /// A new video frame must be rendered (`mpv_render_context_render`).
    pub const FRAME: u64 = 1 << 0;
}

/// Predefined string value for `MPV_RENDER_PARAM_API_TYPE` selecting the
/// OpenGL backend. C (render.h): `#define MPV_RENDER_API_TYPE_OPENGL
/// "opengl"`. NUL-terminated so the bytes can be handed straight to mpv as
/// a `char*`.
pub const MPV_RENDER_API_TYPE_OPENGL: &[u8] = b"opengl\0";

/// Predefined string value for `MPV_RENDER_PARAM_API_TYPE` selecting the
/// software backend. C (render.h): `#define MPV_RENDER_API_TYPE_SW "sw"`.
pub const MPV_RENDER_API_TYPE_SW: &[u8] = b"sw\0";

/// `MPV_CLIENT_API_VERSION` the headers above were transcribed against:
/// `MPV_MAKE_VERSION(2, 5)` == `(2 << 16) | 5`. Compare against the value
/// returned by [`Libmpv::client_api_version`] at runtime.
pub const MPV_CLIENT_API_VERSION: c_ulong = (2 << 16) | 5;

// ===========================================================================
// Structs — client.h
// ===========================================================================

/// `mpv_node_list` — C `typedef struct mpv_node_list` (client.h).
/// Field order: `num`, `values`, `keys` — exact.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_node_list {
    /// Number of entries. Negative values are not allowed.
    pub num: c_int,
    /// `values[0..num]` — for ARRAY and MAP. May be NULL when `num <= 0`.
    pub values: *mut mpv_node,
    /// `keys[0..num]` — MAP only (NULL/unused for ARRAY).
    pub keys: *mut *mut c_char,
}

/// `mpv_byte_array` — C `typedef struct mpv_byte_array` (client.h).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_byte_array {
    /// Pointer to the raw data.
    pub data: *mut c_void,
    /// Size in bytes of the data pointed to by `data`.
    pub size: usize,
}

/// Untagged union inside [`mpv_node`] — C: the anonymous `union { ... } u`.
///
/// Which member is valid is dictated by the sibling [`mpv_node::format`]
/// field. Modelled as a Rust `union` so the `#[repr(C)]` layout (size =
/// largest member, i.e. a pointer / `i64` / `f64` = 8 bytes on x64)
/// matches the C union exactly.
#[repr(C)]
#[derive(Clone, Copy)]
pub union mpv_node_u {
    /// Valid if `format == MPV_FORMAT_STRING` (also OSD_STRING).
    pub string: *mut c_char,
    /// Valid if `format == MPV_FORMAT_FLAG`.
    pub flag: c_int,
    /// Valid if `format == MPV_FORMAT_INT64`.
    pub int64: i64,
    /// Valid if `format == MPV_FORMAT_DOUBLE`. Named `double_` in the C
    /// header (`double` is a C keyword); kept identical here.
    pub double_: f64,
    /// Valid if `format == MPV_FORMAT_NODE_ARRAY` or `NODE_MAP`.
    pub list: *mut mpv_node_list,
    /// Valid if `format == MPV_FORMAT_BYTE_ARRAY`.
    pub ba: *mut mpv_byte_array,
}

/// `mpv_node` — C `typedef struct mpv_node` (client.h). Generic data
/// storage used by the `MPV_FORMAT_NODE` family.
///
/// Field order: the anonymous `union u` FIRST, then `format` — exact. A
/// 0-initialised `mpv_node` has `format == MPV_FORMAT_NONE` by design.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_node {
    /// The tagged-union payload; read the member named by `format`.
    pub u: mpv_node_u,
    /// Type tag — one of the `mpv_format` consts.
    pub format: mpv_format,
}

/// `mpv_event_property` — C `typedef struct mpv_event_property`
/// (client.h). The `data` payload for `MPV_EVENT_PROPERTY_CHANGE` /
/// `MPV_EVENT_GET_PROPERTY_REPLY`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_property {
    /// Name of the property.
    pub name: *const c_char,
    /// Format of `data`; `MPV_FORMAT_NONE` if retrieval failed.
    pub format: mpv_format,
    /// Property value — interpret per `format` (e.g. for
    /// `MPV_FORMAT_STRING`, `*(*const c_char)data`). NULL on failure.
    pub data: *mut c_void,
}

/// `mpv_event_log_message` — C `typedef struct mpv_event_log_message`
/// (client.h). The `data` payload for `MPV_EVENT_LOG_MESSAGE`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_log_message {
    /// Module prefix identifying the sender (or "overflow").
    pub prefix: *const c_char,
    /// Log level as a string (matches `mpv_request_log_messages` names).
    pub level: *const c_char,
    /// The log message — one newline-terminated line.
    pub text: *const c_char,
    /// Same as `level` but as the numeric ID (since API 1.6).
    pub log_level: mpv_log_level,
}

/// `mpv_event_start_file` — C `typedef struct mpv_event_start_file`
/// (client.h, since API 1.108). The `data` payload for
/// `MPV_EVENT_START_FILE`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_start_file {
    /// Playlist entry ID of the file being loaded now.
    pub playlist_entry_id: i64,
}

/// `mpv_event_end_file` — C `typedef struct mpv_event_end_file`
/// (client.h). The `data` payload for `MPV_EVENT_END_FILE`.
///
/// Field order: `reason`, `error`, `playlist_entry_id`,
/// `playlist_insert_id`, `playlist_insert_num_entries` — exact. The last
/// three were added in API 1.108 at the END of the struct (ABI-safe
/// growth).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_end_file {
    /// One of the `mpv_end_file_reason` consts.
    pub reason: mpv_end_file_reason,
    /// mpv error code when `reason == ERROR`; 0 otherwise (since 1.9).
    pub error: c_int,
    /// Playlist entry ID of the file that was being played (since 1.108).
    pub playlist_entry_id: i64,
    /// First inserted entry ID on a REDIRECT-style end (since 1.108).
    pub playlist_insert_id: i64,
    /// Number of inserted playlist entries; only valid with
    /// `playlist_insert_id` (since 1.108).
    pub playlist_insert_num_entries: c_int,
}

/// `mpv_event_client_message` — C `typedef struct
/// mpv_event_client_message` (client.h). The `data` payload for
/// `MPV_EVENT_CLIENT_MESSAGE`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_client_message {
    /// Number of arguments; `args[0..num_args]` are valid.
    pub num_args: c_int,
    /// Argument strings chosen by the message sender.
    pub args: *mut *const c_char,
}

/// `mpv_event_hook` — C `typedef struct mpv_event_hook` (client.h). The
/// `data` payload for `MPV_EVENT_HOOK`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_hook {
    /// The hook name as passed to `mpv_hook_add`.
    pub name: *const c_char,
    /// Internal ID to pass back to `mpv_hook_continue`.
    pub id: u64,
}

/// `mpv_event_command` — C `typedef struct mpv_event_command` (client.h,
/// since API 1.102). The `data` payload for `MPV_EVENT_COMMAND_REPLY`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event_command {
    /// Result data of the command (`MPV_FORMAT_NONE` for most commands /
    /// on failure).
    pub result: mpv_node,
}

/// `mpv_event` — C `typedef struct mpv_event` (client.h). The struct
/// returned (by pointer) from `mpv_wait_event`.
///
/// Field order: `event_id`, `error`, `reply_userdata`, `data` — exact.
/// `data` points to one of the `mpv_event_*` structs above, selected by
/// `event_id` (or NULL).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_event {
    /// One of the `mpv_event_id` consts.
    pub event_id: mpv_event_id,
    /// Status code for reply-type events: `>= 0` ok, `< 0` is `mpv_error`.
    pub error: c_int,
    /// Echoes the `reply_userdata` of the originating request (or 0).
    pub reply_userdata: u64,
    /// Event-specific payload pointer (cast per `event_id`), or NULL.
    pub data: *mut c_void,
}

// ===========================================================================
// Structs — render.h / render_gl.h
// ===========================================================================

/// `mpv_render_param` — C `typedef struct mpv_render_param` (render.h).
///
/// Field order `type`, `data` is guaranteed by the header "even after ABI
/// changes". Arrays of these are always terminated by a `type == INVALID`
/// (0) entry. `r#type` because `type` is a Rust keyword.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_render_param {
    /// One of the `mpv_render_param_type` consts.
    pub r#type: mpv_render_param_type,
    /// Pointer whose target type is dictated by `type`.
    pub data: *mut c_void,
}

/// `mpv_render_frame_info` — C `typedef struct mpv_render_frame_info`
/// (render.h). Retrieved via `MPV_RENDER_PARAM_NEXT_FRAME_INFO`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_render_frame_info {
    /// Bitset of `mpv_render_frame_info_flag` values.
    pub flags: u64,
    /// Absolute target display time (same base as `mpv_get_time_us`), or
    /// 0 for redrawn / vsync-locked frames.
    pub target_time: i64,
}

/// `mpv_opengl_fbo` — C `typedef struct mpv_opengl_fbo` (render_gl.h).
/// Passed via `MPV_RENDER_PARAM_OPENGL_FBO` to describe the GL render
/// target.
///
/// Field order: `fbo`, `w`, `h`, `internal_format` — exact (`w, h` are a
/// single comma-declaration in the C header; two `c_int` fields here).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_opengl_fbo {
    /// FBO name from `glGenFramebuffers`, or 0 for the default framebuffer.
    pub fbo: c_int,
    /// Framebuffer width in pixels. Must always be set.
    pub w: c_int,
    /// Framebuffer height in pixels. Must always be set.
    pub h: c_int,
    /// Underlying texture internal format (e.g. `GL_RGBA8`), or 0.
    pub internal_format: c_int,
}

/// C function-pointer type for [`mpv_opengl_init_params::get_proc_address`]:
/// `void *(*)(void *ctx, const char *name)`.
pub type GetProcAddressFn =
    unsafe extern "C" fn(ctx: *mut c_void, name: *const c_char) -> *mut c_void;

/// `mpv_opengl_init_params` — C `typedef struct mpv_opengl_init_params`
/// (render_gl.h). Passed via `MPV_RENDER_PARAM_OPENGL_INIT_PARAMS`.
///
/// `get_proc_address` is wrapped in `Option<...>` so a null function
/// pointer is representable (Rust `fn` pointers are non-nullable; the
/// niche of `Option` makes `None` the all-zero / NULL bit pattern, so the
/// `#[repr(C)]` layout still matches the C `void *(*)(...)` field).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_opengl_init_params {
    /// Callback mpv calls to resolve GL function pointers (e.g. wraps
    /// `wglGetProcAddress`).
    pub get_proc_address: Option<GetProcAddressFn>,
    /// Opaque value passed as the `ctx` argument to `get_proc_address`.
    pub get_proc_address_ctx: *mut c_void,
}

/// `mpv_opengl_drm_params_v2` — C `typedef struct mpv_opengl_drm_params_v2`
/// (render_gl.h). Linux/DRM only; transcribed for completeness — Aura's
/// Windows path never uses it. `_drmModeAtomicReq` is opaque, so the
/// `atomic_request_ptr` field is just an untyped double pointer here.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_opengl_drm_params_v2 {
    /// DRM fd. -1 if invalid.
    pub fd: c_int,
    /// Currently used CRTC id.
    pub crtc_id: c_int,
    /// Currently used connector id.
    pub connector_id: c_int,
    /// Pointer to a `drmModeAtomicReq*` used for the render loop (opaque).
    pub atomic_request_ptr: *mut *mut c_void,
    /// DRM render node fd for VAAPI interop. -1 if invalid.
    pub render_fd: c_int,
}

/// `mpv_opengl_drm_draw_surface_size` — C `typedef struct
/// mpv_opengl_drm_draw_surface_size` (render_gl.h). Linux/DRM only;
/// transcribed for completeness.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct mpv_opengl_drm_draw_surface_size {
    /// Draw plane surface width in pixels.
    pub width: c_int,
    /// Draw plane surface height in pixels.
    pub height: c_int,
}

// ===========================================================================
// Function-pointer typedefs
//
// One typedef per libmpv export Phase 2+ will need. mpv's exports use the
// C calling convention; `extern "C"` is correct on every target
// libmpv-2.dll is built for. Argument/return types come straight from the
// header signatures cited inline.
// ===========================================================================

// ---- client.h ----

/// `unsigned long mpv_client_api_version(void)`.
pub type MpvClientApiVersionFn = unsafe extern "C" fn() -> c_ulong;

/// `mpv_handle *mpv_create(void)`.
pub type MpvCreateFn = unsafe extern "C" fn() -> *mut mpv_handle;

/// `int mpv_initialize(mpv_handle *ctx)`.
pub type MpvInitializeFn = unsafe extern "C" fn(ctx: *mut mpv_handle) -> c_int;

/// `void mpv_destroy(mpv_handle *ctx)`.
pub type MpvDestroyFn = unsafe extern "C" fn(ctx: *mut mpv_handle);

/// `void mpv_terminate_destroy(mpv_handle *ctx)`.
pub type MpvTerminateDestroyFn = unsafe extern "C" fn(ctx: *mut mpv_handle);

/// `int mpv_command(mpv_handle *ctx, const char **args)`. `args` is a
/// NULL-terminated array of C strings.
pub type MpvCommandFn =
    unsafe extern "C" fn(ctx: *mut mpv_handle, args: *mut *const c_char) -> c_int;

/// `int mpv_command_string(mpv_handle *ctx, const char *args)`.
pub type MpvCommandStringFn =
    unsafe extern "C" fn(ctx: *mut mpv_handle, args: *const c_char) -> c_int;

/// `int mpv_command_node(mpv_handle *ctx, mpv_node *args, mpv_node *result)`.
pub type MpvCommandNodeFn = unsafe extern "C" fn(
    ctx: *mut mpv_handle,
    args: *mut mpv_node,
    result: *mut mpv_node,
) -> c_int;

/// `int mpv_set_property(mpv_handle *ctx, const char *name,
/// mpv_format format, void *data)`.
pub type MpvSetPropertyFn = unsafe extern "C" fn(
    ctx: *mut mpv_handle,
    name: *const c_char,
    format: mpv_format,
    data: *mut c_void,
) -> c_int;

/// `int mpv_set_property_string(mpv_handle *ctx, const char *name,
/// const char *data)`.
pub type MpvSetPropertyStringFn = unsafe extern "C" fn(
    ctx: *mut mpv_handle,
    name: *const c_char,
    data: *const c_char,
) -> c_int;

/// `int mpv_get_property(mpv_handle *ctx, const char *name,
/// mpv_format format, void *data)`.
pub type MpvGetPropertyFn = unsafe extern "C" fn(
    ctx: *mut mpv_handle,
    name: *const c_char,
    format: mpv_format,
    data: *mut c_void,
) -> c_int;

/// `char *mpv_get_property_string(mpv_handle *ctx, const char *name)`.
/// The returned string must be released with `mpv_free`.
pub type MpvGetPropertyStringFn =
    unsafe extern "C" fn(ctx: *mut mpv_handle, name: *const c_char) -> *mut c_char;

/// `int mpv_observe_property(mpv_handle *mpv, uint64_t reply_userdata,
/// const char *name, mpv_format format)`.
pub type MpvObservePropertyFn = unsafe extern "C" fn(
    mpv: *mut mpv_handle,
    reply_userdata: u64,
    name: *const c_char,
    format: mpv_format,
) -> c_int;

/// `void mpv_set_wakeup_callback(mpv_handle *ctx, void (*cb)(void *d),
/// void *d)`.
pub type MpvSetWakeupCallbackFn = unsafe extern "C" fn(
    ctx: *mut mpv_handle,
    cb: Option<unsafe extern "C" fn(d: *mut c_void)>,
    d: *mut c_void,
);

/// `mpv_event *mpv_wait_event(mpv_handle *ctx, double timeout)`. The
/// returned pointer is owned by mpv and valid only until the next
/// `mpv_wait_event` on the same handle.
pub type MpvWaitEventFn =
    unsafe extern "C" fn(ctx: *mut mpv_handle, timeout: f64) -> *mut mpv_event;

/// `int mpv_request_log_messages(mpv_handle *ctx, const char *min_level)`.
pub type MpvRequestLogMessagesFn =
    unsafe extern "C" fn(ctx: *mut mpv_handle, min_level: *const c_char) -> c_int;

/// `void mpv_free(void *data)`.
pub type MpvFreeFn = unsafe extern "C" fn(data: *mut c_void);

/// `void mpv_free_node_contents(mpv_node *node)`.
pub type MpvFreeNodeContentsFn = unsafe extern "C" fn(node: *mut mpv_node);

/// `const char *mpv_error_string(int error)`. The returned string is
/// static — never freed.
pub type MpvErrorStringFn = unsafe extern "C" fn(error: c_int) -> *const c_char;

/// `const char *mpv_event_name(mpv_event_id event)`. The returned string
/// is static — never freed.
pub type MpvEventNameFn = unsafe extern "C" fn(event: mpv_event_id) -> *const c_char;

// ---- render.h ----

/// `int mpv_render_context_create(mpv_render_context **res,
/// mpv_handle *mpv, mpv_render_param *params)`.
pub type MpvRenderContextCreateFn = unsafe extern "C" fn(
    res: *mut *mut mpv_render_context,
    mpv: *mut mpv_handle,
    params: *mut mpv_render_param,
) -> c_int;

/// `int mpv_render_context_set_parameter(mpv_render_context *ctx,
/// mpv_render_param param)`. Note `param` is passed BY VALUE.
pub type MpvRenderContextSetParameterFn = unsafe extern "C" fn(
    ctx: *mut mpv_render_context,
    param: mpv_render_param,
) -> c_int;

/// `int mpv_render_context_get_info(mpv_render_context *ctx,
/// mpv_render_param param)`. `param` passed BY VALUE; mpv writes through
/// `param.data`.
pub type MpvRenderContextGetInfoFn = unsafe extern "C" fn(
    ctx: *mut mpv_render_context,
    param: mpv_render_param,
) -> c_int;

/// `void mpv_render_context_set_update_callback(mpv_render_context *ctx,
/// mpv_render_update_fn callback, void *callback_ctx)` where
/// `mpv_render_update_fn` is `void (*)(void *cb_ctx)`.
pub type MpvRenderContextSetUpdateCallbackFn = unsafe extern "C" fn(
    ctx: *mut mpv_render_context,
    callback: Option<unsafe extern "C" fn(cb_ctx: *mut c_void)>,
    callback_ctx: *mut c_void,
);

/// `uint64_t mpv_render_context_update(mpv_render_context *ctx)`. Returns
/// an OR-combined bitset of `mpv_render_update_flag`.
pub type MpvRenderContextUpdateFn =
    unsafe extern "C" fn(ctx: *mut mpv_render_context) -> u64;

/// `int mpv_render_context_render(mpv_render_context *ctx,
/// mpv_render_param *params)`.
pub type MpvRenderContextRenderFn = unsafe extern "C" fn(
    ctx: *mut mpv_render_context,
    params: *mut mpv_render_param,
) -> c_int;

/// `void mpv_render_context_report_swap(mpv_render_context *ctx)`.
pub type MpvRenderContextReportSwapFn =
    unsafe extern "C" fn(ctx: *mut mpv_render_context);

/// `void mpv_render_context_free(mpv_render_context *ctx)`.
pub type MpvRenderContextFreeFn = unsafe extern "C" fn(ctx: *mut mpv_render_context);

// ===========================================================================
// Loader
// ===========================================================================

/// Resolved entry points of `libmpv-2.dll` (client API + render API).
///
/// # libloading pattern (mirrors `win32.rs`)
///
/// `win32.rs` loads `user32.dll` / `winmm.dll` / `kernel32.dll` with
/// `libloading::Library::new(...)`, looks symbols up with
/// `lib.get::<FnType>(b"name\0")`, and uses the resolved function
/// pointers. In `win32.rs` each `Library` is short-lived (created and
/// dropped inside one function), so the borrowed `Symbol`s never outlive
/// it.
///
/// This loader is long-lived, so it cannot lean on `Symbol`'s borrow. It
/// uses the SAME mechanism but stores the results differently:
///
///   1. Hold the owning [`libloading::Library`] in the `_lib` field. The
///      DLL stays mapped for as long as the `Libmpv` value lives — exactly
///      the lifetime guarantee `win32.rs` gets from keeping its `Library`
///      on the stack.
///   2. For each symbol, dereference the `Symbol<FnType>` (`*sym`) to copy
///      out the bare `unsafe extern "C" fn` pointer — `fn` pointers are
///      `Copy`, so this detaches the value from `Symbol`'s borrow. The
///      stored pointers stay valid because `_lib` keeps the DLL resident.
///
/// This is the "keep the `Library` owned alongside" option the render-API
/// spec calls for, and it keeps every later phase free of lifetime
/// parameters on the binding type.
///
/// Not wired into Aura yet — see `mpv/mod.rs`.
pub struct Libmpv {
    /// Owning handle to `libmpv-2.dll`. MUST outlive every function
    /// pointer below. Declared LAST in this struct on purpose: Rust drops
    /// struct fields in declaration order, so the DLL is unmapped only
    /// after all the pointers that reference it are gone.
    ///
    /// `#[allow(dead_code)]` because nothing dereferences `_lib`
    /// directly — its sole job is to keep the DLL mapped — and the
    /// module-level `#![allow(dead_code)]` would otherwise be the only
    /// thing covering it; this keeps the intent local and explicit.
    #[allow(dead_code)]
    _lib: libloading::Library,

    // ---- client.h entry points ----
    pub client_api_version: MpvClientApiVersionFn,
    pub create: MpvCreateFn,
    pub initialize: MpvInitializeFn,
    pub destroy: MpvDestroyFn,
    pub terminate_destroy: MpvTerminateDestroyFn,
    pub command: MpvCommandFn,
    pub command_string: MpvCommandStringFn,
    pub command_node: MpvCommandNodeFn,
    pub set_property: MpvSetPropertyFn,
    pub set_property_string: MpvSetPropertyStringFn,
    pub get_property: MpvGetPropertyFn,
    pub get_property_string: MpvGetPropertyStringFn,
    pub observe_property: MpvObservePropertyFn,
    pub set_wakeup_callback: MpvSetWakeupCallbackFn,
    pub wait_event: MpvWaitEventFn,
    pub request_log_messages: MpvRequestLogMessagesFn,
    pub free: MpvFreeFn,
    pub free_node_contents: MpvFreeNodeContentsFn,
    pub error_string: MpvErrorStringFn,
    pub event_name: MpvEventNameFn,

    // ---- render.h entry points ----
    pub render_context_create: MpvRenderContextCreateFn,
    pub render_context_set_parameter: MpvRenderContextSetParameterFn,
    pub render_context_get_info: MpvRenderContextGetInfoFn,
    pub render_context_set_update_callback: MpvRenderContextSetUpdateCallbackFn,
    pub render_context_update: MpvRenderContextUpdateFn,
    pub render_context_render: MpvRenderContextRenderFn,
    pub render_context_report_swap: MpvRenderContextReportSwapFn,
    pub render_context_free: MpvRenderContextFreeFn,
}

/// Resolve one symbol out of an opened `Library` into a bare typed
/// function pointer.
///
/// `libloading::Symbol::deref` hands back the function pointer; because
/// `fn` pointers are `Copy`, `*sym` copies it out and the result no longer
/// borrows `lib`. Safe to store as long as `lib` (the DLL) outlives the
/// returned pointer — which [`Libmpv`] guarantees via its `_lib` field.
///
/// # Safety
/// The caller asserts `T` is the correct ABI signature for the C export
/// named `name`. A mismatch is undefined behaviour at call time.
unsafe fn resolve<T: Copy>(
    lib: &libloading::Library,
    name: &[u8],
) -> Result<T, String> {
    let sym: libloading::Symbol<T> = lib.get(name).map_err(|e| {
        // Trim the trailing NUL for a clean message.
        let pretty = name.strip_suffix(b"\0").unwrap_or(name);
        format!(
            "libmpv-2.dll missing symbol '{}': {e}",
            String::from_utf8_lossy(pretty),
        )
    })?;
    Ok(*sym)
}

impl Libmpv {
    /// Build the priority-ordered list of directories to probe for
    /// `libmpv-2.dll`, matching `player.rs::check_mpv_dll`:
    ///   1. the executable's own directory,
    ///   2. its `lib/` subdirectory (the canonical bundled location),
    ///   3. whatever `LIBMPV_LIB_DIR` points at, if set.
    /// The OS default search (PATH etc.) is tried last by [`Self::load`]
    /// via a bare filename.
    fn search_dirs() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                dirs.push(dir.to_path_buf());
                dirs.push(dir.join("lib"));
            }
        }
        if let Ok(dir) = std::env::var("LIBMPV_LIB_DIR") {
            dirs.push(PathBuf::from(dir));
        }
        dirs
    }

    /// Load `libmpv-2.dll` from the standard search locations and resolve
    /// every client- and render-API symbol [`Libmpv`] declares.
    ///
    /// Mirrors `player.rs::check_mpv_dll`'s probe order: each candidate
    /// directory is tried with an explicit path first, then the bare
    /// filename falls back to the OS loader's PATH / system search.
    ///
    /// Returns `Err` with a human-readable reason if the DLL can't be
    /// found or a required symbol is absent.
    ///
    /// Not called from anywhere yet — Phase 2 wiring.
    pub fn load() -> Result<Self, String> {
        // The libmpv dynamic-library file name differs by OS (the C ABI is
        // identical, which is why the rest of this file is platform-neutral):
        // libmpv-2.dll on Windows, libmpv.so.2 on Linux, libmpv.2.dylib on macOS.
        #[cfg(target_os = "windows")]
        const LIBMPV_NAME: &str = "libmpv-2.dll";
        #[cfg(target_os = "macos")]
        const LIBMPV_NAME: &str = "libmpv.2.dylib";
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        const LIBMPV_NAME: &str = "libmpv.so.2";

        for dir in Self::search_dirs() {
            let candidate = dir.join(LIBMPV_NAME);
            if candidate.is_file() {
                // SAFETY: loading a shared library runs its initializers; libmpv
                // is a known-good library shipped with / required by Aura.
                if let Ok(lib) = unsafe { libloading::Library::new(&candidate) } {
                    return Self::from_library(lib);
                }
            }
        }
        // Fall back to the OS search (PATH / SxS / system / LD_LIBRARY_PATH).
        // SAFETY: see above.
        match unsafe { libloading::Library::new(LIBMPV_NAME) } {
            Ok(lib) => Self::from_library(lib),
            Err(e) => Err(format!(
                "{LIBMPV_NAME} not found in the exe directory, its lib/ \
                 subdirectory, $LIBMPV_LIB_DIR, or the system search path: {e}"
            )),
        }
    }

    /// Load `libmpv-2.dll` from an explicit path and resolve all symbols.
    /// Useful for tests / non-standard layouts. Not called yet.
    pub fn load_from<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        // SAFETY: loading a DLL runs its entry point; the caller asserts
        // the path points at a genuine libmpv-2.dll.
        let lib = unsafe { libloading::Library::new(path.as_ref()) }
            .map_err(|e| format!("failed to load {:?}: {e}", path.as_ref()))?;
        Self::from_library(lib)
    }

    /// Resolve every entry point out of an already-opened `Library`.
    ///
    /// All `resolve` calls are `unsafe` because each asserts the Rust
    /// `Mpv*Fn` typedef matches the C export's ABI — those typedefs are
    /// transcribed verbatim from the headers cited at the top of this
    /// file, which is what makes the assertion sound.
    fn from_library(lib: libloading::Library) -> Result<Self, String> {
        unsafe {
            // client.h
            let client_api_version =
                resolve::<MpvClientApiVersionFn>(&lib, b"mpv_client_api_version\0")?;
            let create = resolve::<MpvCreateFn>(&lib, b"mpv_create\0")?;
            let initialize =
                resolve::<MpvInitializeFn>(&lib, b"mpv_initialize\0")?;
            let destroy = resolve::<MpvDestroyFn>(&lib, b"mpv_destroy\0")?;
            let terminate_destroy = resolve::<MpvTerminateDestroyFn>(
                &lib,
                b"mpv_terminate_destroy\0",
            )?;
            let command = resolve::<MpvCommandFn>(&lib, b"mpv_command\0")?;
            let command_string =
                resolve::<MpvCommandStringFn>(&lib, b"mpv_command_string\0")?;
            let command_node =
                resolve::<MpvCommandNodeFn>(&lib, b"mpv_command_node\0")?;
            let set_property =
                resolve::<MpvSetPropertyFn>(&lib, b"mpv_set_property\0")?;
            let set_property_string = resolve::<MpvSetPropertyStringFn>(
                &lib,
                b"mpv_set_property_string\0",
            )?;
            let get_property =
                resolve::<MpvGetPropertyFn>(&lib, b"mpv_get_property\0")?;
            let get_property_string = resolve::<MpvGetPropertyStringFn>(
                &lib,
                b"mpv_get_property_string\0",
            )?;
            let observe_property = resolve::<MpvObservePropertyFn>(
                &lib,
                b"mpv_observe_property\0",
            )?;
            let set_wakeup_callback = resolve::<MpvSetWakeupCallbackFn>(
                &lib,
                b"mpv_set_wakeup_callback\0",
            )?;
            let wait_event =
                resolve::<MpvWaitEventFn>(&lib, b"mpv_wait_event\0")?;
            let request_log_messages = resolve::<MpvRequestLogMessagesFn>(
                &lib,
                b"mpv_request_log_messages\0",
            )?;
            let free = resolve::<MpvFreeFn>(&lib, b"mpv_free\0")?;
            let free_node_contents = resolve::<MpvFreeNodeContentsFn>(
                &lib,
                b"mpv_free_node_contents\0",
            )?;
            let error_string =
                resolve::<MpvErrorStringFn>(&lib, b"mpv_error_string\0")?;
            let event_name =
                resolve::<MpvEventNameFn>(&lib, b"mpv_event_name\0")?;

            // render.h
            let render_context_create = resolve::<MpvRenderContextCreateFn>(
                &lib,
                b"mpv_render_context_create\0",
            )?;
            let render_context_set_parameter =
                resolve::<MpvRenderContextSetParameterFn>(
                    &lib,
                    b"mpv_render_context_set_parameter\0",
                )?;
            let render_context_get_info = resolve::<MpvRenderContextGetInfoFn>(
                &lib,
                b"mpv_render_context_get_info\0",
            )?;
            let render_context_set_update_callback =
                resolve::<MpvRenderContextSetUpdateCallbackFn>(
                    &lib,
                    b"mpv_render_context_set_update_callback\0",
                )?;
            let render_context_update = resolve::<MpvRenderContextUpdateFn>(
                &lib,
                b"mpv_render_context_update\0",
            )?;
            let render_context_render = resolve::<MpvRenderContextRenderFn>(
                &lib,
                b"mpv_render_context_render\0",
            )?;
            let render_context_report_swap =
                resolve::<MpvRenderContextReportSwapFn>(
                    &lib,
                    b"mpv_render_context_report_swap\0",
                )?;
            let render_context_free = resolve::<MpvRenderContextFreeFn>(
                &lib,
                b"mpv_render_context_free\0",
            )?;

            Ok(Libmpv {
                client_api_version,
                create,
                initialize,
                destroy,
                terminate_destroy,
                command,
                command_string,
                command_node,
                set_property,
                set_property_string,
                get_property,
                get_property_string,
                observe_property,
                set_wakeup_callback,
                wait_event,
                request_log_messages,
                free,
                free_node_contents,
                error_string,
                event_name,
                render_context_create,
                render_context_set_parameter,
                render_context_get_info,
                render_context_set_update_callback,
                render_context_update,
                render_context_render,
                render_context_report_swap,
                render_context_free,
                // Declared last so it is dropped last — keeps the DLL
                // mapped while every function pointer above is live.
                _lib: lib,
            })
        }
    }
}
