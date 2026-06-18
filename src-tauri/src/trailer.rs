// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Trailer resolution.
//!
//! MPV can't open a YouTube page directly (this `libmpv-2.dll` build ships no
//! `ytdl_hook` Lua script). So a "Watch Trailer" click resolves the YouTube id
//! to a direct progressive CDN URL out-of-process via `yt-dlp`, and that plain
//! HTTPS URL flows through the normal `resolve_stream` → `load_video` path like
//! any other stream — YouTube is never handed to MPV.
//!
//! `yt-dlp.exe` is an on-demand runtime binary (see [`crate::runtime_deps`]) —
//! not bundled; the frontend downloads it on first trailer play. It is resolved
//! from the runtime dir first, then `lib/yt-dlp.exe` next to the exe, then the
//! dev `CARGO_MANIFEST_DIR/lib` copy — mirroring `cast::locate_tool`.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Resolve `yt-dlp.exe`: downloaded copy (survives updates) first, then a
/// hand-placed / dev `lib/yt-dlp.exe`. Self-contained so this module doesn't
/// depend on `cast`'s `pub(super)` resolver.
fn locate_yt_dlp() -> Option<PathBuf> {
    if let Some(p) = crate::runtime_deps::resolved_path("yt-dlp.exe") {
        return Some(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [dir.join("lib").join("yt-dlp.exe"), dir.join("yt-dlp.exe")] {
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("lib")
        .join("yt-dlp.exe");
    dev.exists().then_some(dev)
}

/// Whether the input looks like a bare YouTube video id (11 chars, URL-safe).
fn is_yt_id(s: &str) -> bool {
    s.len() == 11 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Resolved trailer playback URLs + the quality actually obtained.
///
/// Flows Rust -> React. `audio_url` is `None` for a single muxed file (YouTube
/// muxes only up to 720p); above that YouTube serves DASH, so `video_url` is
/// the video-only stream and `audio_url` is the separate audio stream (mpv
/// plays them together via the `audio-files` option). `height`/`quality_label`
/// reflect the ACTUAL resolved quality, which may be lower than requested when
/// the title has no higher rendition.
#[derive(serde::Serialize)]
pub struct TrailerResolution {
    pub video_url: String,
    pub audio_url: Option<String>,
    pub height: u32,
    /// "4K" / "1440p" / "1080p" / "720p" / "<n>p" / "Auto".
    pub quality_label: String,
    /// The highest video rendition this trailer offers, across ALL formats (not
    /// just the picked one). The UI gates the quality menu to rungs at or below
    /// this so the user can't pick a resolution the title doesn't have.
    pub max_height_available: u32,
}

/// yt-dlp `-f` selector for a requested max height.
///
/// 0 = Auto (best available). For every capped rung we prefer DASH
/// (`bestvideo[height<=N]+bestaudio`) so the user actually gets N pixels —
/// YouTube only muxes single files up to 720p (and often only 360p), so a
/// muxed-first selector would silently hand back 360p when the user asked for
/// 720p. mp4/m4a is preferred for broad MPV compatibility, then any codec, then
/// a muxed file as a last resort when the title has no DASH at all.
fn format_selector(max_height: u32) -> String {
    if max_height == 0 {
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best".to_string()
    } else {
        let h = max_height;
        format!(
            "bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<={h}]+bestaudio/best[height<={h}][ext=mp4]/best[height<={h}]"
        )
    }
}

/// Human label for an actual resolved height.
fn quality_label(height: u32) -> String {
    if height >= 2160 { "4K".to_string() }
    else if height >= 1440 { "1440p".to_string() }
    else if height >= 1080 { "1080p".to_string() }
    else if height >= 720 { "720p".to_string() }
    else if height > 0 { format!("{height}p") }
    else { "Auto".to_string() }
}

/// Resolve a YouTube trailer to direct CDN URLs at (up to) `max_height` via
/// yt-dlp. `max_height` 0 = Auto/best. Returns the video URL, an optional
/// separate DASH audio URL, and the actual resolved quality. The caller must
/// have ensured `yt-dlp.exe` is present (`ensure_runtime_dep("yt-dlp.exe")`).
#[tauri::command]
pub async fn resolve_trailer_url(yt_id: String, max_height: u32) -> Result<TrailerResolution, String> {
    if !is_yt_id(&yt_id) {
        return Err(format!("Invalid YouTube id: {yt_id:?}"));
    }

    let yt_dlp = locate_yt_dlp()
        .ok_or_else(|| "yt-dlp not found — install it in Settings → Components".to_string())?;

    let yt_url = format!("https://www.youtube.com/watch?v={yt_id}");
    let selector = format_selector(max_height);
    crate::devlog!(info, "trailer", "resolve_trailer_url: max_height={max_height} for {yt_url}");

    let mut cmd = Command::new(&yt_dlp);
    // `-j` dumps the selected info as JSON in ONE call, giving us BOTH the
    // resolved URL(s) AND the real height — more robust than parsing `-g`'s
    // bare URL lines (which can't tell us the height when a lower rendition was
    // substituted). A DASH merge surfaces `requested_formats` (video + audio);
    // a single muxed file has a top-level `url`.
    cmd.args([
        "-j",
        "-f",
        &selector,
        "--no-playlist",
        "--no-warnings",
        &yt_url,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW = 0x08000000 — keep the GUI app from flashing a
        // console window on each spawn (same posture as silencedetect/thumbs).
        cmd.creation_flags(0x08000000);
    }

    let output = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "yt-dlp timed out after 30 s".to_string())?
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.trim().lines().next().unwrap_or("unknown error");
        crate::devlog!(warn, "trailer", "yt-dlp error: {}", stderr.trim());
        return Err(format!("yt-dlp: {first}"));
    }

    let info: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("yt-dlp JSON parse failed: {e}"))?;

    // DASH merge: `requested_formats` holds the video-only + audio-only parts.
    let mut video_url: Option<String> = None;
    let mut audio_url: Option<String> = None;
    let mut height: u64 = 0;
    if let Some(parts) = info.get("requested_formats").and_then(|v| v.as_array()) {
        for fmt in parts {
            let Some(url) = fmt.get("url").and_then(|v| v.as_str()) else { continue };
            let vcodec = fmt.get("vcodec").and_then(|v| v.as_str()).unwrap_or("none");
            let acodec = fmt.get("acodec").and_then(|v| v.as_str()).unwrap_or("none");
            if vcodec != "none" {
                video_url = Some(url.to_string());
                if let Some(h) = fmt.get("height").and_then(|v| v.as_u64()) { height = h; }
            } else if acodec != "none" {
                audio_url = Some(url.to_string());
            }
        }
    }
    // Single muxed file (no separate audio): top-level `url`.
    if video_url.is_none() {
        video_url = info.get("url").and_then(|v| v.as_str()).map(str::to_string);
        if height == 0 {
            height = info.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        }
    }

    let video_url = video_url
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .ok_or_else(|| "yt-dlp returned no usable video URL".to_string())?;
    let height = height as u32;

    // Highest video rendition the title offers (across ALL formats, not just the
    // picked one) — drives the UI's available-quality gating. Storyboards/audio
    // are excluded via the vcodec check. Never reported below the picked height.
    let max_height_available: u32 = info
        .get("formats")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|f| {
                    f.get("vcodec").and_then(|v| v.as_str()).map(|c| c != "none").unwrap_or(false)
                })
                .filter_map(|f| f.get("height").and_then(|h| h.as_u64()))
                .max()
                .unwrap_or(0) as u32
        })
        .unwrap_or(0)
        .max(height);

    crate::devlog!(
        info, "trailer",
        "resolved trailer: height={height} max={max_height_available} dash={} (video {} chars)",
        audio_url.is_some(), video_url.len(),
    );
    Ok(TrailerResolution {
        video_url,
        audio_url,
        height,
        quality_label: quality_label(height),
        max_height_available,
    })
}
