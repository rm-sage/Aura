// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::scrobble_auth;
use crate::settings;

// ---------------------------------------------------------------------------
// Scrobble — direct Trakt progress reporting using OAuth tokens stored
// by scrobble_auth.rs.
//
// Earlier rounds of Aura proxied scrobble events through the AIOMetadata
// addon's `/scrobble` resource. The OAuth proxy migration replaced that:
// Trakt's `client_secret` is held server-side at aura.animasec.dev, the
// desktop holds only the access token, and we POST directly to Trakt's
// API with the bearer token. AIOMetadata is no longer in the scrobble
// path at all — see `aura-proxy/main.go` and the integration doc for
// the full flow.
//
// Wire format (per Trakt API v2):
//   POST https://api.trakt.tv/scrobble/stop
//   Headers: Authorization: Bearer <token>, trakt-api-version: 2,
//            trakt-api-key: <client_id>, Content-Type: application/json
//   Body for movies:
//     { "movie": { "ids": { "imdb": "tt0111161" } }, "progress": 95.0 }
//   Body for episodes:
//     { "show": { "ids": { "imdb": "tt0903747" } },
//       "episode": { "season": 1, "number": 5 },
//       "progress": 95.0 }
//
// Trakt converts /scrobble/stop with progress >= 80% into a "watched"
// entry on the user's history; below that threshold it's recorded as
// "paused". Aura only fires /scrobble/stop on session-end with auto-
// complete already gated to >= 80% (see useScrobble.ts), so the wire
// path always intends "mark watched".
//
// AniList scrobbling is intentionally not wired yet — AniList tracks
// progress by AniList media id, but Aura's session ids come from
// Stremio addons (IMDB / Kitsu / etc.). Wiring up an id mapping is a
// separate task; until then the AniList token is stored but unused at
// runtime. Most anime listed via Cinemeta DOES have an IMDB id, so
// Trakt scrobbling covers the bulk of the catalogue regardless.
//
// All scrobble traffic is best-effort: failures are logged via
// `crate::devlog!` but never propagate to the user. The scrobble
// pipeline must never block playback.
// ---------------------------------------------------------------------------

const TRAKT_API: &str = "https://api.trakt.tv";
const TIMEOUT: Duration = Duration::from_secs(8);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " scrobble"))
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
    /// First 12 chars of the Stremio auth_key, or `"guest"`. Keys the
    /// (provider, scope) pair into the keyring so scrobble.rs reads
    /// the token belonging to whichever Stremio account is active —
    /// see scrobble_auth.rs for the layout. The frontend supplies it
    /// at scrobble_start time; we cache it on the session so /end can
    /// fire the right token even after the user has navigated away.
    pub scope: String,
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
// can fire a `/scrobble/stop` with realistic time/duration values without
// touching MPV (libmpv get_property during the close transition is one of
// the documented STATUS_ACCESS_VIOLATION triggers — CLAUDE.md landmine #3).
// Without this, hard window-closes left Trakt stuck in "Currently watching"
// because the JS-side scrobble_end never fired and Trakt couldn't
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
// Trakt target id parsing
//
// Aura's session ids follow Stremio's convention:
//   • Movies: a bare IMDB id (`tt0111161`).
//   • Episodes: `<show_imdb>:<season>:<episode>` (e.g. `tt0903747:1:5`).
// Anything that doesn't match (e.g. `kitsu:42:3`, MAL ids, etc.) is
// silently skipped — Trakt accepts IMDB ids as the canonical bridge,
// and adding non-IMDB id resolution is a separate task.
// ---------------------------------------------------------------------------

enum TraktTarget {
    Movie { imdb: String },
    Episode { show_imdb: String, season: u32, number: u32 },
}

fn parse_trakt_target(id: &str, media_type: &str) -> Option<TraktTarget> {
    let parts: Vec<&str> = id.split(':').collect();
    match parts.as_slice() {
        [imdb] if imdb.starts_with("tt") && media_type == "movie" => {
            Some(TraktTarget::Movie { imdb: (*imdb).to_string() })
        }
        [imdb, s, e] if imdb.starts_with("tt") => {
            let season: u32 = s.parse().ok()?;
            let number: u32 = e.parse().ok()?;
            Some(TraktTarget::Episode {
                show_imdb: (*imdb).to_string(),
                season,
                number,
            })
        }
        _ => None,
    }
}

fn build_stop_body(target: &TraktTarget, progress_pct: f64) -> serde_json::Value {
    match target {
        TraktTarget::Movie { imdb } => serde_json::json!({
            "movie":    { "ids": { "imdb": imdb } },
            "progress": progress_pct,
        }),
        TraktTarget::Episode { show_imdb, season, number } => serde_json::json!({
            "show":     { "ids": { "imdb": show_imdb } },
            "episode":  { "season": season, "number": number },
            "progress": progress_pct,
        }),
    }
}

// ---------------------------------------------------------------------------
// Trakt /scrobble/stop — async path, called from scrobble_end
// ---------------------------------------------------------------------------

async fn trakt_scrobble_stop(scope: &str, sess: &ScrobbleSession, time: f64, duration: f64) {
    let Some(token) = scrobble_auth::read_token_for("trakt", scope) else {
        // No connected Trakt account — silently no-op. AniList-only
        // users land here, as do guest sessions.
        return;
    };
    let Some(target) = parse_trakt_target(&sess.imdb_id, &sess.media_type) else {
        crate::devlog!(
            warn, "scrobble",
            "Trakt /scrobble/stop skipped: id format unsupported: {} (type={})",
            sess.imdb_id, sess.media_type,
        );
        return;
    };

    let progress_pct = if duration > 0.0 {
        (time / duration * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let body = build_stop_body(&target, progress_pct);

    let res = client()
        .post(format!("{TRAKT_API}/scrobble/stop"))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("Content-Type", "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", scrobble_auth::TRAKT_CLIENT_ID)
        .json(&body)
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            crate::devlog!(
                info, "scrobble",
                "Trakt /scrobble/stop OK ({:.0}%) for {}",
                progress_pct, sess.imdb_id,
            );
        }
        Ok(r) if r.status().as_u16() == 401 => {
            // Token revoked / expired. Clear the keyring entry so the
            // Settings UI picks it up as Disconnected on next refresh
            // (the per-session refetch in ScrobbleAuthRow runs on
            // mount + on `aura:scrobble-auth-changed`). The next
            // Connect flow re-prompts cleanly. We deliberately don't
            // emit a Tauri event here — a mid-playback dialog "your
            // Trakt token expired" would be more disruptive than
            // useful, and the user discovers the disconnected state
            // when they next open Settings.
            crate::devlog!(
                warn, "scrobble",
                "Trakt 401: clearing token for scope={} (user must reconnect)",
                scope,
            );
            scrobble_auth::clear_token_for("trakt", scope);
        }
        Ok(r) => {
            crate::devlog!(
                warn, "scrobble",
                "Trakt /scrobble/stop status {}",
                r.status().as_u16(),
            );
        }
        Err(e) => {
            let category = if e.is_timeout() { "timeout" }
                else if e.is_connect() { "connect" }
                else { "send" };
            // Truncate to category-only — `e.to_string()` may include
            // the request URL with the bearer token in headers if a
            // future log-formatter swap brings header dumps along.
            crate::devlog!(warn, "scrobble", "Trakt /scrobble/stop {category}");
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scrobble_start<R: Runtime>(
    _app: AppHandle<R>,
    session: ScrobbleSession,
    duration: f64,
) -> Result<(), String> {
    *session_slot().lock().map_err(|e| e.to_string())? = Some(session);
    record_playback(0.0, duration);
    // Intentionally no HTTP fires here. Trakt's /scrobble/start would
    // put the user on the public "currently watching" feed, which
    // earlier feedback flagged as too eager — flipping an episode the
    // user is previewing into the public feed before they decided to
    // commit. Only /scrobble/stop fires on completion (>= 80% +
    // useScrobble's elapsed-time floor).
    Ok(())
}

#[tauri::command]
pub async fn scrobble_heartbeat<R: Runtime>(
    _app: AppHandle<R>,
    time: f64,
    duration: f64,
) -> Result<(), String> {
    record_playback(time, duration);
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

    let s = settings::snapshot();
    if !s.scrobble_enabled {
        // Master switch off — keep the local session bookkeeping but
        // skip the wire call. Useful for users debugging "did my
        // history just get nuked?" who want to silence Aura without
        // disconnecting their accounts.
        return Ok(());
    }

    let scope = sess.scope.clone();
    trakt_scrobble_stop(&scope, &sess, time, duration).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Synchronous shutdown helper — called from window_logic's CloseRequested
// handler before app.exit(0) so Trakt sees the stop signal even on hard
// window-closes (X button on the title bar). The previous flow only fired
// /scrobble/end via the React useScrobble unmount, which doesn't run when
// the process exits without React shutting down — leaving Trakt stuck in
// "Currently watching" until its server-side TTL elapsed (often hours).
//
// Uses tauri::async_runtime::block_on so the HTTP POST completes before
// the process exits. Capped at 2 s so a slow / unreachable Trakt API
// can't hold up app shutdown.
// ---------------------------------------------------------------------------

pub fn shutdown_blocking() {
    let taken = match session_slot().lock() {
        Ok(mut g) => g.take(),
        Err(_) => return,
    };
    let Some(sess) = taken else { return; };

    let s = settings::snapshot();
    if !s.scrobble_enabled { return; }

    let (time, duration) = last_playback_slot()
        .lock()
        .map(|g| *g)
        .unwrap_or((0.0, 0.0));
    let progress_pct = if duration > 0.0 {
        (time / duration * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    let scope = sess.scope.clone();
    let Some(target) = parse_trakt_target(&sess.imdb_id, &sess.media_type) else { return; };
    let Some(token) = scrobble_auth::read_token_for("trakt", &scope) else { return; };

    crate::devlog!(
        info, "scrobble",
        "shutdown_blocking — flushing Trakt /scrobble/stop for {} ({:.0}%)",
        sess.imdb_id, progress_pct,
    );

    let body = build_stop_body(&target, progress_pct);

    let _ = tauri::async_runtime::block_on(async move {
        // Bounded short timeout — never hold up shutdown more than 2 s.
        let cli = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .https_only(true)
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " scrobble"))
            .build()
            .ok()?;
        cli.post(format!("{TRAKT_API}/scrobble/stop"))
            .header("Authorization", format!("Bearer {}", token.access_token))
            .header("Content-Type", "application/json")
            .header("trakt-api-version", "2")
            .header("trakt-api-key", scrobble_auth::TRAKT_CLIENT_ID)
            .json(&body)
            .send()
            .await
            .ok()
    });
}
