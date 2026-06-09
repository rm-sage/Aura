// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Hover-scrub thumbnail extractor — ffmpeg-per-hover, never-stale.
//
// Replaces the old in-process named "thumb" libmpv instance (player.rs) that
// confirmed seeks by POLLING `playback-time`, which raced on remote streams
// and surfaced stale/wrong frames + rapid-hover races. ffmpeg-per-hover is
// never-stale BY CONSTRUCTION: each invocation seeks to the target and decodes
// exactly the frame it lands on — there is no shared/persistent decoder state
// to go wrong. The cost is ~1-3 s on a cold first hover (no warm decoder),
// which is the accepted tradeoff for always-correct frames; warm re-hovers hit
// the frontend cache instantly.
//
// Reuses the already-bundled `lib/ffmpeg.exe` (no new binary) via
// `silencedetect::ffmpeg_command` (resolver + CREATE_NO_WINDOW). Same security
// posture as silencedetect: http(s) only + `-protocol_whitelist`. Passes the
// direct `streamUrl` (NOT the 127.0.0.1:11471 bridge — TLS-cert mismatch breaks
// it, per the CLAUDE.md streaming-bridge constraint). Runs entirely outside the
// main mpv2 render instance, so the MPV landmines (#2 WASAPI, #3 seek
// crit-section, #4 observed-property channel) do not apply.
// ---------------------------------------------------------------------------

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::Semaphore;

/// Per-extraction timeout. A cold TLS/DNS + open + keyframe seek on a remote
/// debrid stream can take a couple seconds; 12 s is generous headroom before we
/// give up and let the overlay fall back to the plain timestamp tooltip.
const THUMB_TIMEOUT: Duration = Duration::from_secs(12);

/// Unique temp-file counter so concurrent extractions never clobber each
/// other's output (the old code serialised on a mutex; we allow a little
/// parallelism instead).
static THUMB_SEQ: AtomicU64 = AtomicU64::new(0);

/// Cap concurrent ffmpeg extractions. The frontend already debounces (220 ms)
/// + supersedes rapid hovers, so this is belt-and-suspenders against a fast
/// scrub spawning a pile of decoders.
static THUMB_GATE: Semaphore = Semaphore::const_new(3);

/// Standard base64 (with padding). Tiny inline impl — avoids a crate dep for a
/// few-KB transient thumbnail. (Moved here from player.rs with the rest of the
/// thumb path.)
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Result shape for `extract_thumbnail`. `at` is the requested time — ffmpeg's
/// pre-input `-ss` is keyframe-snapped (off by up to a GOP), which the frontend
/// caches against the requested second exactly as before.
#[derive(serde::Serialize)]
pub struct ThumbResult {
    pub data_url: String,
    pub at: f64,
}

/// Extract a single seek-accurate JPEG thumbnail at `at_seconds` from `url`.
/// Best-effort: any failure (kill-switch, bad url, ffmpeg error, timeout,
/// empty output) resolves to `Ok(None)` so the scrubber falls back to the
/// timestamp tooltip rather than erroring.
#[tauri::command]
pub async fn extract_thumbnail(
    app: AppHandle,
    url: String,
    at_seconds: f64,
) -> Result<Option<ThumbResult>, String> {
    if url.is_empty() || !at_seconds.is_finite() || at_seconds < 0.0 {
        return Ok(None);
    }
    // Kill-switch for users who hit a problem with the engine.
    if std::env::var("AURA_NO_THUMBS").is_ok() {
        return Ok(None);
    }
    // Direct stream URL only (same one the main player gets); never the
    // loopback bridge. Mirrors silencedetect's guard.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(None);
    }

    // Bound concurrency. A closed semaphore is impossible (it's static + never
    // closed), so the acquire only fails on a poisoned runtime — treat as a
    // soft miss.
    let _permit = match THUMB_GATE.acquire().await {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };

    let seq = THUMB_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut out_path = std::env::temp_dir();
    out_path.push(format!("aura-thumb-{seq}.jpg"));
    let out_str = out_path.to_string_lossy().to_string();
    let label: String = url.chars().take(80).collect();
    let ss = format!("{at_seconds}");

    let mut cmd = crate::silencedetect::ffmpeg_command(&app);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    cmd.args(["-protocol_whitelist", "http,https,tcp,tls,crypto"]);
    // `-ss` BEFORE `-i` = fast keyframe-snapped input seek (decodes only the
    // frame it lands on, not from 0). One frame, 320 px wide, ~q4 JPEG.
    cmd.arg("-ss").arg(&ss);
    cmd.arg("-i").arg(&url);
    cmd.args(["-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", "-y"]);
    cmd.arg(&out_str);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // On timeout the status future is dropped, dropping the child → killed.
    cmd.kill_on_drop(true);

    let status = tokio::time::timeout(THUMB_TIMEOUT, cmd.status()).await;

    let result: Result<Option<ThumbResult>, String> = match status {
        Ok(Ok(st)) if st.success() => match std::fs::read(&out_path) {
            Ok(bytes) if !bytes.is_empty() => Ok(Some(ThumbResult {
                data_url: format!("data:image/jpeg;base64,{}", b64_encode(&bytes)),
                at: at_seconds,
            })),
            _ => Ok(None),
        },
        Ok(Ok(_)) => {
            crate::devlog!(debug, "thumbs", "[{}] ffmpeg returned non-zero", label);
            Ok(None)
        }
        Ok(Err(e)) => {
            crate::devlog!(debug, "thumbs", "[{}] ffmpeg spawn failed: {}", label, e);
            Ok(None)
        }
        Err(_) => {
            crate::devlog!(debug, "thumbs", "[{}] ffmpeg timed out", label);
            Ok(None)
        }
    };

    let _ = std::fs::remove_file(&out_path);
    result
}
