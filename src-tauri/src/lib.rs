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
mod arc_align;
mod arc_art;
mod arcs;
mod auth;
mod backup;
// Casting (Chromecast CASTV2 + DLNA SOAP) — discovery, LAN media proxy,
// load/control. See cast/mod.rs.
mod cast;
mod cinema;
mod crash_reporting;
mod devlog;
mod log_export;
mod anime_id_map;
mod api_keyring;
mod media_controls;
// Direct-FFI libmpv layer — Aura's only playback path (engine + headless
// thumbnail instance). Replaced `tauri-plugin-libmpv` entirely; see
// mpv/mod.rs for the consolidation history.
mod debug_panel;
mod img_proxy;
// IPTV (Live TV) network hop — see src/iptv/ for the TS parsers.
mod iptv;
mod mpv;
mod oauth_callback;
mod popup_nav;
mod player;
mod publicmetadb;
mod ratings;
mod runtime_deps;
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
mod subsync;
mod subtitles;
mod sync;
mod tenrai;
mod theme_parse;
mod thumbs;
mod trailer;
mod tray;
#[cfg(target_os = "windows")]
mod win32;
mod window_logic;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Listener, Manager};

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
    // Optional forward proxy (per-playlist Live TV proxy) applied as a
    // per-file `http-proxy` loadfile option. None = direct.
    http_proxy: Option<String>,
    // Stream-name HDR labelling (frontend parseStream). Under the
    // "passthrough" HDR mode this routes the engine's per-load output
    // selection (PQ set for HDR-labelled streams, plain SDR otherwise)
    // — see the LoadFile arm in mpv::engine. None/false → SDR output.
    content_hdr_hint: Option<bool>,
    // Optional external audio URL for DASH trailers (1080p+ YouTube serves
    // video-only + audio-only streams). Applied as the `audio-files` option
    // before the loadfile; None for every normal stream (which clears any
    // stale value). See the LoadFile arm in mpv::engine.
    audio_url: Option<String>,
) -> Result<(), String> {
    let normalised = path.replace('\\', "/");
    // Defence in depth: only http(s) URLs, the localhost streaming
    // bridge, or magnet links may reach mpv from this command. The
    // intended renderer-trusted threat model still holds, but a
    // malicious or compromised addon manifest could theoretically
    // surface `file:///C:/…` in a stream record and reach here via JS
    // state. Reject anything that doesn't start with a known scheme so
    // such a value can't quietly cause mpv to open arbitrary local files.
    let allowed_prefix = ["http://", "https://", "127.0.0.1", "magnet:"]
        .iter()
        .any(|p| normalised.starts_with(p));
    if !allowed_prefix {
        return Err(format!(
            "load_video: rejected path with unsupported scheme: {}",
            crate::stremio::redact_sensitive_url(&normalised),
        ));
    }
    // Stream URLs frequently embed debrid API keys (TorBox `?api_key=…`,
    // Real-Debrid path tokens, etc.). The raw URL would otherwise land
    // verbatim in `aura-mpv.log` and the DevConsole ring buffer (which
    // is part of the Help → Export Logs surface). The helper masks the
    // well-known secret-bearing query params and path segments — see
    // `stremio::redact_sensitive_url`.
    crate::devlog!(
        info, "player",
        "load_video: {} (start={:?})",
        crate::stremio::redact_sensitive_url(&normalised),
        start_seconds,
    );
    // Route through the engine's command channel (the engine handles the
    // pre/post-loadfile pause clears and the `start=X` resume option
    // internally). The engine is spawned at setup; if it isn't running
    // (thread-spawn or HWND-resolution failure) this returns a clear
    // "engine not running" error instead of crashing.
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_load_file(normalised, start_seconds, http_proxy, content_hdr_hint, audio_url);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (normalised, start_seconds, http_proxy, content_hdr_hint, audio_url);
        Err("playback engine is Windows-only".into())
    }
}

#[tauri::command]
async fn stop_video() -> Result<(), String> {
    crate::devlog!(info, "player", "stop_video");
    // Tear down the warm headless thumbnail instance when leaving playback so
    // its libmpv core + open stream + demuxer cache don't sit resident while
    // idle. The next play's pre-warm (App.tsx) re-spawns it. Fire-and-forget,
    // off the async runtime (shutdown() does a bounded join).
    #[cfg(target_os = "windows")]
    {
        let _ = tauri::async_runtime::spawn_blocking(crate::mpv::thumb::shutdown);
        return mpv::engine::submit_command(vec!["stop".into()]);
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
}

#[tauri::command]
async fn toggle_pause() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_toggle_pause();
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
}

/// Keep the display + system awake while the player is active and unpaused.
/// The frontend invokes this on every `isPlayerActive && !paused` change.
/// The engine's pump thread reads this flag and asserts/releases
/// `SetThreadExecutionState`. mpv's own `stop-screensaver` also works
/// under `--wid` embedding (it owns a real window again), so this is
/// belt-and-suspenders driven by the UI's actual playback state. No-op on
/// non-Windows.
#[tauri::command]
fn set_keep_display_awake(enabled: bool) {
    #[cfg(target_os = "windows")]
    mpv::engine::set_display_awake_desired(enabled);
    #[cfg(not(target_os = "windows"))]
    { let _ = enabled; }
}

#[tauri::command]
async fn seek_relative(seconds: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_command(vec![
        "seek".into(),
        format!("{seconds}"),
        "relative".into(),
    ]);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = seconds;
        Err("playback engine is Windows-only".into())
    }
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
async fn frame_step(forward: bool) -> Result<(), String> {
    let cmd = if forward { "frame-step" } else { "frame-back-step" };
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_command(vec![cmd.into()]);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cmd;
        Err("playback engine is Windows-only".into())
    }
}

/// Toggle loudness normalization on the audio filter chain — a single
/// `dynaudnorm` pass labelled `@loudnorm` that levels the volume
/// disparity between streams from different sources.
///
/// Why `dynaudnorm` and not `loudnorm` (EBU R128): the `loudnorm` filter
/// keeps a gating / lookahead window and RESETS it on a timestamp
/// discontinuity, so every seek — most visibly an OP/ED SKIP — replays a
/// few seconds at near-unity gain (a loud blast) until it re-converges.
/// That was the "loudness normalization breaks after a skip" report.
/// `dynaudnorm` derives a Gaussian-smoothed per-frame gain with no
/// cross-seek state, so it survives skips cleanly; it is the standard
/// mpv realtime leveller for exactly this reason.
///
/// Implementation notes (from a stream-silencing regression):
///   • Mutate the chain incrementally with `af add` / `af remove`, never
///     `set af "…"`. The latter REPLACES the entire filter graph in-place
///     during playback, which on this libmpv build re-inits the audio
///     output and frequently leaves it muted or with no track selected
///     (the graph rebuilds before the aid dispatch can reattach).
///   • The `@loudnorm` label selects our filter for removal. `af remove`
///     is a harmless no-op (mpv logs "label not found") when it isn't
///     present, so remove-then-add stays idempotent regardless of state.
///
/// Soft no-op when audio passthrough is on (bitstream output bypasses
/// the filter graph entirely). The UI prevents this at the toggle
/// level but the Rust side is the source of truth — defence in depth.
#[tauri::command]
async fn set_audio_loudnorm(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::devlog!(info, "player", "set_audio_loudnorm(enabled={enabled})");
    // Mirror the toggle into backend settings so the NEXT engine init
    // installs the filter via the initial `af` option — in the chain
    // before the first audio frame of the first loadfile, which is what
    // makes the normalized level consistent on initial load (the old
    // add-after-load flow only took reliable effect after a seek forced
    // an audio-chain rebuild). The frontend `auraSettings` flag remains
    // the user-facing source of truth; this is its applied mirror.
    {
        let mut s = settings::snapshot();
        if s.loudness_normalization != enabled {
            s.loudness_normalization = enabled;
            let _ = settings::save(&app, &s);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        return Err("playback engine is Windows-only".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Live-toggle path for the RUNNING instance. Remove-first so
        // repeat calls don't stack duplicate labelled filters; `remove`
        // is a no-op when the label isn't present. Each step is a
        // separate engine command — the channel drains them in order
        // within one pump tick.
        let _ = mpv::engine::submit_command(vec![
            "af".into(), "remove".into(), "@loudnorm".into(),
        ]);
        if enabled {
            return mpv::engine::submit_command(vec![
                "af".into(),
                "add".into(),
                "@loudnorm:dynaudnorm=f=200:g=15".into(),
            ]);
        }
        Ok(())
    }
}

/// Motion interpolation — mpv's BUILT-IN GPU frame interpolation.
///
/// `video-sync=display-resample` retimes frames to the display refresh
/// and `interpolation=yes` blends across them via `tscale`. `oversample`
/// is the community "smooth motion" default: sharp, minimal blur,
/// frame-rate-conversion-like — the best judder-free-panning result on
/// a high-refresh display, and it runs on the GPU (Aura already uses
/// `vo=gpu-next`) so it's effectively free.
///
/// History: the ffmpeg `minterpolate` vf was tried first, but `mi_mode=
/// mci` is far too CPU-heavy to sustain real-time (estimated-vf-fps
/// never left source rate — every interpolated frame was dropped). The
/// svpflow / RIFE-via-VapourSynth path was dropped at the user's
/// request. This GPU path is the one to dial in.
///
/// Direct `set_property` FFI — NOT `command("set_property", …)` (that's
/// the silent-no-op landmine #1). These are persistent per-instance mpv
/// options, so App.tsx re-firing this on every `load_video` is
/// idempotent. Tunable knobs for "dialing in": `tscale` (oversample /
/// mitchell / catmull_rom / box …), `video-sync`
/// (display-resample / display-resample-vdrop …).
#[tauri::command]
async fn set_motion_interpolation(
    enabled: bool,
    tscale: Option<String>,
) -> Result<(), String> {
    crate::devlog!(info, "player", "set_motion_interpolation(enabled={enabled}, tscale={tscale:?})");
    // Kernel allow-list — anything else collapses to the mitchell default.
    let kernel: String = if enabled {
        match tscale.as_deref() {
            Some(k @ ("oversample" | "linear" | "catmull_rom"
                      | "mitchell" | "gaussian" | "bicubic")) => k.to_string(),
            _ => "mitchell".to_string(),
        }
    } else {
        String::new()
    };
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::PropValue;
        if enabled {
            // Pin the display FPS before flipping to display-resample.
            // In `--wid` embedded mode mpv can't reliably measure the
            // display's refresh (it owns no top-level window); a
            // mis-estimated display FPS makes display-resample retime
            // video against the wrong clock — severe constant frame
            // drops the moment interpolation engages. The true refresh
            // of the monitor the window sits on removes the guesswork.
            if let Some(hz) = mpv::engine::parent_display_refresh_hz() {
                let _ = mpv::engine::submit_set_property(
                    "display-fps-override".into(),
                    PropValue::Double(hz),
                );
                crate::devlog!(
                    info, "player",
                    "display-fps-override={hz} (measured monitor refresh)"
                );
            }
            // video-sync must flip to a display mode BEFORE interpolation.
            mpv::engine::submit_set_property(
                "video-sync".into(),
                PropValue::String("display-resample".into()),
            )?;
            mpv::engine::submit_set_property(
                "tscale".into(),
                PropValue::String(kernel.clone()),
            )?;
            mpv::engine::submit_set_property(
                "interpolation".into(),
                PropValue::Flag(true),
            )?;
            crate::devlog!(
                info, "player",
                "motion interpolation ON (video-sync=display-resample, tscale={kernel})"
            );
        } else {
            mpv::engine::submit_set_property(
                "interpolation".into(),
                PropValue::Flag(false),
            )?;
            mpv::engine::submit_set_property(
                "video-sync".into(),
                PropValue::String("audio".into()),
            )?;
            // Back to automatic display-FPS detection (0 = auto) so the
            // pinned value can't go stale if the user moves the window
            // to another monitor while interpolation is off.
            let _ = mpv::engine::submit_set_property(
                "display-fps-override".into(),
                PropValue::Double(0.0),
            );
            crate::devlog!(info, "player", "motion interpolation OFF");
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = kernel;
        Err("playback engine is Windows-only".into())
    }
}

#[tauri::command]
async fn set_volume(volume: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_volume({volume})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_volume(volume);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = volume;
        Err("playback engine is Windows-only".into())
    }
}

/// Save a screenshot of the CURRENT frame.
///
/// Saved to the user's configured `screenshot_dir` (Settings), or
/// `app_data_dir()/screenshots` when that is empty. Uses mpv's `window` mode so
/// the PNG is the gpu-next RENDERED output: HDR is tonemapped to SDR exactly as
/// it appears on screen. (The `video` / `subtitles` modes dump a raw PQ frame
/// that looks washed-out / wrong in a normal image viewer.) Whatever is
/// currently rendered into the window is captured, so any visible subtitles are
/// included. Returns the saved file path; the write happens just after the
/// command is queued, so the caller should treat the path as "where it will
/// land" rather than a guaranteed-existing file.
#[tauri::command]
async fn save_screenshot<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<String, String> {
    use tauri::Manager;
    // Configured directory wins; fall back to app_data_dir/screenshots. A bad
    // custom dir (create_dir_all fails) falls back too, so a stale path can
    // never silently swallow the screenshot.
    let configured = settings::snapshot().screenshot_dir.trim().to_string();
    let dir = if !configured.is_empty()
        && std::fs::create_dir_all(&configured).is_ok()
    {
        std::path::PathBuf::from(configured)
    } else {
        // Default: the user's Pictures library under an "Aura" subfolder
        // (Pictures/Aura), so screenshots land somewhere obvious instead of
        // buried in AppData. Fall back to app_data_dir/screenshots only if
        // the Pictures known-folder can't be resolved or created.
        let pictures = app
            .path()
            .picture_dir()
            .ok()
            .map(|p| p.join("Aura"))
            .filter(|p| std::fs::create_dir_all(p).is_ok());
        match pictures {
            Some(p) => p,
            None => {
                let fallback = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| e.to_string())?
                    .join("screenshots");
                std::fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
                fallback
            }
        }
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path_str = dir.join(format!("aura-{stamp}.png")).to_string_lossy().to_string();
    crate::devlog!(info, "player", "save_screenshot → {path_str}");
    #[cfg(target_os = "windows")]
    {
        crate::mpv::engine::submit_command(vec![
            "screenshot-to-file".into(),
            path_str.clone(),
            "window".into(),
        ])?;
        Ok(path_str)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path_str;
        Err("playback engine is Windows-only".into())
    }
}

/// Set one of mpv's video-equalizer properties (brightness / contrast /
/// saturation / gamma / hue), each an integer -100..100 with 0 = neutral. These
/// are display-space VO controls (independent of the HDR tonemap), used to
/// rescue a washed-out or too-dark encode. Whitelisted so an arbitrary property
/// name can never be written. NB: mpv keeps these for the SESSION (they don't
/// reset per file), so the player UI offers a reset.
#[tauri::command]
async fn set_video_eq(prop: String, value: i64) -> Result<(), String> {
    const ALLOWED: [&str; 5] = ["brightness", "contrast", "saturation", "gamma", "hue"];
    if !ALLOWED.contains(&prop.as_str()) {
        return Err(format!("unknown video-eq property: {prop}"));
    }
    let v = value.clamp(-100, 100);
    crate::devlog!(info, "player", "set_video_eq({prop}={v})");
    #[cfg(target_os = "windows")]
    return crate::mpv::engine::submit_set_property(prop, crate::mpv::engine::PropValue::Int64(v));
    #[cfg(not(target_os = "windows"))]
    {
        let _ = v;
        Err("playback engine is Windows-only".into())
    }
}

/// Push the user's playback-buffer tuning (Settings) to the live mpv engine:
/// cache-secs, demuxer-readahead-secs, and demuxer-max-bytes (from MiB). Called
/// on app start AND whenever the user changes a buffer setting, so a change
/// takes effect on the next stream load without an app restart. Values clamped
/// to sane ranges; pushed as strings (mpv parses each to its property type, like
/// the INIT_OPTS defaults). Best-effort per property.
#[tauri::command]
async fn apply_buffer_settings(cache_secs: u32, readahead_secs: u32, max_mib: u32) -> Result<(), String> {
    let cs = cache_secs.clamp(10, 1800);
    let ra = readahead_secs.clamp(5, 1800);
    let mb = (max_mib.clamp(64, 4096) as u64) * 1024 * 1024;
    crate::devlog!(info, "player", "apply_buffer_settings cache-secs={cs} readahead={ra} max-bytes={mb}");
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::PropValue;
        let _ = mpv::engine::submit_set_property("cache-secs".into(), PropValue::String(cs.to_string()));
        let _ = mpv::engine::submit_set_property("demuxer-readahead-secs".into(), PropValue::String(ra.to_string()));
        let _ = mpv::engine::submit_set_property("demuxer-max-bytes".into(), PropValue::String(mb.to_string()));
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (cs, ra, mb);
        Err("playback engine is Windows-only".into())
    }
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
    name: String,
    format: String,
) -> Result<serde_json::Value, String> {
    if format.eq_ignore_ascii_case("node") {
        return Err("get_property: format=node is unsafe on this libmpv build (landmine #3)".into());
    }
    if name == "track-list" {
        return Err("get_property: track-list reads must go through get_tracks (landmine #3)".into());
    }
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::GetFormat;
        let fmt = match format.to_lowercase().as_str() {
            "flag" => GetFormat::Flag,
            "int64" => GetFormat::Int64,
            "double" => GetFormat::Double,
            "string" => GetFormat::String,
            other => return Err(format!(
                "get_property: unsupported format '{other}'"
            )),
        };
        // The engine's reply channel blocks; keep off the Tauri runtime.
        tauri::async_runtime::spawn_blocking(move || {
            mpv::engine::submit_get_property(name, fmt)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
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
    is_fullscreen: Option<bool>,
) -> Result<(), String> {
    // The engine tracks the parent's client rect + fullscreen state every
    // pump tick and owns all geometry (host window + mpv's inner child),
    // so this command no longer drives SetWindowPos. `is_fullscreen` is
    // accepted (the frontend still passes it) but unused.
    let _ = is_fullscreen;
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::PropValue;
        // The video-zoom toggle is mpv's documented "force a re-render"
        // trick — nudges the renderer out of a held stale frame.
        let _ = mpv::engine::submit_set_property(
            "video-zoom".into(), PropValue::Double(0.0001),
        );
        let _ = mpv::engine::submit_set_property(
            "video-zoom".into(), PropValue::Double(0.0),
        );
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
}

#[tauri::command]
async fn set_speed(speed: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_speed({speed})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "speed".into(),
        mpv::engine::PropValue::Double(speed),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = speed;
        Err("playback engine is Windows-only".into())
    }
}

#[tauri::command]
async fn seek_absolute(time: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_command(vec![
        "seek".into(),
        format!("{time}"),
        "absolute".into(),
    ]);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = time;
        Err("playback engine is Windows-only".into())
    }
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

/// Translate a `serde_json::Value` into the mpv engine's typed
/// [`mpv::engine::PropValue`]. Used by the handlers that build their
/// property writes as JSON values (HDR options, subtitle styling, …)
/// before deciding to route through the engine. `null` and structured
/// (`Array` / `Object`) values can't be sent — mpv has no NODE-format
/// setter in our typed enum, and Aura's HDR/sub option maps only ever
/// emit scalars. Returns `None` for those so the caller can log and
/// skip rather than send a wrong-format value mpv would reject anyway.
#[cfg(target_os = "windows")]
fn json_to_propvalue(value: &serde_json::Value) -> Option<mpv::engine::PropValue> {
    use mpv::engine::PropValue;
    match value {
        serde_json::Value::Bool(b) => Some(PropValue::Flag(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(PropValue::Int64(i))
            } else {
                n.as_f64().map(PropValue::Double)
            }
        }
        serde_json::Value::String(s) => Some(PropValue::String(s.clone())),
        _ => None,
    }
}

#[tauri::command]
async fn set_audio_track(track: serde_json::Value) -> Result<(), String> {
    crate::devlog!(info, "player", "set_audio_track({track})");
    let Some(track_str) = track_value_as_string(&track) else {
        return Err(format!("invalid track value: {track}"));
    };
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "aid".into(),
        mpv::engine::PropValue::String(track_str),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = track_str;
        Err("playback engine is Windows-only".into())
    }
}

/// Nudge audio sync forward or backward relative to the video stream.
/// Wraps MPV's `audio-delay` property (seconds, f64). Positive values
/// delay the audio; negative values advance it. Clamped to ±10 s to
/// keep the UI's number input from accepting absurd inputs that would
/// confuse the user — beyond that range the user almost certainly
/// has a worse problem than mistimed audio.
#[tauri::command]
async fn set_audio_delay(seconds: f64) -> Result<(), String> {
    let clamped = seconds.clamp(-10.0, 10.0);
    crate::devlog!(info, "player", "set_audio_delay({clamped:.3})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "audio-delay".into(),
        mpv::engine::PropValue::Double(clamped),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = clamped;
        Err("playback engine is Windows-only".into())
    }
}

/// Nudge subtitle sync forward or backward. Wraps MPV's `sub-delay`
/// property (seconds, f64). Positive = subs appear later; negative =
/// subs appear earlier.
///
/// The clamp is ±120 s, deliberately far wider than `set_audio_delay`'s ±10 s.
/// An audio delay past 10 s means the user has a worse problem than mistiming,
/// but a SUBTITLE file grabbed for a different release routinely sits tens of
/// seconds out (a different intro cut, a broadcast-vs-web master), and Live
/// Sync exists precisely to fix those. The old ±10 s clamp silently truncated
/// exactly the corrections the feature was built to apply.
#[tauri::command]
async fn set_subtitle_delay(seconds: f64) -> Result<(), String> {
    let clamped = seconds.clamp(-120.0, 120.0);
    crate::devlog!(info, "player", "set_subtitle_delay({clamped:.3})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "sub-delay".into(),
        mpv::engine::PropValue::Double(clamped),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = clamped;
        Err("playback engine is Windows-only".into())
    }
}

/// Scale subtitle timestamps. Wraps MPV's `sub-speed` (a multiplier applied to
/// every cue time, text subs only).
///
/// This is what a constant `sub-delay` cannot fix: subtitles authored against a
/// different framerate are correct at the start and progressively wrong by the
/// end. Live Sync's two-point mode solves for delay AND speed from two anchor
/// lines and writes both.
///
/// Clamped to 0.5..2.0. Real framerate mismatches live in a narrow band around
/// 1.0 (25 / 23.976 = 1.043, its inverse = 0.959); anything outside this range
/// is a solve gone wrong, not a real correction, and would scramble the track.
#[tauri::command]
async fn set_subtitle_speed(speed: f64) -> Result<(), String> {
    let clamped = if speed.is_finite() { speed.clamp(0.5, 2.0) } else { 1.0 };
    crate::devlog!(info, "player", "set_subtitle_speed({clamped:.5})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "sub-speed".into(),
        mpv::engine::PropValue::Double(clamped),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = clamped;
        Err("playback engine is Windows-only".into())
    }
}

#[tauri::command]
async fn set_subtitle_track(track: serde_json::Value) -> Result<(), String> {
    crate::devlog!(info, "player", "set_subtitle_track({track})");
    let Some(track_str) = track_value_as_string(&track) else {
        return Err(format!("invalid track value: {track}"));
    };
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "sid".into(),
        mpv::engine::PropValue::String(track_str),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = track_str;
        Err("playback engine is Windows-only".into())
    }
}

/// Toggle subtitle visibility entirely. The dropdown's "Off" entry uses this
/// (vs. set_subtitle_track="no") because some libmpv builds reject "no" on
/// `sid` after a sub-add but happily honour `sub-visibility=no`.
#[tauri::command]
async fn set_subtitle_visibility(visible: bool) -> Result<(), String> {
    crate::devlog!(info, "player", "set_subtitle_visibility({visible})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "sub-visibility".into(),
        mpv::engine::PropValue::Flag(visible),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = visible;
        Err("playback engine is Windows-only".into())
    }
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
async fn set_panscan(value: f64) -> Result<(), String> {
    crate::devlog!(info, "player", "set_panscan({value})");
    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "panscan".into(),
        mpv::engine::PropValue::Double(value),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = value;
        Err("playback engine is Windows-only".into())
    }
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
    /// The file path or URL backing an external track (mpv's
    /// `track-list/N/external-filename`). `None` for container-embedded tracks.
    ///
    /// Without this, `external: true` tells you a track came from `sub-add` but
    /// NOT what it came from: an OpenSubtitles download's local path is thrown
    /// away by the picker after `add_subtitle_to_mpv`, and an addon sub's URL is
    /// only recoverable by title-matching back into the addon list. Live Sync
    /// needs the actual source to read the cue text, so we read the one
    /// subproperty that answers it.
    external_filename: Option<String>,
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
async fn get_tracks() -> Result<Vec<TrackEntry>, String> {
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::GetFormat;
        return tauri::async_runtime::spawn_blocking(move || {
            // Read count first; bail early on a 0-track stream rather
            // than spinning N empty rows.
            let count = mpv::engine::submit_get_property(
                "track-list/count".into(), GetFormat::Int64,
            )
            .ok()
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .min(64);
            if count <= 0 {
                return Ok::<Vec<TrackEntry>, String>(Vec::new());
            }
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let id = mpv::engine::submit_get_property(
                    format!("track-list/{}/id", i), GetFormat::Int64,
                ).ok().and_then(|v| v.as_i64()).unwrap_or(0);
                let track_type = mpv::engine::submit_get_property(
                    format!("track-list/{}/type", i), GetFormat::String,
                ).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                let title = mpv::engine::submit_get_property(
                    format!("track-list/{}/title", i), GetFormat::String,
                ).ok().and_then(|v| v.as_str().map(String::from));
                let lang = mpv::engine::submit_get_property(
                    format!("track-list/{}/lang", i), GetFormat::String,
                ).ok().and_then(|v| v.as_str().map(String::from));
                let selected = mpv::engine::submit_get_property(
                    format!("track-list/{}/selected", i), GetFormat::Flag,
                ).ok().and_then(|v| v.as_bool()).unwrap_or(false);
                let external = mpv::engine::submit_get_property(
                    format!("track-list/{}/external", i), GetFormat::Flag,
                ).ok().and_then(|v| v.as_bool()).unwrap_or(false);
                let codec = mpv::engine::submit_get_property(
                    format!("track-list/{}/codec", i), GetFormat::String,
                ).ok().and_then(|v| v.as_str().map(String::from));
                // Same typed-String path as title / lang / codec above, so this
                // carries no new crash surface (the node-format read is the one
                // that faults, and we never do that).
                let external_filename = mpv::engine::submit_get_property(
                    format!("track-list/{}/external-filename", i), GetFormat::String,
                ).ok().and_then(|v| v.as_str().map(String::from))
                 .filter(|s| !s.is_empty());
                out.push(TrackEntry {
                    id, track_type, title, lang, selected, external, codec,
                    external_filename,
                });
            }
            Ok::<Vec<TrackEntry>, String>(out)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
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

    // Persist so next MPV init picks it up — skipping the disk write when
    // nothing changed. Keep the legacy hdr_enabled boolean in lockstep so
    // old code paths reading it (Discord RPC, telemetry, etc.) stay
    // coherent: "off" → false, anything else → true.
    let mut s = settings::snapshot();
    if s.hdr_mode != mode_norm || s.hdr_enabled != (mode_norm != "off") {
        s.hdr_mode = mode_norm.clone();
        s.hdr_enabled = mode_norm != "off";
        settings::save(&app, &s)?;
    }

    #[cfg(target_os = "windows")]
    {
        // Build a fresh option map with this mode's properties and push
        // each one to the engine. apply_hdr_options writes a stable set
        // of keys so previous values from a different mode get
        // overwritten — no residual property drift between toggles.
        // Best-effort per property: anything mpv rejects is devlog'd
        // rather than aborting the rest of the block.
        //
        // NOTE: this full-set push is for explicit Settings changes
        // ONLY — never call it per-load or mid-playback as routine.
        // Rewriting colorspace plumbing on a live gpu-next d3d11
        // pipeline forces a swapchain renegotiation that has been
        // observed to leave the output blown out / mis-encoded. The HDR
        // modes are designed to be fully static per mode (see
        // player::apply_hdr_options) precisely so nothing needs to
        // change per content. A mode change mid-playback may only take
        // full effect (swapchain colorspace) on the next loadfile.
        let mut opts: indexmap::IndexMap<String, serde_json::Value> = indexmap::IndexMap::new();
        crate::player::apply_hdr_options(
            &mut opts,
            &mode_norm,
            settings::snapshot().hdr_target_peak_nits,
        );
        for (key, value) in opts.iter() {
            if let Some(pv) = json_to_propvalue(value) {
                if let Err(e) = mpv::engine::submit_set_property(key.clone(), pv) {
                    crate::devlog!(warn, "player", "apply_hdr {key}={value:?} → {e}");
                }
            } else {
                crate::devlog!(
                    warn, "player",
                    "apply_hdr {key}={value:?} → unsupported JSON shape for PropValue",
                );
            }
        }

        // Re-evaluate the MPO poison: it's gated on hdr_mode=="passthrough",
        // so toggling the mode here must apply (passthrough) or clear (other)
        // the window region without waiting for a restart.
        if let Some(hwnd) = app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
            win32::apply_mpo_poison(hwnd.0 as isize);
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
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
/// Frontend probe: is this Windows 10 (build < 22000) rather than Windows 11?
/// `TitleBar.tsx` reads this once at mount to decide the drag strategy — Win10
/// gets the custom coalesced pointer-drag (the native caption-drag modal loop
/// stalls on Win10's DWM + weak GPUs), Win11 keeps native `startDragging`
/// (and Aero Snap). See `win32::is_windows_10`.
#[tauri::command]
fn is_windows_10() -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::win32::is_windows_10()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

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
        //
        // The engine tracks `win32::is_in_native_fullscreen()` + the
        // parent's client rect every pump tick, so the host window and
        // mpv's child snap to the new geometry within ~5 ms of the
        // parent restyle — no explicit resize calls needed here.
        let p = parent_hwnd;
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            if enabled {
                win32::enter_native_fullscreen(p)?;
            } else {
                win32::exit_native_fullscreen(p)?;
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
    is_anime: bool,
) -> Result<(), String> {
    let _ = is_anime;
    let s = settings::snapshot();
    let subs = s.subtitle_language.clone();

    #[cfg(target_os = "windows")]
    return mpv::engine::submit_set_property(
        "slang".into(),
        mpv::engine::PropValue::String(subs),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = subs;
        Err("playback engine is Windows-only".into())
    }
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
///
/// `subtitle_brightness` (0-100) scales the glyph RGB so white subs don't sear
/// at peak nits on HDR / OLED, alpha preserved.
///
/// Scale the RGB channels of an mpv `#RRGGBB` / `#RRGGBBAA` colour by
/// `brightness`/100 (alpha kept). Returns the input unchanged at 100 / on a
/// malformed value, so a bad setting can never blank the subtitles.
fn dim_sub_color(color: &str, brightness: u32) -> String {
    if brightness >= 100 {
        return color.to_string();
    }
    let f = (brightness as f64 / 100.0).clamp(0.0, 1.0);
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 && hex.len() != 8 {
        return color.to_string();
    }
    let rgb = &hex[0..6];
    let tail = &hex[6..]; // "" (RRGGBB) or alpha "AA" (RRGGBBAA)
    let parse = |s: &str| u8::from_str_radix(s, 16).ok();
    let (Some(r), Some(g), Some(b)) = (parse(&rgb[0..2]), parse(&rgb[2..4]), parse(&rgb[4..6])) else {
        return color.to_string();
    };
    let scale = |c: u8| ((c as f64) * f).round() as u8;
    format!("#{:02X}{:02X}{:02X}{}", scale(r), scale(g), scale(b), tail)
}

#[tauri::command]
async fn apply_subtitle_style() -> Result<(), String> {
    let s = settings::snapshot();
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::PropValue;
        // Best-effort per property — same intent as the legacy block.
        // The engine reports errors via devlog (`warn` lines), so an
        // unsupported property doesn't abort the rest of the block.
        let _ = mpv::engine::submit_set_property(
            "sub-font-size".into(), PropValue::Int64(s.subtitle_font_size as i64),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-margin-y".into(), PropValue::Int64(0),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-ass-force-margins".into(), PropValue::String("yes".into()),
        );
        // `sub-ass-override` is the modern property name; the legacy
        // `ass-style-override` alias was dropped — it doesn't exist on this
        // libmpv build and only spammed a "-8 property not found" warning on
        // every load (this line set it right before the working one below).
        let _ = mpv::engine::submit_set_property(
            "sub-ass-override".into(), PropValue::String("force".into()),
        );
        // sub-pos as Int64 first; if mpv rejects an integer cast on this
        // build, the engine will log a warning and the next call (sub-pos
        // as String) is the fallback.
        let _ = mpv::engine::submit_set_property(
            "sub-pos".into(), PropValue::Int64(s.subtitle_position as i64),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-pos".into(), PropValue::String(s.subtitle_position.to_string()),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-border-size".into(), PropValue::Int64(s.subtitle_border_size as i64),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-color".into(),
            PropValue::String(dim_sub_color(&s.subtitle_color, s.subtitle_brightness)),
        );
        let _ = mpv::engine::submit_set_property(
            "sub-back-color".into(), PropValue::String(s.subtitle_back_color.clone()),
        );
        if !s.subtitle_font.trim().is_empty() {
            let _ = mpv::engine::submit_set_property(
                "sub-font".into(),
                PropValue::String(s.subtitle_font.trim().to_string()),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    Err("playback engine is Windows-only".into())
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
async fn set_subtitle_position_runtime(percent: u32) -> Result<(), String> {
    let pct = percent.clamp(0, 150);
    #[cfg(target_os = "windows")]
    {
        use mpv::engine::PropValue;
        // Try Int64 then String — mpv builds vary on which format
        // `sub-pos` accepts post-loadfile.
        if mpv::engine::submit_set_property(
            "sub-pos".into(), PropValue::Int64(pct as i64),
        ).is_err() {
            let _ = mpv::engine::submit_set_property(
                "sub-pos".into(), PropValue::String(pct.to_string()),
            );
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pct;
        Err("playback engine is Windows-only".into())
    }
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
    // Dev gate: debug builds (cargo build without --release, which is
    // what `pnpm tauri dev` produces) never ship events to the
    // production Sentry project. HMR reloads, intentional panics
    // during local debugging, and noisy work-in-progress code paths
    // would otherwise flood Issues. To exercise the real Sentry path
    // locally, build a release binary (`pnpm tauri build`) — that
    // still respects the user-consent flag below. Mirrors the
    // `import.meta.env.DEV` gate on the JS side in `main.tsx`.
    if cfg!(debug_assertions) {
        return None;
    }
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

/// Remove binaries that older Aura versions bundled but that are no longer
/// used. Tauri's NSIS updater overlays the new fileset without deleting files
/// the previous installer placed, so these linger in the install dir as dead
/// weight after an update (e.g. the ~115 MB `mpv.dll`, a redundant duplicate of
/// `libmpv-2.dll`, and the legacy `libmpv-wrapper.dll`). Best-effort: a failed
/// delete (file in use / already gone / no permission) is logged and ignored.
/// Mirrors the resolver search order (resource_dir/lib + exe_dir/lib). Extend
/// `ORPHANS` as binaries move out of the bundle to on-demand download.
///
/// Release-only: in dev, `resource_dir`/`current_exe` can resolve into the
/// source tree, and we must never delete the developer's git-ignored `lib/`.
#[cfg(not(debug_assertions))]
fn cleanup_orphaned_binaries<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    const ORPHANS: &[&str] = &["mpv.dll", "libmpv-wrapper.dll"];

    let mut lib_dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        lib_dirs.push(dir.join("lib"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            lib_dirs.push(dir.join("lib"));
        }
    }

    for dir in &lib_dirs {
        for name in ORPHANS {
            let path = dir.join(name);
            if path.is_file() {
                match std::fs::remove_file(&path) {
                    Ok(()) => crate::devlog!(info, "lib", "cleaned orphaned binary {}", path.display()),
                    Err(e) => crate::devlog!(warn, "lib", "could not remove orphaned {}: {e}", path.display()),
                }
            }
        }
    }
}

/// Start the mpv playback engine if it isn't already running AND libmpv is
/// resolvable (a copy left by a prior install, one downloaded on-demand, or a
/// system one). Idempotent; returns whether the engine is running afterwards.
/// On a fresh install with no libmpv yet it returns `false` WITHOUT aborting —
/// the frontend first-run gate (PlaybackEngineGate) downloads libmpv and then
/// calls `ensure_playback_engine` to retry. Mirrors the original setup wiring
/// (parent HWND + the `mpv-event-main` emit channel).
#[cfg(target_os = "windows")]
fn try_start_playback_engine<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::{Emitter, Manager};
    if mpv::engine::is_running() {
        return true;
    }
    if let Err(e) = player::check_mpv_dll() {
        crate::devlog!(info, "player", "libmpv not resolvable yet ({e}) — engine not started");
        return false;
    }
    if mpv::engine::legacy_env_requested() {
        crate::devlog!(
            warn, "player",
            "AURA_MPV2 is set to an off value, but the legacy --wid plugin path \
             it used to select was removed in the engine consolidation — ignored",
        );
    }
    let parent_hwnd: isize = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .unwrap_or(0);
    let emit_handle = app.clone();
    mpv::engine::start(
        parent_hwnd,
        Box::new(move |name, payload| {
            let mut wrapped = serde_json::Map::new();
            wrapped.insert("name".into(), serde_json::Value::String(name.to_string()));
            wrapped.insert("data".into(), payload);
            let _ = emit_handle.emit("mpv-event-main", serde_json::Value::Object(wrapped));
        }),
    );
    let running = mpv::engine::is_running();
    if running {
        crate::devlog!(info, "player", "mpv engine spawn requested");
    }
    running
}

#[cfg(not(target_os = "windows"))]
fn try_start_playback_engine<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> bool {
    false
}

/// True when the mpv playback engine is running (libmpv loaded). The frontend
/// first-run gate polls this to decide whether to download libmpv. Non-Windows
/// returns `true` — there is no Windows libmpv to fetch there, so the gate is
/// skipped (the Linux engine, when present, sources libmpv from the system).
#[tauri::command]
fn playback_engine_ready() -> bool {
    #[cfg(target_os = "windows")]
    {
        mpv::engine::is_running()
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// (Re)start the playback engine after the first-run gate has downloaded libmpv.
/// Returns whether the engine is running afterwards.
#[tauri::command]
fn ensure_playback_engine<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
    try_start_playback_engine(&app)
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

            // ── Orphaned-binary cleanup (release only) ─────────────────────
            // Delete binaries older versions bundled that are now unused, so an
            // update doesn't leave dead weight behind in the install dir. See
            // cleanup_orphaned_binaries for the rationale and the orphan list.
            #[cfg(not(debug_assertions))]
            cleanup_orphaned_binaries(app.handle());

            // ── On-demand runtime binaries ─────────────────────────────────
            // Resolve <app_local_data>/runtime (survives updates) so the
            // ffmpeg/ffprobe resolvers can find a previously-downloaded copy.
            runtime_deps::init(app.handle());

            // ── API key migration: settings.json → OS keyring ──
            // One-shot per launch. Moves the plaintext OpenSubtitles
            // key from settings.json into the keyring (DPAPI / Keychain
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
                    // MPO "poison pill": when hdr_mode==passthrough, give the
                    // top-level window a non-rectangular region so Windows
                    // can't promote the MPV child swapchain to direct scanout
                    // (fixes the QD-OLED raised-black-in-HDR behaviour without
                    // disabling MPO globally). No-op for SDR / off. Re-applied
                    // on HDR-settings change + fullscreen transitions.
                    win32::apply_mpo_poison(parent_hwnd);
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
            // Opt the process out of Windows background timer/priority
            // throttling BEFORE MPV starts, as defense-in-depth for off-focus
            // playback. See win32::pin_process_scheduling: touches no MPV
            // property or window (clear of every MPV stability landmine).
            // NB: the severe off-focus drops once blamed on this throttle
            // (the "20-60 dropped fps with interpolation" reports) were
            // actually the NVIDIA "Background Application Max Frame Rate"
            // driver setting capping aura.exe when unfocused (per-machine
            // config), not this. This opt-out is kept but was not the fix.
            #[cfg(target_os = "windows")]
            {
                win32::pin_process_scheduling();
            }

            // Persist the addon-manifest cache across launches. Reads
            // the existing JSON file (if any), warms the in-memory map
            // with anything <24 h old, and stores the path so subsequent
            // cache writes mirror to disk. Best-effort: a missing /
            // unreadable / wrong-version file just leaves us with an
            // empty cache, identical to pre-persistence behaviour.
            // Skipping the manifest cache when app_data_dir resolution
            // fails is fine too — Tauri's path resolver almost never
            // fails on Windows, but the in-memory cache still works.
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                let cache_path = data_dir.join("manifest-cache.json");
                crate::stremio::init_manifest_cache_path(cache_path);
            }

            // ── Playback engine (mpv — FFI --wid embedding) ──────────────
            // Started here when libmpv is resolvable: an update keeps the prior
            // version's libmpv-2.dll in the install dir, so the engine starts
            // immediately. On a FRESH install (libmpv no longer bundled) this is
            // a no-op — the frontend first-run gate (PlaybackEngineGate)
            // downloads libmpv then calls `ensure_playback_engine`. See
            // try_start_playback_engine for the event-channel wiring.
            if !try_start_playback_engine(app.handle()) {
                crate::devlog!(
                    info, "player",
                    "playback engine deferred — libmpv not available yet (first-run download will fetch it)",
                );
            }

            // Apply the user's persisted playback-buffer tuning to the engine,
            // overriding the INIT_OPTS defaults. Queued; the engine applies it
            // after init. Mirrors the apply_buffer_settings command (which the
            // Settings UI calls on a live change).
            #[cfg(target_os = "windows")]
            {
                use mpv::engine::PropValue;
                let s = settings::snapshot();
                let _ = mpv::engine::submit_set_property("cache-secs".into(), PropValue::String(s.cache_secs.clamp(10, 1800).to_string()));
                let _ = mpv::engine::submit_set_property("demuxer-readahead-secs".into(), PropValue::String(s.demuxer_readahead_secs.clamp(5, 1800).to_string()));
                let _ = mpv::engine::submit_set_property("demuxer-max-bytes".into(), PropValue::String(((s.demuxer_max_mib.clamp(64, 4096) as u64) * 1024 * 1024).to_string()));
            }

            // ── Window lifecycle (pause-on-blur, pause-on-min, close-on-exit) ─
            window_logic::install(app.handle());

            // ── Tray icon (gated behind minimize_to_tray_on_close at runtime) ─
            if let Err(e) = tray::install(app.handle()) {
                crate::devlog!(warn, "tray", "tray install failed: {}", e);
            }

            // ── System Media Transport Controls (SMTC, Windows) ────────────────
            media_controls::install(app.handle());

            // ── Background-playback perf (full frame rate when unfocused) ──────
            // Opt out of Win11 EcoQoS throttling + raise timer resolution, the
            // two levers browsers use to keep media smooth in the background.
            #[cfg(target_os = "windows")]
            win32::apply_playback_perf_opts();

            // ── Streaming bridge (in-process) ──────────────────────────────
            // The loopback byte-range proxy runs on Tauri's shared tokio
            // runtime inside this process — no sidecar binary to stage,
            // bundle, spawn, or reap. Bind failure is logged and
            // swallowed inside start_in_process (only plain-HTTP streams
            // need the proxy; HTTPS bypasses the bridge entirely per
            // resolve_stream's routing rules).
            // Poster resize-and-cache proxy: capture its on-device cache dir
            // (the bridge task has no AppHandle) before the bridge starts, then
            // it serves GET /img?url=&w= on the same loopback listener.
            if let Ok(dir) = app.handle().path().app_data_dir() {
                img_proxy::init(dir.join("img-cache"));
            }
            // Same reason: the loopback OAuth callback route needs an
            // AppHandle to re-emit the `deep-link` event and focus the
            // window, and the bridge task has none. Must precede the
            // listener so no callback can race an uninitialised handle.
            oauth_callback::init(app.handle());
            streaming::start_in_process();

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
                    "seek-state" => {
                        // Seek lifecycle (SEEK → PLAYBACK_RESTART) → the frontend
                        // shows the loading overlay during a slow/buffering seek.
                        if let Some(s) = ev.get("data").and_then(|d| d.get("seeking")).and_then(|v| v.as_bool()) {
                            let mut update = serde_json::Map::new();
                            update.insert("seeking".into(), serde_json::Value::Bool(s));
                            handle.emit("playback-update", serde_json::Value::Object(update)).ok();
                        }
                    }
                    "cache-state" => {
                        // Engine's gated cache poll → real buffering state +
                        // readahead. `paused_for_cache` drives the loading
                        // overlay's mid-playback re-appearance; `cache_pct` is
                        // the buffering % shown on it; `cache_seconds` is the
                        // demuxer readahead (also broadcast per-member to the party).
                        let Some(data) = ev.get("data") else { return; };
                        let mut update = serde_json::Map::new();
                        if let Some(b) = data.get("paused_for_cache").and_then(|v| v.as_bool()) {
                            pb_ref.lock().unwrap().buffering = b;
                            update.insert("buffering".into(), serde_json::Value::Bool(b));
                        }
                        if let Some(p) = data.get("cache_pct").and_then(|v| v.as_f64()) {
                            if let Some(n) = serde_json::Number::from_f64(p) {
                                update.insert("cache_pct".into(), serde_json::Value::Number(n));
                            }
                        }
                        if let Some(s) = data.get("cache_seconds").and_then(|v| v.as_f64()) {
                            if let Some(n) = serde_json::Number::from_f64(s) {
                                update.insert("cache_seconds".into(), serde_json::Value::Number(n));
                            }
                        }
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
            set_keep_display_awake,
            seek_relative,
            frame_step,
            set_audio_loudnorm,
            set_motion_interpolation,
            thumbs::extract_thumbnail,
            set_volume,
            save_screenshot,
            set_video_eq,
            apply_buffer_settings,
            set_speed,
            seek_absolute,
            set_audio_track,
            set_audio_delay,
            set_subtitle_track,
            set_subtitle_delay,
            set_subtitle_speed,
            set_subtitle_visibility,
            set_panscan,
            // ── Live subtitle sync ──────────────────────────────────────────
            subsync::parse_subtitle_cues,
            subsync::extract_embedded_cues,
            subsync::probe_subtitle_streams,
            // ── Story arcs ──────────────────────────────────────────────────
            arcs::fetch_story_arcs,
            arcs::story_arcs_available,
            dev_force_panic,
            debug_panel::debug_engine_state,
            debug_panel::debug_drop_test,
            debug_panel::debug_load_test_pattern,
            debug_panel::debug_stop_playback,
            popup_nav::popup_webview_back,
            popup_nav::popup_webview_forward,
            popup_nav::popup_webview_reload,
            popup_nav::popup_webview_navigate,
            popup_nav::popup_webview_current_url,
            get_tracks,
            get_property,
            refresh_video,
            apply_lang_defaults,
            apply_hdr_settings,
            // ── Live TV (IPTV) network hop ───────────────────────────────────
            iptv::iptv_fetch_text,
            iptv::iptv_set_xtream_password,
            iptv::iptv_get_xtream_password,
            iptv::iptv_clear_xtream_password,
            apply_subtitle_style,
            set_subtitle_position_runtime,
            // ── Casting (Chromecast + DLNA) ───────────────────────────────────
            cast::cast_discover,
            cast::cast_load,
            cast::cast_play,
            cast::cast_pause,
            cast::cast_seek,
            cast::cast_stop,
            cast::cast_status,
            cast::cast_ffmpeg_present,
            runtime_deps::ensure_runtime_dep,
            runtime_deps::runtime_dep_present,
            trailer::resolve_trailer_url,
            playback_engine_ready,
            ensure_playback_engine,
            set_native_fullscreen,
            is_windows_10,
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
            stremio::reorder_addons,
            // ── Global search & cloud sync (2.3) ────────────────────────────
            stremio::global_search_grouped,
            stremio::search_addon_grouped,
            stremio::fetch_search_catalog_expanded,
            stremio::cloud_add_addon,
            stremio::cloud_remove_addon,
            stremio::cloud_reorder_addons,
            // ── Auth ────────────────────────────────────────────────────────
            auth::login,
            auth::logout,
            auth::get_session,
            auth::get_synced_addons,
            auth::stremio_link_create,
            auth::stremio_link_poll,
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
            // ── AuraSkip: skip-window aggregate (set/get) + AniSkip API (fetch/vote/submit/resolve) ──
            aniskip::fetch_skip_windows,
            aniskip::fetch_neighbour_skip_profile,
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
            // ── Anime extras (Tenrai): the More info overlay's five tabs ──
            tenrai::fetch_anime_themes,
            tenrai::fetch_anime_statistics,
            tenrai::fetch_anime_staff,
            tenrai::fetch_anime_recommendations,
            tenrai::fetch_anime_trailers,
            silencedetect::detect_silence_intervals,
            silencedetect::detect_outro_boundary,
            // ── publicmetadb (OP/ED skip source: live-action + anime) ──
            publicmetadb::fetch_publicmetadb_skips,
            publicmetadb::resolve_anime_tmdb_id,
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
            scrobble::scrobble_history_trakt,
            scrobble::scrobble_history_anilist,
            scrobble::set_scrobble_run_active,
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
            sync::migrate_sync_scope,
            auth::backfill_user_id,
            auth::fetch_stremio_account,
            log_export::save_text_with_dialog,
            log_export::pick_folder,
            per_title::get_all_title_state,
            per_title::set_all_title_state,
            scrobble_anilist::get_anilist_id_map,
            scrobble_anilist::set_anilist_id_map,
            // ── Phase 3C: Discord RPC ─────────────────────────────────────────
            window_logic::discord_set_presence,
            window_logic::discord_clear_presence,
            // Watch-party: exempt an in-sync member from pause-on-minimise.
            window_logic::set_party_keep_alive,
            // Force quit — overrides minimize_to_tray_on_close for one close.
            window_logic::request_quit,
            window_logic::cancel_quit,
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
            // ── Multi-source ratings (MDBList + MAL via Tenrai) ──────────────
            ratings::fetch_aggregate_ratings,
            // ── Accurate movie Digital/Theatrical dates (MDBList) ────────────
            ratings::fetch_movie_release_dates,
            // ── Landscape (16:9) art resolution via AIOMeta ──────────────────
            stremio::fetch_landscape_art,
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
