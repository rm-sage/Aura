// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Settings → Debug Stuff backend.
//!
//! Two Tauri commands that surface live engine + mpv + window state into
//! the frontend, and a timed drop-rate test the user can run while moving
//! Aura between foreground / visible-background / minimised to validate
//! the off-focus-drop behaviour empirically.
//!
//! All values come either from the [`crate::mpv2::engine`] published
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
    use crate::mpv2::engine::{submit_get_property, GetFormat};
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
    #[cfg(target_os = "windows")]
    let mpv2_active = crate::mpv2::engine::enabled();
    #[cfg(not(target_os = "windows"))]
    let mpv2_active = false;

    #[cfg(target_os = "windows")]
    let mpv2_running = crate::mpv2::engine::is_running();
    #[cfg(not(target_os = "windows"))]
    let mpv2_running = false;

    #[cfg(target_os = "windows")]
    let present_mode = crate::mpv2::engine::current_present_mode().map(|m| m.name());
    #[cfg(not(target_os = "windows"))]
    let present_mode: Option<&'static str> = None;

    let parent_hwnd: isize = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);

    let mpv = if mpv2_running { read_mpv_snapshot() } else { json!(null) };

    json!({
        "engine": {
            "mpv2_active":  mpv2_active,
            "mpv2_running": mpv2_running,
            "present_mode": present_mode,
        },
        "window": read_window_state(parent_hwnd),
        "mpv":    mpv,
    })
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
        use crate::mpv2::engine::{
            current_present_mode, enabled as engine_enabled, is_running, submit_get_property,
            GetFormat,
        };
        if !engine_enabled() || !is_running() {
            return Err(
                "debug_drop_test: mpv2 engine not running. Launch Aura with \
                 AURA_MPV2=1 and load a stream first."
                    .into(),
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
