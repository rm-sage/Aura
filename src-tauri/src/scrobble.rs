// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::scrobble_auth;
use crate::settings;

// ---------------------------------------------------------------------------
// Scrobble: completion reporting to AniList and Simkl, using the OAuth tokens
// stored by scrobble_auth.rs.
//
// Earlier rounds of Aura proxied scrobble events through the AIOMetadata
// addon's `/scrobble` resource. That is gone: each provider is called
// directly with the user's own token, and AIOMetadata is no longer in the
// scrobble path at all.
//
// AniList (scrobble_anilist.rs): the IMDb id resolves to an AniList media id
// (the addon's embedded per-video pair first, then the Fribb id map, a title
// search and a persistent cache). `is_anime` on the session decides whether it
// fires; the anime detector in `aiometadata.ts` needs the meta's genre /
// original language / production country signals, all of which are carried on
// `ActiveScrobbleTarget` so Cinemeta-supplied IMDb anime (Frieren, Demon
// Slayer, etc.) flows through correctly.
//
// Simkl (scrobble_simkl.rs) is completion-only (POST /sync/history, never
// /scrobble/*): one POST per finished movie / episode, plus one fallback POST
// with show-level ids for an anime episode whose cour-level ids come back
// not_found, every one paced by send_paced. Anime goes to it alongside AniList
// rather than instead of it. Inert in a build without a Simkl client_id.
//
// Aura fires a provider only on session end with auto-complete gated to
// >= 80% (see useScrobble.ts), so the wire path always means "mark watched".
// Nothing is sent at session start: a live "watching now" push would put a
// preview on a public feed.
//
// All scrobble traffic is best-effort: failures are logged via
// `crate::devlog!` but never propagate to the user. The scrobble pipeline
// must never block playback.
// ---------------------------------------------------------------------------

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
    /// over the ID-parsed value (the two can disagree when AIOMetadata's
    /// metadata provider produces absolute vs multi-season numbering
    /// inconsistently, common for anime where the stream id may be
    /// TMDB-multi-season while the VideoEntry's display numbers are
    /// TVDB-absolute, or vice versa). `None` for movies and for older
    /// targets that don't supply it.
    #[serde(default)]
    pub season: Option<u32>,
    /// Authoritative episode number, paired with `season` above. Same
    /// disambiguation purpose.
    #[serde(default)]
    pub episode_num: Option<u32>,
    /// Series-root IMDb id (e.g. `"tt22248376"`), kept separately from
    /// `imdb_id` (which carries the *video* id for the episode being
    /// scrobbled). Required since AIOMetadata's IMDb-anime patch makes
    /// the video id non-tt-prefixed (e.g. `kitsu:46474:5`) while the
    /// series root stays IMDb, so a provider keying the show by IMDb id
    /// + S/E numbers still has its show anchor.
    ///
    /// Optional because movies and pre-patch shows don't need it and the
    /// frontend may not always have a separate series root to thread.
    /// When None, the show id is parsed from `imdb_id`, which yields the
    /// same value for IMDb-keyed episodes.
    #[serde(default)]
    pub series_imdb_id: Option<String>,
    /// AIOMetadata-embedded AniList media id for this episode's cour, threaded
    /// from the VideoEntry (Aura<->AIOMetadata scrobble contract). When present
    /// with `anilist_episode`, `scrobble_anilist::save_progress` saves straight
    /// to this entry and bypasses the Fribb id-map / title-search / sequel-walk
    /// / offset heuristics.
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
// can flush a completion with realistic time/duration values without
// touching MPV (libmpv get_property during the close transition is one of
// the documented STATUS_ACCESS_VIOLATION triggers — CLAUDE.md landmine #3).
// Without this, a hard window-close lost a completion: the JS-side
// scrobble_end never fires when the process exits.
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
// Bulk-run flag, mirrored from the frontend.
//
// The bulk History scrobble runs in the WEBVIEW (see scrobbleRun.ts), but the
// window-close decision is made in Rust. This flag is how the close handler
// learns that a job is in flight so it can ask the user instead of silently
// killing a half-finished run and leaving AniList/Simkl partially updated with
// no record of where it stopped.
// ---------------------------------------------------------------------------

static SCROBBLE_RUN_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Marker prefix on an error a RETRY CAN NEVER FIX.
///
/// Simkl has no catalog match for some items; AniList cannot resolve some titles
/// at all. Those verdicts are stable, so the bulk runner marks
/// the row permanently ineligible instead of re-attempting it (and re-reporting it
/// as a failure) on every single run.
///
/// The frontend keys on this exact prefix and strips it before showing the message
/// (`scrobbleRun.ts` / `HistoryView.tsx`). Kept as a machine-readable marker rather
/// than having the frontend pattern-match English prose, which would silently break
/// the moment anyone reworded an error.
pub const PERMANENT_PREFIX: &str = "[permanent] ";

/// True while a bulk History scrobble is running. Read by window_logic's
/// CloseRequested handler.
pub fn scrobble_run_active() -> bool {
    SCROBBLE_RUN_ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

/// Mirror the frontend's bulk-run state into Rust. The frontend MUST clear this
/// (in a `finally`) or the window could never be closed again.
#[tauri::command]
pub fn set_scrobble_run_active(app: tauri::AppHandle, active: bool) {
    SCROBBLE_RUN_ACTIVE.store(active, std::sync::atomic::Ordering::Release);
    if !active {
        // A run that finished while the window sits in the tray no longer
        // keeps the webview visible.
        crate::window_logic::repark_if_tray_hidden(&app);
    }
}

/// Last time a PROACTIVE token refresh was attempted, per key.
static LAST_PROACTIVE_REFRESH: OnceLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    OnceLock::new();

/// Rate-limit the proactive refresh path to at most one attempt per scope per
/// `REFRESH_COOLDOWN`.
///
/// The window check alone is not enough. Once a token IS genuinely inside the
/// window, every subsequent call would try to refresh until one succeeds -- and
/// if the refresh endpoint is the thing that's failing (429), that is a retry
/// storm that makes the 429 worse. This caps proactive attempts regardless, so a
/// bulk run degrades to "use the current token, let the reactive 401 path sort it
/// out" instead of hammering. Returns true when a refresh may be attempted, and
/// stamps the attempt.
///
/// The reactive (401) refresh is deliberately NOT gated by this: that one only
/// fires when the server has already rejected the token, so it is self-limiting.
///
/// The key names the provider and scope (scrobble_simkl.rs passes
/// `simkl:<scope>`), so a provider added later never spends Simkl's cooldown.
pub(crate) fn proactive_refresh_allowed(scope: &str) -> bool {
    const REFRESH_COOLDOWN: Duration = Duration::from_secs(60);
    let map = LAST_PROACTIVE_REFRESH.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let Ok(mut guard) = map.lock() else { return true };
    let now = std::time::Instant::now();
    if let Some(prev) = guard.get(scope) {
        if now.duration_since(*prev) < REFRESH_COOLDOWN {
            return false;
        }
    }
    guard.insert(scope.to_string(), now);
    true
}

// ---------------------------------------------------------------------------
// Provider fan-out
//
// An automatic push goes to every provider in `Provider::ALL`. scrobble_end,
// scrobble_test_fire and shutdown_blocking used to spell out each provider
// call by hand, each in its own shape (sequential,
// sequential-with-results, tokio::join!), so a provider wired into one of
// them could be missing from another with nothing to say so. All three now
// iterate the slice and route through `dispatch`, whose match is exhaustive
// over (provider, push): a new variant does not compile until `dispatch`
// handles it for both kinds of push. `ALL` is still listed by hand and nothing
// checks it against the enum, so a variant left out of it compiles clean and
// is never dispatched. Each caller keeps its own concurrency: the two command
// paths run the slice in order, the shutdown flush joins it.
//
// A closed enum rather than a trait: each arm is a direct call into that
// provider's module and nothing here needs dynamic dispatch.
// ---------------------------------------------------------------------------

/// A provider an automatic scrobble push fans out to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Provider {
    Anilist,
    Simkl,
}

impl Provider {
    /// Every provider, in dispatch order. The sequential callers run them in
    /// exactly this order: AniList, then Simkl.
    const ALL: &'static [Provider] = &[Provider::Anilist, Provider::Simkl];
}

/// Which kind of push `dispatch` is making.
#[derive(Clone, Copy, Debug)]
enum Push {
    /// End of playback, or the DevConsole test: each provider's full path
    /// (AniList's resolver, Simkl's refresh + fallback-id walk), with
    /// the outcome handed back to the caller.
    Completion,
    /// The window-close flush: a hard ~2 s budget and nobody left to report
    /// to, so each provider takes a cheaper fire-and-forget path.
    Shutdown { progress_pct: f64 },
}

/// What one provider did with a push.
enum ProviderOutcome {
    /// A 401 in here has already been handled (token cleared) by `dispatch`.
    Anilist(Result<crate::scrobble_anilist::SaveOutcome, crate::scrobble_anilist::AnilistError>),
    /// Refresh, 401 and not_found handling already happened inside
    /// `push_completion`, which also logged the outcome.
    Simkl(crate::scrobble_simkl::SimklSyncResult),
    /// A `Push::Shutdown` flush. Fire-and-forget, so there is nothing to report.
    Flushed,
}

async fn dispatch<R: Runtime>(
    provider: Provider,
    push:     Push,
    app:      &AppHandle<R>,
    scope:    &str,
    sess:     &ScrobbleSession,
) -> ProviderOutcome {
    use crate::scrobble_anilist::{save_progress, AnilistError};
    match (provider, push) {
        // AniList: separate provider, separate keyring entry, separate
        // failure mode. Internally no-ops when sess.is_anime is false or
        // no AniList token is stored, so calling it unconditionally is
        // cheap. Its outcome is best-effort: a 401 clears the keyring
        // entry so Settings reflects "expired, reconnect" on next refresh.
        (Provider::Anilist, Push::Completion) => {
            let outcome = save_progress(app, scope, sess, None).await;
            if let Err(AnilistError::Unauthorized) = outcome {
                crate::devlog!(
                    warn, "scrobble",
                    "AniList 401/403 - clearing token for scope={scope} (user must reconnect)",
                );
                scrobble_auth::clear_token_for("anilist", scope);
            }
            ProviderOutcome::Anilist(outcome)
        }
        // AniList reuses save_progress under a 2 s cap. Skipped outright for
        // a non-anime session or when no AniList token is stored.
        (Provider::Anilist, Push::Shutdown { .. }) => {
            let linked =
                sess.is_anime && scrobble_auth::read_token_for("anilist", scope).is_some();
            if !linked {
                return ProviderOutcome::Flushed;
            }
            crate::devlog!(
                info, "scrobble",
                "shutdown_blocking flushing AniList progress for \"{}\"",
                sess.title,
            );
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                save_progress(app, scope, sess, None),
            )
            .await;
            ProviderOutcome::Flushed
        }
        // Simkl: movies, series AND anime (it supplements AniList, so an anime
        // episode reaches both). Returns at once, with no request, in a build
        // without a Simkl client_id or when no Simkl token is stored.
        (Provider::Simkl, Push::Completion) => {
            ProviderOutcome::Simkl(crate::scrobble_simkl::push_completion(scope, sess).await)
        }
        // One POST of the best candidate, no refresh and no not_found retry,
        // capped at 2 s inside flush_on_shutdown like the other providers.
        (Provider::Simkl, Push::Shutdown { progress_pct }) => {
            crate::scrobble_simkl::flush_on_shutdown(scope, sess, progress_pct).await;
            ProviderOutcome::Flushed
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
    // Intentionally no HTTP fires here. A live "watching now" push would
    // put an episode the user is only previewing on a public feed before
    // they decided to commit. Providers are told on completion only
    // (>= 80% + useScrobble's elapsed-time floor).
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

/// Minimum watched fraction (percent of runtime) for an AUTOMATIC end-of-
/// playback push to count as "watched". Kept in step with the frontend's
/// completion threshold in src/useScrobble.ts. Manual History-page scrobbling
/// deliberately bypasses this: there the user is asserting the fact directly.
const AUTO_COMPLETE_MIN_PCT: f64 = 80.0;

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
    if !s.auto_scrobble_enabled {
        // Automatic scrobbling is off. This is the END-OF-PLAYBACK push, i.e. the
        // automatic path — so it stands down. The History page's manual and bulk
        // scrobbling deliberately does NOT consult this flag: the whole point of
        // turning automatic off is to choose what gets recorded by hand instead.
        crate::devlog!(
            info, "scrobble",
            "scrobble_end: automatic scrobbling is off — skipping the completion push \
             (History-page scrobbling still works)",
        );
        return Ok(());
    }

    let scope = sess.scope.clone();
    let progress = if duration > 0.0 { (time / duration * 100.0).clamp(0.0, 100.0) } else { 0.0 };
    // Completion floor. `scrobble_end` is invoked from EVERY frontend teardown
    // path (exit playback, episode switch, unmount, beforeunload), not only
    // from the >= 80% completion branch, and Simkl's /sync/history is an
    // unconditional "mark watched" with no progress semantics. Without this,
    // quitting two minutes into an episode marked it watched and advanced AniList.
    // `duration <= 0` means we never learned the runtime, so the ratio is not
    // meaningful: keep the old behaviour there rather than silently dropping a
    // real completion.
    if duration > 0.0 && progress < AUTO_COMPLETE_MIN_PCT {
        crate::devlog!(
            info, "scrobble",
            "scrobble_end: id={} progress={:.0}% is under the {:.0}% bar - closing the session \
             without marking watched (teardown, not a completion)",
            sess.imdb_id, progress, AUTO_COMPLETE_MIN_PCT,
        );
        return Ok(());
    }
    crate::devlog!(
        info, "scrobble",
        "scrobble_end: id={} progress={:.0}% anime={} scope={} - dispatching to providers",
        sess.imdb_id, progress, sess.is_anime, scope,
    );
    // In order, one after the other: AniList, then Simkl.
    use crate::scrobble_anilist::AnilistError;
    let push = Push::Completion;
    for &provider in Provider::ALL {
        match dispatch(provider, push, &app, &scope, &sess).await {
            // Saved / already ahead, or a 401 `dispatch` has already handled.
            ProviderOutcome::Anilist(Ok(_))
            | ProviderOutcome::Anilist(Err(AnilistError::Unauthorized)) => {}
            ProviderOutcome::Anilist(Err(AnilistError::NotFound)) => {
                // Anime not on AniList, or search returned no candidates.
                // Common; not actionable.
            }
            ProviderOutcome::Anilist(Err(e)) => {
                crate::devlog!(warn, "scrobble", "AniList save failed: {e}");
            }
            // push_completion logs its own outcome.
            ProviderOutcome::Simkl(_) => {}
            // Only a Push::Shutdown flush reports this.
            ProviderOutcome::Flushed => {}
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
    /// Did AniList fire (token present + is_anime + resolvable id)?
    pub anilist_fired: bool,
    /// Did Simkl record it (client_id in this build + token present + an id
    /// Simkl matched)? A new field, so older frontends simply ignore it.
    pub simkl_fired: bool,
    /// Human-readable summary the DevConsole prints verbatim.
    pub message: String,
}

// ---------------------------------------------------------------------------
// DevConsole test command
//
// Fires the same scrobble paths that scrobble_end uses, but bypasses
// the elapsed-time warmup gates so the user can verify their
// AniList / Simkl wiring without having to actually watch 120+ seconds
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
//   - AniList: is_anime + token present + resolvable IMDB id
//   - Simkl: a client_id in this build + token present + an id Simkl can use
//
// Pretends time = 95% of duration so each provider records it
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
                    anilist_fired: false, simkl_fired: false,
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

    // Same order as scrobble_end (AniList, then Simkl), one after the other.
    // Each provider contributes its `*_fired` flag and one "<Name>: <outcome>"
    // leg of the message.
    let push = Push::Completion;
    let mut anilist_fired = false;
    let mut simkl_fired = false;
    let mut legs: Vec<String> = Vec::with_capacity(Provider::ALL.len());
    for &provider in Provider::ALL {
        match dispatch(provider, push, &app, &scope, &sess).await {
            ProviderOutcome::Anilist(anilist_outcome) => {
                anilist_fired = anilist_will_fire && anilist_outcome.is_ok();
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
                legs.push(format!("AniList: {anilist_msg}"));
            }
            ProviderOutcome::Simkl(simkl_result) => {
                use crate::scrobble_simkl::SimklSyncResult;
                simkl_fired = simkl_result == SimklSyncResult::Fired;
                let simkl_msg = match simkl_result {
                    SimklSyncResult::Fired         => "fired",
                    SimklSyncResult::NotFound      => "not_found (no catalog match on Simkl)",
                    SimklSyncResult::NoToken       => "skipped (no token)",
                    SimklSyncResult::NoUsableId    => "skipped (no id Simkl can use)",
                    SimklSyncResult::NotConfigured => "skipped (not configured in this build)",
                    SimklSyncResult::Failed        => "failed (network or HTTP error)",
                };
                legs.push(format!("Simkl: {simkl_msg}"));
            }
            // Only a Push::Shutdown flush reports this.
            ProviderOutcome::Flushed => {}
        }
    }
    let message = format!(
        "test scrobble fired for \"{}\" ({} {}). {}",
        sess.title, sess.media_type,
        sess.episode.as_deref().unwrap_or(""),
        legs.join(", "),
    );
    Ok(ScrobbleTestResult {
        session_active: true,
        id: Some(sess.imdb_id),
        media_type: Some(sess.media_type),
        is_anime: sess.is_anime,
        anilist_fired,
        simkl_fired,
        message,
    })
}

// ---------------------------------------------------------------------------
// Manual "scrobble a History item" commands
//
// The History tab lets the user push a past watch to AniList / Simkl on
// demand, backdated to the ORIGINAL watch time (`played_at`). These go
// through the SAME resolution + POST/retry machinery as the automatic
// scrobble path (save_progress for AniList, scrobble_simkl for Simkl);
// they only differ in (a) supplying the
// backdate and (b) returning a human-readable outcome string (or an Err
// with a legible reason) so the UI can toast it. Nothing here fails
// silently.
//
// Simkl's command is the one BATCHED sibling: Simkl allows about one POST
// per second, so a bulk run takes the rows in one call and gets one result
// per row back (see scrobble_simkl::history_batch).
// ---------------------------------------------------------------------------

/// Assemble a `ScrobbleSession` from the fields a History row carries.
/// `episode` (the trailing S/E number) is threaded as `episode_num` and
/// the season as `season`, mirroring what the live scrobble path passes
/// from the VideoEntry the user clicked; `parent_id` becomes the
/// series-root IMDb anchor. `imdb_id`/`title` reuse the existing session
/// field names.
#[allow(clippy::too_many_arguments)]
pub(crate) fn session_from_history(
    id:              String,
    parent_id:       Option<String>,
    media_type:      String,
    season:          Option<u32>,
    episode:         Option<u32>,
    name:            String,
    is_anime:        bool,
    scope:           String,
    anilist_id:      Option<u64>,
    anilist_episode: Option<u32>,
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
        // The addon's per-video AniList mapping, carried on the History row. These
        // used to be hardcoded None, which quietly disabled the AIOMetadata
        // fast-path for EVERY manual/bulk history scrobble: the resolver fell back
        // to title-search + SEQUEL-walk, which cannot place a split-cour show
        // (Dr. STONE S04E29 has no AniList entry with >= 29 episodes, so it landed
        // on the 24-episode base and clamped the save away). Live playback always
        // passed these; history simply never stored them.
        anilist_id,
        anilist_episode,
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
    app:             AppHandle<R>,
    id:              String,
    parent_id:       Option<String>,
    media_type:      String,
    season:          Option<u32>,
    episode:         Option<u32>,
    name:            String,
    scope:           String,
    played_at:       String,
    anilist_id:      Option<u64>,
    anilist_episode: Option<u32>,
) -> Result<String, String> {
    if scrobble_auth::read_token_for("anilist", &scope).is_none() {
        return Err("AniList is not connected. Connect it in Settings > Scrobbling.".into());
    }
    // is_anime = true so save_progress runs its resolver; the frontend
    // gates this command to anime rows already. The anilist_* pair (when the
    // History row carries it) takes save_progress's embedded fast path and skips
    // the title-search + SEQUEL-walk entirely -- the only way to get split-cour
    // shows right.
    let sess = session_from_history(
        id, parent_id, media_type, season, episode, name, true, scope.clone(),
        anilist_id, anilist_episode,
    );
    let completed_at = crate::scrobble_anilist::parse_fuzzy_date(&played_at);
    crate::devlog!(
        info, "scrobble",
        "scrobble_history_anilist: id={} scope={} completed_at={:?} embedded=({:?},{:?})",
        sess.imdb_id, scope, completed_at, anilist_id, anilist_episode,
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
        // Verdicts about the item itself — AniList has nothing this can map onto, and
        // a retry re-derives the identical answer. Retire the row (PERMANENT_PREFIX)
        // instead of re-failing it every run.
        Ok(SaveOutcome::NotApplicable) => {
            Err(format!("{PERMANENT_PREFIX}AniList scrobbling is not available for this item."))
        }
        Ok(SaveOutcome::Unresolvable) => {
            Err(format!("{PERMANENT_PREFIX}Could not resolve this title to an AniList entry."))
        }
        Err(AnilistError::Unauthorized) => {
            scrobble_auth::clear_token_for("anilist", &scope);
            Err("AniList sign-in expired. Reconnect it in Settings > Scrobbling.".into())
        }
        Err(AnilistError::NotFound) => {
            Err(format!("{PERMANENT_PREFIX}Could not find this anime on AniList."))
        }
        // Everything left (429 after its own retries, 5xx, network, decode) is
        // transient. NOT marked permanent: the runner should back off and retry.
        Err(e) => Err(format!("AniList request failed: {e}")),
    }
}

/// Push a BATCH of History items to Simkl's /sync/history, each backdated to
/// its own `played_at`. Takes the same per-row fields as the two commands
/// above (see `SimklHistoryItem`) and the same `scope`, but many rows per
/// call: Simkl's budget of about one POST per second makes one call per row
/// unsafe for a bulk run. Returns one result per item, in input order
/// (`added` / `not_found` / `failed` / `skipped`, each with a short message;
/// only `failed` is worth retrying), or an Err for the whole batch when Simkl
/// is not set up in this build or not connected.
#[tauri::command]
pub async fn scrobble_history_simkl<R: Runtime>(
    _app:  AppHandle<R>,
    scope: String,
    items: Vec<crate::scrobble_simkl::SimklHistoryItem>,
) -> Result<Vec<crate::scrobble_simkl::SimklHistoryResult>, String> {
    crate::scrobble_simkl::history_batch(&scope, items).await
}

// ---------------------------------------------------------------------------
// Synchronous shutdown helper — called from window_logic's CloseRequested
// handler before app.exit(0) so a completion is still recorded on a hard
// window-close (X button on the title bar). The React useScrobble unmount,
// the normal path, doesn't run when the process exits without React
// shutting down.
//
// Uses tauri::async_runtime::block_on so the HTTP POSTs complete before
// the process exits. Capped at 2 s so a slow / unreachable provider can't
// hold up app shutdown.
// ---------------------------------------------------------------------------

pub fn shutdown_blocking<R: Runtime>(app: &AppHandle<R>) {
    let taken = match session_slot().lock() {
        Ok(mut g) => g.take(),
        Err(_) => return,
    };
    let Some(sess) = taken else { return; };

    let s = settings::snapshot();
    // Same gate as scrobble_end: this shutdown flush IS the automatic path,
    // just fired from the close handler instead of end-of-file.
    if !s.auto_scrobble_enabled { return; }

    let (time, duration) = last_playback_slot()
        .lock()
        .map(|g| *g)
        .unwrap_or((0.0, 0.0));
    let progress_pct = if duration > 0.0 {
        (time / duration * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    // Same completion floor as scrobble_end: closing the window part-way
    // through an episode is not a completion and must not mark it watched.
    if duration > 0.0 && progress_pct < AUTO_COMPLETE_MIN_PCT {
        crate::devlog!(
            info, "scrobble",
            "shutdown flush: id={} progress={:.0}% is under the {:.0}% bar - not marking watched",
            sess.imdb_id, progress_pct, AUTO_COMPLETE_MIN_PCT,
        );
        return;
    }

    let scope = sess.scope.clone();

    // ── Flush every provider CONCURRENTLY ──────────────────────────
    // Each is a best-effort network write capped at 2 s. They used to run as
    // SEQUENTIAL `block_on`s (up to 4 s on an anime title linked to two
    // services), serializing app shutdown (and a slow exit widens the
    // Windows self-update file-lock window). Joining them in ONE runtime entry
    // caps the lot at ~2 s. Each still no-ops when its service isn't linked.
    //
    // `join_all` over `Provider::ALL` rather than a fixed `tokio::join!`, so a
    // provider added to the slice is flushed alongside the others instead of
    // needing its own slot here. The per-provider shutdown paths (AniList's
    // capped save_progress, Simkl's single-candidate POST) live in the
    // `Push::Shutdown` arms of `dispatch`.
    let push = Push::Shutdown { progress_pct };
    tauri::async_runtime::block_on(futures_util::future::join_all(
        Provider::ALL
            .iter()
            .map(|&provider| dispatch(provider, push, app, &scope, &sess)),
    ));
}

