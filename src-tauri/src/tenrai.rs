// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Tenrai (MyAnimeList mirror) client.
//
// Replaces Jikan (api.jikan.moe/v4), which is shutting down permanently.
// Tenrai serves the identical response envelope and field names, so this is a
// base-URL change rather than a client rewrite. The one thing that is NOT the
// same is the version segment: Tenrai is `/v1`, Jikan was `/v4`. Verified live
// against /anime/21/full (One Piece) before the migration.
//
// Rate limits (better than Jikan's 3 req/s, 60/min):
//   public          4 req/s, 120/min, 40k/day
//   X-Server-Key    5 req/s, 300/min, unlimited daily  (Patreon; NOT used)
//
// The server key is deliberately out of scope. Public limits cover Aura's
// usage comfortably, and `api_keyring::SUPPORTED_KEYS` is where it would live
// if that ever changes.
//
// WHY THIS IS A MODULE AND NOT A CONST
//
// `/anime/{id}/full` was already being fetched by `ratings.rs` on every anime
// detail open AND every catalog hover, parsed down to five fields, and thrown
// away. That same payload carries the `theme` object (opening and ending
// songs). Routing both readers through one cached fetch means theme songs cost
// zero additional requests, and repeat surfaces cost zero requests at all.
//
// Everything here is best-effort. A dead host, a 404 or a parse failure yields
// None and the dependent feature ships inert. This module must never fail a
// caller.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Base URL. Single source of truth: `aniskip.rs`'s title search reads this
/// too, so there is no second hardcoded host anywhere in the tree.
pub const TENRAI_API: &str = "https://api.tenrai.org/v1";

const TIMEOUT: Duration = Duration::from_secs(10);
/// MAL scores drift slowly. Long enough to collapse a browsing session's
/// repeat hovers into one request, short enough that a score is never
/// meaningfully stale.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// A miss is ambiguous: it means "no such MAL entry" but it also means
/// "the network was out when we asked". Honouring the second for six hours
/// would strip a show of ratings for the rest of the session.
const NEGATIVE_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_CAP: usize = 200;

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
            .user_agent("Aura/1.6.3 anime-metadata")
            .build()
            .expect("Tenrai HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// /anime/{id}/full
// ---------------------------------------------------------------------------

/// The raw theme block. Both arrays are display strings, not structured data:
///   `1: "again" by YUI (eps 1-14)`
/// `theme_parse` turns them into spans. Note the naming trap on the wire:
/// `theme` is songs, `themes` is genre themes (Military, Isekai). Different
/// fields, and only the first is wanted here.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnimeThemeRaw {
    #[serde(default)]
    pub openings: Vec<String>,
    #[serde(default)]
    pub endings: Vec<String>,
}

/// The subset of `/full` Aura reads. Deliberately narrow: this is cached, and
/// the payload is large.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnimeFull {
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub scored_by: Option<u64>,
    #[serde(default)]
    pub rank: Option<u32>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub members: Option<u64>,
    #[serde(default)]
    pub theme: Option<AnimeThemeRaw>,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
}

#[derive(Clone)]
struct FullEntry {
    value: Option<AnimeFull>,
    cached_at: Instant,
}

static FULL_CACHE: OnceLock<Mutex<HashMap<u32, FullEntry>>> = OnceLock::new();

fn full_cache() -> &'static Mutex<HashMap<u32, FullEntry>> {
    FULL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Insert with eviction. Drops the oldest quarter when the cap is reached,
/// mirroring `aniskip.rs`'s cache discipline.
fn cache_put(mal_id: u32, value: Option<AnimeFull>) {
    let mut lock = full_cache().lock().unwrap();
    if lock.len() >= CACHE_CAP {
        let mut ages: Vec<(u32, Instant)> =
            lock.iter().map(|(k, v)| (*k, v.cached_at)).collect();
        ages.sort_by_key(|(_, t)| *t);
        for (k, _) in ages.into_iter().take(CACHE_CAP / 4) {
            lock.remove(&k);
        }
    }
    lock.insert(mal_id, FullEntry { value, cached_at: Instant::now() });
}

fn cache_get(mal_id: u32) -> Option<Option<AnimeFull>> {
    let lock = full_cache().lock().unwrap();
    let entry = lock.get(&mal_id)?;
    let ttl = if entry.value.is_some() { TTL } else { NEGATIVE_TTL };
    if entry.cached_at.elapsed() >= ttl {
        return None;
    }
    Some(entry.value.clone())
}

/// Fetch `/anime/{id}/full`, cached. `None` means "no usable answer", never
/// "empty answer": callers treat it as the feature being unavailable for this
/// id rather than as data.
pub async fn anime_full(mal_id: u32) -> Option<AnimeFull> {
    if mal_id == 0 {
        return None;
    }
    if let Some(hit) = cache_get(mal_id) {
        return hit;
    }
    let value = fetch_json::<AnimeFull>(&format!("{TENRAI_API}/anime/{mal_id}/full")).await;
    cache_put(mal_id, value.clone());
    value
}

/// Shared GET plus envelope unwrap. Every endpoint in this module returns
/// `{ "data": ... }`, so the failure handling lives here once.
async fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> Option<T> {
    let resp = match client().get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "tenrai", "request failed {url}: {e}");
            return None;
        }
    };
    let status = resp.status();
    if !status.is_success() {
        // 404 usually just means the id does not exist on MAL. Quiet.
        if status.as_u16() != 404 {
            crate::devlog!(warn, "tenrai", "HTTP {} for {url}", status.as_u16());
        }
        return None;
    }
    match resp.json::<Envelope<T>>().await {
        Ok(env) => env.data,
        Err(e) => {
            crate::devlog!(warn, "tenrai", "parse error for {url}: {e}");
            None
        }
    }
}
