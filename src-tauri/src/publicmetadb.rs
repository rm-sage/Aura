// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// publicmetadb skip-timestamp client.
//
// Endpoint:
//   GET https://publicmetadb.com/api/external/skips
//       ?tmdb_id={id}&media_type={tv|movie}&season={n}&episode={n}
//   Header: Authorization: Bearer <AURA_PUBLICMETADB_KEY>
//
// Response (the fields we consume):
//   { "items": [ { "intro_start_ms": …, "intro_end_ms": …,
//                   "credits_start_ms": …, "credits_end_ms": … }, … ] }
//
// publicmetadb is a crowd-sourced skip database — Aura's PRIMARY skip
// source for live-action series (which AniSkip does not cover) and a
// best-effort SECONDARY source for anime. The key is app-owned, baked
// at build time by build.rs (the mdblist.key pattern); an empty key
// makes the whole module cleanly no-op.
//
// A dedicated HTTP client + cache keep publicmetadb latency off the
// addon catalog path — same discipline as aniskip.rs.
// ---------------------------------------------------------------------------

const PUBLICMETADB_URL: &str = "https://publicmetadb.com/api/external/skips";
const AURA_PUBLICMETADB_KEY: &str = env!("AURA_PUBLICMETADB_KEY");
const NEGATIVE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// One skip row from publicmetadb's `items[]`. Every field is optional —
/// a row may carry only an intro, only credits, or neither.
#[derive(Debug, Clone, Deserialize)]
struct ApiSkipItem {
    #[serde(default)] intro_start_ms:   Option<f64>,
    #[serde(default)] intro_end_ms:     Option<f64>,
    #[serde(default)] credits_start_ms: Option<f64>,
    #[serde(default)] credits_end_ms:   Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    items: Vec<ApiSkipItem>,
}

/// One normalized skip window. Shape mirrors `aniskip::SkipWindow`
/// minus `skip_id` (publicmetadb rows carry no per-row vote identity).
/// `kind` is "op" (from intro_*) or "ed" (from credits_*); `start` /
/// `end` are SECONDS — the API gives milliseconds, converted on the
/// way out.
#[derive(Debug, Clone, Serialize)]
pub struct PublicmetadbWindow {
    pub kind:   String,
    pub start:  f64,
    pub end:    f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicmetadbSkips {
    /// True when at least one usable window was produced.
    pub found:   bool,
    pub windows: Vec<PublicmetadbWindow>,
}

// ---------------------------------------------------------------------------
// Cache — positive results kept indefinitely (skip data for a given
// episode is stable once submitted); 404 / empty negatives expire after
// 24 h. Keyed by tmdb_id:media_type:season:episode.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    payload:   PublicmetadbSkips,
    cached_at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(tmdb_id: i64, media_type: &str, season: u32, episode: u32) -> String {
    format!("{tmdb_id}:{media_type}:{season}:{episode}")
}

// ---------------------------------------------------------------------------
// HTTP client — dedicated, so publicmetadb latency / errors don't bleed
// into the addon catalog path. Mirrors aniskip.rs's client config.
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
            .expect("publicmetadb client init failed")
    })
}

/// Convert a millisecond start/end pair into a seconds-based window when
/// both are present, finite, and form a positive interval. Malformed
/// rows collapse to None and are dropped.
fn window_from_ms(
    kind: &str,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
) -> Option<PublicmetadbWindow> {
    let (s, e) = (start_ms?, end_ms?);
    if !s.is_finite() || !e.is_finite() {
        return None;
    }
    let (start, end) = (s / 1000.0, e / 1000.0);
    if end <= start || start < 0.0 {
        return None;
    }
    Some(PublicmetadbWindow {
        kind:   kind.to_string(),
        start,
        end,
        source: "publicmetadb".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Command — fetch_publicmetadb_skips(tmdb_id, media_type, season, episode)
//
// Returns the OP/ED windows for one episode. Network / HTTP / parse
// failure and "no data" all collapse to `found: false, windows: []` —
// the caller falls through to the next skip source. Never hard-fails.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_publicmetadb_skips(
    tmdb_id:    i64,
    media_type: String,
    season:     u32,
    episode:    u32,
) -> Result<PublicmetadbSkips, String> {
    let empty = PublicmetadbSkips { found: false, windows: vec![] };

    // No key baked → feature inert (the mdblist.key pattern).
    if AURA_PUBLICMETADB_KEY.trim().is_empty() {
        return Ok(empty);
    }

    // The API only knows `tv` / `movie`; anything else is coerced to tv.
    let mt = match media_type.as_str() {
        "movie" => "movie",
        _       => "tv",
    };
    let key = cache_key(tmdb_id, mt, season, episode);

    // Cache hit? Positive kept forever; negative expires after 24 h.
    {
        let lock = cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = !entry.payload.found
                && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                crate::devlog!(
                    info, "publicmetadb",
                    "cache hit {key} found={} ({} window(s))",
                    entry.payload.found, entry.payload.windows.len(),
                );
                return Ok(entry.payload.clone());
            }
        }
    }

    crate::devlog!(
        info, "publicmetadb",
        "GET {PUBLICMETADB_URL} tmdb={tmdb_id} type={mt} s={season} e={episode}",
    );

    let resp = match client()
        .get(PUBLICMETADB_URL)
        .query(&[
            ("tmdb_id",    tmdb_id.to_string()),
            ("media_type", mt.to_string()),
            ("season",     season.to_string()),
            ("episode",    episode.to_string()),
        ])
        .bearer_auth(AURA_PUBLICMETADB_KEY)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Network-class failure — don't cache, so a transient blip
            // retries on the next episode load.
            crate::devlog!(warn, "publicmetadb", "request failed: {e}");
            return Ok(empty);
        }
    };

    let status = resp.status();
    if !status.is_success() {
        crate::devlog!(
            warn, "publicmetadb",
            "HTTP {} for {key}", status.as_u16(),
        );
        // 404 = "no data for this episode" — negative-cache it. Other
        // HTTP errors (5xx, 429) are transient — don't cache.
        if status == reqwest::StatusCode::NOT_FOUND {
            cache().lock().unwrap().insert(key, CacheEntry {
                payload: empty.clone(), cached_at: Instant::now(),
            });
        }
        return Ok(empty);
    }

    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            crate::devlog!(warn, "publicmetadb", "read error: {e}");
            return Ok(empty);
        }
    };
    let parsed: ApiResponse = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(
                warn, "publicmetadb",
                "JSON parse error: {e} body_len={}", raw.len(),
            );
            return Ok(empty);
        }
    };

    // A 200 with no items is a genuine "no skip data" answer — but it's
    // ALSO what a wire-shape mismatch (field names != this struct) looks
    // like, since every field is #[serde(default)]. Dump the raw body
    // (truncated) so a mismatch is diagnosable from the DevConsole.
    if parsed.items.is_empty() {
        crate::devlog!(
            info, "publicmetadb",
            "200 OK, items empty for {key} — body: {}",
            raw.chars().take(300).collect::<String>(),
        );
    }

    // Map the FIRST item: intro_* → an OP window, credits_* → an ED
    // window. ms → seconds; malformed pairs are dropped by window_from_ms.
    let mut windows: Vec<PublicmetadbWindow> = Vec::new();
    if let Some(item) = parsed.items.first() {
        if let Some(w) = window_from_ms("op", item.intro_start_ms, item.intro_end_ms) {
            windows.push(w);
        }
        if let Some(w) = window_from_ms("ed", item.credits_start_ms, item.credits_end_ms) {
            windows.push(w);
        }
    }

    let payload = PublicmetadbSkips { found: !windows.is_empty(), windows };

    // Cache positive AND "200-but-empty" results — an empty 200 is a
    // genuine "no skip data" answer; the 24 h negative TTL applies to it.
    cache().lock().unwrap().insert(key.clone(), CacheEntry {
        payload:   payload.clone(),
        cached_at: Instant::now(),
    });

    crate::devlog!(
        info, "publicmetadb",
        "resolved {key} found={} windows={}",
        payload.found, payload.windows.len(),
    );
    Ok(payload)
}

// ---------------------------------------------------------------------------
// resolve_anime_tmdb_id — best-effort kitsu/anidb/anilist → TMDB id.
//
// publicmetadb is TMDB-keyed. Live-action series get their TMDB id from
// AIOMetadata's `_tmdbId` (see stremio.rs::build_meta_detail). For anime
// that id is unreliable, so the anime publicmetadb fallback resolves a
// TMDB id from yuna.moe's relations API instead — the same API the
// AniSkip MAL resolver already uses, which returns a `themoviedb` field.
//
// Isolated as its own command + cache here (rather than retrofitting
// aniskip.rs::resolve_mal_id) so the change is contained. yuna.moe
// mappings are static — positives cached forever, negatives 24 h.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct YunaTmdbResponse {
    #[serde(default)]
    themoviedb: Option<serde_json::Value>,
}

#[derive(Clone)]
struct TmdbResolveEntry {
    tmdb_id:   Option<i64>,
    cached_at: Instant,
}

static TMDB_RESOLVE_CACHE: OnceLock<Mutex<HashMap<String, TmdbResolveEntry>>> = OnceLock::new();

fn tmdb_resolve_cache() -> &'static Mutex<HashMap<String, TmdbResolveEntry>> {
    TMDB_RESOLVE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn resolve_anime_tmdb_id(source: String, id: u32) -> Option<i64> {
    let src = match source.to_lowercase().as_str() {
        "kitsu"   => "kitsu",
        "anidb"   => "anidb",
        "anilist" => "anilist",
        _         => return None,
    };
    let key = format!("{src}:{id}");

    {
        let lock = tmdb_resolve_cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = entry.tmdb_id.is_none()
                && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                return entry.tmdb_id;
            }
        }
    }

    let url = format!("https://relations.yuna.moe/api/ids?source={src}&id={id}");
    let tmdb_id: Option<i64> = async {
        let resp = client().get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let parsed: YunaTmdbResponse = resp.json().await.ok()?;
        // yuna.moe returns themoviedb as a number or null.
        parsed.themoviedb.as_ref().and_then(|v| v.as_i64())
    }
    .await;

    tmdb_resolve_cache().lock().unwrap().insert(key, TmdbResolveEntry {
        tmdb_id,
        cached_at: Instant::now(),
    });
    crate::devlog!(
        info, "publicmetadb",
        "resolve_anime_tmdb_id {src}={id} → {tmdb_id:?}",
    );
    tmdb_id
}