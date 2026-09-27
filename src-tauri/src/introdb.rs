// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! IntroDB client: a crowd-sourced, IMDb-keyed skip-segment database
//! (intro / recap / outro, plus post-credits for movies).
//!
//! Read:
//!   GET https://api.introdb.app/segments?imdb_id=tt..&season=N&episode=N
//!   GET https://api.introdb.app/segments?imdb_id=tt..&is_movie=true
//!   -> { intro, recap, outro, post_credits }, each null or
//!      { start_sec, end_sec, start_ms, end_ms, confidence, submission_count, updated_at }
//!   No key. No rate-limit headers are sent, so this module is gentle: one
//!   request per (title, numbering) per cache window.
//!
//! Write (user-initiated only, personal key from the OS keyring):
//!   POST https://api.introdb.app/submit, header `X-API-Key: idb_...`
//!   200 ok, 400 invalid, 401 bad key, 429 = one submission per segment and
//!   episode per 5 minutes (reported as "already submitted recently").
//!
//! NUMBERING. IntroDB rows are keyed by whatever numbering the SUBMITTER used
//! (Bleach tt0434665 has rows under both S1E250 and S12E5). This module never
//! guesses: it answers exactly the (season, episode) it is asked for. Picking
//! which numberings to try, and in what order, is the frontend's job
//! (`src/introdb.ts`), which only ever tries numberings Aura already knows.
//!
//! TRUST. A segment with `submission_count >= 2` AND `confidence >= 0.9` is
//! emitted as source "introdb" (ranked with AniSkip); anything else is
//! "introdb-single" (ranked just under publicmetadb, and never auto-skips).
//!
//! One Tauri command, `introdb`, takes a tagged action (fetch / submit /
//! status) so the three registration sites cover the whole feature.
//! Devlog label `[introdb]`. The API key is never logged.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const INTRODB_BASE: &str = "https://api.introdb.app";

/// Positive answers live 3 days, the same window as the frontend AniSkip cache:
/// long enough that a binge never re-asks, short enough that a community
/// correction surfaces within days.
const POSITIVE_TTL: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// "No data" is cached only briefly: a fresh submission should be picked up on
/// the next watch, and the point of the negative entry is only to stop a
/// re-open of the same episode from re-asking within the same sitting.
const NEGATIVE_TTL: Duration = Duration::from_secs(30 * 60);
/// Bounded like every other cache in the app; the oldest quarter goes on
/// overflow.
const CACHE_CAP: usize = 400;

/// No real intro / recap / outro sits past six hours into a file. Anything
/// that claims to is a unit error (ms sent as seconds) or junk.
const MAX_SEGMENT_END_SEC: f64 = 6.0 * 60.0 * 60.0;
/// Slack when checking a segment against the caller's file duration. Release
/// lengths differ by a frame or two; more than this means a different cut, and
/// the segment is dropped rather than clamped onto the wrong edit.
const DURATION_SLACK_SEC: f64 = 2.0;
/// Shorter than this is a mis-click, not a segment.
const MIN_SEGMENT_SEC: f64 = 1.0;

/// Trust split. Both conditions must hold for "introdb".
pub const TRUSTED_MIN_SUBMISSIONS: i64 = 2;
pub const TRUSTED_MIN_CONFIDENCE: f64 = 0.9;

pub const SOURCE_TRUSTED: &str = "introdb";
pub const SOURCE_SINGLE: &str = "introdb-single";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// One segment as IntroDB sends it. Every field optional so a partial or
/// reshaped row degrades to "dropped" rather than failing the whole parse.
#[derive(Debug, Clone, Default, Deserialize)]
struct ApiSegment {
    #[serde(default)] start_sec:        Option<f64>,
    #[serde(default)] end_sec:          Option<f64>,
    #[serde(default)] start_ms:         Option<f64>,
    #[serde(default)] end_ms:           Option<f64>,
    #[serde(default)] confidence:       Option<f64>,
    #[serde(default)] submission_count: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct ApiSegments {
    #[serde(default)] intro:        Option<ApiSegment>,
    #[serde(default)] recap:        Option<ApiSegment>,
    #[serde(default)] outro:        Option<ApiSegment>,
    /// Parsed so the wire shape is documented, never used: see parse_segments.
    #[allow(dead_code)]
    #[serde(default)] post_credits: Option<ApiSegment>,
}

/// One validated window in Aura's vocabulary. `kind` is "op" | "recap" | "ed";
/// `start` / `end` are seconds.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IntroDbWindow {
    pub kind:             String,
    pub start:            f64,
    pub end:              f64,
    pub source:           String,
    pub confidence:       f64,
    pub submission_count: i64,
}

// ---------------------------------------------------------------------------
// Parsing + validation (pure; unit-tested below)
// ---------------------------------------------------------------------------

/// Source name for a segment's trust level.
pub fn trust_source(submission_count: i64, confidence: f64) -> &'static str {
    if submission_count >= TRUSTED_MIN_SUBMISSIONS
        && confidence.is_finite()
        && confidence >= TRUSTED_MIN_CONFIDENCE
    {
        SOURCE_TRUSTED
    } else {
        SOURCE_SINGLE
    }
}

/// Validate one segment. Seconds are preferred; the ms pair is the fallback
/// when the seconds pair is absent. Returns None for anything that is not a
/// finite, non-negative, forward interval inside the sane bound.
fn validate_segment(kind: &str, seg: &ApiSegment) -> Option<IntroDbWindow> {
    let (start, end) = match (seg.start_sec, seg.end_sec) {
        (Some(s), Some(e)) => (s, e),
        _ => (seg.start_ms? / 1000.0, seg.end_ms? / 1000.0),
    };
    if !start.is_finite() || !end.is_finite() {
        return None;
    }
    if start < 0.0 || end <= start || end - start < MIN_SEGMENT_SEC {
        return None;
    }
    if end > MAX_SEGMENT_END_SEC {
        return None;
    }
    // A missing / non-finite / out-of-range confidence reads as zero trust,
    // never as full trust.
    let confidence = seg
        .confidence
        .filter(|c| c.is_finite() && (0.0..=1.0).contains(c))
        .unwrap_or(0.0);
    let submission_count = seg.submission_count.filter(|n| *n >= 0).unwrap_or(0);
    Some(IntroDbWindow {
        kind: kind.to_string(),
        start,
        end,
        source: trust_source(submission_count, confidence).to_string(),
        confidence,
        submission_count,
    })
}

/// Parse a `/segments` body into validated windows (no duration check yet:
/// the parsed list is what gets cached, and the duration is per file).
/// `post_credits` is deliberately ignored: it is a scene AFTER the credits,
/// i.e. content, and Aura has no slot that means "skip to the stinger".
fn parse_segments(body: &str) -> Result<Vec<IntroDbWindow>, serde_json::Error> {
    let parsed: ApiSegments = serde_json::from_str(body)?;
    let mut out = Vec::new();
    for (kind, seg) in [("op", &parsed.intro), ("recap", &parsed.recap), ("ed", &parsed.outro)] {
        if let Some(seg) = seg {
            if let Some(w) = validate_segment(kind, seg) {
                out.push(w);
            }
        }
    }
    Ok(out)
}

/// Keep only windows that fit the caller's file. With no usable duration the
/// list passes through unchanged. An end that overshoots by less than the slack
/// is clamped; more than that is a different cut and the window is dropped.
fn fit_to_duration(windows: Vec<IntroDbWindow>, duration: Option<f64>) -> Vec<IntroDbWindow> {
    let Some(d) = duration.filter(|d| d.is_finite() && *d > 0.0) else {
        return windows;
    };
    windows
        .into_iter()
        .filter(|w| w.start < d && w.end <= d + DURATION_SLACK_SEC)
        .map(|mut w| {
            if w.end > d {
                w.end = d;
            }
            w
        })
        .filter(|w| w.end - w.start >= MIN_SEGMENT_SEC)
        .collect()
}

/// `^tt[0-9]{7,8}$`, the pattern the API enforces.
fn valid_imdb(id: &str) -> bool {
    let Some(digits) = id.strip_prefix("tt") else { return false };
    (7..=8).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

/// (season, episode) for an episode, None for a movie. Both or neither; each
/// must be >= 1 (IntroDB has no season 0).
fn episode_target(season: Option<u32>, episode: Option<u32>) -> Result<Option<(u32, u32)>, String> {
    match (season, episode) {
        (None, None) => Ok(None),
        (Some(s), Some(e)) if s >= 1 && e >= 1 => Ok(Some((s, e))),
        (Some(_), Some(_)) => Err("season and episode must both be >= 1".into()),
        _ => Err("season and episode must be given together".into()),
    }
}

/// Aura skip kind -> IntroDB segment type. Kinds IntroDB has no slot for
/// (mixed-op) return None and are simply not submitted.
fn segment_type_for(kind: &str) -> Option<&'static str> {
    match kind {
        "op" => Some("intro"),
        "ed" => Some("outro"),
        "recap" => Some("recap"),
        _ => None,
    }
}

/// Round to milliseconds so the body never carries float noise.
fn round_ms(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Build the `/submit` JSON body. Optional ids are omitted, not sent as null.
fn submit_body(
    segment_type: &str,
    imdb_id: &str,
    target: Option<(u32, u32)>,
    start: f64,
    end: f64,
    tvdb_id: Option<i64>,
    tmdb_id: Option<i64>,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert("segment_type".into(), segment_type.into());
    body.insert("imdb_id".into(), imdb_id.into());
    match target {
        Some((s, e)) => {
            body.insert("season".into(), s.into());
            body.insert("episode".into(), e.into());
        }
        None => {
            body.insert("is_movie".into(), true.into());
        }
    }
    body.insert("start_sec".into(), round_ms(start).into());
    body.insert("end_sec".into(), round_ms(end).into());
    if let Some(id) = tvdb_id.filter(|v| *v > 0) {
        body.insert("tvdb_id".into(), id.into());
    }
    if let Some(id) = tmdb_id.filter(|v| *v > 0) {
        body.insert("tmdb_id".into(), id.into());
    }
    serde_json::Value::Object(body)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    windows:   Vec<IntroDbWindow>,
    cached_at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(imdb_id: &str, target: Option<(u32, u32)>) -> String {
    match target {
        Some((s, e)) => format!("{imdb_id}:{s}:{e}"),
        None => format!("{imdb_id}:movie"),
    }
}

fn cache_get(key: &str) -> Option<Vec<IntroDbWindow>> {
    let lock = cache().lock().unwrap();
    let entry = lock.get(key)?;
    let ttl = if entry.windows.is_empty() { NEGATIVE_TTL } else { POSITIVE_TTL };
    (entry.cached_at.elapsed() < ttl).then(|| entry.windows.clone())
}

fn cache_insert(key: String, windows: Vec<IntroDbWindow>) {
    let mut lock = cache().lock().unwrap();
    if lock.len() >= CACHE_CAP && !lock.contains_key(&key) {
        let mut ages: Vec<(String, Instant)> =
            lock.iter().map(|(k, e)| (k.clone(), e.cached_at)).collect();
        ages.sort_by_key(|(_, at)| *at);
        for (k, _) in ages.into_iter().take(CACHE_CAP / 4) {
            lock.remove(&k);
        }
    }
    lock.insert(key, CacheEntry { windows, cached_at: Instant::now() });
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(8))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("introdb client init failed")
    })
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum IntroDbAction {
    /// Segments for one (title, numbering). Omit season AND episode for a movie.
    Fetch {
        imdb_id: String,
        #[serde(default)] season:   Option<u32>,
        #[serde(default)] episode:  Option<u32>,
        /// File duration in seconds, when the caller knows it.
        #[serde(default)] duration: Option<f64>,
    },
    /// User-initiated submission of one segment. `kind` is Aura's vocabulary
    /// ("op" | "ed" | "recap").
    Submit {
        imdb_id: String,
        #[serde(default)] season:  Option<u32>,
        #[serde(default)] episode: Option<u32>,
        kind:  String,
        start: f64,
        end:   f64,
        #[serde(default)] tvdb_id: Option<i64>,
        #[serde(default)] tmdb_id: Option<i64>,
    },
    /// Whether a personal key is stored. Never returns the key itself.
    Status,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitOutcome {
    Ok,
    /// 429: this segment of this episode was submitted in the last 5 minutes.
    RateLimited,
    /// 401: the stored key was refused.
    KeyRejected,
    /// 400: IntroDB refused the payload (its message is passed through).
    Invalid,
    /// No key in the keyring.
    NoKey,
    /// Aura kind with no IntroDB equivalent (mixed-op).
    Unsupported,
    /// Anything else (5xx, network).
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum IntroDbReply {
    Segments { found: bool, windows: Vec<IntroDbWindow> },
    Submitted { outcome: SubmitOutcome, message: String },
    Status { has_key: bool },
}

fn stored_key() -> Option<zeroize::Zeroizing<String>> {
    crate::api_keyring::read("introdb").filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub async fn introdb(action: IntroDbAction) -> Result<IntroDbReply, String> {
    match action {
        IntroDbAction::Status => Ok(IntroDbReply::Status { has_key: stored_key().is_some() }),
        IntroDbAction::Fetch { imdb_id, season, episode, duration } => {
            let windows = fetch(&imdb_id, season, episode).await?;
            let windows = fit_to_duration(windows, duration);
            Ok(IntroDbReply::Segments { found: !windows.is_empty(), windows })
        }
        IntroDbAction::Submit { imdb_id, season, episode, kind, start, end, tvdb_id, tmdb_id } => {
            submit(&imdb_id, season, episode, &kind, start, end, tvdb_id, tmdb_id).await
        }
    }
}

async fn fetch(
    imdb_id: &str,
    season: Option<u32>,
    episode: Option<u32>,
) -> Result<Vec<IntroDbWindow>, String> {
    if !valid_imdb(imdb_id) {
        return Err(format!("not an IMDb id: {}", imdb_id.chars().take(24).collect::<String>()));
    }
    let target = episode_target(season, episode)?;
    let key = cache_key(imdb_id, target);
    if let Some(hit) = cache_get(&key) {
        crate::devlog!(info, "introdb", "cache hit {key} ({} window(s))", hit.len());
        return Ok(hit);
    }

    let mut query: Vec<(&str, String)> = vec![("imdb_id", imdb_id.to_string())];
    match target {
        Some((s, e)) => {
            query.push(("season", s.to_string()));
            query.push(("episode", e.to_string()));
        }
        None => query.push(("is_movie", "true".into())),
    }
    crate::devlog!(info, "introdb", "GET /segments {key}");

    let resp = match client().get(format!("{INTRODB_BASE}/segments")).query(&query).send().await {
        Ok(r) => r,
        Err(e) => {
            // Transient: not cached, so the next load retries.
            crate::devlog!(warn, "introdb", "request failed for {key}: {}", e.without_url());
            return Ok(Vec::new());
        }
    };
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        cache_insert(key, Vec::new());
        return Ok(Vec::new());
    }
    if !status.is_success() {
        // 429 / 5xx: transient, never cached.
        crate::devlog!(warn, "introdb", "HTTP {} for {key}", status.as_u16());
        return Ok(Vec::new());
    }
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            crate::devlog!(warn, "introdb", "read error for {key}: {}", e.without_url());
            return Ok(Vec::new());
        }
    };
    let windows = match parse_segments(&body) {
        Ok(w) => w,
        Err(e) => {
            crate::devlog!(warn, "introdb", "JSON parse error for {key}: {e} body_len={}", body.len());
            return Ok(Vec::new());
        }
    };
    crate::devlog!(
        info, "introdb",
        "{key} -> {}",
        if windows.is_empty() {
            "no usable segments".to_string()
        } else {
            windows
                .iter()
                .map(|w| format!(
                    "{} {:.0}-{:.0}s {} (n={}, c={:.2})",
                    w.kind, w.start, w.end, w.source, w.submission_count, w.confidence,
                ))
                .collect::<Vec<_>>()
                .join(", ")
        },
    );
    cache_insert(key, windows.clone());
    Ok(windows)
}

#[allow(clippy::too_many_arguments)]
async fn submit(
    imdb_id: &str,
    season: Option<u32>,
    episode: Option<u32>,
    kind: &str,
    start: f64,
    end: f64,
    tvdb_id: Option<i64>,
    tmdb_id: Option<i64>,
) -> Result<IntroDbReply, String> {
    let reply = |outcome: SubmitOutcome, message: &str| {
        Ok(IntroDbReply::Submitted { outcome, message: message.to_string() })
    };
    let Some(segment_type) = segment_type_for(kind) else {
        return reply(SubmitOutcome::Unsupported, "IntroDB has no segment type for this kind");
    };
    if !valid_imdb(imdb_id) {
        return reply(SubmitOutcome::Invalid, "IntroDB needs an IMDb id for this title");
    }
    let target = episode_target(season, episode)?;
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end <= start || end > MAX_SEGMENT_END_SEC {
        return reply(SubmitOutcome::Invalid, "Start and end must be a forward interval");
    }
    let Some(api_key) = stored_key() else {
        return reply(SubmitOutcome::NoKey, "No IntroDB API key is set");
    };
    let key = cache_key(imdb_id, target);
    let body = submit_body(segment_type, imdb_id, target, start, end, tvdb_id, tmdb_id);
    crate::devlog!(
        info, "introdb",
        "POST /submit {key} {segment_type} {start:.2}-{end:.2}s tvdb={tvdb_id:?} tmdb={tmdb_id:?}",
    );
    let resp = client()
        .post(format!("{INTRODB_BASE}/submit"))
        .header("X-API-Key", api_key.as_str())
        .json(&body)
        .send()
        .await;
    drop(api_key);
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "introdb", "submit failed for {key}: {}", e.without_url());
            return reply(SubmitOutcome::Failed, "Could not reach IntroDB");
        }
    };
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    // IntroDB's own error text ("Episode does not exist for this show.") is
    // useful to the user; cap it, and never echo anything request-shaped.
    let server_msg = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("error").and_then(|m| m.as_str()).map(|s| s.chars().take(200).collect::<String>()));
    crate::devlog!(info, "introdb", "submit {key} -> HTTP {}", status.as_u16());
    match status.as_u16() {
        200..=299 => {
            // The next load of this episode should see the new submission.
            cache().lock().unwrap().remove(&key);
            reply(SubmitOutcome::Ok, "Submitted to IntroDB")
        }
        429 => reply(SubmitOutcome::RateLimited, "Already submitted to IntroDB in the last few minutes"),
        401 | 403 => reply(SubmitOutcome::KeyRejected, "IntroDB rejected your API key"),
        400 => reply(
            SubmitOutcome::Invalid,
            &server_msg.unwrap_or_else(|| "IntroDB refused this segment".into()),
        ),
        code => reply(SubmitOutcome::Failed, &format!("IntroDB HTTP {code}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const BLEACH_S12E5: &str = r#"{"imdb_id":"tt0434665","media_type":"tv","is_movie":false,"season":12,"episode":5,"intro":{"start_sec":0,"end_sec":100.1,"start_ms":0,"end_ms":100100,"confidence":0.90909094,"submission_count":1,"updated_at":"2026-09-16T22:40:05.357Z"},"recap":null,"outro":{"start_sec":1320.8,"end_sec":1411,"start_ms":1320800,"end_ms":1411000,"confidence":1,"submission_count":1,"updated_at":"2026-09-16T12:03:59.494Z"},"post_credits":null}"#;

    fn seg(start: f64, end: f64, n: i64, c: f64) -> String {
        format!(r#"{{"start_sec":{start},"end_sec":{end},"confidence":{c},"submission_count":{n}}}"#)
    }

    #[test]
    fn parses_real_response() {
        let w = parse_segments(BLEACH_S12E5).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].kind, "op");
        assert_eq!(w[0].start, 0.0);
        assert_eq!(w[0].end, 100.1);
        // One submission: never trusted, whatever the confidence.
        assert_eq!(w[0].source, SOURCE_SINGLE);
        assert_eq!(w[1].kind, "ed");
        assert_eq!(w[1].source, SOURCE_SINGLE);
    }

    #[test]
    fn all_null_is_empty() {
        let body = r#"{"imdb_id":"tt0434665","season":99,"episode":99,"intro":null,"recap":null,"outro":null,"post_credits":null}"#;
        assert!(parse_segments(body).unwrap().is_empty());
    }

    #[test]
    fn missing_fields_and_post_credits_ignored() {
        let body = format!(r#"{{"post_credits":{}}}"#, seg(7650.0, 7800.0, 5, 1.0));
        assert!(parse_segments(&body).unwrap().is_empty());
    }

    #[test]
    fn recap_maps_to_recap() {
        let body = format!(r#"{{"recap":{}}}"#, seg(0.0, 60.0, 3, 0.95));
        let w = parse_segments(&body).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].kind, "recap");
        assert_eq!(w[0].source, SOURCE_TRUSTED);
    }

    #[test]
    fn drops_inverted_negative_and_huge() {
        let body = format!(
            r#"{{"intro":{},"recap":{},"outro":{}}}"#,
            seg(90.0, 30.0, 3, 1.0),
            seg(-5.0, 30.0, 3, 1.0),
            seg(10.0, MAX_SEGMENT_END_SEC + 1.0, 3, 1.0),
        );
        assert!(parse_segments(&body).unwrap().is_empty());
    }

    #[test]
    fn drops_zero_length() {
        let body = format!(r#"{{"intro":{}}}"#, seg(30.0, 30.0, 3, 1.0));
        assert!(parse_segments(&body).unwrap().is_empty());
    }

    #[test]
    fn non_finite_times_are_dropped() {
        // JSON has no NaN literal, so exercise the validator directly.
        let s = ApiSegment { start_sec: Some(f64::NAN), end_sec: Some(90.0), ..Default::default() };
        assert!(validate_segment("op", &s).is_none());
        let s = ApiSegment { start_sec: Some(0.0), end_sec: Some(f64::INFINITY), ..Default::default() };
        assert!(validate_segment("op", &s).is_none());
    }

    #[test]
    fn ms_fallback_when_seconds_absent() {
        let body = r#"{"intro":{"start_ms":1500,"end_ms":91500,"confidence":1,"submission_count":4}}"#;
        let w = parse_segments(body).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].start, 1.5);
        assert_eq!(w[0].end, 91.5);
    }

    #[test]
    fn bad_confidence_reads_as_untrusted() {
        let s = ApiSegment {
            start_sec: Some(0.0), end_sec: Some(90.0),
            confidence: Some(1.7), submission_count: Some(9), ..Default::default()
        };
        let w = validate_segment("op", &s).unwrap();
        assert_eq!(w.confidence, 0.0);
        assert_eq!(w.source, SOURCE_SINGLE);
        let s = ApiSegment {
            start_sec: Some(0.0), end_sec: Some(90.0),
            confidence: None, submission_count: None, ..Default::default()
        };
        assert_eq!(validate_segment("op", &s).unwrap().source, SOURCE_SINGLE);
    }

    #[test]
    fn trust_split() {
        assert_eq!(trust_source(2, 0.9), SOURCE_TRUSTED);
        assert_eq!(trust_source(10, 1.0), SOURCE_TRUSTED);
        assert_eq!(trust_source(1, 1.0), SOURCE_SINGLE);
        assert_eq!(trust_source(5, 0.89), SOURCE_SINGLE);
        assert_eq!(trust_source(0, 0.0), SOURCE_SINGLE);
        assert_eq!(trust_source(3, f64::NAN), SOURCE_SINGLE);
    }

    #[test]
    fn duration_fit() {
        let w = parse_segments(BLEACH_S12E5).unwrap();
        // No duration: unchanged.
        assert_eq!(fit_to_duration(w.clone(), None).len(), 2);
        assert_eq!(fit_to_duration(w.clone(), Some(f64::NAN)).len(), 2);
        // Outro ends at 1411: a 1410 s file clamps it (within slack).
        let fit = fit_to_duration(w.clone(), Some(1410.0));
        assert_eq!(fit.len(), 2);
        assert_eq!(fit[1].end, 1410.0);
        // A 1380 s cut: the outro overshoots by 31 s, a different edit. Dropped.
        let fit = fit_to_duration(w.clone(), Some(1380.0));
        assert_eq!(fit.len(), 1);
        assert_eq!(fit[0].kind, "op");
        // A 60 s file: the intro starts inside but ends far past. Dropped too.
        assert!(fit_to_duration(w, Some(60.0)).is_empty());
    }

    #[test]
    fn imdb_validation() {
        assert!(valid_imdb("tt0434665"));
        assert!(valid_imdb("tt12345678"));
        assert!(!valid_imdb("tt123456"));
        assert!(!valid_imdb("tt123456789"));
        assert!(!valid_imdb("kitsu:123"));
        assert!(!valid_imdb("tt0434665:1:5"));
    }

    #[test]
    fn episode_target_rules() {
        assert_eq!(episode_target(None, None).unwrap(), None);
        assert_eq!(episode_target(Some(12), Some(5)).unwrap(), Some((12, 5)));
        assert!(episode_target(Some(0), Some(5)).is_err());
        assert!(episode_target(Some(1), None).is_err());
    }

    #[test]
    fn submit_body_episode() {
        let b = submit_body("intro", "tt0903747", Some((1, 1)), 2.5, 58.0, Some(81189), Some(1396));
        assert_eq!(b["segment_type"], "intro");
        assert_eq!(b["imdb_id"], "tt0903747");
        assert_eq!(b["season"], 1);
        assert_eq!(b["episode"], 1);
        assert_eq!(b["start_sec"], 2.5);
        assert_eq!(b["end_sec"], 58.0);
        assert_eq!(b["tvdb_id"], 81189);
        assert_eq!(b["tmdb_id"], 1396);
        assert!(b.get("is_movie").is_none());
    }

    #[test]
    fn submit_body_movie_and_optional_ids() {
        let b = submit_body("outro", "tt0137523", None, 7650.0, 7800.123_456, None, Some(550));
        assert_eq!(b["is_movie"], true);
        assert!(b.get("season").is_none());
        assert!(b.get("episode").is_none());
        assert!(b.get("tvdb_id").is_none());
        assert_eq!(b["tmdb_id"], 550);
        assert_eq!(b["end_sec"], 7800.123);
        // Non-positive ids are omitted rather than sent.
        let b = submit_body("recap", "tt0137523", Some((2, 3)), 0.0, 30.0, Some(0), Some(-1));
        assert!(b.get("tvdb_id").is_none());
        assert!(b.get("tmdb_id").is_none());
    }

    #[test]
    fn kind_mapping() {
        assert_eq!(segment_type_for("op"), Some("intro"));
        assert_eq!(segment_type_for("ed"), Some("outro"));
        assert_eq!(segment_type_for("recap"), Some("recap"));
        assert_eq!(segment_type_for("mixed-op"), None);
    }
}
