// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Phase-4 on-the-fly HLS transmux — spawns a continuous ffmpeg that
//! segments the upstream into a temp dir, and serves the growing
//! `index.m3u8` + `.ts` segments to the cast device on the same LAN
//! listener as the direct-play proxy (`media_server`).
//!
//! Lifecycle / orphan-proofing: each session owns its ffmpeg `Child` and
//! temp dir; `Drop` taskkills the process tree and removes the dir, so a
//! `clear_all()` on cast-stop / a `shutdown()` on app-close / an idle
//! eviction can never leak an ffmpeg or a temp folder. The transcode is
//! ALWAYS from the head of the file — the resume offset goes to the
//! device as the LOAD `currentTime`, keeping the HLS timeline 1:1 with
//! real media time (see `transcode.rs`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};

/// Sessions not touched for this long are evicted (ffmpeg killed, dir
/// removed). A live cast re-touches on every segment fetch (~6 s apart),
/// so only abandoned sessions age out.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

struct HlsSession {
    dir: PathBuf,
    child: Child,
    last_access: Instant,
}

impl Drop for HlsSession {
    fn drop(&mut self) {
        // taskkill /F /T kills ffmpeg AND any child it spawned (the
        // canonical Windows orphan-proofing). child.kill()+wait() reaps the
        // handle so we don't leave a zombie even if taskkill missed.
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &self.child.id().to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

static SESSIONS: OnceLock<Mutex<HashMap<String, HlsSession>>> = OnceLock::new();
fn sessions() -> &'static Mutex<HashMap<String, HlsSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

static EVICTOR_STARTED: AtomicBool = AtomicBool::new(false);

/// Spawn an HLS transmux of `upstream` and return the LAN playlist URL
/// the device should load. `device_host` selects the right local
/// interface IP (multi-homed machines).
pub(super) async fn register_transcode(
    upstream: &str,
    device_host: &str,
    start_seconds: f64,
) -> Result<String, String> {
    // Defence in depth: ffmpeg's `-protocol_whitelist` must include `file`
    // for the HLS muxer to write segments, which would also let a `file://`
    // INPUT read arbitrary local files. The direct-play proxy is safe (reqwest
    // is http-only); here we gate the upstream scheme explicitly so only
    // http(s) sources ever reach the ffmpeg input. (The cast URL comes from
    // the playing stream, which load_video already restricts to http(s).)
    let lo = upstream.to_ascii_lowercase();
    if !(lo.starts_with("http://") || lo.starts_with("https://")) {
        return Err("cast transmux only supports http(s) sources".into());
    }
    if super::transcode::ffmpeg_path().is_none() {
        return Err("ffmpeg.exe not found — cannot transcode this file for casting".into());
    }
    let port = super::media_server::ensure_started().await?;
    let ip = super::media_server::reachable_ip_for(device_host)
        .unwrap_or_else(super::media_server::lan_ip_fallback);

    let id = uuid::Uuid::new_v4().to_string();
    let dir = std::env::temp_dir().join(format!("aura-cast-hls-{id}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir create failed: {e}"))?;

    let up = upstream.to_string();
    let dir2 = dir.clone();
    // ffprobe (blocking, network-bound) off the async runtime.
    let codecs = tauri::async_runtime::spawn_blocking(move || super::transcode::probe(&up))
        .await
        .map_err(|e| e.to_string())?;

    let ffmpeg = super::transcode::ffmpeg_path().unwrap();
    let args = super::transcode::build_hls_args(upstream, &codecs, &dir2, start_seconds);
    let child = Command::new(ffmpeg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            let _ = std::fs::remove_dir_all(&dir2);
            format!("ffmpeg spawn failed: {e}")
        })?;

    crate::devlog!(
        info, "cast",
        "hls transmux {id}: video={:?} pix={:?} audio={:?} start={start_seconds:.0} ({})",
        codecs.video, codecs.video_pix_fmt, codecs.audio,
        crate::stremio::redact_sensitive_url(upstream),
    );

    let playlist = dir2.join("index.m3u8");
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), HlsSession { dir, child, last_access: Instant::now() });
    start_evictor();

    // Pre-warm: wait for ffmpeg to write the first segment BEFORE handing the
    // URL to the device, so the Cast LOAD (which has a ~10 s timeout) never
    // races the first-segment encode. Bail fast if ffmpeg exited early (bad
    // source / unsupported codec) rather than waiting out the full budget.
    let mut ready = false;
    for i in 0..450 {
        // 45 s ceiling
        if let Ok(body) = std::fs::read(&playlist) {
            if body.windows(8).any(|w| w == b"#EXTINF:") {
                ready = true;
                break;
            }
        }
        if i % 10 == 9 && child_exited(&id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !ready {
        evict_one(&id);
        return Err("transcode failed to start (no playable output produced)".into());
    }

    Ok(format!("http://{ip}:{port}/hls/{id}/index.m3u8"))
}

/// True if the session's ffmpeg child has exited (used during pre-warm to
/// fail fast on a dead transcode). Locks briefly to `try_wait` the child.
fn child_exited(id: &str) -> bool {
    let mut map = match sessions().lock() {
        Ok(m) => m,
        Err(_) => return true,
    };
    match map.get_mut(id) {
        Some(s) => matches!(s.child.try_wait(), Ok(Some(_))),
        None => true,
    }
}

/// Remove + dispose a single session (kill ffmpeg + rmdir), with the heavy
/// teardown run off the SESSIONS lock.
fn evict_one(id: &str) {
    let victim = sessions().lock().ok().and_then(|mut m| m.remove(id));
    drop(victim); // taskkill + rmdir, lock released
}

/// Kill + clear every transcode session (cast stopped / load failed).
/// Drains under the lock but runs the heavy Drop (taskkill + rmdir) OUTSIDE
/// it — holding the SESSIONS mutex across a blocking process-kill + multi-GB
/// remove_dir_all would stall every serve_* handler that locks to touch().
pub(super) fn clear_all() {
    let drained: Vec<HlsSession> = match sessions().lock() {
        Ok(mut m) => m.drain().map(|(_, v)| v).collect(),
        Err(_) => return,
    };
    drop(drained); // lock released — taskkill + rmdir happen here
}

/// Async wrapper for the cast command paths (cast_load / cast_stop) — runs
/// the blocking teardown on a blocking thread so it never parks a tokio
/// worker that also services the cast HTTP listener.
pub(super) async fn clear_all_async() {
    let _ = tauri::async_runtime::spawn_blocking(clear_all).await;
}

/// Synchronous shutdown hook (CloseRequested) — same as `clear_all`.
pub fn shutdown() {
    clear_all();
}

/// Whether any transcode session is live — drives `CastStatus.transcoding`.
pub(super) fn is_active() -> bool {
    sessions().lock().map(|m| !m.is_empty()).unwrap_or(false)
}

fn start_evictor() {
    if EVICTOR_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            // An active cast OWNS its transcode — even while paused or
            // buffering, when the device fetches no segments for minutes —
            // so it must NEVER be reaped here (cast_stop / the next cast_load
            // reclaim it). The evictor only cleans ORPHANED sessions left
            // behind with no active cast at all.
            if super::has_active_session() {
                continue;
            }
            let victims: Vec<HlsSession> = match sessions().lock() {
                Ok(mut map) => {
                    let stale: Vec<String> = map
                        .iter()
                        .filter(|(_, s)| s.last_access.elapsed() > IDLE_TIMEOUT)
                        .map(|(id, _)| id.clone())
                        .collect();
                    stale.into_iter().filter_map(|id| map.remove(&id)).collect()
                }
                Err(_) => continue,
            };
            if !victims.is_empty() {
                let n = victims.len();
                // Dispose (taskkill + rmdir) off the lock AND off this worker.
                let _ = tauri::async_runtime::spawn_blocking(move || drop(victims)).await;
                crate::devlog!(info, "cast", "hls evictor reclaimed {n} orphaned session(s)");
            }
        }
    });
}

/// Look up a session's dir + bump its last-access. None if unknown.
fn touch(id: &str) -> Option<PathBuf> {
    let mut map = sessions().lock().ok()?;
    let s = map.get_mut(id)?;
    s.last_access = Instant::now();
    Some(s.dir.clone())
}

// ---------------------------------------------------------------------------
// HTTP handlers (wired into media_server's router)
// ---------------------------------------------------------------------------

/// Serve the media playlist. Polls briefly for ffmpeg to write the first
/// segment so the device never receives an empty/segment-less playlist.
pub(super) async fn serve_playlist(id: String) -> Response {
    let Some(dir) = touch(&id) else {
        return (StatusCode::NOT_FOUND, "unknown transcode session").into_response();
    };
    let playlist = dir.join("index.m3u8");
    // ffmpeg needs ~1-2 s to emit the first segment + playlist.
    for _ in 0..150 {
        if let Ok(body) = std::fs::read(&playlist) {
            if body.windows(8).any(|w| w == b"#EXTINF:") {
                return hls_response(body, "application/vnd.apple.mpegurl");
            }
        }
        // Session may have been torn down mid-wait.
        if touch(&id).is_none() {
            return (StatusCode::NOT_FOUND, "transcode session ended").into_response();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (StatusCode::GATEWAY_TIMEOUT, "transcode did not start in time").into_response()
}

/// Serve a `.ts` segment. The filename is validated so a crafted path
/// can't escape the session's temp dir.
pub(super) async fn serve_segment(id: String, seg: String) -> Response {
    if !is_safe_segment_name(&seg) {
        return (StatusCode::BAD_REQUEST, "invalid segment name").into_response();
    }
    let Some(dir) = touch(&id) else {
        return (StatusCode::NOT_FOUND, "unknown transcode session").into_response();
    };
    let path = dir.join(&seg);
    // A segment listed in the playlist is complete, but allow a short
    // poll for the write to settle.
    for _ in 0..120 {
        if let Ok(body) = std::fs::read(&path) {
            if !body.is_empty() {
                return hls_response(body, "video/mp2t");
            }
        }
        if touch(&id).is_none() {
            return (StatusCode::NOT_FOUND, "transcode session ended").into_response();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (StatusCode::NOT_FOUND, "segment unavailable").into_response()
}

/// Only `name.ts` with a safe charset — no separators, no `..`, no drive
/// or UNC prefixes. ffmpeg writes `seg00001.ts`; nothing else is valid.
fn is_safe_segment_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.ends_with(".ts")
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn hls_response(body: Vec<u8>, content_type: &'static str) -> Response {
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    let h = resp.headers_mut();
    h.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static(content_type),
    );
    h.insert(
        HeaderName::from_static("access-control-allow-origin"),
        HeaderValue::from_static("*"),
    );
    h.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-cache"),
    );
    resp
}
