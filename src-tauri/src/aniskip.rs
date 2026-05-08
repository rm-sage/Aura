// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_libmpv::MpvExt;

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
    /// Total episode length AniSkip received from the submitter; we
    /// don't currently use it but it's useful for diagnostics.
    #[serde(rename = "episodeLength", default)]
    #[allow(dead_code)]
    episode_length: f64,
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

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(mal_id: u32, episode: u32) -> String {
    format!("{}:{}", mal_id, episode)
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
            // plain-HTTP host). Matches the policy on auth / OMDb /
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
    let key = cache_key(mal_id, episode);

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
            cache().lock().unwrap().insert(key, CacheEntry {
                payload: payload.clone(),
                cached_at: Instant::now(),
            });
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
                    start:  r.interval.start_time,
                    end:    r.interval.end_time,
                    source: "aniskip".into(),
                }
            })
            .collect();
        SkipWindows { found: true, windows }
    };

    cache().lock().unwrap().insert(key.clone(), CacheEntry {
        payload: payload.clone(),
        cached_at: Instant::now(),
    });

    crate::devlog!(
        info, "aniskip",
        "resolved mal={mal_id} ep={episode} found={} windows={}",
        payload.found, payload.windows.len()
    );
    Ok(payload)
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
// Title → MAL id (Jikan / MyAnimeList unofficial API).
//
// Last-resort resolver for anime that come into Aura via an IMDb id
// (`tt…`) — the most common case in practice. AIOMetadata's response
// for IMDb-keyed anime frequently has NONE of `mal_id` / `kitsu_id`
// / `anidb_id` populated because its anime-specific enrichment only
// fires when the request id already looks like an anime id (kitsu:,
// mal:, anilist:, anidb:). Without those we can't bounce through
// yuna.moe to get a MAL id, and AniSkip never fires.
//
// Jikan exposes MAL's catalogue with no API key required at
// https://api.jikan.moe/v4/. Rate limit is 3 req/s, 60/min — well
// within budget for one request per fresh anime title. We cache
// positive results indefinitely (titles are stable) and negatives
// for 24 h to ride out transient outages.
//
// Matching rules: query Jikan with `?q=<title>&type=tv&limit=10`.
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
struct JikanSearchResponse {
    #[serde(default)]
    data: Vec<JikanAnime>,
}

#[derive(Debug, Clone, Deserialize)]
struct JikanAnime {
    mal_id: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    title_english: Option<String>,
    #[serde(default)]
    title_japanese: Option<String>,
    #[serde(default)]
    titles: Vec<JikanTitle>,
    #[serde(default)]
    year: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
struct JikanTitle {
    #[serde(default)]
    title: Option<String>,
}

/// Resolve a title (and optional year hint) to a MyAnimeList id via
/// Jikan. Returns None when no exact-title match is found — see the
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
    let key = format!("title:{}", q.to_lowercase());

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

    // Jikan limits q to 64 chars and rejects most punctuation. Strip
    // anything wild — `reqwest` percent-encodes the query string for
    // us via `.query()`.
    let cleaned: String = q.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || matches!(c, '-' | ':' | '\'' | '!' | '.' | ','))
        .take(64)
        .collect();
    let cleaned = cleaned.trim().to_string();
    let url = "https://api.jikan.moe/v4/anime";
    crate::devlog!(info, "aniskip", "resolve_mal_id_by_title GET {url}?q={cleaned}");

    let resp = match client()
        .get(url)
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
            crate::devlog!(warn, "aniskip", "Jikan request failed: {e}");
            mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
                mal_id: None, cached_at: Instant::now(),
            });
            return Ok(None);
        }
    };
    if !resp.status().is_success() {
        crate::devlog!(
            warn, "aniskip",
            "Jikan HTTP {} for '{q}'", resp.status().as_u16()
        );
        mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
            mal_id: None, cached_at: Instant::now(),
        });
        return Ok(None);
    }
    let parsed: JikanSearchResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "aniskip", "Jikan JSON parse error: {e}");
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
        if let (Some(want), Some(have)) = (year, a.year) {
            if want == have { score += 20; }
            else if want.abs_diff(have) <= 1 { score += 10; }
        }
        // Lower MAL ids → older entries → preferred on duplicates.
        // Cap the contribution so it can't outweigh title match.
        score += (50_000_u32.saturating_sub(a.mal_id.min(50_000)) / 5_000) as i32;

        if score >= 100 && best.map_or(true, |(s, _)| score > s) {
            best = Some((score, a.mal_id));
        }
    }

    let mal_id = best.map(|(_, id)| id);
    mal_resolve_cache().lock().unwrap().insert(key, MalResolveEntry {
        mal_id, cached_at: Instant::now(),
    });
    crate::devlog!(
        info, "aniskip",
        "resolve_mal_id_by_title '{q}' (year={year:?}) → {:?}", mal_id
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
        info, "aniskip",
        "set_skip_windows ({} window(s))",
        payload.windows.len()
    );
    {
        let mut cache = skip_windows_cache().lock().unwrap();
        *cache = payload.clone();
    }
    let _ = app.emit("aura:skip-windows", &payload);
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .set_property(
                "user-data/aura/skip-windows",
                &serde_json::Value::String(json),
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
