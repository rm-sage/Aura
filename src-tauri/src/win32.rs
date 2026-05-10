// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tiny Win32 helper — force-resize the embedded MPV child window so it
//! tracks the parent's client area on every parent resize / fullscreen
//! toggle.
//!
//! `tauri-plugin-libmpv` embeds MPV via the `--wid=<HWND>` option. The
//! embedded child window doesn't propagate WM_SIZE in every libmpv build,
//! so after a parent resize the video stays at its old geometry. The
//! standard fix is `SetWindowPos(child, …, x, y, new_w, new_h)`.
//!
//! `y_offset` allows the caller to push the child below the webview title
//! bar in windowed mode (36 px) without covering it. In fullscreen mode the
//! title bar is unmounted so y_offset = 0.
//!
//! IMPORTANT: the parent window has BOTH the WebView2 host AND the MPV
//! child as direct children. Naive `EnumChildWindows` resizes BOTH, which
//! clips the WebView2 (and therefore the React title bar / overlay) on
//! every fullscreen toggle. We filter by class name so only MPV-related
//! children get repositioned.
//!
//! We avoid pulling `windows-sys` as a dependency by dynamically loading
//! `user32.dll` via `libloading` (already a dep for the libmpv DLL probe).

use std::cell::Cell;
use std::ffi::c_void;
use std::sync::Mutex;

// Windows shell COM bindings for ITaskbarList2::MarkFullscreenWindow.
// See `signal_fullscreen_to_shell` below for full rationale. The `windows`
// 0.61 binding for MarkFullscreenWindow takes native Rust `bool` (the crate
// auto-converts to the underlying Win32 `BOOL`), so no manual wrapping is
// needed at the call site.
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{ITaskbarList2, TaskbarList};

const SWP_NOZORDER: u32   = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
const MONITOR_DEFAULTTONEAREST: u32 = 0x0000_0002;

/// HWND_TOPMOST sentinel — pass as `hwndInsertAfter` to make a window
/// topmost. Windows uses this signal (combined with a window that
/// covers the full monitor + has no chrome) to flip the auto-hide
/// taskbar into hidden state.
const HWND_TOPMOST: *mut c_void = -1isize as *mut c_void;
/// HWND_NOTOPMOST — drop the topmost flag without bringing the window
/// to front of the regular z-order.
const HWND_NOTOPMOST: *mut c_void = -2isize as *mut c_void;

#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

type GetClientRectFn = unsafe extern "system" fn(*mut c_void, *mut Rect) -> i32;
type SetWindowPosFn  = unsafe extern "system" fn(
    *mut c_void, *mut c_void, i32, i32, i32, i32, u32,
) -> i32;
type EnumChildWindowsFn = unsafe extern "system" fn(
    *mut c_void,
    Option<unsafe extern "system" fn(*mut c_void, isize) -> i32>,
    isize,
) -> i32;
type GetClassNameWFn = unsafe extern "system" fn(*mut c_void, *mut u16, i32) -> i32;

thread_local! {
    // Stash (SetWindowPos fn, GetClassName fn, y_offset, width, height) for
    // the EnumChildWindows callback.
    static CTX: Cell<Option<(SetWindowPosFn, GetClassNameWFn, i32, i32, i32)>> =
        const { Cell::new(None) };

    // Resize counter — incremented per call to verify MPV's window is being
    // found. If this stays at 0, EnumChildWindows is finding no MPV child
    // (possibly because the vo subsystem hasn't created one yet).
    static RESIZED: Cell<u32> = const { Cell::new(0) };
    static SKIPPED: Cell<u32> = const { Cell::new(0) };
}

/// Read the window's class name as a lowercase Rust String.
/// Returns "" on failure.
unsafe fn class_name_lower(get_class_name: GetClassNameWFn, hwnd: *mut c_void) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { get_class_name(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize]).to_lowercase()
}

/// Decide whether a child window is the WebView2 host (skip) vs. anything
/// else (resize as MPV).
///
/// WebView2 class names depend on the runtime version:
///   • "Chrome_WidgetWin_0" / "Chrome_WidgetWin_1"  (older Edge WebView2)
///   • "Microsoft.UI.Content.DesktopChildSiteBridge" (newer)
///   • "Intermediate D3D Window"                    (compositor surface)
///   • "Internet Explorer_Server"                   (legacy IE host)
///
/// We treat anything that ISN'T one of those as a candidate for resize —
/// libmpv-wrapper's window class doesn't have a stable name across builds,
/// so allow-listing MPV would be brittle.
/// Skip the WebView2 host AND Tauri's internal helper windows. Resizing
/// `tauri_drag_resize_borders` (the invisible window Tauri uses to detect
/// mouse drag/resize on the borderless window) breaks edge-drag behaviour
/// AND has been observed to race MPV's vo init on this libmpv build.
fn is_webview_host(class_lower: &str) -> bool {
    class_lower.starts_with("chrome_")
        || class_lower.contains("microsoft.ui")
        || class_lower.contains("webview")
        || class_lower == "intermediate d3d window"
        || class_lower == "internet explorer_server"
        || class_lower.starts_with("tauri_")
        || class_lower.starts_with("wry_")
}

unsafe extern "system" fn cb(child: *mut c_void, _lparam: isize) -> i32 {
    if child.is_null() { return 1; }
    let Some((set_window_pos, get_class_name, y, w, h)) = CTX.with(|c| c.get()) else {
        return 0;
    };
    unsafe {
        let class = class_name_lower(get_class_name, child);
        if is_webview_host(&class) {
            SKIPPED.with(|c| c.set(c.get() + 1));
            // debug-level: this fires for every webview / Tauri helper
            // window on every focus event. Useful when diagnosing
            // child-window enumeration; just noise day-to-day.
            crate::devlog!(debug, "win32", "skip child '{}' (webview host)", class);
            return 1;
        }
        crate::devlog!(info, "win32", "resize child '{}' → ({},{},{},{})",
            if class.is_empty() { "<unknown>" } else { &class },
            0, y, w, h
        );
        let r = set_window_pos(
            child,
            std::ptr::null_mut(),
            0, y, w, h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        if r == 0 {
            crate::devlog!(warn, "win32", "SetWindowPos failed for '{}'", class);
        } else {
            RESIZED.with(|c| c.set(c.get() + 1));
        }
    }
    1 // continue enumeration
}

/// Iterate the parent's non-WebView2 child windows and resize each to fill
/// the client area below `y_offset`. Pass `y_offset = 0` for fullscreen;
/// pass the title-bar height (36) for windowed playback.
pub fn resize_mpv_child_to_parent(parent_hwnd: isize, y_offset: i32) {
    if parent_hwnd == 0 {
        return;
    }

    unsafe {
        let user32 = match libloading::Library::new("user32.dll") {
            Ok(lib) => lib,
            Err(_) => return,
        };

        let get_client_rect: libloading::Symbol<GetClientRectFn> =
            match user32.get(b"GetClientRect\0") { Ok(s) => s, Err(_) => return };
        let set_window_pos: libloading::Symbol<SetWindowPosFn> =
            match user32.get(b"SetWindowPos\0") { Ok(s) => s, Err(_) => return };
        let enum_child_windows: libloading::Symbol<EnumChildWindowsFn> =
            match user32.get(b"EnumChildWindows\0") { Ok(s) => s, Err(_) => return };
        let get_class_name: libloading::Symbol<GetClassNameWFn> =
            match user32.get(b"GetClassNameW\0") { Ok(s) => s, Err(_) => return };

        let parent = parent_hwnd as *mut c_void;
        let mut rect = Rect::default();
        if get_client_rect(parent, &mut rect) == 0 {
            return;
        }
        let width  = rect.right  - rect.left;
        let height = rect.bottom - rect.top;
        let adjusted_h = (height - y_offset).max(0);
        if width <= 0 || adjusted_h <= 0 {
            return;
        }

        let swp_fn: SetWindowPosFn = *set_window_pos;
        let gcn_fn: GetClassNameWFn = *get_class_name;
        CTX.with(|c| c.set(Some((swp_fn, gcn_fn, y_offset, width, adjusted_h))));
        RESIZED.with(|c| c.set(0));
        SKIPPED.with(|c| c.set(0));
        let _ = enum_child_windows(parent, Some(cb), 0);
        let resized = RESIZED.with(|c| c.get());
        let skipped = SKIPPED.with(|c| c.get());
        CTX.with(|c| c.set(None));
        // Demote to debug when there's no MPV child to resize (the
        // common case while the user is browsing without a stream
        // playing — focus / resize events still trigger this path
        // but it's a no-op). Stays at info when we actually moved
        // something so the diagnostic value is preserved during
        // playback fullscreen / window resize.
        if resized > 0 {
            crate::devlog!(info, "win32",
                "resize_mpv_child y_offset={} client={}x{} resized={} skipped={}",
                y_offset, width, height, resized, skipped
            );
        } else {
            crate::devlog!(debug, "win32",
                "resize_mpv_child y_offset={} client={}x{} (no MPV child to resize, skipped={})",
                y_offset, width, height, skipped
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Native borderless fullscreen
//
// Tauri's `setFullscreen(true)` on a window configured with
// `decorations: false` + `transparent: true` ends up at the monitor's
// work-area bounds (everything except the taskbar) instead of the full
// monitor. The user-visible symptom is a strip of taskbar background
// showing under the player even when the OS has hidden the taskbar
// icons (because Windows still sees a fullscreen window above and
// auto-hides the icons, but the window itself doesn't paint over the
// taskbar's reserved area).
//
// We bypass Tauri's path entirely. On enter:
//   1. Save the parent window's current bounds (for restore on exit).
//   2. Resolve the monitor the window is currently on (closest if
//      partly off-screen).
//   3. SetWindowPos to that monitor's `rcMonitor` — the FULL monitor
//      rect, including the taskbar area. Combined with `decorations:
//      false` (already WS_POPUP-ish in style) this triggers Windows'
//      fullscreen-window heuristic and the taskbar genuinely hides.
//
// On exit we just restore the saved rect.
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MonitorInfo {
    cb_size:    u32,
    rc_monitor: Rect,
    rc_work:    Rect,
    dw_flags:   u32,
}

type MonitorFromWindowFn =
    unsafe extern "system" fn(*mut c_void, u32) -> *mut c_void;
type GetMonitorInfoWFn =
    unsafe extern "system" fn(*mut c_void, *mut MonitorInfo) -> i32;
type GetWindowRectFn =
    unsafe extern "system" fn(*mut c_void, *mut Rect) -> i32;
type GetWindowLongPtrWFn =
    unsafe extern "system" fn(*mut c_void, i32) -> isize;
type SetWindowLongPtrWFn =
    unsafe extern "system" fn(*mut c_void, i32, isize) -> isize;
// Reserved for future fullscreen-detection / taskbar-hint helpers.
#[allow(dead_code)]
type FindWindowWFn =
    unsafe extern "system" fn(*const u16, *const u16) -> *mut c_void;
type ShowWindowFn =
    unsafe extern "system" fn(*mut c_void, i32) -> i32;
type SetForegroundWindowFn =
    unsafe extern "system" fn(*mut c_void) -> i32;
type BringWindowToTopFn =
    unsafe extern "system" fn(*mut c_void) -> i32;
/// IsZoomed returns non-zero if the window is currently maximized. We use
/// it to remember the maximize state across the fullscreen toggle so the
/// user lands back in the same window state when they exit.
type IsZoomedFn =
    unsafe extern "system" fn(*mut c_void) -> i32;

/// Window-style longptr index.
const GWL_STYLE: i32 = -16;
/// Extended-window-style longptr index.
const GWL_EXSTYLE: i32 = -20;
/// Window styles we manipulate to enter/exit borderless fullscreen.
const WS_OVERLAPPEDWINDOW: isize = 0x00CF0000;
const WS_POPUP:            isize = 0x80000000_u32 as isize;
const WS_VISIBLE:          isize = 0x10000000;
/// WS_MAXIMIZE — set when the window is in maximized show state.
/// Critical: a window with WS_MAXIMIZE has its CLIENT area locked to
/// the monitor's work-area (= monitor minus taskbar), regardless of what
/// SetWindowPos sets the WINDOW rect to. Result: even when we
/// SetWindowPos to the full monitor rect, the client area stops at the
/// taskbar boundary and the taskbar stays visible underneath. We strip
/// this bit AND call ShowWindow(SW_RESTORE) on entering fullscreen so
/// the window genuinely un-maximizes. On exit we re-maximize via
/// ShowWindow(SW_MAXIMIZE) if the user had been maximized before.
const WS_MAXIMIZE:         isize = 0x01000000;
/// WS_EX_LAYERED — set by Tauri's `transparent: true` on some configs.
/// On this Tauri build the main window does NOT carry WS_EX_LAYERED
/// (transparency is composited via DWM / WebView2 directly), so the
/// strip below is a defensive no-op. Kept in the code path so a future
/// Tauri config that DOES set WS_EX_LAYERED won't reintroduce the
/// layered-z-order taskbar bug.
const WS_EX_LAYERED:       isize = 0x00080000;
/// WS_EX_TRANSPARENT — also stripped for the duration of fullscreen so
/// hit-testing and z-order stay sane on the now-non-layered window.
const WS_EX_TRANSPARENT:   isize = 0x00000020;
/// ShowWindow command codes used to un-/re-maximize the window across
/// the fullscreen toggle.
const SW_MAXIMIZE: i32 = 3;
const SW_RESTORE:  i32 = 9;

/// Saved (x, y, w, h) of the parent window before we entered native
/// borderless fullscreen. `None` means "we're not in fullscreen mode."
static SAVED_BOUNDS: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);
/// Saved window style (GWL_STYLE) before we forced WS_POPUP. Restored on exit.
static SAVED_STYLE: Mutex<Option<isize>> = Mutex::new(None);
/// Saved extended window style (GWL_EXSTYLE) before we stripped
/// WS_EX_LAYERED / WS_EX_TRANSPARENT. Restored on exit.
static SAVED_EX_STYLE: Mutex<Option<isize>> = Mutex::new(None);
/// True if the window was maximized when fullscreen was entered. Drives
/// the re-maximize-on-exit step so the user lands back in the same
/// window state. Cleared on exit.
static SAVED_WAS_MAXIMIZED: Mutex<bool> = Mutex::new(false);
/// True when we have hidden Explorer's taskbar via Shell_TrayWnd. Drives the
/// "must restore on exit" path so we never leave the user with a hidden
/// taskbar permanently.
static TASKBAR_HIDDEN: Mutex<bool> = Mutex::new(false);

/// Hide the Windows taskbar (Shell_TrayWnd) for the duration of fullscreen.
/// Best-effort — never returns an error to the caller.
///
/// Why this exists: Windows' built-in fullscreen detection only auto-hides
/// the taskbar when the user has "automatically hide the taskbar" enabled
/// in Settings. With the default "always show" config, the taskbar paints
/// OVER fullscreen non-exclusive windows even when our window is at the
/// monitor's full bounds, has WS_POPUP, and is HWND_TOPMOST. The only
/// reliable workaround for non-exclusive borderless fullscreen is to
/// SW_HIDE the taskbar window directly.
///
/// Restored unconditionally on exit_native_fullscreen (and via a process-
/// abort fallback if the user kills the app — Explorer auto-restarts a
/// hidden taskbar within seconds).
/// We previously SW_HIDE'd Shell_TrayWnd to force the taskbar away in
/// fullscreen, but on multi-monitor setups that hid the SECONDARY
/// monitor's tray icons too — a worse outcome than the original
/// "taskbar bar is still visible" complaint. Reverted: rely solely on
/// Windows' built-in fullscreen detection (HWND_TOPMOST + WS_POPUP +
/// monitor-rect coverage). If the user has the taskbar set to "always
/// show", Windows non-exclusive fullscreen WILL leave it visible —
/// that's an OS architectural limit; the workaround is the user's
/// own "automatically hide taskbar" setting.
unsafe fn hide_taskbar() {
    // Intentional no-op. See header comment.
}

/// Public: restore the Windows taskbar if we hid it. Called from the
/// app-close handler so a CloseRequested-while-fullscreen never strands
/// the user without a taskbar.
pub fn ensure_taskbar_visible() {
    unsafe { show_taskbar(); }
}

/// `true` while the window is in our Win32-managed native fullscreen
/// (between enter_native_fullscreen and exit_native_fullscreen). Used by
/// the WindowEvent::Resized backstop to pick the correct MPV-child
/// y_offset (0 in fullscreen, 36 in windowed).
pub fn is_in_native_fullscreen() -> bool {
    SAVED_BOUNDS.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// One-shot startup recovery. Runs once during app setup AFTER
/// `tauri-plugin-window-state` has restored bounds.
///
/// Why this exists: an earlier version of `enter_native_fullscreen` could
/// be called twice in a row when the React state lost track of the
/// fullscreen flag, which clobbered SAVED_BOUNDS with the *current*
/// fullscreen rect (= `(0, 0, monitor_w, monitor_h)`). The matching
/// `exit_native_fullscreen` then restored the window to that monitor rect
/// WITHOUT re-applying WS_MAXIMIZE — leaving the window covering the full
/// monitor (taskbar area included) but not in maximize show-state. The
/// window-state plugin then persisted those exact bounds, so even a
/// fresh launch came back stuck: window covers the full monitor, taskbar
/// is hidden by Windows' fullscreen-ish auto-detect / auto-hide.
///
/// This recovery detects that exact condition (window covers the full
/// monitor rect AND IsZoomed returns false) and calls SW_MAXIMIZE so the
/// OS re-applies its work-area lock. With WS_MAXIMIZE set, the client
/// area collapses to the work area (= monitor minus taskbar) and the
/// taskbar is once again drawn over the bottom of the screen.
pub fn recover_window_state(parent_hwnd: isize) {
    if parent_hwnd == 0 {
        return;
    }
    unsafe {
        let user32 = match libloading::Library::new("user32.dll") {
            Ok(lib) => lib,
            Err(_) => return,
        };
        let get_window_rect: libloading::Symbol<GetWindowRectFn> =
            match user32.get(b"GetWindowRect\0") { Ok(s) => s, Err(_) => return };
        let monitor_from_window: libloading::Symbol<MonitorFromWindowFn> =
            match user32.get(b"MonitorFromWindow\0") { Ok(s) => s, Err(_) => return };
        let get_monitor_info: libloading::Symbol<GetMonitorInfoWFn> =
            match user32.get(b"GetMonitorInfoW\0") { Ok(s) => s, Err(_) => return };
        let is_zoomed: libloading::Symbol<IsZoomedFn> =
            match user32.get(b"IsZoomed\0") { Ok(s) => s, Err(_) => return };
        let show_window: libloading::Symbol<ShowWindowFn> =
            match user32.get(b"ShowWindow\0") { Ok(s) => s, Err(_) => return };

        let parent = parent_hwnd as *mut c_void;

        // Skip if already maximized — nothing to recover.
        if is_zoomed(parent) != 0 {
            return;
        }

        let mut rect = Rect::default();
        if get_window_rect(parent, &mut rect) == 0 {
            return;
        }

        let monitor = monitor_from_window(parent, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return;
        }
        let mut info = MonitorInfo::default();
        info.cb_size = std::mem::size_of::<MonitorInfo>() as u32;
        if get_monitor_info(monitor, &mut info) == 0 {
            return;
        }

        // Compare window rect to monitor rect. If they match exactly,
        // the window is in the corrupted "stuck at monitor rect, no
        // maximize" state described above.
        let m = info.rc_monitor;
        let stuck = rect.left == m.left
            && rect.top == m.top
            && rect.right == m.right
            && rect.bottom == m.bottom;
        if !stuck {
            return;
        }

        crate::devlog!(info, "win32",
            "recover_window_state: window at full monitor rect ({},{},{},{}) without WS_MAXIMIZE — re-maximizing",
            m.left, m.top, m.right - m.left, m.bottom - m.top,
        );
        let _ = show_window(parent, SW_MAXIMIZE);
    }
}

/// No-op companion to `hide_taskbar`. Kept so the public
/// `ensure_taskbar_visible` API still exists for callers that may need it
/// (window close, panic recovery) even though we don't hide the taskbar
/// any more.
unsafe fn show_taskbar() {
    let mut flag = TASKBAR_HIDDEN.lock().unwrap();
    *flag = false;
}

/// Signal the Windows shell that `hwnd` is (or is no longer) running in
/// fullscreen mode via `ITaskbarList2::MarkFullscreenWindow`.
///
/// Why this exists: Windows' built-in DWM fullscreen-detection heuristic
/// fails on borderless transparent layered windows (our Tauri shell uses
/// `decorations: false` + `transparent: true`, which sets `WS_EX_LAYERED`
/// — and DWM's auto-hide-taskbar logic treats layered windows as
/// non-fullscreen even when they cover the whole monitor with WS_POPUP +
/// HWND_TOPMOST). The shell exposes an explicit, documented bypass:
/// MarkFullscreenWindow tells Explorer "treat this HWND as fullscreen for
/// the purposes of the taskbar / app-bar" regardless of style heuristics.
///
/// This is the same path Chromium / Firefox / VLC use to suppress the
/// Windows taskbar in their borderless fullscreen modes — there's no
/// reparenting, no global Shell_TrayWnd manipulation, no architectural
/// rewrite. It's the canonical fix.
///
/// THREADING: COM rules say MarkFullscreenWindow runs against the HWND's
/// thread, but the interface itself can be created in any single-threaded
/// apartment. We CoInitializeEx an STA on whatever thread we're called
/// from (idempotent — `RPC_E_CHANGED_MODE` and `S_FALSE` both mean "OK,
/// already initialised") then drop the interface at function exit.
/// CoUninitialize is intentionally NOT called: the apartment may be
/// reused by a later toggle, and `tauri-plugin-libmpv` / souvlaki / etc.
/// also touch COM, so unbalancing the ref count is risky.
///
/// ERRORS: any COM failure is swallowed by the caller (logged as warn).
/// The pre-fix behaviour was "taskbar overlaps fullscreen" — a quietly
/// failed call to this helper degrades back to that, never crashes.
pub fn signal_fullscreen_to_shell(
    parent_hwnd: isize,
    fullscreen: bool,
) -> Result<(), windows::core::Error> {
    if parent_hwnd == 0 {
        return Err(windows::core::Error::from_win32());
    }
    let hwnd = HWND(parent_hwnd as *mut std::ffi::c_void);

    unsafe {
        // CoInitializeEx returns:
        //   S_OK              — first init on this thread
        //   S_FALSE           — already initialised in same mode (OK)
        //   RPC_E_CHANGED_MODE — already initialised in DIFFERENT mode (still OK
        //                       for our purposes; the existing apartment will host
        //                       the interface, MarkFullscreenWindow doesn't care)
        let init_hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // We don't gate on init_hr — CoCreateInstance below will fail with a
        // clearer error if the apartment really isn't usable. This avoids
        // false negatives when another module beat us to CoInitialize.
        let _ = init_hr;

        let taskbar_list: ITaskbarList2 =
            CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)?;

        // ITaskbarList::HrInit() is mandatory before any other method per MS
        // docs — it does the version negotiation with the shell.
        taskbar_list.HrInit()?;

        // The 0.61 binding takes native Rust `bool` directly — windows-rs
        // converts to the underlying Win32 BOOL automatically. Older
        // bindings (0.58 and earlier) required `BOOL::from(fullscreen)`;
        // if a future windows-rs bump regresses this, the compiler will
        // surface it with a `expected BOOL, found bool` mismatch.
        taskbar_list.MarkFullscreenWindow(hwnd, fullscreen)?;

        // Interface dropped here releases its ref count. CoUninitialize is
        // intentionally not paired with the CoInitializeEx above — see
        // function-level docs.
        Ok(())
    }
}

/// Move the parent window to its current monitor's full bounds. Saves
/// the previous bounds so `exit_native_fullscreen` can restore them.
pub fn enter_native_fullscreen(parent_hwnd: isize) -> Result<(), String> {
    if parent_hwnd == 0 {
        return Err("invalid hwnd".into());
    }

    // Idempotent: if SAVED_BOUNDS is already Some we're already in
    // native fullscreen — re-running enter_* would (a) overwrite
    // SAVED_BOUNDS with the *current* fullscreen rect (so a future exit
    // restores to the wrong place, leaving the window stuck at the
    // monitor rect with the maximize state lost) and (b) overwrite
    // SAVED_WAS_MAXIMIZED with `false` (because IsZoomed on a
    // WS_POPUP-at-monitor-rect window returns false), so the matching
    // exit wouldn't re-apply SW_MAXIMIZE. Both bugs were observed when
    // the frontend lost track of the fullscreen state and called the
    // toggle a second time. Treat the duplicate enter as a no-op.
    if SAVED_BOUNDS.lock().map(|g| g.is_some()).unwrap_or(false) {
        crate::devlog!(info, "win32",
            "enter_native_fullscreen: already in native fullscreen, no-op"
        );
        return Ok(());
    }

    unsafe {
        let user32 = libloading::Library::new("user32.dll")
            .map_err(|e| e.to_string())?;
        let monitor_from_window: libloading::Symbol<MonitorFromWindowFn> =
            user32.get(b"MonitorFromWindow\0").map_err(|e| e.to_string())?;
        let get_monitor_info: libloading::Symbol<GetMonitorInfoWFn> =
            user32.get(b"GetMonitorInfoW\0").map_err(|e| e.to_string())?;
        let get_window_rect: libloading::Symbol<GetWindowRectFn> =
            user32.get(b"GetWindowRect\0").map_err(|e| e.to_string())?;
        let set_window_pos: libloading::Symbol<SetWindowPosFn> =
            user32.get(b"SetWindowPos\0").map_err(|e| e.to_string())?;
        let get_window_long: libloading::Symbol<GetWindowLongPtrWFn> =
            user32.get(b"GetWindowLongPtrW\0").map_err(|e| e.to_string())?;
        let set_window_long: libloading::Symbol<SetWindowLongPtrWFn> =
            user32.get(b"SetWindowLongPtrW\0").map_err(|e| e.to_string())?;

        let parent = parent_hwnd as *mut c_void;

        // 1. Snapshot current bounds for the eventual restore.
        let mut current = Rect::default();
        if get_window_rect(parent, &mut current) == 0 {
            return Err("GetWindowRect failed".into());
        }
        *SAVED_BOUNDS.lock().unwrap() = Some((
            current.left,
            current.top,
            current.right - current.left,
            current.bottom - current.top,
        ));

        // 1b. Detect + un-maximize. THIS IS THE KEY FIX FOR THE TASKBAR
        //     BLEED-THROUGH. A window with WS_MAXIMIZE locks its CLIENT
        //     area to the monitor's WORK area (= monitor minus taskbar)
        //     regardless of what SetWindowPos sets the WINDOW rect to —
        //     so even with WS_POPUP + monitor-rect + HWND_TOPMOST the
        //     client stops at the taskbar boundary and the taskbar paints
        //     UNDER our window. The fix is to actually exit the maximized
        //     show-state via SW_RESTORE before the style/rect changes;
        //     that releases the work-area lock so the subsequent
        //     SetWindowPos really fills the monitor. SW_MAXIMIZE on exit
        //     restores the user's prior maximize state.
        let was_maximized = if let Ok(is_zoomed) = user32.get::<IsZoomedFn>(b"IsZoomed\0") {
            is_zoomed(parent) != 0
        } else { false };
        *SAVED_WAS_MAXIMIZED.lock().unwrap() = was_maximized;
        if was_maximized {
            if let Ok(show_window) = user32.get::<ShowWindowFn>(b"ShowWindow\0") {
                let _ = show_window(parent, SW_RESTORE);
                crate::devlog!(info, "win32",
                    "un-maximized window before fullscreen (was WS_MAXIMIZE)"
                );
            }
        }

        // 2. Snapshot current window style so we can put it back on exit,
        //    then force WS_POPUP. Windows' auto-hide-taskbar fullscreen
        //    detection requires the window to have the WS_POPUP style
        //    (no overlapped chrome) AND cover the entire monitor AND be
        //    topmost. Tauri's `decorations: false` strips visible chrome
        //    but the underlying GWL_STYLE may still include
        //    WS_OVERLAPPEDWINDOW bits (caption / thickframe / sysmenu),
        //    which trips the heuristic — we strip them explicitly here.
        //    Also strip WS_MAXIMIZE defensively in case SW_RESTORE above
        //    didn't fully clear the bit (rare, but seen in some Tauri /
        //    DWM permutations).
        let current_style = get_window_long(parent, GWL_STYLE);
        *SAVED_STYLE.lock().unwrap() = Some(current_style);
        let fullscreen_style =
            (current_style & !WS_OVERLAPPEDWINDOW & !WS_MAXIMIZE) | WS_POPUP | WS_VISIBLE;
        set_window_long(parent, GWL_STYLE, fullscreen_style);

        // 2b. Snapshot + strip the layered/transparent extended-window
        //     bits if present. On the current Tauri config the main
        //     window doesn't actually carry WS_EX_LAYERED so this is
        //     usually a no-op, but a future config change could
        //     reintroduce it (and with it, the layered-z-order
        //     taskbar bug). We only log when something changed.
        let current_ex_style = get_window_long(parent, GWL_EXSTYLE);
        *SAVED_EX_STYLE.lock().unwrap() = Some(current_ex_style);
        let fullscreen_ex_style = current_ex_style & !(WS_EX_LAYERED | WS_EX_TRANSPARENT);
        if fullscreen_ex_style != current_ex_style {
            set_window_long(parent, GWL_EXSTYLE, fullscreen_ex_style);
            crate::devlog!(info, "win32",
                "fullscreen ex-style 0x{:X} → 0x{:X} (layered/transparent stripped)",
                current_ex_style as u32, fullscreen_ex_style as u32,
            );
        }

        // 3. Resolve target monitor + its full bounds.
        let monitor = monitor_from_window(parent, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return Err("MonitorFromWindow returned null".into());
        }
        let mut info: MonitorInfo = MonitorInfo::default();
        info.cb_size = std::mem::size_of::<MonitorInfo>() as u32;
        if get_monitor_info(monitor, &mut info) == 0 {
            return Err("GetMonitorInfoW failed".into());
        }
        let m = info.rc_monitor;
        let w = m.right - m.left;
        let h = m.bottom - m.top;

        crate::devlog!(info, "win32",
            "enter_native_fullscreen → monitor=({},{},{},{}) style 0x{:X} → 0x{:X}",
            m.left, m.top, w, h, current_style as u32, fullscreen_style as u32,
        );

        // 4. Move the window to fill the entire monitor + topmost.
        //    SWP_FRAMECHANGED is REQUIRED after a SetWindowLongPtr style
        //    change for Windows to re-evaluate the non-client area.
        //    Crucially we DO want activation here — Windows' "auto-hide
        //    taskbar in fullscreen" heuristic only kicks in for the
        //    foreground window, so dropping SWP_NOACTIVATE is necessary.
        let r = set_window_pos(
            parent,
            HWND_TOPMOST,
            m.left, m.top, w, h,
            SWP_FRAMECHANGED,
        );
        if r == 0 {
            return Err("SetWindowPos failed".into());
        }

        // 4b. Belt-and-suspenders activation. Some Windows builds require
        //     an explicit BringWindowToTop + SetForegroundWindow combo
        //     before the fullscreen-detection heuristic accepts the
        //     window — SetWindowPos alone isn't always enough on
        //     borderless+transparent Tauri windows.
        if let Ok(bring_to_top) = user32.get::<BringWindowToTopFn>(b"BringWindowToTop\0") {
            let _ = bring_to_top(parent);
        }
        if let Ok(set_fg) = user32.get::<SetForegroundWindowFn>(b"SetForegroundWindow\0") {
            let _ = set_fg(parent);
        }

        // 5. Force-hide the taskbar window. Required because Windows'
        //    built-in fullscreen detection only auto-hides the taskbar
        //    when the user has "automatically hide" enabled — and many
        //    users keep "always show" configured. SW_HIDE is restored
        //    unconditionally in exit_native_fullscreen.
        hide_taskbar();
    }

    // 6. Signal the shell that this HWND is now fullscreen. This must
    //    fire LAST, after all SetWindowPos / activation / SetWindowLongPtr
    //    calls have settled, so Explorer sees the final HWND state. On
    //    layered (transparent) windows this is the ONLY reliable way to
    //    suppress the taskbar — DWM's automatic detection ignores them.
    //
    //    Errors are logged + swallowed: a failed signal degrades back to
    //    the pre-fix behaviour (taskbar bleeds through), never crashes.
    if let Err(e) = signal_fullscreen_to_shell(parent_hwnd, true) {
        crate::devlog!(warn, "win32",
            "ITaskbarList2::MarkFullscreenWindow(true) failed: {} (taskbar may overlap)", e
        );
    } else {
        crate::devlog!(info, "win32", "ITaskbarList2 signalled fullscreen=true");
    }

    Ok(())
}

/// Restore the parent window to the bounds it had before
/// `enter_native_fullscreen` ran. No-op if we never entered.
pub fn exit_native_fullscreen(parent_hwnd: isize) -> Result<(), String> {
    if parent_hwnd == 0 {
        return Err("invalid hwnd".into());
    }
    let saved = SAVED_BOUNDS.lock().unwrap().take();
    let Some((x, y, w, h)) = saved else {
        // Nothing to restore — already windowed.
        return Ok(());
    };

    unsafe {
        let user32 = libloading::Library::new("user32.dll")
            .map_err(|e| e.to_string())?;
        let set_window_pos: libloading::Symbol<SetWindowPosFn> =
            user32.get(b"SetWindowPos\0").map_err(|e| e.to_string())?;
        let set_window_long: libloading::Symbol<SetWindowLongPtrWFn> =
            user32.get(b"SetWindowLongPtrW\0").map_err(|e| e.to_string())?;

        let parent = parent_hwnd as *mut c_void;

        // Restore the original window style we saved on enter. Required
        // before SetWindowPos so the WS_OVERLAPPEDWINDOW chrome bits
        // come back in the right order (the OS computes non-client
        // metrics off this).
        if let Some(saved_style) = SAVED_STYLE.lock().unwrap().take() {
            set_window_long(parent, GWL_STYLE, saved_style);
        }

        // Restore the saved extended style — putting back WS_EX_LAYERED
        // (and WS_EX_TRANSPARENT if it was originally there). This brings
        // the window back into the layered compositor path so windowed-
        // mode transparency works again (WebView2 + MPV bleed-through).
        // Order matters: re-add WS_EX_LAYERED BEFORE the SetWindowPos
        // below so the SWP_FRAMECHANGED on the restore picks up the new
        // ex-style in the same WM_NCCALCSIZE round.
        if let Some(saved_ex_style) = SAVED_EX_STYLE.lock().unwrap().take() {
            set_window_long(parent, GWL_EXSTYLE, saved_ex_style);
            crate::devlog!(info, "win32",
                "restore ex-style → 0x{:X} (layered re-applied)",
                saved_ex_style as u32,
            );
        }

        crate::devlog!(info, "win32",
            "exit_native_fullscreen → restore=({},{},{},{})", x, y, w, h
        );

        // Drop HWND_TOPMOST so the window goes back into the normal
        // z-order — otherwise the windowed player would sit on top of
        // every other app forever.
        let r = set_window_pos(
            parent,
            HWND_NOTOPMOST,
            x, y, w, h,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        if r == 0 {
            return Err("SetWindowPos restore failed".into());
        }

        // Re-maximize if the user was maximized before the fullscreen
        // toggle. ShowWindow(SW_MAXIMIZE) tells the OS to apply its full
        // maximize-state semantics (including the work-area-locked
        // client area) — important for the user's mental model: they
        // had a maximized window before pressing F11, they get a
        // maximized window back after pressing F11 again.
        let was_maximized = std::mem::replace(
            &mut *SAVED_WAS_MAXIMIZED.lock().unwrap(), false,
        );
        if was_maximized {
            if let Ok(show_window) = user32.get::<ShowWindowFn>(b"ShowWindow\0") {
                let _ = show_window(parent, SW_MAXIMIZE);
                crate::devlog!(info, "win32",
                    "re-maximized window after fullscreen exit"
                );
            }
        }

        // Always restore the taskbar after exiting fullscreen — even if
        // the SetWindowPos call above failed. Leaving the user with a
        // hidden taskbar would be a bad outcome.
        show_taskbar();
    }

    // Tell the shell we're no longer fullscreen. Mirrors the call in
    // enter_native_fullscreen so Explorer un-suppresses the taskbar
    // overlay path. Errors are logged + swallowed (same rationale).
    if let Err(e) = signal_fullscreen_to_shell(parent_hwnd, false) {
        crate::devlog!(warn, "win32",
            "ITaskbarList2::MarkFullscreenWindow(false) failed: {}", e
        );
    } else {
        crate::devlog!(info, "win32", "ITaskbarList2 signalled fullscreen=false");
    }

    Ok(())
}

