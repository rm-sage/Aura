// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

// ---------------------------------------------------------------------------
// AniSkip API client.
//
// Endpoint:
//   GET https://api.aniskip.com/v2/skip-times/{mal_id}/{episode_number}
//       ?types[]=op&types[]=ed&types[]=mixed-op&types[]=recap
//       &episodeLength={runtime_seconds_or_0}
//
// No auth, no CORS concerns. Generous rate limit. Negative responses
// (`{ found: false }`) are common for niche / brand-new titles —
// negative-cached for 24 h to avoid re-poking AniSkip on every
// episode load.
//
// The response is normalized into a `SkipWindows` payload that the
// front-end stamps onto MPV's `user-data/aura/skip-windows` property.
// The Lua script in `scripts/skip-windows.lua` reads it from there.
// ---------------------------------------------------------------------------

const ANISKIP_BASE: &str = "https://api.aniskip.com/v2";
const NEGATIVE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Wire shape of the AniSkip API's `interval` object — wraps start/end
/// timestamps in seconds. Serde reads camelCase as that's what AniSkip
/// emits.
#[derive(Debug, Clone, Deserialize)]
struct ApiInterval {
    #[serde(rename = "startTime")]
    start_time: f64,
    #[serde(rename = "endTime")]
    end_time: f64,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiResult {
    interval: ApiInterval,
    /// "op" | "ed" | "mixed-op" | "recap"
    #[serde(rename = "skipType")]
    skip_type: String,
    /// Total episode length AniSkip received from the submitter. This is the
    /// gate the neighbour profile below is built on: a row recorded against a
    /// different runtime describes a different edit and its timings do not
    /// transfer.
    #[serde(rename = "episodeLength", default)]
    episode_length: f64,
    /// AniSkip's per-row identifier. Required for the vote endpoint
    /// (`POST /v2/skip-times/vote/{skip_id}`). Optional in the parse
    /// because older API responses occasionally omit it for synthetic
    /// rows; voting on those is a no-op anyway.
    #[serde(rename = "skipId", default)]
    skip_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiResponse {
    found: bool,
    #[serde(default)]
    results: Vec<ApiResult>,
}

/// One skip window after normalization. `kind` is folded to a small
/// set that the Lua script + settings UI both recognise: "op" | "ed" |
/// "recap". `mixed-op` from AniSkip is collapsed into "op" by default
/// (toggle: `skip_treat_mixed_op_as_op` setting on the React side).
#[derive(Debug, Clone, Serialize)]
pub struct SkipWindow {
    pub kind: String,
    pub start: f64,
    pub end: f64,
    /// "aniskip" for now. Future "chapter" / "silencedetect" sources
    /// will share this struct so the Lua side can priority-rank.
    pub source: String,
    /// AniSkip per-row identifier passed through unchanged when the
    /// source is "aniskip". `None` for non-AniSkip windows (chapter,
    /// silencedetect) — they don't have a server-side identity to
    /// vote against.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkipWindows {
    /// True when AniSkip returned at least one usable window. False
    /// means a negative-cached result OR the API genuinely had no
    /// data; either way, the front-end can skip the
    /// user-data property write.
    pub found: bool,
    pub windows: Vec<SkipWindow>,
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    payload: SkipWindows,
    /// When this entry was cached. Used to expire negative results
    /// after 24 h. Positive results are kept indefinitely (timing data
    /// for a specific episode doesn't change once submitted +
    /// validated).
    cached_at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

/// Positive entries never expire, so without a cap this map only ever grows
/// for the life of the process - one entry per episode watched, plus one per
/// episode the neighbour profile probes. Bounded like every other cache in the
/// app; the oldest quarter goes on overflow.
const CACHE_CAP: usize = 400;

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Insert with the cap applied. Eviction is by insertion time, which for this
/// cache is also least-recently-fetched (entries are never refreshed on read).
fn cache_insert(key: String, payload: SkipWindows) {
    let mut lock = cache().lock().unwrap();
    if lock.len() >= CACHE_CAP {
        let mut ages: Vec<(String, Instant)> =
            lock.iter().map(|(k, e)| (k.clone(), e.cached_at)).collect();
        ages.sort_by_key(|(_, at)| *at);
        for (k, _) in ages.into_iter().take(CACHE_CAP / 4) {
            lock.remove(&k);
        }
    }
    lock.insert(key, CacheEntry { payload, cached_at: Instant::now() });
}

/// `treat_mixed_op_as_op` is part of the key because the cached payload is
/// stored POST-mapping (a "mixed-op" row is rewritten to "op" before it is
/// cached). Keying without it served the previous mapping to everyone who
/// toggled the setting mid-session, and positive entries never expire.
fn cache_key(mal_id: u32, episode: u32, treat_mixed_op_as_op: bool) -> String {
    format!("{}:{}:{}", mal_id, episode, u8::from(treat_mixed_op_as_op))
}

/// Drop every cached payload for one (anime, episode) across both
/// `treat_mixed_op_as_op` variants. Called after a vote or a submit: the user
/// has just told AniSkip its data is wrong, and positive entries otherwise
/// live for the whole process lifetime.
fn invalidate_cache(mal_id: u32, episode: u32) {
    let prefix = format!("{}:{}:", mal_id, episode);
    let mut lock = cache().lock().unwrap();
    let before = lock.len();
    lock.retain(|k, _| !k.starts_with(&prefix));
    let dropped = before - lock.len();
    if dropped > 0 {
        crate::devlog!(
            info, "aniskip",
            "cache invalidated for mal={mal_id} ep={episode} ({dropped} entr(ies))"
        );
    }
}

// ---------------------------------------------------------------------------
// HTTP client — separate from stremio.rs's so AniSkip latency / errors
// don't bleed into the addon catalog path. 8 s timeout is generous for
// the API's typical response time (~200 ms).
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Defence-in-depth: api.aniskip.com is HTTPS-only in
            // practice, but `https_only` rejects any silent HTTP
            // downgrade (e.g. a captured DNS rebinding to a malicious
            // plain-HTTP host). Matches the policy on the auth /
            // ratings clients elsewhere in the crate.
            .https_only(true)
            .timeout(Duration::from_secs(8))
            // tcp_nodelay defaults to true in reqwest 0.12 — set it
            // explicitly so future-us doesn't have to re-derive that
            // from the docs. tcp_keepalive(60 s) keeps long-lived
            // pooled connections alive across firewall idle-timeouts;
            // without it, the first request after ~5 min idle eats a
            // full reconnect (TCP + TLS handshake) per host.
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            // 4, not 1: the neighbour profile fires up to 2 * PROFILE_SPAN
            // probes at once against this same host, and a 1-connection idle
            // pool made every one of them pay a fresh TLS handshake.
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura/0.6.6")
            .build()
            .expect("AniSkip client init failed")
    })
}

// ---------------------------------------------------------------------------
// Command — fetch_skip_windows(mal_id, episode, episode_length, treat_mixed_op_as_op)
//
// `treat_mixed_op_as_op`: when false, AniSkip's "mixed-op" results are
// kept as their own kind ("mixed-op") rather than collapsed into "op".
// Caller-side (settings) decision; the API itself returns the four
// types regardless of what we ask for.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_skip_windows(
    mal_id: u32,
    episode: u32,
    episode_length: f64,
    treat_mixed_op_as_op: bool,
) -> Result<SkipWindows, String> {
    let key = cache_key(mal_id, episode, treat_mixed_op_as_op);

    // Cache hit? Positive results never expire; negative results
    // expire after 24 h.
    {
        let lock = cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = !entry.payload.found
                && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                crate::devlog!(
                    info, "aniskip",
                    "cache hit mal={mal_id} ep={episode} found={} ({} window(s))",
                    entry.payload.found, entry.payload.windows.len()
                );
                return Ok(entry.payload.clone());
            }
        }
    }

    // Build the request. The `types[]=` repetition is significant —
    // AniSkip uses PHP-style array binding.
    let url = format!(
        "{ANISKIP_BASE}/skip-times/{mal_id}/{episode}\
         ?types[]=op&types[]=ed&types[]=mixed-op&types[]=recap\
         &episodeLength={length}",
        length = episode_length.max(0.0),
    );

    crate::devlog!(info, "aniskip", "GET {url}");

    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            crate::devlog!(warn, "aniskip", "request failed: {e}");
            format!("AniSkip request error: {e}")
        })?;

    let status = resp.status();
    if !status.is_success() {
        // 404 is the canonical "no data for this id" — cache as
        // negative. Other HTTP errors (5xx, rate limit) we swallow
        // without caching so a transient blip retries on next fetch.
        crate::devlog!(
            warn, "aniskip",
            "HTTP {} for mal={mal_id} ep={episode}",
            status.as_u16()
        );
        if status == reqwest::StatusCode::NOT_FOUND {
            let payload = SkipWindows { found: false, windows: vec![] };
            cache_insert(key, payload.clone());
            return Ok(payload);
        }
        return Err(format!("AniSkip HTTP {}", status.as_u16()));
    }

    let raw = resp.text().await.map_err(|e| format!("read error: {e}"))?;
    let parsed: ApiResponse = serde_json::from_str(&raw)
        .map_err(|e| {
            crate::devlog!(warn, "aniskip", "JSON parse error: {e} body_len={}", raw.len());
            format!("AniSkip JSON parse error: {e}")
        })?;

    let payload = if !parsed.found || parsed.results.is_empty() {
        SkipWindows { found: false, windows: vec![] }
    } else {
        let windows: Vec<SkipWindow> = parsed
            .results
            .into_iter()
            .map(|r| {
                let kind = match r.skip_type.as_str() {
                    "mixed-op" if treat_mixed_op_as_op => "op".to_string(),
                    other => other.to_string(),
                };
                SkipWindow {
                    kind,
                    start:   r.interval.start_time,
                    end:     r.interval.end_time,
                    source:  "aniskip".into(),
                    skip_id: r.skip_id,
                }
            })
            .collect();
        SkipWindows { found: true, windows }
    };

    cache_insert(key, payload.clone());

    crate::devlog!(
        info, "aniskip",
        "resolved mal={mal_id} ep={episode} found={} windows={}",
        payload.found, payload.windows.len()
    );
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Neighbour profile: infer a MISSING episode's OP/ED from the episodes
// either side of it.
//
// AniSkip's coverage is per-episode and patchy. Hell's Paradise S02 (mal 55825)
// carries an ED on episodes 1, 2, 5, 6, 7 and 12 and NOTHING on 3, 4, 8-11 and
// 13. The ending of a TV anime does not wander between episodes of one cour,
// though: every one of those six rows starts within 13 s of 1376 against a
// 1465.1 s runtime. So for the gaps the neighbours ARE the answer, and a much
// better one than the ffmpeg tail-scan that used to be the only fallback (a
// ~97 MB on-demand dependency and a multi-minute decode, for a worse number -
// it is what put the Next-Up card a minute early on S02E11).
//
// Rails, because this is inference and not data:
//   * only neighbours whose reported `episodeLength` matches the file actually
//     playing. A different release or a double-length premiere has a different
//     ED offset: mal 52991 (Frieren) puts its ED at 1417 on the 1560 s opener
//     and at 1370 on every 1470 s episode, so an ungated average would land
//     between two correct answers and be wrong for both.
//   * at least PROFILE_MIN_SAMPLES agreeing rows, so one bad submission cannot
//     carry a window on its own.
//   * the MEDIAN, not the mean - an outlier shifts nothing.
//   * source "aniskip-neighbour", which the front-end classifies as a GUESS:
//     prompt-only, never an auto-seek, and drawn on the scrubber like every
//     other window so the user can see what it inferred.
//
// Recap is deliberately NOT inferred: "previously on" segments are per-episode
// content whose length changes week to week, so a neighbour tells us nothing.
// ---------------------------------------------------------------------------

/// Episodes either side of the target that get probed.
const PROFILE_SPAN: u32 = 4;
/// Agreeing rows required before an ED is inferred at all.
const PROFILE_MIN_SAMPLES: usize = 2;
/// The OP asks for more, and for tighter agreement, because an opening is a far
/// less stable target than an ending. An ending is anchored to the end of a
/// fixed broadcast slot - every ED row for mal 55825 lands within 13 s of 1376,
/// and mal 52991's within 1 s of 1370. An opening floats with whatever cold
/// open precedes it: the SAME six episodes of 55825 start their OP at 0, 76.5,
/// 97, 107 and 116 s. Borrowing that would also suppress the file-specific
/// silencedetect OP scan (which outranks nothing here but does get skipped once
/// `hasOp` is true), and that scan reads THIS file rather than its neighbours.
/// So the OP is inferred only for shows whose openings genuinely do not move.
const PROFILE_OP_MIN_SAMPLES: usize = 3;
/// How far a neighbour's reported `episodeLength` may differ from the file
/// actually playing and still describe the same edit.
const PROFILE_LENGTH_TOLERANCE: f64 = 6.0;
/// How far a sample's start may sit from the median and still count as agreeing.
const PROFILE_AGREE_TOLERANCE: f64 = 20.0;
const PROFILE_OP_AGREE_TOLERANCE: f64 = 10.0;
/// Shortest window worth inferring.
const PROFILE_MIN_WINDOW: f64 = 10.0;
const PROFILE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Bounded like every other cache in the app: one entry per (series, runtime,
/// mixed-op mapping). Oldest third is dropped on overflow.
const PROFILE_CACHE_CAP: usize = 64;

#[derive(Debug, Clone, Serialize)]
pub struct SeriesSkipProfile {
    pub found: bool,
    /// Inferred windows. `source` is "aniskip-neighbour" and `skip_id` is
    /// always None: there is no server-side row for THIS episode to vote on.
    pub windows: Vec<SkipWindow>,
    /// Human-readable summary for the DevConsole (`[aniskip]`).
    pub note: String,
}

static PROFILE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, SeriesSkipProfile)>>> =
    OnceLock::new();

fn profile_cache() -> &'static Mutex<HashMap<String, (Instant, SeriesSkipProfile)>> {
    PROFILE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One raw AniSkip row, kept with the runtime the submitter recorded it against.
#[derive(Debug, Clone)]
struct ProfileRow {
    kind: String,
    start: f64,
    end: f64,
    episode_length: f64,
}

/// Outcome of one neighbour probe. A 404 ("this episode has no data") and a
/// network failure both mean "no vote", but they are NOT the same thing: if
/// most of the neighbourhood errored, the profile that comes back is built on a
/// fraction of the evidence and the note has to say so, otherwise "nothing
/// usable" reads as "this series has no data" when it was a dead connection.
struct ProbeOutcome {
    rows: Vec<ProfileRow>,
    failed: bool,
}

/// Raw single-episode probe. Deliberately NOT routed through
/// `fetch_skip_windows`: that drops `episodeLength` (the whole basis of the
/// length gate) and would fill the per-episode cache with rows for episodes the
/// user is not watching.
async fn probe_episode(mal_id: u32, episode: u32) -> ProbeOutcome {
    let none = |failed| ProbeOutcome { rows: vec![], failed };
    let url = format!(
        "{ANISKIP_BASE}/skip-times/{mal_id}/{episode}\
         ?types[]=op&types[]=ed&types[]=mixed-op&episodeLength=0"
    );
    let Ok(resp) = client().get(&url).send().await else { return none(true) };
    let status = resp.status();
    if !status.is_success() {
        // 404 is the API's "no rows for this episode" and is an answer.
        return none(status != reqwest::StatusCode::NOT_FOUND);
    }
    let Ok(raw) = resp.text().await else { return none(true) };
    let Ok(parsed) = serde_json::from_str::<ApiResponse>(&raw) else { return none(true) };
    if !parsed.found { return none(false) }
    ProbeOutcome {
        rows: parsed.results.into_iter().map(|r| ProfileRow {
            kind: r.skip_type,
            start: r.interval.start_time,
            end: r.interval.end_time,
            episode_length: r.episode_length,
        }).collect(),
        failed: false,
    }
}

/// Lower median. Callers only reach it with at least PROFILE_MIN_SAMPLES
/// entries, but it returns NaN rather than indexing an empty slice so a future
/// caller gets a value that fails every downstream comparison instead of a panic.
fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() { return f64::NAN }
    // total_cmp, not partial_cmp+unwrap_or: a NaN in the input makes the latter
    // an inconsistent comparator, and sort_by's output order is then undefined.
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

/// Reduce raw neighbour rows to at most one OP and one ED window. Pure, so the
/// rails (runtime gate, sample floor, agreement, median) are testable without
/// touching the network.
fn infer_profile_windows(
    rows: &[ProfileRow], duration: f64, treat_mixed_op_as_op: bool,
) -> Vec<SkipWindow> {
    // Runtime gate first: a row recorded against a different edit describes a
    // different timeline and must not vote at all.
    let matched: Vec<&ProfileRow> = rows.iter()
        .filter(|r| (r.episode_length - duration).abs() <= PROFILE_LENGTH_TOLERANCE)
        .collect();

    let mut windows: Vec<SkipWindow> = Vec::new();
    for want in ["op", "ed"] {
        let samples: Vec<&ProfileRow> = matched.iter().copied()
            .filter(|r| {
                let mapped = if r.kind == "mixed-op" && treat_mixed_op_as_op {
                    "op"
                } else {
                    r.kind.as_str()
                };
                mapped == want
            })
            .collect();
        let (floor, slack) = if want == "op" {
            (PROFILE_OP_MIN_SAMPLES, PROFILE_OP_AGREE_TOLERANCE)
        } else {
            (PROFILE_MIN_SAMPLES, PROFILE_AGREE_TOLERANCE)
        };
        if samples.len() < floor { continue }
        // Median as the centre, then keep only what agrees with it, then take
        // the median of THOSE - one wild submission neither carries the window
        // nor drags it. A show whose openings do not cluster tightly enough
        // fails the floor on the second pass and is simply not inferred.
        let centre = median(samples.iter().map(|r| r.start).collect());
        let agreeing: Vec<&ProfileRow> = samples.iter().copied()
            .filter(|r| (r.start - centre).abs() <= slack)
            .collect();
        if agreeing.len() < floor { continue }
        let start = median(agreeing.iter().map(|r| r.start).collect());
        let end = median(agreeing.iter().map(|r| r.end).collect()).min(duration);
        if !(end > start + PROFILE_MIN_WINDOW) { continue }
        windows.push(SkipWindow {
            kind: want.to_string(),
            start,
            end,
            source: "aniskip-neighbour".into(),
            skip_id: None,
        });
    }
    windows
}

#[cfg(test)]
mod profile_tests {
    use super::*;

    fn row(kind: &str, start: f64, end: f64, len: f64) -> ProfileRow {
        ProfileRow { kind: kind.into(), start, end, episode_length: len }
    }

    /// Real AniSkip data for mal 55825 (Hell's Paradise S02), which is the case
    /// that produced the bug report: episode 11 returns 404 while 1, 2, 5, 6, 7
    /// and 12 all carry an ED.
    fn hells_paradise_neighbours() -> Vec<ProfileRow> {
        vec![
            row("ed", 1375.0, 1465.0, 1465.0),
            row("ed", 1376.0, 1465.0, 1465.132),
            row("ed", 1388.0, 1465.0, 1465.048),   // the outlier
            row("ed", 1376.0, 1465.0, 1465.132),
            row("ed", 1377.0, 1465.0, 1465.09),
            row("ed", 1376.0, 1461.9, 1464.97),
        ]
    }

    #[test]
    fn hells_paradise_ed_is_recovered_from_its_neighbours() {
        let w = infer_profile_windows(&hells_paradise_neighbours(), 1465.1, true);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].kind, "ed");
        assert_eq!(w[0].source, "aniskip-neighbour");
        assert!(w[0].skip_id.is_none());
        // The 1388 outlier must not drag the answer.
        assert!((w[0].start - 1376.0).abs() < 1.0, "start was {}", w[0].start);
        assert!(w[0].end <= 1465.1);
    }

    #[test]
    fn a_different_runtime_never_votes() {
        // Frieren (mal 52991) is the reason this gate exists: its double-length
        // opener (1559.9 s) starts its ED at 1417, every 1470 s episode at 1370.
        // Averaging the two lands between two correct answers and is wrong for
        // both.
        let rows = vec![
            row("ed", 1417.135, 1507.135, 1559.949),
            row("ed", 1370.0, 1460.0, 1469.968),
            row("ed", 1370.0, 1460.0, 1470.032),
            row("ed", 1371.0, 1460.0, 1470.148),
        ];
        let w = infer_profile_windows(&rows, 1470.078, true);
        assert_eq!(w.len(), 1);
        assert!((w[0].start - 1370.0).abs() < 1.0, "start was {}", w[0].start);
    }

    #[test]
    fn one_lone_sample_is_not_enough() {
        // Frieren episode 4 (1559.857 s) has exactly one runtime-matching
        // neighbour. One crowd submission does not get to move the UI.
        let rows = vec![
            row("ed", 1417.135, 1507.135, 1559.949),
            row("ed", 1370.0, 1460.0, 1470.032),
        ];
        assert!(infer_profile_windows(&rows, 1559.857, true).is_empty());
    }

    #[test]
    fn disagreeing_samples_produce_nothing() {
        let rows = vec![
            row("ed", 1100.0, 1200.0, 1465.0),
            row("ed", 1376.0, 1465.0, 1465.0),
        ];
        // Neither half reaches PROFILE_MIN_SAMPLES once the outlier filter runs.
        assert!(infer_profile_windows(&rows, 1465.1, true).is_empty());
    }

    #[test]
    fn mixed_op_folds_into_op_only_when_asked() {
        let rows = vec![
            row("mixed-op", 100.0, 190.0, 1465.0),
            row("mixed-op", 101.0, 191.0, 1465.0),
            row("mixed-op", 102.0, 192.0, 1465.0),
        ];
        let folded = infer_profile_windows(&rows, 1465.1, true);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].kind, "op");
        assert!(infer_profile_windows(&rows, 1465.1, false).is_empty());
    }

    #[test]
    fn a_show_whose_opening_moves_gets_no_inferred_op() {
        // Real AniSkip OP starts for mal 55825 episodes 7-12: the cold open
        // before the opening is a different length every week, so the neighbours
        // do not agree and the file-specific silencedetect scan should keep the
        // job. The ED on the same episodes is rock steady, so it still lands.
        let rows = vec![
            row("op", 116.0, 204.0, 1465.09),
            row("op", 76.5, 106.0, 1465.133),
            row("op", 0.0, 108.0, 1465.048),
            row("op", 97.0, 185.0, 1465.132),
            row("op", 107.338, 197.018, 1464.97),
            row("ed", 1377.0, 1465.0, 1465.09),
            row("ed", 1376.0, 1461.9, 1464.97),
        ];
        let w = infer_profile_windows(&rows, 1465.1, true);
        assert_eq!(w.len(), 1, "expected ED only, got {w:?}");
        assert_eq!(w[0].kind, "ed");
        assert!((w[0].start - 1377.0).abs() < 1.5, "start was {}", w[0].start);
    }

    #[test]
    fn a_show_whose_opening_is_fixed_does_get_one() {
        let rows = vec![
            row("op", 118.0, 208.0, 1440.0),
            row("op", 119.0, 209.0, 1440.0),
            row("op", 118.5, 208.5, 1440.0),
        ];
        let w = infer_profile_windows(&rows, 1440.0, true);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].kind, "op");
        assert!((w[0].start - 118.5).abs() < 1.0, "start was {}", w[0].start);
    }

    #[test]
    fn recap_is_never_inferred() {
        // Per-episode content: the neighbours say nothing useful about it.
        let rows = vec![
            row("recap", 0.0, 60.0, 1465.0),
            row("recap", 0.0, 62.0, 1465.0),
            row("recap", 0.0, 61.0, 1465.0),
        ];
        assert!(infer_profile_windows(&rows, 1465.1, true).is_empty());
    }

    #[test]
    fn a_degenerate_window_is_dropped() {
        let rows = vec![
            row("ed", 1400.0, 1403.0, 1465.0),
            row("ed", 1400.0, 1404.0, 1465.0),
        ];
        assert!(infer_profile_windows(&rows, 1465.1, true).is_empty());
    }

    #[test]
    fn both_kinds_can_be_filled_at_once() {
        let rows = vec![
            row("op", 100.0, 190.0, 1465.0),
            row("op", 101.0, 191.0, 1465.0),
            row("op", 102.0, 192.0, 1465.0),
            row("ed", 1376.0, 1465.0, 1465.0),
            row("ed", 1377.0, 1465.0, 1465.0),
        ];
        let w = infer_profile_windows(&rows, 1465.1, true);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].kind, "op");
        assert_eq!(w[1].kind, "ed");
    }
}

/// Infer OP / ED windows for `episode` from its neighbours. `duration` is the
/// container runtime of the file being played and is REQUIRED: without it the
/// length gate cannot run and the whole thing degrades into averaging unrelated
/// edits together.
#[tauri::command]
pub async fn fetch_neighbour_skip_profile(
    mal_id: u32,
    episode: u32,
    duration: f64,
    treat_mixed_op_as_op: bool,
) -> Result<SeriesSkipProfile, String> {
    if !(duration > 0.0) {
        return Ok(SeriesSkipProfile {
            found: false, windows: vec![],
            note: "no container duration - neighbour inference needs one".into(),
        });
    }
    // Keyed by EPISODE, not just by series: each episode has its own
    // neighbourhood, and a long-running show can change its opening or ending
    // between cours. A series-wide key served episode 5's answer to episode 40.
    // The runtime is bucketed so a re-open of the same episode (or the same
    // episode at a fractionally different reported duration) still hits.
    let key = format!(
        "{mal_id}:{episode}:{}:{}",
        (duration / 5.0).round() as i64,
        u8::from(treat_mixed_op_as_op),
    );
    {
        let lock = profile_cache().lock().unwrap();
        if let Some((at, profile)) = lock.get(&key) {
            if at.elapsed() < PROFILE_TTL {
                crate::devlog!(
                    info, "aniskip",
                    "neighbour profile cache hit mal={mal_id} ({} window(s))",
                    profile.windows.len()
                );
                return Ok(profile.clone());
            }
        }
    }

    let lo = episode.saturating_sub(PROFILE_SPAN).max(1);
    let hi = episode.saturating_add(PROFILE_SPAN);
    let mut set: tokio::task::JoinSet<ProbeOutcome> = tokio::task::JoinSet::new();
    let mut probed = 0usize;
    for ep in lo..=hi {
        if ep == episode { continue }
        probed += 1;
        set.spawn(async move { probe_episode(mal_id, ep).await });
    }
    let mut rows: Vec<ProfileRow> = Vec::new();
    let mut failed = 0usize;
    while let Some(res) = set.join_next().await {
        match res {
            Ok(mut out) => { failed += usize::from(out.failed); rows.append(&mut out.rows) }
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        crate::devlog!(
            warn, "aniskip",
            "neighbour profile mal={mal_id} ep={episode}: {failed}/{probed} probe(s) failed"
        );
    }

    let matched = rows.iter()
        .filter(|r| (r.episode_length - duration).abs() <= PROFILE_LENGTH_TOLERANCE)
        .count();
    let windows = infer_profile_windows(&rows, duration, treat_mixed_op_as_op);

    let note = format!(
        "neighbour profile mal={mal_id} ep={episode}: probed {probed} ({failed} failed), \
         {matched} row(s) matched runtime {duration:.1}s -> {} window(s)",
        windows.len(),
    );
    crate::devlog!(info, "aniskip", "{note}");

    let profile = SeriesSkipProfile { found: !windows.is_empty(), windows, note };
    {
        let mut lock = profile_cache().lock().unwrap();
        if lock.len() >= PROFILE_CACHE_CAP {
            // Drop the oldest third rather than clearing: a full wipe would
            // re-probe every open series at once on the next episode load.
            let mut ages: Vec<(String, Instant)> =
                lock.iter().map(|(k, (at, _))| (k.clone(), *at)).collect();
            ages.sort_by_key(|(_, at)| *at);
            for (k, _) in ages.into_iter().take(PROFILE_CACHE_CAP / 3) {
                lock.remove(&k);
            }
        }
        lock.insert(key, (Instant::now(), profile.clone()));
    }
    Ok(profile)
}

// ---------------------------------------------------------------------------
// kitsu / anidb → mal resolver.
//
// AniSkip is keyed by MAL ids. Many anime addons stamp meta with a
// kitsu or anidb id but no mal id — those titles silently bail out of
// the skip lookup. We close the gap with a small HTTP shim against the
// public yuna.moe relations API:
//
//   GET https://relations.yuna.moe/api/ids?source={src}&id={id}
//   →   { anidb, anilist, kitsu, mal, themoviedb, thetvdb }   (any may be null)
//
// Mappings are static once published, so the cache is keyed by
// (source, id) and never expires. Negative results (no mal id found,
// or HTTP error) are cached for 24 h so a transient network blip
// doesn't burn one round-trip per AniSkip lookup.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct YunaIdsResponse {
    #[serde(default)]
    mal: Option<serde_json::Value>,
}

#[derive(Clone)]
struct MalResolveEntry {
    mal_id: Option<u32>,
    cached_at: Instant,
}

static MAL_RESOLVE_CACHE: OnceLock<Mutex<HashMap<String, MalResolveEntry>>> = OnceLock::new();

fn mal_resolve_cache() -> &'static Mutex<HashMap<String, MalResolveEntry>> {
    MAL_RESOLVE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Convert a kitsu / anidb / anilist id to a MAL id via yuna.moe's
/// relations endpoint. Returns `None` on any failure (network, parse,
/// or no mapping exists). Negative results are cached for 24 h.
#[tauri::command]
pub async fn resolve_mal_id(source: String, id: u32) -> Result<Option<u32>, String> {
    // Normalize the source name to what yuna.moe expects.
    let src = match source.to_lowercase().as_str() {
        "kitsu"   => "kitsu",
        "anidb"   => "anidb",
        "anilist" => "anilist",
        // mal/myanimelist passthrough — caller shouldn't hit this path
        // but it keeps the API tolerant if they do.
        "mal" | "myanimelist" => return Ok(Some(id)),
        other => return Err(format!("unsupported mapping source: {other}")),
    };

    let key = format!("{src}:{id}");

    {
        let lock = mal_resolve_cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            // Positive results never expire; negative for 24 h.
            let stale = entry.mal_id.is_none() && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                crate::devlog!(
                    info, "aniskip",
                    "resolve_mal_id cache hit {src}={id} → {:?}",
                    entry.mal_id
                );
                return Ok(entry.mal_id);
            }
        }
    }

    let url = format!("https://relations.yuna.moe/api/ids?source={src}&id={id}");
    crate::devlog!(info, "aniskip", "resolve_mal_id GET {url}");

    let resp = match client().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "resolve_mal_id request failed: {e}");
            // Cache the negative so we don't hammer on transient outages.
            mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
                mal_id: None,
                cached_at: Instant::now(),
            });
            return Ok(None);
        }
    };

    if !resp.status().is_success() {
        crate::devlog!(
            warn, "aniskip",
            "resolve_mal_id HTTP {} for {src}={id}", resp.status().as_u16()
        );
        mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
            mal_id: None,
            cached_at: Instant::now(),
        });
        return Ok(None);
    }

    let parsed: YunaIdsResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "resolve_mal_id JSON parse error: {e}");
            mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
                mal_id: None,
                cached_at: Instant::now(),
            });
            return Ok(None);
        }
    };

    // yuna.moe returns mal as either a number or null. Anything else
    // (string id, missing field) we treat as no mapping.
    let mal_id = parsed.mal.and_then(|v| v.as_u64()).and_then(|n| u32::try_from(n).ok());

    mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
        mal_id,
        cached_at: Instant::now(),
    });
    crate::devlog!(
        info, "aniskip",
        "resolve_mal_id {src}={id} → {:?}", mal_id
    );
    Ok(mal_id)
}

// ---------------------------------------------------------------------------
// Title -> MAL id (Tenrai / MyAnimeList mirror).
//
// Last-resort resolver for anime that come into Aura via an IMDb id
// (`tt…`) — the most common case in practice. AIOMetadata's response
// for IMDb-keyed anime frequently has NONE of `mal_id` / `kitsu_id`
// / `anidb_id` populated because its anime-specific enrichment only
// fires when the request id already looks like an anime id (kitsu:,
// mal:, anilist:, anidb:). Without those we can't bounce through
// yuna.moe to get a MAL id, and AniSkip never fires.
//
// Tenrai exposes MAL's catalogue with no API key required at
// https://api.tenrai.org/v1/ (see tenrai.rs; it replaced Jikan, which
// shut down). Rate limit is 4 req/s, 120/min: well within budget for one
// request per fresh anime title. We cache positive results indefinitely
// (titles are stable) and negatives for 24 h to ride out transient outages.
//
// Matching rules: query Tenrai with `?q=<title>&type=tv&limit=10`.
// Walk the results, score each candidate by:
//   1. Exact case-insensitive match on `title`, `title_english`,
//      `title_japanese`, or any synonym in `titles[].title` → +100
//   2. Year match against the release_info hint (when supplied) → +20
//   3. Lower MAL id (older, more "canonical" entries) → small tiebreak
// Pick the best score; require ≥ 100 (i.e. at least one exact title
// hit) before accepting. Fuzzy matching is intentionally NOT used —
// false positives here would skip the wrong OP/ED on the wrong show.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct MalSearchResponse {
    #[serde(default)]
    data: Vec<MalSearchAnime>,
}

#[derive(Debug, Clone, Deserialize)]
struct MalSearchAnime {
    mal_id: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    title_english: Option<String>,
    #[serde(default)]
    title_japanese: Option<String>,
    #[serde(default)]
    titles: Vec<MalSearchTitle>,
    #[serde(default)]
    year: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct MalSearchTitle {
    #[serde(default)]
    title: Option<String>,
}

/// Resolve a title (and optional year hint) to a MyAnimeList id via
/// Tenrai. Returns None when no exact-title match is found. See the
/// matching-rules note above. Cached in the same `MAL_RESOLVE_CACHE`
/// that the id-based resolver uses, keyed by `title:<lowercased name>`
/// so subsequent episodes of the same series skip the round-trip.
#[tauri::command]
pub async fn resolve_mal_id_by_title(
    title: String,
    year: Option<u32>,
) -> Result<Option<u32>, String> {
    let q = title.trim();
    if q.is_empty() { return Ok(None); }
    // The year is part of the key. It used to be omitted, so the first caller
    // to ask about a title fixed the answer for every later caller regardless
    // of which year they meant, and the year filter below could never be
    // re-evaluated for them.
    let key = match year {
        Some(y) => format!("title:{}:{y}", q.to_lowercase()),
        None    => format!("title:{}", q.to_lowercase()),
    };

    {
        let lock = mal_resolve_cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = entry.mal_id.is_none() && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                crate::devlog!(
                    info, "aniskip",
                    "resolve_mal_id_by_title cache hit '{q}' → {:?}", entry.mal_id
                );
                return Ok(entry.mal_id);
            }
        }
    }

    // The MAL search limits q to 64 chars and rejects most punctuation. Strip
    // anything wild — `reqwest` percent-encodes the query string for
    // us via `.query()`.
    let cleaned: String = q.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || matches!(c, '-' | ':' | '\'' | '!' | '.' | ','))
        .take(64)
        .collect();
    let cleaned = cleaned.trim().to_string();
    let url = format!("{}/anime", crate::tenrai::TENRAI_API);
    crate::devlog!(info, "aniskip", "resolve_mal_id_by_title GET {url}?q={cleaned}");

    let resp = match client()
        .get(&url)
        .query(&[
            ("q", cleaned.as_str()),
            ("type", "tv"),
            ("limit", "10"),
            ("sfw", "true"),
        ])
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "Tenrai request failed: {e}");
            mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
                mal_id: None, cached_at: Instant::now(),
            });
            return Ok(None);
        }
    };
    if !resp.status().is_success() {
        crate::devlog!(
            warn, "aniskip",
            "Tenrai HTTP {} for '{q}'", resp.status().as_u16()
        );
        mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
            mal_id: None, cached_at: Instant::now(),
        });
        return Ok(None);
    }
    let parsed: MalSearchResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "Tenrai JSON parse error: {e}");
            mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
                mal_id: None, cached_at: Instant::now(),
            });
            return Ok(None);
        }
    };

    // Score candidates. Need at least one EXACT title hit (case-
    // insensitive) — fuzzy matching here would silently pull in the
    // wrong show, which is worse than a missed OP-skip.
    let needle = q.to_lowercase();
    let mut best: Option<(i32, u32)> = None;
    for a in parsed.data.iter() {
        let mut score: i32 = 0;
        let title_match = |s: &Option<String>| {
            s.as_deref()
                .map(|t| t.trim().to_lowercase() == needle)
                .unwrap_or(false)
        };
        if title_match(&a.title)
            || title_match(&a.title_english)
            || title_match(&a.title_japanese)
            || a.titles.iter().any(|t| title_match(&t.title))
        {
            score += 100;
        }
        // Year is a HARD FILTER when both sides have one, not a bonus.
        //
        // It used to be a bonus, and that let a candidate from the wrong
        // decade win on title alone. Combined with the low-id tiebreak below
        // it deterministically elected the franchise ROOT: a long-running
        // series' original entry matches the bare title exactly, while the
        // cour actually being watched is titled "... Season 3" and cannot.
        // The result was a hover card showing a top-tier score and MAL
        // popularity rank for a niche recent show.
        if let (Some(want), Some(have)) = (year, a.year) {
            if want == have { score += 20; }
            else if want.abs_diff(have) <= 1 { score += 10; }
            else { continue; }
        }
        // The old "prefer lower MAL ids" tiebreak lived here. It is gone on
        // purpose: preferring older entries is precisely what picks a
        // franchise root over the season in hand. Ties now resolve to the
        // FIRST candidate, which is the upstream's own relevance order.

        if score >= 100 && best.is_none_or(|(s, _)| score > s) {
            best = Some((score, a.mal_id));
        }
    }

    let mal_id = best.map(|(_, id)| id);
    mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
        mal_id, cached_at: Instant::now(),
    });
    // Logged with the winning score so a mis-election is diagnosable from the
    // DevConsole alone: hovering a card and then opening it should produce ONE
    // mal id, not two.
    crate::devlog!(
        info, "aniskip",
        "resolve_mal_id_by_title '{q}' (year={year:?}) -> {:?} (score={}, candidates={})",
        mal_id,
        best.map(|(s, _)| s).unwrap_or(0),
        parsed.data.len()
    );
    Ok(mal_id)
}

// ---------------------------------------------------------------------------
// Stamping the per-load payload onto MPV's user-data property.
// ---------------------------------------------------------------------------

/// One window as the Lua script wants to receive it. Same shape as
/// `SkipWindow` plus an `auto` flag that the React side computes from
/// the user's settings (off / prompt / auto per skip type).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedWindow {
    #[serde(rename = "type")]
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub source: String,
    pub auto: bool,
    /// AniSkip per-row identifier (when source == "aniskip"). React's
    /// AniSkipMenu reads this to call vote_skip_time. Omitted in the
    /// wire format when None so the Lua script doesn't see an
    /// unexpected field.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub skip_id: Option<String>,
    /// The opening or ending SONG playing in this window, when it could be
    /// identified with certainty. React stamps these from the MAL theme list
    /// during the single `set_skip_windows` pass, joining on the same
    /// cour-correct MAL id and MAL-local episode number AniSkip already
    /// requires. Both are omitted from the wire format when absent, so the
    /// Lua script never sees an unexpected key.
    ///
    /// ABSENCE IS MEANINGFUL: the join deliberately refuses ambiguous matches
    /// (unknown episode range, no match, or more than one candidate) and
    /// leaves these unset so the UI falls back to its generic label. Naming
    /// the wrong song is worse than naming none.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub song_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub song_artist: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkipWindowsPayload {
    pub windows: Vec<PreparedWindow>,
}

// Aura-side cache of the most recently set skip-windows payload.
// Read by `get_skip_windows` (so the React side never has to round-trip
// through `mpv.get_property("user-data/aura/skip-windows")` — that
// 250 ms poll in PlayerOverlay's `useSkipWindows` hook was racing
// libmpv's seek critical section the moment AniSkip's Lua script
// fired its skip seek, crashing the wrapper at
// `mpv_wrapper_get_property+0xa71`. CLAUDE.md landmine #3.)
static SKIP_WINDOWS_CACHE: OnceLock<Mutex<SkipWindowsPayload>> = OnceLock::new();

fn skip_windows_cache() -> &'static Mutex<SkipWindowsPayload> {
    SKIP_WINDOWS_CACHE.get_or_init(|| Mutex::new(SkipWindowsPayload { windows: Vec::new() }))
}

/// Read the last payload Aura sent to MPV. Cheap — no libmpv call.
#[tauri::command]
pub fn get_skip_windows() -> SkipWindowsPayload {
    skip_windows_cache().lock().unwrap().clone()
}

/// Write the prepared window list to MPV's
/// `user-data/aura/skip-windows` property as a JSON string. The Lua
/// script observes this property and updates its internal state on
/// every change. Pass an empty windows list to clear (e.g. when the
/// next file is non-anime or has no AniSkip data).
///
/// Also updates the Aura-side cache and emits `aura:skip-windows` so
/// React can react without polling `get_property`.
#[tauri::command]
pub async fn set_skip_windows<R: Runtime>(
    app: AppHandle<R>,
    payload: SkipWindowsPayload,
) -> Result<(), String> {
    // Serialize ourselves so MPV stores the value as a STRING — the
    // Lua script handles both `string` (parse_json) and native-table
    // shapes, but writing a string is the most predictable across
    // libmpv builds.
    let json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    crate::devlog!(
        info, "auraskip",
        "set_skip_windows ({} window(s))",
        payload.windows.len()
    );
    {
        let mut cache = skip_windows_cache().lock().unwrap();
        *cache = payload.clone();
    }
    let _ = app.emit("aura:skip-windows", &payload);
    #[cfg(target_os = "windows")]
    return crate::mpv::engine::submit_set_property(
        "user-data/aura/skip-windows".into(),
        crate::mpv::engine::PropValue::String(json),
    );
    #[cfg(not(target_os = "windows"))]
    {
        let _ = json;
        Err("playback engine is Windows-only".into())
    }
}

// ---------------------------------------------------------------------------
// Submitter id — persistent UUID v4 stamped on every POST to AniSkip
// so the server can dedupe per-user spam and offer per-submitter
// moderation. Stored next to the cache so it survives reinstalls of
// the same user-data dir; regenerated when missing or unparseable.
// ---------------------------------------------------------------------------

fn submitter_id_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("aniskip-submitter-id.txt"))
}

fn read_or_create_submitter_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let path = match submitter_id_path(app) {
        Some(p) => p,
        None => return uuid::Uuid::new_v4().to_string(),
    };
    if let Ok(text) = std::fs::read_to_string(&path) {
        let trimmed = text.trim();
        // Validate that the stored value is a parseable UUID. Bogus
        // contents (truncation, manual edits) fall through to fresh
        // generation rather than uploading junk to AniSkip.
        if uuid::Uuid::parse_str(trimmed).is_ok() {
            return trimmed.to_string();
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &fresh);
    fresh
}

// ---------------------------------------------------------------------------
// POST /v2/skip-times/{mal_id}/{episode} — submit a new OP/ED window.
//
// Body shape (camelCase per AniSkip's wire format):
//   {
//     "skipType": "op" | "ed" | "mixed-op" | "recap",
//     "providerName": "Aura",
//     "startTime": 90.0,
//     "endTime":   180.0,
//     "episodeLength": 1440.0,
//     "submitterId": "<uuid-v4>"
//   }
//
// Returns a JSON envelope with `{ message, success, skipId }` on
// success. We surface skipId so the caller can immediately upvote
// the user's own submission if AniSkip's policy permits.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SubmitSkipResult {
    pub success: bool,
    pub skip_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SubmitResponse {
    #[serde(default)] message: Option<String>,
    #[serde(default)] success: Option<bool>,
    #[serde(default, rename = "skipId")] skip_id: Option<String>,
    #[serde(default, rename = "skip_id")] skip_id_alt: Option<String>,
}

#[tauri::command]
pub async fn submit_skip_time<R: Runtime>(
    app: AppHandle<R>,
    mal_id: u32,
    episode: u32,
    skip_type: String,
    start_time: f64,
    end_time: f64,
    episode_length: f64,
) -> Result<SubmitSkipResult, String> {
    // Server-side sanity gates the wire layer enforces too, but
    // catching them locally produces a friendlier error than a 400
    // from AniSkip.
    if !matches!(skip_type.as_str(), "op" | "ed" | "mixed-op" | "recap") {
        return Err(format!("invalid skip_type: {skip_type}"));
    }
    if !start_time.is_finite() || !end_time.is_finite() {
        return Err("start_time and end_time must be finite".into());
    }
    if end_time <= start_time {
        return Err("end_time must be greater than start_time".into());
    }
    if start_time < 0.0 {
        return Err("start_time must be non-negative".into());
    }

    let submitter_id = read_or_create_submitter_id(&app);
    let url = format!("{ANISKIP_BASE}/skip-times/{mal_id}/{episode}");
    let body = serde_json::json!({
        "skipType":      skip_type,
        "providerName":  concat!("Aura/", env!("CARGO_PKG_VERSION")),
        "startTime":     start_time,
        "endTime":       end_time,
        "episodeLength": episode_length.max(0.0),
        "submitterId":   submitter_id,
    });

    crate::devlog!(
        info, "aniskip",
        "POST {url} skipType={skip_type} start={start_time:.2} end={end_time:.2} length={episode_length:.2}",
    );

    let resp = client().post(&url).json(&body).send().await
        .map_err(|e| {
            crate::devlog!(warn, "aniskip", "submit request failed: {e}");
            format!("AniSkip submit error: {e}")
        })?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        crate::devlog!(
            warn, "aniskip",
            "submit HTTP {} for mal={mal_id} ep={episode}: {}",
            status.as_u16(), raw.chars().take(400).collect::<String>(),
        );
        return Err(format!("AniSkip HTTP {}: {raw}", status.as_u16()));
    }
    let parsed: SubmitResponse = serde_json::from_str(&raw).unwrap_or(SubmitResponse {
        message: None, success: Some(true), skip_id: None, skip_id_alt: None,
    });
    let success = parsed.success.unwrap_or(true);
    let skip_id = parsed.skip_id.or(parsed.skip_id_alt);
    let message = parsed.message.unwrap_or_else(|| "Submitted".to_string());
    crate::devlog!(
        info, "aniskip",
        "submit OK status={} success={} skip_id={:?} message={}",
        status.as_u16(), success, skip_id, message,
    );
    // Invalidate the cached query so the next fetch picks up the
    // freshly-submitted window without waiting for AniSkip's
    // server-side cache to expire.
    invalidate_cache(mal_id, episode);
    Ok(SubmitSkipResult { success, skip_id, message })
}

// ---------------------------------------------------------------------------
// AniList GraphQL → MAL id resolver. yuna.moe's relations API doesn't
// always have recent anime (Frieren cour 2 fell through that gap),
// but AniList itself stores the corresponding MAL id on every Media
// record as `idMal`. Public read; no auth required. One small query
// per call — only used by the AniSkipMenu's last-resort chain.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AnilistIdMalResponse {
    data: Option<AnilistIdMalData>,
}
#[derive(Deserialize)]
struct AnilistIdMalData {
    #[serde(rename = "Media")]
    media: Option<AnilistIdMalMedia>,
}
#[derive(Deserialize)]
struct AnilistIdMalMedia {
    #[serde(rename = "idMal", default)]
    id_mal: Option<u64>,
}

/// Helper: hit yuna.moe and return the full mapping row for a single
/// (source, id) pair. Mirrors the lookup in `resolve_mal_id` but
/// surfaces ALL fields so callers can chain through whichever id is
/// populated. We keep `resolve_mal_id` as a separate command for
/// backwards-compatibility with the existing call sites that just
/// want the MAL id.
#[derive(Debug, Clone, Deserialize, Default)]
struct YunaFullResponse {
    #[serde(default)] anilist: Option<serde_json::Value>,
    #[serde(default)] mal:     Option<serde_json::Value>,
}

async fn yuna_lookup_full(source: &str, id: u64) -> Option<YunaFullResponse> {
    let api_source = match source.to_lowercase().as_str() {
        "kitsu" | "anidb" | "anilist" | "mal" => source.to_lowercase(),
        _ => return None,
    };
    let url = format!("https://relations.yuna.moe/api/ids?source={api_source}&id={id}");
    let resp = client().get(&url).send().await.ok()?;
    if !resp.status().is_success() { return None; }
    resp.json::<YunaFullResponse>().await.ok()
}

fn extract_u64(v: &Option<serde_json::Value>) -> Option<u64> {
    v.as_ref()?.as_u64()
}

/// Consolidated MAL resolver for the AniSkipMenu — walks the full
/// chain of fallbacks server-side so the frontend doesn't have to
/// orchestrate four async invocations.
///
/// Resolution order:
///   1. Direct provider id (kitsu/mal/anidb/anilist parsed from
///      `target_id`) → yuna.moe `mal` field. If present, done.
///   2. Same provider id → yuna.moe `anilist` field → AniList
///      GraphQL `Media.idMal`. Covers recent anime where yuna.moe
///      has the anilist mapping filled but not mal (Frieren cour 2
///      is the canonical case).
///   3. Series-root IMDb + season → Fribb mal_id slot via
///      `anime_id_map::lookup_mal`. tt-style fallback for shows
///      AIOMetadata serves under IMDb.
///   4. Series-root IMDb + season → Fribb anilist_id → AniList
///      GraphQL idMal. Covers Fribb rows with anilist but no mal.
///   5. Title-based MAL search (when season <= 1 only). Last
///      resort; multi-cour anime would return the cour-1 MAL
///      which is wrong for cour ≥ 2 submissions.
///
/// Returns None when every step fails. Each step logs its outcome
/// so the DevConsole `[aniskip]` filter shows the full chain.
#[tauri::command]
pub async fn resolve_mal_for_aniskip(
    target_id:    String,
    series_imdb:  Option<String>,
    season:       Option<u32>,
    title:        Option<String>,
) -> Option<u64> {
    crate::devlog!(
        info, "aniskip",
        "resolve_mal_for_aniskip target_id={target_id} series_imdb={series_imdb:?} season={season:?}",
    );
    // Parse provider + show id from `kitsu:N:M` / `mal:N:M` / etc.
    let parts: Vec<&str> = target_id.split(':').collect();
    let (provider, show_id): (Option<&str>, Option<u64>) = match parts.as_slice() {
        [p, n, _] => (Some(*p), n.parse::<u64>().ok()),
        _ => (None, None),
    };
    let is_anime_prefix = matches!(
        provider.map(|s| s.to_lowercase()).as_deref(),
        Some("kitsu") | Some("mal") | Some("anidb") | Some("anilist"),
    );

    // Step 1 + 2 — yuna.moe row in one call.
    if is_anime_prefix {
        if let (Some(p), Some(id)) = (provider, show_id) {
            if p.to_lowercase() == "mal" {
                crate::devlog!(info, "aniskip", "step 1: target id is mal:{id}");
                return Some(id);
            }
            if let Some(row) = yuna_lookup_full(p, id).await {
                if let Some(mal) = extract_u64(&row.mal) {
                    crate::devlog!(info, "aniskip", "step 1: yuna.moe {p}={id} → mal={mal}");
                    return Some(mal);
                }
                if let Some(anilist) = extract_u64(&row.anilist) {
                    crate::devlog!(
                        info, "aniskip",
                        "step 2: yuna.moe {p}={id} → anilist={anilist} → AniList idMal",
                    );
                    if let Some(mal) = resolve_anilist_to_mal(anilist).await {
                        return Some(mal);
                    }
                }
            } else {
                crate::devlog!(info, "aniskip", "step 1: yuna.moe {p}={id} → no row");
            }
        }
    }

    // Step 3 + 4 — Fribb fallback via the cour-aware anime_id_map.
    if let Some(imdb) = series_imdb.as_deref() {
        if let Some(mal) = crate::anime_id_map::lookup_mal(imdb, season) {
            crate::devlog!(info, "aniskip", "step 3: fribb mal {imdb}/{season:?} → {mal}");
            return Some(mal);
        }
        if let Some(anilist) = crate::anime_id_map::lookup(imdb, season) {
            crate::devlog!(
                info, "aniskip",
                "step 4: fribb anilist {imdb}/{season:?} → {anilist} → AniList idMal",
            );
            if let Some(mal) = resolve_anilist_to_mal(anilist).await {
                return Some(mal);
            }
        } else {
            crate::devlog!(info, "aniskip", "step 3/4: fribb has no entry for {imdb}");
        }
    }

    // Step 5 — title search (S1 only; multi-cour shows would return
    // cour 1's MAL which is wrong for cour 2 submissions).
    let s1_or_unknown = season.map(|s| s <= 1).unwrap_or(true);
    if s1_or_unknown {
        if let Some(t) = title.as_deref() {
            if !t.is_empty() {
                crate::devlog!(info, "aniskip", "step 5: title search \"{t}\"");
                if let Ok(Some(mal)) = resolve_mal_id_by_title(t.to_string(), None).await {
                    return Some(mal as u64);
                }
            }
        }
    } else {
        crate::devlog!(
            info, "aniskip",
            "step 5: skipped (season={season:?} > 1, would resolve cour 1)",
        );
    }

    crate::devlog!(warn, "aniskip", "resolve_mal_for_aniskip: all steps failed");
    None
}

#[tauri::command]
pub async fn resolve_anilist_to_mal(anilist_id: u64) -> Option<u64> {
    let query = "query ($id: Int) { Media(id: $id, type: ANIME) { idMal } }";
    let body = serde_json::json!({
        "query": query,
        "variables": { "id": anilist_id },
    });
    let cli = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .https_only(true)
        .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anilist-idmal"))
        .build()
        .ok()?;
    let resp = match cli
        .post("https://graphql.anilist.co")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "anilist idMal request failed for {anilist_id}: {e}");
            return None;
        }
    };
    if !resp.status().is_success() {
        crate::devlog!(
            warn, "aniskip",
            "anilist idMal HTTP {} for {anilist_id}", resp.status().as_u16(),
        );
        return None;
    }
    let parsed: AnilistIdMalResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "anilist idMal parse error: {e}");
            return None;
        }
    };
    let id_mal = parsed.data.and_then(|d| d.media).and_then(|m| m.id_mal);
    crate::devlog!(
        info, "aniskip",
        "resolve_anilist_to_mal({anilist_id}) → {id_mal:?}",
    );
    id_mal
}

// ---------------------------------------------------------------------------
// POST /v2/skip-times/vote/{skip_id} — upvote / downvote a submission.
// Body: { "voteType": "upvote" | "downvote" }
// ---------------------------------------------------------------------------

#[tauri::command]
// `mal_id` / `episode` are optional and are used only to invalidate this
// episode's cached windows once the vote lands; a caller that omits them just
// skips that step.
pub async fn vote_skip_time(
    skip_id: String,
    vote_type: String,
    mal_id: Option<u32>,
    episode: Option<u32>,
) -> Result<bool, String> {
    if !matches!(vote_type.as_str(), "upvote" | "downvote") {
        return Err(format!("invalid vote_type: {vote_type}"));
    }
    let url = format!("{ANISKIP_BASE}/skip-times/vote/{skip_id}");
    let body = serde_json::json!({ "voteType": vote_type });
    crate::devlog!(info, "aniskip", "POST {url} voteType={vote_type}");
    let resp = client().post(&url).json(&body).send().await
        .map_err(|e| format!("AniSkip vote error: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let raw = resp.text().await.unwrap_or_default();
        crate::devlog!(
            warn, "aniskip",
            "vote HTTP {} for skip_id={skip_id}: {}",
            status.as_u16(), raw.chars().take(400).collect::<String>(),
        );
        return Err(format!("AniSkip HTTP {}", status.as_u16()));
    }
    // The vote itself does not change what AniSkip returns today (votes
    // accumulate server-side), but the user has flagged this episode's data,
    // so stop serving them the local copy of it.
    if let (Some(mal), Some(ep)) = (mal_id, episode) {
        invalidate_cache(mal, ep);
    }
    Ok(true)
}
