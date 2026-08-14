// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! devlog — minimal log shim that re-emits messages as Tauri events so the
//! frontend DevConsole can render them.
//!
//! Call sites use the `devlog!(level, source, "msg {x}")` macro. The module
//! captures the AppHandle once during setup so calls anywhere in the codebase
//! can emit events back to the webview. Stderr is mirrored — useful when the
//! webview isn't loaded or the DevConsole isn't open.

use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Capture the AppHandle once during setup. Subsequent calls are no-ops.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

#[derive(Serialize, Clone)]
pub struct DevLogEvent {
    pub level: &'static str,    // "trace" | "debug" | "info" | "warn" | "error"
    pub source: &'static str,   // module name
    pub message: String,
    pub ts: u128,
}

/// Send a structured log entry to the frontend. Best-effort.
pub fn log(level: &'static str, source: &'static str, message: impl Into<String>) {
    let msg = message.into();
    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    // Format the wall-clock time as HH:MM:SS.mmm in local time so the
    // dev terminal log lines are useful for correlating with user
    // actions / external service traffic. The in-app DevConsole has its
    // own timestamp column so we don't include one in the JSON payload
    // beyond the unix-ms `ts` field.
    eprintln!("[{}][{level}][{source}] {msg}", format_local_hms(ts_ms));

    if let Some(app) = APP.get() {
        let event = DevLogEvent {
            level,
            source,
            message: msg,
            ts: ts_ms,
        };
        let _ = app.emit("dev-log", event);
    }
}

/// Format a unix-ms timestamp as `HH:MM:SS.mmm` in the system's LOCAL
/// timezone. We avoid pulling `chrono` for one print line — derive the
/// local offset by diffing the local "now" components from the UTC
/// "now" components via the libc time API.
fn format_local_hms(unix_ms: u128) -> String {
    let secs_total = (unix_ms / 1000) as u64;
    let ms = (unix_ms % 1000) as u32;

    // Local time: use the platform's `localtime` via the time crate's
    // surrogate, but we don't have time crate. Instead, compute via
    // SystemTime → seconds, then approximate UTC, and use the OS local
    // offset.
    let local_secs = secs_total.saturating_add(cached_local_offset_seconds(secs_total));
    let secs_in_day = local_secs % 86400;
    let h = (secs_in_day / 3600) % 24;
    let m = (secs_in_day / 60) % 60;
    let s = secs_in_day % 60;
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

/// The offset, memoised, re-probed at most every `TZ_REPROBE_SECS`.
///
/// The uncached version below does a full LoadLibrary + GetProcAddress +
/// FreeLibrary of kernel32 on Windows, and it sat on the formatting path of
/// EVERY log line. That is a large fixed cost per line, and it is what made an
/// over-chatty log expensive rather than merely noisy.
///
/// Re-probed rather than computed once because Aura is a long-running app and a
/// DST transition mid-session would otherwise leave every subsequent timestamp
/// an hour out until restart. Ten minutes bounds that error to ten minutes while
/// still removing essentially all of the calls.
const TZ_REPROBE_SECS: u64 = 600;
/// (offset_seconds, unix_seconds_when_probed), packed so one atomic covers both
/// and no lock sits on the logging path.
static TZ_CACHE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

fn cached_local_offset_seconds(now_secs: u64) -> u64 {
    use std::sync::atomic::Ordering;
    let packed = TZ_CACHE.load(Ordering::Relaxed);
    if packed != u64::MAX {
        let probed_at = packed >> 20;
        let offset = packed & 0xF_FFFF;
        if now_secs.saturating_sub(probed_at) < TZ_REPROBE_SECS {
            return offset;
        }
    }
    let offset = local_offset_seconds();
    // Offsets are seconds-of-day (< 86400), so 20 bits hold one comfortably and
    // the remaining 44 hold a unix timestamp well past any plausible lifetime.
    TZ_CACHE.store((now_secs << 20) | (offset & 0xF_FFFF), Ordering::Relaxed);
    offset
}

/// Best-effort local-timezone offset (seconds east of UTC). On Windows we
/// query GetTimeZoneInformation; on Unix we use `localtime_r`. Falls back
/// to 0 (UTC) if the platform call fails — log timestamps will then be
/// in UTC, which is still useful relative-to-each-other.
///
/// Call `cached_local_offset_seconds` instead: this one is expensive.
#[cfg(target_os = "windows")]
fn local_offset_seconds() -> u64 {
    // GetTimeZoneInformation returns Bias in MINUTES, where local = UTC - Bias.
    // We want offset east of UTC, so it's -Bias (in seconds).
    #[repr(C)]
    #[derive(Default)]
    struct SystemTimeRec {
        year: u16, month: u16, day_of_week: u16, day: u16,
        hour: u16, minute: u16, second: u16, millis: u16,
    }
    #[repr(C)]
    #[derive(Default)]
    struct TzInfo {
        bias: i32,
        std_name: [u16; 32],
        std_date: SystemTimeRec,
        std_bias: i32,
        dlt_name: [u16; 32],
        dlt_date: SystemTimeRec,
        dlt_bias: i32,
    }
    type GetTzInfoFn = unsafe extern "system" fn(*mut TzInfo) -> u32;

    unsafe {
        let kernel32 = match libloading::Library::new("kernel32.dll") {
            Ok(lib) => lib,
            Err(_) => return 0,
        };
        let get_tz: libloading::Symbol<GetTzInfoFn> =
            match kernel32.get(b"GetTimeZoneInformation\0") {
                Ok(s) => s,
                Err(_) => return 0,
            };
        let mut tz = TzInfo::default();
        let id = get_tz(&mut tz);
        // ID: 0=unknown, 1=standard, 2=daylight
        let total_bias_min = tz.bias + match id {
            1 => tz.std_bias,
            2 => tz.dlt_bias,
            _ => 0,
        };
        // local = UTC - bias  →  offset_east = -bias (in minutes)
        let offset_min = -total_bias_min;
        if offset_min < 0 {
            // Negative offset (west of UTC) — represent by adding (24h - |offset|)
            // since we're working in unsigned seconds-of-day arithmetic.
            ((24 * 60 + offset_min) as u64) * 60
        } else {
            (offset_min as u64) * 60
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn local_offset_seconds() -> u64 {
    // Cross-platform fallback: stay in UTC for non-Windows builds.
    // (Aura is Windows-only in practice; macOS/Linux can extend if needed.)
    0
}

#[macro_export]
macro_rules! devlog {
    (info,  $src:expr, $($arg:tt)*) => { $crate::devlog::log("info",  $src, format!($($arg)*)) };
    (warn,  $src:expr, $($arg:tt)*) => { $crate::devlog::log("warn",  $src, format!($($arg)*)) };
    (error, $src:expr, $($arg:tt)*) => { $crate::devlog::log("error", $src, format!($($arg)*)) };
    (debug, $src:expr, $($arg:tt)*) => { $crate::devlog::log("debug", $src, format!($($arg)*)) };
    (trace, $src:expr, $($arg:tt)*) => { $crate::devlog::log("trace", $src, format!($($arg)*)) };
}
