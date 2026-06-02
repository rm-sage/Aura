// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv2::engine` — Phase-2.1 long-lived render-context engine.
//!
//! Promotes the verified hello-world setup ([`super::hello`]) into a
//! persistent owner: a dedicated render thread that holds the Win32 window,
//! the WGL context, the mpv handle and the render context for the lifetime
//! of the app, and a small command channel so other threads can signal it.
//!
//! Phase 2.1 deliberately stops short of:
//!   * **parenting the GL window under the Tauri main HWND** (Phase 2.2 — for
//!     now the window is still top-level so the engine is visible above
//!     Aura's opaque shell, exactly like the hello-world);
//!   * the **dual-mode focused/unfocused present loop** (Phase 2.3 — for now
//!     the loop sleeps ~16 ms between frames, identical cadence to the
//!     hello-world);
//!   * any **playback commands** (Phase 2.4 — for now [`EngineCommand`]
//!     carries only `Shutdown`).
//!
//! Its job is to prove the steady-state plumbing: a long-running render
//! thread, the update-callback wiring, a real command channel, and a clean
//! teardown from the Tauri close handler. With no file loaded the engine
//! paints a steady teal clear forever — the "is the engine alive?" indicator
//! — and exits via [`shutdown_if_running`] when the user closes Aura.
//!
//! Drives playback by DEFAULT now. Set `AURA_MPV2=0` (or `false`/`off`/`no`)
//! to fall back to the legacy `--wid` `tauri-plugin-libmpv` path — the
//! escape hatch kept until Phase 7 removes that dependency. Independent
//! from `AURA_MPV2_HELLO` (the Phase-1 verification scaffolding).
//!
//! Windows-only — gated at the `mod` declaration in [`super`].

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::mem::size_of;
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    mpsc::{self, Receiver, Sender, TryRecvError},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::{w, PCSTR, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT,
    RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, EndPaint, GetDC, ReleaseDC, HDC, PAINTSTRUCT,
};
use windows::Win32::Foundation::COLORREF;
use windows::Win32::Graphics::OpenGL::{
    glGetString, glViewport, wglCreateContext, wglDeleteContext, wglGetProcAddress,
    wglMakeCurrent, ChoosePixelFormat, SetPixelFormat, SwapBuffers, GL_RENDERER,
    GL_VERSION, HGLRC, PFD_DOUBLEBUFFER, PFD_DRAW_TO_WINDOW, PFD_SUPPORT_OPENGL,
    PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
    GetForegroundWindow, IsIconic, IsWindow, IsWindowVisible,
    MsgWaitForMultipleObjects, PeekMessageW, RegisterClassW, SetWindowPos,
    TranslateMessage, CS_OWNDC, HWND_BOTTOM, MSG, PM_REMOVE, QS_ALLINPUT,
    SWP_DEFERERASE, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, WINDOW_EX_STYLE, WM_PAINT, WNDCLASSW, WS_CHILD, WS_VISIBLE,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

use super::ffi::{
    mpv_event_end_file, mpv_event_id, mpv_event_log_message, mpv_event_property,
    mpv_format, mpv_handle, mpv_opengl_fbo, mpv_opengl_init_params, mpv_render_context,
    mpv_render_param, mpv_render_param_type, Libmpv, MPV_RENDER_API_TYPE_OPENGL,
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
///   long tail — every other `app.mpv().command(...)` / `set_property(...)`
///   / `get_property(...)` site in lib.rs routes through these.
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
/// [`start_if_requested`] / [`shutdown_if_running`] can be called from
/// arbitrary call sites without threading a Tauri-managed state through.
static ENGINE: OnceLock<Mutex<Option<EngineHandle>>> = OnceLock::new();

fn engine_slot() -> &'static Mutex<Option<EngineHandle>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Master env-var gate for the mpv2 path. The engine is the DEFAULT
/// playback path now: [`start_if_requested`] spawns it AND the Tauri
/// command handlers route playback through it
/// ([`submit_load_file`] / [`submit_toggle_pause`] / [`submit_set_volume`])
/// unless this variable is explicitly set to an off value, which restores
/// the legacy `--wid` engine. Single switch by design so partial runs
/// (engine without command routing or vice versa) can't accidentally
/// happen.
pub const ENV_VAR: &str = "AURA_MPV2";

/// Whether the mpv2 engine should drive playback this process.
///
/// DEFAULT ON. The engine is disabled only when [`ENV_VAR`] is explicitly
/// set to an off value — `0`, `false`, `off`, or `no` (case-insensitive,
/// trimmed). Unset, empty, or any other value → ON. `$env:AURA_MPV2=0`
/// (or `=off`) is the documented escape hatch back to the legacy `--wid`
/// path, kept until Phase 7 deletes the legacy plugin.
pub fn enabled() -> bool {
    match std::env::var(ENV_VAR) {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no",
        ),
        Err(_) => true,
    }
}

/// Whether the engine thread is currently running. Tauri command handlers
/// gate on this to decide between the mpv2 path and the legacy path.
pub fn is_running() -> bool {
    engine_slot()
        .lock()
        .map(|s| s.is_some())
        .unwrap_or(false)
}

/// Spawn the engine (the default path) — a no-op only when [`ENV_VAR`] is
/// set to an off value. Idempotent: a second call while the engine is
/// already running returns without doing anything.
///
/// `parent_hwnd` is the Tauri main window's HWND, passed as `isize` so it
/// can cross the thread boundary (`HWND` itself is not `Send`). The render
/// thread re-wraps it. Passing 0 disables the engine even when the env var
/// is set — used as a defensive fall-through when the main window's HWND
/// can't be resolved at setup time. `emit` is the channel the render
/// thread uses to push mpv events (property changes, end-of-file, …) back
/// to the frontend through Tauri.
pub fn start_if_requested(parent_hwnd: isize, emit: EngineEmit) {
    if !enabled() {
        return;
    }
    if parent_hwnd == 0 {
        crate::devlog!(
            warn, "mpv2",
            "engine enabled but parent HWND is 0 — engine not spawned (legacy --wid init kept as fallback)",
        );
        return;
    }
    let mut slot = match engine_slot().lock() {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(error, "mpv2", "engine slot poisoned on start: {e}");
            return;
        }
    };
    if slot.is_some() {
        return;
    }
    crate::devlog!(
        info, "mpv2",
        "spawning long-lived render engine — default path (parent HWND {parent_hwnd:#x})",
    );

    let (tx, rx) = mpsc::channel::<EngineCommand>();
    let join = match thread::Builder::new()
        .name("aura-mpv2-engine".into())
        .spawn(move || run_engine(rx, parent_hwnd, emit))
    {
        Ok(j) => j,
        Err(e) => {
            crate::devlog!(error, "mpv2", "failed to spawn engine thread: {e}");
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
/// render thread exits before the process does (matches the WASAPI-clean
/// shutdown discipline `shutdown_mpv_sync` follows for the legacy mpv
/// instance — see `window_logic.rs`).
pub fn shutdown_if_running() {
    let mut slot = match engine_slot().lock() {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(error, "mpv2", "engine slot poisoned on shutdown: {e}");
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
    crate::devlog!(info, "mpv2", "engine shut down");
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
                warn, "mpv2",
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
                warn, "mpv2",
                "engine join timed out — detaching thread",
            );
            std::mem::forget(j);
            return;
        }
        if res == WAIT_FAILED {
            crate::devlog!(
                error, "mpv2",
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
        crate::devlog!(error, "mpv2", "engine thread join panicked: {e:?}");
    }
}

// ===========================================================================
// Render-thread internals
// ===========================================================================

const CLASS_NAME: PCWSTR = w!("AuraMpv2EngineWindow");
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

/// Unfocused-mode present cadence — 60 fps nominal (16.667 ms). The exact
/// rate isn't load-bearing — what matters is that the spacing is regular
/// and that `mpv_render_context_report_swap` is called at this cadence so
/// mpv's display-resample doesn't think the swap chain stalled while DWM
/// is throttling our non-foreground composition. `pin_process_scheduling`
/// holds `timeBeginPeriod(1)` for the process lifetime, so `thread::sleep`
/// granularity here is ~1 ms — close enough.
const UNFOCUSED_FRAME: Duration = Duration::from_micros(16_667);

/// `BOOL wglSwapIntervalEXT(int interval)` — WGL_EXT_swap_control. 0 turns
/// vsync off (`SwapBuffers` returns immediately); 1 waits for the next
/// vblank before returning. Resolved at runtime via `wglGetProcAddress`;
/// the call is the standard handle for toggling between vsync-blocked and
/// timer-paced present modes.
type WglSwapIntervalExtFn = unsafe extern "system" fn(interval: c_int) -> i32;

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

/// Engine wndproc. Only `WM_PAINT` is special-cased; everything else
/// (including `WM_SIZE`, `WM_ERASEBKGND`, `WM_WINDOWPOSCHANGED`) goes to
/// the default handler. The render thread polls the parent's client rect
/// every tick and `SetWindowPos`-es itself when the parent has moved,
/// driving its own resize — the wndproc doesn't need a fast-path because
/// the render thread is already the source of geometry change.
///
/// * `WM_PAINT` → BeginPaint / EndPaint with no GDI work, return 0. The
///   actual painting is the render thread's continuous SwapBuffers; this
///   only validates the paint rect so Windows doesn't immediately re-fire
///   WM_PAINT.
///
/// Phase 2.2 ran an inline `glClear` + `SwapBuffers` from `WM_SIZE` to
/// close the latency window during drag-resize, but the glClear's teal
/// fill WAS the visible cyan flicker — every cross-thread `SetWindowPos`
/// caused a one-frame teal flash before the next render tick painted the
/// real frame. Removed in Phase 5 in favour of engine-driven resize +
/// black class brush; stale content for ≤16 ms is preferable to a teal
/// blink.
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

/// Two-tier `get_proc_address` for `mpv_opengl_init_params`: try
/// `wglGetProcAddress` first (extensions + modern core), fall back to
/// `GetProcAddress` on `opengl32.dll` for GL 1.1 core. Same logic as
/// [`super::hello::aura_get_proc_address`]; duplicated rather than factored
/// to keep the Phase-1 hello-world artifact untouched.
unsafe extern "C" fn aura_get_proc_address(
    ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if name.is_null() {
        return ptr::null_mut();
    }
    let pcstr = PCSTR(name as *const u8);

    if let Some(f) = wglGetProcAddress(pcstr) {
        let addr = f as usize as isize;
        if !matches!(addr, 0 | 1 | 2 | 3 | -1) {
            return f as usize as *mut c_void;
        }
    }

    let opengl32 = HMODULE(ctx);
    if !opengl32.is_invalid() {
        if let Some(f) = GetProcAddress(opengl32, pcstr) {
            return f as usize as *mut c_void;
        }
    }

    ptr::null_mut()
}

/// mpv's update callback. Invoked from arbitrary threads when a new video
/// frame is ready. `cb_ctx` is the `*const AtomicBool` we handed mpv via
/// [`Arc::into_raw`] — flip it, the render thread will pick it up.
///
/// The callback contract forbids re-entering mpv from here, so we only
/// touch the atomic.
unsafe extern "C" fn on_mpv_update(cb_ctx: *mut c_void) {
    let flag = cb_ctx as *const AtomicBool;
    if !flag.is_null() {
        (*flag).store(true, Ordering::Release);
    }
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
                    debug, "mpv2",
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
                if name == "frame-drop-count" {
                    crate::devlog!(
                        info, "mpv2",
                        "frame-drop-count → {data} (VO)",
                    );
                } else if name == "decoder-frame-drop-count" {
                    crate::devlog!(
                        info, "mpv2",
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
            crate::devlog!(warn, "mpv2", "mpv emitted SHUTDOWN");
            break;
        }
    }
}

/// Resolve `wglSwapIntervalEXT` via `wglGetProcAddress`. Returns `None` if
/// the driver doesn't advertise the extension (rare on Windows; every
/// major GPU vendor exports it) — in that case the dual-mode loop falls
/// back to pure timer pacing in both branches. Must be called with a GL
/// context current on the calling thread, since `wglGetProcAddress` reads
/// from the current context's ICD.
unsafe fn resolve_swap_interval() -> Option<WglSwapIntervalExtFn> {
    let name = PCSTR(b"wglSwapIntervalEXT\0".as_ptr());
    let f = wglGetProcAddress(name)?;
    let addr = f as usize as isize;
    if matches!(addr, 0 | 1 | 2 | 3 | -1) {
        return None;
    }
    // Both source and target are `unsafe extern "system" fn` pointers,
    // identical size and ABI on Windows — transmuting between function
    // signatures of the same calling convention is the standard pattern
    // for typed extension loaders.
    Some(std::mem::transmute::<_, WglSwapIntervalExtFn>(f))
}

/// Apply mpv's `framedrop` property. It's now uniformly `vo` (mpv's own
/// default — drop late frames at the renderer) regardless of mode; see
/// [`PresentMode::framedrop`]. This still runs on each mode transition so
/// the property is re-asserted, but it no longer varies by focus.
///
/// History: an earlier design used `framedrop=no` while backgrounded to
/// "present every frame", but that made mpv hoard late frames during
/// DWM's background-present throttle and then dump the backlog as a
/// catch-up drop burst the instant focus returned — the off-focus
/// regression. `vo` (steady dropping, matching what legacy `--wid` did)
/// is the fix.
///
/// Errors are devlog'd at `warn` and otherwise ignored — `framedrop`
/// is a runtime hint, not a correctness requirement.
unsafe fn apply_framedrop_policy(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    mode: PresentMode,
) {
    let value = mode.framedrop();
    let r = (lib.set_property_string)(
        handle,
        b"framedrop\0".as_ptr() as *const c_char,
        value.as_ptr() as *const c_char,
    );
    let value_label = std::str::from_utf8(&value[..value.len().saturating_sub(1)])
        .unwrap_or("?");
    if r < 0 {
        crate::devlog!(
            warn, "mpv2",
            "set framedrop={value_label} failed: {}",
            err_str(lib, r),
        );
    } else {
        crate::devlog!(
            debug, "mpv2",
            "framedrop = {value_label} (mode={})",
            mode.label(),
        );
    }
}

/// Three-state present mode the render thread switches between based on
/// the parent window's foreground / visibility state. Each state picks a
/// distinct (swap-interval, report_swap, framedrop) policy so playback
/// quality matches the user's actual viewing scenario.
///
/// * [`Foreground`] — the parent IS `GetForegroundWindow()` AND visible.
///   Full-quality mode: `wglSwapIntervalEXT(1)` (vsync-blocked), every
///   present reports the swap to mpv, and `framedrop=vo` drops frames
///   that would arrive late (mpv's default behaviour for tight a/v sync).
///
/// * [`VisibleBackground`] — visible but NOT foreground (Aura on monitor
///   2, or alongside a foreground app). Now treated IDENTICALLY to
///   [`Foreground`]: vsync (`swap-interval=1`) + `report_swap` +
///   `framedrop=vo`. DWM throttles a background window's present, but
///   that's fine — vsync-blocked SwapBuffers keeps `report_swap` honest
///   (mpv learns the real, throttled cadence) and `framedrop=vo` drops
///   late frames steadily to track it, the same as the legacy `--wid`
///   path. (The earlier `framedrop=no` here hoarded late frames and
///   dumped a catch-up burst on refocus — the off-focus regression.)
///   Kept as a distinct variant from Foreground only for diagnostic
///   logging.
///
/// * [`Hidden`] — minimised, DWM-cloaked (different virtual desktop /
///   UWP shell-ghost), or otherwise not visible. The user can't see
///   playback. Non-blocking present path so the engine stays responsive
///   to commands / shutdown while the window is suspended:
///   `swap-interval=0` (SwapBuffers can't block on a suspended present) +
///   a 60 Hz render timer + no `report_swap` (no real flip to anchor to).
///   `framedrop=vo` like every other mode, so it drops steadily rather
///   than hoarding a backlog that would burst on un-minimise.
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
            PresentMode::Foreground => "foreground (full quality)",
            PresentMode::VisibleBackground => "visible-background (no-drop)",
            PresentMode::Hidden => "hidden (background)",
        }
    }
    /// `wglSwapIntervalEXT` value for this mode. `1` vsync-locks the
    /// next SwapBuffers to vblank; `0` returns immediately.
    fn swap_interval(self) -> c_int {
        match self {
            PresentMode::Foreground | PresentMode::VisibleBackground => 1,
            PresentMode::Hidden => 0,
        }
    }
    /// Whether `mpv_render_context_report_swap` should fire after each
    /// SwapBuffers. We lie to mpv about timing in Hidden mode because
    /// the swap there isn't vsync-anchored to anything mpv can use.
    fn report_swap(self) -> bool {
        match self {
            PresentMode::Foreground | PresentMode::VisibleBackground => true,
            PresentMode::Hidden => false,
        }
    }
    /// mpv `framedrop` property value — now uniformly `vo` (mpv's own
    /// default: drop late frames at the renderer). The old per-mode `no`
    /// for background states WAS the off-focus-burst regression: while DWM
    /// throttles a background window's present, `framedrop=no` made mpv
    /// HOARD the late frames instead of dropping them, then dump the whole
    /// backlog as a catch-up drop burst the instant focus returned. `vo`
    /// drops steadily instead (no backlog → no burst) — exactly what the
    /// legacy `--wid` path did. Kept as a method (call sites + logging
    /// stay put); the value just no longer varies by mode.
    fn framedrop(self) -> &'static [u8] {
        b"vo\0"
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

/// FSO ("Fullscreen Optimization") geometry-break inset, in device
/// pixels. Subtracted from the engine child's height when the parent is
/// in native fullscreen so the GL surface does NOT exactly cover the
/// monitor.
///
/// Win11's DWM auto-promotes any swapchain-backed window that covers a
/// full output to Independent Flip / Multi-Plane Overlay mode (the same
/// promotion exclusive-fullscreen games get). When that fires the
/// engine's WGL surface drops out of DWM composition, which produces
/// FOUR simultaneous symptoms:
///   1. WebView2 (transparent overlay above the GL child in z-order)
///      stops compositing over the surface → the React UI vanishes.
///   2. The display pipeline bypasses DWM's ICM colour management →
///      colours look "vivid" / over-saturated (raw gamma, no profile).
///   3. DWM re-sorts every other output's compositor as part of the
///      transition → secondary monitors flash black for a beat.
///   4. The acquire path is a real mode transition → ~2-3 seconds of
///      latency between toggling fullscreen and a stable picture.
///
/// VERIFIED FIX (hardware test): shrinking the engine surface 1px shorter
/// than the monitor stops the promotion outright — DWM can't hand a
/// non-output-sized window a full-screen overlay plane, so it must
/// composite. Confirmed the OTHER way round does NOT work: putting opaque
/// content ABOVE a full-size engine (a 1px WebView2 marker) failed,
/// because the RTX 4090 supports multi-plane overlays and simply put the
/// engine on its own plane regardless. The disqualifier MUST be the
/// engine surface's own geometry, not occlusion from above. The 1px gap
/// is covered by a black strip in the React layer (App.tsx) so it reads
/// as a thin letterbox line rather than desktop bleed-through.
///
/// Pre-mpv2 (legacy `--wid` mpv child) didn't have this problem because
/// libmpv's own DirectX swapchain explicitly opts out via DXGI flags
/// (`SetFullscreenState(FALSE)`). WGL has no equivalent API — we go
/// through the NVIDIA ICD's hidden DXGI swap chain with no opt-out. The
/// canonical workaround (RPCS3, PCSX2, many borderless-fullscreen game
/// launchers) is exactly this 1px geometric break.
const FSO_HEIGHT_INSET: i32 = 1;

/// Compute the engine child's target geometry from its parent's client
/// rect: full client width, full client height minus the title-bar inset
/// (which is 0 in fullscreen, [`TITLE_BAR_H`] windowed) minus the FSO
/// break inset ([`FSO_HEIGHT_INSET`] in fullscreen, 0 windowed — see the
/// constant's comment for the full rationale). On failure or a degenerate
/// rect, falls back to a small visible default so the engine can still
/// come up and the per-frame resync can correct on the next iteration
/// once the parent settles.
unsafe fn parent_client_inset(parent: HWND) -> (i32, i32, i32, i32) {
    let in_fs = crate::win32::is_in_native_fullscreen();
    let y_off = if in_fs { 0 } else { TITLE_BAR_H };
    let bottom_inset = if in_fs { FSO_HEIGHT_INSET } else { 0 };
    let mut rc = RECT::default();
    if GetClientRect(parent, &mut rc).is_ok()
        && rc.right > rc.left
        && rc.bottom > rc.top
    {
        let w = rc.right - rc.left;
        let h = (rc.bottom - rc.top - y_off - bottom_inset).max(1);
        return (0, y_off, w, h);
    }
    (0, y_off, FALLBACK_W, FALLBACK_H)
}

/// Render-thread body. Sets everything up, runs until `Shutdown` is
/// received (or the window is closed externally), then tears down.
fn run_engine(rx: Receiver<EngineCommand>, parent_hwnd: isize, emit: EngineEmit) {
    crate::devlog!(info, "mpv2", "engine thread started");

    unsafe {
        // -- Win32 child window under the Tauri main HWND --
        // Phase 2.2: the engine's GL surface lives as a WS_CHILD of the
        // Tauri main window, exactly where the legacy `--wid` mpv child
        // sits today. Z-order is pushed to HWND_BOTTOM right after
        // creation so the transparent WebView2 stays on top and continues
        // to receive all input.
        let parent = HWND(parent_hwnd as *mut c_void);
        if !IsWindow(Some(parent)).as_bool() {
            crate::devlog!(
                error, "mpv2",
                "parent HWND {parent_hwnd:#x} is not a valid window",
            );
            return;
        }

        let hmodule = match GetModuleHandleW(PCWSTR::null()) {
            Ok(h) => h,
            Err(e) => {
                crate::devlog!(error, "mpv2", "GetModuleHandleW failed: {e}");
                return;
            }
        };
        let hinstance = HINSTANCE(hmodule.0);

        // Background brush filled with black. DefWindowProc uses this for
        // WM_ERASEBKGND, so any GDI fill that happens between a resize and
        // the next render-tick SwapBuffers shows black — matching mpv's
        // letterbox / idle colour, perceptually invisible against video
        // content. Phase 2.2 used a teal brush as a "render thread is
        // alive" signal; that bled through as cyan flicker during
        // drag-resize on every cross-thread SetWindowPos because the
        // brush would paint AND the WM_SIZE handler would do an explicit
        // teal glClear. Black brush + WM_SIZE pass-through (see
        // [`engine_wndproc`]) + engine-driven per-frame resize (below) is
        // Phase 5's resolution.
        //
        // The brush is leaked for process lifetime — one allocation per
        // process, matches the once-per-process RegisterClassW semantics.
        let black_brush = CreateSolidBrush(COLORREF(0));
        let wc = WNDCLASSW {
            style: CS_OWNDC,
            lpfnWndProc: Some(engine_wndproc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
            hbrBackground: black_brush,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            let e = GetLastError();
            if e != ERROR_CLASS_ALREADY_EXISTS {
                crate::devlog!(error, "mpv2", "RegisterClassW failed: {e:?}");
                return;
            }
        }

        let (init_x, init_y, init_w, init_h) = parent_client_inset(parent);
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            WINDOW_NAME,
            WS_CHILD | WS_VISIBLE,
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
                crate::devlog!(error, "mpv2", "CreateWindowExW failed: {e}");
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
            crate::devlog!(warn, "mpv2", "SetWindowPos(HWND_BOTTOM) failed: {e}");
        }
        crate::devlog!(
            info, "mpv2",
            "engine child window created at ({init_x},{init_y}) {init_w}x{init_h}",
        );

        // -- WGL pixel format + context --
        let hdc = GetDC(Some(hwnd));
        if hdc.is_invalid() {
            crate::devlog!(error, "mpv2", "GetDC returned an invalid DC");
            let _ = DestroyWindow(hwnd);
            return;
        }

        let pfd = PIXELFORMATDESCRIPTOR {
            nSize: size_of::<PIXELFORMATDESCRIPTOR>() as u16,
            nVersion: 1,
            dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
            iPixelType: PFD_TYPE_RGBA,
            cColorBits: 32,
            cDepthBits: 24,
            cStencilBits: 8,
            ..Default::default()
        };
        let pf = ChoosePixelFormat(hdc, &pfd);
        if pf == 0 {
            crate::devlog!(error, "mpv2", "ChoosePixelFormat found no match");
            ReleaseDC(Some(hwnd), hdc);
            let _ = DestroyWindow(hwnd);
            return;
        }
        if let Err(e) = SetPixelFormat(hdc, pf, &pfd) {
            crate::devlog!(error, "mpv2", "SetPixelFormat failed: {e}");
            ReleaseDC(Some(hwnd), hdc);
            let _ = DestroyWindow(hwnd);
            return;
        }

        let hglrc = match wglCreateContext(hdc) {
            Ok(c) => c,
            Err(e) => {
                crate::devlog!(error, "mpv2", "wglCreateContext failed: {e}");
                ReleaseDC(Some(hwnd), hdc);
                let _ = DestroyWindow(hwnd);
                return;
            }
        };
        if let Err(e) = wglMakeCurrent(hdc, hglrc) {
            crate::devlog!(error, "mpv2", "wglMakeCurrent failed: {e}");
            let _ = wglDeleteContext(hglrc);
            ReleaseDC(Some(hwnd), hdc);
            let _ = DestroyWindow(hwnd);
            return;
        }
        crate::devlog!(
            info, "mpv2",
            "WGL context current — GL_VERSION='{}', GL_RENDERER='{}'",
            cstr(glGetString(GL_VERSION) as *const c_char),
            cstr(glGetString(GL_RENDERER) as *const c_char),
        );

        let opengl32 = GetModuleHandleW(w!("opengl32.dll")).unwrap_or_default();

        // -- mpv handle + render context --
        let lib = match Libmpv::load() {
            Ok(l) => l,
            Err(e) => {
                crate::devlog!(error, "mpv2", "Libmpv::load failed: {e}");
                teardown_wgl(hwnd, hdc, hglrc);
                return;
            }
        };
        crate::devlog!(
            info, "mpv2",
            "libmpv-2.dll loaded — client API version {:#x}",
            (lib.client_api_version)(),
        );

        let handle = (lib.create)();
        if handle.is_null() {
            crate::devlog!(error, "mpv2", "mpv_create returned NULL");
            teardown_wgl(hwnd, hdc, hglrc);
            return;
        }

        (lib.set_property_string)(
            handle,
            b"vo\0".as_ptr() as *const c_char,
            b"libmpv\0".as_ptr() as *const c_char,
        );

        // -- Initial playback options --
        // Mirrors the legacy `player::init_mpv` set for the options that
        // are decode/cache-stage (the render path differs: legacy uses
        // `vo=gpu-next`, mpv2 must use `vo=libmpv` for the render-API
        // contract — that's the only intentional divergence). Without
        // `hwdec=auto` mpv defaults to software decode, which means
        // 4K HEVC 10-bit playback bottlenecks the CPU and produces a
        // steady VO drop pattern even in focused/visible mode. With
        // hwdec=auto, NVDEC / D3D11VA / DXVA take over and the GPU
        // handles the decode. The cache tuning matches the legacy
        // path's "no 1-second stall on stream start" behaviour
        // (cache-pause-initial=no, big demuxer-max-bytes, etc.) and
        // the libavformat reconnect flags keep playback alive through
        // transient HTTP errors from debrid hosts.
        //
        // Each value is a literal C string set BEFORE mpv_initialize
        // so the option goes through mpv's "option" path rather than
        // the runtime property path — same approach the legacy
        // `MpvConfig.initial_options` plumbing uses internally.
        // Failures are devlog'd at `warn` but never fatal: mpv may
        // reject an unknown option on a future libmpv version without
        // breaking the rest of init.
        const INIT_OPTS: &[(&[u8], &[u8])] = &[
            // GPU decode — the actual fix for the focused 4K HEVC drops.
            (b"hwdec\0", b"auto\0"),
            // Render-side defaults that match legacy gpu-next behaviour.
            (b"keepaspect\0", b"yes\0"),
            (b"background\0", b"none\0"),
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
                    warn, "mpv2",
                    "init option {} = {} failed: {}",
                    String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]),
                    String::from_utf8_lossy(&value[..value.len().saturating_sub(1)]),
                    err_str(&lib, r),
                );
            }
        }

        let ir = (lib.initialize)(handle);
        if ir < 0 {
            crate::devlog!(
                error, "mpv2",
                "mpv_initialize failed: {}", err_str(&lib, ir),
            );
            (lib.terminate_destroy)(handle);
            teardown_wgl(hwnd, hdc, hglrc);
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
                    warn, "mpv2",
                    "observe_property('{}') failed: {}",
                    String::from_utf8_lossy(&name[..name.len() - 1]),
                    err_str(&lib, r),
                );
            }
        }

        let mut gl_init = mpv_opengl_init_params {
            get_proc_address: Some(aura_get_proc_address),
            get_proc_address_ctx: opengl32.0,
        };
        let mut params = [
            mpv_render_param {
                r#type: mpv_render_param_type::API_TYPE,
                data: MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
            },
            mpv_render_param {
                r#type: mpv_render_param_type::OPENGL_INIT_PARAMS,
                data: &mut gl_init as *mut _ as *mut c_void,
            },
            mpv_render_param {
                r#type: mpv_render_param_type::INVALID,
                data: ptr::null_mut(),
            },
        ];
        let mut rctx: *mut mpv_render_context = ptr::null_mut();
        let cr = (lib.render_context_create)(&mut rctx, handle, params.as_mut_ptr());
        if cr < 0 || rctx.is_null() {
            crate::devlog!(
                error, "mpv2",
                "mpv_render_context_create failed: {}",
                err_str(&lib, cr),
            );
            (lib.terminate_destroy)(handle);
            teardown_wgl(hwnd, hdc, hglrc);
            return;
        }
        crate::devlog!(
            info, "mpv2",
            "mpv_render_context_create OK — engine render context live",
        );

        // Update-callback context. We hand mpv a stable `*const AtomicBool`
        // by leaking an `Arc::into_raw` clone; the matching `Arc::from_raw`
        // in teardown reclaims it. The Arc is leaked specifically because
        // mpv may invoke the callback from any thread until
        // `render_context_free` returns, so the pointer must outlive every
        // possible callback.
        let needs_render = Arc::new(AtomicBool::new(false));
        let cb_ctx = Arc::into_raw(needs_render.clone()) as *mut c_void;
        (lib.render_context_set_update_callback)(
            rctx, Some(on_mpv_update), cb_ctx,
        );

        // -- Dual-mode present pacing setup --
        // Resolve wglSwapIntervalEXT once. If absent, both branches fall
        // back to pure timer pacing (no vsync wait) — playback still
        // works, just without the extra-smooth focused-mode vblank lock.
        let wgl_swap_interval = resolve_swap_interval();
        if wgl_swap_interval.is_none() {
            crate::devlog!(
                warn, "mpv2",
                "wglSwapIntervalEXT not available — both modes will be timer-paced",
            );
        }
        // Three-state present mode: see `PresentMode` doc for the full
        // rationale. Foreground gets full-quality (vsync + report_swap +
        // framedrop=vo); visible-but-not-foreground gets no-drop
        // (vsync + report_swap + framedrop=no — DWM throttles
        // non-foreground presents and mpv's default framedrop would
        // see the slow swaps as "late frames" and drop them); hidden
        // gets the background path (no vsync, no report_swap, no
        // framedrop).
        let mut mode = detect_present_mode(parent);
        if let Some(set_swap) = wgl_swap_interval {
            let interval = mode.swap_interval();
            let r = set_swap(interval);
            crate::devlog!(
                info, "mpv2",
                "wglSwapIntervalEXT({interval}) → {r} (nonzero = ok)",
            );
        }
        apply_framedrop_policy(&lib, handle, mode);
        CURRENT_MODE.store(mode.as_u8(), Ordering::Release);
        crate::devlog!(
            info, "mpv2",
            "engine starting in {} present mode",
            mode.label(),
        );

        // -- Render loop --
        // Dual-mode pacing per the render-API spec:
        //   * Focused: swap-interval=1, SwapBuffers itself is the clock.
        //   * Unfocused: swap-interval=0 + a fixed timer cadence — DWM
        //     throttles a non-foreground window's compositor, so vsync
        //     would stall us; we drive render+report_swap at a steady
        //     ~60 Hz instead so mpv's display-resample model stays fed.
        // Mode switches are detected by polling GetForegroundWindow each
        // tick (cheap; the win32 transition is what off-focus-drop is
        // really about, so we react inside one frame of the change).
        let mut frame_count: u64 = 0;
        let mut shutting_down = false;
        let mut last_geom = (init_x, init_y, init_w, init_h);
        // Tracks the last display-sleep-inhibit state we asserted, so we
        // only call SetThreadExecutionState on an actual transition (not
        // every frame). Starts false = not inhibited.
        let mut display_awake_applied = false;
        loop {
            let frame_start = Instant::now();

            // Keep the monitor awake while the frontend says playback is
            // active + unpaused. Applied here (the render thread) because
            // SetThreadExecutionState's ES_CONTINUOUS state is per-thread —
            // see crate::win32::set_display_sleep_inhibited. Transition-only.
            let want_awake = DISPLAY_AWAKE_DESIRED.load(Ordering::Acquire);
            if want_awake != display_awake_applied {
                crate::win32::set_display_sleep_inhibited(want_awake);
                display_awake_applied = want_awake;
                crate::devlog!(
                    debug, "mpv2",
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
                crate::devlog!(warn, "mpv2", "engine window closed externally — ending");
                break;
            }
            if !IsWindow(Some(parent)).as_bool() {
                crate::devlog!(
                    warn, "mpv2",
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
                                warn, "mpv2",
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
                                info, "mpv2",
                                "loadfile accepted: {url}{}",
                                start_opt.as_deref().map(|s| format!(" {s}")).unwrap_or_default(),
                            ),
                            Err(e) => crate::devlog!(
                                warn, "mpv2", "loadfile failed: {e}",
                            ),
                        }
                        // Belt-and-suspenders: some libmpv builds reset the
                        // pause flag during demuxer init, so clear again.
                        if let Err(e) = set_pause(&lib, handle, false) {
                            crate::devlog!(
                                warn, "mpv2",
                                "set_pause(false) post-loadfile failed: {e}",
                            );
                        }
                    }
                    Ok(EngineCommand::TogglePause) => {
                        if let Err(e) = run_mpv_command(&lib, handle, &["cycle", "pause"]) {
                            crate::devlog!(warn, "mpv2", "cycle pause failed: {e}");
                        }
                    }
                    Ok(EngineCommand::SetVolume(v)) => {
                        if let Err(e) = set_volume(&lib, handle, v) {
                            crate::devlog!(warn, "mpv2", "set volume failed: {e}");
                        }
                    }
                    Ok(EngineCommand::Command(args)) => {
                        let borrowed: Vec<&str> =
                            args.iter().map(String::as_str).collect();
                        if let Err(e) = run_mpv_command(&lib, handle, &borrowed) {
                            crate::devlog!(
                                warn, "mpv2",
                                "command {:?} failed: {e}", borrowed,
                            );
                        }
                    }
                    Ok(EngineCommand::SetProperty { name, value }) => {
                        if let Err(e) =
                            set_property_generic(&lib, handle, &name, &value)
                        {
                            crate::devlog!(
                                warn, "mpv2",
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

            // Detect mode transitions across all three states.
            // Foreground → VisibleBackground happens on alt-tab to
            // another monitor; VisibleBackground → Hidden happens on
            // minimise / virtual-desktop switch; etc. Each switch
            // re-applies the appropriate swap-interval + framedrop
            // policy so playback is right for the new context.
            let now_mode = detect_present_mode(parent);
            if now_mode != mode {
                mode = now_mode;
                if let Some(set_swap) = wgl_swap_interval {
                    let interval = mode.swap_interval();
                    let r = set_swap(interval);
                    crate::devlog!(
                        debug, "mpv2",
                        "wglSwapIntervalEXT({interval}) → {r}",
                    );
                }
                apply_framedrop_policy(&lib, handle, mode);
                CURRENT_MODE.store(mode.as_u8(), Ordering::Release);
                crate::devlog!(
                    info, "mpv2",
                    "engine present mode → {}",
                    mode.label(),
                );
            }

            // Phase 5 — engine owns its resize. Poll the PARENT's client
            // rect every tick; if our cached geometry differs, SetWindowPos
            // ourselves to match. Same-thread `SetWindowPos` on our own
            // HWND invokes our wndproc inline (no cross-thread message),
            // so this is cheap and deadlock-free.
            //
            // Driving resize from the render thread (vs. the old path of
            // Tauri's onResized → `refresh_video` → `EnumChildWindows` +
            // `SetWindowPos` on the main thread) closes two latencies:
            // the JS round-trip and the cross-thread SendMessage to our
            // wndproc. During a drag-resize the engine reacts within one
            // render tick (~16 ms) instead of however long the JS hop
            // takes, which kills the visible stale-frame gap.
            //
            // `SWP_NOCOPYBITS | SWP_DEFERERASE` suppresses GDI's bitblt
            // copy + WM_ERASEBKGND fill — both produce visible frame
            // artifacts when the next render tick is about to overwrite
            // the surface anyway.
            let in_fs = crate::win32::is_in_native_fullscreen();
            let y_off = if in_fs { 0 } else { TITLE_BAR_H };
            // Match parent_client_inset: shave FSO_HEIGHT_INSET pixels off
            // the bottom in fullscreen so the GL surface is NOT exactly
            // monitor-sized. See the constant's comment — this is the
            // verified disqualifier for Win11's Independent Flip / MPO
            // promotion (occlusion from above does NOT work on multi-plane
            // GPUs). The gap is covered by a black strip in App.tsx.
            let bottom_inset = if in_fs { FSO_HEIGHT_INSET } else { 0 };
            let mut parent_rc = RECT::default();
            let (target_w, target_h) = if GetClientRect(parent, &mut parent_rc).is_ok()
                && parent_rc.right > parent_rc.left
                && parent_rc.bottom > parent_rc.top
            {
                let pw = parent_rc.right - parent_rc.left;
                let ph = (parent_rc.bottom - parent_rc.top - y_off - bottom_inset).max(1);
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
                    crate::devlog!(warn, "mpv2", "self SetWindowPos failed: {e}");
                }
                last_geom = target_geom;
            }
            let (cw, ch) = (target_w, target_h);

            glViewport(0, 0, cw, ch);

            drain_mpv_events(&lib, handle, &emit);

            // Consume the update-callback flag and the render-context's
            // own update bitset for completeness, but DO NOT use them to
            // gate mpv_render_context_render. mpv must be invoked every
            // present so the FBO content tracks the current playback
            // state — when the video frame rate is lower than the swap
            // rate (e.g. 23.976 fps video on a 144 Hz monitor in
            // focused/vsync-blocked mode), mpv internally re-paints the
            // most-recent frame; an `if frame_ready` gate would leave
            // the FBO unrendered on those ticks and SwapBuffers would
            // present whatever was left in the back buffer (an old
            // clear). The user-visible symptom was cyan flashes when the
            // player had focus — fixed by rendering unconditionally.
            let _ = needs_render.swap(false, Ordering::AcqRel);
            let _ = (lib.render_context_update)(rctx);

            let mut fbo = mpv_opengl_fbo {
                fbo: 0,
                w: cw,
                h: ch,
                internal_format: 0,
            };
            let mut flip_y: c_int = 1;
            let mut rparams = [
                mpv_render_param {
                    r#type: mpv_render_param_type::OPENGL_FBO,
                    data: &mut fbo as *mut _ as *mut c_void,
                },
                mpv_render_param {
                    r#type: mpv_render_param_type::FLIP_Y,
                    data: &mut flip_y as *mut _ as *mut c_void,
                },
                mpv_render_param {
                    r#type: mpv_render_param_type::INVALID,
                    data: ptr::null_mut(),
                },
            ];
            let r = (lib.render_context_render)(rctx, rparams.as_mut_ptr());
            if r < 0 {
                crate::devlog!(
                    warn, "mpv2",
                    "render_context_render: {}", err_str(&lib, r),
                );
            } else {
                frame_count = frame_count.saturating_add(1);
                if frame_count == 1 {
                    crate::devlog!(
                        info, "mpv2",
                        "first mpv frame rendered by engine",
                    );
                }
            }

            let _ = SwapBuffers(hdc);
            // Only report_swap when focused. In focused mode
            // SwapBuffers blocks on vblank, so the call sequence
            // models a real flip: mpv learns accurate vsync timing
            // and its display-sync prediction model works correctly.
            //
            // In unfocused mode SwapBuffers returns immediately
            // (swap-interval=0) while DWM throttles the actual
            // composite. Calling report_swap here would tell mpv
            // "vsync at 60 Hz" while the real flip happens whenever
            // DWM decides — that misinformation builds an incorrect
            // prediction model and was the source of the ~16% drop
            // rate observed pre-fix. Suppressing the call lets mpv
            // fall back to its audio-clock-only timing model, which
            // doesn't depend on vsync prediction. Paired with
            // `framedrop=no` (set by apply_framedrop_policy on focus
            // change) the engine plays every decoded frame in
            // unfocused mode rather than dropping ones it incorrectly
            // judges as "late".
            if mode.report_swap() {
                (lib.render_context_report_swap)(rctx);
            }

            // Pacing branch:
            //   * Foreground / VisibleBackground: SwapBuffers is the
            //     clock (swap-interval=1 blocks on vblank — DWM-throttled
            //     in the background case, vsync-locked in the foreground
            //     case, either way we don't need to add our own sleep).
            //   * Hidden: SwapBuffers returns immediately; sleep until
            //     the next steady 60 Hz tick so the loop doesn't spin.
            if matches!(mode, PresentMode::Hidden) {
                let elapsed = frame_start.elapsed();
                if elapsed < UNFOCUSED_FRAME {
                    thread::sleep(UNFOCUSED_FRAME - elapsed);
                }
            }
        }

        // -- Teardown --
        // Order matters: deregister update callback BEFORE freeing the
        // render context so a late callback can't dereference a freed Arc;
        // free the render context BEFORE giving up the GL context; reclaim
        // the leaked Arc BEFORE dropping `lib` (so any in-flight callback
        // is also blocked by the deregistration above).
        (lib.render_context_set_update_callback)(rctx, None, ptr::null_mut());
        (lib.render_context_free)(rctx);
        drop(Arc::from_raw(cb_ctx as *const AtomicBool));
        (lib.terminate_destroy)(handle);
        teardown_wgl(hwnd, hdc, hglrc);

        // Reset the published mode so debug callers see "not running"
        // after teardown.
        CURRENT_MODE.store(255, Ordering::Release);
        crate::devlog!(
            info, "mpv2",
            "engine torn down cleanly ({frame_count} mpv frame(s) rendered)",
        );
    }
}

/// Common WGL/window teardown — runs after mpv is destroyed (or on an early
/// init-failure bail-out where mpv was never created). Idempotent on the
/// "context-not-current" branch, so the early-exit call sites can use it
/// without first un-currenting anything.
unsafe fn teardown_wgl(hwnd: HWND, hdc: HDC, hglrc: HGLRC) {
    let _ = wglMakeCurrent(HDC::default(), HGLRC::default());
    let _ = wglDeleteContext(hglrc);
    ReleaseDC(Some(hwnd), hdc);
    let _ = DestroyWindow(hwnd);
}
