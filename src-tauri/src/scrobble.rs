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
) -> TraktSyncOutcome {
    let body = build_history_body(target);
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

async fn trakt_sync_history(scope: &str, sess: &ScrobbleSession, time: f64, duration: f64) -> TraktSyncResult {
    let Some(token) = scrobble_auth::read_token_for("trakt", scope) else {
        crate::devlog!(
            info, "scrobble",
            "Trakt /sync/history skipped: no token for scope={scope}",
        );
        return TraktSyncResult::Skipped;
    };
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
        let outcome = trakt_sync_history_once(
            &token.access_token, target, sess, progress_pct,
        ).await;
        match outcome {
            TraktSyncOutcome::Added => return TraktSyncResult::Fired,
            TraktSyncOutcome::Unauthorized => {
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

    let trakt_result = trakt_sync_history(&scope, &sess, test_time, test_duration).await;
    let anilist_outcome = crate::scrobble_anilist::save_progress(&app, &scope, &sess).await;
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
            Ok(()) => "fired".to_string(),
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
    // Use the highest-priority candidate from trakt_targets so the
    // VideoEntry's authoritative season/episode is preferred over the
    // ID-parsed alternate / absolute fallback. Fire-and-forget; no
    // retry on `not_found` here because the shutdown path can't wait
    // on the response body parse + a second round-trip.
    let primary_target = trakt_targets(&sess).into_iter().next();
    if let (Some(target), Some(token)) = (
        primary_target,
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
