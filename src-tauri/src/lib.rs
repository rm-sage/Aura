// Aura — Tauri 2 + libmpv desktop media player.
// Copyright (C) 2026 rm-sage
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Contact:
//   Electronic mail: contact@animasec.dev
//   Postal mail:     <intentionally omitted>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

mod addons;
mod aniskip;
mod auth;
mod backup;
mod cinema;
mod crash_reporting;
mod devlog;
mod anime_id_map;
mod api_keyring;
mod media_controls;
mod omdb;
mod player;
mod ratings;
mod scrobble;
mod scrobble_anilist;
mod scrobble_auth;
mod per_title;
mod settings;
mod silencedetect;
mod stats;
mod storage;
mod streaming;
mod stremio;
mod subtitles;
mod sync;
mod tray;
#[cfg(target_os = "windows")]
mod win32;
mod window_logic;

use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_libmpv::MpvExt;

// ---------------------------------------------------------------------------
// Bridge subprocess handle. Stored here (not in `streaming.rs`) because
// it depends on `std::process::Child` and is shutdown-coordinated from
// the same place that handles graceful exit. `OnceLock<Mutex<...>>` so
// the spawn path can register the handle from `setup` and the
// shutdown path can take it from anywhere.
// ---------------------------------------------------------------------------

static BRIDGE_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();

fn bridge_child_slot() -> &'static Mutex<Option<std::process::Child>> {
    BRIDGE_CHILD.get_or_init(|| Mutex::new(None))
}

/// Walk a small candidate list trying to find the aura-bridge binary,
/// then spawn it as a detached subprocess. Failure is logged and
/// silenced — HTTPS streams keep working without the bridge, only
/// plain-HTTP streams need it.
fn spawn_bridge_subprocess() {
    let candidates = bridge_candidate_paths();
    let mut chosen: Option<std::path::PathBuf> = None;
    for c in &candidates {
        if c.exists() {
            chosen = Some(c.clone());
            break;
        }
    }
    let Some(path) = chosen else {
        crate::devlog!(
            warn, "bridge",
            "aura-bridge binary not found alongside the Aura executable; plain-HTTP stream proxying is disabled. HTTPS streams continue to work as normal (they bypass the bridge entirely)."
        );
        return;
    };

    crate::devlog!(info, "bridge", "spawning bridge subprocess: {}", path.display());
    let mut cmd = std::process::Command::new(&path);
    // Detach stdio. The bridge's println/eprintln output isn't
    // piped back to the parent — if you need it, change these to
    // .piped() and read in a background thread.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        // Suppress the bridge's console window when launched from a
        // GUI-built Aura. CREATE_NO_WINDOW = 0x08000000.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.spawn() {
        Ok(child) => {
            #[cfg(target_os = "windows")]
            attach_child_to_kill_on_close_job(&child);
            *bridge_child_slot().lock().unwrap() = Some(child);
            crate::devlog!(info, "bridge", "bridge subprocess running");
        }
        Err(e) => {
            crate::devlog!(warn, "bridge", "spawn failed: {}", e);
        }
    }
}

/// Attach the spawned bridge child to a Win32 Job Object configured with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When Aura's process handle
/// closes — including a hard crash, taskkill, or the debugger detaching
/// without a graceful shutdown — Windows automatically terminates every
/// process in the job. Without this, an orphaned `aura-bridge.exe`
/// keeps `target/debug/` files mapped, blocking the next `pnpm tauri
/// dev` build with `Os { code: 5, kind: PermissionDenied }` from
/// `tauri-build`.
///
/// The job handle is intentionally leaked for the lifetime of the
/// process; closing it would trigger the kill before Aura itself
/// exits. Windows reclaims the handle on process termination.
///
/// Implemented with raw FFI declarations rather than the `windows`
/// crate so we don't have to carry an extra feature gate.
#[cfg(target_os = "windows")]
fn attach_child_to_kill_on_close_job(child: &std::process::Child) {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;

    type HANDLE = *mut c_void;
    type BOOL = i32;

    // JOBOBJECT_BASIC_LIMIT_INFORMATION + JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    // shapes mirror winnt.h. We only set `LimitFlags`; the rest stay zeroed.
    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_op_count: u64,
        write_op_count: u64,
        other_op_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOBOBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> HANDLE;
        fn SetInformationJobObject(
            h_job: HANDLE,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> BOOL;
        fn AssignProcessToJobObject(h_job: HANDLE, h_process: HANDLE) -> BOOL;
    }

    static JOB: OnceLock<usize> = OnceLock::new();
    let job_raw = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            crate::devlog!(warn, "bridge", "CreateJobObjectW failed — orphan-on-crash protection disabled");
            return 0_usize;
        }
        let info = ExtendedLimit {
            basic: BasicLimit {
                limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..Default::default()
            },
            ..Default::default()
        };
        if SetInformationJobObject(
            job,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            &info as *const _ as *const c_void,
            std::mem::size_of::<ExtendedLimit>() as u32,
        ) == 0
        {
            crate::devlog!(warn, "bridge", "SetInformationJobObject failed — orphan-on-crash protection disabled");
            return 0_usize;
        }
        job as usize
    });
    if job_raw == 0 {
        return;
    }
    let job = job_raw as HANDLE;
    let proc = child.as_raw_handle() as HANDLE;
    if unsafe { AssignProcessToJobObject(job, proc) } == 0 {
        crate::devlog!(warn, "bridge", "AssignProcessToJobObject failed — bridge may orphan on crash");
    } else {
        crate::devlog!(info, "bridge", "bridge attached to kill-on-close job (orphan-proof)");
    }
}

/// Candidate paths to try, in priority order:
///   1. `<exe_dir>/aura-bridge[.exe]` — sidecar deployment
///   2. `<exe_dir>/../aura-bridge[.exe]`               — one dir up
///
/// Only the first candidate matches the production layout (the bridge
/// binary sits next to Aura's own .exe). The second covers a fallback
/// where a packager might place it one level up. Both are anchored at
/// the running exe so they don't leak any hint about source locations.
fn bridge_candidate_paths() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let bin_name = if cfg!(target_os = "windows") { "aura-bridge.exe" } else { "aura-bridge" };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(bin_name));
            if let Some(parent) = dir.parent() {
                out.push(parent.join(bin_name));
            }
        }
    }
    out
}

/// Kill the bridge subprocess if it's running. Called from the
/// shutdown path when the main window closes.
pub fn shutdown_bridge_subprocess() {
    if let Some(mut child) = bridge_child_slot().lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        crate::devlog!(info, "bridge", "bridge subprocess shut down");
    }
}

// ---------------------------------------------------------------------------
// Shared playback state (updated by the mpv-event-main observer bridge)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct PlaybackState {
    time: f64,
    duration: f64,
    paused: bool,
    /// Current MPV volume (0..100). Wired so the slider stays in sync when
    /// other code paths (volume keybindings, OS media keys) change it.
    volume: f64,
    /// Playback speed multiplier (e.g. 1.0, 1.5, 2.0).
    speed: f64,
    /// True while MPV is filling its cache from the network. Drives the
    /// buffering animation in the player overlay.
    buffering: bool,
    /// True when playback has hit the end of the file.
    eof: bool,
}

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            time: 0.0,
            duration: 0.0,
            paused: true,
            // Match init_mpv's `volume=50` so the first emitted snapshot
            // (if any property event with data fires before the actual
            // volume read settles) shows 50, not 0.
            volume: 50.0,
            speed: 1.0,
            buffering: false,
            eof: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn load_video(
    app: tauri::AppHandle,
    path: String,
    // Optional resume position in seconds. When set, the loadfile
    // command passes `start=X` as an MPV option so playback begins at
    // that offset without a separate seek round-trip. Drives the
    // resume-from-progress prompt: when the user picks "Resume" the
    // frontend hands over the saved state.timeOffset; "Start over"
    // omits the field (Tauri maps undefined / missing → None). None
    // / 0 / NaN all mean "play from the beginning" — matches the
    // previous behaviour.
    start_seconds: Option<f64>,
) -> Result<(), String> {
    let normalised = path.replace('\\', "/");
    crate::devlog!(
        info, "player",
        "load_video: {normalised} (start={:?})",
        start_seconds,
    );
    let t_start = std::time::Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        // Defensive re-init: if the MPV instance has been destroyed for any
        // reason (e.g. a previous error path called destroy and the process
        // is still alive thanks to the tray icon), `init_mpv` is a no-op
        // when the instance already exists, so it's safe to call here.
        let t_init = std::time::Instant::now();
        if let Err(e) = player::init_mpv(&app) {
            crate::devlog!(warn, "player", "load_video pre-init failed: {e}");
        }
        crate::devlog!(
            info, "player",
            "load_video step: init_mpv done at +{}ms",
            t_init.elapsed().as_millis(),
        );
        let mpv = app.mpv();
        // Force unpause BEFORE loadfile so an inherited pause flag from
        // a previous file doesn't carry over and require a manual click.
        let _ = mpv.set_property("pause", &serde_json::json!(false), "main");

        // Build the loadfile arg list. The 4th positional arg is a
        // KEY=VALUE option string that mpv applies to the loaded file
        // for the duration of this playback (no global state mutation).
        // We use `start=X` to seek to the resume offset atomically with
        // the load — vs. a post-load seek_absolute which would briefly
        // play frames from t=0 and then jump.
        let t_load = std::time::Instant::now();
        let mut args: Vec<serde_json::Value> = vec![
            serde_json::json!(normalised),
            serde_json::json!("replace"),
        ];
        if let Some(t) = start_seconds.filter(|v| v.is_finite() && *v > 0.0) {
            // mpv accepts `start=12.34` (seconds) directly. The 3rd
            // positional arg `0` is the file index — required to be
            // present when we want to pass an options string in the
            // 4th slot, even on a single-file load.
            //
            // Clamp to 7 days and force fixed (non-scientific) notation.
            // is_finite filters NaN/inf, but extreme magnitudes
            // (1e308, etc.) print as `1e308` which mpv's option parser
            // rejects, propagating as a hard loadfile error rather than
            // a graceful resume failure. A corrupted library row is
            // the realistic source. 7 days * 86400 covers every
            // plausible media duration.
            let clamped = t.min(86_400.0 * 7.0);
            args.push(serde_json::json!(0));
            args.push(serde_json::json!(format!("start={clamped:.3}")));
        }
        mpv.command("loadfile", &args, "main")
            .map_err(|e| e.to_string())?;
        crate::devlog!(
            info, "player",
            "load_video step: loadfile accepted at +{}ms (mpv command returned)",
            t_load.elapsed().as_millis(),
        );

        // Belt-and-suspenders: clear pause again right after issuing the
        // loadfile, since some MPV builds reset the pause flag during
        // the demuxer init.
        let _ = mpv.set_property("pause", &serde_json::json!(false), "main");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map(|()| {
        crate::devlog!(
            info, "player",
            "load_video total: {}ms (Tauri command boundary → JS)",
            t_start.elapsed().as_millis(),
        );
    })
}

#[tauri::command]
async fn stop_video(app: tauri::AppHandle) -> Result<(), String> {
    crate::devlog!(info, "player", "stop_video");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command("stop", &Vec::<serde_json::Value>::new(), "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn toggle_pause(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command("cycle", &vec![serde_json::json!("pause")], "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn seek_relative(app: tauri::AppHandle, seconds: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "seek",
                &vec![serde_json::json!(seconds), serde_json::json!("relative")],
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Step exactly one frame forward (`forward = true`) or backward
/// (`forward = false`) and pause. Wraps MPV's `frame-step` /
/// `frame-back-step` commands. `frame-back-step` is somewhat slow per
/// MPV's docs (the demuxer has to seek and decode forward to the
/// previous frame) but is precise enough for the muscle-memory `,` / `.`
/// shortcut anime fans expect from VLC / standalone mpv. Issued as a
/// plain command without args — no property poll, so the libmpv state-
/// transition landmines (CLAUDE.md #3) don't apply here.
#[tauri::command]
async fn frame_step(app: tauri::AppHandle, forward: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cmd = if forward { "frame-step" } else { "frame-back-step" };
        app.mpv()
            .command(cmd, &vec![], "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toggle EBU R128 loudness normalization on the audio filter chain.
/// When enabled, audio is levelled to −23 LUFS (broadcast standard)
/// with a true-peak ceiling of −2 dBTP and a 7 LU loudness range —
/// flattens the volume disparity between streams from different
/// sources without crushing dynamics.
///
/// Implementation notes (from a stream-silencing regression):
///   • Use `change-list af toggle @loudnorm:loudnorm=…` instead of
///     `set af "…"`. The latter REPLACES the entire filter graph
///     in-place during playback, which on this libmpv build re-inits
///     the audio output and frequently leaves it muted or with no
///     track selected (the filter graph rebuilds before the aid
///     dispatch can reattach). `change-list … toggle` does an
///     incremental graph mutation that keeps the audio chain hot.
///   • Drop `dynamic=true` — not a documented loudnorm parameter; the
///     filter still initialises but the unknown option may push the
///     graph into a degraded state where output samples don't reach
///     the audio device. The base `I/LRA/TP` triple is sufficient.
///   • The `@loudnorm` label prefix is the change-list selector — if
///     it's already in the chain, toggle removes it; if it's absent,
///     toggle adds it. Idempotent regardless of caller state.
///
/// Soft no-op when audio passthrough is on (bitstream output bypasses
/// the filter graph entirely). The UI prevents this at the toggle
/// level but the Rust side is the source of truth — defence in depth.
#[tauri::command]
async fn set_audio_loudnorm(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::devlog!(info, "player", "set_audio_loudnorm(enabled={enabled})");
    tauri::async_runtime::spawn_blocking(move || {
        let mpv = app.mpv();
        // Always remove first so repeat calls don't stack duplicate
        // labelled filters (App.tsx re-fires this on every load_video
        // to honor the persisted setting). `remove` is a no-op when
        // the label isn't present; ignore its error.
        let _ = mpv.command(
            "af",
            &vec![serde_json::json!("remove"), serde_json::json!("@loudnorm")],
            "main",
        );
        if !enabled {
            return Ok(());
        }
        // Add the labelled loudnorm filter. The `@loudnorm` label is
        // the handle we use to remove it later.
        mpv.command(
            "af",
            &vec![
                serde_json::json!("add"),
                serde_json::json!("@loudnorm:loudnorm=I=-23:LRA=7:TP=-2"),
            ],
            "main",
        )
        .map_err(|e| {
            crate::devlog!(warn, "player", "set_audio_loudnorm failed: {e}");
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_volume(app: tauri::AppHandle, volume: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_volume({volume})");
    tauri::async_runtime::spawn_blocking(move || {
        // Use the dedicated set_property FFI path — going through the
        // generic `command("set_property", [name, value])` route silently
        // succeeds in some libmpv builds without actually changing the
        // property (manifests as "slider snaps back to old value").
        app.mpv()
            .set_property("volume", &serde_json::json!(volume), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_volume failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Generic property reader — used by the React side as a polling fallback
/// when MPV's observe-property channel doesn't deliver a particular field.
/// Returns the JSON-encoded property value.
///
/// Rejects `(name, format)` pairs known to crash this libmpv build:
/// any `format=node` request and any read of `track-list` regardless
/// of format both hit the same dispatch-table fault documented as
/// CLAUDE.md landmine #3 (`mpv_wrapper_get_property+0xa71`,
/// `movsxd rax, [rcx+rax*4]` derefs -1). Legitimate callers use
/// `string` / `double` / `flag` / `int64` and never need
/// `track-list` here (the dedicated `get_tracks` command exists for
/// that and rate-limits its use through the tracksReady effect in
/// PlayerOverlay). The deny-list is the only thing standing between
/// a future caller (or a copy-pasted snippet) and a hard crash.
#[tauri::command]
async fn get_property(
    app: tauri::AppHandle,
    name: String,
    format: String,
) -> Result<serde_json::Value, String> {
    if format.eq_ignore_ascii_case("node") {
        return Err("get_property: format=node is unsafe on this libmpv build (landmine #3)".into());
    }
    if name == "track-list" {
        return Err("get_property: track-list reads must go through get_tracks (landmine #3)".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .get_property(name, format, "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Best-effort "force a redraw / re-layout of the embedded video output".
/// Called after a window resize / fullscreen toggle so MPV picks up the
/// new client-area dimensions.
///
/// In windowed mode the webview's top 36 px is the Aura title bar. The MPV
/// child window is offset downward by that amount so video starts below the
/// bar instead of behind it. In fullscreen the title bar is unmounted so
/// the offset is 0 and MPV fills the whole screen.
/// Force MPV's child window to recompute its bounds.
///
/// `is_fullscreen` is an optional caller-provided fullscreen flag. React
/// holds the source-of-truth `isFullscreen` state and can pass it
/// explicitly so we don't race Tauri's `is_fullscreen()` query (which
/// has been observed to lag behind the real OS state during transitions
/// on borderless+transparent windows). When omitted we fall back to
/// querying Tauri.
#[tauri::command]
async fn refresh_video(
    app: tauri::AppHandle,
    is_fullscreen: Option<bool>,
) -> Result<(), String> {
    let is_fullscreen = is_fullscreen.unwrap_or_else(|| {
        app.get_webview_window("main")
            .and_then(|w| w.is_fullscreen().ok())
            .unwrap_or(false)
    });
    // 36 px = height of the webview title bar (TitleBar component).
    let title_bar_h: i32 = if is_fullscreen { 0 } else { 36 };

    #[cfg(target_os = "windows")]
    let parent_hwnd: isize = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        if parent_hwnd != 0 {
            win32::resize_mpv_child_to_parent(parent_hwnd, title_bar_h);
        }
        let mpv = app.mpv();
        let _ = mpv.set_property("video-zoom", &serde_json::json!(0.0001), "main");
        let _ = mpv.set_property("video-zoom", &serde_json::json!(0.0), "main");
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_speed(app: tauri::AppHandle, speed: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_speed({speed})");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("speed", &serde_json::json!(speed), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_speed failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn seek_absolute(app: tauri::AppHandle, time: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "seek",
                &vec![serde_json::json!(time), serde_json::json!("absolute")],
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Convert a track id passed from the frontend (number, string, "no",
/// "auto") into the string form MPV's `aid`/`sid` properties accept. The
/// libmpv-wrapper get/set_property dispatch on this build has been
/// observed to mis-handle non-string formats (same family of bug as the
/// `track-list/node` crash we hit earlier), so writing track selectors
/// as strings goes through a stable code path.
fn track_value_as_string(track: &serde_json::Value) -> Option<String> {
    match track {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[tauri::command]
async fn set_audio_track(app: tauri::AppHandle, track: serde_json::Value) -> Result<(), String> {
    crate::devlog!(info, "player", "set_audio_track({track})");
    let Some(track_str) = track_value_as_string(&track) else {
        return Err(format!("invalid track value: {track}"));
    };
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("aid", &serde_json::json!(track_str), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_audio_track failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Nudge audio sync forward or backward relative to the video stream.
/// Wraps MPV's `audio-delay` property (seconds, f64). Positive values
/// delay the audio; negative values advance it. Clamped to ±10 s to
/// keep the UI's number input from accepting absurd inputs that would
/// confuse the user — beyond that range the user almost certainly
/// has a worse problem than mistimed audio.
#[tauri::command]
async fn set_audio_delay(app: tauri::AppHandle, seconds: f64) -> Result<(), String> {
    let clamped = seconds.clamp(-10.0, 10.0);
    crate::devlog!(info, "player", "set_audio_delay({clamped:.3})");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("audio-delay", &serde_json::json!(clamped), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_audio_delay failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Nudge subtitle sync forward or backward. Wraps MPV's `sub-delay`
/// property (seconds, f64). Positive = subs appear later; negative =
/// subs appear earlier. Same ±10 s clamp as `set_audio_delay`.
#[tauri::command]
async fn set_subtitle_delay(app: tauri::AppHandle, seconds: f64) -> Result<(), String> {
    let clamped = seconds.clamp(-10.0, 10.0);
    crate::devlog!(info, "player", "set_subtitle_delay({clamped:.3})");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("sub-delay", &serde_json::json!(clamped), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_subtitle_delay failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_subtitle_track(app: tauri::AppHandle, track: serde_json::Value) -> Result<(), String> {
    crate::devlog!(info, "player", "set_subtitle_track({track})");
    let Some(track_str) = track_value_as_string(&track) else {
        return Err(format!("invalid track value: {track}"));
    };
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("sid", &serde_json::json!(track_str), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_subtitle_track failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Toggle subtitle visibility entirely. The dropdown's "Off" entry uses this
/// (vs. set_subtitle_track="no") because some libmpv builds reject "no" on
/// `sid` after a sub-add but happily honour `sub-visibility=no`.
#[tauri::command]
async fn set_subtitle_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    crate::devlog!(info, "player", "set_subtitle_visibility({visible})");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("sub-visibility", &serde_json::json!(visible), "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deliberately panic the Rust backend to verify the crash-reporting
/// pipeline end-to-end (Sentry panic hook → ingest endpoint → Issues
/// dashboard). Invoked from the DevConsole `panic` command. The panic
/// fires on a Tokio worker thread (via `spawn_blocking`) so the main
/// runtime can return the JoinError to the caller as a string instead
/// of taking down the whole runtime — but Sentry's panic hook still
/// captures the stack from the worker thread before unwind.
///
/// Available in both debug and release builds intentionally: the user
/// who just set up Sentry needs to be able to verify it on a real
/// production-style build, not only during `pnpm tauri dev`.
#[tauri::command]
async fn dev_force_panic(message: Option<String>) -> Result<(), String> {
    let msg = message
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "DevConsole-triggered panic (Sentry test)".to_string());
    crate::devlog!(warn, "dev", "force-panic: {msg}");
    let m = msg.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        panic!("{m}");
    })
    .await;
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(join_err) => Err(format!("worker panicked: {join_err}")),
    }
}

/// Set MPV's `panscan` property.
///
/// `0.0` = letterbox / pillarbox (the default — preserve aspect ratio,
/// black bars where needed). `1.0` = fully zoom-and-crop the video to
/// fill the viewport on the constrained axis, which is what an
/// ultrawide-monitor user wants for 16:9 content (zooms vertically into
/// the frame to fill 21:9) or what a 16:9 user wants for 21:9 content
/// (zooms horizontally to fill 16:9). Values between 0 and 1 blend the
/// two; we expose 0.0 / 1.0 only for the toggle UI.
///
/// Property docs: <https://mpv.io/manual/master/#options-panscan>
#[tauri::command]
async fn set_panscan(app: tauri::AppHandle, value: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_panscan({value})");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("panscan", &serde_json::json!(value), "main")
            .map_err(|e| {
                crate::devlog!(warn, "player", "set_panscan failed: {e}");
                e.to_string()
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct TrackEntry {
    id: i64,
    #[serde(rename = "type")]
    track_type: String, // "video" | "audio" | "sub"
    title: Option<String>,
    lang: Option<String>,
    selected: bool,
    /// True for tracks injected via `sub-add` (external `.srt`/`.vtt`).
    external: bool,
    codec: Option<String>,
}

/// Snapshot the current MPV track-list. Returns one entry per video / audio /
/// subtitle track; the frontend filters by `track_type` and renders selectors.
///
/// CRITICAL: do NOT use `get_property("track-list", "node")`. WinDbg traced
/// our STATUS_ACCESS_VIOLATION crashes on play to that exact call —
/// libmpv-wrapper.dll's get_property dispatch table for the "node" format
/// indexes through an uninitialized pointer when the property is
/// "track-list", reading from `0xFFFFFFFFFFFFFFFF` and faulting. Stack trace
/// pointed at lib.rs:275 (the original `get_property("track-list", "node")`
/// line) inside our `get_tracks` command.
///
/// Workaround: read individual numbered subproperties
/// (`track-list/count`, `track-list/N/{id,type,title,lang,selected,external,codec}`).
/// Each call uses a simple typed format (int64, string, flag) which goes
/// through a different code path in the wrapper that doesn't crash.
#[tauri::command]
async fn get_tracks(app: tauri::AppHandle) -> Result<Vec<TrackEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mpv = app.mpv();

        // How many tracks does MPV know about? `int64` format is safe.
        let count = mpv
            .get_property("track-list/count".into(), "int64".into(), "main")
            .ok()
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        if count <= 0 {
            return Ok::<Vec<TrackEntry>, String>(Vec::new());
        }
        // Sanity cap — prevents a malformed track-list reporting a huge
        // count from spinning us forever.
        let count = count.min(64);

        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            // All field reads are best-effort: if a subproperty is missing
            // (e.g. the track has no title) we just leave it empty rather
            // than failing the whole snapshot.
            let id = mpv
                .get_property(format!("track-list/{}/id", i), "int64".into(), "main")
                .ok()
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let track_type = mpv
                .get_property(format!("track-list/{}/type", i), "string".into(), "main")
                .ok()
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_default();
            let title = mpv
                .get_property(format!("track-list/{}/title", i), "string".into(), "main")
                .ok()
                .and_then(|v| v.as_str().map(String::from));
            let lang = mpv
                .get_property(format!("track-list/{}/lang", i), "string".into(), "main")
                .ok()
                .and_then(|v| v.as_str().map(String::from));
            let selected = mpv
                .get_property(format!("track-list/{}/selected", i), "flag".into(), "main")
                .ok()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let external = mpv
                .get_property(format!("track-list/{}/external", i), "flag".into(), "main")
                .ok()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let codec = mpv
                .get_property(format!("track-list/{}/codec", i), "string".into(), "main")
                .ok()
                .and_then(|v| v.as_str().map(String::from));

            out.push(TrackEntry {
                id, track_type, title, lang, selected, external, codec,
            });
        }
        Ok::<Vec<TrackEntry>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apply HDR tone-mapping settings live to the running MPV instance.
/// Called by the Settings page when the user toggles the HDR mode.
/// Also persists the new value to AppSettings so it's used at next init.
///
/// `mode` is one of "off" | "sdr" | "passthrough" — see settings.rs and
/// player::apply_hdr_options for what each mode emits to MPV. Unknown
/// strings collapse to "sdr" (the safe default).
#[tauri::command]
async fn apply_hdr_settings(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    crate::devlog!(info, "player", "apply_hdr_settings({mode})");

    // Normalise so persisted values match what player::resolve_hdr_mode
    // expects. Empty / unknown → "sdr".
    let mode_norm = match mode.trim().to_ascii_lowercase().as_str() {
        "off" | "passthrough" | "sdr" => mode.trim().to_ascii_lowercase(),
        _ => "sdr".to_string(),
    };

    // Persist so next MPV init picks it up. Also keep the legacy
    // hdr_enabled boolean in lockstep so old code paths reading it
    // (Discord RPC, telemetry, etc.) stay coherent: "off" → false,
    // anything else → true.
    let mut s = settings::snapshot();
    s.hdr_mode = mode_norm.clone();
    s.hdr_enabled = mode_norm != "off";
    settings::save(&app, &s)?;

    let mode_for_blocking = mode_norm.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mpv = app.mpv();
        // Build a fresh option map with this mode's properties and push
        // each one to MPV. apply_hdr_options writes a stable set of keys
        // so previous values from a different mode get overwritten — no
        // residual property drift between toggles.
        let mut opts: indexmap::IndexMap<String, serde_json::Value> = indexmap::IndexMap::new();
        crate::player::apply_hdr_options(&mut opts, &mode_for_blocking);
        for (key, value) in opts.iter() {
            // Best-effort per property: a mode that uses an option not
            // supported by this libmpv build should still apply the
            // others rather than aborting halfway. Log warnings via
            // devlog so DevConsole can surface anything mpv rejected.
            if let Err(e) = mpv.set_property(key.as_str(), value, "main") {
                crate::devlog!(warn, "player", "apply_hdr {key}={value:?} → {e}");
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native borderless fullscreen — bypasses Tauri's `setFullscreen`,
/// which on this app's `decorations: false` + `transparent: true`
/// window leaves the bottom strip of the monitor (the taskbar's
/// reserved area) uncovered. `set_native_fullscreen(true)` SetWindowPos's
/// the main window to the current monitor's FULL bounds (not the
/// work-area), which (a) actually fills the screen and (b) makes
/// Windows recognise the window as fullscreen so the taskbar auto-hides.
/// `set_native_fullscreen(false)` restores the saved pre-fullscreen
/// bounds.
#[tauri::command]
async fn set_native_fullscreen(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let parent_hwnd: isize = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
            .ok_or("no main window hwnd")?;

        // The MPV reparent-to-top-level experiment broke video rendering
        // (libmpv's render context didn't survive `SetParent(NULL)` cleanly
        // — first paint after the reparent never reached the screen). True
        // DXGI exclusive fullscreen would also require hiding the Tauri
        // window entirely (no overlay possible), so the path is a dead end
        // for this UX.
        //
        // Reverted to the child-window architecture. Fullscreen now:
        //   1. Tauri parent → WS_POPUP + monitor full rect + HWND_TOPMOST
        //      (existing enter_native_fullscreen path).
        //   2. MPV child resized to fill the parent's client area at
        //      y_offset=0 (no title bar in fullscreen).
        //   3. MPV's `fullscreen` property flipped — drives MPV's
        //      taskbar-auto-hide signalling and render-path optimisations.
        let mpv_handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = mpv_handle.mpv().set_property(
                "fullscreen", &serde_json::json!(enabled), "main",
            );
        })
        .await
        .map_err(|e| e.to_string())?;

        let p = parent_hwnd;
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if enabled {
                win32::enter_native_fullscreen(p)?;
                // After the parent restyle, snap the MPV child to the
                // freshly-resized client area so the video covers the
                // whole monitor (not just the previous windowed bounds).
                win32::resize_mpv_child_to_parent(p, 0);
            } else {
                win32::exit_native_fullscreen(p)?;
                // Title bar comes back on exit; keep the 36 px offset.
                win32::resize_mpv_child_to_parent(p, 36);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;

        Ok::<(), String>(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

/// Apply subtitle language preference to MPV.
///
/// Audio is no longer pushed via `alang` — the audio_priority + scoring
/// algorithm in `audioScoring.ts` does that work after tracks are
/// available, which is more reliable than MPV's own initial selection.
///
/// `is_anime` is kept in the signature for forward-compat but is unused —
/// the global subtitle_language now applies to all titles.
#[tauri::command]
async fn apply_lang_defaults(
    app: tauri::AppHandle,
    is_anime: bool,
) -> Result<(), String> {
    let _ = is_anime;
    let s = settings::snapshot();
    let subs = s.subtitle_language.clone();

    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property("slang", &serde_json::json!(subs), "main")
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Push the subtitle styling block from settings into MPV. Called from the
/// frontend whenever the user changes a subtitle-style option in Settings,
/// and once on every load_video so a freshly-loaded file inherits the
/// user's chosen look.
///
/// MPV property mapping:
///   • sub-font-size      → integer, glyph height in MPV units
///   • sub-pos            → integer 0..100, % from top
///   • sub-border-size    → integer 0..10, outline thickness
///   • sub-color          → "#RRGGBB" or "#RRGGBBAA"
///   • sub-back-color     → "#RRGGBBAA"; A=00 → no background box
///   • sub-font           → string family name; empty falls back to MPV's default sans
#[tauri::command]
async fn apply_subtitle_style(app: tauri::AppHandle) -> Result<(), String> {
    let s = settings::snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let mpv = app.mpv();

        // CRITICAL: every set_property here is BEST-EFFORT (`let _ =`).
        // On this libmpv build, *any* one of these properties might be
        // rejected — `sub-margin-y` errors when no track is loaded,
        // `ass-style-override` is named differently across builds,
        // `sub-pos` may briefly reject during loadfile transitions —
        // and using `?` would short-circuit the rest of the function,
        // leaving the user's slider visibly non-functional.
        //
        // The combined block below is what makes the vertical-position
        // slider actually move ASS / SSA subtitles (which is most anime
        // and many movie BD rips). Without an override directive,
        // libass respects the script's own MarginV / `\an*` / `\pos()`
        // and `sub-pos` is silently ignored. We try BOTH the canonical
        // `ass-style-override` and the legacy `sub-ass-override` alias
        // so whichever this libmpv build understands wins.
        //
        // Range up to 150 is supported by MPV's sub-pos so the slider
        // can push subs below the natural frame baseline when ASS
        // scripts add their own margins.

        let _ = mpv.set_property("sub-font-size",   &serde_json::json!(s.subtitle_font_size),   "main");
        let _ = mpv.set_property("sub-margin-y",    &serde_json::json!(0),                      "main");
        let _ = mpv.set_property("sub-ass-force-margins", &serde_json::json!("yes"),            "main");
        let _ = mpv.set_property("ass-style-override",    &serde_json::json!("force"),          "main");
        let _ = mpv.set_property("sub-ass-override",      &serde_json::json!("force"),          "main");
        // sub-pos accepts both numeric and string forms across libmpv
        // builds — try numeric first (canonical), fall back to string.
        let pos_num: serde_json::Value  = serde_json::json!(s.subtitle_position);
        let pos_str: serde_json::Value  = serde_json::json!(s.subtitle_position.to_string());
        if mpv.set_property("sub-pos", &pos_num, "main").is_err() {
            let _ = mpv.set_property("sub-pos", &pos_str, "main");
        }
        let _ = mpv.set_property("sub-border-size", &serde_json::json!(s.subtitle_border_size), "main");
        let _ = mpv.set_property("sub-color",       &serde_json::json!(s.subtitle_color),       "main");
        let _ = mpv.set_property("sub-back-color",  &serde_json::json!(s.subtitle_back_color),  "main");
        if !s.subtitle_font.trim().is_empty() {
            let _ = mpv.set_property("sub-font", &serde_json::json!(s.subtitle_font.trim()), "main");
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runtime-only sub-pos nudge — does NOT persist to settings.
///
/// Used by PlayerOverlay to "lift" subtitles when the control bar is
/// visible (so the bar doesn't sit on top of dialogue) and drop them
/// back to the user's chosen baseline when the bar hides. The frontend
/// is responsible for picking percentages and timing — this command
/// just forwards to MPV.
///
/// `percent` is the standard MPV `sub-pos` 0..150 range. Values above 95
/// can push subs below the natural frame baseline on ASS scripts that
/// declare their own MarginV; useful but lossy. Settings stays the
/// source of truth for "user's chosen subtitle height" — this only
/// overrides MPV's live property until Aura restarts (or until the
/// bar-hide handler fires the restore call).
#[tauri::command]
async fn set_subtitle_position_runtime(app: tauri::AppHandle, percent: u32) -> Result<(), String> {
    let pct = percent.clamp(0, 150);
    tauri::async_runtime::spawn_blocking(move || {
        let mpv = app.mpv();
        let pos_num: serde_json::Value = serde_json::json!(pct);
        let pos_str: serde_json::Value = serde_json::json!(pct.to_string());
        if mpv.set_property("sub-pos", &pos_num, "main").is_err() {
            let _ = mpv.set_property("sub-pos", &pos_str, "main");
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Initialise the Sentry client when (a) the user has explicitly
/// consented via the first-run dialog and (b) a DSN is resolvable.
///
/// DSN resolution order:
///   1. Persisted setting `crash_reporting_dsn` (user-editable in
///      Settings → Crash Reporting; survives across rebuilds)
///   2. Compile-time `SENTRY_DSN` env var baked in by `cargo build`
///      (intended for release builds shipped to end users)
///
/// Returns the guard so the caller can bind it for the lifetime of
/// the process. Sentry's panic-hook integration installs its hook
/// here; the custom file-logging panic hook in `run()` chains into
/// it via `prev_hook(info)` so both surfaces capture every panic.
/// Hardcoded production Sentry DSN. Lives in the binary so end users
/// don't have to set anything — the only thing they decide is whether
/// crash reports are *sent at all* (the first-run consent dialog).
///
/// Developer override: set `SENTRY_DSN` at compile time to point a
/// local build at a different project. The crash-reporting sidecar's
/// `dsn` field is also still respected for the same purpose, but the
/// Settings UI no longer surfaces it — production users have no
/// reason to see or change it.
const HARDCODED_SENTRY_DSN: &str =
    "https://a58c117ea2f8f76c8f3f666be1ef44d8@o4511346738987008.ingest.de.sentry.io/4511346906038352";

fn init_sentry_if_consented() -> Option<sentry::ClientInitGuard> {
    let cfg = crash_reporting::load_pre_init();
    if cfg.consent != Some(true) {
        return None;
    }
    // Resolution order: runtime sidecar override (developer setting,
    // not surfaced in UI) → compile-time SENTRY_DSN (developer build
    // override) → hardcoded production DSN. Empty strings at any
    // layer fall through to the next.
    let dsn = if !cfg.dsn.trim().is_empty() {
        cfg.dsn.clone()
    } else if let Some(d) = option_env!("SENTRY_DSN") {
        if !d.is_empty() { d.to_string() } else { HARDCODED_SENTRY_DSN.to_string() }
    } else {
        HARDCODED_SENTRY_DSN.to_string()
    };
    if dsn.is_empty() {
        return None;
    }
    let guard = sentry::init(sentry::ClientOptions {
        dsn: dsn.parse().ok(),
        release: sentry::release_name!(),
        // Stack traces on every event — vital for diagnosing the
        // libmpv-adjacent panics this app is most likely to surface.
        attach_stacktrace: true,
        // 10 % of Tauri commands get a transaction trace attached so
        // the Sentry Performance / Traces tab gets non-empty data.
        // Higher = more bandwidth + more storage; raise temporarily
        // when chasing a specific perf regression.
        traces_sample_rate: 0.1,
        // SDK-side PII off. Sentry's ingest server can still derive an
        // IP from the inbound HTTPS connection independently of the
        // SDK, so we also clamp ip_address + clear geo / request blocks
        // in before_send. The project-level "Prevent Storing of IP
        // Addresses" toggle in Sentry → Settings → Security & Privacy
        // is the belt-and-braces server-side equivalent — enabling
        // both means events arrive with no IP at any layer.
        send_default_pii: false,
        before_send: Some(std::sync::Arc::new(|mut event| {
            if let Some(ref mut user) = event.user {
                user.ip_address = Some(sentry::protocol::IpAddress::Exact(
                    "0.0.0.0".parse().unwrap(),
                ));
                user.email = None;
                user.username = None;
                user.id = None;
            } else {
                event.user = Some(sentry::protocol::User {
                    ip_address: Some(sentry::protocol::IpAddress::Exact(
                        "0.0.0.0".parse().unwrap(),
                    )),
                    ..Default::default()
                });
            }
            event.request = None;
            event.contexts.remove("geo");
            Some(event)
        })),
        ..Default::default()
    });
    if guard.is_enabled() {
        crate::devlog!(info, "sentry", "crash reporting enabled");
    } else {
        crate::devlog!(warn, "sentry", "DSN provided but client did not initialise");
    }
    Some(guard)
}

pub fn run() {
    // ── Crash reporting (Sentry) — opt-in via first-run consent ───────────
    // Initialise BEFORE the panic hook below so that hook chains into
    // Sentry's. Bind the guard to a local in `run()` — its Drop impl
    // flushes pending events, and `run()` only returns at app exit so
    // the binding lives for the whole process. No-op when the user has
    // not consented or no DSN is configured.
    let _sentry_guard = init_sentry_if_consented();

    // ── Native crash capture (minidump) — only when Sentry is up ──────────
    //
    // `sentry_rust_minidump::init` works by re-spawning THIS binary with
    // a private CLI flag that switches it into "crash reporter mode".
    // In reporter mode the process runs everything ABOVE this line
    // (so it inherits the same Sentry client + DSN) and then waits on
    // an IPC channel for a crash notification from the main process.
    // When the main process segfaults / hits STATUS_ACCESS_VIOLATION,
    // the reporter writes a minidump and uploads it as an attachment
    // to whatever Sentry event the panic hook also produced — the two
    // surfaces stitch together server-side via the same event id.
    //
    // Everything BELOW this block runs only in the main process;
    // skipping it in the reporter is what keeps the crash handler
    // lightweight (no Tauri webview spawning, no MPV dll preflight, no
    // bridge subprocess). We MUST keep the returned guard alive for
    // the whole main-process lifetime — dropping it tears down the
    // IPC channel and the reporter exits.
    //
    // Skipped when Sentry isn't initialised (no consent / no DSN) so a
    // declined-consent install still has zero crash-reporting overhead
    // and zero re-spawn quirks.
    let _minidump_guard = _sentry_guard
        .as_ref()
        .and_then(|guard| sentry_rust_minidump::init(guard).ok());

    // ── WebView2 launch args ──────────────────────────────────────────────

    // ── WebView2 launch args ──────────────────────────────────────────────
    // Read the persisted `gpu_acceleration` setting BEFORE Tauri builds the
    // window — WebView2 only consumes WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    // at spawn time, so changing the setting requires an app restart.
    // Surfaced to the user as "Hardware acceleration" in Settings →
    // Performance. When off, we pass `--disable-gpu` so WebView2 falls
    // back to software rendering — useful when GPU compositing of a
    // transparent window paired with DWM produces frame-pacing jank
    // (a few users report visibly laggy Library scroll on multi-monitor
    // setups while neither CPU nor GPU show meaningful load, which is
    // the canonical signature of compositor-thread contention rather
    // than render-thread saturation).
    //
    // We also read the setting via the same `settings::load` path the
    // Tauri command handlers use later, so both surfaces share one
    // source of truth. Failure here is non-fatal — fall through to
    // GPU-on (the default).
    if let Ok(s) = settings::load_pre_init() {
        if !s.gpu_acceleration {
            // The env var is read on EVERY WebView2 process spawn,
            // including child renderers, so setting it here covers
            // the whole webview lifecycle.
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--disable-gpu --disable-gpu-compositing",
            );
        }
    }

    // ── Panic hook ────────────────────────────────────────────────────────
    // Capture every unhandled panic to %USERPROFILE%\aura-panic.log so a
    // post-mortem crash report has more than just a one-line stderr
    // tombstone. Format: timestamp + thread + payload + best-effort
    // stack-frame info pulled from std::backtrace. Best-effort — failure
    // to write here mustn't itself panic (we're already in the panic
    // handler), so every IO call is `.ok()`-swallowed.
    //
    // Pre-emptive size cap: if a previous run (or runs) accumulated more
    // than 5 MB of panic log, rotate to .old so the file doesn't grow
    // unbounded. A 5 MB ceiling holds ~50 typical panics — plenty of
    // history for forensics without becoming a disk-space concern.
    if let Ok(home) = std::env::var("USERPROFILE") {
        let path = format!("{home}\\aura-panic.log");
        const MAX_PANIC_LOG_BYTES: u64 = 5 * 1024 * 1024;
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_PANIC_LOG_BYTES {
                let rotated = format!("{home}\\aura-panic.log.old");
                let _ = std::fs::remove_file(&rotated);
                let _ = std::fs::rename(&path, &rotated);
            }
        }
    }
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current()
            .name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| format!("{:?}", std::thread::current().id()));
        let backtrace = std::backtrace::Backtrace::force_capture();
        // std-only timestamp: SystemTime::now() reduced to a Unix
        // milliseconds count. Avoids pulling in `chrono` for one
        // log-line. Resolution of ms is enough for crash forensics.
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let entry = format!(
            "----- ts_ms={} -----\nthread: {}\nat:     {}\nmessage: {}\nbacktrace:\n{}\n\n",
            ts_ms, thread, location, msg, backtrace,
        );
        if let Ok(home) = std::env::var("USERPROFILE") {
            let path = format!("{home}\\aura-panic.log");
            // Append, don't truncate — preserves the panic history
            // across launches so users sending a bug report can ship
            // the file and we see the lead-up too.
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = f.write_all(entry.as_bytes());
            }
        }
        // Chain to whatever hook was previously installed (e.g. the
        // default stderr writer) so terminal output still shows the
        // panic when Aura is run from a console.
        prev_hook(info);
    }));

    tauri::Builder::default()
        // Window-state plugin must be registered FIRST so it sees every
        // window's events — it auto-saves position/size on move/resize/close
        // and restores them when each window is created. The main window's
        // bounds therefore land before the React app paints, eliminating
        // the visible "open at default centred 1280×800 → snap to last
        // position" jump that any post-mount restore would produce.
        // Persist size / position / maximized / visible / decorations,
        // but DO NOT persist the FULLSCREEN flag. Aura uses a Win32-driven
        // native fullscreen path that doesn't go through Tauri's
        // setFullscreen, so the plugin's notion of "is fullscreen" doesn't
        // line up with reality. Letting it persist meant a session that
        // ended mid-fullscreen could restart with the window stuck in a
        // half-fullscreen state on the next launch.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        ^ tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        // Single-instance MUST be registered BEFORE the deep-link
        // plugin so the deep-link plugin can hook into it and forward
        // `aura://` URLs from secondary processes back to the primary.
        // Without it the OS scheme handler spawns a fresh aura.exe
        // per deep-link click and neither instance ends up applying
        // the OAuth token. The callback fires on the running primary
        // instance whenever a second one is launched; we focus the
        // main window. The single-instance plugin's `deep-link`
        // feature hooks into tauri_plugin_deep_link BEFORE this
        // callback runs (see tauri-plugin-single-instance's `init`
        // wrapper) so the URL forwarding is automatic.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            use tauri::Manager;
            // Log unconditionally so we can tell from DevConsole /
            // stderr whether the OS actually dispatched the
            // secondary process, separate from whether the deep-link
            // plugin then propagated the URL. argv[0] is the
            // executable path; argv[1..] is what we care about for
            // the `aura://` URL — but argv may contain an OAuth
            // callback whose `token=` / `refresh=` params are
            // long-lived bearer secrets, so each entry routes through
            // `redact_oauth_url` before hitting the log.
            let redacted: Vec<String> = argv
                .iter()
                .map(|a| crate::scrobble_auth::redact_oauth_url(a))
                .collect();
            crate::devlog!(
                info, "lib",
                "single-instance second-process args ({} total): {:?} cwd={cwd}",
                argv.len(), redacted,
            );
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        // Auto-updater plugin. Configuration lives in tauri.conf.json
        // (plugins.updater). Until you generate a signing keypair via
        // `pnpm tauri signer generate` and stamp the public key into
        // the config, the plugin still loads but check() / download()
        // fail with a "signature mismatch" error. See PRODUCTION.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // ── DevLog — install first so subsequent setup steps can log ──
            devlog::install(app.handle());
            crate::devlog!(info, "lib", "Aura setup begin");

            // ── API key migration: settings.json → OS keyring ──
            // One-shot per launch. Moves plaintext OMDb / OpenSubtitles
            // keys from settings.json into the keyring (DPAPI / Keychain
            // / Secret Service) and clears the settings.json fields.
            // Idempotent — no-op when there's nothing to migrate AND
            // the keyring is already populated. See `api_keyring.rs`
            // for the full migration semantics.
            api_keyring::migrate_from_settings(app.handle());

            // ── Anime ID map warm-up (Fribb/anime-lists) ──
            // Background load + refresh of the imdb→anilist map used
            // by scrobble_anilist's resolver. Spawned on the async
            // runtime so a network round-trip doesn't block setup.
            // Non-blocking — resolver returns None until the map
            // arrives, which gracefully falls back to title search.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    anime_id_map::warm_cache(handle).await;
                });
            }

            // ── Deep-link scheme registration ──────────────────────────────
            // The Windows NSIS installer registers `aura://` and
            // `stremio://` in HKCU\Software\Classes when the user
            // installs Aura, so OAuth deep-links Just Work for shipped
            // builds. But `pnpm tauri dev` never runs the installer,
            // so the scheme is unknown to the OS — the system browser
            // shows "Prevented navigation due to unknown protocol"
            // when the proxy 302s to `aura://oauth/{provider}`.
            // Registering at runtime in debug-Windows + Linux fixes
            // dev mode without disturbing release behaviour. macOS is
            // bundle-only (the .app's Info.plist registers it; no
            // runtime API). Linux always needs runtime registration
            // — the .desktop file path varies by distro.
            #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    crate::devlog!(
                        warn, "lib",
                        "deep-link register_all failed: {e} — aura:// links may not route to this build",
                    );
                } else {
                    crate::devlog!(info, "lib", "deep-link schemes registered (dev mode)");
                }
            }

            // ── AniList ID cache ──────────────────────────────────────────
            // Loads the persistent cache that maps Aura's IMDB show ids to
            // AniList media ids. Loaded once at startup; written through on
            // every cache miss in scrobble_anilist::save_progress. Empty /
            // missing file is fine (just an empty cache).
            scrobble_anilist::init_cache(app.handle());


            // ── DLL pre-flight ─────────────────────────────────────────────
            player::check_mpv_dll().map_err(|e| {
                crate::devlog!(error, "player", "MPV DLL pre-flight failed: {e}");
                std::io::Error::new(std::io::ErrorKind::NotFound, e)
            })?;

            // ── Vibrancy ───────────────────────────────────────────────────
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::{apply_acrylic, apply_mica};
                apply_mica(&window, Some(true))
                    .or_else(|_| apply_acrylic(&window, Some((0, 0, 0, 180))))
                    .expect("Failed to apply Windows vibrancy");

                // ── One-shot recovery: if the previous session left the
                // window persisted at the full monitor rect with no
                // WS_MAXIMIZE bit (a known consequence of the earlier
                // double-fullscreen-entry bug), force-maximize so the
                // taskbar comes back and the client area locks to the
                // work area. No-op on healthy installs.
                if let Ok(handle) = window.hwnd() {
                    let parent_hwnd = handle.0 as isize;
                    win32::recover_window_state(parent_hwnd);
                }
            }

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                    .expect("Failed to apply macOS vibrancy");
            }

            // ── Settings — eager load so cache is hot for window callbacks ─
            //
            // Seed the active scope from the persisted Stremio session BEFORE
            // touching settings::load. Without this, the cache would warm up
            // from the "guest" file and MPV (which initialises a few lines
            // below using the cache) would pick up the wrong subtitle / HDR
            // / passthrough config on first paint for signed-in users —
            // until the frontend's post-mount `set_settings_scope` swap.
            let initial_scope = match auth::load_session(app.handle()) {
                Ok(Some(sess)) => settings::scope_from_auth_key(&sess.auth_key),
                _ => "guest".to_string(),
            };
            let _ = settings::set_active_scope(app.handle(), &initial_scope);
            settings::load(app.handle());

            // ── MPV engine ─────────────────────────────────────────────────
            player::init_mpv(app.handle()).map_err(|e| {
                crate::devlog!(error, "player", "MPV init failed: {e}");
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;
            crate::devlog!(info, "player", "MPV engine ready");

            // ── Window lifecycle (pause-on-blur, pause-on-min, close-on-exit) ─
            window_logic::install(app.handle());

            // ── Tray icon (gated behind minimize_to_tray_on_close at runtime) ─
            if let Err(e) = tray::install(app.handle()) {
                crate::devlog!(warn, "tray", "tray install failed: {}", e);
            }

            // ── System Media Transport Controls (SMTC, Windows) ────────────────
            media_controls::install(app.handle());

            // ── Streaming bridge subprocess ────────────────────────────────
            // The bridge is a separate `aura-bridge` binary (sibling
            // crate). On startup we spawn it as a child process; on
            // app shutdown the child is killed via the on_window_event
            // handler in window_logic. The binary is searched for in
            // a few well-known locations:
            //
            //   1. <exe_dir>/aura-bridge.exe         — bundled sidecar
            //   2. <repo>/aura-bridge/target/release — release build
            //   3. <repo>/aura-bridge/target/debug   — dev build
            //
            // Falling back through these means devs running `pnpm
            // tauri dev` get the binary picked up automatically as
            // long as they ran `cargo build` in the bridge crate at
            // least once. Production installs ship the bundled
            // sidecar at slot #1.
            //
            // If no binary is found we log a warning and let the app
            // continue — only HTTP streams need the bridge; HTTPS
            // bypasses entirely (per resolve_stream's routing
            // rules), so most playback still works without it.
            spawn_bridge_subprocess();

            // ── Deep-link handler ─────────────────────────────────────────
            // Emits `deep-link` events to the frontend for both aura:// and
            // stremio:// protocol URLs so the UI can route them.
            //
            // tauri-plugin-deep-link v2 emits this event with payload
            // `Vec<String>` (the list of URLs the OS handed the
            // process). The earlier code tried to deserialize as
            // `String`, which silently failed on every event — the
            // URL never reached the frontend, so OAuth deep-links
            // looked like "nothing happened" even though
            // single-instance had correctly forwarded the URL from
            // the secondary process. Iterating the vec preserves the
            // existing per-URL `deep-link` event the React side
            // listens for, so App.tsx's handler doesn't change.
            {
                let handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    let payload = event.payload();
                    if let Ok(urls) = serde_json::from_str::<Vec<String>>(payload) {
                        for url in urls {
                            // Redact tokens for log (the original URL still goes
                            // to the frontend handler — App.tsx needs the live
                            // params to persist the token to the keyring).
                            crate::devlog!(
                                info, "lib",
                                "deep-link arrived: {}",
                                crate::scrobble_auth::redact_oauth_url(&url),
                            );
                            handle.emit("deep-link", url).ok();
                        }
                    } else {
                        crate::devlog!(
                            warn, "lib",
                            "deep-link event payload not Vec<String>: {payload}",
                        );
                    }
                });
            }

            // ── Observer bridge ────────────────────────────────────────────
            // The plugin emits `mpv-event-main` via `app.emit_to(window_label, …)`.
            // We subscribe via `listen_any` (target = Any) so the handler
            // matches the window-targeted emission, fold each property
            // change into a single PlaybackState snapshot, and re-emit as
            // a broadcast `playback-update` for the frontend.
            //
            // Removing this bridge in earlier rounds did NOT fix the
            // STATUS_ACCESS_VIOLATION on play (the crash happened with or
            // without it) — it was a red herring. Restored because the
            // aggregated snapshot pattern is what the rest of the app
            // expects and it gives us a single Rust-side place to add
            // diagnostics when needed.
            let pb_state: Arc<Mutex<PlaybackState>> =
                Arc::new(Mutex::new(PlaybackState::default()));

            let handle = app.handle().clone();
            let pb_ref = pb_state.clone();

            app.listen_any("mpv-event-main", move |event| {
                let Ok(ev) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };

                let name = ev.get("name").and_then(|v| v.as_str()).unwrap_or("");

                match name {
                    "pause" | "time-pos" | "duration" | "volume" | "speed" => {
                        // Bug guard: if MPV emits the property event with
                        // null/missing data (happens during loadfile and
                        // early init for some properties), DO NOT clobber
                        // the last-known value with the type's zero — that
                        // was the cause of "volume slider shows 0% on
                        // first stream while audio is at 50". Skip the
                        // update entirely when there's no real data.
                        let data = ev.get("data");
                        let has_data = data.is_some() && !data.unwrap().is_null();
                        if !has_data {
                            return;
                        }
                        let data = data.unwrap();

                        // Emit a PARTIAL update carrying ONLY the field
                        // that changed. Earlier rounds emitted the full
                        // PlaybackState snapshot on every event, which
                        // meant time-pos events (~30 Hz during playback)
                        // re-broadcast the bridge's cached `paused`
                        // value. When the cache disagreed with MPV's
                        // actual pause (the documented "initial pause:
                        // false transition never fires" landmine), each
                        // time-pos tick pushed stale paused=true to
                        // React while the 800 ms polling kept correcting
                        // back to paused=false — observable as the play
                        // button flapping at exactly the polling cadence
                        // and Discord RPC spamming Paused/Playing pairs.
                        // Partial updates side-step the whole problem.
                        let mut update = serde_json::Map::new();
                        let mut st = pb_ref.lock().unwrap();
                        match name {
                            "pause" => {
                                if let Some(v) = data.as_bool() {
                                    st.paused = v;
                                    update.insert("paused".into(), serde_json::Value::Bool(v));
                                }
                            }
                            "time-pos" => {
                                if let Some(v) = data.as_f64() {
                                    st.time = v;
                                    update.insert("time".into(),
                                        serde_json::Number::from_f64(v)
                                            .map(serde_json::Value::Number)
                                            .unwrap_or(serde_json::Value::Null));
                                }
                            }
                            "duration" => {
                                if let Some(v) = data.as_f64() {
                                    st.duration = v;
                                    update.insert("duration".into(),
                                        serde_json::Number::from_f64(v)
                                            .map(serde_json::Value::Number)
                                            .unwrap_or(serde_json::Value::Null));
                                }
                            }
                            "volume" => {
                                if let Some(v) = data.as_f64() {
                                    st.volume = v;
                                    update.insert("volume".into(),
                                        serde_json::Number::from_f64(v)
                                            .map(serde_json::Value::Number)
                                            .unwrap_or(serde_json::Value::Null));
                                }
                            }
                            "speed" => {
                                if let Some(v) = data.as_f64() {
                                    st.speed = v;
                                    update.insert("speed".into(),
                                        serde_json::Number::from_f64(v)
                                            .map(serde_json::Value::Number)
                                            .unwrap_or(serde_json::Value::Null));
                                }
                            }
                            _ => {}
                        }
                        drop(st);
                        if !update.is_empty() {
                            handle.emit("playback-update", serde_json::Value::Object(update)).ok();
                        }
                    }
                    "end-file" => {
                        // libmpv fires this when a file finishes playing —
                        // either naturally (eof), via stop/quit, OR because
                        // loading failed (DNS / TCP / demuxer init / codec
                        // unsupported). The "error" reason is the case the
                        // frontend cares about: without this bridge, a
                        // load-time failure leaves the user staring at
                        // Aura's background while MPV silently uninits its
                        // video output — the stale-heartbeat detector
                        // can't fire because no first frame ever arrived.
                        //
                        // The libmpv-wrapper FFI emits this with the
                        // `reason` field as either a string ("error",
                        // "eof", …) or an integer matching mpv's
                        // mpv_end_file_reason enum (0=eof / 2=stop /
                        // 3=quit / 4=error / 5=redirect). Normalize to a
                        // string for the frontend.
                        let data = ev.get("data").or(Some(&ev));
                        let reason: Option<String> = data
                            .and_then(|d| d.get("reason"))
                            .map(|r| {
                                if let Some(s) = r.as_str() {
                                    s.to_string()
                                } else if let Some(n) = r.as_i64() {
                                    match n {
                                        0 => "eof".to_string(),
                                        2 => "stop".to_string(),
                                        3 => "quit".to_string(),
                                        4 => "error".to_string(),
                                        5 => "redirect".to_string(),
                                        other => format!("unknown({})", other),
                                    }
                                } else {
                                    r.to_string()
                                }
                            });
                        let error_code: Option<i64> = data
                            .and_then(|d| d.get("error"))
                            .and_then(|e| e.as_i64());

                        crate::devlog!(
                            info, "player",
                            "end-file reason={:?} error={:?}",
                            reason, error_code
                        );

                        let mut out = serde_json::Map::new();
                        if let Some(r) = reason {
                            out.insert("reason".into(), serde_json::Value::String(r));
                        }
                        if let Some(e) = error_code {
                            out.insert(
                                "error".into(),
                                serde_json::Value::Number(serde_json::Number::from(e)),
                            );
                        }
                        handle.emit("playback-end", serde_json::Value::Object(out)).ok();
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── Player ──────────────────────────────────────────────────────
            load_video,
            stop_video,
            toggle_pause,
            seek_relative,
            frame_step,
            set_audio_loudnorm,
            set_volume,
            set_speed,
            seek_absolute,
            set_audio_track,
            set_audio_delay,
            set_subtitle_track,
            set_subtitle_delay,
            set_subtitle_visibility,
            set_panscan,
            dev_force_panic,
            get_tracks,
            get_property,
            refresh_video,
            apply_lang_defaults,
            apply_hdr_settings,
            apply_subtitle_style,
            set_subtitle_position_runtime,
            set_native_fullscreen,
            // ── Per-title persistence (volume / shader / audio / sub) ───────
            per_title::get_title_state,
            per_title::set_title_state,
            // ── Local fun-stats (hours watched, etc.) ───────────────────────
            stats::get_stats,
            stats::bump_stat,
            // ── Disk / cache management ──────────────────────────────────────
            storage::get_storage_report,
            storage::clear_storage_item,
            // ── Crash reporting (consent + DSN, scope-independent) ───────────
            crash_reporting::get_crash_reporting,
            crash_reporting::set_crash_reporting,
            // ── Stremio catalog ─────────────────────────────────────────────
            stremio::fetch_catalog,
            stremio::fetch_catalog_paginated,
            stremio::get_addon_manifest,
            stremio::refresh_addon_manifest,
            // ── Addon management (guest) ─────────────────────────────────────
            stremio::add_addon,
            stremio::remove_addon,
            stremio::list_addons,
            // ── Global search & cloud sync (2.3) ────────────────────────────
            stremio::global_search,
            stremio::global_search_grouped,
            stremio::search_addon_grouped,
            stremio::cloud_add_addon,
            stremio::cloud_remove_addon,
            // ── Auth ────────────────────────────────────────────────────────
            auth::login,
            auth::logout,
            auth::get_session,
            auth::get_synced_addons,
            // ── Streaming bridge (2.4) ───────────────────────────────────────
            streaming::resolve_stream,
            // ── Cinema Suite (2.6) ──────────────────────────────────────────
            cinema::list_shader_profiles,
            cinema::set_shader_profile,
            cinema::get_shader_profile,
            // ── Phase 3B: meta detail, library sync, settings ────────────────
            stremio::fetch_meta_detail,
            stremio::library_get,
            stremio::library_put,
            settings::get_settings,
            settings::set_theme,
            settings::update_settings,
            settings::reset_settings,
            settings::set_settings_scope,
            // ── AniSkip (anime OP/ED skip-time fetcher) ──
            aniskip::fetch_skip_windows,
            aniskip::set_skip_windows,
            aniskip::submit_skip_time,
            aniskip::vote_skip_time,
            aniskip::resolve_anilist_to_mal,
            aniskip::resolve_mal_for_aniskip,
            anime_id_map::resolve_cour_mal_id,
            anime_id_map::resolve_cour_anilist_id,
            aniskip::get_skip_windows,
            aniskip::resolve_mal_id,
            aniskip::resolve_mal_id_by_title,
            silencedetect::detect_silence_intervals,
            // ── Phase 3C: scrobbling ──────────────────────────────────────────
            scrobble::scrobble_start,
            scrobble::scrobble_heartbeat,
            scrobble::scrobble_end,
            // ── Trakt + AniList OAuth (direct scrobble, replaces AIOMetadata) ──
            scrobble_auth::get_scrobble_auth_status,
            scrobble_auth::set_scrobble_auth_token,
            scrobble_auth::clear_scrobble_auth_token,
            scrobble_auth::scrobble_oauth_authorize_url,
            scrobble_auth::scrobble_oauth_device_begin,
            scrobble_auth::scrobble_oauth_device_poll,
            scrobble_auth::open_oauth_popup_webview,
            scrobble::scrobble_test_fire,
            // ── API keys (OS keyring) ─────────────────────────────────────────
            api_keyring::get_api_key,
            api_keyring::set_api_key,
            api_keyring::clear_api_key,
            sync::sync_status,
            sync::sync_pull,
            sync::sync_pull_all,
            sync::sync_push,
            sync::sync_delete,
            sync::sync_purge,
            sync::fetch_release_signal,
            sync::fetch_release_signals,
            sync::nudge_release_poller,
            per_title::get_all_title_state,
            per_title::set_all_title_state,
            scrobble_anilist::get_anilist_id_map,
            scrobble_anilist::set_anilist_id_map,
            // ── Phase 3C: Discord RPC ─────────────────────────────────────────
            window_logic::discord_set_presence,
            window_logic::discord_clear_presence,
            // ── Phase 4: OpenSubtitles ────────────────────────────────────────
            subtitles::search_subtitles,
            subtitles::download_subtitle,
            subtitles::compute_opensubtitles_hash,
            subtitles::add_subtitle_to_mpv,
            // ── Phase 4: SMTC ─────────────────────────────────────────────────
            media_controls::smtc_set_metadata,
            media_controls::smtc_set_playback,
            media_controls::smtc_clear,
            // ── Phase 5: stream aggregation ──────────────────────────────────
            stremio::fetch_streams,
            // ── Phase 6.0.5: OMDb ratings enrichment ─────────────────────────
            omdb::fetch_omdb_ratings,
            // ── Multi-source ratings (MAL via Jikan, etc.) ───────────────────
            ratings::fetch_aggregate_ratings,
            // ── Phase 5.5: external subtitles fan-out ────────────────────────
            stremio::fetch_external_subtitles,
            // ── User-data backups (manual & queue, history, settings) ───────
            backup::create_user_backup,
            backup::list_user_backups,
            backup::read_user_backup,
            backup::delete_user_backup,
            backup::user_backup_storage_used,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
