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
//! Opt-in via the `AURA_MPV2_ENGINE` environment variable, independent from
//! `AURA_MPV2_HELLO`. A normal launch (neither set) is unaffected.
//!
//! Windows-only — gated at the `mod` declaration in [`super`].

use std::ffi::{c_char, c_int, c_void, CStr};
use std::mem::size_of;
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, Sender, TryRecvError},
    Arc, Mutex, OnceLock,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use windows::core::{w, PCSTR, PCWSTR};
use windows::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT,
    RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};
use windows::Win32::Graphics::OpenGL::{
    glClear, glClearColor, glGetString, glViewport, wglCreateContext, wglDeleteContext,
    wglGetProcAddress, wglMakeCurrent, ChoosePixelFormat, SetPixelFormat, SwapBuffers,
    GL_COLOR_BUFFER_BIT, GL_RENDERER, GL_VERSION, HGLRC, PFD_DOUBLEBUFFER,
    PFD_DRAW_TO_WINDOW, PFD_SUPPORT_OPENGL, PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR,
};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
    IsWindow, MsgWaitForMultipleObjects, PeekMessageW, RegisterClassW, SetWindowPos,
    TranslateMessage, CS_OWNDC, HWND_BOTTOM, MSG, PM_REMOVE, QS_ALLINPUT,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WINDOW_EX_STYLE, WNDCLASSW, WS_CHILD,
    WS_VISIBLE,
};

use super::ffi::{
    mpv_event_id, mpv_event_log_message, mpv_handle, mpv_opengl_fbo,
    mpv_opengl_init_params, mpv_render_context, mpv_render_param, mpv_render_param_type,
    mpv_render_update_flag, Libmpv, MPV_RENDER_API_TYPE_OPENGL,
};

// ===========================================================================
// Public API
// ===========================================================================

/// A request submitted to the engine's render thread. Phase 2.1 only carries
/// `Shutdown`; Phase 2.4 will extend this with `LoadFile`, property setters
/// etc. as the wrapper's call sites get migrated.
enum EngineCommand {
    Shutdown,
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

/// Spawn the engine — but only if the `AURA_MPV2_ENGINE` environment
/// variable is set. A no-op otherwise. Idempotent: a second call while the
/// engine is already running returns without doing anything.
///
/// `parent_hwnd` is the Tauri main window's HWND, passed as `isize` so it
/// can cross the thread boundary (`HWND` itself is not `Send`). The render
/// thread re-wraps it. Passing 0 disables the engine even when the env var
/// is set — used as a defensive fall-through when the main window's HWND
/// can't be resolved at setup time.
pub fn start_if_requested(parent_hwnd: isize) {
    if std::env::var_os("AURA_MPV2_ENGINE").is_none() {
        return;
    }
    if parent_hwnd == 0 {
        crate::devlog!(
            warn, "mpv2",
            "AURA_MPV2_ENGINE set but parent HWND is 0 — engine not spawned",
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
        "AURA_MPV2_ENGINE set — spawning long-lived render engine (parent HWND {parent_hwnd:#x})",
    );

    let (tx, rx) = mpsc::channel::<EngineCommand>();
    let join = match thread::Builder::new()
        .name("aura-mpv2-engine".into())
        .spawn(move || run_engine(rx, parent_hwnd))
    {
        Ok(j) => j,
        Err(e) => {
            crate::devlog!(error, "mpv2", "failed to spawn engine thread: {e}");
            return;
        }
    };

    *slot = Some(EngineHandle { tx, join: Some(join) });
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

/// Trivial wndproc — the engine window does no input handling and paints
/// only via OpenGL, so every message goes to the default handler.
unsafe extern "system" fn engine_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
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

/// Drain queued mpv events without blocking. Forwards LOG_MESSAGE to the
/// DevConsole and returns once the queue is empty or a SHUTDOWN is seen.
/// The full event channel goes to Phase 3 — this minimal drain keeps mpv's
/// own diagnostics reaching the user.
unsafe fn drain_mpv_events(lib: &Libmpv, handle: *mut mpv_handle) {
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
        } else if id == mpv_event_id::SHUTDOWN {
            crate::devlog!(warn, "mpv2", "mpv emitted SHUTDOWN");
            break;
        }
    }
}

/// Compute the engine child's target geometry from its parent's client
/// rect: full client width, full client height minus the title-bar inset
/// (which is 0 in fullscreen, [`TITLE_BAR_H`] windowed). On failure or a
/// degenerate rect, falls back to a small visible default so the engine
/// can still come up and the per-frame resync can correct on the next
/// iteration once the parent settles.
unsafe fn parent_client_inset(parent: HWND) -> (i32, i32, i32, i32) {
    let y_off = if crate::win32::is_in_native_fullscreen() {
        0
    } else {
        TITLE_BAR_H
    };
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

/// Render-thread body. Sets everything up, runs until `Shutdown` is
/// received (or the window is closed externally), then tears down.
fn run_engine(rx: Receiver<EngineCommand>, parent_hwnd: isize) {
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

        let wc = WNDCLASSW {
            style: CS_OWNDC,
            lpfnWndProc: Some(engine_wndproc),
            hInstance: hinstance,
            lpszClassName: CLASS_NAME,
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

        // -- Render loop --
        // ~60 Hz steady cadence; Phase 2.3 introduces the focused/unfocused
        // dual-mode loop. No file is loaded yet (Phase 2.4 wires `loadfile`),
        // so in practice the update callback never fires and the loop just
        // paints teal until shutdown.
        let mut frame_count: u64 = 0;
        let mut shutting_down = false;
        let last_geom = (init_x, init_y, init_w, init_h);
        loop {
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
            match rx.try_recv() {
                Ok(EngineCommand::Shutdown) | Err(TryRecvError::Disconnected) => {
                    shutting_down = true;
                }
                Err(TryRecvError::Empty) => {}
            }
            if shutting_down {
                break;
            }

            // Resize sync is intentionally NOT done from this thread.
            // `win32::resize_mpv_child_to_parent` (driven by Tauri's
            // Focused / Resized window events on the main thread) already
            // enumerates non-WebView2 children and resizes them; the
            // engine's class name passes that filter so our window tracks
            // the parent client area automatically. Doing SetWindowPos
            // here from a worker thread carries a cross-thread Win32
            // hazard: SetWindowPos on a child can route notifications
            // through the parent's owning thread, and if the parent
            // thread is ever blocked (e.g. waiting on this engine to
            // join during shutdown) the call deadlocks. Reading the
            // size for the GL viewport is fine — that's pure local
            // state read on our own HWND.
            let mut rc = RECT::default();
            let (cw, ch) = if GetClientRect(hwnd, &mut rc).is_ok()
                && rc.right > rc.left
                && rc.bottom > rc.top
            {
                (rc.right - rc.left, rc.bottom - rc.top)
            } else {
                (last_geom.2, last_geom.3)
            };

            // Visible "engine alive" baseline — a steady teal clear regardless
            // of whether mpv produced a frame this tick.
            glViewport(0, 0, cw, ch);
            glClearColor(0.04, 0.45, 0.50, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);

            drain_mpv_events(&lib, handle);

            let asked = needs_render.swap(false, Ordering::AcqRel);
            let flags = (lib.render_context_update)(rctx);
            let frame_ready = asked || (flags & mpv_render_update_flag::FRAME) != 0;

            let mut rendered_mpv = false;
            if frame_ready {
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
                    rendered_mpv = true;
                    frame_count = frame_count.saturating_add(1);
                    if frame_count == 1 {
                        crate::devlog!(
                            info, "mpv2",
                            "first mpv frame rendered by engine",
                        );
                    }
                }
            }

            let _ = SwapBuffers(hdc);
            if rendered_mpv {
                // report_swap is the channel mpv uses to learn vsync cadence —
                // only call it when we actually drove an mpv frame, otherwise
                // we'd be reporting "a frame was displayed" for a frame mpv
                // didn't produce.
                (lib.render_context_report_swap)(rctx);
            }

            thread::sleep(Duration::from_millis(16));
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
