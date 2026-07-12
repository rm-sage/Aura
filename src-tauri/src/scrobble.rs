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
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
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
    /// Authoritative season number from the VideoEntry the user
    /// actually clicked in the episode picker. When present, preferred
    /// over the ID-parsed value for the Trakt payload (the two can
    /// disagree when AIOMetadata's metadata provider produces absolute
    /// vs multi-season numbering inconsistently — common for anime
    /// where the stream id may be TMDB-multi-season while the
    /// VideoEntry's display numbers are TVDB-absolute, or vice-versa).
    /// `None` for movies and for older targets that don't supply it.
    #[serde(default)]
    pub season: Option<u32>,
    /// Authoritative episode number, paired with `season` above. Same
    /// disambiguation purpose.
    #[serde(default)]
    pub episode_num: Option<u32>,
    /// Series-root IMDb id (e.g. `"tt22248376"`), kept separately from
    /// `imdb_id` (which carries the *video* id for the episode being
    /// scrobbled). Required after AIOMetadata's IMDb-anime patch makes
    /// the video id non-tt-prefixed (e.g. `kitsu:46474:5`) while the
    /// series root stays IMDb. Trakt scrobble keys the show by IMDb id
    /// + S/E numbers, so without this we lose the show anchor for
    /// anime once the video ids switch shape.
    ///
    /// Optional because movies and pre-patch shows don't need it (the
    /// id parse path still works) and because frontend may not always
    /// have a separate series root to thread. When None, scrobble.rs
    /// falls back to extracting the show id from `imdb_id` via the
    /// existing parse path — which yields the same value for IMDb-keyed
    /// episodes today.
    #[serde(default)]
    pub series_imdb_id: Option<String>,
    /// Absolute episode number across the entire show, summed from
    /// every earlier main-run cour's episode count + the current
    /// cour-relative episode. Aura computes this on the frontend
    /// from the meta detail (cour-relative is what AIOMetadata's
    /// cour-aggregated `videos[].episode` carries).
    ///
    /// Used by `trakt_targets` to build a tertiary fallback target
    /// for shows Trakt indexes by absolute numbering instead of
    /// per-cour seasons (Frieren is the canonical example —
    /// `tt22248376` on Trakt has all 38 episodes under S1, so a
    /// cour-2-ep-9 payload returns `not_found` while
    /// cour-2-absolute-37 succeeds). None when the frontend doesn't
    /// have a meta detail to compute against (movies, pre-patch
    /// shows, scoped scrobble events firing before the videos array
    /// resolved).
    #[serde(default)]
    pub absolute_episode_num: Option<u32>,
    /// AIOMetadata-embedded AniList media id for this episode's cour, threaded
    /// from the VideoEntry (Aura<->AIOMetadata scrobble contract). When present
    /// with `anilist_episode`, `scrobble_anilist::save_progress` saves straight
    /// to this entry and bypasses the Fribb id-map / title-search / sequel-walk
    /// / offset heuristics. AniList-only; Trakt still keys by IMDb + S/E.
    #[serde(default)]
    pub anilist_id: Option<u64>,
    /// AIOMetadata-embedded episode number LOCAL to `anilist_id` (1-indexed).
    /// Paired with `anilist_id`; ignored without it.
    #[serde(default)]
    pub anilist_episode: Option<u32>,
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

#[derive(Clone, Debug, PartialEq)]
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

/// Build the primary + optional fallback Trakt targets for a session.
///
/// AIOMetadata can produce dual-numbering inconsistencies depending on
/// the selected metadata provider for anime — the stream id may carry
/// one season/episode tuple (e.g. TMDB multi-season `tt22248376:2:3`)
/// while the VideoEntry's `season` / `episode` fields carry another
/// (TVDB absolute `S1E31` for the same physical episode). Trakt
/// indexes by TVDB ordering for anime, so the "right" payload depends
/// on whether Trakt's catalog uses absolute or multi-season for that
/// show. Rather than guess, we send the VideoEntry's authoritative
/// numbers first; if Trakt reports `not_found`, the wrapper retries
/// with the ID-parsed alternate.
///
/// Returns:
///   • Primary  — what to send first (VideoEntry override if present,
///     else the ID-parsed value).
///   • Fallback — a different target to retry with on not_found; None
///     when the two would be identical (no retry needed) or when the
///     session has no usable id (skip path).
/// Build the ordered list of Trakt /sync/history targets to try for a
/// single scrobble event. Tried in priority order; the retry loop in
/// `trakt_sync_history` walks the list until one returns `Added` or
/// the list is exhausted.
///
/// Ordering rationale:
///   1. VideoEntry-authoritative cour numbering (`series_imdb_id` +
///      `sess.season` + `sess.episode_num`). What AIOMetadata's
///      cour-aggregation patch encodes as the canonical view. Trakt
///      anime entries that follow TVDB's cour-per-season layout
///      accept this directly.
///   2. ID-parsed numbering (legacy `tt…:S:E` ids). Only different
///      from #1 when the id-string S/E disagrees with the VideoEntry
///      override — the dual-numbering anime case that the original
///      fallback was designed for.
///   3. Absolute episode under S1 (`series_imdb_id` + S1 +
///      `sess.absolute_episode_num`). Covers Trakt entries that
///      index by show-wide absolute numbering (Frieren is the
///      canonical example — all 38 eps under S1). Only added when
///      the absolute number differs from #1's episode (so single-
///      cour shows don't generate a duplicate retry).
///
/// Movies emit one target — the IMDb movie id. The Vec contract
/// keeps the calling shape uniform.
///
/// Returns an empty Vec when no valid target can be synthesized
/// (movie without a valid IMDb id, series without any S/E source).
/// Callers treat empty as "skip — id format unsupported".
fn trakt_targets(sess: &ScrobbleSession) -> Vec<TraktTarget> {
    let from_id = parse_trakt_target(&sess.imdb_id, &sess.media_type);
    let series_root = sess.series_imdb_id.clone().or_else(|| {
        sess.imdb_id.split(':').next().filter(|s| s.starts_with("tt")).map(String::from)
    });

    let primary: Option<TraktTarget> = match (&from_id, sess.season, sess.episode_num, &series_root) {
        // VideoEntry S/E + id-parsed show — use S/E with the show
        // anchor from the id parse.
        (Some(TraktTarget::Episode { show_imdb, .. }), Some(s), Some(e), _) => {
            Some(TraktTarget::Episode {
                show_imdb: show_imdb.clone(),
                season: s,
                number: e,
            })
        }
        // Id parse failed (kitsu-shape video) but we have the series
        // root + VideoEntry S/E.
        (None, Some(s), Some(e), Some(root)) if sess.media_type != "movie" => {
            Some(TraktTarget::Episode {
                show_imdb: root.clone(),
                season: s,
                number: e,
            })
        }
        // Movie variant.
        (None, _, _, Some(root)) if sess.media_type == "movie" => {
            Some(TraktTarget::Movie { imdb: root.clone() })
        }
        _ => None,
    };

    // Build the ordered candidate list, dedup'ing identical entries
    // so a single-cour show or a show whose cour/absolute numbering
    // matches doesn't fan out duplicate POSTs.
    let mut out: Vec<TraktTarget> = Vec::new();
    let mut push_unique = |t: TraktTarget| {
        if !out.iter().any(|existing| existing == &t) {
            out.push(t);
        }
    };

    if let Some(p) = primary {
        push_unique(p);
    }
    if let Some(id_target) = from_id {
        push_unique(id_target);
    }
    // Absolute-numbering retry — only for episodes (movies don't
    // carry episode numbers). Synthesized under S1 with the
    // absolute episode supplied by the frontend.
    if sess.media_type != "movie" {
        if let (Some(root), Some(abs)) = (series_root.as_ref(), sess.absolute_episode_num) {
            push_unique(TraktTarget::Episode {
                show_imdb: root.clone(),
                season: 1,
                number: abs,
            });
        }
    }
    out
}

/// Build the `/sync/history` body for marking a target as watched.
/// Trakt accepts top-level `movies`, `shows`, and `episodes` arrays;
/// for episodes we use the nested `shows[].seasons[].episodes[]` shape
/// which lets us key the show by IMDB id and the episode by S/E
/// numbers without needing the Trakt-internal episode id.
///
/// `watched_at` (ISO 8601 UTC, e.g. `2026-07-12T21:04:00.000Z`) backdates
/// the history row to the original watch time. Trakt accepts it on the
/// movie object and on the episode object; when `None`, Trakt stamps the
/// row with "now" (the automatic scrobble path's behavior). Only the
/// manual "scrobble a History item" path supplies it.
fn build_history_body(target: &TraktTarget, watched_at: Option<&str>) -> serde_json::Value {
    match target {
        TraktTarget::Movie { imdb } => {
            let mut movie = serde_json::json!({ "ids": { "imdb": imdb } });
            if let Some(ts) = watched_at {
                movie["watched_at"] = serde_json::Value::String(ts.to_string());
            }
            serde_json::json!({ "movies": [movie] })
        }
        TraktTarget::Episode { show_imdb, season, number } => {
            let mut episode = serde_json::json!({ "number": number });
            if let Some(ts) = watched_at {
                episode["watched_at"] = serde_json::Value::String(ts.to_string());
            }
            serde_json::json!({
                "shows": [{
                    "ids":     { "imdb": show_imdb },
                    "seasons": [{
                        "number":   season,
                        "episodes": [episode],
                    }],
                }],
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Trakt /sync/history — async path, called from scrobble_end
// ---------------------------------------------------------------------------

/// Structured outcome of one /sync/history POST attempt. Distinguishes
/// "Trakt accepted AND added the row" from "Trakt accepted but said
/// not_found" so the retry-on-fallback path and the scrobble-test
/// command can both surface the difference.
#[derive(Clone, Copy, Debug)]
enum TraktSyncOutcome {
    /// Trakt's response body had `added.episodes > 0` (or `added.movies`)
    /// — actually written to history.
    Added,
    /// Trakt accepted the payload (201) but the show/episode wasn't in
    /// their catalog under that numbering. Caller may retry with an
    /// alternate (season, number) tuple.
    NotFound,
    /// HTTP-level failure (4xx other than 401, 5xx, network blip, etc.).
    /// Distinct from NotFound: doesn't trigger the dual-numbering retry
    /// because the cause isn't a metadata mismatch.
    HttpError,
    /// 401 — token expired/revoked. Caller is responsible for clearing.
    Unauthorized,
}

/// Public summary used by `scrobble_test_fire` so the DevConsole toast
/// can say "fired" vs "not_found" vs "failed" instead of the generic
/// "fired" that masked silent misses for the entire dual-numbered
/// anime catalog.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TraktSyncResult {
    Fired,        // Primary or fallback added a row.
    NotFound,     // Both attempts (or single attempt with no fallback) returned not_found.
    Skipped,      // No token / unsupported id / movie pre-checks failed.
    Failed,       // HTTP error or network blip.
}

#[derive(Deserialize)]
struct TraktSyncResponseAdded { #[serde(default)] episodes: u32, #[serde(default)] movies: u32 }
#[derive(Deserialize)]
struct TraktSyncResponseNotFound {
    #[serde(default)] episodes: Vec<serde_json::Value>,
    #[serde(default)] movies:   Vec<serde_json::Value>,
    /// Show-level miss: Trakt couldn't find the show under the
    /// supplied imdb id at all. Distinct from episode-level miss
    /// (show exists but the requested S/E doesn't). When present,
    /// the whole scrobble is a no-op regardless of episode count.
    #[serde(default)] shows:    Vec<serde_json::Value>,
    /// Season-level miss for sync/history payloads that key by
    /// season instead of episode. Included for completeness — Aura
    /// doesn't currently send season-keyed payloads but the field
    /// keeps the catch-all `not_found_n` count accurate if a
    /// future call shape does.
    #[serde(default)] seasons:  Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct TraktSyncResponseBody {
    #[serde(default)] added:     Option<TraktSyncResponseAdded>,
    #[serde(default)] not_found: Option<TraktSyncResponseNotFound>,
}

/// Single POST to /sync/history with the given target. Returns the
/// structured outcome; the caller decides whether to retry with a
/// fallback target (dual-numbering) or surface the result as final.
async fn trakt_sync_history_once(
    token_bearer: &str, target: &TraktTarget, sess: &ScrobbleSession, progress_pct: f64,
    watched_at: Option<&str>,
) -> TraktSyncOutcome {
    let body = build_history_body(target, watched_at);
    let res = client()
        .post(format!("{TRAKT_API}/sync/history"))
        .header("Authorization", format!("Bearer {token_bearer}"))
        .header("Content-Type", "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", scrobble_auth::TRAKT_CLIENT_ID)
        .json(&body)
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            // Parse `added` vs `not_found` from the response body. Trakt
            // accepts syntactically valid payloads even when the show or
            // episode isn't in their catalog (silent miss). The earlier
            // status-only handler treated those as success — that's the
            // bug this whole refactor fixes.
            let status = r.status().as_u16();
            // Read raw text first so the diagnostic on parse failure
            // can dump what Trakt actually sent — previously the
            // "unparseable, treating as added" branch ate every silent
            // miss because `r.json()` consumed the body and we had
            // nothing to show.
            let raw = r.text().await.unwrap_or_default();
            let body: Result<TraktSyncResponseBody, _> = serde_json::from_str(&raw);
            let (added_n, not_found_n) = match &body {
                Ok(b) => {
                    let added = b.added.as_ref()
                        .map(|a| a.episodes + a.movies)
                        .unwrap_or(0);
                    let nf = b.not_found.as_ref()
                        .map(|n| (n.shows.len() + n.seasons.len() + n.episodes.len() + n.movies.len()) as u32)
                        .unwrap_or(0);
                    (added, nf)
                }
                Err(_) => (0, 0),
            };
            if added_n > 0 {
                crate::devlog!(
                    info, "scrobble",
                    "Trakt /sync/history OK (status={}, {:.0}% watched, added={}) for {}",
                    status, progress_pct, added_n, sess.imdb_id,
                );
                TraktSyncOutcome::Added
            } else if not_found_n > 0 {
                let preview: String = raw.chars().take(400).collect();
                crate::devlog!(
                    warn, "scrobble",
                    "Trakt /sync/history accepted but not_found (status={}, not_found={}) for {} \
                     — show/episode not in Trakt's catalog under this numbering. body: {}",
                    status, not_found_n, sess.imdb_id, preview,
                );
                TraktSyncOutcome::NotFound
            } else if body.is_err() {
                // Parse failed AND no added/not_found extracted —
                // surface the raw body so the cause is diagnosable
                // (truncated to 400 chars to keep the log usable).
                // Treated as a NotFound so the retry path engages
                // instead of silently false-flagging the scrobble.
                let preview: String = raw.chars().take(400).collect();
                crate::devlog!(
                    warn, "scrobble",
                    "Trakt /sync/history body parse failed (status={}) for {}: {} — treating as not_found so the retry fallback can engage",
                    status, sess.imdb_id, preview,
                );
                TraktSyncOutcome::NotFound
            } else {
                // Successfully parsed but both counters are zero. This
                // shouldn't happen with Trakt's documented response
                // shape, but if it does, surface the body and treat
                // as not_found so we don't silently mark unwritten
                // scrobbles as "fired".
                let preview: String = raw.chars().take(400).collect();
                crate::devlog!(
                    warn, "scrobble",
                    "Trakt /sync/history returned zero added AND zero not_found (status={}) for {}: {} — treating as not_found",
                    status, sess.imdb_id, preview,
                );
                TraktSyncOutcome::NotFound
            }
        }
        Ok(r) if r.status().as_u16() == 401 => {
            crate::devlog!(
                warn, "scrobble",
                "Trakt 401: token expired/revoked (will clear, user must reconnect)",
            );
            TraktSyncOutcome::Unauthorized
        }
        Ok(r) => {
            crate::devlog!(warn, "scrobble", "Trakt /sync/history status {}", r.status().as_u16());
            TraktSyncOutcome::HttpError
        }
        Err(e) => {
            let category = if e.is_timeout() { "timeout" }
                else if e.is_connect() { "connect" }
                else { "send" };
            crate::devlog!(warn, "scrobble", "Trakt /sync/history {category}");
            TraktSyncOutcome::HttpError
        }
    }
}

async fn trakt_sync_history(
    scope: &str, sess: &ScrobbleSession, time: f64, duration: f64, watched_at: Option<&str>,
) -> TraktSyncResult {
    let Some(mut token) = scrobble_auth::read_token_for("trakt", scope) else {
        crate::devlog!(
            info, "scrobble",
            "Trakt /sync/history skipped: no token for scope={scope}",
        );
        return TraktSyncResult::Skipped;
    };

    // ── Proactive refresh ──────────────────────────────────────────
    // Trakt access tokens are 90-day-lived. If this one is within ~7
    // days of expiry, refresh BEFORE dispatching so the request goes
    // out with a fresh token rather than relying on the reactive 401
    // backstop. `expires_at == None` means the proxy didn't stamp an
    // expiry (older token) — skip the proactive check and let the
    // reactive path handle it.
    if let Some(exp) = token.expires_at {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        const PROACTIVE_WINDOW: u64 = 7 * 24 * 3600;
        if exp.saturating_sub(now) < PROACTIVE_WINDOW {
            match scrobble_auth::refresh_trakt_token(scope, Some(&token.access_token)).await {
                Ok(_) => {
                    // Re-read so the dispatch below uses the rotated token.
                    match scrobble_auth::read_token_for("trakt", scope) {
                        Some(fresh) => token = fresh,
                        None => {
                            // Cleared out from under us between refresh
                            // and re-read — treat as expired.
                            crate::devlog!(
                                warn, "scrobble",
                                "Trakt token vanished after proactive refresh for scope={scope}",
                            );
                            return TraktSyncResult::Skipped;
                        }
                    }
                }
                Err(scrobble_auth::RefreshError::Rejected) => {
                    // Refresh token dead — keyring already cleared by
                    // refresh_trakt_token; the expired-token notification
                    // will fire. Abort the sync cleanly.
                    crate::devlog!(
                        warn, "scrobble",
                        "Trakt proactive refresh rejected for scope={scope} — aborting sync, user must reconnect",
                    );
                    return TraktSyncResult::Skipped;
                }
                Err(scrobble_auth::RefreshError::Transient(reason)) => {
                    // Proxy/network blip — proceed with the still-valid
                    // current token; the reactive 401 path is the backstop.
                    crate::devlog!(
                        info, "scrobble",
                        "Trakt proactive refresh transient failure for scope={scope}: {reason} — proceeding with current token",
                    );
                }
                Err(scrobble_auth::RefreshError::NoRefreshToken) => {
                    // No refresh_token stored — nothing to do proactively;
                    // the reactive 401 path will fall back to re-auth.
                    crate::devlog!(
                        info, "scrobble",
                        "Trakt token near expiry for scope={scope} but no refresh_token stored",
                    );
                }
            }
        }
    }

    let candidates = trakt_targets(sess);
    if candidates.is_empty() {
        crate::devlog!(
            warn, "scrobble",
            "Trakt /sync/history skipped: id format unsupported: {} (type={})",
            sess.imdb_id, sess.media_type,
        );
        return TraktSyncResult::Skipped;
    }

    let progress_pct = if duration > 0.0 {
        (time / duration * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    // Walk the candidate list in priority order. First Added wins;
    // NotFound triggers the next attempt; everything else short-
    // circuits and surfaces the corresponding TraktSyncResult.
    // Logs name which candidate position is firing so the user can
    // see in DevConsole which numbering Trakt's catalog accepted.
    let total = candidates.len();
    for (idx, target) in candidates.iter().enumerate() {
        if idx > 0 {
            crate::devlog!(
                info, "scrobble",
                "Trakt not_found on attempt {} — retrying with candidate {}/{}",
                idx, idx + 1, total,
            );
        }
        let mut outcome = trakt_sync_history_once(
            &token.access_token, target, sess, progress_pct, watched_at,
        ).await;

        // ── Reactive refresh on 401 ────────────────────────────────
        // The token 401'd mid-flight (expired since the proactive
        // check, or there was no proactive check). Try to refresh and
        // retry this exact request ONCE. The per-scope async mutex in
        // refresh_trakt_token collapses concurrent 401s onto a single
        // refresh so the rotating refresh_token isn't double-spent.
        if let TraktSyncOutcome::Unauthorized = outcome {
            match scrobble_auth::refresh_trakt_token(scope, Some(&token.access_token)).await {
                Ok(refreshed) => {
                    crate::devlog!(
                        info, "scrobble",
                        "Trakt 401 — token refreshed, retrying /sync/history once",
                    );
                    // Re-read the persisted token so any later candidate
                    // iteration also uses the fresh access_token.
                    if let Some(fresh) = scrobble_auth::read_token_for("trakt", scope) {
                        token = fresh;
                    } else {
                        token.access_token = refreshed.access_token.clone();
                    }
                    outcome = trakt_sync_history_once(
                        &token.access_token, target, sess, progress_pct, watched_at,
                    ).await;
                    if let TraktSyncOutcome::Unauthorized = outcome {
                        // Refreshed token still 401s — give up, clear,
                        // surface the reconnect prompt. Do NOT loop.
                        crate::devlog!(
                            warn, "scrobble",
                            "Trakt /sync/history 401 even after refresh — clearing token",
                        );
                        scrobble_auth::clear_token_for("trakt", scope);
                        return TraktSyncResult::Failed;
                    }
                }
                Err(scrobble_auth::RefreshError::Rejected) => {
                    // refresh_token dead — refresh_trakt_token already
                    // cleared the keyring. Same outcome as the old
                    // clear-on-401 path; the notification fires.
                    return TraktSyncResult::Failed;
                }
                Err(scrobble_auth::RefreshError::Transient(reason)) => {
                    // Transient refresh failure — do NOT clear; the
                    // token is left intact for a later retry.
                    crate::devlog!(
                        warn, "scrobble",
                        "Trakt 401 + transient refresh failure: {reason} — leaving token intact, failing this sync",
                    );
                    return TraktSyncResult::Failed;
                }
                Err(scrobble_auth::RefreshError::NoRefreshToken) => {
                    // Nothing to refresh with — fall back to the legacy
                    // clear-token-and-re-auth behaviour.
                    scrobble_auth::clear_token_for("trakt", scope);
                    return TraktSyncResult::Failed;
                }
            }
        }

        match outcome {
            TraktSyncOutcome::Added => return TraktSyncResult::Fired,
            TraktSyncOutcome::Unauthorized => {
                // Reached only when the reactive block above didn't run
                // (it always resolves Unauthorized to a return or a
                // non-401 outcome) — defensive, mirrors legacy behaviour.
                scrobble_auth::clear_token_for("trakt", scope);
                return TraktSyncResult::Failed;
            }
            TraktSyncOutcome::HttpError => return TraktSyncResult::Failed,
            TraktSyncOutcome::NotFound => {
                // Try the next candidate.
                continue;
            }
        }
    }
    crate::devlog!(
        warn, "scrobble",
        "Trakt /sync/history exhausted all {} candidate target(s) without Added",
        total,
    );
    TraktSyncResult::NotFound
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
    trakt_sync_history(&scope, &sess, time, duration, None).await;
    // AniList: separate provider, separate keyring entry, separate
    // failure mode. Internally no-ops when sess.is_anime is false or
    // no AniList token is stored, so calling it unconditionally is
    // cheap. We treat its outcome as best-effort the same way Trakt
    // does — a 401 clears the keyring entry so Settings reflects
    // "expired, reconnect" on next refresh.
    match crate::scrobble_anilist::save_progress(&app, &scope, &sess, None).await {
        Ok(_) => {}
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

/// Outcome of a `scrobble_test_fire` call. Surfaced to the DevConsole
/// command so the user can see exactly what fired.
#[derive(Clone, Debug, Serialize)]
pub struct ScrobbleTestResult {
    /// Was a session loaded (`load_video` had run)?
    pub session_active: bool,
    /// Item id the test fired against (for series this is the EPISODE
    /// id, e.g. `tt0903747:1:5`; for movies it's the bare imdb id).
    pub id: Option<String>,
    /// "anime" / "series" / "movie".
    pub media_type: Option<String>,
    /// True when the session was tagged as anime (drives the AniList
    /// branch). The DevConsole prints this so the user can reason
    /// about why AniList fired or didn't.
    pub is_anime: bool,
    /// Did Trakt fire (token present + parseable target)?
    pub trakt_fired: bool,
    /// Did AniList fire (token present + is_anime + resolvable id)?
    pub anilist_fired: bool,
    /// Human-readable summary the DevConsole prints verbatim.
    pub message: String,
}

// ---------------------------------------------------------------------------
// DevConsole test command
//
// Fires the same scrobble paths that scrobble_end uses, but bypasses
// the elapsed-time warmup gates so the user can verify their
// Trakt/AniList wiring without having to actually watch 120+ seconds
// of every test stream.
//
// Session source preference:
//   1. The frontend can pass a fully-formed `session` (built from its
//      `activeTarget` + active scope). This is the path the
//      DevConsole's `scrobble` command uses, since `activeTarget`
//      is always present the moment `load_video` returns — well
//      before the 120s START_WARMUP_S that gates the real
//      `scrobble_start` from populating `session_slot`.
//   2. If `session` is None, fall back to the live `session_slot`.
//      This is the "user manually watched 2+ minutes and then ran
//      the test command" path; convenient when both work.
//   3. If neither is available, return a friendly "no active stream"
//      message so the DevConsole user understands what happened.
//
// Honors the same gates as scrobble_end:
//   - Trakt token present (skipped silently if not connected)
//   - AniList: is_anime + token present + resolvable IMDB id
//
// Pretends time = 95% of duration so Trakt's /sync/history records
// as a normal completion instead of the 0%-watched edge case. If
// the caller passes a real `time` / `duration` we use those instead.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scrobble_test_fire<R: Runtime>(
    app: AppHandle<R>,
    session: Option<ScrobbleSession>,
    time: Option<f64>,
    duration: Option<f64>,
) -> Result<ScrobbleTestResult, String> {
    // Source the session: caller-provided (DevConsole path) wins over
    // the live slot because it's available before the 120s warmup.
    let sess = if let Some(s) = session {
        s
    } else {
        match session_slot().lock().map_err(|e| e.to_string())?.clone() {
            Some(s) => s,
            None => {
                return Ok(ScrobbleTestResult {
                    session_active: false,
                    id: None, media_type: None, is_anime: false,
                    trakt_fired: false, anilist_fired: false,
                    message: "no active stream - either load_video hasn't been called \
                              or the frontend didn't pass an activeTarget".into(),
                });
            }
        }
    };

    let scope = sess.scope.clone();
    // Prefer caller-supplied time/duration (DevConsole reads MPV's
    // playback snapshot from React state and forwards it). Fall back
    // to the heartbeat-tracked last_playback slot, then to a
    // synthetic 95%/100% pair so the wire call still goes out even
    // before duration has been observed.
    let (last_time, last_duration) = last_playback_slot()
        .lock().map(|g| *g).unwrap_or((0.0, 0.0));
    let supplied_dur = duration.filter(|d| d.is_finite() && *d > 0.0);
    let supplied_time = time.filter(|t| t.is_finite() && *t >= 0.0);
    let (test_time, test_duration) = match (supplied_time, supplied_dur) {
        (Some(t), Some(d)) => (t.min(d * 0.95).max(d * 0.95), d),
        (_, Some(d))       => (d * 0.95, d),
        _ if last_duration > 0.0 => (last_duration * 0.95, last_duration),
        _ if last_time > 0.0     => (last_time, (last_time / 0.95).max(1.0)),
        _                  => (95.0, 100.0),
    };

    let anilist_will_fire = sess.is_anime
        && scrobble_auth::read_token_for("anilist", &scope).is_some();

    crate::devlog!(
        info, "scrobble",
        "scrobble_test_fire: id={} type={} anime={} scope={} test_progress={:.0}% season={:?} ep={:?}",
        sess.imdb_id, sess.media_type, sess.is_anime, scope,
        if test_duration > 0.0 { test_time / test_duration * 100.0 } else { 0.0 },
        sess.season, sess.episode_num,
    );

    let trakt_result = trakt_sync_history(&scope, &sess, test_time, test_duration, None).await;
    let anilist_outcome = crate::scrobble_anilist::save_progress(&app, &scope, &sess, None).await;
    if let Err(crate::scrobble_anilist::AnilistError::Unauthorized) = anilist_outcome {
        crate::devlog!(
            warn, "scrobble",
            "AniList 401/403 - clearing token for scope={scope} (user must reconnect)",
        );
        crate::scrobble_auth::clear_token_for("anilist", &scope);
    }

    let trakt_msg = match trakt_result {
        TraktSyncResult::Fired    => "fired".to_string(),
        TraktSyncResult::NotFound => "not_found (S/E mismatch with Trakt catalog)".to_string(),
        TraktSyncResult::Skipped  => "skipped (no token or unsupported id)".to_string(),
        TraktSyncResult::Failed   => "failed (network or HTTP error)".to_string(),
    };
    let anilist_msg = if anilist_will_fire {
        match &anilist_outcome {
            Ok(_) => "fired".to_string(),
            Err(crate::scrobble_anilist::AnilistError::NotFound)
                => "skipped (not on AniList)".to_string(),
            Err(e) => format!("failed: {e}"),
        }
    } else if !sess.is_anime {
        "skipped (session not flagged as anime)".to_string()
    } else {
        "skipped (no AniList token)".to_string()
    };
    let message = format!(
        "test scrobble fired for \"{}\" ({} {}). Trakt: {}, AniList: {}",
        sess.title, sess.media_type,
        sess.episode.as_deref().unwrap_or(""),
        trakt_msg, anilist_msg,
    );
    Ok(ScrobbleTestResult {
        session_active: true,
        id: Some(sess.imdb_id),
        media_type: Some(sess.media_type),
        is_anime: sess.is_anime,
        trakt_fired: trakt_result == TraktSyncResult::Fired,
        anilist_fired: anilist_will_fire && anilist_outcome.is_ok(),
        message,
    })
}

// ---------------------------------------------------------------------------
// Manual "scrobble a History item" commands
//
// The History tab lets the user push a past watch to Trakt / AniList on
// demand, backdated to the ORIGINAL watch time (`played_at`). These go
// through the SAME target resolution + POST/retry machinery as the
// automatic scrobble path (trakt_targets / trakt_sync_history for Trakt,
// save_progress for AniList); they only differ in (a) supplying the
// backdate and (b) returning a human-readable outcome string (or an Err
// with a legible reason) so the UI can toast it. Nothing here fails
// silently.
// ---------------------------------------------------------------------------

/// Assemble a `ScrobbleSession` from the fields a History row carries.
/// `episode` (the trailing S/E number) is threaded as `episode_num` and
/// the season as `season`, mirroring what the live scrobble path passes
/// from the VideoEntry the user clicked; `parent_id` becomes the
/// series-root IMDb anchor. `imdb_id`/`title` reuse the existing session
/// field names.
#[allow(clippy::too_many_arguments)]
fn session_from_history(
    id:         String,
    parent_id:  Option<String>,
    media_type: String,
    season:     Option<u32>,
    episode:    Option<u32>,
    name:       String,
    is_anime:   bool,
    scope:      String,
) -> ScrobbleSession {
    ScrobbleSession {
        imdb_id: id,
        media_type,
        episode: None,
        title: name,
        is_anime,
        scope,
        season,
        episode_num: episode,
        series_imdb_id: parent_id,
        absolute_episode_num: None,
        anilist_id: None,
        anilist_episode: None,
    }
}

/// Push a History item to Trakt's /sync/history, backdated to `played_at`
/// (ISO 8601 UTC). Returns a short outcome string on success, or an Err
/// with a legible reason (not connected / unsupported id / catalog miss /
/// network failure).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn scrobble_history_trakt<R: Runtime>(
    _app:       AppHandle<R>,
    id:         String,
    parent_id:  Option<String>,
    media_type: String,
    season:     Option<u32>,
    episode:    Option<u32>,
    name:       String,
    scope:      String,
    played_at:  String,
) -> Result<String, String> {
    if scrobble_auth::read_token_for("trakt", &scope).is_none() {
        return Err("Trakt is not connected. Connect it in Settings > Scrobbling.".into());
    }
    let sess = session_from_history(id, parent_id, media_type, season, episode, name, false, scope.clone());
    let trimmed = played_at.trim();
    let watched_at = if trimmed.is_empty() { None } else { Some(trimmed) };
    crate::devlog!(
        info, "scrobble",
        "scrobble_history_trakt: id={} scope={} watched_at={:?}",
        sess.imdb_id, scope, watched_at,
    );
    // time/duration only feed a progress-% log line on this path; pass a
    // synthetic completion pair.
    match trakt_sync_history(&scope, &sess, 100.0, 100.0, watched_at).await {
        TraktSyncResult::Fired    => Ok("Added to Trakt history".into()),
        TraktSyncResult::NotFound => {
            Err("Trakt has no catalog match for this title under its numbering.".into())
        }
        TraktSyncResult::Skipped  => {
            Err("This item has no IMDb id Trakt can use.".into())
        }
        TraktSyncResult::Failed   => {
            Err("Trakt request failed (network error or token rejected). Try again.".into())
        }
    }
}

/// Push a History item to AniList, backdating the completion date to
/// `played_at` when the write completes the entry (AniList's
/// `completedAt` is day-precision, no time of day). Anime-only; the
/// frontend only offers this for anime rows. Returns a short outcome
/// string on success or an Err with a legible reason.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn scrobble_history_anilist<R: Runtime>(
    app:        AppHandle<R>,
    id:         String,
    parent_id:  Option<String>,
    media_type: String,
    season:     Option<u32>,
    episode:    Option<u32>,
    name:       String,
    scope:      String,
    played_at:  String,
) -> Result<String, String> {
    if scrobble_auth::read_token_for("anilist", &scope).is_none() {
        return Err("AniList is not connected. Connect it in Settings > Scrobbling.".into());
    }
    // is_anime = true so save_progress runs its resolver; the frontend
    // gates this command to anime rows already.
    let sess = session_from_history(id, parent_id, media_type, season, episode, name, true, scope.clone());
    let completed_at = crate::scrobble_anilist::parse_fuzzy_date(&played_at);
    crate::devlog!(
        info, "scrobble",
        "scrobble_history_anilist: id={} scope={} completed_at={:?}",
        sess.imdb_id, scope, completed_at,
    );
    use crate::scrobble_anilist::{AnilistError, SaveOutcome};
    match crate::scrobble_anilist::save_progress(&app, &scope, &sess, completed_at).await {
        Ok(SaveOutcome::Saved { progress, total, completed }) => {
            if completed {
                let total_str = total.map(|t| t.to_string()).unwrap_or_else(|| progress.to_string());
                Ok(format!("AniList marked complete ({progress}/{total_str})"))
            } else {
                Ok(format!("AniList progress set to {progress}"))
            }
        }
        Ok(SaveOutcome::AlreadyAhead { progress }) => {
            Ok(format!("AniList already at episode {progress} or beyond"))
        }
        Ok(SaveOutcome::NotApplicable) => {
            Err("AniList scrobbling is not available for this item.".into())
        }
        Ok(SaveOutcome::Unresolvable) => {
            Err("Could not resolve this title to an AniList entry.".into())
        }
        Err(AnilistError::Unauthorized) => {
            scrobble_auth::clear_token_for("anilist", &scope);
            Err("AniList sign-in expired. Reconnect it in Settings > Scrobbling.".into())
        }
        Err(AnilistError::NotFound) => {
            Err("Could not find this anime on AniList.".into())
        }
        Err(e) => Err(format!("AniList request failed: {e}")),
    }
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

    // ── Flush Trakt + AniList CONCURRENTLY ─────────────────────────
    // Both are best-effort network writes each capped at 2 s. They used to run
    // as two SEQUENTIAL `block_on`s — up to 4 s on an anime title linked to
    // both services — serializing app shutdown (and a slow exit widens the
    // Windows self-update file-lock window). Joining them in ONE runtime entry
    // caps the pair at ~2 s. Each still no-ops when its service isn't linked.
    //
    // Trakt uses the highest-priority trakt_targets candidate (VideoEntry's
    // authoritative season/episode over the ID-parsed / absolute fallback),
    // fire-and-forget with no not_found retry — the shutdown path can't wait on
    // a body parse + a second round-trip. AniList reuses save_progress (which
    // self-no-ops for non-anime / no token). Clients are built locally with a
    // 2 s timeout, tighter than the 8 s runtime default.
    let primary_target = trakt_targets(&sess).into_iter().next();
    let trakt_token = scrobble_auth::read_token_for("trakt", &scope);
    let anilist_linked =
        sess.is_anime && scrobble_auth::read_token_for("anilist", &scope).is_some();
    let imdb_id = sess.imdb_id.clone();
    let title = sess.title.clone();
    let app = app.clone();

    tauri::async_runtime::block_on(async move {
        let trakt = async {
            let (Some(target), Some(token)) = (primary_target, trakt_token) else {
                return;
            };
            crate::devlog!(
                info, "scrobble",
                "shutdown_blocking flushing Trakt /sync/history for {} ({:.0}%)",
                imdb_id, progress_pct,
            );
            let body = build_history_body(&target, None);
            let Ok(cli) = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .https_only(true)
                .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " scrobble"))
                .build()
            else {
                return;
            };
            let _ = cli
                .post(format!("{TRAKT_API}/sync/history"))
                .header("Authorization", format!("Bearer {}", token.access_token))
                .header("Content-Type", "application/json")
                .header("trakt-api-version", "2")
                .header("trakt-api-key", scrobble_auth::TRAKT_CLIENT_ID)
                .json(&body)
                .send()
                .await;
        };
        let anilist = async {
            if !anilist_linked {
                return;
            }
            crate::devlog!(
                info, "scrobble",
                "shutdown_blocking flushing AniList progress for \"{}\"",
                title,
            );
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                crate::scrobble_anilist::save_progress(&app, &scope, &sess, None),
            )
            .await;
        };
        tokio::join!(trakt, anilist);
    });
}
