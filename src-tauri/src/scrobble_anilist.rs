// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! AniList scrobble integration. Uses the access_token persisted by
//! scrobble_auth.rs (deep-link OAuth flow) to call AniList's GraphQL
//! API directly. Two responsibilities:
//!
//! 1. Resolve Aura's session (IMDB-id-based) to an AniList media id.
//!    AniList's API doesn't accept IMDB ids, so we search by title and
//!    cache successful mappings to disk so the search runs at most
//!    once per show. Multi-season anime (Demon Slayer S01/S02/S03/...)
//!    is a known weakness here: the search returns the most popular
//!    match, which is usually season 1; users watching season 2+ will
//!    see progress saved to the wrong AniList entry until a proper
//!    IMDB↔AniList mapping is wired (anime-offline-database +
//!    anime-lists/anime-lists XML for TVDB↔AniList season splits).
//!
//! 2. Save progress via `SaveMediaListEntry`. Pre-flight reads the
//!    user's existing progress on the entry; we only update if our
//!    episode is HIGHER (avoids clobbering manual marks where the
//!    user is ahead of what Aura has played).
//!
//! Error handling per the AIOMetadata reference:
//!   * 401/403 → clear keyring entry, surface re-auth (handled by
//!     caller via AnilistError::Unauthorized)
//!   * 404 → silent (anime not on AniList; common, not an error)
//!   * 429/5xx → retry with backoff 1s/2s/4s (max 3 attempts)
//!   * GraphQL errors come in HTTP 200 with errors[]; parse error
//!     status to bucket as Unauthorized / NotFound / generic
//!
//! AniList does NOT issue refresh tokens (see scrobble_auth.rs); on
//! Unauthorized the only recovery is full re-auth.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::scrobble::ScrobbleSession;
use crate::scrobble_auth;

const ANILIST_API: &str = "https://graphql.anilist.co";
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RETRIES: u32 = 3;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anilist"))
            .build()
            .expect("AniList HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Persistent ID cache (title → AniList id, keyed by IMDB show id)
// ---------------------------------------------------------------------------

/// Cache schema version. Bump whenever the resolution algorithm
/// changes in a way that could make existing cached anilist_ids
/// wrong. The cache reader treats multi-cour entries (lookup_season
/// > 1) with `resolver_version < CURRENT_CACHE_VERSION` as misses
/// so a single re-resolve corrects them via the new path.
///
/// History:
///   * v0 (implicit, pre-release): popularity-search picked the
///     franchise root for any season. Multi-cour saves landed on
///     the wrong cour (Frieren S02E10 → S1 entry).
///   * v1: SEQUEL-walk on save_progress finds the correct cour for
///     season > 1. Bumped so existing v0 multi-cour rows get
///     re-resolved on next watch.
const CURRENT_CACHE_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedMedia {
    anilist_id: u64,
    episodes:   Option<u32>,
    fetched_at: u64,
    /// Cache schema version that wrote this row. `default = 0` so
    /// rows from older Aura versions deserialize cleanly; the reader
    /// then invalidates them for multi-cour keys.
    #[serde(default)]
    resolver_version: u32,
}

#[derive(Default, Serialize, Deserialize)]
struct IdCache {
    /// Key is the IMDB show id (e.g. `tt0903747`). For movies the show
    /// id IS the movie id; for series it's the show root, with season /
    /// episode stripped. Limitation: multi-season anime collide here.
    by_show: HashMap<String, CachedMedia>,
}

static CACHE: OnceLock<Mutex<IdCache>> = OnceLock::new();

fn cache_lock() -> &'static Mutex<IdCache> {
    CACHE.get_or_init(|| Mutex::new(IdCache::default()))
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("anilist-id-cache.json"))
}

/// Load the persistent cache from disk. Idempotent; safe to call
/// multiple times (subsequent calls overwrite the in-memory cache).
/// Errors are silent (corrupt / missing file = empty cache).
pub fn init_cache<R: Runtime>(app: &AppHandle<R>) {
    let loaded: IdCache = cache_path(app)
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if let Ok(mut g) = cache_lock().lock() {
        let count = loaded.by_show.len();
        *g = loaded;
        crate::devlog!(info, "scrobble", "AniList ID cache loaded ({count} entries)");
    }
}

fn save_cache<R: Runtime>(app: &AppHandle<R>, cache: &IdCache) {
    let Some(path) = cache_path(app) else { return; };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(&path, json);
    }
    // Notify the frontend that the cache changed so sync.ts can debounce
    // a push. We can't take an AppHandle in the helper signature for
    // every caller without churn; the Emitter call below relies on the
    // handle the caller already passed in.
    use tauri::Emitter;
    let _ = app.emit("anilist-id-map-changed", ());
}

// ---------------------------------------------------------------------------
// Bulk get/set used by the cloud sync layer (sync.rs).
//
// The IdCache struct is private (its shape is internal to AniList
// scrobbling) so the bulk commands round-trip serde_json::Value
// instead. Sync layer treats it as opaque JSON; the merge strategy in
// sync.ts unions the two `by_show` maps with a "more episodes wins"
// disambiguation for multi-season collisions.
// ---------------------------------------------------------------------------

/// Snapshot the entire cache as JSON for the sync push path.
#[tauri::command]
pub async fn get_anilist_id_map() -> Result<serde_json::Value, String> {
    let guard = cache_lock().lock().map_err(|e| e.to_string())?;
    serde_json::to_value(&*guard).map_err(|e| e.to_string())
}

/// Replace the cache with the given snapshot. Used by sync pull when
/// the proxy returns a merged version. Total replacement: any entries
/// not in `map` are dropped from in-memory and from disk.
#[tauri::command]
pub async fn set_anilist_id_map<R: Runtime>(
    app: AppHandle<R>,
    map: serde_json::Value,
) -> Result<(), String> {
    let parsed: IdCache = serde_json::from_value(map).map_err(|e| e.to_string())?;
    // Take the write AND the snapshot inside one critical section.
    // Dropping the lock between the two created a window where an
    // in-flight scrobble lookup could mutate the cache after our
    // assignment but before our snapshot, and the disk write would
    // then either include the racing mutation (mostly harmless) or
    // overwrite a fresh in-memory entry with stale data (silent loss).
    let snapshot = {
        let mut guard = cache_lock().lock().map_err(|e| e.to_string())?;
        *guard = parsed;
        guard.by_show.clone()
    };
    save_cache(&app, &IdCache { by_show: snapshot });
    Ok(())
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AnilistError {
    /// Token revoked or lapsed. Caller must clear the keyring entry
    /// and surface a Reconnect prompt; AniList has no refresh path.
    Unauthorized,
    /// Anime not on AniList, or AniList ID lookup found nothing.
    /// Common for non-Japanese animation, very recent shows, etc.
    /// Should be treated as a no-op, not an error.
    NotFound,
    /// 429 / 5xx after exhausting retry budget.
    RateLimited,
    Network(String),
    HttpStatus(u16),
    Decode(String),
    GraphQL(String),
    MissingData,
}

impl std::fmt::Display for AnilistError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Unauthorized   => write!(f, "unauthorized (token revoked or expired)"),
            Self::NotFound       => write!(f, "not found"),
            Self::RateLimited    => write!(f, "rate-limited"),
            Self::Network(s)     => write!(f, "network: {s}"),
            Self::HttpStatus(s)  => write!(f, "http {s}"),
            Self::Decode(s)      => write!(f, "decode: {s}"),
            Self::GraphQL(s)     => write!(f, "graphql: {s}"),
            Self::MissingData    => write!(f, "no data"),
        }
    }
}

// ---------------------------------------------------------------------------
// GraphQL plumbing
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct GraphQLBody<'a, V: Serialize> {
    query:     &'a str,
    variables: V,
}

#[derive(Deserialize, Debug)]
struct GraphQLResp<T> {
    #[serde(default = "Option::default")]
    data:   Option<T>,
    #[serde(default = "Option::default")]
    errors: Option<Vec<GraphQLError>>,
}

#[derive(Deserialize, Debug)]
struct GraphQLError {
    message: String,
    #[serde(default = "Option::default")]
    status:  Option<i64>,
}

/// POST a GraphQL operation with retry on 429/5xx. Backoff: 1s, 2s, 4s.
async fn graphql_post<V: Serialize, T: for<'de> Deserialize<'de>>(
    token:     &str,
    query:     &str,
    variables: V,
) -> Result<T, AnilistError> {
    let body = GraphQLBody { query, variables };

    let mut last_err = AnilistError::Network("no attempts".into());
    for attempt in 0..MAX_RETRIES {
        let res = client()
            .post(ANILIST_API)
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await;

        let resp = match res {
            Ok(r) => r,
            Err(e) => {
                let transient = e.is_timeout() || e.is_connect();
                last_err = AnilistError::Network(e.to_string());
                if transient && attempt + 1 < MAX_RETRIES {
                    tokio::time::sleep(Duration::from_millis(1000u64 << attempt)).await;
                    continue;
                }
                return Err(last_err);
            }
        };

        let status = resp.status();

        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(AnilistError::Unauthorized);
        }
        if status.as_u16() == 429 || status.is_server_error() {
            last_err = if status.as_u16() == 429 {
                AnilistError::RateLimited
            } else {
                AnilistError::HttpStatus(status.as_u16())
            };
            if attempt + 1 < MAX_RETRIES {
                tokio::time::sleep(Duration::from_millis(1000u64 << attempt)).await;
                continue;
            }
            return Err(last_err);
        }
        if !status.is_success() {
            return Err(AnilistError::HttpStatus(status.as_u16()));
        }

        let parsed: GraphQLResp<T> = resp
            .json()
            .await
            .map_err(|e| AnilistError::Decode(e.to_string()))?;

        if let Some(errors) = parsed.errors {
            let unauthorized = errors.iter().any(|e| {
                matches!(e.status, Some(401) | Some(403))
                    || e.message.to_lowercase().contains("unauthorized")
                    || e.message.to_lowercase().contains("invalid token")
            });
            if unauthorized {
                return Err(AnilistError::Unauthorized);
            }
            let not_found = errors.iter().any(|e| matches!(e.status, Some(404)));
            if not_found {
                return Err(AnilistError::NotFound);
            }
            return Err(AnilistError::GraphQL(
                errors.into_iter().map(|e| e.message).collect::<Vec<_>>().join("; "),
            ));
        }
        return parsed.data.ok_or(AnilistError::MissingData);
    }

    Err(last_err)
}

// ---------------------------------------------------------------------------
// GraphQL operations
// ---------------------------------------------------------------------------

const SEARCH_QUERY: &str = "
query ($search: String) {
  Page(perPage: 5) {
    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
      id
      idMal
      episodes
      status
      title { romaji english native }
      mediaListEntry { id status progress }
    }
  }
}
";

const MEDIA_QUERY: &str = "
query ($mediaId: Int) {
  Media(id: $mediaId, type: ANIME) {
    id idMal episodes status
    mediaListEntry { id status progress }
  }
}
";

/// Walks a single SEQUEL edge from a starting Media. Used by the
/// season-aware resolver to map Aura's `season > 1` requests onto
/// AniList's per-cour entries when a popularity-sorted title search
/// returns the franchise root (season 1) instead of the sequel the
/// user is actually watching. One hop per call; the caller iterates
/// `lookup_season - 1` times to reach season N.
const RELATIONS_QUERY: &str = "
query ($mediaId: Int) {
  Media(id: $mediaId, type: ANIME) {
    relations {
      edges {
        relationType
        node { id idMal episodes status }
      }
    }
  }
}
";

const SAVE_MUTATION: &str = "
mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
    id progress status
  }
}
";

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)] // id_mal kept for future MAL cross-mapping work
pub struct MediaInfo {
    pub id:       u64,
    #[serde(rename = "idMal", default)]
    pub id_mal:   Option<u64>,
    #[serde(default)]
    pub episodes: Option<u32>,
    /// AniList release status — one of `FINISHED`, `RELEASING`,
    /// `NOT_YET_RELEASED`, `CANCELLED`, `HIATUS`. Aura uses this as
    /// an additional wrong-mapping signal: when the id-map (Fribb)
    /// hands us an entry that's `NOT_YET_RELEASED` but the user is
    /// requesting progress > 0, the mapping is almost certainly off
    /// (Fribb has Frieren's cour rows in the wrong order, for
    /// example, mapping S2 → S3's anilist_id). The existing
    /// `episodes >= episode_num` guard didn't fire for unaired
    /// entries because `episodes` is None until the schedule is set.
    #[serde(default)]
    pub status:   Option<String>,
    #[serde(rename = "mediaListEntry", default)]
    pub media_list_entry: Option<MediaListEntry>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(dead_code)] // id and status are surfaced for diagnostics / future UI
pub struct MediaListEntry {
    pub id:       u64,
    pub status:   String,
    pub progress: u32,
}

#[derive(Deserialize, Debug)]
struct SearchResponse {
    #[serde(rename = "Page")]
    page: SearchPage,
}

#[derive(Deserialize, Debug)]
struct SearchPage {
    media: Vec<MediaInfo>,
}

#[derive(Deserialize, Debug)]
struct MediaResponse {
    #[serde(rename = "Media")]
    media: Option<MediaInfo>,
}

#[derive(Deserialize, Debug)]
struct SaveResponse {
    #[serde(rename = "SaveMediaListEntry")]
    _save: serde_json::Value,
}

/// Minimal Media shape returned by the relations query — only the
/// fields needed to decide whether a sequel candidate is the right
/// cour. Re-fetched via fetch_media at the end of the walk to pick
/// up `mediaListEntry`, which the relations payload doesn't include.
#[derive(Deserialize, Debug, Clone)]
struct RelationNode {
    id: u64,
    /// Episode count surfaced for log diagnostics; the walk's final
    /// is_plausible_target check looks at the destination Media's
    /// episodes rather than the intermediate node's.
    #[allow(dead_code)]
    #[serde(default)]
    episodes: Option<u32>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize, Debug)]
struct RelationEdge {
    #[serde(rename = "relationType", default)]
    relation_type: String,
    node: RelationNode,
}

#[derive(Deserialize, Debug)]
struct RelationsPayload {
    #[serde(default)]
    edges: Vec<RelationEdge>,
}

#[derive(Deserialize, Debug)]
struct RelationsMedia {
    #[serde(default)]
    relations: Option<RelationsPayload>,
}

#[derive(Deserialize, Debug)]
struct RelationsResponse {
    #[serde(rename = "Media")]
    media: Option<RelationsMedia>,
}

async fn search_anilist(token: &str, title: &str) -> Result<Vec<MediaInfo>, AnilistError> {
    let resp: SearchResponse =
        graphql_post(token, SEARCH_QUERY, serde_json::json!({ "search": title })).await?;
    Ok(resp.page.media)
}

async fn fetch_media(token: &str, anilist_id: u64) -> Result<MediaInfo, AnilistError> {
    let resp: MediaResponse =
        graphql_post(token, MEDIA_QUERY, serde_json::json!({ "mediaId": anilist_id as i64 })).await?;
    resp.media.ok_or(AnilistError::NotFound)
}

/// Fetch the SEQUEL relation edges from a Media. Returns the bare
/// nodes (not full MediaInfo) — the caller traverses to a target
/// hop and only fetches full Media for the final pick.
async fn fetch_sequel_node(token: &str, anilist_id: u64) -> Result<Option<RelationNode>, AnilistError> {
    let resp: RelationsResponse = graphql_post(
        token,
        RELATIONS_QUERY,
        serde_json::json!({ "mediaId": anilist_id as i64 }),
    )
    .await?;
    let edges = resp
        .media
        .and_then(|m| m.relations)
        .map(|r| r.edges)
        .unwrap_or_default();
    Ok(edges.into_iter().find(|e| e.relation_type == "SEQUEL").map(|e| e.node))
}

/// Walk N SEQUEL hops from `start_id`, returning a fully-populated
/// MediaInfo for the destination. Returns Ok(None) when the chain
/// runs out (no SEQUEL edge) before reaching the target hop, or when
/// the destination Media fails the plausible-target check (e.g. the
/// chosen sequel is NOT_YET_RELEASED — the user can't be watching
/// episode N of an unaired entry).
async fn walk_sequel_chain(
    token: &str,
    start_id: u64,
    hops: u32,
    episode_num: u32,
) -> Result<Option<MediaInfo>, AnilistError> {
    if hops == 0 {
        return Ok(None);
    }
    let mut current_id = start_id;
    for hop in 0..hops {
        let next = match fetch_sequel_node(token, current_id).await {
            Ok(Some(n)) => n,
            Ok(None) => {
                crate::devlog!(
                    info, "scrobble",
                    "AniList SEQUEL walk: chain ended at id={current_id} after {} hop(s); needed {hops}",
                    hop,
                );
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        current_id = next.id;
        // Reject branches that point at an unaired entry while the
        // user is requesting concrete progress — same wrong-mapping
        // signal the id-map / cache resolvers use. Without this an
        // S2→S3 walk could land on a NOT_YET_RELEASED S3 row and
        // silently save progress to the wrong cour again.
        if next.status.as_deref() == Some("NOT_YET_RELEASED") && episode_num > 0 {
            crate::devlog!(
                info, "scrobble",
                "AniList SEQUEL walk: hop {} landed on id={} (NOT_YET_RELEASED); abandoning chain",
                hop + 1, current_id,
            );
            return Ok(None);
        }
    }
    let final_media = fetch_media(token, current_id).await?;
    if is_plausible_target(&final_media, episode_num) {
        Ok(Some(final_media))
    } else {
        crate::devlog!(
            info, "scrobble",
            "AniList SEQUEL walk: final hop id={} rejected (eps={:?} status={:?} ep_num={episode_num})",
            final_media.id, final_media.episodes, final_media.status,
        );
        Ok(None)
    }
}

async fn save_media_list_entry(
    token:    &str,
    media_id: u64,
    progress: u32,
    status:   &str,
) -> Result<(), AnilistError> {
    let _: SaveResponse = graphql_post(
        token,
        SAVE_MUTATION,
        serde_json::json!({
            "mediaId":  media_id as i64,
            "progress": progress as i64,
            "status":   status,
        }),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Session id parsing
// ---------------------------------------------------------------------------

/// Anime-provider prefixes that yuna.moe's relations API maps to a
/// canonical AniList id. Keep this aligned with the
/// `match source.to_lowercase()` arms in `aniskip::resolve_mal_id`.
const ANIME_PREFIXES: &[&str] = &["kitsu", "mal", "anilist", "anidb"];

/// Pull the show root from a session id.
///
/// Accepted shapes (in priority order):
///   • `tt0903747`              → `Some("tt0903747")` (IMDb movie)
///   • `tt0903747:1:5`          → `Some("tt0903747")` (IMDb episode)
///   • `kitsu:46474`            → `Some("kitsu:46474")` (anime prefix show)
///   • `kitsu:46474:5`          → `Some("kitsu:46474")` (anime prefix ep)
///   • same for mal / anilist / anidb prefixes
///
/// The anime-prefix branch returns the `<provider>:<id>` slice so the
/// caller has the provider tag for routing — IMDb roots go through the
/// Fribb id-map cour-aware path, anime-prefix roots route through
/// yuna.moe's exact-mapping API (no fuzzy season heuristic needed
/// because AIOMetadata has already encoded the cour-specific provider
/// id).
fn parse_show_id(id: &str) -> Option<&str> {
    let parts: Vec<&str> = id.split(':').collect();
    match parts.as_slice() {
        [first] if first.starts_with("tt") => Some(*first),
        [first, _, _] if first.starts_with("tt") => Some(*first),
        // `kitsu:46474` (2-segment, no episode) — returns whole id.
        [first, _] if ANIME_PREFIXES.contains(&first.to_lowercase().as_str()) => {
            Some(id)
        }
        // `kitsu:46474:5` — slice off the trailing `:<episode>`.
        [first, _, _] if ANIME_PREFIXES.contains(&first.to_lowercase().as_str()) => {
            id.match_indices(':').nth(1).map(|(i, _)| &id[..i])
        }
        _ => None,
    }
}

/// Did `parse_show_id` return an anime-provider root (vs an IMDb root)?
fn is_anime_prefix_root(show_id: &str) -> bool {
    let Some((provider, _)) = show_id.split_once(':') else { return false; };
    ANIME_PREFIXES.contains(&provider.to_lowercase().as_str())
}

/// Resolve an anime-provider show id to an AniList media id via
/// yuna.moe's relations API. Returns the bare AniList id directly
/// when the provider is already `anilist:N`. For other prefixes, hits
/// `https://relations.yuna.moe/api/ids` and pulls the `anilist`
/// field out of the response.
///
/// Errors / no-match cases (network failure, unrecognised provider,
/// no AniList counterpart) return Ok(None). Callers fall back to the
/// title-search path.
async fn resolve_anilist_id_for_anime_prefix(show_id: &str) -> Result<Option<u64>, String> {
    let Some((source_raw, id_str)) = show_id.split_once(':') else {
        return Ok(None);
    };
    let source = source_raw.to_lowercase();
    let id: u32 = id_str.parse().map_err(|e| format!("bad anime prefix id: {e}"))?;
    if source == "anilist" {
        return Ok(Some(id as u64));
    }
    let api_source = match source.as_str() {
        "kitsu" | "mal" | "anidb" => source.as_str(),
        _ => return Ok(None),
    };
    #[derive(serde::Deserialize)]
    struct YunaResponse {
        #[serde(default)]
        anilist: Option<serde_json::Value>,
    }
    let url = format!("https://relations.yuna.moe/api/ids?source={api_source}&id={id}");
    let cli = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .https_only(true)
        .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anilist-resolve"))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = match cli.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "yuna.moe lookup failed for {source}={id}: {e}");
            return Ok(None);
        }
    };
    if !resp.status().is_success() {
        crate::devlog!(
            warn, "scrobble",
            "yuna.moe HTTP {} for {source}={id}", resp.status().as_u16(),
        );
        return Ok(None);
    }
    let parsed: YunaResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "yuna.moe JSON parse error: {e}");
            return Ok(None);
        }
    };
    let anilist_id = parsed.anilist
        .and_then(|v| v.as_u64())
        .or_else(|| parsed_anilist_string());
    Ok(anilist_id)
}

/// Stub for the rare `anilist` field-as-string case. Kept separate so
/// the parsing path stays explicit; yuna.moe currently always returns
/// the field as a number when present.
fn parsed_anilist_string() -> Option<u64> { None }

/// Parse the episode number from the session id. Movies always return 1
/// (AniList treats movies as 1-episode anime). Series ids
/// `<show>:<season>:<episode>` return the trailing episode component.
/// Anything else returns None and the caller should skip.
fn parse_episode_num(id: &str, media_type: &str) -> Option<u32> {
    if media_type == "movie" {
        return Some(1);
    }
    let parts: Vec<&str> = id.split(':').collect();
    match parts.as_slice() {
        [_, _, e] => e.parse().ok(),
        _ => None,
    }
}

/// Parse the season number from the session id (`<show>:<season>:<ep>`).
/// Used to pick the season-specific AniList entry for multi-cour anime
/// — AIOMetadata's split-season patch encodes the cour into this slot,
/// and that's a more reliable cour signal than the frontend
/// VideoEntry's `season` field (which can carry the library's merged
/// shape for shows that Stremio collapses to "season 1, 35 episodes").
fn parse_season_num(id: &str, media_type: &str) -> Option<u32> {
    if media_type == "movie" {
        return None;
    }
    let parts: Vec<&str> = id.split(':').collect();
    match parts.as_slice() {
        [_, s, _] => s.parse().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Resolution helper extracted from the inline cache-or-search match in
/// `save_progress` so the new id-map path can fall through cleanly when
/// its fetch_media returns NotFound or the wrong-season heuristic miss.
/// Mirrors the legacy three-branch cache/search behaviour exactly.
/// True when a Media we just fetched is plausibly the user's
/// target — episode count accommodates the requested episode AND
/// the show is actually airing (or finished). A
/// `NOT_YET_RELEASED` entry hit while requesting progress > 0 is
/// almost always a Fribb id-map mis-mapping (an unaired cour ends
/// up at an earlier cour's index, e.g. Frieren tt22248376 season=2
/// pointing at "Sousou no Frieren 3rd Season"). Rejecting it
/// pushes the resolver to fall through to the title-search path.
fn is_plausible_target(m: &MediaInfo, episode_num: u32) -> bool {
    let episode_ok = m.episodes.map(|e| e >= episode_num).unwrap_or(true);
    let status_ok  = m.status.as_deref() != Some("NOT_YET_RELEASED") || episode_num == 0;
    episode_ok && status_ok
}

async fn resolve_via_cache_or_search(
    access: &str,
    cached: &Option<CachedMedia>,
    title: &str,
    show_id: &str,
    episode_num: u32,
    season: Option<u32>,
) -> Result<MediaInfo, AnilistError> {
    match cached {
        Some(c) if c.episodes.map(|e| e >= episode_num).unwrap_or(true) => {
            crate::devlog!(
                info, "scrobble",
                "AniList cache hit: show={} → anilist_id={} (episodes={:?})",
                show_id, c.anilist_id, c.episodes,
            );
            match fetch_media(access, c.anilist_id).await {
                Ok(m) if is_plausible_target(&m, episode_num) => Ok(m),
                Ok(m) => {
                    // Cached id resolves to an entry that can't be
                    // what the user is watching (most often a
                    // NOT_YET_RELEASED cour the prior version cached
                    // before the wrong-mapping guard existed). Drop
                    // it from cache so subsequent runs don't keep
                    // hitting the same dead end, then search.
                    let reason = if m.status.as_deref() == Some("NOT_YET_RELEASED") {
                        "status=NOT_YET_RELEASED"
                    } else {
                        "episodes insufficient"
                    };
                    crate::devlog!(
                        warn, "scrobble",
                        "AniList cached id {} rejected ({reason}) for ep {episode_num} — \
                         invalidating cache row and re-searching for \"{title}\"",
                        c.anilist_id,
                    );
                    if let Ok(mut g) = cache_lock().lock() {
                        // Walk every key that points at this anilist_id
                        // and remove. We don't have the cache_key here
                        // (intentional — keeps this helper reusable);
                        // a tiny value-scan is fine since the map is
                        // small (one entry per (show, cour) pair).
                        g.by_show.retain(|_, v| v.anilist_id != c.anilist_id);
                    }
                    search_and_pick(access, title, episode_num, season).await
                }
                Err(AnilistError::NotFound) => {
                    crate::devlog!(
                        warn, "scrobble",
                        "AniList cached id {} returned NotFound — falling back to title search for \"{}\"",
                        c.anilist_id, title,
                    );
                    search_and_pick(access, title, episode_num, season).await
                }
                Err(e) => Err(e),
            }
        }
        Some(c) => {
            crate::devlog!(
                info, "scrobble",
                "AniList cache inconsistent: cached episodes={:?} < requested ep={} — re-searching",
                c.episodes, episode_num,
            );
            search_and_pick(access, title, episode_num, season).await
        }
        None => {
            crate::devlog!(
                info, "scrobble",
                "AniList cache miss for show={} — searching by title \"{}\"",
                show_id, title,
            );
            search_and_pick(access, title, episode_num, season).await
        }
    }
}

/// Save scrobble progress to AniList for the given session. No-op when:
///   * `sess.is_anime` is false
///   * No AniList token is stored for `scope`
///   * Session id can't be parsed (non-IMDB shape)
///   * Existing progress on AniList is already >= our episode
///
/// Best-effort. Errors are returned so the caller can clear tokens on
/// Unauthorized; everything else is a "log and move on" outcome.
pub async fn save_progress<R: Runtime>(
    app:   &AppHandle<R>,
    scope: &str,
    sess:  &ScrobbleSession,
) -> Result<(), AnilistError> {
    if !sess.is_anime {
        return Ok(());
    }
    let Some(token_obj) = scrobble_auth::read_token_for("anilist", scope) else {
        return Ok(());
    };
    let access = token_obj.access_token;

    let Some(show_id) = parse_show_id(&sess.imdb_id) else {
        crate::devlog!(
            info, "scrobble",
            "AniList: skipping non-IMDB session id ({})",
            sess.imdb_id,
        );
        return Ok(());
    };
    let Some(parsed_episode) = parse_episode_num(&sess.imdb_id, &sess.media_type) else {
        return Ok(());
    };
    // Prefer the VideoEntry-authoritative absolute episode number (set
    // by App.tsx from active.episode_num) over the id-string's trailing
    // segment. After AIOMetadata's split-season patch, the id encodes
    // cour-relative episodes (e.g. `tt…:2:6` for absolute ep 34); but
    // AniList for most multi-cour anime has a SINGLE entry covering all
    // cours with a flat 1..N episode list, so sending the cour-relative
    // value (6) silently misaligns with whatever AniList has (where 6
    // is cour 1 ep 6, not cour 2 ep 6).
    //
    // Fallback to the id-parse when sess.episode_num is missing — that
    // path covers movies and older addons whose VideoEntry doesn't
    // populate the field.
    let episode_num: u32 = sess.episode_num.unwrap_or(parsed_episode);

    // Prefer the id-string season over sess.season for multi-cour
    // lookup. After AIOMetadata's split-season patch, `tt…:N:M` carries
    // the authoritative cour index in N. The VideoEntry-side
    // `sess.season` lags for shows Stremio renders as "season 1, all
    // episodes" — we'd pick the wrong AniList entry every time. Fall
    // back to sess.season only when the id slot is missing.
    let id_season = parse_season_num(&sess.imdb_id, &sess.media_type);
    let lookup_season = id_season.or(sess.season);

    crate::devlog!(
        info, "scrobble",
        "AniList resolve: show=\"{}\" id={} episode_num={} \
         (id_season={:?} sess.season={:?} → lookup_season={:?}; sess.episode_num={:?})",
        sess.title, show_id, episode_num,
        id_season, sess.season, lookup_season, sess.episode_num,
    );

    // 0. Resolve the AniList id. Two paths:
    //    a) Anime-provider prefix (`kitsu:46474`, `mal:N`, `anilist:N`,
    //       `anidb:N`) — yuna.moe direct mapping. Exact, no fuzzy
    //       heuristic; AIOMetadata has already encoded the cour-
    //       specific provider id so we don't need Fribb's season index.
    //       `anilist:N` is even shorter: N IS the anilist id.
    //    b) IMDb (`ttN`) — Fribb/anime-lists id-map with the
    //       `season - 1` heuristic for multi-cour anime. Falls back to
    //       title search down-stream when the heuristic misses.
    let id_map_anilist_id = if is_anime_prefix_root(show_id) {
        match resolve_anilist_id_for_anime_prefix(show_id).await {
            Ok(Some(id)) => {
                crate::devlog!(
                    info, "scrobble",
                    "AniList anime-prefix resolved: show={} → anilist_id={}",
                    show_id, id,
                );
                Some(id)
            }
            Ok(None) => {
                crate::devlog!(
                    info, "scrobble",
                    "AniList anime-prefix lookup yielded no anilist id for {show_id} — falling through to title search",
                );
                None
            }
            Err(e) => {
                crate::devlog!(warn, "scrobble", "anime-prefix resolve error: {e}");
                None
            }
        }
    } else {
        let id = crate::anime_id_map::lookup(show_id, lookup_season);
        if let Some(anilist_id) = id {
            crate::devlog!(
                info, "scrobble",
                "AniList id-map hit: show={} → anilist_id={} (skipping title search)",
                show_id, anilist_id,
            );
        }
        id
    };

    // 1. Cache lookup. Keyed by show + season so multi-cour anime
    // (Frieren, Demon Slayer, Mushoku Tensei …) doesn't ping-pong a
    // single show_id slot between cours' anilist_ids on alternating
    // saves. Movies and single-cour shows fall back to season=0, which
    // gives them a stable single key just like before.
    let cache_key = format!("{}:{}", show_id, lookup_season.unwrap_or(0));
    let cached_raw = cache_lock()
        .lock()
        .ok()
        .and_then(|g| g.by_show.get(&cache_key).cloned());
    // Multi-cour cache rows written by a pre-v1 Aura mapped many
    // season > 1 keys to the franchise root's anilist_id (the
    // popularity-search winner before the SEQUEL walk landed). Treat
    // those as misses so a single re-resolve corrects the mapping;
    // season-1 / movie rows aren't affected because v0's behaviour
    // was correct for them.
    let cached = cached_raw.clone().filter(|c| {
        let multi_cour = lookup_season.map(|s| s > 1).unwrap_or(false);
        let fresh = c.resolver_version >= CURRENT_CACHE_VERSION;
        !multi_cour || fresh
    });
    if cached_raw.is_some() && cached.is_none() {
        crate::devlog!(
            info, "scrobble",
            "AniList cache: invalidating stale pre-v{CURRENT_CACHE_VERSION} multi-cour entry \
             for {cache_key} so the SEQUEL-walk path can re-resolve the correct cour",
        );
    }

    // Resolve to an AniList MediaInfo. Four layered strategies, each
    // surfacing a clear log line so the DevConsole shows which path
    // produced the result (or NotFound) without the user having to
    // re-instrument the binary.
    //
    //   • ID-map hit → fetch_media against the Fribb-mapped anilist_id.
    //     On NotFound (rare; stale Fribb data), fall through to cache /
    //     search same as the cached-but-stale path.
    //   • Cached + consistent → fetch_media on the cached id. NotFound
    //     here falls back to search (stale on-disk cache).
    //   • Cached + inconsistent → re-search (the cached entry doesn't
    //     have enough episodes for our ep number).
    //   • Uncached → search.
    let media = if let Some(id_anilist) = id_map_anilist_id {
        match fetch_media(&access, id_anilist).await {
            Ok(m) if is_plausible_target(&m, episode_num) => m,
            Ok(m) => {
                let reason = if m.status.as_deref() == Some("NOT_YET_RELEASED") {
                    "status=NOT_YET_RELEASED while episode_num>0 (Fribb row mis-mapped to unaired cour)"
                } else {
                    "episodes insufficient for the requested episode"
                };
                crate::devlog!(
                    info, "scrobble",
                    "AniList id-map entry {id_anilist} rejected ({reason}) for ep {episode_num} \
                     — falling through to cache/search (multi-season heuristic miss)",
                );
                resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num, lookup_season).await?
            }
            Err(AnilistError::NotFound) => {
                crate::devlog!(
                    warn, "scrobble",
                    "AniList id-map entry {id_anilist} returned NotFound — falling through to cache/search",
                );
                resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num, lookup_season).await?
            }
            Err(e) => return Err(e),
        }
    } else {
        resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num, lookup_season).await?
    };

    crate::devlog!(
        info, "scrobble",
        "AniList resolved: show={} → anilist_id={} (episodes={:?}, current_list_progress={:?})",
        show_id, media.id, media.episodes,
        media.media_list_entry.as_ref().map(|e| e.progress),
    );

    // 2. Persist mapping (write-through cache). Use the same composite
    // key as the read above so multi-cour shows store one entry per
    // cour.
    let needs_persist = cached.as_ref().map(|c| c.anilist_id) != Some(media.id);
    if needs_persist {
        if let Ok(mut g) = cache_lock().lock() {
            g.by_show.insert(
                cache_key.clone(),
                CachedMedia {
                    anilist_id:       media.id,
                    episodes:         media.episodes,
                    fetched_at:       now_secs(),
                    resolver_version: CURRENT_CACHE_VERSION,
                },
            );
            save_cache(app, &g);
        }
    }

    // 3. Clamp the candidate to the entry's total. The candidate
    //    (`episode_num`) is the user's absolute ep number; for split-
    //    cour anime the chosen anilist_id may only cover a slice of
    //    the absolute range. AniList rejects `progress > episodes`, so
    //    clamping turns "user watched ep 34 of a 28-ep entry" into
    //    "save 28 + mark COMPLETED" — the right semantic for someone
    //    who's finished what AniList tracks under this id.
    let to_save = match media.episodes {
        Some(total) if episode_num > total => total,
        _ => episode_num,
    };

    // 4. Don't clobber user-tracked progress that's ahead of us.
    //    Compare against the clamped value — otherwise a user on ep 34
    //    of a 28-ep entry with list_progress=20 would get skipped
    //    forever (34 > 20 passes, but the save would write 28 since
    //    clamp also applies on write).
    let existing = media
        .media_list_entry
        .as_ref()
        .map(|e| e.progress)
        .unwrap_or(0);
    if existing >= to_save {
        crate::devlog!(
            info, "scrobble",
            "AniList: progress already {existing} (>= clamped {to_save}, raw episode={episode_num}); skipping save",
        );
        return Ok(());
    }

    // 5. Status: COMPLETED if we know the total and we're at or past it.
    let status = match media.episodes {
        Some(total) if to_save >= total => "COMPLETED",
        _ => "CURRENT",
    };

    // 6. Save.
    save_media_list_entry(&access, media.id, to_save, status).await?;

    let total_str = media.episodes.map(|e| e.to_string()).unwrap_or_else(|| "?".into());
    crate::devlog!(
        info, "scrobble",
        "AniList: saved {}/{} ({}) for \"{}\" (anilist_id={}, raw episode={episode_num})",
        to_save, total_str, status, sess.title, media.id,
    );
    Ok(())
}

/// Run the search query and pick the best candidate. Prefers entries
/// whose total episode count is >= the user's current episode (filters
/// out single-cour seasons when the user is on episode 24+ of a long
/// runner). Falls back to the first result if no candidate clears that
/// bar — better to attempt a save than return NotFound for matches the
/// search did rank.
/// Generate progressively more permissive search variants from a title.
/// AniList's search algorithm is sensitive to punctuation in ways that
/// real-world titles trip over — "Frieren: Beyond Journey's End" returns
/// zero candidates while "Frieren" returns the show as the top hit. We
/// try the original first (best precision), then strip punctuation, then
/// fall back to the first clause before a delimiter, then the first
/// word. Dedupes so we never re-query AniList with the same string.
///
/// Order matters: less-specific variants risk matching the wrong show
/// (a one-word query like "Sword" could resolve to half a dozen distinct
/// anime). We accept that risk only after more-specific variants have
/// genuinely failed.
fn title_search_variants(title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push_unique = |s: String| {
        let trimmed = s.trim();
        if trimmed.is_empty() { return; }
        if out.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed)) { return; }
        out.push(trimmed.to_string());
    };

    push_unique(title.to_string());

    // Strip ASCII + curly punctuation. Keep alphanumerics, spaces, and
    // non-Latin scripts (so a Japanese title stays usable).
    let stripped: String = title
        .chars()
        .map(|c| match c {
            ':' | ';' | ',' | '.' | '!' | '?' | '–' | '—' | '-'
            | '\'' | '"' | '`' | '’' | '‘' | '“' | '”'
            | '(' | ')' | '[' | ']' | '{' | '}' => ' ',
            _ => c,
        })
        .collect();
    let stripped_normalized = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    push_unique(stripped_normalized);

    // First clause — text before the first `:`, `–`, `—`, ` - `, or `(`.
    // Many anime sequel titles read "{Show}: {Subtitle}" or
    // "{Show} - Season 2"; the lead clause is usually the canonical
    // searchable form.
    for delim in [':', '–', '—', '('] {
        if let Some(idx) = title.find(delim) {
            push_unique(title[..idx].to_string());
            break;
        }
    }
    if let Some(idx) = title.find(" - ") {
        push_unique(title[..idx].to_string());
    }

    // Final fallback — the first word. Most useful for one-name brands
    // (Frieren, Naruto, Bleach) where the franchise IS the show on
    // AniList's catalogue. Risks false-matching for generic words but
    // only fires when nothing else found anything.
    if let Some(first_word) = title.split_whitespace().next() {
        push_unique(first_word.to_string());
    }

    out
}

async fn search_and_pick(
    token:       &str,
    title:       &str,
    episode_num: u32,
    season:      Option<u32>,
) -> Result<MediaInfo, AnilistError> {
    let variants = title_search_variants(title);
    for (i, variant) in variants.iter().enumerate() {
        let candidates = search_anilist(token, variant).await?;
        if candidates.is_empty() {
            crate::devlog!(
                info, "scrobble",
                "AniList search variant {}/{}: \"{}\" → 0 candidates",
                i + 1, variants.len(), variant,
            );
            continue;
        }
        crate::devlog!(
            info, "scrobble",
            "AniList search variant {}/{}: \"{}\" → {} candidate(s): [{}]",
            i + 1, variants.len(), variant, candidates.len(),
            candidates.iter()
                .map(|m| format!("id={} eps={:?}", m.id, m.episodes))
                .collect::<Vec<_>>()
                .join(", "),
        );
        // Pick the first plausible candidate as the franchise root.
        // For season=1 (or unspecified) this IS the answer; for
        // season>1 it's the starting point of a SEQUEL walk.
        // Note we deliberately ignore `episodes >= episode_num` when
        // `season > 1` — the popular S1 row's episode count
        // (typically 24-28) coincidentally also satisfies a cour-2
        // ep number like 10, which used to make us pick S1 and save
        // Frieren S02E10's progress against S01.
        let base_pick = candidates
            .iter()
            .find(|m| m.episodes.map(|e| e >= episode_num).unwrap_or(true))
            .or_else(|| candidates.first())
            .cloned();
        let Some(base) = base_pick else { continue; };

        // Season-aware walk. When the user is watching season N>1,
        // AniList typically links seasons via SEQUEL relations from
        // the franchise root, so (season-1) hops lands on the cour
        // the user is actually watching. Falls back to the base
        // candidate on any walk failure (chain stops short, sequel
        // is unaired, network error) so we never regress past the
        // prior behaviour.
        if let Some(target_season) = season.filter(|&s| s > 1) {
            let hops = target_season - 1;
            match walk_sequel_chain(token, base.id, hops, episode_num).await {
                Ok(Some(seq)) => {
                    crate::devlog!(
                        info, "scrobble",
                        "AniList SEQUEL walk: base id={} → season {} id={} ({} hop(s), eps={:?})",
                        base.id, target_season, seq.id, hops, seq.episodes,
                    );
                    return Ok(seq);
                }
                Ok(None) => {
                    crate::devlog!(
                        info, "scrobble",
                        "AniList SEQUEL walk: no plausible season-{target_season} sequel of id={} — falling back to base",
                        base.id,
                    );
                }
                Err(e) => {
                    crate::devlog!(
                        warn, "scrobble",
                        "AniList SEQUEL walk error: {e}; falling back to base id={}", base.id,
                    );
                }
            }
        }

        return Ok(base);
    }
    crate::devlog!(
        warn, "scrobble",
        "AniList search exhausted {} variant(s) for title=\"{}\" — returning NotFound",
        variants.len(), title,
    );
    Err(AnilistError::NotFound)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
