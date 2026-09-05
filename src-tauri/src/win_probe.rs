// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! win_probe - restore-latency instrument. Dev builds only, and opt-in even
//! there: `AURA_WIN_PROBE=1 pnpm tauri dev`. See `enabled()`.
//!
//! Why it exists: restoring Aura from the taskbar or the tray looks sudden,
//! and the measured reason is that Aura's content lands AFTER the OS restore
//! animation has finished. A cross-process `ShowWindow(SW_RESTORE)` is an
//! inter-thread send, so it returns only once the owning thread has drained
//! the resulting message burst; that block is therefore a direct measure of
//! how late Aura is. Full write-up, including the four hypotheses that were
//! refuted by A/B rather than by argument, in
//! `docs/research/2026-09-03-restore-animation.md`.
//!
//! The measurement has to sit at the wndproc, below tao and below Tauri's
//! window-event callback, or it cannot see where the time goes.
//! `SetWindowSubclass` puts us there: our proc runs first and times the
//! `DefSubclassProc` call, which is the ENTIRE rest of the chain (tao's
//! wndproc, the Tauri event callback it dispatches, then DefWindowProc).
//!
//! Two outputs, both under the `wintiming` devlog label:
//!   * per-message, any single message whose downstream handling took
//!     >= `SLOW_MSG_MS`. Names a single hotspot if there is one.
//!   * a burst summary: consecutive messages separated by less than
//!     `BURST_GAP` are one burst, reported as busy-time over wall-time. Catches
//!     the case where the cost is spread over many small messages instead.
//!
//! WHAT IT FOUND (2026-09-03, and the reason not to re-derive this by hand).
//! Over a driven minimize/restore cycle, SW_RESTORE blocked the caller for
//! 98.0 ms avg on a release build and 111.2 ms on a dev build, against 61.6 ms
//! for Firefox, 50.9 ms for Spotify and 7.1 ms for an opaque native window
//! (Telegram) on the same machine in the same session. Inside that:
//!
//!   * Aura's own Tauri window-event callback costs 0.0 - 0.8 ms. It is not
//!     the problem, and the `save_window_state` disk write it can trigger
//!     fired on one restore out of six and cost 0.8 ms. That hypothesis is
//!     DEAD; do not go looking there again.
//!   * the whole wndproc chain is busy 38 - 41 ms over ~14 messages,
//!     dominated by the top-level WM_PAINT (25.7 - 28.7 ms) with WM_SIZE and
//!     WM_WINDOWPOSCHANGED around 5 ms each.
//!   * the remaining ~60 ms is GAPS between messages, i.e. win32k and DWM,
//!     with no Aura frame on the stack at all.
//!
//! So there is no hotspot in Aura to delete. The cost is the transparent
//! WebView2 top-level itself - the same architecture that lets the mpv child
//! show through, and the same reason the animation has nothing to draw.
//!
//! Caveat when reading the numbers: the devlog emit runs inside the wndproc,
//! so a burst that logs is slightly slower than the same burst unobserved. The
//! DefSubclassProc timings are taken before any logging and are clean; only
//! the wall-time figure carries the probe's own overhead.

use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

/// Log any individual message whose downstream handling took at least this.
const SLOW_MSG_MS: f64 = 4.0;

/// Messages closer together than this belong to the same burst.
const BURST_GAP: Duration = Duration::from_millis(200);

/// Only report a burst that actually cost something; an idle app produces a
/// steady trickle of timers and mouse moves and we do not want those lines.
const BURST_REPORT_MS: f64 = 15.0;

/// Force a burst report once it has been open this long even if no quiet gap
/// has arrived yet, so a restore that is not followed by further input still
/// gets summarised.
const BURST_MAX_OPEN: Duration = Duration::from_millis(400);

/// Subclass id. Arbitrary, just has to be unique per (hwnd, proc) pair.
const SUBCLASS_ID: usize = 0xA0_9A_71;

/// Opt-in, because the probe is chatty: it reports on ordinary
/// drag-resizes too, and an always-on instrument would bury the labels
/// people actually read in the dev terminal. Run
/// `AURA_WIN_PROBE=1 pnpm tauri dev` to arm it.
pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("AURA_WIN_PROBE").is_some())
}

#[derive(Default)]
struct Burst {
    start: Option<Instant>,
    last_end: Option<Instant>,
    busy: Duration,
    count: u32,
    reported: bool,
    /// (message id, ms) for the worst offenders, capped so a pathological
    /// burst cannot grow this without bound.
    slow: Vec<(u32, f64)>,
}

thread_local! {
    /// The wndproc is single-threaded by definition (messages are delivered to
    /// the thread that created the window), so a thread-local needs no lock.
    static BURST: RefCell<Burst> = RefCell::new(Burst::default());
    /// Re-entrancy guard. A devlog emit can pump messages; without this a
    /// nested wndproc would report bursts from inside a burst report.
    static LOGGING: Cell<bool> = const { Cell::new(false) };
}

/// Install the probe on `hwnd`. Must be called from the thread that owns the
/// window (Tauri's `setup` runs on it). Idempotent per subclass id.
pub fn install(hwnd: isize) {
    if !enabled() {
        return;
    }
    let ok = unsafe {
        SetWindowSubclass(
            HWND(hwnd as *mut core::ffi::c_void),
            Some(subclass_proc),
            SUBCLASS_ID,
            0,
        )
    };
    crate::devlog!(
        info,
        "wintiming",
        "restore-latency probe {} on hwnd {hwnd:#x} (dev build only)",
        if ok.as_bool() { "installed" } else { "FAILED to install" },
    );
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _ref_data: usize,
) -> LRESULT {
    let entered = Instant::now();

    // Close out the previous burst BEFORE handling this message, so the report
    // is not itself counted as part of the burst it describes.
    let pending = BURST.with(|b| {
        let mut b = b.borrow_mut();
        let gap_ended = b
            .last_end
            .is_some_and(|end| entered.duration_since(end) >= BURST_GAP);
        if gap_ended {
            let out = take_report(&mut b);
            *b = Burst::default();
            out
        } else {
            None
        }
    });
    emit_report(pending);

    // The whole rest of the chain: tao's wndproc, which is what dispatches
    // Tauri's window-event callback, then DefWindowProc.
    let call_start = Instant::now();
    let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    let elapsed = call_start.elapsed();
    let ended = Instant::now();
    let ms = elapsed.as_secs_f64() * 1000.0;

    let (slow_line, forced) = BURST.with(|b| {
        let mut b = b.borrow_mut();
        b.start.get_or_insert(call_start);
        b.busy += elapsed;
        b.count += 1;
        b.last_end = Some(ended);
        if ms >= SLOW_MSG_MS && b.slow.len() < 16 {
            b.slow.push((msg, ms));
        }
        let slow_line = (ms >= SLOW_MSG_MS)
            .then(|| format!("{} ({msg:#06x}) handled in {ms:.1} ms", msg_name(msg)));
        // A restore may be the last thing that happens for a while. Report on
        // a long-open burst rather than waiting for a quiet gap that may not
        // come until the user moves the mouse.
        let open_long = b
            .start
            .is_some_and(|s| ended.duration_since(s) >= BURST_MAX_OPEN);
        let forced = if !b.reported && open_long {
            b.reported = true;
            take_report(&mut b)
        } else {
            None
        };
        (slow_line, forced)
    });

    if let Some(line) = slow_line {
        log_guarded(|| crate::devlog!(warn, "wintiming", "{}", line));
    }
    emit_report(forced);

    result
}

/// Render a burst into a report line, or `None` if it is not worth a line.
fn take_report(b: &mut Burst) -> Option<String> {
    let busy_ms = b.busy.as_secs_f64() * 1000.0;
    if busy_ms < BURST_REPORT_MS {
        return None;
    }
    let wall_ms = match (b.start, b.last_end) {
        (Some(s), Some(e)) => e.duration_since(s).as_secs_f64() * 1000.0,
        _ => busy_ms,
    };
    b.slow
        .sort_by(|a, c| c.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let worst = b
        .slow
        .iter()
        .take(4)
        .map(|(m, ms)| format!("{} {ms:.1}", msg_name(*m)))
        .collect::<Vec<_>>()
        .join(", ");
    let tail = if worst.is_empty() {
        String::new()
    } else {
        format!(" | slowest: {worst}")
    };
    Some(format!(
        "burst: {} msgs, {busy_ms:.1} ms busy over {wall_ms:.1} ms wall{tail}",
        b.count,
    ))
}

fn emit_report(line: Option<String>) {
    if let Some(line) = line {
        log_guarded(|| crate::devlog!(warn, "wintiming", "{}", line));
    }
}

/// Run a logging closure unless we are already inside one on this thread.
fn log_guarded(f: impl FnOnce()) {
    LOGGING.with(|g| {
        if g.get() {
            return;
        }
        g.set(true);
        f();
        g.set(false);
    });
}

/// Names for the messages that actually show up in a show/hide/resize burst.
/// Anything else prints as its hex id, which is enough to look up.
fn msg_name(msg: u32) -> &'static str {
    match msg {
        0x0003 => "WM_MOVE",
        0x0005 => "WM_SIZE",
        0x0006 => "WM_ACTIVATE",
        0x0007 => "WM_SETFOCUS",
        0x0008 => "WM_KILLFOCUS",
        0x000B => "WM_SETREDRAW",
        0x000F => "WM_PAINT",
        0x0014 => "WM_ERASEBKGND",
        0x0018 => "WM_SHOWWINDOW",
        0x001C => "WM_ACTIVATEAPP",
        0x0024 => "WM_GETMINMAXINFO",
        0x0046 => "WM_WINDOWPOSCHANGING",
        0x0047 => "WM_WINDOWPOSCHANGED",
        0x007E => "WM_DISPLAYCHANGE",
        0x0083 => "WM_NCCALCSIZE",
        0x0085 => "WM_NCPAINT",
        0x0086 => "WM_NCACTIVATE",
        0x0112 => "WM_SYSCOMMAND",
        0x0113 => "WM_TIMER",
        0x0215 => "WM_CAPTURECHANGED",
        0x0231 => "WM_ENTERSIZEMOVE",
        0x0232 => "WM_EXITSIZEMOVE",
        0x02E0 => "WM_DPICHANGED",
        0x031E => "WM_DWMCOMPOSITIONCHANGED",
        _ => "msg",
    }
}
