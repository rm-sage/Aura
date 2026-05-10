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
//   POST https://api.trakt.tv/sync/history
//   Headers: Authorization: Bearer <token>, trakt-api-version: 2,
//            trakt-api-key: <client_id>, Content-Type: application/json
//   Body for movies:
//     { "movies":   [{ "ids": { "imdb": "tt0111161" } }] }
//   Body for episodes:
//     { "shows":    [{
//         "ids":     { "imdb": "tt0903747" },
//         "seasons": [{
//           "number":   1,
//           "episodes": [{ "number": 5 }]
//         }]
//       }] }
//
// Why `/sync/history` and not `/scrobble/stop`?
//
//   1. `/scrobble/stop` is designed to terminate an in-progress scrobble
//      session opened via `/scrobble/start`. Aura deliberately skips
//      `/scrobble/start` (it would put the user on Trakt's public
//      "currently watching" feed for every preview attempt), so calling
//      `/stop` standalone is supported by Trakt but inconsistent: it
//      returns 409 Conflict on the second call within 30 minutes for
//      the same item, and the implicit "intent" semantics are awkward
//      when there was no prior start.
//
//   2. `/sync/history` is the canonical "add this to watched history"
//      endpoint. It's idempotent in the right way (multiple plays
//      produce multiple history entries the user can inspect) and
//      doesn't depend on Trakt's scrobble session state at all.
//
//   3. AIOMetadata uses `/checkin` (which both scrobbles AND adds to
//      history) for the same reason — `/scrobble/stop` is unreliable
//      for "I just finished this" semantics. We picked `/sync/history`
//      over `/checkin` because Aura's stricter completion gates
//      (80% + 5 min elapsed in useScrobble.ts) already mean we only
//      fire on a confirmed completion, so the public-feed effect of
//      `/checkin` adds no value over a plain history write.
//
// Aura only fires this on session-end with auto-complete already gated
// to >= 80% (see useScrobble.ts), so the wire path always intends
// "mark watched".
//
// AniList scrobbling is wired through scrobble_anilist.rs — IMDB id
// resolves to AniList media id via title search + a persistent cache.
// `is_anime` on the session drives whether it fires; the anime
// detector in `aiometadata.ts` needs the meta's genre / original
// language / production country signals, all of which are now carried
// on `ActiveScrobbleTarget` so Cinemeta-supplied IMDB anime
// (Frieren, Demon Slayer, etc.) flows through correctly.
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

/// Build the `/sync/history` body for marking a target as watched.
/// Trakt accepts top-level `movies`, `shows`, and `episodes` arrays;
/// for episodes we use the nested `shows[].seasons[].episodes[]` shape
/// which lets us key the show by IMDB id and the episode by S/E
/// numbers without needing the Trakt-internal episode id.
fn build_history_body(target: &TraktTarget) -> serde_json::Value {
    match target {
        TraktTarget::Movie { imdb } => serde_json::json!({
            "movies": [{ "ids": { "imdb": imdb } }],
        }),
        TraktTarget::Episode { show_imdb, season, number } => serde_json::json!({
            "shows": [{
                "ids":     { "imdb": show_imdb },
                "seasons": [{
                    "number":   season,
                    "episodes": [{ "number": number }],
                }],
            }],
        }),
    }
}

// ---------------------------------------------------------------------------
// Trakt /sync/history — async path, called from scrobble_end
// ---------------------------------------------------------------------------

async fn trakt_sync_history(scope: &str, sess: &ScrobbleSession, time: f64, duration: f64) {
    let Some(token) = scrobble_auth::read_token_for("trakt", scope) else {
        // No connected Trakt account — silently no-op. AniList-only
        // users land here, as do guest sessions.
        crate::devlog!(
            info, "scrobble",
            "Trakt /sync/history skipped: no token for scope={scope}",
        );
        return;
    };
    let Some(target) = parse_trakt_target(&sess.imdb_id, &sess.media_type) else {
        crate::devlog!(
            warn, "scrobble",
            "Trakt /sync/history skipped: id format unsupported: {} (type={})",
            sess.imdb_id, sess.media_type,
        );
        return;
    };

    let progress_pct = if duration > 0.0 {
        (time / duration * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let body = build_history_body(&target);

    let res = client()
        .post(format!("{TRAKT_API}/sync/history"))
        .header("Authorization", format!("Bearer {}", token.access_token))
        .header("Content-Type", "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", scrobble_auth::TRAKT_CLIENT_ID)
        .json(&body)
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            // Trakt's /sync/history response includes an `added` /
            // `not_found` breakdown — we don't parse it, but logging
            // the status code is enough for users to verify in
            // DevConsole that the call landed (201 Created on success).
            crate::devlog!(
                info, "scrobble",
                "Trakt /sync/history OK (status={}, {:.0}% watched) for {}",
                r.status().as_u16(), progress_pct, sess.imdb_id,
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
                "Trakt /sync/history status {}",
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
            crate::devlog!(warn, "scrobble", "Trakt /sync/history {category}");
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
    crate::devlog!(
        info, "scrobble",
        "scrobble_start: id={} type={} ep={:?} title=\"{}\" anime={} scope={} duration={:.0}s",
        session.imdb_id, session.media_type, session.episode,
        session.title, session.is_anime, session.scope, duration,
    );
    *session_slot().lock().map_err(|e| e.to_string())? = Some(session);
    record_playback(0.0, duration);
    // Intentionally no HTTP fires here. Trakt's /scrobble/start would
    // put the user on the public "currently watching" feed, which
    // earlier feedback flagged as too eager — flipping an episode the
    // user is previewing into the public feed before they decided to
    // commit. The /sync/history POST fires on completion only (>= 80%
    // + useScrobble's elapsed-time floor).
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
    app: AppHandle<R>,
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
    let progress = if duration > 0.0 { (time / duration * 100.0).clamp(0.0, 100.0) } else { 0.0 };
    crate::devlog!(
        info, "scrobble",
        "scrobble_end: id={} progress={:.0}% anime={} scope={} - dispatching to providers",
        sess.imdb_id, progress, sess.is_anime, scope,
    );
    // Trakt: covers movies + IMDB-id'd series (most of the catalogue).
    trakt_sync_history(&scope, &sess, time, duration).await;
    // AniList: separate provider, separate keyring entry, separate
    // failure mode. Internally no-ops when sess.is_anime is false or
    // no AniList token is stored, so calling it unconditionally is
    // cheap. We treat its outcome as best-effort the same way Trakt
    // does — a 401 clears the keyring entry so Settings reflects
    // "expired, reconnect" on next refresh.
    match crate::scrobble_anilist::save_progress(&app, &scope, &sess).await {
        Ok(()) => {}
        Err(crate::scrobble_anilist::AnilistError::Unauthorized) => {
            crate::devlog!(
                warn, "scrobble",
                "AniList 401/403 - clearing token for scope={scope} (user must reconnect)",
            );
            crate::scrobble_auth::clear_token_for("anilist", &scope);
        }
        Err(crate::scrobble_anilist::AnilistError::NotFound) => {
            // Anime not on AniList, or search returned no candidates.
            // Common; not actionable.
        }
        Err(e) => {
            crate::devlog!(warn, "scrobble", "AniList save failed: {e}");
        }
    }
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

pub fn shutdown_blocking<R: Runtime>(app: &AppHandle<R>) {
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

    // ── Trakt flush ────────────────────────────────────────────────
    // Mirrors `trakt_sync_history` above but with a 2s timeout so a
    // slow / unreachable Trakt API can't hold up app shutdown. We
    // re-build the client locally rather than reusing the OnceLock
    // singleton because reqwest's per-request timeout overrides the
    // builder's, and we want a tighter ceiling than the 8s runtime
    // default for the shutdown path specifically.
    if let (Some(target), Some(token)) = (
        parse_trakt_target(&sess.imdb_id, &sess.media_type),
        scrobble_auth::read_token_for("trakt", &scope),
    ) {
        crate::devlog!(
            info, "scrobble",
            "shutdown_blocking flushing Trakt /sync/history for {} ({:.0}%)",
            sess.imdb_id, progress_pct,
        );
        let body = build_history_body(&target);
        let _ = tauri::async_runtime::block_on(async move {
            let cli = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .https_only(true)
                .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " scrobble"))
                .build()
                .ok()?;
            cli.post(format!("{TRAKT_API}/sync/history"))
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

    // ── AniList flush ──────────────────────────────────────────────
    // Best-effort, capped at 2 s. AniList is async + GraphQL so it's
    // a different code path from Trakt's bare HTTP POST. We reuse
    // save_progress (which internally no-ops for non-anime / no
    // token) wrapped in a tokio timeout so the shutdown handler
    // can't hang on a stuck network.
    if sess.is_anime && scrobble_auth::read_token_for("anilist", &scope).is_some() {
        crate::devlog!(
            info, "scrobble",
            "shutdown_blocking flushing AniList progress for \"{}\"",
            sess.title,
        );
        let app_clone = app.clone();
        let sess_clone = sess.clone();
        let scope_clone = scope.clone();
        let _ = tauri::async_runtime::block_on(async move {
            tokio::time::timeout(
                Duration::from_secs(2),
                crate::scrobble_anilist::save_progress(&app_clone, &scope_clone, &sess_clone),
            )
            .await
        });
    }
}
