// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Settings → Debug Stuff backend.
//!
//! Two Tauri commands that surface live engine + mpv + window state into
//! the frontend, and a timed drop-rate test the user can run while moving
//! Aura between foreground / visible-background / minimised to validate
//! the off-focus-drop behaviour empirically.
//!
//! All values come either from the [`crate::mpv::engine`] published
//! atomics + `submit_get_property`, or from cheap Win32 / DWM queries
//! against the main HWND. No render-thread state is touched directly.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
    UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindowVisible,
    },
};

/// Read several mpv properties via the engine's synchronous getter and
/// roll them into a JSON object. Each property is best-effort — a missing
/// or wrong-format property doesn't fail the whole snapshot.
#[cfg(target_os = "windows")]
fn read_mpv_snapshot() -> Value {
    use crate::mpv::engine::{submit_get_property, GetFormat};
    fn s(name: &str) -> Option<String> {
        submit_get_property(name.into(), GetFormat::String)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
    }
    fn i(name: &str) -> Option<i64> {
        submit_get_property(name.into(), GetFormat::Int64)
            .ok()
            .and_then(|v| v.as_i64())
    }
    fn d(name: &str) -> Option<f64> {
        submit_get_property(name.into(), GetFormat::Double)
            .ok()
            .and_then(|v| v.as_f64())
    }

    let gamma = s("video-params/gamma");
    let primaries = s("video-params/primaries");
    let pixelformat = s("video-params/pixelformat");
    // HDR heuristic: mpv reports `pq` for SMPTE 2084 (HDR10/Dolby Vision
    // base layer) and `hlg` for Hybrid-Log-Gamma. Everything else
    // (bt.1886, srgb, gamma22, …) is SDR.
    let hdr_kind = match gamma.as_deref() {
        Some("pq") => Some("PQ (HDR10)"),
        Some("hlg") => Some("HLG"),
        Some(_) => Some("SDR"),
        None => None,
    };
    let hdr_detected = matches!(gamma.as_deref(), Some("pq") | Some("hlg"));

    // Dolby Vision detection — best-effort: mpv exposes
    // `track-list/0/dolby-vision-cfg/profile` on builds that have DV
    // support compiled in (zhongfly's mpv-winbuild does). Reading any
    // numeric value means a DV layer is present in the track.
    let dv_profile = i("track-list/0/dolby-vision-cfg/profile");
    let dv_detected = dv_profile.is_some();

    json!({
        "video_codec":     s("video-codec"),
        "video_format":    s("video-format"),
        "video_w":         i("dwidth"),
        "video_h":         i("dheight"),
        "fps":             d("container-fps"),
        "estimated_vf_fps": d("estimated-vf-fps"),
        "display_fps":     d("display-fps"),
        "hwdec_current":   s("hwdec-current"),
        "audio_codec":     s("audio-codec"),
        "audio_format":    s("audio-codec-name"),
        "pixelformat":     pixelformat,
        "primaries":       primaries,
        "gamma":           gamma,
        "hdr_detected":    hdr_detected,
        "hdr_kind":        hdr_kind,
        "dv_profile":      dv_profile,
        "dv_detected":     dv_detected,
        "frame_drop_count":         i("frame-drop-count"),
        "decoder_frame_drop_count": i("decoder-frame-drop-count"),
        "vo_delayed_frame_count":   i("vo-delayed-frame-count"),
        "paused":          submit_get_property("pause".into(), GetFormat::Flag)
                            .ok().and_then(|v| v.as_bool()),
        "time_pos":        d("time-pos"),
        "duration":        d("duration"),
        "volume":          d("volume"),
        "speed":           d("speed"),
    })
}

#[cfg(not(target_os = "windows"))]
fn read_mpv_snapshot() -> Value {
    json!({})
}

/// Snapshot of window-management state. All four predicates feed the
/// engine's [`PresentMode`] decision; surfacing them in the debug panel
/// lets the user verify the mode switch is firing on the right input.
#[cfg(target_os = "windows")]
fn read_window_state(parent_hwnd: isize) -> Value {
    if parent_hwnd == 0 {
        return json!({
            "available": false,
            "reason": "main window HWND not resolvable",
        });
    }
    unsafe {
        let parent = HWND(parent_hwnd as *mut _);
        let fg = GetForegroundWindow();
        let is_foreground = !fg.is_invalid() && fg == parent;
        let is_visible = IsWindowVisible(parent).as_bool();
        let is_iconic = IsIconic(parent).as_bool();
        let mut cloaked: u32 = 0;
        let cloaked_ok = DwmGetWindowAttribute(
            parent,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok();
        json!({
            "available":      true,
            "hwnd_hex":       format!("{parent_hwnd:#x}"),
            "is_foreground":  is_foreground,
            "is_visible":     is_visible,
            "is_iconic":      is_iconic,
            "is_cloaked":     cloaked_ok && cloaked != 0,
            "cloak_reason":   if cloaked_ok { cloaked } else { 0 },
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn read_window_state(_parent_hwnd: isize) -> Value {
    json!({ "available": false, "reason": "non-Windows build" })
}

/// One-shot live snapshot. Frontend polls this every second.
#[tauri::command]
pub fn debug_engine_state(app: AppHandle) -> Value {
    // Always true since the engine consolidation — the mpv engine is the
    // only playback path. Kept in the payload so the frontend panel's
    // shape doesn't change.
    #[cfg(target_os = "windows")]
    let mpv_active = true;
    #[cfg(not(target_os = "windows"))]
    let mpv_active = false;

    #[cfg(target_os = "windows")]
    let mpv_running = crate::mpv::engine::is_running();
    #[cfg(not(target_os = "windows"))]
    let mpv_running = false;

    #[cfg(target_os = "windows")]
    let present_mode = crate::mpv::engine::current_present_mode().map(|m| m.name());
    #[cfg(not(target_os = "windows"))]
    let present_mode: Option<&'static str> = None;

    let parent_hwnd: isize = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);

    let mpv = if mpv_running { read_mpv_snapshot() } else { json!(null) };

    json!({
        "engine": {
            "mpv_active":  mpv_active,
            "mpv_running": mpv_running,
            "present_mode": present_mode,
        },
        "window": read_window_state(parent_hwnd),
        "mpv":    mpv,
    })
}

/// Load a synthetic test pattern into the mpv engine. Uses mpv's
/// `av://lavfi:<filtergraph>` protocol so playback is generated by
/// FFmpeg's libavfilter — no file on disk, no network call, no asset
/// bundling. The pattern is SMPTE color bars at 1280×720 / 24 fps with
/// `loop=inf` on the filter so the source never ends.
///
/// Goes straight to `mpv::engine::submit_load_file` to bypass the
/// `load_video` Tauri command's scheme guard (which intentionally
/// rejects anything that isn't http(s) / 127.0.0.1 / magnet — safe in
/// production but blocks the lavfi virtual-file URL we need here). The
/// engine itself runs `mpv_command(["loadfile", url, "replace"])` which
/// accepts the lavfi URL.
///
/// The duration field on the filter is a "stop-after" — we set it
/// large enough to outlast any drop-test window (3 600 s = 1 hour) so
/// the user can run any duration without worrying about the source
/// ending mid-test.
#[tauri::command]
pub async fn debug_load_test_pattern() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use crate::mpv::engine::{is_running, submit_load_file};
        if !is_running() {
            return Err("debug_load_test_pattern: mpv engine not running.".into());
        }
        // 1280×720 SMPTE bars at 24 fps. `duration=3600` caps the source
        // at one hour so even the 60 s drop test has plenty of headroom.
        // mpv's keep-open=yes (set in the engine init) preserves the
        // last frame after the source ends if a user runs longer.
        let url =
            "av://lavfi:smptebars=size=1280x720:rate=24:duration=3600".to_string();
        crate::devlog!(info, "debug-panel", "loading lavfi test pattern: {url}");
        submit_load_file(url, None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("debug_load_test_pattern: not implemented on non-Windows builds".into())
    }
}

/// Unload whatever is currently playing in the mpv engine. Mirrors
/// the `stop_video` Tauri command but bypasses its scope for the
/// debug panel — the panel needs to remove the test pattern without
/// disturbing the rest of the player UI state. Uses `mpv_command
/// ["stop"]` which discards the loaded file and returns the engine
/// to idle (with the last frame held thanks to `keep-open=yes`, until
/// the next `loadfile` replaces it).
#[tauri::command]
pub fn debug_stop_playback() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use crate::mpv::engine::{is_running, submit_command};
        if !is_running() {
            return Err("debug_stop_playback: mpv engine not running.".into());
        }
        submit_command(vec!["stop".into()])
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("debug_stop_playback: not implemented on non-Windows builds".into())
    }
}

/// Run a timed drop-rate test. Reads `frame-drop-count` and
/// `decoder-frame-drop-count` at start, awaits `duration_secs`
/// (clamped 3..=60), reads them again, returns deltas + rates.
/// Captures present-mode at start and end so the user can correlate
/// drops with the mode the engine was in.
///
/// Off-focus verification recipe:
///   1. Start a stream.
///   2. Call this command for, say, 15 seconds.
///   3. While it runs, move Aura to a non-foreground state (alt-tab,
///      drag to another monitor, etc.) and leave it there until the
///      timer expires.
///   4. The returned delta_vo / rate_vo + initial_mode / final_mode
///      tell the story.
#[tauri::command]
pub async fn debug_drop_test(duration_secs: u32) -> Result<Value, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = duration_secs;
        return Err("debug_drop_test: not implemented on non-Windows builds".into());
    }
    #[cfg(target_os = "windows")]
    {
        use crate::mpv::engine::{
            current_present_mode, is_running, submit_get_property, GetFormat,
        };
        if !is_running() {
            return Err(
                "debug_drop_test: mpv engine not running. Load a stream first.".into(),
            );
        }

        let duration_secs = duration_secs.clamp(3, 60);
        let read_int = |name: &str| -> Option<i64> {
            submit_get_property(name.into(), GetFormat::Int64)
                .ok()
                .and_then(|v| v.as_i64())
        };

        let initial_mode = current_present_mode().map(|m| m.name());
        let start_vo = read_int("frame-drop-count").unwrap_or(0);
        let start_dec = read_int("decoder-frame-drop-count").unwrap_or(0);
        let start_at = std::time::Instant::now();

        tokio::time::sleep(std::time::Duration::from_secs(duration_secs as u64))
            .await;

        let actual_secs = start_at.elapsed().as_secs_f64();
        let end_vo = read_int("frame-drop-count").unwrap_or(start_vo);
        let end_dec = read_int("decoder-frame-drop-count").unwrap_or(start_dec);
        let final_mode = current_present_mode().map(|m| m.name());

        let delta_vo = (end_vo - start_vo).max(0);
        let delta_dec = (end_dec - start_dec).max(0);
        let rate_vo = if actual_secs > 0.0 {
            delta_vo as f64 / actual_secs
        } else {
            0.0
        };
        let rate_dec = if actual_secs > 0.0 {
            delta_dec as f64 / actual_secs
        } else {
            0.0
        };

        // Heuristic verdict — coarse but useful at-a-glance.
        let verdict = if delta_vo == 0 && delta_dec == 0 {
            "clean"
        } else if rate_vo < 1.0 && rate_dec < 1.0 {
            "minor"
        } else {
            "drops"
        };

        Ok(json!({
            "duration_secs":             actual_secs,
            "initial_mode":              initial_mode,
            "final_mode":                final_mode,
            "start_drop_count_vo":       start_vo,
            "end_drop_count_vo":         end_vo,
            "delta_vo":                  delta_vo,
            "rate_vo":                   rate_vo,
            "start_drop_count_dec":      start_dec,
            "end_drop_count_dec":        end_dec,
            "delta_dec":                 delta_dec,
            "rate_dec":                  rate_dec,
            "verdict":                   verdict,
        }))
    }
}
