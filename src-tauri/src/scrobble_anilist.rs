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
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anilist"))
            .build()
            .expect("AniList HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Persistent ID cache (title → AniList id, keyed by IMDB show id)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedMedia {
    anilist_id: u64,
    episodes:   Option<u32>,
    fetched_at: u64,
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
      title { romaji english native }
      mediaListEntry { id status progress }
    }
  }
}
";

const MEDIA_QUERY: &str = "
query ($mediaId: Int) {
  Media(id: $mediaId, type: ANIME) {
    id idMal episodes
    mediaListEntry { id status progress }
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

/// Pull the show root from `tt0903747:1:5` → `Some("tt0903747")`. Movies
/// (`tt0111161`) return themselves. Anything not IMDB-shaped returns None.
fn parse_show_id(id: &str) -> Option<&str> {
    let first = id.split(':').next()?;
    if first.starts_with("tt") {
        Some(first)
    } else {
        None
    }
}

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

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Resolution helper extracted from the inline cache-or-search match in
/// `save_progress` so the new id-map path can fall through cleanly when
/// its fetch_media returns NotFound or the wrong-season heuristic miss.
/// Mirrors the legacy three-branch cache/search behaviour exactly.
async fn resolve_via_cache_or_search(
    access: &str,
    cached: &Option<CachedMedia>,
    title: &str,
    show_id: &str,
    episode_num: u32,
) -> Result<MediaInfo, AnilistError> {
    match cached {
        Some(c) if c.episodes.map(|e| e >= episode_num).unwrap_or(true) => {
            crate::devlog!(
                info, "scrobble",
                "AniList cache hit: show={} → anilist_id={} (episodes={:?})",
                show_id, c.anilist_id, c.episodes,
            );
            match fetch_media(access, c.anilist_id).await {
                Ok(m) => Ok(m),
                Err(AnilistError::NotFound) => {
                    crate::devlog!(
                        warn, "scrobble",
                        "AniList cached id {} returned NotFound — falling back to title search for \"{}\"",
                        c.anilist_id, title,
                    );
                    search_and_pick(access, title, episode_num).await
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
            search_and_pick(access, title, episode_num).await
        }
        None => {
            crate::devlog!(
                info, "scrobble",
                "AniList cache miss for show={} — searching by title \"{}\"",
                show_id, title,
            );
            search_and_pick(access, title, episode_num).await
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
    let Some(episode_num) = parse_episode_num(&sess.imdb_id, &sess.media_type) else {
        return Ok(());
    };

    crate::devlog!(
        info, "scrobble",
        "AniList resolve: show=\"{}\" id={} episode_num={} (sess.season={:?} sess.episode_num={:?})",
        sess.title, show_id, episode_num, sess.season, sess.episode_num,
    );

    // 0. Fribb/anime-lists ID-map fast path. Single hash lookup; no
    //    network round-trip. Skipped silently when the map is empty
    //    (uncached / niche show / map not warmed yet). When the show
    //    has multiple AniList ids (multi-season anime), the map's
    //    `season - 1` index heuristic picks the corresponding entry;
    //    if we still pick the wrong one (heuristic miss), the
    //    AniList `progress > episodes` guard down-stream rejects the
    //    save and the caller falls back through search-and-pick.
    let id_map_anilist_id = crate::anime_id_map::lookup(show_id, sess.season);
    if let Some(anilist_id) = id_map_anilist_id {
        crate::devlog!(
            info, "scrobble",
            "AniList id-map hit: show={} → anilist_id={} (skipping title search)",
            show_id, anilist_id,
        );
    }

    // 1. Cache lookup. Treat the cache as authoritative when its
    // episode count is consistent with what we're trying to save.
    let cached = cache_lock()
        .lock()
        .ok()
        .and_then(|g| g.by_show.get(show_id).cloned());

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
            Ok(m) if m.episodes.map(|e| e >= episode_num).unwrap_or(true) => m,
            Ok(_) => {
                // Wrong season picked by the heuristic — episode count
                // can't accommodate the requested episode. Drop through
                // to the cache / search path which has its own consistency
                // guards.
                crate::devlog!(
                    info, "scrobble",
                    "AniList id-map entry {id_anilist} has insufficient episodes for ep {episode_num} \
                     — falling through to cache/search (multi-season heuristic miss)",
                );
                resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num).await?
            }
            Err(AnilistError::NotFound) => {
                crate::devlog!(
                    warn, "scrobble",
                    "AniList id-map entry {id_anilist} returned NotFound — falling through to cache/search",
                );
                resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num).await?
            }
            Err(e) => return Err(e),
        }
    } else {
        resolve_via_cache_or_search(&access, &cached, &sess.title, show_id, episode_num).await?
    };

    crate::devlog!(
        info, "scrobble",
        "AniList resolved: show={} → anilist_id={} (episodes={:?}, current_list_progress={:?})",
        show_id, media.id, media.episodes,
        media.media_list_entry.as_ref().map(|e| e.progress),
    );

    // 2. Persist mapping (write-through cache).
    let needs_persist = cached.as_ref().map(|c| c.anilist_id) != Some(media.id);
    if needs_persist {
        if let Ok(mut g) = cache_lock().lock() {
            g.by_show.insert(
                show_id.to_string(),
                CachedMedia {
                    anilist_id: media.id,
                    episodes:   media.episodes,
                    fetched_at: now_secs(),
                },
            );
            save_cache(app, &g);
        }
    }

    // 3. Don't clobber user-tracked progress that's ahead of us.
    let existing = media
        .media_list_entry
        .as_ref()
        .map(|e| e.progress)
        .unwrap_or(0);
    if existing >= episode_num {
        crate::devlog!(
            info, "scrobble",
            "AniList: progress already {existing} (>= our {episode_num}); skipping save",
        );
        return Ok(());
    }

    // 4. Status: COMPLETED if we know the total and we're at or past it.
    let status = match media.episodes {
        Some(total) if episode_num >= total => "COMPLETED",
        _ => "CURRENT",
    };

    // 5. Save.
    save_media_list_entry(&access, media.id, episode_num, status).await?;

    let total_str = media.episodes.map(|e| e.to_string()).unwrap_or_else(|| "?".into());
    crate::devlog!(
        info, "scrobble",
        "AniList: saved {}/{} ({}) for \"{}\" (anilist_id={})",
        episode_num, total_str, status, sess.title, media.id,
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
        let pick = candidates
            .iter()
            .find(|m| m.episodes.map(|e| e >= episode_num).unwrap_or(true))
            .or_else(|| candidates.first())
            .cloned();
        if let Some(pick) = pick {
            return Ok(pick);
        }
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
