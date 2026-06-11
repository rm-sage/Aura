// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tiny Win32 helper — force-resize the embedded MPV child window so it
//! tracks its parent's client area on every parent resize / fullscreen
//! toggle.
//!
//! The mpv engine embeds MPV via the `wid=<HWND>` option (pointed at the
//! engine's host child window). The embedded child window doesn't
//! propagate WM_SIZE in every libmpv build, so after a parent resize the
//! video stays at its old geometry. The standard fix is
//! `SetWindowPos(child, …, x, y, new_w, new_h)` — the engine's pump loop
//! calls this with the host HWND + y_offset 0 whenever the host moves.
//!
//! `y_offset` allows a caller to push the child below the webview title
//! bar (36 px) when targeting a parent whose client area includes it; the
//! engine's host window already sits below the title bar, so its calls
//! pass 0.
//!
//! IMPORTANT (kept for any future caller targeting the MAIN window): the
//! main window has BOTH the WebView2 host AND video children. Naive
//! `EnumChildWindows` resizes BOTH, which clips the WebView2 (and
//! therefore the React title bar / overlay). We filter by class name so
//! only MPV-related children get repositioned.
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
/// Suppress the WM_WINDOWPOSCHANGING broadcast that other windows /
/// shell extensions react to. Reduces the multi-monitor DWM
/// compositor re-sort cost during the fullscreen flip, which is the
/// dominant source of the brief "other monitors flash black" symptom.
const SWP_NOSENDCHANGING: u32 = 0x0400;
const MONITOR_DEFAULTTONEAREST: u32 = 0x0000_0002;

/// HWND_TOPMOST sentinel — pass as `hwndInsertAfter` to make a window
/// topmost. Windows uses this signal (combined with a window that
/// covers the full monitor + has no chrome) to flip the auto-hide
/// taskbar into hidden state.
///
/// CAUTION: combining HWND_TOPMOST with WS_POPUP + monitor-rect coverage
/// + foreground status triggers Windows' "fullscreen optimization" —
/// DWM drops the window from composition and treats it like an
/// exclusive-fullscreen game. That breaks WebView2 transparency (the
/// React UI vanishes), bypasses DWM color management (raw gamma —
/// looks "more vivid"), and forces a multi-monitor composition re-sort
/// (other monitors briefly black out during the transition). For
/// Aura's borderless-fullscreen-with-overlay use case we use HWND_TOP
/// instead — foreground but NOT topmost, which keeps DWM composition
/// engaged for our window and avoids all three symptoms.
const HWND_TOPMOST: *mut c_void = -1isize as *mut c_void;
/// HWND_TOP — bring to top of the regular (non-topmost) z-order
/// without joining the topmost pool. This is what we use for native
/// fullscreen: keeps DWM composition engaged so transparency + colour
/// management + multi-monitor composition all behave correctly.
const HWND_TOP: *mut c_void = 0 as *mut c_void;

// HWND_TOPMOST itself is intentionally unused (see big comment above);
// the symbol + its comment is kept as load-bearing documentation so
// future code touching the fullscreen path doesn't reintroduce it.
#[allow(dead_code)]
const _HWND_TOPMOST_DOC_ANCHOR: *mut c_void = HWND_TOPMOST;
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

    // The most-recently-resized MPV child HWND (the swapchain-owning window).
    // Captured so resize_mpv_child_to_parent can clip THAT window for the
    // windowed MPO poison — the disqualifier has to be on the plane's own
    // window, not the top-level (see apply_mpo_poison / mpv_child_poison).
    static MPV_CHILD: Cell<*mut c_void> = const { Cell::new(std::ptr::null_mut()) };
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
            MPV_CHILD.with(|c| c.set(child));
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
        MPV_CHILD.with(|c| c.set(std::ptr::null_mut()));
        let _ = enum_child_windows(parent, Some(cb), 0);
        let resized = RESIZED.with(|c| c.get());
        let skipped = SKIPPED.with(|c| c.get());
        let mpv_child = MPV_CHILD.with(|c| c.get());
        CTX.with(|c| c.set(None));

        // WINDOWED MPO poison: clip the MPV child (the swapchain-owning
        // window) so its video plane can't be promoted to a hardware overlay
        // in windowed mode → DWM composites → the QD-OLED gets the EDID-
        // calibrated signal (true black). The fullscreen case is handled by
        // the top-level corner notch in apply_mpo_poison; here we target the
        // CHILD because the driver grades the child plane's own rectangle,
        // which a top-level region never touches (that's why the old
        // top-level windowed strip was a no-op). A hole in the MPV child
        // exposes the host window's BLACK class brush behind it, so the
        // artifact is a 1px black line near the top of the video — not a
        // see-through gap. Gated to passthrough + windowed; cleared otherwise.
        if !mpv_child.is_null() && !rect_is_empty(width, adjusted_h) {
            apply_mpv_child_poison(mpv_child, width, adjusted_h);
        }
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
/// GetForegroundWindow returns the HWND that currently owns input focus
/// (or NULL when no foreground window exists, e.g. during a screen
/// lock). Used by enter_native_fullscreen to skip redundant activation
/// calls when our window is already foreground.
type GetForegroundWindowFn =
    unsafe extern "system" fn() -> *mut c_void;
/// IsZoomed returns non-zero if the window is currently maximized. We use
/// it to remember the maximize state across the fullscreen toggle so the
/// user lands back in the same window state when they exit.
type IsZoomedFn =
    unsafe extern "system" fn(*mut c_void) -> i32;
/// Region APIs (gdi32 + user32) driving the MPO "poison pill": a
/// non-rectangular window region disqualifies the window from hardware
/// overlay / Independent-Flip promotion without adding any alpha (so the
/// window stays fully opaque — no desktop bleed-through).
type CreateRectRgnFn =
    unsafe extern "system" fn(i32, i32, i32, i32) -> *mut c_void;
type CombineRgnFn =
    unsafe extern "system" fn(*mut c_void, *mut c_void, *mut c_void, i32) -> i32;
type DeleteObjectFn =
    unsafe extern "system" fn(*mut c_void) -> i32;
type SetWindowRgnFn =
    unsafe extern "system" fn(*mut c_void, *mut c_void, i32) -> i32;
/// CombineRgn mode: Src1 − Src2.
const RGN_DIFF: i32 = 4;

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

/// Keep the display + system awake during playback (or release that hold).
///
/// WHY THIS EXISTS: under the mpv render-API engine, mpv renders into a
/// surface WE own (`vo=libmpv`) and no longer manages a video-output
/// window — so mpv's built-in `stop-screensaver` can't fire, and after the
/// OS idle timeout the monitors sleep mid-playback. (The legacy `--wid`
/// path didn't have this problem: mpv owned the window and inhibited the
/// screensaver itself.) `SetThreadExecutionState` is the canonical Win32
/// way to assert "keep the display on."
///
/// `ES_CONTINUOUS` makes the state persist until the next call (rather
/// than a one-shot idle-timer poke), so we set it once on the playing↔
/// paused transition instead of heartbeating. CRITICAL: the continuous
/// state is PER-THREAD — `inhibit(true)` and the matching `inhibit(false)`
/// MUST run on the same thread. The mpv engine calls this only from its
/// single long-lived render thread, satisfying that. The state also clears
/// automatically when that thread terminates (app shutdown), so the
/// display can sleep again on exit.
pub fn set_display_sleep_inhibited(inhibit: bool) {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    type SetThreadExecutionStateFn = unsafe extern "system" fn(u32) -> u32;

    let flags = if inhibit {
        ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    unsafe {
        let Ok(kernel32) = libloading::Library::new("kernel32.dll") else { return; };
        let Ok(set_state) =
            kernel32.get::<SetThreadExecutionStateFn>(b"SetThreadExecutionState\0")
        else { return; };
        // Return value is the PREVIOUS state (or 0 on failure); we don't
        // need it. The call itself is the effect.
        let _ = set_state(flags);
    }
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
// ---------------------------------------------------------------------------
// MPO "poison pill" — force DWM composition for Aura's window so the MPV
// child swapchain is never promoted to an Independent-Flip / Multi-Plane-
// Overlay hardware plane.
//
// WHY: on direct scanout the panel receives the raw PQ signal and applies
// its OWN near-black EOTF (raised blacks on some QD-OLEDs). DWM composition
// re-maps through the panel's EDID calibration → true black. Every other
// per-app lever failed (in-webview overlay can't beat HW plane-blending,
// d3d11-output-mode=composition breaks --wid, metadata can't move the panel
// EOTF). A NON-RECTANGULAR window region is the one that works: overlay
// planes are strictly rectangular, so a clipped window can't be promoted →
// DWM composites it. Global MPO stays enabled for other apps (games' RTX
// HDR); only Aura's window tree becomes plane-ineligible. No alpha → the
// window stays fully opaque (the layered-alpha variant fixed the blacks too
// but bled the desktop through at ~0.4 %).
//
// GATING: applied only when `hdr_mode == "passthrough"` (the lone case the
// black-lift matters) — SDR / off playback keeps the efficient direct-scanout
// path and no clipped pixels. Re-evaluated at startup, on every HDR-settings
// change (apply_hdr_settings), and after each fullscreen transition (a
// SetWindowPos with SWP_FRAMECHANGED can clear the region).
//
// WHICH WINDOW gets clipped is mode-dependent — this was the hard-won fix:
//   • Fullscreen → the TOP-LEVEL window (apply_mpo_poison), a 1×1 corner
//     notch. The whole window IS the video, so Independent Flip demands EXACT
//     full-monitor coverage; any top-level notch breaks it. Imperceptible.
//   • Windowed → the MPV CHILD window itself (apply_mpv_child_poison, driven
//     from resize_mpv_child_to_parent), a FULL-WIDTH 1px strip. Here the video
//     is a child SUB-plane the driver grades on the CHILD's own rectangle — a
//     TOP-LEVEL region never subtracts from it (that's why the old top-level
//     windowed strip was a confirmed no-op). Clipping the child's OWN window
//     splits its visible region into two disconnected rectangles → no single
//     overlay → DWM composites. The hole exposes the host's black brush, so
//     the artifact is a 1px BLACK line near the top of the video.
fn hdr_passthrough_active() -> bool {
    crate::player::resolve_hdr_mode(&crate::settings::snapshot()) == "passthrough"
}

/// Apply (or clear) the MPO poison on the top-level window based on the
/// current HDR mode + windowed/fullscreen state. Idempotent — safe to call
/// at startup, on HDR-settings change, and after every fullscreen
/// transition. When passthrough is off, any previously-set region is cleared
/// (back to a normal rectangular window).
pub fn apply_mpo_poison(parent_hwnd: isize) {
    if parent_hwnd == 0 {
        return;
    }
    unsafe {
        let Ok(user32) = libloading::Library::new("user32.dll") else { return; };
        let Ok(set_window_rgn) = user32.get::<SetWindowRgnFn>(b"SetWindowRgn\0") else { return; };
        let hwnd = parent_hwnd as *mut c_void;

        // The top-level notch ONLY does anything in fullscreen (whole-window
        // Independent Flip needs exact full-monitor coverage, so a corner
        // pixel breaks it). In WINDOWED mode the video is a child SUB-plane
        // the driver grades on the CHILD's own rectangle, which a top-level
        // region never touches — that path is handled by apply_mpv_child_poison
        // (clips the MPV child itself). So here: corner notch in fullscreen-
        // passthrough; clear the top-level region otherwise.
        if !hdr_passthrough_active() || !is_in_native_fullscreen() {
            set_window_rgn(hwnd, std::ptr::null_mut(), 1);
            return;
        }

        let Ok(gdi32) = libloading::Library::new("gdi32.dll") else { return; };
        let Ok(create_rect_rgn) = gdi32.get::<CreateRectRgnFn>(b"CreateRectRgn\0") else { return; };
        let Ok(combine_rgn) = gdi32.get::<CombineRgnFn>(b"CombineRgn\0") else { return; };
        let Ok(delete_object) = gdi32.get::<DeleteObjectFn>(b"DeleteObject\0") else { return; };

        // Fullscreen: region larger than any monitor minus a 1×1 corner notch
        // (imperceptible; breaks exact-coverage Independent Flip).
        let full = create_rect_rgn(0, 0, 32767, 32767);
        let notch = create_rect_rgn(0, 0, 1, 1);
        combine_rgn(full, full, notch, RGN_DIFF);
        delete_object(notch);
        // SetWindowRgn TAKES OWNERSHIP of `full` — must NOT delete it here.
        let r = set_window_rgn(hwnd, full, 1);
        crate::devlog!(info, "win32",
            "MPO poison: top-level fullscreen corner notch applied (SetWindowRgn rc={r})",
        );
    }
}

/// `true` when the resize computed an empty client rect — nothing to clip.
fn rect_is_empty(w: i32, h: i32) -> bool {
    w <= 0 || h <= 0
}

/// WINDOWED MPO poison on the MPV child (the swapchain-owning window). Splits
/// the child's visible region with a full-width 1px strip so its video plane
/// can't be a single hardware overlay → DWM composites → true black on the
/// QD-OLED. Gated to passthrough + windowed; clears the region otherwise.
/// The hole exposes the host window's black class brush → the artifact is a
/// 1px BLACK line near the top of the video, not a see-through gap.
unsafe fn apply_mpv_child_poison(child: *mut c_void, w: i32, h: i32) {
    let Ok(user32) = libloading::Library::new("user32.dll") else { return; };
    let Ok(set_window_rgn) = user32.get::<SetWindowRgnFn>(b"SetWindowRgn\0") else { return; };

    // Only the windowed-passthrough case needs it. Fullscreen is handled by
    // the top-level corner notch; SDR/off keeps the efficient scanout path.
    if !hdr_passthrough_active() || is_in_native_fullscreen() {
        set_window_rgn(child, std::ptr::null_mut(), 1);
        return;
    }

    let Ok(gdi32) = libloading::Library::new("gdi32.dll") else { return; };
    let Ok(create_rect_rgn) = gdi32.get::<CreateRectRgnFn>(b"CreateRectRgn\0") else { return; };
    let Ok(combine_rgn) = gdi32.get::<CombineRgnFn>(b"CombineRgn\0") else { return; };
    let Ok(delete_object) = gdi32.get::<DeleteObjectFn>(b"DeleteObject\0") else { return; };

    // Full child rect minus a FULL-WIDTH 1px strip. The strip must NOT be at
    // y=0 (that would just shrink the rect to y>=1 — still one rectangle the
    // driver inscribes); y=1 leaves the y=0 row above so the region is two
    // disconnected rectangles (non-promotable → composite). y=1 puts the
    // black line at the very top edge of the video, right under the title bar.
    const STRIP_Y: i32 = 1;
    let full = create_rect_rgn(0, 0, w, h);
    let strip = create_rect_rgn(0, STRIP_Y, w, STRIP_Y + 1);
    combine_rgn(full, full, strip, RGN_DIFF);
    delete_object(strip);
    let r = set_window_rgn(child, full, 1); // takes ownership of `full`
    crate::devlog!(info, "win32",
        "MPO poison: MPV child region applied {w}x{h} strip@{STRIP_Y} (SetWindowRgn rc={r})",
    );
}

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

        // 4. Move the window to fill the entire monitor.
        //    SWP_FRAMECHANGED is REQUIRED after a SetWindowLongPtr style
        //    change for Windows to re-evaluate the non-client area.
        //    Crucially we DO want activation here — Windows' "auto-hide
        //    taskbar in fullscreen" heuristic only kicks in for the
        //    foreground window, so dropping SWP_NOACTIVATE is necessary.
        //
        //    Z-order is HWND_TOP (foreground non-topmost), NOT
        //    HWND_TOPMOST. See the HWND_TOPMOST comment above for the
        //    full rationale — HWND_TOPMOST + WS_POPUP + monitor-rect
        //    triggers Windows' DWM exclusive-fullscreen optimisation,
        //    which breaks WebView2 transparency (UI vanishes),
        //    bypasses colour management (raw gamma), and forces a
        //    multi-monitor composition re-sort (black flashes).
        //    HWND_TOP keeps DWM composition engaged on our window so
        //    the transparent React overlay continues to render over
        //    the MPV child.
        //
        //    SWP_NOSENDCHANGING suppresses the WM_WINDOWPOSCHANGING
        //    broadcast that other top-level windows and shell extensions
        //    react to — reduces side-channel work during the flip.
        let r = set_window_pos(
            parent,
            HWND_TOP,
            m.left, m.top, w, h,
            SWP_FRAMECHANGED | SWP_NOSENDCHANGING,
        );
        if r == 0 {
            return Err("SetWindowPos failed".into());
        }

        // 4b. Belt-and-suspenders activation. Skipped when the parent
        //     window is already foreground — the typical case when the
        //     user clicks the fullscreen button in the player overlay
        //     (Aura already has focus). Redundant activation calls in
        //     that path were the dominant source of the multi-second
        //     fullscreen latency: each one synchronously waits for DWM
        //     to process the activation change. When Aura is NOT
        //     foreground (e.g. fullscreen toggled via a hotkey while
        //     another window was active), the activation IS necessary
        //     for Windows' fullscreen detection to fire.
        let get_foreground: Option<libloading::Symbol<GetForegroundWindowFn>> =
            user32.get(b"GetForegroundWindow\0").ok();
        let is_already_foreground = get_foreground
            .as_ref()
            .map(|f| f() == parent)
            .unwrap_or(false);
        if !is_already_foreground {
            if let Ok(bring_to_top) = user32.get::<BringWindowToTopFn>(b"BringWindowToTop\0") {
                let _ = bring_to_top(parent);
            }
            if let Ok(set_fg) = user32.get::<SetForegroundWindowFn>(b"SetForegroundWindow\0") {
                let _ = set_fg(parent);
            }
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

    // Re-assert the MPO poison (non-rectangular region) now that all
    // style / position changes have settled — the SetWindowPos with
    // SWP_FRAMECHANGED above can clear the window region. No-op unless
    // gated on.
    apply_mpo_poison(parent_hwnd);

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
        // every other app forever. SWP_NOSENDCHANGING mirrors the enter
        // path: suppresses the broadcast WM_WINDOWPOSCHANGING storm
        // that triggers DWM multi-monitor compositor re-sort on exit.
        let r = set_window_pos(
            parent,
            HWND_NOTOPMOST,
            x, y, w, h,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOSENDCHANGING,
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

    // Re-assert the MPO poison after the windowed-mode restore — the
    // SetWindowPos with SWP_FRAMECHANGED above can clear the window region.
    // No-op unless gated on.
    apply_mpo_poison(parent_hwnd);

    Ok(())
}

// ---------------------------------------------------------------------------
// Background-throttle immunity for the embedded MPV render loop
// ---------------------------------------------------------------------------
//
// libmpv runs INSIDE this process and renders into the embedded child
// window. When Aura is not the foreground window — the user alt-tabbed,
// or clicked a window on another monitor (Aura still fully visible, just
// unfocused, so this is NOT DWM occlusion throttling) — Windows applies
// two process-level throttles that wreck MPV's frame pacing:
//
//   1. The high-resolution multimedia timer is clamped back to the
//      default ~15.6 ms tick for non-foreground processes. MPV's
//      `video-sync=display-resample` path (interpolation ON) needs
//      sub-millisecond wakeups to hit every display refresh; 15.6 ms
//      scheduling granularity makes it miss refresh deadlines wholesale
//      → the reported 20-60 dropped fps. With interpolation OFF
//      (`video-sync=audio`) only whole frames jitter → the milder
//      6-8/sec the user also saw. This asymmetry is the fingerprint.
//   2. The foreground priority boost is gone, so the render/decode
//      threads get preempted harder and longer.
//
// Fix: pin a 1 ms timer resolution for the ENTIRE process lifetime
// (deliberately never paired with timeEndPeriod — the same lifetime
// hold mpv.exe / VLC / browsers use for video) and nudge the process
// priority class up one notch. Both are process-global and independent
// of focus, so playback stays smooth off-focus. Touches NO MPV property
// and NO window — clear of every MPV stability landmine in CLAUDE.md.
//
// Loaded via libloading to stay consistent with this module's stated
// "no windows-sys dep" approach (see the module header). winmm is
// intentionally leaked so the timeBeginPeriod request is never
// implicitly dropped by the Library handle closing.

type TimeBeginPeriodFn = unsafe extern "system" fn(u32) -> u32;
type GetCurrentProcessFn = unsafe extern "system" fn() -> *mut c_void;
type SetPriorityClassFn = unsafe extern "system" fn(*mut c_void, u32) -> i32;
type SetProcessInformationFn = unsafe extern "system" fn(
    handle: *mut c_void,
    info_class: i32,
    info: *mut c_void,
    size: u32,
) -> i32;

/// `ABOVE_NORMAL_PRIORITY_CLASS`. Deliberately NOT `HIGH_PRIORITY_CLASS`
/// (0x80) — HIGH can starve the audio service / DWM compositor and cause
/// its own stutter. ABOVE_NORMAL restores the scheduling headroom lost
/// when the foreground boost disappears, without that risk.
const ABOVE_NORMAL_PRIORITY_CLASS: u32 = 0x0000_8000;

/// `PROCESS_INFORMATION_CLASS::ProcessPowerThrottling` discriminant.
/// Used with `SetProcessInformation` to opt out of Windows 11 EcoQoS
/// background CPU throttling — without this, the OS may drop our
/// process to the "efficiency core" power state when minimised /
/// occluded / generally background, even with `ABOVE_NORMAL_PRIORITY_CLASS`
/// set. Discord / Slack / OBS / video editors all do this.
const PROCESS_POWER_THROTTLING: i32 = 4;
/// Wire format version for `PROCESS_POWER_THROTTLING_STATE`.
const PROCESS_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
/// Bit in `ControlMask` / `StateMask` corresponding to the execution-
/// speed throttling axis (EcoQoS). Setting it in `ControlMask` says
/// "we are managing this knob"; clearing it in `StateMask` says
/// "don't throttle me".
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;

#[repr(C)]
struct ProcessPowerThrottlingState {
    version: u32,
    control_mask: u32,
    state_mask: u32,
}

/// Make the process immune to Windows background timer/priority
/// throttling so the embedded MPV render loop keeps pace when Aura is
/// not the foreground window. Call once, early, at startup. A second
/// call is harmless (timeBeginPeriod ref-counts; we never balance it —
/// intended) but unnecessary.
pub fn pin_process_scheduling() {
    unsafe {
        // 1 ms timer resolution, held for the whole process lifetime.
        match libloading::Library::new("winmm.dll") {
            Ok(winmm) => {
                match winmm.get::<TimeBeginPeriodFn>(b"timeBeginPeriod\0") {
                    Ok(time_begin_period) => {
                        let r = time_begin_period(1);
                        crate::devlog!(info, "win32",
                            "timeBeginPeriod(1) → {} (0 = TIMERR_NOERROR); \
                             held for process lifetime", r);
                    }
                    Err(e) => crate::devlog!(warn, "win32",
                        "winmm!timeBeginPeriod unavailable: {} — off-focus \
                         frame pacing NOT hardened", e),
                }
                // Never unload winmm: dropping the Library closes our
                // module handle. forget() keeps it resident so the timer
                // request is unambiguously lifetime-scoped.
                std::mem::forget(winmm);
            }
            Err(e) => crate::devlog!(warn, "win32",
                "winmm.dll load failed: {} — off-focus frame pacing NOT \
                 hardened", e),
        }

        // Nudge the process priority class up one notch AND opt out of
        // Windows-11 EcoQoS background-execution throttling. The latter
        // is the documented cause of post-2021 "background apps drop
        // frames even with ABOVE_NORMAL priority" behaviour: when the
        // OS decides our process is background-ish (minimised, behind
        // another foreground window, etc.) it can drop the process to
        // efficiency-core power state independent of priority class.
        // SetProcessInformation(ProcessPowerThrottling) with
        // ControlMask = EXECUTION_SPEED and StateMask = 0 means
        // "I'm managing this; do NOT throttle me". Discord, Slack, OBS,
        // and pretty much every real-time Windows app does this.
        match libloading::Library::new("kernel32.dll") {
            Ok(kernel32) => {
                let get_cur =
                    kernel32.get::<GetCurrentProcessFn>(b"GetCurrentProcess\0");
                let set_pc =
                    kernel32.get::<SetPriorityClassFn>(b"SetPriorityClass\0");
                if let (Ok(get_current_process), Ok(set_priority_class)) =
                    (&get_cur, &set_pc)
                {
                    let ok = set_priority_class(
                        get_current_process(),
                        ABOVE_NORMAL_PRIORITY_CLASS,
                    );
                    crate::devlog!(info, "win32",
                        "SetPriorityClass(ABOVE_NORMAL) → {} (nonzero = ok)",
                        ok);
                } else {
                    crate::devlog!(warn, "win32",
                        "kernel32 priority symbols unavailable; priority \
                         class left at OS default");
                }

                // EcoQoS opt-out. `SetProcessInformation` was added in
                // Windows 8 (the function), but the
                // `ProcessPowerThrottling` info class is Windows 11+ —
                // pre-Win11 calls return ERROR_INVALID_PARAMETER, which
                // is benign (the throttling behaviour we're opting out
                // of didn't exist on those builds either).
                let set_pi = kernel32
                    .get::<SetProcessInformationFn>(b"SetProcessInformation\0");
                if let (Ok(get_current_process), Ok(set_process_information)) =
                    (&get_cur, &set_pi)
                {
                    let mut state = ProcessPowerThrottlingState {
                        version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
                        control_mask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
                        state_mask: 0, // 0 = "don't throttle"
                    };
                    let ok = set_process_information(
                        get_current_process(),
                        PROCESS_POWER_THROTTLING,
                        &mut state as *mut _ as *mut c_void,
                        std::mem::size_of::<ProcessPowerThrottlingState>() as u32,
                    );
                    crate::devlog!(info, "win32",
                        "SetProcessInformation(EcoQoS disable) → {} \
                         (nonzero = ok; 0 on Win10 / WinServer 2019 is benign)",
                        ok);
                } else {
                    crate::devlog!(warn, "win32",
                        "kernel32!SetProcessInformation unavailable — \
                         Win11 EcoQoS background throttling NOT disabled, \
                         off-focus playback may drop frames");
                }
            }
            Err(e) => crate::devlog!(warn, "win32",
                "kernel32.dll load failed: {} — priority class left at OS \
                 default", e),
        }
    }
}

