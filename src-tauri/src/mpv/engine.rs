// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv::engine` — Aura's single playback engine: direct-FFI libmpv
//! embedded via `--wid` into an engine-owned host child window.
//!
//! ## Consolidation history (2026-06)
//!
//! This module started life as the render-API rewrite (mpv driven through
//! `mpv_render_context_*` into an engine-owned WGL surface, to fix DWM
//! throttling of the `--wid` child's presentation while Aura was
//! backgrounded). The render path shipped as the default in v0.9.0 but was
//! **consolidated away** in favour of `--wid` embedding on the same FFI
//! foundation, because:
//!
//!   * the render API on this libmpv build is hardcoded to `gl_video` —
//!     `vo=gpu-next` (and with it scRGB/HDR passthrough) is unreachable;
//!     real HDR needed a host DXGI flip swapchain + `WGL_NV_DX_interop2`
//!     (see `docs/superpowers/specs/2026-06-03-mpv-hdr-dxgi-interop-
//!     design.md`), an L-effort, HW-gated build;
//!   * `--wid` + `vo=gpu-next` + d3d11 does correct HDR/Dolby-Vision
//!     passthrough today (`target-colorspace-hint` is honoured by the
//!     d3d11 GPU context), and mpv's own DXGI swapchain opts out of the
//!     Win11 Independent-Flip/MPO promotion that plagued the WGL surface;
//!   * dropping the render path also drops `tauri-plugin-libmpv` /
//!     `libmpv-wrapper.dll` (the legacy plugin) entirely — one engine,
//!     one DLL (`libmpv-2.dll`), one event channel.
//!
//! The known cost is the original off-focus DWM throttling of a `--wid`
//! child's swapchain — accepted for now; the FFI foundation kept here is
//! the basis for optimising that later.
//!
//! ## Architecture
//!
//! A dedicated engine thread owns a plain Win32 host child window (black
//! class brush, `HWND_BOTTOM` so the transparent WebView2 stays on top),
//! creates the mpv handle with `wid=<host HWND>` + `vo=gpu-next` +
//! `hwdec=auto`, and then runs a light pump loop: drain mpv events →
//! drain the command channel → resync geometry to the parent's client
//! rect → sleep [`TICK`]. mpv owns rendering/presentation entirely (its
//! child window of the host), so there is no render loop here.
//!
//! `AURA_MPV2` is no longer honoured — the legacy plugin path it selected
//! is gone. Setting it to an off value logs a warning at startup (see
//! [`legacy_env_requested`]).
//!
//! Windows-only — gated at the `mod` declaration in [`super`].

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, AtomicIsize, AtomicU8, Ordering},
    mpsc::{self, Receiver, Sender, TryRecvError},
    Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT,
    RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, EndPaint, EnumDisplaySettingsW, GetMonitorInfoW,
    MonitorFromWindow, DEVMODEW, ENUM_CURRENT_SETTINGS, MONITORINFO, MONITORINFOEXW,
    MONITOR_DEFAULTTONEAREST, PAINTSTRUCT,
};
use windows::Win32::Foundation::COLORREF;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
    GetForegroundWindow, IsIconic, IsWindow, IsWindowVisible,
    MsgWaitForMultipleObjects, PeekMessageW, RegisterClassW, SetWindowPos,
    TranslateMessage, HWND_BOTTOM, MSG, PM_REMOVE, QS_ALLINPUT,
    SWP_DEFERERASE, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, WINDOW_EX_STYLE, WM_PAINT, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
    WS_VISIBLE,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

use super::ffi::{
    mpv_event_end_file, mpv_event_id, mpv_event_log_message, mpv_event_property,
    mpv_format, mpv_handle, Libmpv,
};

// ===========================================================================
// Public API
// ===========================================================================

/// Type-erased emit callback the engine uses to push events to the
/// frontend. lib.rs's setup provides a closure that calls
/// `app.emit("mpv-event-main", payload)` on the active `AppHandle`. The
/// engine module stays Tauri-agnostic by going through this boxed `Fn`.
pub type EngineEmit = Box<dyn Fn(&str, serde_json::Value) + Send + Sync + 'static>;

/// Typed property value the engine accepts when forwarding
/// `mpv_set_property`. Tauri command handlers pick the variant that
/// matches mpv's documented format for the property — FLAG for booleans
/// like `pause` / `sub-visibility`, DOUBLE for `volume` / `speed` /
/// `audio-delay`, STRING for `aid` / `sid` (mpv accepts "auto" / "no" /
/// numeric strings here), INT64 for the few integer properties Aura
/// touches. Picking the wrong variant returns an mpv error code rather
/// than corrupting state.
pub enum PropValue {
    Flag(bool),
    Int64(i64),
    Double(f64),
    String(String),
}

/// Format hint for [`EngineCommand::GetProperty`], mirroring mpv's
/// `mpv_format` enum. The engine reads via `mpv_get_property` with the
/// matching format and serialises the result to JSON for the reply
/// channel so the Tauri command handler can hand it straight back to JS.
pub enum GetFormat {
    Flag,
    Int64,
    Double,
    String,
}

/// A request submitted to the engine's render thread.
///
/// The render thread owns `*mut mpv_handle` and `*mut mpv_render_context`
/// uniquely — those pointers stay off other threads to avoid a `Sync`
/// fight with raw FFI types. Tauri command handlers submit a typed
/// `EngineCommand` instead and the render thread drains the queue between
/// frames, executing each on the libmpv client API.
///
/// Phase 4 surface:
/// * Typed variants for the hot, special-cased operations (`LoadFile`
///   needs pre/post pause clears, `TogglePause` / `SetVolume` are
///   submitted often enough to justify dedicated dispatch).
/// * Generic `Command` / `SetProperty` / `GetProperty` variants for the
///   long tail — every other command / property site in lib.rs routes
///   through these.
/// * `GetProperty` carries a synchronous reply `Sender` so the calling
///   Tauri command can await the result.
enum EngineCommand {
    Shutdown,
    LoadFile {
        url: String,
        start_seconds: Option<f64>,
    },
    TogglePause,
    SetVolume(f64),
    Command(Vec<String>),
    SetProperty {
        name: String,
        value: PropValue,
    },
    GetProperty {
        name: String,
        format: GetFormat,
        /// One-shot reply channel: `Ok(Value)` on success, `Err(msg)` on
        /// mpv error or a name/format mismatch. The Tauri handler blocks
        /// on `reply.recv()` and forwards either to JS.
        reply: Sender<Result<serde_json::Value, String>>,
    },
}

/// Live engine bookkeeping. Held inside [`ENGINE`] for the engine's lifetime.
struct EngineHandle {
    tx: Sender<EngineCommand>,
    join: Option<JoinHandle<()>>,
}

/// Process-global slot for the live engine. `OnceLock<Mutex<Option<_>>>` so
/// [`start`] / [`shutdown_if_running`] can be called from
/// arbitrary call sites without threading a Tauri-managed state through.
static ENGINE: OnceLock<Mutex<Option<EngineHandle>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<EngineHandle>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Parent (main window) HWND, published by [`start`] so helpers that need
/// monitor-relative queries can reach it from any thread without holding
/// engine state. 0 = engine never started.
static PARENT_HWND: AtomicIsize = AtomicIsize::new(0);

/// Refresh rate (Hz) of the monitor the main window currently occupies.
///
/// Used by `set_motion_interpolation` to pin mpv's
/// `display-fps-override`: in `--wid` embedded mode mpv doesn't own a
/// top-level window, so its own vsync/display-FPS estimation is
/// unreliable — and `video-sync=display-resample` with a mis-estimated
/// display FPS resamples video to the wrong clock, which manifests as
/// severe, constant frame drops the moment interpolation turns on.
/// `EnumDisplaySettingsW(ENUM_CURRENT_SETTINGS)` on the window's monitor
/// returns the mode's true vertical refresh, sidestepping the estimate.
pub fn parent_display_refresh_hz() -> Option<f64> {
    let raw = PARENT_HWND.load(Ordering::Acquire);
    if raw == 0 {
        return None;
    }
    unsafe {
        let hwnd = HWND(raw as *mut c_void);
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return None;
        }
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO)
            .as_bool()
        {
            return None;
        }
        let mut dm = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        if !EnumDisplaySettingsW(
            PCWSTR(mi.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut dm,
        )
        .as_bool()
        {
            return None;
        }
        let hz = dm.dmDisplayFrequency;
        // 23..1000 sanity window — 0/1 mean "hardware default" (unusable),
        // and anything outside the window is a driver-reporting artifact.
        if !(23..=1000).contains(&hz) {
            return None;
        }
        Some(hz as f64)
    }
}

/// Historical env-var gate for the mpv path. It used to select between
/// this engine and the legacy `tauri-plugin-libmpv` `--wid` path; the
/// legacy path was removed in the engine consolidation, so the variable
/// no longer changes anything. Kept only so [`legacy_env_requested`] can
/// warn users whose launch scripts still set `AURA_MPV2=0`.
pub const ENV_VAR: &str = "AURA_MPV2";

/// True when [`ENV_VAR`] is explicitly set to an off value — `0`,
/// `false`, `off`, or `no` (case-insensitive, trimmed). The setup path
/// devlogs a warning in that case: the legacy engine this used to select
/// no longer exists, so the variable is ignored.
pub fn legacy_env_requested() -> bool {
    match std::env::var(ENV_VAR) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no",
        ),
        Err(_) => false,
    }
}

/// Whether the engine thread is currently running. Tauri command handlers
/// gate on this to decide between the mpv path and the legacy path.
pub fn is_running() -> bool {
    engine_slot()
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false)
}

/// Spawn the engine — Aura's only playback path. Idempotent: a second
/// call while the engine is already running returns without doing
/// anything.
///
/// `parent_hwnd` is the Tauri main window's HWND, passed as `isize` so it
/// can cross the thread boundary (`HWND` itself is not `Send`). The engine
/// thread re-wraps it. Passing 0 skips the spawn entirely — a defensive
/// fall-through when the main window's HWND can't be resolved at setup
/// time (every playback command then fails with "engine not running"
/// instead of crashing). `emit` is the channel the engine thread uses to
/// push mpv events (property changes, end-of-file, …) back to the
/// frontend through Tauri.
pub fn start(parent_hwnd: isize, emit: EngineEmit) {
    if parent_hwnd == 0 {
        crate::devlog!(
            error, "mpv",
            "parent HWND is 0 — engine not spawned; playback will be unavailable",
        );
        return;
    }
    let mut slot = match engine_slot().lock() {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(error, "mpv", "engine slot poisoned on start: {e}");
            return;
        }
    };
    if slot.is_some() {
        return;
    }
    crate::devlog!(
        info, "mpv",
        "spawning playback engine — FFI --wid embedding (parent HWND {parent_hwnd:#x})",
    );
    PARENT_HWND.store(parent_hwnd, Ordering::Release);

    let (tx, rx) = mpsc::channel::<EngineCommand>();
    let join = match thread::Builder::new()
        .name("aura-mpv-engine".into())
        .spawn(move || run_engine(rx, parent_hwnd, emit))
    {
        Ok(j) => j,
        Err(e) => {
            crate::devlog!(error, "mpv", "failed to spawn engine thread: {e}");
            return;
        }
    };

    *slot = Some(EngineHandle { tx, join: Some(join) });
}

/// Submit a `LoadFile` command. Returns an error if the engine isn't
/// running (master gate off or pre-startup) or the channel is closed.
pub fn submit_load_file(url: String, start_seconds: Option<f64>) -> Result<(), String> {
    submit(EngineCommand::LoadFile { url, start_seconds })
}

/// Submit a `TogglePause` command.
pub fn submit_toggle_pause() -> Result<(), String> {
    submit(EngineCommand::TogglePause)
}

/// Submit a `SetVolume` command. Volume is in mpv's `volume` property
/// units (0.0 = mute, 100.0 = unity gain).
pub fn submit_set_volume(volume: f64) -> Result<(), String> {
    submit(EngineCommand::SetVolume(volume))
}

/// Submit an arbitrary mpv `command` — the `args` slice is the same as
/// the C `const char **args` form: positional command name first, then
/// arguments, no trailing NULL (the engine appends it). Use this for the
/// long tail of Aura's command call sites (seek, stop, frame-step,
/// sub-add, af add/remove, change-list, ...).
pub fn submit_command(args: Vec<String>) -> Result<(), String> {
    submit(EngineCommand::Command(args))
}

/// Submit an arbitrary `mpv_set_property` write. Pick the [`PropValue`]
/// variant that matches mpv's documented format for `name` — getting
/// this wrong returns an mpv error rather than corrupting state.
pub fn submit_set_property(name: String, value: PropValue) -> Result<(), String> {
    submit(EngineCommand::SetProperty { name, value })
}

/// Submit a synchronous `mpv_get_property` read. Returns the property's
/// value as JSON or an mpv error message. Blocks the calling thread on
/// the engine's reply channel — keep the call off the Tauri main runtime
/// (use `spawn_blocking` in the Tauri handler).
pub fn submit_get_property(
    name: String,
    format: GetFormat,
) -> Result<serde_json::Value, String> {
    let (reply_tx, reply_rx) = mpsc::channel();
    submit(EngineCommand::GetProperty {
        name,
        format,
        reply: reply_tx,
    })?;
    match reply_rx.recv() {
        Ok(r) => r,
        Err(e) => Err(format!("engine reply channel closed: {e}")),
    }
}

/// Shared submit path — locks the slot briefly, sends through the
/// channel, releases. Multiple Tauri command handlers can call this
/// concurrently; the render thread drains them in order between frames.
fn submit(cmd: EngineCommand) -> Result<(), String> {
    let slot = engine_slot()
        .lock()
        .map_err(|e| format!("engine slot poisoned: {e}"))?;
    let Some(h) = slot.as_ref() else {
        return Err("engine not running".to_string());
    };
    h.tx.send(cmd).map_err(|e| format!("engine channel closed: {e}"))
}

/// Tear down the engine if one is running. Safe to call when none was
/// started — used unconditionally from the `CloseRequested` path so the
/// engine thread (and with it mpv's synchronous mute → stop →
/// terminate_destroy teardown — the WASAPI-clean shutdown discipline,
/// landmine #9) completes before the process exits.
pub fn shutdown_if_running() {
    let mut slot = match engine_slot().lock() {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(error, "mpv", "engine slot poisoned on shutdown: {e}");
            return;
        }
    };
    let Some(EngineHandle { tx, join }) = slot.take() else {
        return;
    };
    drop(slot);

    let _ = tx.send(EngineCommand::Shutdown);
    if let Some(j) = join {
        join_with_message_pump(j);
    }
    crate::devlog!(info, "mpv", "engine shut down");
}

/// Wait for the engine thread to finish while continuing to pump Win32
/// messages on the calling (main) thread.
///
/// A plain `JoinHandle::join` would block the message loop, which deadlocks
/// the engine's teardown: `DestroyWindow` on a child sends `WM_PARENTNOTIFY`
/// synchronously to the parent window's owning thread (the main thread),
/// and any `SetWindowPos` on a child may route notifications through the
/// parent's thread too. If the main thread is asleep in `join`, those
/// sends never complete and neither side moves. `MsgWaitForMultipleObjects`
/// wakes us up either when the thread finishes OR when a message arrives;
/// in the message-arrived case we drain the queue and loop. Capped at 5 s
/// so a genuinely hung worker can't stall app shutdown indefinitely.
fn join_with_message_pump(j: JoinHandle<()>) {
    use std::os::windows::io::AsRawHandle;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::HANDLE;

    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 0x102;
    const WAIT_FAILED: u32 = 0xFFFF_FFFF;
    const TIMEOUT: Duration = Duration::from_secs(5);

    let raw = j.as_raw_handle();
    let handle = HANDLE(raw);
    let handles = [handle];
    let deadline = Instant::now() + TIMEOUT;

    loop {
        let remaining_ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u32::MAX as u128) as u32;
        if remaining_ms == 0 {
            crate::devlog!(
                warn, "mpv",
                "engine join timed out after 5 s — detaching thread",
            );
            std::mem::forget(j);
            return;
        }
        // MsgWaitForMultipleObjects returns WAIT_EVENT(u32) in this windows
        // crate version; compare the inner u32 against the documented
        // sentinels rather than rebinding their names as match patterns.
        let res = unsafe {
            MsgWaitForMultipleObjects(
                Some(&handles),
                false,
                remaining_ms,
                QS_ALLINPUT,
            )
        }
        .0;
        if res == WAIT_OBJECT_0 {
            break;
        }
        if res == WAIT_TIMEOUT {
            crate::devlog!(
                warn, "mpv",
                "engine join timed out — detaching thread",
            );
            std::mem::forget(j);
            return;
        }
        if res == WAIT_FAILED {
            crate::devlog!(
                error, "mpv",
                "MsgWaitForMultipleObjects failed — detaching thread",
            );
            std::mem::forget(j);
            return;
        }
        // Any other wake (typically WAIT_OBJECT_0 + 1 = "messages
        // available") means: pump the queue so the engine thread's
        // cross-thread Win32 sends can complete, then retry the wait.
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
    if let Err(e) = j.join() {
        crate::devlog!(error, "mpv", "engine thread join panicked: {e:?}");
    }
}

// ===========================================================================
// Render-thread internals
// ===========================================================================

const CLASS_NAME: PCWSTR = w!("AuraMpvEngineWindow");
const WINDOW_NAME: PCWSTR = w!("Aura render-API engine");

/// Title-bar inset for the engine window in windowed mode — matches the
/// custom React-rendered TitleBar height that the existing `--wid` MPV
/// child is also offset under (see `win32::resize_mpv_child_to_parent` call
/// sites in `window_logic.rs`). In native fullscreen the inset is 0 — the
/// title bar is unmounted and the engine occupies the full client area.
const TITLE_BAR_H: i32 = 36;

/// Fallback engine size used only when [`GetClientRect`] on the parent
/// fails at startup (so creation can still succeed and the per-frame resync
/// in [`run_engine`] can recover on the next iteration).
const FALLBACK_W: i32 = 720;
const FALLBACK_H: i32 = 460;

/// Engine pump cadence. mpv owns rendering/presentation entirely under
/// `--wid` embedding, so this loop only drains mpv events, drains the
/// command channel, and resyncs geometry — 5 ms keeps command latency
/// (pause/seek/volume) and event latency (time-pos at ~30 Hz) invisible
/// while costing ~0 CPU. `pin_process_scheduling` holds
/// `timeBeginPeriod(1)` for the process lifetime, so `thread::sleep`
/// granularity here is ~1 ms.
const TICK: Duration = Duration::from_millis(5);

/// Current [`PresentMode`] discriminant, published from the render thread
/// on every mode transition. 255 = engine not running. Read by the debug
/// Tauri commands so the Settings → Debug Stuff panel can show the live
/// state without touching the render thread.
static CURRENT_MODE: AtomicU8 = AtomicU8::new(255);

/// Whether the display should be kept awake (set by the frontend via the
/// `set_keep_display_awake` Tauri command when the player is active and
/// unpaused). The render thread reads this each iteration and asserts /
/// releases `SetThreadExecutionState` on transition — see the call in
/// [`run_engine`] and [`crate::win32::set_display_sleep_inhibited`] for why
/// it must be driven from the single render thread.
static DISPLAY_AWAKE_DESIRED: AtomicBool = AtomicBool::new(false);

/// Set by `lib.rs::set_keep_display_awake`. Frontend calls this on every
/// `isPlayerActive && !paused` change. No-op beyond the store; the render
/// loop does the actual SetThreadExecutionState on its own thread.
pub fn set_display_awake_desired(awake: bool) {
    DISPLAY_AWAKE_DESIRED.store(awake, Ordering::Release);
}

/// Read the engine's current [`PresentMode`]. Returns `None` when the
/// engine isn't running.
pub fn current_present_mode() -> Option<PresentMode> {
    PresentMode::from_u8(CURRENT_MODE.load(Ordering::Acquire))
}

/// Host-window wndproc. Only `WM_PAINT` is special-cased; everything else
/// (including `WM_SIZE`, `WM_ERASEBKGND`, `WM_WINDOWPOSCHANGED`) goes to
/// the default handler. The engine thread polls the parent's client rect
/// every tick and `SetWindowPos`-es the host when the parent has moved,
/// driving its own resize — the wndproc doesn't need a fast-path because
/// the engine thread is already the source of geometry change.
///
/// * `WM_PAINT` → BeginPaint / EndPaint with no GDI work, return 0. The
///   actual painting is mpv's child window (full host coverage); the host
///   itself only ever shows its black class brush during resize gaps.
///   This handler just validates the paint rect so Windows doesn't
///   immediately re-fire WM_PAINT.
unsafe extern "system" fn engine_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_PAINT {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let _ = BeginPaint(hwnd, &mut ps);
        let _ = EndPaint(hwnd, &ps);
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// `<null>`-safe NUL-terminated-C-string → owned `String`.
unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return "<null>".to_string();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

unsafe fn err_str(lib: &Libmpv, code: c_int) -> String {
    format!("{code} ({})", cstr((lib.error_string)(code)))
}

/// Run an mpv `command`-style call: `mpv_command(handle, args)`. Args are
/// borrowed `&str`s, internally promoted to NUL-terminated `CString`s and
/// then a `*const c_char` array terminated by a NULL sentinel (libmpv reads
/// past the array bounds otherwise). Returns the mpv error code as a
/// human-readable string on failure.
unsafe fn run_mpv_command(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    args: &[&str],
) -> Result<(), String> {
    let cstrings: Vec<CString> = args
        .iter()
        .map(|s| CString::new(*s))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("argument contained NUL: {e}"))?;
    let mut ptrs: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(ptr::null());
    let r = (lib.command)(handle, ptrs.as_mut_ptr());
    if r < 0 {
        Err(err_str(lib, r))
    } else {
        Ok(())
    }
}

/// `mpv_set_property("pause", MPV_FORMAT_FLAG, &flag)`. Separate helper
/// because the FLAG-format `data` argument is an `int *` not the C-string
/// form `set_property_string` accepts.
unsafe fn set_pause(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    paused: bool,
) -> Result<(), String> {
    let mut v: c_int = if paused { 1 } else { 0 };
    let r = (lib.set_property)(
        handle,
        b"pause\0".as_ptr() as *const c_char,
        mpv_format::FLAG,
        &mut v as *mut _ as *mut c_void,
    );
    if r < 0 {
        Err(err_str(lib, r))
    } else {
        Ok(())
    }
}

/// `mpv_set_property("volume", MPV_FORMAT_DOUBLE, &v)`. mpv's `volume`
/// property is a `double` in the [0, 100] (or higher) range — 100 is
/// unity gain. Callers should clamp upstream if a hard ceiling is wanted.
unsafe fn set_volume(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    volume: f64,
) -> Result<(), String> {
    let mut v: f64 = volume;
    let r = (lib.set_property)(
        handle,
        b"volume\0".as_ptr() as *const c_char,
        mpv_format::DOUBLE,
        &mut v as *mut _ as *mut c_void,
    );
    if r < 0 {
        Err(err_str(lib, r))
    } else {
        Ok(())
    }
}

/// Generic `mpv_set_property` for the long-tail of property writes
/// outside the hot path. Picks the FFI format based on the [`PropValue`]
/// variant. STRING uses `set_property_string` which takes the value as a
/// NUL-terminated `*const c_char` directly rather than via the
/// `*mut c_void` route (the value isn't mutated either way; the
/// dedicated string entry-point sidesteps the double-pointer convention
/// the FFI version uses for STRING format).
unsafe fn set_property_generic(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    name: &str,
    value: &PropValue,
) -> Result<(), String> {
    let name_c = CString::new(name)
        .map_err(|e| format!("property name contains NUL: {e}"))?;
    let r = match value {
        PropValue::Flag(b) => {
            let mut v: c_int = if *b { 1 } else { 0 };
            (lib.set_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::FLAG,
                &mut v as *mut _ as *mut c_void,
            )
        }
        PropValue::Int64(i) => {
            let mut v: i64 = *i;
            (lib.set_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::INT64,
                &mut v as *mut _ as *mut c_void,
            )
        }
        PropValue::Double(d) => {
            let mut v: f64 = *d;
            (lib.set_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::DOUBLE,
                &mut v as *mut _ as *mut c_void,
            )
        }
        PropValue::String(s) => {
            let v_c = CString::new(s.as_str())
                .map_err(|e| format!("property value contains NUL: {e}"))?;
            (lib.set_property_string)(handle, name_c.as_ptr(), v_c.as_ptr())
        }
    };
    if r < 0 {
        Err(err_str(lib, r))
    } else {
        Ok(())
    }
}

/// Generic `mpv_get_property` for the long-tail of property reads. The
/// return shape mirrors the format choice — `Bool` for FLAG, `Number`
/// for INT64/DOUBLE, `String` for STRING. mpv allocates STRING results
/// on its heap via `mpv_alloc`; the FFI takes ownership and frees via
/// `mpv_free` once the value is copied into a Rust `String`.
unsafe fn get_property_generic(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    name: &str,
    format: GetFormat,
) -> Result<serde_json::Value, String> {
    let name_c = CString::new(name)
        .map_err(|e| format!("property name contains NUL: {e}"))?;
    match format {
        GetFormat::Flag => {
            let mut v: c_int = 0;
            let r = (lib.get_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::FLAG,
                &mut v as *mut _ as *mut c_void,
            );
            if r < 0 {
                Err(err_str(lib, r))
            } else {
                Ok(serde_json::Value::Bool(v != 0))
            }
        }
        GetFormat::Int64 => {
            let mut v: i64 = 0;
            let r = (lib.get_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::INT64,
                &mut v as *mut _ as *mut c_void,
            );
            if r < 0 {
                Err(err_str(lib, r))
            } else {
                Ok(serde_json::Value::Number(serde_json::Number::from(v)))
            }
        }
        GetFormat::Double => {
            let mut v: f64 = 0.0;
            let r = (lib.get_property)(
                handle,
                name_c.as_ptr(),
                mpv_format::DOUBLE,
                &mut v as *mut _ as *mut c_void,
            );
            if r < 0 {
                Err(err_str(lib, r))
            } else {
                Ok(serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null))
            }
        }
        GetFormat::String => {
            // `mpv_get_property_string` returns a `char*` mpv heap-owns;
            // the caller must `mpv_free` once the string has been
            // copied into Rust storage. Going through the typed FFI
            // here lets us reuse the existing `get_property_string` /
            // `free` pair without juggling the *mut*mut c_char dance.
            let p = (lib.get_property_string)(handle, name_c.as_ptr());
            if p.is_null() {
                Err(format!("get_property_string('{}') returned NULL", name))
            } else {
                let owned = cstr(p);
                (lib.free)(p as *mut c_void);
                Ok(serde_json::Value::String(owned))
            }
        }
    }
}

/// Render an observed `mpv_event_property` payload as a serde JSON value
/// suitable for the `mpv-event-main` Tauri event the bridge in lib.rs
/// consumes. Returns `Null` when the property couldn't be retrieved (mpv
/// signals this with `format == NONE` or `data == NULL`); the bridge
/// already has a guard that drops null updates so the property's
/// last-known value isn't clobbered.
unsafe fn property_value_to_json(prop: &mpv_event_property) -> serde_json::Value {
    if prop.data.is_null() {
        return serde_json::Value::Null;
    }
    let fmt = prop.format.0;
    if fmt == mpv_format::FLAG.0 {
        let v = *(prop.data as *const c_int);
        serde_json::Value::Bool(v != 0)
    } else if fmt == mpv_format::INT64.0 {
        let v = *(prop.data as *const i64);
        serde_json::Value::Number(serde_json::Number::from(v))
    } else if fmt == mpv_format::DOUBLE.0 {
        let v = *(prop.data as *const f64);
        serde_json::Number::from_f64(v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null)
    } else if fmt == mpv_format::STRING.0 {
        // For STRING format `data` points to a `*const c_char` — read the
        // outer pointer first, then the C string itself.
        let ptr = *(prop.data as *const *const c_char);
        if ptr.is_null() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(cstr(ptr))
        }
    } else {
        serde_json::Value::Null
    }
}

/// Map an `mpv_end_file_reason` enum value to the string the legacy
/// `tauri-plugin-libmpv` plugin emitted. The lib.rs observer bridge
/// already accepts either a string OR the raw int, but matching the
/// legacy string form keeps the bridge's fast path active and the
/// devlog messages identical between engines.
fn end_file_reason_to_str(reason: c_int) -> &'static str {
    match reason {
        0 => "eof",
        2 => "stop",
        3 => "quit",
        4 => "error",
        5 => "redirect",
        _ => "unknown",
    }
}

/// Drain queued mpv events without blocking. Three handlings:
///
/// * `LOG_MESSAGE` → DevConsole.
/// * `PROPERTY_CHANGE` → emit `{name, data}` so the lib.rs observer
///   bridge translates it into `playback-update`.
/// * `END_FILE` → emit `{name: "end-file", data: {reason, error}}` so the
///   bridge fires `playback-end`.
/// * `SHUTDOWN` → logged, drain stops.
///
/// Other events (start-file / file-loaded / seek / playback-restart, …)
/// aren't consumed by the bridge today, so they're discarded silently —
/// Phase 4 can extend this when a setter or observer needs them.
unsafe fn drain_mpv_events(lib: &Libmpv, handle: *mut mpv_handle, emit: &EngineEmit) {
    loop {
        let ev = (lib.wait_event)(handle, 0.0);
        if ev.is_null() {
            break;
        }
        let id = (*ev).event_id;
        if id == mpv_event_id::NONE {
            break;
        }
        if id == mpv_event_id::LOG_MESSAGE {
            let m = (*ev).data as *const mpv_event_log_message;
            if !m.is_null() {
                crate::devlog!(
                    debug, "mpv",
                    "mpv/{} {}",
                    cstr((*m).prefix).trim(),
                    cstr((*m).text).trim_end(),
                );
            }
        } else if id == mpv_event_id::PROPERTY_CHANGE {
            let p = (*ev).data as *const mpv_event_property;
            if !p.is_null() && !(*p).name.is_null() {
                let name = cstr((*p).name);
                let data = property_value_to_json(&*p);
                // Devlog the two drop counters separately — the lib.rs
                // observer bridge doesn't consume them and silent-
                // discards them from the `mpv-event-main` channel.
                // Distinguishing VO drops (frame-drop-count) from
                // decoder drops (decoder-frame-drop-count) tells us
                // WHERE in the pipeline the loss happens:
                //   * VO drops without decoder drops → presentation
                //     timing issue (DWM throttling, swap-interval
                //     mismatch, render-loop pacing drift).
                //   * Decoder drops → CPU starvation / process power
                //     throttling. Win11 EcoQoS is the canonical cause
                //     post-2021; pin_process_scheduling now opts out.
                //   * Both → both. mpv usually drops at the decoder
                //     first when CPU-bound.
                // Only logs on change (mpv fires PROPERTY_CHANGE on
                // transitions), so no spam.
                // Debug level: during a sustained drop storm these fire
                // on every increment — at info they flooded the ring
                // buffer + stderr + the Tauri event channel (an overhead
                // amplifier exactly when the system is already behind).
                // The debug panel's drop test reads the counters via
                // get_property instead.
                if name == "frame-drop-count" {
                    crate::devlog!(
                        debug, "mpv",
                        "frame-drop-count → {data} (VO)",
                    );
                } else if name == "decoder-frame-drop-count" {
                    crate::devlog!(
                        debug, "mpv",
                        "decoder-frame-drop-count → {data} (decoder)",
                    );
                }
                emit(&name, data);
            }
        } else if id == mpv_event_id::END_FILE {
            let e = (*ev).data as *const mpv_event_end_file;
            if !e.is_null() {
                let mut payload = serde_json::Map::new();
                payload.insert(
                    "reason".into(),
                    serde_json::Value::String(
                        end_file_reason_to_str((*e).reason.0).to_string(),
                    ),
                );
                payload.insert(
                    "error".into(),
                    serde_json::Value::Number(serde_json::Number::from((*e).error as i64)),
                );
                emit("end-file", serde_json::Value::Object(payload));
            }
        } else if id == mpv_event_id::SHUTDOWN {
            crate::devlog!(warn, "mpv", "mpv emitted SHUTDOWN");
            break;
        }
    }
}

/// Three-state visibility classification of the parent window, retained
/// from the render-engine era as **telemetry only** — under `--wid`
/// embedding mpv owns presentation, so nothing here changes playback
/// behaviour. The engine publishes the current mode to [`CURRENT_MODE`]
/// (read by the Settings → Debug panel) and devlogs transitions, which
/// remains the easiest way to correlate off-focus frame-drop reports
/// with the window state they happened in.
///
/// * [`Foreground`] — the parent IS `GetForegroundWindow()` AND visible.
/// * [`VisibleBackground`] — visible but NOT foreground (Aura on monitor
///   2, or alongside a foreground app).
/// * [`Hidden`] — minimised, DWM-cloaked (different virtual desktop /
///   UWP shell-ghost), or otherwise not visible.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum PresentMode {
    Foreground,
    VisibleBackground,
    Hidden,
}

impl PresentMode {
    /// Numeric discriminant for the [`CURRENT_MODE`] atomic. 255 stands
    /// for "engine not running" so debug callers can distinguish a
    /// genuinely-foreground engine from an idle / shut-down one.
    fn as_u8(self) -> u8 {
        match self {
            PresentMode::Foreground => 0,
            PresentMode::VisibleBackground => 1,
            PresentMode::Hidden => 2,
        }
    }

    /// Reverse of [`as_u8`] — used by [`current_present_mode`] to
    /// translate the atomic back into a Mode.
    fn from_u8(value: u8) -> Option<PresentMode> {
        match value {
            0 => Some(PresentMode::Foreground),
            1 => Some(PresentMode::VisibleBackground),
            2 => Some(PresentMode::Hidden),
            _ => None,
        }
    }

    /// Short string identifier (no parenthetical) for the debug API
    /// JSON. Stable name — frontend can switch on this.
    pub fn name(self) -> &'static str {
        match self {
            PresentMode::Foreground => "foreground",
            PresentMode::VisibleBackground => "visible-background",
            PresentMode::Hidden => "hidden",
        }
    }

    /// Human-readable label for devlog messages.
    fn label(self) -> &'static str {
        match self {
            PresentMode::Foreground => "foreground",
            PresentMode::VisibleBackground => "visible-background",
            PresentMode::Hidden => "hidden",
        }
    }
}

/// Determine the [`PresentMode`] from the parent window's current
/// foreground / visibility state. Order matters: a foreground window IS
/// always visible, so we check that first; only fall through to the
/// non-foreground checks when foreground fails.
unsafe fn detect_present_mode(parent: HWND) -> PresentMode {
    if !is_parent_actually_visible(parent) {
        return PresentMode::Hidden;
    }
    if is_parent_foreground(parent) {
        return PresentMode::Foreground;
    }
    PresentMode::VisibleBackground
}

/// True when the parent IS the OS-level foreground window. Used in
/// combination with [`is_parent_actually_visible`] to derive the
/// three-state [`PresentMode`].
unsafe fn is_parent_foreground(parent: HWND) -> bool {
    let fg = GetForegroundWindow();
    !fg.is_invalid() && fg == parent
}

/// True when our parent window is **actually visible** on screen — not
/// minimised, not DWM-cloaked (a different virtual desktop, or a UWP-
/// style ghost), AND the `WS_VISIBLE` style bit is set.
///
/// This is intentionally NOT the same predicate as
/// `GetForegroundWindow() == parent`. The earlier dual-mode loop used
/// foreground detection and treated *every* not-foreground case as
/// "DWM is throttling us; switch to timer-paced render mode" — but
/// DWM doesn't throttle visible-on-another-monitor windows. A user
/// who has Aura playing a stream on monitor 2 while working on
/// monitor 1 expects full-quality playback; the legacy detection
/// dropped them into timer-paced + framedrop+report_swap mode that
/// was actively dropping ~16% of frames OR (with framedrop=no)
/// accumulating decoded-but-undisplayed frames until refocus, which
/// caused the catch-up burst the user reported.
///
/// Real DWM throttling only applies to:
///   * Minimised windows (`IsIconic`).
///   * DWM-cloaked windows (different virtual desktop, hidden by
///     window-management policy, etc.).
///   * Hidden windows (`!IsWindowVisible`).
///
/// For all of those, swap-chain present is throttled to ~1 Hz or
/// suspended entirely. For the visible-but-not-foreground case, DWM
/// composites normally — vsync-blocked SwapBuffers behaves exactly
/// as it does for the foreground window.
unsafe fn is_parent_actually_visible(parent: HWND) -> bool {
    if !IsWindowVisible(parent).as_bool() {
        return false;
    }
    if IsIconic(parent).as_bool() {
        return false;
    }
    // DWMWA_CLOAKED returns a BOOL/DWORD (0 = not cloaked, nonzero =
    // cloaked for a documented reason: virtual desktop, UWP shell-
    // ghost, etc.). Treat any cloaking as "not visible" so we fall
    // back to the lightweight render path in those cases.
    let mut cloaked: u32 = 0;
    let r = DwmGetWindowAttribute(
        parent,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if r.is_ok() && cloaked != 0 {
        return false;
    }
    true
}

/// Compute the host child's target geometry from its parent's client
/// rect: full client width, full client height minus the title-bar inset
/// (which is 0 in fullscreen, [`TITLE_BAR_H`] windowed). On failure or a
/// degenerate rect, falls back to a small visible default so the engine
/// can still come up and the per-tick resync can correct on the next
/// iteration once the parent settles.
///
/// NOTE: the render-engine era subtracted a 1px "FSO break" from the
/// fullscreen height so the WGL surface never exactly covered the
/// monitor (Win11 DWM promotes output-sized swapchains to Independent
/// Flip / MPO, which dropped the WebView2 overlay out of composition).
/// That inset is GONE here on purpose: mpv's own DXGI swapchain opts out
/// of the promotion (`SetFullscreenState(FALSE)`), which is why the
/// original legacy `--wid` child never had the problem — and this host
/// window carries no swapchain of its own, only mpv's child does.
unsafe fn parent_client_inset(parent: HWND) -> (i32, i32, i32, i32) {
    let in_fs = crate::win32::is_in_native_fullscreen();
    let y_off = if in_fs { 0 } else { TITLE_BAR_H };
    let mut rc = RECT::default();
    if GetClientRect(parent, &mut rc).is_ok()
        && rc.right > rc.left
        && rc.bottom > rc.top
    {
        let w = rc.right - rc.left;
        let h = (rc.bottom - rc.top - y_off).max(1);
        return (0, y_off, w, h);
    }
    (0, y_off, FALLBACK_W, FALLBACK_H)
}

/// Engine-thread body. Sets everything up, runs the pump loop until
/// `Shutdown` is received (or the window is closed externally), then
/// tears down mpv synchronously (mute → stop → terminate_destroy — the
/// WASAPI-release discipline, CLAUDE.md landmine #9).
fn run_engine(rx: Receiver<EngineCommand>, parent_hwnd: isize, emit: EngineEmit) {
    crate::devlog!(info, "mpv", "engine thread started");

    unsafe {
        // -- Win32 host child window under the Tauri main HWND --
        // mpv's `--wid` child parents into this host, which lives as a
        // WS_CHILD of the Tauri main window — exactly where the legacy
        // plugin's mpv child sat. Z-order is pushed to HWND_BOTTOM right
        // after creation so the transparent WebView2 stays on top and
        // continues to receive all input. WS_CLIPCHILDREN keeps the
        // host's black background brush from painting over mpv's child
        // during WM_ERASEBKGND.
        let parent = HWND(parent_hwnd as *mut c_void);
        if !IsWindow(Some(parent)).as_bool() {
            crate::devlog!(
                error, "mpv",
                "parent HWND {parent_hwnd:#x} is not a valid window",
            );
            return;
        }

        let hmodule = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => h,
            Err(e) => {
                crate::devlog!(error, "mpv", "GetModuleHandleW failed: {e}");
                return;
            }
        };
        let hinstance = HINSTANCE(hmodule.0);

        // Background brush filled with black. DefWindowProc uses this for
        // WM_ERASEBKGND, so any GDI fill that happens in a resize gap
        // before mpv's child repaints shows black — matching mpv's
        // letterbox / idle colour, perceptually invisible against video
        // content.
        //
        // The brush is leaked for process lifetime — one allocation per
        // process, matches the once-per-process RegisterClassW semantics.
        let black_brush = CreateSolidBrush(COLORREF(0));
        let wc = WNDCLASSW {
            lpfnWndProc: Some(engine_wndproc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
            hbrBackground: black_brush,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            let e = GetLastError();
            if e != ERROR_CLASS_ALREADY_EXISTS {
                crate::devlog!(error, "mpv", "RegisterClassW failed: {e:?}");
                return;
            }
        }

        let (init_x, init_y, init_w, init_h) = parent_client_inset(parent);
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            WINDOW_NAME,
            WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
            init_x,
            init_y,
            init_w,
            init_h,
            Some(parent),
            None,
            Some(hinstance),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                crate::devlog!(error, "mpv", "CreateWindowExW failed: {e}");
                return;
            }
        };
        // Push to the bottom of the child z-order immediately so the
        // (transparent) WebView2 sits above the engine and continues to
        // receive keyboard / mouse messages. SWP_NOMOVE | SWP_NOSIZE keep
        // the geometry we just set.
        if let Err(e) = SetWindowPos(
            hwnd,
            Some(HWND_BOTTOM),
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        ) {
            crate::devlog!(warn, "mpv", "SetWindowPos(HWND_BOTTOM) failed: {e}");
        }
        crate::devlog!(
            info, "mpv",
            "engine host window created at ({init_x},{init_y}) {init_w}x{init_h}",
        );

        // -- mpv handle, embedded via wid --
        let lib = match Libmpv::load() {
            Ok(l) => l,
            Err(e) => {
                crate::devlog!(error, "mpv", "Libmpv::load failed: {e}");
                let _ = DestroyWindow(hwnd);
                return;
            }
        };
        crate::devlog!(
            info, "mpv",
            "libmpv-2.dll loaded — client API version {:#x}",
            (lib.client_api_version)(),
        );

        let handle = (lib.create)();
        if handle.is_null() {
            crate::devlog!(error, "mpv", "mpv_create returned NULL");
            let _ = DestroyWindow(hwnd);
            return;
        }

        // `wid` BEFORE mpv_initialize — pre-init writes go through mpv's
        // option path, and `wid` is init-only. mpv creates its own child
        // window inside the host, sized to the host's client area, and
        // owns the d3d11 swapchain + presentation from there on.
        {
            let mut wid: i64 = hwnd.0 as i64;
            let r = (lib.set_property)(
                handle,
                b"wid\0".as_ptr() as *const c_char,
                mpv_format::INT64,
                &mut wid as *mut _ as *mut c_void,
            );
            if r < 0 {
                crate::devlog!(
                    error, "mpv",
                    "set wid={wid:#x} failed: {} — no video surface; aborting engine",
                    err_str(&lib, r),
                );
                (lib.terminate_destroy)(handle);
                let _ = DestroyWindow(hwnd);
                return;
            }
        }

        // `vo=gpu-next` — the libplacebo-based renderer the legacy path
        // always used, and the whole point of the consolidation: under a
        // real window (vs `vo=libmpv`) it drives the d3d11 GPU context,
        // which honours `target-colorspace-hint` for true HDR/DV
        // passthrough and opts its swapchain out of Win11's
        // Independent-Flip promotion.
        (lib.set_property_string)(
            handle,
            b"vo\0".as_ptr() as *const c_char,
            b"gpu-next\0".as_ptr() as *const c_char,
        );

        // -- Initial playback options --
        // The full `player::init_mpv` option set the legacy plugin path
        // used, carried over verbatim now that this engine IS the `--wid`
        // path. Without `hwdec=auto` mpv defaults to software decode,
        // which means 4K HEVC 10-bit playback bottlenecks the CPU and
        // produces a steady VO drop pattern even in focused/visible
        // mode. With hwdec=auto, NVDEC / D3D11VA / DXVA take over and
        // the GPU handles the decode. The cache tuning matches the
        // legacy path's "no 1-second stall on stream start" behaviour
        // (cache-pause-initial=no, big demuxer-max-bytes, etc.) and
        // the libavformat reconnect flags keep playback alive through
        // transient HTTP errors from debrid hosts.
        //
        // Each value is a literal C string set BEFORE mpv_initialize
        // so the option goes through mpv's "option" path rather than
        // the runtime property path — same approach the legacy
        // `MpvConfig.initial_options` plumbing used internally.
        // Failures are devlog'd at `warn` but never fatal: mpv may
        // reject an unknown option on a future libmpv version without
        // breaking the rest of init.
        const INIT_OPTS: &[(&[u8], &[u8])] = &[
            // GPU decode — the actual fix for the focused 4K HEVC drops.
            (b"hwdec\0", b"auto\0"),
            (b"keepaspect\0", b"yes\0"),
            (b"background\0", b"none\0"),
            // 50% initial volume — comfortable headphone-safe default;
            // matches the PlaybackState bridge's assumed initial value
            // (mpv's own default of 100 is too loud for first play).
            (b"volume\0", b"50\0"),
            // Subtitle styling baseline — `apply_subtitle_style`
            // re-asserts the user's persisted values on every
            // load_video; these are just sane first-paint defaults.
            (b"sub-pos\0", b"95\0"),
            (b"sub-font-size\0", b"45\0"),
            (b"sub-border-size\0", b"3\0"),
            (b"sub-shadow-offset\0", b"2\0"),
            (b"sub-color\0", b"#FFFFFFFF\0"),
            // Keep the last frame around at EOF so EOS Spotlight /
            // Replay can scrub backwards without reloading.
            (b"keep-open\0", b"yes\0"),
            (b"keep-open-pause\0", b"yes\0"),
            // Streaming cache — 1.5 GiB forward / 256 MiB back; start
            // playback immediately rather than waiting for the cache
            // to pre-fill; re-buffer when the queue falls below 4 s.
            (b"cache\0", b"yes\0"),
            (b"cache-pause-initial\0", b"no\0"),
            (b"cache-secs\0", b"180\0"),
            (b"demuxer-readahead-secs\0", b"120\0"),
            (b"demuxer-max-bytes\0", b"1610612736\0"),
            (b"demuxer-max-back-bytes\0", b"268435456\0"),
            (b"cache-pause-wait\0", b"4.0\0"),
            (b"cache-pause\0", b"yes\0"),
            (b"network-timeout\0", b"60\0"),
            // libavformat HTTP resilience — reconnect on EOF / network
            // errors with capped backoff. Without these, debrid hosts
            // that close idle keep-alives mid-episode surface as a
            // hard "End of file" stop.
            (
                b"demuxer-lavf-o\0",
                b"reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=4\0",
            ),
        ];
        for (name, value) in INIT_OPTS {
            let r = (lib.set_property_string)(
                handle,
                name.as_ptr() as *const c_char,
                value.as_ptr() as *const c_char,
            );
            if r < 0 {
                crate::devlog!(
                    warn, "mpv",
                    "init option {} = {} failed: {}",
                    String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]),
                    String::from_utf8_lossy(&value[..value.len().saturating_sub(1)]),
                    err_str(&lib, r),
                );
            }
        }

        // -- Audio passthrough (settings-gated, default OFF) --
        // CRITICAL: never enable by default — `audio-exclusive=yes` puts
        // WASAPI into exclusive mode (locks the output device system-wide
        // until Aura exits cleanly; a crash leaves it locked until
        // reboot), and `audio-spdif` implies the same exclusivity. Only
        // users who explicitly opted in via Settings get bitstream
        // passthrough. Mirrors the legacy `player::init_mpv` block.
        let snap = crate::settings::snapshot();
        if snap.audio_passthrough {
            let r = (lib.set_property_string)(
                handle,
                b"audio-exclusive\0".as_ptr() as *const c_char,
                b"yes\0".as_ptr() as *const c_char,
            );
            if r < 0 {
                crate::devlog!(warn, "mpv", "audio-exclusive=yes failed: {}", err_str(&lib, r));
            }
            let r = (lib.set_property_string)(
                handle,
                b"audio-spdif\0".as_ptr() as *const c_char,
                b"ac3,dts,dts-hd,eac3,truehd\0".as_ptr() as *const c_char,
            );
            if r < 0 {
                crate::devlog!(warn, "mpv", "audio-spdif failed: {}", err_str(&lib, r));
            }
            crate::devlog!(info, "mpv", "audio passthrough enabled (user setting)");
        }

        // -- Loudness normalization at init (settings-gated) --
        // Install the @loudnorm filter into the initial `af` option so it
        // is part of the audio chain from the very first frame of the
        // very first loadfile. The old flow (frontend re-adding it via
        // `af add` ~1.5 s after each load) raced slow stream opens: the
        // filter landed in the af property but the already-built audio
        // chain didn't always pick it up until a seek forced a rebuild —
        // the "volume is wrong until I seek once" symptom. Skipped under
        // audio passthrough (bitstream bypasses the filter graph; the UI
        // enforces the same exclusivity).
        if snap.loudness_normalization && !snap.audio_passthrough {
            let r = (lib.set_property_string)(
                handle,
                b"af\0".as_ptr() as *const c_char,
                b"@loudnorm:loudnorm=I=-23:LRA=7:TP=-2\0".as_ptr() as *const c_char,
            );
            if r < 0 {
                crate::devlog!(warn, "mpv", "init af=@loudnorm failed: {}", err_str(&lib, r));
            } else {
                crate::devlog!(info, "mpv", "loudness normalization installed at init");
            }
        }

        // -- Diagnostic log file --
        // mpv writes its own verbose log to %USERPROFILE%\aura-mpv.log
        // (rotated to .old past 50 MB by the helper). The last few lines
        // usually pinpoint a STATUS_ACCESS_VIOLATION — the render-engine
        // era lost this surface (it only had request_log_messages →
        // DevConsole); restored here for crash forensics parity with the
        // legacy path. See CLAUDE.md "Conventions".
        if let Some(log_path) = crate::player::mpv_log_file_path() {
            if let Ok(path_c) = CString::new(log_path.clone()) {
                let r = (lib.set_property_string)(
                    handle,
                    b"log-file\0".as_ptr() as *const c_char,
                    path_c.as_ptr(),
                );
                if r < 0 {
                    crate::devlog!(warn, "mpv", "log-file failed: {}", err_str(&lib, r));
                } else {
                    crate::devlog!(info, "mpv", "mpv log: {log_path}");
                }
            }
            let _ = (lib.set_property_string)(
                handle,
                b"msg-level\0".as_ptr() as *const c_char,
                b"all=v\0".as_ptr() as *const c_char,
            );
        }

        // -- HDR mode at init --
        // Apply the user's persisted HDR mode (target-colorspace-hint /
        // tone-mapping / target-prim/trc/peak / hdr-compute-peak) at
        // instance creation so the first frame already honours the
        // setting; the Settings toggle keeps routing live changes through
        // `apply_hdr_settings` → `submit_set_property`.
        //
        // Under `--wid` + `vo=gpu-next` + the d3d11 GPU context,
        // "passthrough" (`target-colorspace-hint=yes`) is REAL HDR
        // passthrough — the d3d11 context honours the hint and flips the
        // swapchain colour space. This is what the render-API engine
        // could never do (`vo=libmpv` ignores the hint; its WGL surface
        // was 8-bit SDR) and the reason the DXGI-interop design
        // (2026-06-03 spec) is superseded by this consolidation.
        {
            let mode = crate::player::resolve_hdr_mode(&snap);
            let mut hdr_opts: indexmap::IndexMap<String, serde_json::Value> =
                indexmap::IndexMap::new();
            crate::player::apply_hdr_options(&mut hdr_opts, mode, snap.hdr_target_peak_nits);
            for (name, value) in hdr_opts.iter() {
                let value_str = match value {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => {
                        if *b { "yes".to_string() } else { "no".to_string() }
                    }
                    // apply_hdr_options only ever emits scalars; skip anything
                    // else rather than send a wrong-format value.
                    _ => continue,
                };
                if let (Ok(name_c), Ok(value_c)) =
                    (CString::new(name.as_str()), CString::new(value_str.as_str()))
                {
                    let r = (lib.set_property_string)(handle, name_c.as_ptr(), value_c.as_ptr());
                    if r < 0 {
                        crate::devlog!(
                            warn, "mpv",
                            "HDR init option {name} = {value_str} failed: {}",
                            err_str(&lib, r),
                        );
                    }
                }
            }
            crate::devlog!(info, "mpv", "HDR mode '{mode}' applied at engine init");
        }

        let ir = (lib.initialize)(handle);
        if ir < 0 {
            crate::devlog!(
                error, "mpv",
                "mpv_initialize failed: {}", err_str(&lib, ir),
            );
            (lib.terminate_destroy)(handle);
            let _ = DestroyWindow(hwnd);
            return;
        }
        (lib.request_log_messages)(handle, b"info\0".as_ptr() as *const c_char);

        // -- Observe properties (Phase 3) --
        // Trimmed working set per CLAUDE.md landmine #4: pause / time-pos
        // / duration / volume / speed were the only properties safe to
        // observe through the legacy wrapper's event channel. Direct FFI
        // MAY relax this — the wrapper was the fragile part, not libmpv
        // itself — but we start with that exact set so the existing
        // observer bridge in lib.rs (which folds these five into
        // `playback-update`) keeps working unchanged. `frame-drop-count`
        // is added on top as INT64 telemetry for the off-focus-drop
        // verification deferred from Phase 2.4 — it isn't consumed by the
        // bridge today, but emitting it lets us log/inspect drop deltas
        // around focus transitions.
        for (name, fmt) in [
            (b"pause\0".as_slice(), mpv_format::FLAG),
            (b"time-pos\0".as_slice(), mpv_format::DOUBLE),
            (b"duration\0".as_slice(), mpv_format::DOUBLE),
            (b"volume\0".as_slice(), mpv_format::DOUBLE),
            (b"speed\0".as_slice(), mpv_format::DOUBLE),
            // `frame-drop-count` — VO-level drops (the renderer
            // decided a decoded frame couldn't be shown in time).
            (b"frame-drop-count\0".as_slice(), mpv_format::INT64),
            // `decoder-frame-drop-count` — drops at the decoder layer
            // (decoder fell behind audio clock and skipped a frame
            // before it ever reached the renderer). Distinguishing the
            // two is critical for diagnosing off-focus drops: VO drops
            // mean a presentation timing issue; decoder drops mean the
            // CPU is being throttled / starved.
            (b"decoder-frame-drop-count\0".as_slice(), mpv_format::INT64),
        ] {
            let r = (lib.observe_property)(handle, 0, name.as_ptr() as *const c_char, fmt);
            if r < 0 {
                crate::devlog!(
                    warn, "mpv",
                    "observe_property('{}') failed: {}",
                    String::from_utf8_lossy(&name[..name.len() - 1]),
                    err_str(&lib, r),
                );
            }
        }

        // -- Visibility telemetry --
        // PresentMode is observation-only under --wid (mpv owns its own
        // presentation); see the enum doc. Published for the debug panel
        // and devlog'd on transitions.
        let mut mode = detect_present_mode(parent);
        CURRENT_MODE.store(mode.as_u8(), Ordering::Release);
        crate::devlog!(
            info, "mpv",
            "engine ready — parent visibility: {}",
            mode.label(),
        );

        // -- Pump loop --
        // mpv renders and presents entirely on its own threads under
        // `--wid`; this loop only:
        //   1. services the host window's message queue,
        //   2. drains the engine command channel,
        //   3. drains mpv's event queue into the Tauri bridge,
        //   4. tracks the parent's client rect / fullscreen state and
        //      resizes the host (plus mpv's inner child) on change,
        //   5. publishes visibility telemetry + display-sleep inhibit.
        let mut shutting_down = false;
        let mut last_geom = (init_x, init_y, init_w, init_h);
        // Tracks the last display-sleep-inhibit state we asserted, so we
        // only call SetThreadExecutionState on an actual transition (not
        // every frame). Starts false = not inhibited.
        let mut display_awake_applied = false;
        loop {
            let tick_start = Instant::now();

            // Keep the monitor awake while the frontend says playback is
            // active + unpaused. Applied here (the render thread) because
            // SetThreadExecutionState's ES_CONTINUOUS state is per-thread —
            // see crate::win32::set_display_sleep_inhibited. Transition-only.
            let want_awake = DISPLAY_AWAKE_DESIRED.load(Ordering::Acquire);
            if want_awake != display_awake_applied {
                crate::win32::set_display_sleep_inhibited(want_awake);
                display_awake_applied = want_awake;
                crate::devlog!(
                    debug, "mpv",
                    "display sleep inhibit → {want_awake}",
                );
            }

            // Pump win32 messages.
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !IsWindow(Some(hwnd)).as_bool() {
                crate::devlog!(warn, "mpv", "engine window closed externally — ending");
                break;
            }
            if !IsWindow(Some(parent)).as_bool() {
                crate::devlog!(
                    warn, "mpv",
                    "parent window destroyed — engine ending",
                );
                break;
            }
            // Drain every queued command this tick so a burst (e.g. a
            // volume slider drag) doesn't accumulate one-per-frame latency.
            // Shutdown wins immediately — anything after it would race the
            // teardown sequence.
            loop {
                match rx.try_recv() {
                    Ok(EngineCommand::Shutdown) | Err(TryRecvError::Disconnected) => {
                        shutting_down = true;
                        break;
                    }
                    Ok(EngineCommand::LoadFile { url, start_seconds }) => {
                        // Pre-loadfile pause clear: an inherited pause flag
                        // from a previous file would carry over otherwise
                        // and require a manual click to start playback.
                        if let Err(e) = set_pause(&lib, handle, false) {
                            crate::devlog!(
                                warn, "mpv",
                                "set_pause(false) pre-loadfile failed: {e}",
                            );
                        }
                        let start_opt = start_seconds
                            .filter(|v| v.is_finite() && *v > 0.0)
                            .map(|t| format!("start={:.3}", t.min(86_400.0 * 7.0)));
                        let mut args_v: Vec<&str> = vec!["loadfile", &url, "replace"];
                        if let Some(s) = start_opt.as_deref() {
                            // Positional 3 ("0") is the file-index — required
                            // when supplying a 4th-positional options string.
                            args_v.push("0");
                            args_v.push(s);
                        }
                        match run_mpv_command(&lib, handle, &args_v) {
                            Ok(()) => crate::devlog!(
                                info, "mpv",
                                "loadfile accepted: {url}{}",
                                start_opt.as_deref().map(|s| format!(" {s}")).unwrap_or_default(),
                            ),
                            Err(e) => crate::devlog!(
                                warn, "mpv", "loadfile failed: {e}",
                            ),
                        }
                        // Belt-and-suspenders: some libmpv builds reset the
                        // pause flag during demuxer init, so clear again.
                        if let Err(e) = set_pause(&lib, handle, false) {
                            crate::devlog!(
                                warn, "mpv",
                                "set_pause(false) post-loadfile failed: {e}",
                            );
                        }
                    }
                    Ok(EngineCommand::TogglePause) => {
                        if let Err(e) = run_mpv_command(&lib, handle, &["cycle", "pause"]) {
                            crate::devlog!(warn, "mpv", "cycle pause failed: {e}");
                        }
                    }
                    Ok(EngineCommand::SetVolume(v)) => {
                        if let Err(e) = set_volume(&lib, handle, v) {
                            crate::devlog!(warn, "mpv", "set volume failed: {e}");
                        }
                    }
                    Ok(EngineCommand::Command(args)) => {
                        let borrowed: Vec<&str> =
                            args.iter().map(String::as_str).collect();
                        if let Err(e) = run_mpv_command(&lib, handle, &borrowed) {
                            crate::devlog!(
                                warn, "mpv",
                                "command {:?} failed: {e}", borrowed,
                            );
                        }
                    }
                    Ok(EngineCommand::SetProperty { name, value }) => {
                        if let Err(e) =
                            set_property_generic(&lib, handle, &name, &value)
                        {
                            crate::devlog!(
                                warn, "mpv",
                                "set_property('{name}') failed: {e}",
                            );
                        }
                    }
                    Ok(EngineCommand::GetProperty { name, format, reply }) => {
                        let result =
                            get_property_generic(&lib, handle, &name, format);
                        // Drop the reply Result if the caller has gone
                        // away — the channel close is the natural signal
                        // and we don't want to leak a warning for it.
                        let _ = reply.send(result);
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            if shutting_down {
                break;
            }

            // Visibility-transition telemetry. Foreground →
            // VisibleBackground happens on alt-tab to another monitor;
            // VisibleBackground → Hidden on minimise / virtual-desktop
            // switch; etc. Nothing is applied to mpv — this exists so
            // off-focus playback reports can be correlated with the
            // window state in DevConsole.
            let now_mode = detect_present_mode(parent);
            if now_mode != mode {
                mode = now_mode;
                CURRENT_MODE.store(mode.as_u8(), Ordering::Release);
                crate::devlog!(
                    info, "mpv",
                    "parent visibility → {}",
                    mode.label(),
                );
            }

            // Geometry resync — poll the PARENT's client rect + fullscreen
            // state every tick; on change, SetWindowPos the host to match
            // (same-thread → our wndproc runs inline, cheap and
            // deadlock-free) and then snap mpv's inner child to the host's
            // new client area. mpv's `--wid` child does NOT track its
            // parent's size on this build (the documented reason
            // `win32::resize_mpv_child_to_parent` exists), so the inner
            // resize is required; it's a no-op while no video is loaded
            // (mpv hasn't created the child yet — when it does, it sizes
            // to the host's CURRENT client area, which this loop keeps
            // correct, so first-frame geometry is right by construction).
            //
            // `SWP_NOCOPYBITS | SWP_DEFERERASE` suppresses GDI's bitblt
            // copy + WM_ERASEBKGND fill — both produce visible artifacts
            // when mpv is about to repaint the surface anyway.
            let in_fs = crate::win32::is_in_native_fullscreen();
            let y_off = if in_fs { 0 } else { TITLE_BAR_H };
            let mut parent_rc = RECT::default();
            let (target_w, target_h) = if GetClientRect(parent, &mut parent_rc).is_ok()
                && parent_rc.right > parent_rc.left
                && parent_rc.bottom > parent_rc.top
            {
                let pw = parent_rc.right - parent_rc.left;
                let ph = (parent_rc.bottom - parent_rc.top - y_off).max(1);
                (pw, ph)
            } else {
                (last_geom.2, last_geom.3)
            };
            let target_geom = (0, y_off, target_w, target_h);
            if target_geom != last_geom {
                if let Err(e) = SetWindowPos(
                    hwnd,
                    None,
                    target_geom.0,
                    target_geom.1,
                    target_geom.2,
                    target_geom.3,
                    SWP_NOZORDER
                        | SWP_NOACTIVATE
                        | SWP_NOCOPYBITS
                        | SWP_DEFERERASE,
                ) {
                    crate::devlog!(warn, "mpv", "host SetWindowPos failed: {e}");
                }
                last_geom = target_geom;
                // Inner child fills the host exactly (y_offset 0 — the
                // title-bar inset is already the host's own position).
                crate::win32::resize_mpv_child_to_parent(hwnd.0 as isize, 0);
            }

            drain_mpv_events(&lib, handle, &emit);

            // Steady pump cadence — see TICK.
            let elapsed = tick_start.elapsed();
            if elapsed < TICK {
                thread::sleep(TICK - elapsed);
            }
        }

        // -- Teardown --
        // WASAPI-release discipline (CLAUDE.md landmine #9), formerly
        // `window_logic::shutdown_mpv_sync` on the legacy plugin: mute
        // first so in-flight audio buffers don't squeak through the
        // device-close path, `stop` to unlink the demuxer and release the
        // AO, then `mpv_terminate_destroy` — all synchronous on this
        // thread, and the CloseRequested handler joins this thread before
        // `app.exit()`, so the audio device is guaranteed back with the
        // OS mixer before the process dies.
        let _ = set_property_generic(&lib, handle, "mute", &PropValue::Flag(true));
        let _ = run_mpv_command(&lib, handle, &["stop"]);
        (lib.terminate_destroy)(handle);
        let _ = DestroyWindow(hwnd);

        // Reset the published mode so debug callers see "not running"
        // after teardown.
        CURRENT_MODE.store(255, Ordering::Release);
        crate::devlog!(info, "mpv", "engine torn down cleanly");
    }
}
