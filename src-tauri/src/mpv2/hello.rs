// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv2::hello` — Phase-1 runtime hello-world for the render-API rewrite.
//!
//! This is the runtime half of Phase 1 (see
//! `docs/superpowers/specs/2026-05-20-render-api-rewrite-design.md`). The
//! bindings half ([`super::ffi`]) is compile-only verifiable; this half is
//! the FIRST piece that can only be confirmed by running on real hardware.
//!
//! What it does, end to end, on its own dedicated thread:
//!
//!   1. Creates a standalone top-level Win32 window. (Phase 2's real
//!      render surface will be a child window in the MPV position; this
//!      Phase-1 smoke test uses a top-level window so the result is
//!      visible above Aura's opaque home screen — a webview child is
//!      occluded by the UI painted into the transparent webview.)
//!   2. Picks a pixel format and creates a legacy WGL OpenGL context on it.
//!   3. `mpv_create` / `mpv_initialize` / `mpv_render_context_create`,
//!      handing mpv a two-tier `get_proc_address` (wgl -> opengl32.dll).
//!   4. Runs a short render loop: a static teal clear (proves the window +
//!      WGL context render), then `mpv_render_context_render` into the
//!      default framebuffer (proves the render context drives mpv).
//!   5. Tears everything down cleanly.
//!
//! It is **opt-in** — [`run_if_requested`] is a no-op unless the
//! `AURA_MPV2_HELLO` environment variable is set. The shipped `--wid`
//! playback path (`player.rs` / `tauri-plugin-libmpv`) is untouched, so a
//! normal launch behaves exactly as before; a developer runs
//! `AURA_MPV2_HELLO=1` to exercise this path and read the result in the
//! DevConsole (`[mpv2]` source) / stderr.
//!
//! Windows-only — gated at the `mod` declaration in [`super`].

use std::ffi::{c_char, c_int, c_void, CStr};
use std::mem::size_of;
use std::ptr;
use std::time::{Duration, Instant};

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
    IsWindow, PeekMessageW, RegisterClassW, TranslateMessage, CS_OWNDC, MSG, PM_REMOVE,
    WNDCLASSW, WS_CAPTION, WS_EX_TOPMOST, WS_SYSMENU, WS_VISIBLE,
};

use super::ffi::{
    mpv_event_id, mpv_event_log_message, mpv_handle, mpv_opengl_fbo,
    mpv_opengl_init_params, mpv_render_context, mpv_render_param, mpv_render_param_type,
    Libmpv, MPV_RENDER_API_TYPE_OPENGL,
};

/// Window-class name for the hello-world window. Registered lazily on the
/// render thread; `RegisterClassW` failing with `ERROR_CLASS_ALREADY_EXISTS`
/// is benign (the class survives a teardown / re-run within one process).
const CLASS_NAME: PCWSTR = w!("AuraMpv2HelloWindow");
const WINDOW_NAME: PCWSTR = w!("Aura render-API Phase 1 test");

/// Top-level window geometry (outer size — the GL surface is the smaller
/// client area below the caption bar, queried each frame via
/// `GetClientRect`).
const WIN_X: i32 = 160;
const WIN_Y: i32 = 120;
const WIN_W: i32 = 720;
const WIN_H: i32 = 460;

/// Total hello-world runtime, then everything is torn down.
const TOTAL: Duration = Duration::from_secs(6);
/// Phase A (teal clear only) runs before this; phase B (teal clear +
/// `mpv_render_context_render`) runs after.
const PHASE_SPLIT: Duration = Duration::from_secs(3);

/// Spawn the Phase-1 render-context hello-world — but only if the
/// `AURA_MPV2_HELLO` environment variable is set. A no-op otherwise, which
/// is every normal launch.
pub fn run_if_requested() {
    if std::env::var_os("AURA_MPV2_HELLO").is_none() {
        return;
    }
    crate::devlog!(
        info, "mpv2",
        "AURA_MPV2_HELLO set — spawning Phase-1 render-context hello-world",
    );
    let spawned = std::thread::Builder::new()
        .name("aura-mpv2-hello".into())
        .spawn(run);
    if let Err(e) = spawned {
        crate::devlog!(error, "mpv2", "failed to spawn hello-world thread: {e}");
    }
}

/// Trivial window procedure — the hello-world window does no input handling
/// and paints exclusively through OpenGL, so every message goes straight to
/// the default handler.
unsafe extern "system" fn hello_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// `get_proc_address` callback handed to mpv via [`mpv_opengl_init_params`].
///
/// mpv calls this (from inside `mpv_render_context_create`, on the thread
/// holding the current GL context) to resolve every GL entry point it
/// needs. The two-tier lookup is mandatory on Windows:
///
///   1. `wglGetProcAddress` — resolves extension and non-1.1-core
///      functions, but returns NULL (or, on some ICDs, the `1/2/3/-1`
///      sentinels) for core GL 1.1 functions.
///   2. `GetProcAddress` on `opengl32.dll` — resolves exactly those core
///      1.1 functions that tier 1 refuses.
///
/// `ctx` carries the cached `opengl32.dll` module handle (see [`run`]).
unsafe extern "C" fn aura_get_proc_address(
    ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if name.is_null() {
        return ptr::null_mut();
    }
    let pcstr = PCSTR(name as *const u8);

    // Tier 1: wglGetProcAddress — extensions + modern core entry points.
    if let Some(f) = wglGetProcAddress(pcstr) {
        let addr = f as usize as isize;
        // Some ICDs hand back 1/2/3/-1 instead of NULL for "not found".
        if !matches!(addr, 0 | 1 | 2 | 3 | -1) {
            return f as usize as *mut c_void;
        }
    }

    // Tier 2: GetProcAddress on opengl32.dll — core GL 1.1 functions that
    // wglGetProcAddress does not return.
    let opengl32 = HMODULE(ctx);
    if !opengl32.is_invalid() {
        if let Some(f) = GetProcAddress(opengl32, pcstr) {
            return f as usize as *mut c_void;
        }
    }

    ptr::null_mut()
}

/// Read a NUL-terminated C string into an owned `String`; `<null>` if the
/// pointer is null.
unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return "<null>".to_string();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

/// Human-readable form of an mpv error code via `mpv_error_string`.
unsafe fn err_str(lib: &Libmpv, code: c_int) -> String {
    format!("{code} ({})", cstr((lib.error_string)(code)))
}

/// Drain every queued mpv event without blocking, forwarding log messages
/// to the DevConsole. Exercises the client event channel — a small early
/// down-payment on Phase 3 — and surfaces mpv's own diagnostics if the
/// render context misbehaves.
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

/// The hello-world body. Runs entirely on the spawned render thread; the
/// GL context, the render context and every `mpv_render_context_*` call
/// stay on this one thread, as the render API requires.
fn run() {
    crate::devlog!(info, "mpv2", "hello-world thread started");

    unsafe {
        // -- Win32 top-level window --
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
            lpfnWndProc: Some(hello_wndproc),
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

        // A standalone top-level window — WS_EX_TOPMOST so it floats above
        // Aura's main window, WS_CAPTION|WS_SYSMENU so it reads as a real
        // titled test window with a close button. Deliberately NOT a
        // webview child: that would be occluded by the opaque home-screen
        // UI (Phase 2's real render surface goes back to a child window).
        let hwnd = match CreateWindowExW(
            WS_EX_TOPMOST,
            CLASS_NAME,
            WINDOW_NAME,
            WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
            WIN_X,
            WIN_Y,
            WIN_W,
            WIN_H,
            None,
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
        crate::devlog!(info, "mpv2", "top-level window created ({WIN_W}x{WIN_H})");

        // -- WGL pixel format + context --
        // CS_OWNDC means this DC is private and stays valid for the
        // window's lifetime, so a single GetDC is enough.
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

        // opengl32.dll is mapped now (WGL pulled it in) — cache its handle
        // for the get_proc_address tier-2 fallback.
        let opengl32 = GetModuleHandleW(w!("opengl32.dll")).unwrap_or_default();

        // -- mpv: create + initialize + render context --
        // A failure at any step is logged and the loop falls back to the
        // teal-only path, so the WGL layer is still verified visually.
        let lib_opt = match Libmpv::load() {
            Ok(l) => Some(l),
            Err(e) => {
                crate::devlog!(error, "mpv2", "Libmpv::load failed: {e}");
                None
            }
        };
        let mut mpv_state: Option<(*mut mpv_render_context, *mut mpv_handle)> = None;

        if let Some(lib) = &lib_opt {
            crate::devlog!(
                info, "mpv2",
                "libmpv-2.dll loaded — client API version {:#x}",
                (lib.client_api_version)(),
            );
            let handle = (lib.create)();
            if handle.is_null() {
                crate::devlog!(error, "mpv2", "mpv_create returned NULL");
            } else {
                // Setting a property before mpv_initialize behaves as an
                // option write. 'vo=libmpv' selects the render-API video
                // output explicitly (the render API uses it internally;
                // setting it is the documented, defensive choice).
                (lib.set_property_string)(
                    handle,
                    b"vo\0".as_ptr() as *const c_char,
                    b"libmpv\0".as_ptr() as *const c_char,
                );
                let ir = (lib.initialize)(handle);
                if ir < 0 {
                    crate::devlog!(
                        error, "mpv2",
                        "mpv_initialize failed: {}", err_str(lib, ir),
                    );
                    (lib.terminate_destroy)(handle);
                } else {
                    (lib.request_log_messages)(
                        handle,
                        b"info\0".as_ptr() as *const c_char,
                    );

                    // Build the render-context params. The array is
                    // 0-terminated by a trailing INVALID entry — omitting
                    // it reads past bounds.
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
                    let cr = (lib.render_context_create)(
                        &mut rctx,
                        handle,
                        params.as_mut_ptr(),
                    );
                    if cr < 0 || rctx.is_null() {
                        crate::devlog!(
                            error, "mpv2",
                            "mpv_render_context_create failed: {}",
                            err_str(lib, cr),
                        );
                        (lib.terminate_destroy)(handle);
                    } else {
                        crate::devlog!(
                            info, "mpv2",
                            "mpv_render_context_create OK — render context live",
                        );
                        mpv_state = Some((rctx, handle));
                    }
                }
            }
        }

        // -- Render loop --
        let start = Instant::now();
        let mut logged_render = false;

        loop {
            // Pump messages so the child window stays responsive.
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // Bail if the window was closed (e.g. the user hit its X).
            if !IsWindow(Some(hwnd)).as_bool() {
                crate::devlog!(warn, "mpv2", "window closed — ending early");
                break;
            }

            let elapsed = start.elapsed();
            if elapsed >= TOTAL {
                break;
            }
            let phase_b = elapsed >= PHASE_SPLIT;

            // Render at the real client size — the caption bar makes the
            // client area smaller than WIN_W/WIN_H, which remain only a
            // fallback if GetClientRect fails.
            let mut rc = RECT::default();
            let (cw, ch) = if GetClientRect(hwnd, &mut rc).is_ok()
                && rc.right > rc.left
                && rc.bottom > rc.top
            {
                (rc.right - rc.left, rc.bottom - rc.top)
            } else {
                (WIN_W, WIN_H)
            };

            // Phase A & B both start with a static teal clear — that alone
            // proves the window + WGL context render a frame.
            glViewport(0, 0, cw, ch);
            glClearColor(0.04, 0.45, 0.50, 1.0);
            glClear(GL_COLOR_BUFFER_BIT);

            // Phase B additionally drives mpv's render context into the
            // default framebuffer (fbo = 0).
            if phase_b {
                if let (Some((rctx, handle)), Some(lib)) = (mpv_state, &lib_opt) {
                    drain_mpv_events(lib, handle);

                    let mut fbo = mpv_opengl_fbo {
                        fbo: 0,
                        w: cw,
                        h: ch,
                        internal_format: 0,
                    };
                    // FLIP_Y: GL's default framebuffer is bottom-up, so
                    // mpv must flip or the picture is upside down.
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
                    let rr = (lib.render_context_render)(rctx, rparams.as_mut_ptr());
                    if !logged_render {
                        let flags = (lib.render_context_update)(rctx);
                        crate::devlog!(
                            info, "mpv2",
                            "first mpv_render_context_render -> {}, update flags = {flags:#x}",
                            if rr < 0 { err_str(lib, rr) } else { "OK".to_string() },
                        );
                        logged_render = true;
                    }
                }
            }

            let _ = SwapBuffers(hdc);
            // ~60 Hz pacing — Phase 1 only needs a steady cadence; the
            // dual-mode vsync/timer present loop is Phase 2+ work.
            std::thread::sleep(Duration::from_millis(16));
        }

        // -- Teardown --
        // mpv_render_context_free must run while the GL context is still
        // current — it deletes the GL objects mpv created.
        if let (Some((rctx, handle)), Some(lib)) = (mpv_state, &lib_opt) {
            (lib.render_context_free)(rctx);
            (lib.terminate_destroy)(handle);
        }
        let _ = wglMakeCurrent(HDC::default(), HGLRC::default());
        let _ = wglDeleteContext(hglrc);
        ReleaseDC(Some(hwnd), hdc);
        let _ = DestroyWindow(hwnd);

        crate::devlog!(info, "mpv2", "hello-world complete — torn down cleanly");
        // lib_opt drops here -> libmpv-2.dll is unmapped last.
    }
}
