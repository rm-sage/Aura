// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::settings;

// ---------------------------------------------------------------------------
// Scrobble — Trakt / AniList progress reporting via AIOMetadata.
//
// AIOMetadata exposes a `scrobble` resource on its addon URL. Aura POSTs
// JSON payloads of the form:
//
//   POST {addon}/scrobble/{type}/{id}/{event}.json
//   { "progress": 0..1, "time": seconds, "duration": seconds, "episode": "S01E03" }
//
// The events fire from MPV's playback observer:
//
//   • start     — once, on first time-pos > 0 after load
//   • heartbeat — every ~60 s while paused == false
//   • end       — once, when MPV stops the file or progress crosses 0.9
//
// All scrobble HTTP traffic is best-effort: failures are logged via
// `log::warn!` but never propagate to the user. The scrobble pipeline must
// never block playback.
// ---------------------------------------------------------------------------

const TIMEOUT: Duration = Duration::from_secs(8);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // The user's scrobble addon URL is configured in Settings;
            // we expect HTTPS-hosted endpoints (Trakt-bridge providers
            // ship behind HTTPS by default). Forbid silent downgrades —
            // a misconfigured `http://` URL surfaces as a connection
            // error rather than leaking the user / title / progress
            // payload over plaintext on a hostile network.
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent("Aura/0.6.7 scrobble")
            .build()
            .expect("Scrobble HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Active session — at most one scrobble session at a time
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScrobbleSession {
    pub imdb_id: String,
    pub media_type: String,
    pub episode: Option<String>,
    pub title: String,
    pub is_anime: bool,
}

static SESSION: OnceLock<Mutex<Option<ScrobbleSession>>> = OnceLock::new();

fn session_slot() -> &'static Mutex<Option<ScrobbleSession>> {
    SESSION.get_or_init(|| Mutex::new(None))
}

#[allow(dead_code)] // retained for an opt-in re-introduction of /start traffic
pub fn current() -> Option<ScrobbleSession> {
    session_slot().lock().ok().and_then(|g| g.clone())
}

// ---------------------------------------------------------------------------
// Last-seen playback snapshot
//
// Tracked via heartbeat / start so the synchronous CloseRequested handler
// can fire a `/scrobble/end` with realistic time/duration values without
// touching MPV (libmpv get_property during the close transition is one of
// the documented STATUS_ACCESS_VIOLATION triggers — CLAUDE.md landmine #3).
// Without this, hard window-closes left Trakt stuck in "Currently watching"
// because the JS-side scrobble_end never fired and the addon couldn't
// distinguish stop-by-close from stop-by-pause.
// ---------------------------------------------------------------------------

static LAST_PLAYBACK: OnceLock<Mutex<(f64, f64)>> = OnceLock::new();

fn last_playback_slot() -> &'static Mutex<(f64, f64)> {
    LAST_PLAYBACK.get_or_init(|| Mutex::new((0.0, 0.0)))
}

fn record_playback(time: f64, duration: f64) {
    if let Ok(mut g) = last_playback_slot().lock() {
        *g = (time, duration);
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn post_event(
    addon_url: &str,
    enabled: bool,
    sess: &ScrobbleSession,
    event: &str,
    progress: f64,
    time: f64,
    duration: f64,
) {
    if !enabled {
        return; // user disabled scrobbling via Settings toggle
    }
    if addon_url.is_empty() {
        return; // scrobbling disabled — no addon configured
    }
    let base = addon_url.trim_end_matches('/');
    let url = format!(
        "{base}/scrobble/{}/{}/{}.json",
        sess.media_type, sess.imdb_id, event
    );

    let body = serde_json::json!({
        "progress": progress.clamp(0.0, 1.0),
        "time": time,
        "duration": duration,
        "episode": sess.episode,
        "title": sess.title,
        "isAnime": sess.is_anime,
    });

    if let Err(e) = client().post(&url).json(&body).send().await {
        // Best-effort: log but never surface. We deliberately log only
        // the high-level error CATEGORY (status / connect / timeout)
        // and NOT `e.to_string()` — reqwest's Display impl can include
        // the full request URL, which for poorly-formed scrobble addon
        // URLs can carry embedded auth info (`http://user:pass@host`).
        // Truncate to a short sanitised form so the DevConsole never
        // spills credentials.
        let category = if e.is_timeout() { "timeout" }
            else if e.is_connect() { "connect" }
            else if e.is_status() {
                e.status().map(|s| s.as_u16().to_string()).unwrap_or_else(|| "status".into())
                    .leak()
            }
            else { "send" };
        eprintln!("[scrobble] {event} failed: {category}");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scrobble_start<R: Runtime>(
    _app: AppHandle<R>,
    session: ScrobbleSession,
    duration: f64,
) -> Result<(), String> {
    *session_slot().lock().map_err(|e| e.to_string())? = Some(session);
    record_playback(0.0, duration);
    // Trakt-style "check-in" /scrobble/start was removed: it fired a
    // live "Currently watching" feed entry and (via AIOMetadata's
    // AniList integration) bumped the user's `progress` to the current
    // episode within seconds — flipping unwatched anime to watched
    // during the user's preview window. We keep the local session_slot
    // setup so /scrobble/end has the right session metadata to send,
    // but no HTTP request fires here. Only /end traffics the wire.
    Ok(())
}

#[tauri::command]
pub async fn scrobble_heartbeat<R: Runtime>(
    _app: AppHandle<R>,
    time: f64,
    duration: f64,
) -> Result<(), String> {
    record_playback(time, duration);
    // Heartbeats also went silent when /start was removed — they used
    // to be Trakt's "I'm still watching" pings, which only make sense
    // alongside an active /start. The frontend may still call this
    // command to record live time/duration so /end has accurate
    // progress on hard window closes (CloseRequested → shutdown_blocking
    // reads last_playback_slot).
    Ok(())
}

#[tauri::command]
pub async fn scrobble_end<R: Runtime>(
    _app: AppHandle<R>,
    time: f64,
    duration: f64,
) -> Result<(), String> {
    record_playback(time, duration);
    let taken = session_slot().lock().map_err(|e| e.to_string())?.take();
    let Some(sess) = taken else { return Ok(()); };
    let progress = if duration > 0.0 { time / duration } else { 0.0 };
    let s = settings::snapshot();
    post_event(&s.scrobble_addon_url, s.scrobble_enabled, &sess, "end", progress, time, duration).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Synchronous shutdown helper — called from window_logic's CloseRequested
// handler before app.exit(0) so Trakt / AniList see the stop signal even on
// hard window-closes (X button on the title bar). The previous flow only
// fired /scrobble/end via the React useScrobble unmount, which doesn't run
// when the process exits without React shutting down — leaving Trakt stuck
// in "Currently watching" until its server-side TTL elapsed (often hours).
//
// Uses tauri::async_runtime::block_on so the HTTP POST completes before
// the process exits. Capped at 2 s so a slow / unreachable scrobble addon
// can't hold up app shutdown.
// ---------------------------------------------------------------------------

pub fn shutdown_blocking() {
    let taken = match session_slot().lock() {
        Ok(mut g) => g.take(),
        Err(_) => return,
    };
    let Some(sess) = taken else { return; };
    let s = settings::snapshot();
    if !s.scrobble_enabled || s.scrobble_addon_url.is_empty() {
        return;
    }
    let (time, duration) = last_playback_slot()
        .lock()
        .map(|g| *g)
        .unwrap_or((0.0, 0.0));
    let progress = if duration > 0.0 { time / duration } else { 0.0 };

    crate::devlog!(
        info, "scrobble",
        "shutdown_blocking — flushing /end for {} (progress {:.2})",
        sess.imdb_id, progress,
    );

    let base = s.scrobble_addon_url.trim_end_matches('/').to_string();
    let url = format!("{base}/scrobble/{}/{}/end.json", sess.media_type, sess.imdb_id);
    let body = serde_json::json!({
        "progress": progress.clamp(0.0, 1.0),
        "time": time,
        "duration": duration,
        "episode": sess.episode,
        "title": sess.title,
        "isAnime": sess.is_anime,
    });

    let _ = tauri::async_runtime::block_on(async move {
        // Bounded short timeout — never hold up shutdown more than 2 s.
        let cli = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .user_agent("Aura/0.6.7 scrobble")
            .build()
            .ok()?;
        cli.post(&url).json(&body).send().await.ok()
    });
}
