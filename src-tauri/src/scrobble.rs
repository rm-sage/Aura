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
            .timeout(TIMEOUT)
            .user_agent("Aura/0.1 scrobble")
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

pub fn current() -> Option<ScrobbleSession> {
    session_slot().lock().ok().and_then(|g| g.clone())
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async fn post_event(
    addon_url: &str,
    sess: &ScrobbleSession,
    event: &str,
    progress: f64,
    time: f64,
    duration: f64,
) {
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
        // Best-effort: log but never surface.
        eprintln!("[scrobble] {event} failed: {e}");
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
    *session_slot().lock().map_err(|e| e.to_string())? = Some(session.clone());
    let s = settings::snapshot();
    post_event(&s.scrobble_addon_url, &session, "start", 0.0, 0.0, duration).await;
    Ok(())
}

#[tauri::command]
pub async fn scrobble_heartbeat<R: Runtime>(
    _app: AppHandle<R>,
    time: f64,
    duration: f64,
) -> Result<(), String> {
    let Some(sess) = current() else { return Ok(()); };
    let progress = if duration > 0.0 { time / duration } else { 0.0 };
    let s = settings::snapshot();
    post_event(&s.scrobble_addon_url, &sess, "heartbeat", progress, time, duration).await;
    Ok(())
}

#[tauri::command]
pub async fn scrobble_end<R: Runtime>(
    _app: AppHandle<R>,
    time: f64,
    duration: f64,
) -> Result<(), String> {
    let taken = session_slot().lock().map_err(|e| e.to_string())?.take();
    let Some(sess) = taken else { return Ok(()); };
    let progress = if duration > 0.0 { time / duration } else { 0.0 };
    let s = settings::snapshot();
    post_event(&s.scrobble_addon_url, &sess, "end", progress, time, duration).await;
    Ok(())
}
