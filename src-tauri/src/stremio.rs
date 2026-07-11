// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::addons::{self, AddonEntry};
use crate::auth::SESSION_EXPIRED;

// ---------------------------------------------------------------------------
// HTTP clients
// ---------------------------------------------------------------------------

const TIMEOUT: Duration = Duration::from_secs(10);
const STREMIO_ACCOUNT_API: &str = "https://api.strem.io/api";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static ACCOUNT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

// Manifest cache — avoids redundant /manifest.json fetches that would
// otherwise fire on every home load, search, stream fetch, and subtitle
// fetch. AIOStreams and other self-hosted addons build their manifest
// dynamically (internal health checks per request) so repeated fetches
// show up as high-frequency status hits in their logs.
//
// `MANIFEST_TTL` (24 h) is the single cache window — entries inside it
// serve verbatim. Addon manifests describe long-lived capabilities
// (catalogs / resources / id prefixes); they change at the cadence of
// an addon redeploy, not per-request. Tolerating up to a day of
// staleness dramatically improves cold-launch responsiveness for users
// with several addons installed. The user-facing `Refresh` button
// (`refresh_addon_manifest`) explicitly drops the entry to force a
// fresh fetch when the user actually wants one.
//
// Disk persistence: the in-memory map is mirrored to
// `app_data_dir/manifest-cache.json` on every successful insert
// (synchronous JSON write through a temp-file + rename, ~10–50 ms).
// At app boot, [`init_manifest_cache_path`] is called from lib.rs
// setup with the data-dir path; that function also reads the file once
// and populates memory with any entry still inside `MANIFEST_TTL`.
static MANIFEST_CACHE: OnceLock<Mutex<HashMap<String, ManifestCacheEntry>>> = OnceLock::new();
const MANIFEST_TTL: Duration = Duration::from_secs(86_400); // 24h

/// On-disk cache file path. Set once at boot by [`init_manifest_cache_path`].
/// When absent (test runs / pre-setup callers), disk persistence is a
/// no-op and the cache behaves exactly as the prior in-memory-only version.
static MANIFEST_CACHE_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Wire format version for the on-disk manifest cache. Bump on any
/// breaking change to `WireManifest` / `WireCatalogEntry` so a stale
/// file from an older Aura build is dropped instead of misparsed.
const MANIFEST_CACHE_FILE_VERSION: u32 = 1;

#[derive(Clone)]
struct ManifestCacheEntry {
    wire:       WireManifest,
    has_search: bool,
    /// SystemTime so the entry can serialise to / deserialise from the
    /// disk cache via Unix-epoch seconds. Compared via
    /// `SystemTime::now().duration_since(cached_at)` — a clock that
    /// goes backwards (`Err`) treats the entry as infinitely old, so
    /// the next fetch revalidates.
    cached_at:  SystemTime,
}

fn manifest_cache() -> &'static Mutex<HashMap<String, ManifestCacheEntry>> {
    MANIFEST_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// On-disk cache record. Owned `WireManifest` so the file is
/// self-contained and decoupled from any one Aura process.
#[derive(Deserialize, Serialize)]
struct ManifestCacheDiskEntry {
    wire: WireManifest,
    has_search: bool,
    /// Unix-epoch seconds at the moment of caching.
    cached_at_unix: i64,
}

#[derive(Deserialize, Serialize)]
struct ManifestCacheDiskFile {
    version: u32,
    entries: HashMap<String, ManifestCacheDiskEntry>,
}

/// Set the on-disk manifest cache file path and warm the in-memory map
/// from it. Called from lib.rs setup once the Tauri app data directory
/// is known. Safe to call more than once (subsequent calls are no-ops).
///
/// Disk-side errors are logged at `warn` and never propagated — a
/// missing / corrupt / unreadable file simply means we start with an
/// empty cache, identical to the pre-persistence behaviour.
pub fn init_manifest_cache_path(path: PathBuf) {
    if MANIFEST_CACHE_PATH.set(path.clone()).is_err() {
        return; // already initialised; second call is a no-op
    }
    if !path.exists() {
        crate::devlog!(
            info, "catalog",
            "manifest cache: no disk file yet (cold start)",
        );
        return;
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(
                warn, "catalog",
                "manifest cache: read failed ({e}); starting with empty cache",
            );
            return;
        }
    };
    let parsed: ManifestCacheDiskFile = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            crate::devlog!(
                warn, "catalog",
                "manifest cache: parse failed ({e}); starting with empty cache",
            );
            return;
        }
    };
    if parsed.version != MANIFEST_CACHE_FILE_VERSION {
        crate::devlog!(
            info, "catalog",
            "manifest cache: file version {} doesn't match expected {} — discarding",
            parsed.version, MANIFEST_CACHE_FILE_VERSION,
        );
        return;
    }
    let now = SystemTime::now();
    let mut loaded = 0usize;
    let mut dropped_stale = 0usize;
    let mut cache = manifest_cache().lock().unwrap();
    for (url, disk) in parsed.entries {
        let cached_at = match u64::try_from(disk.cached_at_unix) {
            Ok(secs) => UNIX_EPOCH + Duration::from_secs(secs),
            Err(_) => continue, // negative timestamp = corrupt
        };
        match now.duration_since(cached_at) {
            Ok(age) if age <= MANIFEST_TTL => {
                cache.insert(url, ManifestCacheEntry {
                    wire: disk.wire,
                    has_search: disk.has_search,
                    cached_at,
                });
                loaded += 1;
            }
            _ => dropped_stale += 1,
        }
    }
    drop(cache);
    crate::devlog!(
        info, "catalog",
        "manifest cache: warmed from disk ({loaded} entry/entries, {dropped_stale} dropped as stale)",
    );
}

/// Persist the current in-memory manifest cache to the configured disk
/// path. No-op when [`init_manifest_cache_path`] hasn't been called.
/// Errors are logged but never propagated — disk persistence is an
/// optimisation, not a correctness requirement.
fn save_manifest_cache_to_disk() {
    let Some(path) = MANIFEST_CACHE_PATH.get() else { return; };
    // Snapshot under the lock; do the file write outside it so a slow
    // I/O can't stall other fetches.
    let snapshot = {
        let cache = match manifest_cache().lock() {
            Ok(c) => c,
            Err(e) => {
                crate::devlog!(
                    warn, "catalog",
                    "manifest cache: poisoned on save: {e}",
                );
                return;
            }
        };
        let mut out: HashMap<String, ManifestCacheDiskEntry> =
            HashMap::with_capacity(cache.len());
        for (url, entry) in cache.iter() {
            let cached_at_unix = match entry.cached_at.duration_since(UNIX_EPOCH) {
                Ok(d) => d.as_secs() as i64,
                Err(_) => continue, // cached_at < UNIX_EPOCH — shouldn't happen
            };
            out.insert(url.clone(), ManifestCacheDiskEntry {
                wire: entry.wire.clone(),
                has_search: entry.has_search,
                cached_at_unix,
            });
        }
        out
    };
    let file = ManifestCacheDiskFile {
        version: MANIFEST_CACHE_FILE_VERSION,
        entries: snapshot,
    };
    let json = match serde_json::to_vec(&file) {
        Ok(b) => b,
        Err(e) => {
            crate::devlog!(
                warn, "catalog",
                "manifest cache: serialise failed: {e}",
            );
            return;
        }
    };
    // Ensure parent dir exists (Tauri's data dir is created on first
    // access — but if we somehow beat it, mkdir is a no-op when present).
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Atomic write: temp file + rename. Prevents a half-written cache
    // file from breaking the next launch's parse.
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, &json) {
        crate::devlog!(warn, "catalog", "manifest cache: tmp write failed: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        crate::devlog!(warn, "catalog", "manifest cache: rename failed: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}

// Per-CATALOG soft-fail cache.
//
// History: this used to be a per-ADDON cache that stamped the whole
// addon URL when ANY catalog failed. AIOMetadata has 34 catalogs, so
// a single slow `flixpatrol.aggregate.movie` request would poison the
// addon for 30 s — every other catalog (top, trending, mdblist,
// streaming.*) returned "addon in cooldown" instantly even though the
// addon itself was healthy. End-user view: the entire addon's rows
// disappeared from Home. The current shape keys the cache on
// (url, type, id) so a slow catalog only mutes ITSELF; the other 33
// keep serving normally.
//
// Stale-response fallback: when a catalog times out but we have a
// successful response cached within `CATALOG_STALE_TTL`, return that
// instead of an error. The user sees the previous payload — slightly
// out of date but vastly better than an empty row — and the cooldown
// still rate-limits retries upstream.
//
// Only TIMEOUT-class failures stamp the fail cache. HTTP errors
// (4xx / 5xx) are user-actionable (misconfigured catalog id, etc.)
// and shouldn't suppress retries.
static ADDON_FAIL_CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
const ADDON_FAIL_COOLDOWN: Duration = Duration::from_secs(30);

/// Successful-catalog-response cache. Same key shape as the fail cache
/// (`{url}|{type}/{id}`). 10-minute TTL: longer than the 5-minute
/// manifest cache because catalog ITEMS change less frequently than
/// the manifest's addon-id list, AND because the whole point is to
/// give the home page something to render when a refresh fails.
static CATALOG_OK_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<MetaPreview>)>>> =
    OnceLock::new();
const CATALOG_STALE_TTL: Duration = Duration::from_secs(600);

fn fail_key(base: &str, catalog_type: &str, catalog_id: &str) -> String {
    format!("{base}|{catalog_type}/{catalog_id}")
}

fn addon_fail_cache() -> &'static Mutex<HashMap<String, Instant>> {
    ADDON_FAIL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn catalog_ok_cache() -> &'static Mutex<HashMap<String, (Instant, Vec<MetaPreview>)>> {
    CATALOG_OK_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_catalog_soft_failed(base: &str, catalog_type: &str, catalog_id: &str) -> bool {
    let key = fail_key(base, catalog_type, catalog_id);
    let Ok(cache) = addon_fail_cache().lock() else { return false; };
    cache.get(&key)
        .map(|stamped| stamped.elapsed() < ADDON_FAIL_COOLDOWN)
        .unwrap_or(false)
}

fn mark_catalog_failed(base: &str, catalog_type: &str, catalog_id: &str) {
    let key = fail_key(base, catalog_type, catalog_id);
    if let Ok(mut cache) = addon_fail_cache().lock() {
        cache.retain(|_, t| t.elapsed() < ADDON_FAIL_COOLDOWN);
        cache.insert(key, Instant::now());
    }
}

/// Pull the last successful response if it's within the stale TTL.
/// Returned vec is cloned so we don't hold the cache lock across an
/// await.
fn cached_catalog_metas(
    base: &str,
    catalog_type: &str,
    catalog_id: &str,
) -> Option<Vec<MetaPreview>> {
    let key = fail_key(base, catalog_type, catalog_id);
    let cache = catalog_ok_cache().lock().ok()?;
    let (stamp, metas) = cache.get(&key)?;
    if stamp.elapsed() < CATALOG_STALE_TTL {
        Some(metas.clone())
    } else {
        None
    }
}

fn store_catalog_metas(
    base: &str,
    catalog_type: &str,
    catalog_id: &str,
    metas: &[MetaPreview],
) {
    if metas.is_empty() {
        return; // never cache an empty payload — that's a no-op
    }
    let key = fail_key(base, catalog_type, catalog_id);
    if let Ok(mut cache) = catalog_ok_cache().lock() {
        // Opportunistic eviction: drop entries past the stale TTL so the map
        // tracks the last-10-min working set instead of every catalog browsed
        // this session (stale entries are never served anyway). Bounds a
        // previously session-unbounded HashMap of ~100-item MetaPreview vecs.
        cache.retain(|_, (t, _)| t.elapsed() < CATALOG_STALE_TTL);
        cache.insert(key, (Instant::now(), metas.to_vec()));
    }
}

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            // Reclaim idle TLS/socket buffers between bursts — this client
            // fans out to many addon hosts, so the default (unbounded idle
            // per host) is the biggest pool tenant. 1 kept-warm conn per host
            // is enough for serial re-requests; concurrency is unaffected
            // (this caps IDLE retention, not in-flight connections).
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura/0.6.6")
            .build()
            .expect("HTTP client init failed")
    })
}

/// HTTPS-only client for the Stremio account API — same principle as auth.rs.
fn account_client() -> &'static reqwest::Client {
    ACCOUNT_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(15))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura/0.6.6")
            .build()
            .expect("Account HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Stremio wire types
// ---------------------------------------------------------------------------

#[derive(Clone, Deserialize, Serialize)]
struct WireManifest {
    /// Manifest-level `id` (stable across deployments of the same addon —
    /// e.g. "com.linvo.cinemeta"). Optional in deserialization for
    /// resilience against sloppy addons; defaults to "" when missing.
    #[serde(default)]
    id: String,
    name: String,
    catalogs: Vec<WireCatalogEntry>,
    #[serde(default)]
    resources: Vec<serde_json::Value>,
    #[serde(default)]
    types: Vec<String>,
    /// Optional id-prefix gate. When non-empty, the addon only handles
    /// requests whose id begins with one of these prefixes (canonical
    /// Stremio addon-spec field). Used by `fetch_streams` to skip
    /// addons that declare a stream resource for compatibility but
    /// don't actually serve the prefix the user is looking for —
    /// notably AI Search, which advertises stream + catalog but only
    /// returns results for its own AI-generated catalog ids.
    #[serde(default, rename = "idPrefixes")]
    id_prefixes: Vec<String>,
    /// Stremio `behaviorHints` — we only need `configurable` (does the
    /// addon host a `/configure` page?). `#[serde(default)]` tolerates a
    /// missing object; nested `#[serde(default)]` tolerates a missing
    /// `configurable` key.
    #[serde(default, rename = "behaviorHints")]
    behavior_hints: WireBehaviorHints,
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct WireBehaviorHints {
    #[serde(default)]
    configurable: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct WireCatalogEntry {
    #[serde(rename = "type")]
    media_type: String,
    id: String,
    name: Option<String>,
    #[serde(default)]
    extra: Vec<serde_json::Value>,
    /// AIOMetadata extension: explicit "Show on Home Board" toggle from
    /// the addon's configure UI. `Some(true)` = visible, `Some(false)` =
    /// hidden, `None` = field absent (other addons / older AIOMetadata
    /// builds — fall back to the `extra`-based heuristic in
    /// `catalog_is_hidden_from_home`).
    #[serde(default, rename = "showInHome")]
    show_in_home: Option<bool>,
}

#[derive(Deserialize)]
struct CatalogResponse {
    /// Raw per-meta values; deserialised one-by-one in `fetch_catalog`
    /// so a single malformed item doesn't poison the whole payload.
    /// AniList / MAL catalogs occasionally surface entries that fail the
    /// strict `id`/`type`/`name` requirement on `WireMeta` (numeric id
    /// types, missing fields, etc.) — pre-this-refactor that wiped the
    /// entire catalog with a top-level "error decoding response body".
    #[serde(default)]
    metas: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct WireMeta {
    /// Required. The Stremio addon spec mandates an id on every meta;
    /// we drop the row if it's missing or empty.
    id: String,
    /// Required by the spec, but some community addons (AniList /
    /// MAL-backed catalogs in particular) occasionally emit metas
    /// without a `type` field — we default to empty and let downstream
    /// resolve via id-prefix.
    #[serde(rename = "type", default)]
    media_type: String,
    /// Required by spec; default to empty so the catalog still renders
    /// the entry and downstream code can detect "no title" gracefully
    /// rather than wiping the whole payload.
    #[serde(default)]
    name: String,
    poster: Option<String>,
    background: Option<String>,
    /// Community/AIOMetadata field for hero/landscape art.
    fanart: Option<String>,
    /// Community/AIOMetadata field for alt landscape art.
    backdrop: Option<String>,
    logo: Option<String>,
    #[serde(rename = "releaseInfo")]
    release_info: Option<String>,
    description: Option<String>,
    #[serde(rename = "imdbRating")]
    imdb_rating: Option<String>,
    /// Optional genre list — drives the FilterBar genre chips.
    #[serde(default)]
    genres: Vec<String>,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct CatalogInfo {
    pub media_type: String,
    pub id: String,
    pub name: String,
    /// Catalog requires a search query to return any items — exclude from
    /// browseable home feeds.
    #[serde(default)]
    pub is_search_only: bool,
    /// Catalog has a required `extra` parameter (other than `search`) that
    /// has no `options` default — the addon can't return rows without a
    /// user-supplied input. AIOMetadata's "enabled but hidden from home"
    /// catalogs surface as this shape, as does Stremio's own convention
    /// for "Discover-only" catalogs (e.g. genre-keyed lists where you
    /// must pick a genre first). Filtered out of the home grid; still
    /// available via the Discover tab.
    #[serde(default)]
    pub is_hidden_from_home: bool,
}

#[derive(Serialize)]
pub struct AddonManifest {
    pub name: String,
    pub catalogs: Vec<CatalogInfo>,
    pub has_search: bool,
}

#[derive(Clone, Serialize)]
pub struct MetaPreview {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub fanart: Option<String>,
    pub backdrop: Option<String>,
    pub logo: Option<String>,
    pub release_info: Option<String>,
    pub description: Option<String>,
    pub imdb_rating: Option<String>,
    pub genres: Vec<String>,
}

/// One row in `MetaDetail.cast_detailed` / `producer_detailed`. Mirrors
/// the AIOMetadata `app_extras.cast` shape: a name plus optional
/// character/role string and headshot URL. Frontend renders name +
/// "as character" pairing inline and the photo on hover.
#[derive(Clone, Serialize)]
pub struct CastMember {
    pub name: String,
    pub character: Option<String>,
    pub photo: Option<String>,
}

/// One per-season credit ensemble — sourced from
/// `meta.app_extras.seasonCredits[<season>]` on TMDB / TVDB series.
/// Absent on movies and on MAL-meta anime. The frontend swaps the
/// detail page's cast block to this season's roster whenever the
/// selected season changes.
#[derive(Clone, Serialize, Default)]
pub struct SeasonCredits {
    pub name: Option<String>,
    pub overview: Option<String>,
    /// ISO date string (YYYY-MM-DD).
    pub air_date: Option<String>,
    pub poster: Option<String>,
    pub cast: Vec<CastMember>,
    pub crew: Vec<CrewMember>,
}

/// Crew entry — same shape as CastMember plus a `job` and optional
/// `department`. Sourced from `app_extras.seasonCredits[s].crew`.
#[derive(Clone, Serialize)]
pub struct CrewMember {
    pub name: String,
    pub job: String,
    pub department: Option<String>,
    pub photo: Option<String>,
}

/// Show-level credits with per-season episode counts — TMDB-only.
/// Used by the React-side hover overlay to classify each cast member
/// as Main / Recurring / Guest based on `total_episode_count` over
/// the show's total episode count.
#[derive(Clone, Serialize, Default)]
pub struct AggregateCredits {
    pub cast: Vec<AggCast>,
    pub crew: Vec<AggCrew>,
}

#[derive(Clone, Serialize)]
pub struct AggCast {
    pub name: String,
    pub character: Option<String>,
    pub photo: Option<String>,
    pub total_episode_count: u32,
    pub roles: Vec<RoleSpan>,
}

#[derive(Clone, Serialize)]
pub struct AggCrew {
    pub name: String,
    pub department: Option<String>,
    pub jobs: Vec<JobSpan>,
    pub total_episode_count: u32,
    pub photo: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct RoleSpan {
    pub character: String,
    pub episode_count: u32,
}

#[derive(Clone, Serialize)]
pub struct JobSpan {
    pub job: String,
    pub episode_count: u32,
}

#[derive(Clone, Serialize)]
pub struct MetaDetail {
    pub id: String,
    pub name: String,
    pub media_type: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub logo: Option<String>,
    pub description: Option<String>,
    pub release_info: Option<String>,
    /// Full release date (ISO-8601) for calendar grouping when available.
    pub released: Option<String>,
    pub runtime: Option<String>,
    pub imdb_rating: Option<String>,
    pub genres: Vec<String>,
    /// Cast names — capped to 20 entries, 64 chars each.
    pub cast: Vec<String>,
    /// Cast with character / role pairings + headshot URLs when the
    /// addon emits the rich shape. Sourced from
    /// `meta.app_extras.cast: [{ name, character, photo }]` (TMDB,
    /// TVDB, TVmaze, MAL anime). For Kitsu anime / older cached
    /// entries this is empty — UI falls back to `cast` (names only).
    /// Capped to 20 entries.
    pub cast_detailed: Vec<CastMember>,
    /// Directors — capped to 20 entries.
    pub director: Vec<String>,
    /// Writers / creators — capped to 20 entries.
    pub writer: Vec<String>,
    /// Producers — capped to 20 entries (AIOMetadata `producers`/`producer`).
    pub producer: Vec<String>,
    /// Producer character/role pairings — same shape as cast_detailed,
    /// populated from `app_extras.producers` on TVmaze series. Empty
    /// otherwise. Capped to 20 entries.
    pub producer_detailed: Vec<CastMember>,
    /// Music composers — capped to 20 entries (`composers`/`composer`/`music`).
    pub composer: Vec<String>,
    /// Show / story creators — capped to 20 entries (`creators`/`creator`).
    pub creator: Vec<String>,
    /// Voice actors — capped to 20 entries. Sourced from anime-aware
    /// addons (Kitsu / AniList / AIOMetadata anime catalogs) under
    /// `voiceActors` / `voice_actors` / `voiceCast`. Empty for live-
    /// action; live-action voice work shows under `cast` instead.
    /// For MAL-meta anime, voice-actor character/role pairings live
    /// in `cast_detailed` (same array — MAL's "cast" is the voice
    /// ensemble paired to characters).
    pub voice_actors: Vec<String>,
    /// Production studios — capped to 20 entries. Most relevant for
    /// anime and animated content (Studio Ghibli, MAPPA, etc.). Empty
    /// when the addon doesn't expose `studios` / `studio`.
    pub studios: Vec<String>,
    /// Country of origin (best-effort string from addons that include it).
    pub country: Option<String>,
    /// ISO 639-1 original-audio language code (e.g. "ko", "ja", "en").
    /// Sourced from AIOMetadata's `originalLanguage` field. Drives the
    /// "original" token in the user's audio_priority preference list.
    pub original_language: Option<String>,
    /// ISO 3166-1 alpha-2 country codes (e.g. ["KR"], ["DE", "GB", "US"]).
    /// Sourced from AIOMetadata's `productionCountries`. Used as a regional
    /// tiebreaker when picking between dub variants (es-MX vs es-ES, etc.).
    pub production_countries: Vec<String>,
    /// Multi-source ratings: list of `{source, value}` (e.g. IMDb, RT, MAL).
    pub ratings: Vec<RatingEntry>,
    /// Episode / video list (series + anime). For movies this is empty.
    /// IDs are preserved verbatim — addons need exact strings like
    /// `kitsu:12345:1` or `tt0903747:1:5` to resolve episode-level streams.
    pub videos: Vec<VideoEntry>,
    /// MyAnimeList numeric id when the addon stamps one — sourced from
    /// AIOMetadata's `_malId` / `app_extras.malId` / similar. Empty
    /// for non-anime AND for anime addons that don't expose MAL ids.
    /// Drives the AniSkip lookup on the React side.
    pub mal_id: Option<u32>,
    /// Kitsu numeric id when present. Future use: kitsu→mal mapping
    /// fallback for AniSkip when mal_id is missing.
    pub kitsu_id: Option<u32>,
    /// AniDB numeric id when present. Future use: anidb→mal mapping
    /// fallback for AniSkip.
    pub anidb_id: Option<u32>,
    /// The Movie Database (TMDB) numeric id when the addon stamps one.
    /// Sourced from AIOMetadata's `_tmdbId` — correct on live-action
    /// series, unreliable for anime (null, or the broken literal
    /// "[object Object]"). Drives the publicmetadb OP/ED skip lookup.
    pub tmdb_id: Option<i64>,
    /// Per-season cast/crew rosters. Keys are season numbers (TMDB /
    /// TVDB convention — season 0 is specials, 1+ are the main run).
    /// Empty on movies + MAL-meta anime + older cached entries that
    /// pre-date AIOMetadata's `seasonCredits` payload. The React side
    /// uses the currently-selected season to swap the detail-page
    /// cast block; falls through to `cast_detailed` when this is
    /// empty so older cached entries keep rendering.
    pub season_credits: std::collections::BTreeMap<u32, SeasonCredits>,
    /// Show-level aggregate credits — episode counts per actor /
    /// crew member. TMDB-only. Powers the hover-overlay's
    /// Main/Recurring/Guest tier classification.
    pub aggregate_credits: Option<AggregateCredits>,
    /// Series airing status straight from the addon meta's `status` field
    /// (best-effort; the vocabulary varies by source). Cinemeta / TMDB-backed
    /// addons emit "Continuing" / "Returning Series" / "Ended" / "Canceled";
    /// anime addons (Kitsu / MAL / AniList) emit "current" / "finished" /
    /// "finished_airing" / "releasing" / "upcoming" / "tba". `None` when the
    /// addon omits it. Drives the EOS Spotlight's "Series finale" vs "Caught
    /// up" decision — a non-ended status means more episodes are still coming
    /// even when the meta's video list hasn't been extended with them yet.
    pub status: Option<String>,
    /// YouTube video id for the title's trailer, when the addon emits one.
    /// Resolved from `trailerStreams[0].ytId` (Stremio v5 shape) or from
    /// `trailers[0].source` (a bare id or a `youtube.com`/`youtu.be` URL).
    /// `None` when neither is present. Drives the "Watch Trailer" button;
    /// the frontend passes it to `resolve_trailer_url` (yt-dlp) for playback.
    pub trailer_yt_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct VideoEntry {
    /// EXACT addon id for this episode/video — passed verbatim to
    /// `fetch_streams`. Do NOT mutate (no slugification, no encoding).
    pub id: String,
    pub title: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub released: Option<String>,
    pub thumbnail: Option<String>,
    pub overview: Option<String>,
    /// AIOMetadata emits a per-episode kind classification for anime:
    /// `"filler"`, `"recap"`, or `"normal"` (we also accept `"canon"`
    /// and `"mixed"` as historical aliases — both fold to `normal`).
    /// Aura paints a banner on the episode row in DetailView and the
    /// next-up auto-advance can be configured to skip filler/recap.
    /// `None` = upstream didn't emit the field (movies, non-anime
    /// series, older addons without the patch).
    ///
    /// Kept as a string for back-compat with downstream surfaces that
    /// already branch on its single-value shape (CinemaRows banners,
    /// auto-advance filter). For the dual-flag case (AIOMetadata
    /// flagging both filler AND recap on one episode), see the two
    /// boolean fields below — `episode_kind` resolves to whichever
    /// flag is dominant (filler wins) when both are set.
    pub episode_kind: Option<String>,
    /// True when AIOMetadata flagged the episode as filler. Independent
    /// of `is_recap` — both can be true on the same episode per the
    /// release-search-spec §6.3 contract. Defaults to `false` for
    /// non-anime content / older addons.
    #[serde(default)]
    pub is_filler: bool,
    /// True when AIOMetadata flagged the episode as recap. See
    /// `is_filler` for the dual-flag rationale.
    #[serde(default)]
    pub is_recap: bool,
    /// AIOMetadata-embedded AniList media id for THIS episode's cour/season
    /// (per the Aura<->AIOMetadata scrobble contract). Paired with
    /// `anilist_episode`. When both are present, the AniList scrobbler saves
    /// straight to this entry and skips the Fribb id-map / title-search /
    /// sequel-walk / offset heuristics entirely — the addon owns the
    /// numbering scheme, so it's exact and immune to Fribb dataset drift.
    /// `None` for non-anime, movies, and addons without the patch.
    #[serde(default)]
    pub anilist_id: Option<i64>,
    /// AIOMetadata-embedded episode number LOCAL to `anilist_id` (1-indexed,
    /// e.g. Science Future ep 4, NOT the display/absolute number). Only
    /// meaningful alongside `anilist_id`.
    #[serde(default)]
    pub anilist_episode: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct RatingEntry {
    pub source: String,
    pub value: String,
}

#[derive(Clone, Serialize)]
pub struct StreamEntry {
    /// Display name (e.g. "1080p HDR · 4.5 GB"). Always present.
    pub title: String,
    /// Source addon's display name — lets the UI group by provider.
    pub addon_name: String,
    /// Direct HTTP(S) URL to the stream. Mutually-exclusive with `info_hash`.
    pub url: Option<String>,
    /// Torrent info hash for magnet streams.
    pub info_hash: Option<String>,
    /// File index inside the torrent (defaults to 0 for single-file).
    pub file_idx: Option<i64>,
    /// Behavior hints from the addon (HDR, 4K, etc).
    pub description: Option<String>,
    /// `behaviorHints.filename` from the addon — raw release filename
    /// (e.g. "Frieren.S01E07.1080p.WEB-DL.x265-RAWR.mkv"). AIOStreams
    /// and some other addons populate this; the UI surfaces it as a
    /// hover tooltip on the stream row's headline so users can verify
    /// the exact release without copying the link first.
    pub filename: Option<String>,
    /// `streamData.episodePack` from AIOStreams. `Some(true)` marks an
    /// unreliable multi-episode / season pack whose actually-played file
    /// can't be verified for a single-episode request (the file is chosen
    /// by the upstream addon, not by AIOStreams, so a request for E15 can
    /// silently play a different episode inside the pack). `Some(false)` =
    /// a verified single episode, or a pack the upstream already resolved
    /// to the requested episode. `None` = the server didn't emit
    /// `streamData` (it's gated behind PROVIDE_STREAM_DATA) or it's an
    /// older build — treat as unknown and render normally. The UI swaps the
    /// star rating for a red "Unreliable" badge only when this is `Some(true)`.
    pub episode_pack: Option<bool>,
}

// ---------------------------------------------------------------------------
// AIOStreams metadata payloads
//
// AIOStreams (https://github.com/Viren070/AIOStreams) returns a JSON object
// alongside the canonical Stremio `streams` array containing four optional
// arrays of structured messages:
//   • errors      — fatal addon failures the user should see
//   • warnings    — non-fatal issues (rate limit, partial result, etc.)
//   • info        — informational notes
//   • statistics  — per-fetch stats (latency, scraper counts, …)
//
// Each entry is shaped roughly like `{ title?: string, description: string }`
// or `{ message: string }`. We capture both so the UI can render either.
// Tagging each message with the originating addon's name lets the React panel
// group messages by source the same way it groups streams.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct StreamMessage {
    /// Category — one of "error", "warning", "info", "stats". Allows the
    /// frontend to colour-code without inspecting which array the entry came
    /// from. Plain string keeps serialisation trivial across the boundary.
    pub kind: String,
    /// Optional short heading from AIOStreams (`title` field).
    pub title: Option<String>,
    /// Body text — falls back to `message` when `description` is absent.
    pub description: String,
    /// Source addon's display name.
    pub addon_name: String,
    /// `streamData.forced` from AIOStreams pseudo-streams. The patched fork
    /// surfaces this on every statistic / error pseudo-stream so the UI can
    /// keep rendering forced notices (e.g. the "Digital Release Filter"
    /// warning, the disabled-stream-types removal-reasons entry) even when
    /// the user has globally toggled "Show AIOStreams notices" off. False
    /// for the named-array shape (errors / warnings / info / statistics)
    /// since that path doesn't carry per-entry forced flags.
    #[serde(default)]
    pub forced: bool,
}

#[derive(Clone, Serialize, Default)]
pub struct StreamMetadata {
    pub errors: Vec<StreamMessage>,
    pub warnings: Vec<StreamMessage>,
    pub info: Vec<StreamMessage>,
    pub stats: Vec<StreamMessage>,
}

#[derive(Clone, Serialize)]
pub struct StreamFetchResult {
    pub streams: Vec<StreamEntry>,
    pub metadata: StreamMetadata,
}

// IMPORTANT: All renames here are DESERIALIZE-ONLY so the Stremio cloud's
// wire format ("_id", "type", "_mtime", "_ctime") is read into our snake-case
// Rust fields, but when Tauri serialises the struct back to JSON for the
// frontend it uses the Rust field names ("id", "media_type", "mtime",
// "ctime"). Without the directional rename, Tauri was sending the wire
// names and the React side's `i.id`, `i.media_type`, etc. were undefined —
// breaking Library type filters (Movies / Series / Anime → 0), DetailView
// opens (mediaType undefined → addons can't resolve), and the Calendar
// (which keys off media_type to filter to series).
#[derive(Clone, Serialize, Deserialize)]
pub struct LibraryItem {
    #[serde(rename(deserialize = "_id"))]
    pub id: String,
    #[serde(rename(deserialize = "type"))]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub logo: Option<String>,
    pub year: Option<String>,
    #[serde(default)]
    pub removed: bool,
    #[serde(default)]
    pub temp: bool,
    #[serde(rename(deserialize = "_ctime"), default)]
    pub ctime: Option<String>,
    #[serde(rename(deserialize = "_mtime"), default)]
    pub mtime: Option<String>,
    /// Free-form playback state object (timeOffset, video_id, etc.).
    /// Kept opaque so we can round-trip it back to the cloud unchanged.
    #[serde(default)]
    pub state: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Security: sanitization
// ---------------------------------------------------------------------------

/// Accepts only http:// and https:// URLs up to 2 KB.
/// Rejects data:, javascript:, and any other scheme that could trigger XSS or
/// image-based injection when placed in an <img src>.
fn sanitize_url(url: Option<String>) -> Option<String> {
    let url = url?;
    let lower = url.to_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://")) && url.len() <= 2048 {
        Some(url)
    } else {
        None
    }
}

fn cap(s: String, max: usize) -> String {
    if s.chars().count() <= max { s } else { s.chars().take(max).collect() }
}

/// Per-item-tolerant deserialiser. Returns the items that parse cleanly
/// AND have a non-empty id; counts the ones that failed for the caller's
/// log line. Used by every catalog / search call site so a single
/// malformed meta entry can't blank out an entire payload. Spec-violating
/// entries (numeric ids, missing `type`/`name`) are logged at the call
/// site but never crash the response.
fn parse_meta_array(raw: Vec<serde_json::Value>) -> (Vec<WireMeta>, usize, Vec<String>) {
    let mut out = Vec::with_capacity(raw.len());
    let mut dropped = 0usize;
    let mut errors = Vec::new();
    for value in raw {
        match serde_json::from_value::<WireMeta>(value.clone()) {
            Ok(m) if !m.id.is_empty() => out.push(m),
            Ok(_) => { dropped += 1; errors.push("empty id".to_string()); }
            Err(e) => {
                dropped += 1;
                let preview: String = value.to_string().chars().take(160).collect();
                errors.push(format!("{e} (raw: {preview})"));
            }
        }
    }
    (out, dropped, errors)
}

/// Clamp all text fields to safe lengths and strip dangerous poster URLs.
fn sanitize_meta(m: WireMeta) -> MetaPreview {
    MetaPreview {
        id:           cap(m.id, 128),
        name:         cap(m.name, 200),
        media_type:   cap(m.media_type, 32),
        poster:       sanitize_url(m.poster),
        background:   sanitize_url(m.background),
        fanart:       sanitize_url(m.fanart),
        backdrop:     sanitize_url(m.backdrop),
        logo:         sanitize_url(m.logo),
        release_info: m.release_info.map(|s| cap(s, 32)),
        description:  m.description.map(|s| cap(s, 500)),
        imdb_rating:  m.imdb_rating.map(|s| cap(s, 8)),
        genres:       sanitize_genres(m.genres),
    }
}

/// Cap genre count + per-string length so a malicious addon can't blow up
/// our memory or the FilterBar's chip rendering.
fn sanitize_genres(g: Vec<String>) -> Vec<String> {
    g.into_iter().take(10).map(|s| cap(s, 32)).collect()
}

/// Pull a string field out of an arbitrary serde_json::Value with capping.
fn json_str(v: &serde_json::Value, field: &str, max: usize) -> Option<String> {
    v.get(field)
        .and_then(|x| x.as_str())
        .map(|s| cap(s.to_string(), max))
}

fn json_url(v: &serde_json::Value, field: &str) -> Option<String> {
    sanitize_url(v.get(field).and_then(|x| x.as_str()).map(String::from))
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/// Map a reqwest error to a single-word category so error logs read
/// "[addon] catalog/foo timed out — <details>" instead of just dumping
/// the multi-line nested cause chain. Goal: at a glance, distinguish
/// "addon hung on its own dependency" (timeout) from "addon hostname
/// is wrong" (connect / DNS) from "TLS cert mismatch" (builder), so
/// future debugging doesn't require re-reading reqwest's internals.
fn describe_reqwest_err(e: &reqwest::Error) -> &'static str {
    if e.is_timeout()                       { "timed out" }
    else if e.is_connect()                  { "connect failed" }
    else if e.is_decode()                   { "decode failed" }
    else if e.is_redirect()                 { "redirect loop" }
    else if e.is_request()                  { "request error" }
    else if e.is_status()                   { "http status error" }
    else if e.is_body()                     { "response body error" }
    else if e.is_builder()                  { "builder error" }
    else                                    { "send error" }
}

/// Reject obviously-malformed addon URLs before any network call. The Rust
/// reqwest layer would also error on a bad URL, but doing the cheap structural
/// checks here gives the user a precise message and prevents wasted DNS / TLS
/// handshakes on URLs that can never be valid.
///
/// Loopback (127.0.0.1, localhost) is intentionally ALLOWED. Power users
/// self-host addons like AIOMetadata / AIOStreams locally and need to point
/// Aura at `http://127.0.0.1:11470/manifest.json` and similar. Aura is a
/// desktop client, not a server — the SSRF surface that loopback rejection
/// is meant to protect (cloud-metadata endpoints, internal services on a
/// shared cluster) doesn't apply here.
pub fn validate_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("URL is empty".into());
    }
    // 2048 bytes is the de-facto Internet Explorer / RFC 3986 ceiling.
    // Anything longer is virtually certain to be a malformed paste or
    // an attempted exploit — safe to reject outright.
    if url.len() > 2048 {
        return Err("URL is too long (max 2048 characters)".into());
    }
    let host_and_rest = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        rest
    } else {
        return Err("URL must use the http:// or https:// scheme".into());
    };
    // Need SOMETHING after the scheme — `https://` alone is rejected.
    let host = host_and_rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err("URL has no host component".into());
    }
    // Reject embedded credentials (`http://user:pass@host`). reqwest
    // accepts these but they're a credential-leak vector via logs and
    // backup exports, and a legitimate Stremio addon never needs them.
    if host.contains('@') {
        return Err("URL must not embed credentials (user:pass@…)".into());
    }
    // Block path traversal in the URL path. None of Aura's URL builders
    // round-trip user input as a raw path segment, but defence-in-depth
    // against an addon that returns a malicious meta record with a
    // poster URL containing `../` is cheap.
    if url.contains("/../") || url.ends_with("/..") {
        return Err("URL contains a path-traversal segment".into());
    }
    Ok(())
}

/// Strip /manifest.json suffix and trailing slashes — used for deduplication
/// across the two transport URL forms Stremio addons use.
fn normalize_addon_url(url: &str) -> &str {
    url.strip_suffix("/manifest.json")
        .unwrap_or(url)
        .trim_end_matches('/')
}

/// Percent-encode a search query for safe embedding in a URL path segment.
/// Spaces become +; other non-unreserved bytes become %XX.
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Internal async helpers
// ---------------------------------------------------------------------------

async fn fetch_manifest(base: &str) -> Result<(WireManifest, bool), String> {
    // Cache hit — avoids redundant network calls on home load, search,
    // stream and subtitle fan-outs. Lock is dropped before any await
    // point. Manifests rarely change for installed addons (capabilities
    // are tied to the addon's deploy, not per-request), and the
    // user-facing `Refresh` button (`refresh_addon_manifest`) drops the
    // entry to force a fresh fetch when needed. MANIFEST_TTL is the
    // same window the disk-cache warm-start uses, so a cold launch can
    // serve an addon's manifest from local storage instead of a
    // network round-trip.
    {
        let cache = manifest_cache().lock().unwrap();
        if let Some(entry) = cache.get(base) {
            let age = SystemTime::now()
                .duration_since(entry.cached_at)
                .unwrap_or(Duration::MAX);
            if age < MANIFEST_TTL {
                return Ok((entry.wire.clone(), entry.has_search));
            }
        }
    }

    let wire: WireManifest = client()
        .get(format!("{base}/manifest.json"))
        .send()
        .await
        .map_err(|e| format!("Manifest fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Manifest HTTP error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Manifest parse error: {e}"))?;

    let search_in_extra = wire.catalogs.iter().any(|c| {
        c.extra.iter().any(|ex| ex.get("name").and_then(|v| v.as_str()) == Some("search"))
    });
    let search_in_resources = wire.resources.iter().any(|r| match r {
        serde_json::Value::String(s) => s == "search",
        serde_json::Value::Object(o) => o.get("name").and_then(|v| v.as_str()) == Some("search"),
        _ => false,
    });

    let has_search = search_in_extra || search_in_resources;

    {
        let mut cache = manifest_cache().lock().unwrap();
        cache.insert(base.to_string(), ManifestCacheEntry {
            wire:       wire.clone(),
            has_search,
            cached_at:  SystemTime::now(),
        });
    }
    // Persist to disk so the next cold launch's home-screen mount can
    // serve the addon's capability list from local storage instead of
    // refetching N manifests in parallel.
    save_manifest_cache_to_disk();

    Ok((wire, has_search))
}

/// Read the full addon collection from the Stremio account API.
/// Returns raw JSON so we can round-trip the full manifest objects that
/// addonCollectionSet requires.
async fn fetch_raw_collection(auth_key: &str) -> Result<Vec<serde_json::Value>, String> {
    let body = serde_json::json!({ "authKey": auth_key });
    let raw = account_client()
        .post(format!("{STREMIO_ACCOUNT_API}/addonCollectionGet"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .error_for_status()
        .map_err(|e| {
            if e.status().map(|s| s.as_u16()) == Some(401) { SESSION_EXPIRED.into() }
            else { format!("HTTP error: {e}") }
        })?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON parse error: {e}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(map_api_error(err));
    }

    json.pointer("/result/addons")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| format!("addons array missing in response: {raw}"))
}

/// Write a modified addon collection back to the Stremio account.
async fn push_collection(auth_key: &str, addons: Vec<serde_json::Value>) -> Result<(), String> {
    let body = serde_json::json!({ "authKey": auth_key, "addons": addons });
    let raw = account_client()
        .post(format!("{STREMIO_ACCOUNT_API}/addonCollectionSet"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .error_for_status()
        .map_err(|e| {
            if e.status().map(|s| s.as_u16()) == Some(401) { SESSION_EXPIRED.into() }
            else { format!("HTTP error: {e}") }
        })?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON parse error: {e}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(map_api_error(err));
    }

    Ok(())
}

fn map_api_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("session") || lower.contains("auth") || lower.contains("expired") {
        SESSION_EXPIRED.into()
    } else {
        err.to_string()
    }
}

// ---------------------------------------------------------------------------
// Commands — addon management (guest mode)
// ---------------------------------------------------------------------------

/// Best-effort detection — does this URL/name look like an AIOMetadata
/// addon? Used by the logger to pick the `[AIOMetadata]` label.
fn looks_like_aiometadata(name: &str, url: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let u = url.to_ascii_lowercase();
    n.contains("aiometadata") || n.contains("aio-metadata") || n.contains("aio metadata")
        || u.contains("aiometadata") || u.contains("aio-metadata")
}

/// Pick a stable label for log lines so the DevConsole can be grep-filtered.
/// Falls back to the addon's display name; AIOMetadata addons get the
/// distinctive `AIOMetadata` label regardless of the user's display name.
fn log_label(name: &str, url: &str) -> String {
    if looks_like_aiometadata(name, url) {
        "AIOMetadata".to_string()
    } else if !name.is_empty() {
        name.to_string()
    } else {
        redact_sensitive_url(url)
    }
}

/// Strip API-key / token shaped fragments from a URL before it's
/// devlog'd. Stream addons routinely return URLs with debrid bearer
/// keys embedded as `?api_key=…`, `?token=…`, or `/api_key/<key>/…`
/// path segments — devlog'ing the raw URL persists them to
/// `aura-mpv.log` AND the DevConsole ring buffer (which gets exported
/// from the Help menu). The redacted form preserves the host and the
/// non-secret path so debugging still works.
///
/// Conservative scope: redact ONLY parameters whose name matches the
/// well-known secret-bearing keys. Aura's own addon URLs (configured by
/// the user, e.g. AIOMetadata `?lang=en&…`) stay readable.
pub(crate) fn redact_sensitive_url(input: &str) -> String {
    // Path-segment form: `…/api_key/<value>/…` → `…/api_key/<redacted>/…`
    const PATH_KEYS: &[&str] = &["api_key", "apikey", "token", "auth"];
    // Query-param form: `?api_key=<value>` / `&token=<value>` → `<redacted>`
    const QUERY_KEYS: &[&str] = &[
        "api_key", "apikey", "apiKey", "token", "password", "pin", "auth", "key",
    ];

    let mut s = input.to_string();

    // Pass 1: path-segment redaction. Walk each key marker and replace
    // the segment following it (up to the next `/` or `?` or end).
    for k in PATH_KEYS {
        let marker = format!("/{}/", k);
        let mut search_start = 0;
        while let Some(idx) = s[search_start..].find(&marker) {
            let abs = search_start + idx + marker.len();
            // Find end of value: next '/' or '?' or end-of-string.
            let tail = &s[abs..];
            let end = tail
                .find(|c: char| c == '/' || c == '?')
                .unwrap_or(tail.len());
            if end > 0 {
                s.replace_range(abs..abs + end, "<redacted>");
            }
            // Advance past the redaction so we don't re-scan it.
            search_start = abs + "<redacted>".len();
            if search_start >= s.len() {
                break;
            }
        }
    }

    // Pass 2: query-param redaction. Each `?key=` or `&key=` followed by
    // value up to the next `&` or `#` or end.
    for k in QUERY_KEYS {
        let prefixes = [format!("?{k}="), format!("&{k}=")];
        for prefix in &prefixes {
            let mut search_start = 0;
            while let Some(idx) = s[search_start..].find(prefix) {
                let abs = search_start + idx + prefix.len();
                let tail = &s[abs..];
                let end = tail
                    .find(|c: char| c == '&' || c == '#')
                    .unwrap_or(tail.len());
                if end > 0 {
                    s.replace_range(abs..abs + end, "<redacted>");
                }
                search_start = abs + "<redacted>".len();
                if search_start >= s.len() {
                    break;
                }
            }
        }
    }

    s
}

/// Force a fresh manifest fetch, bypassing the 5-minute MANIFEST_CACHE
/// TTL. Used by the per-addon "Refresh" button in AddonsView so users
/// can pick up newly-added catalogs (typical for self-hosted
/// AIOMetadata where catalogs are toggled in the addon's configure
/// page) without removing and re-adding the addon. The shape matches
/// `get_addon_manifest` so callers can reuse the same response type.
#[tauri::command]
pub async fn refresh_addon_manifest(addon_url: String) -> Result<AddonManifest, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    // Drop the cached entry BEFORE the refetch so the very next call
    // sees the cache miss and hits the network. We also drop any
    // catalog-level success caches keyed against this base so the
    // refresh actually surfaces the new state on next home load.
    manifest_cache().lock().unwrap().remove(&base);
    // Mirror the eviction to disk so the next launch doesn't warm an
    // entry the user just asked to discard.
    save_manifest_cache_to_disk();
    let prefix = format!("{base}|");
    if let Ok(mut ok)   = catalog_ok_cache().lock()   { ok.retain(|k, _| !k.starts_with(&prefix)); }
    if let Ok(mut fail) = addon_fail_cache().lock()   { fail.retain(|k, _| !k.starts_with(&prefix)); }
    get_addon_manifest(addon_url).await
}

#[tauri::command]
pub async fn get_addon_manifest(addon_url: String) -> Result<AddonManifest, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    let (wire, has_search) = fetch_manifest(&base).await?;
    let label = log_label(&wire.name, &base);
    crate::devlog!(
        info, "manifest",
        "[{}] {} catalogs, has_search={}",
        label, wire.catalogs.len(), has_search,
    );

    let catalogs = wire
        .catalogs
        .into_iter()
        .map(|c| {
            let display_name = c
                .name
                .unwrap_or_else(|| format!("{} · {}", title_case(&c.media_type), c.id));
            let is_search_only = catalog_is_search_only(&c.extra);
            // showInHome (AIOMetadata extension) is the AUTHORITATIVE
            // signal when present: `Some(false)` means the user has
            // explicitly toggled the catalog off the home board. Fall
            // through to the extras-based heuristic only when the field
            // is absent (other addons that follow the standard Stremio
            // "required-genre" convention for Discover-only catalogs).
            let is_hidden_from_home = match c.show_in_home {
                Some(true) => false,
                Some(false) => true,
                None => catalog_is_hidden_from_home(&c.extra),
            };
            CatalogInfo {
                name:           display_name,
                media_type:     c.media_type,
                id:             c.id,
                is_search_only,
                is_hidden_from_home,
            }
        })
        .collect();

    Ok(AddonManifest { name: wire.name, catalogs, has_search })
}

/// A catalog is "search-only" when one of its `extra` parameters is `search`
/// AND that parameter is required — meaning the addon cannot return any
/// items without a user-supplied query. Such catalogs don't belong in the
/// browseable home feed.
fn catalog_is_search_only(extras: &[serde_json::Value]) -> bool {
    extras.iter().any(|ex| {
        let is_search = ex.get("name").and_then(|v| v.as_str()) == Some("search");
        let required = ex.get("isRequired").and_then(|v| v.as_bool()) == Some(true);
        is_search && required
    })
}

/// A catalog is "hidden from home" when it has a required `extra` parameter
/// other than `search` that has no `options` default — the addon can't
/// produce rows without a user-supplied filter (genre, year, etc.). This is
/// Stremio's standard "Discover-only" pattern AND how AIOMetadata's
/// "enabled but hidden from home" toggle surfaces in the manifest. Distinct
/// from `is_search_only` so the Discover tab can offer these as picks.
fn catalog_is_hidden_from_home(extras: &[serde_json::Value]) -> bool {
    extras.iter().any(|ex| {
        let name = ex.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name == "search" || name.is_empty() { return false; }
        let required = ex.get("isRequired").and_then(|v| v.as_bool()) == Some(true);
        if !required { return false; }
        // Required extras with a non-empty `options` array are still
        // home-eligible — the addon can default to the first option.
        // Required extras without options need user input.
        let has_options = ex
            .get("options")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        !has_options
    })
}

#[tauri::command]
pub async fn add_addon<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
) -> Result<AddonEntry, String> {
    validate_url(&url)?;
    // Normalise so users can paste either form (`…/stremio` OR
    // `…/stremio/manifest.json`) and we always store a clean base.
    let base = normalise_addon_base(&url);
    let (wire, has_search) = fetch_manifest(&base).await?;

    let mut list = addons::load(&app)?;
    if list.iter().any(|a| normalise_addon_base(&a.url) == base) {
        return Err("Addon already added".into());
    }

    // Build types/resources from the manifest so the Addons UI can render
    // colored tags without re-fetching the manifest. Also cache the
    // stream-resource metadata + idPrefixes so fetch_streams doesn't have
    // to re-probe the manifest on every request (a transient network
    // failure during that re-probe was killing all stream lookups).
    let types       = collect_wire_types(&wire);
    let resources   = collect_wire_resources(&wire);
    let id_prefixes = collect_wire_id_prefixes(&wire);
    let (stream_types, stream_id_prefixes) = collect_wire_stream_resource_info(&wire);
    let configurable = wire.behavior_hints.configurable;

    let entry = AddonEntry {
        url: base,
        name: wire.name,
        manifest_id: wire.id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
        configurable,
    };
    list.push(entry.clone());
    addons::save(&app, &list)?;
    Ok(entry)
}

#[tauri::command]
pub async fn remove_addon<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let norm = url.trim_end_matches('/');
    let mut list = addons::load(&app)?;
    list.retain(|a| a.url.trim_end_matches('/') != norm);
    addons::save(&app, &list)
}

#[tauri::command]
pub async fn list_addons<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<AddonEntry>, String> {
    addons::load(&app)
}

/// Reorder the local addons.json to match `urls`. Guest-mode counterpart of
/// `cloud_reorder_addons`. Returns the new ordering so the caller can
/// reconcile its in-memory state without a separate `list_addons` round-trip.
#[tauri::command]
pub async fn reorder_addons<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    urls: Vec<String>,
) -> Result<Vec<AddonEntry>, String> {
    addons::reorder(&app, &urls)
}

// ---------------------------------------------------------------------------
// Commands — catalog browsing
// ---------------------------------------------------------------------------

/// Fetch one catalog page from a Stremio-compatible addon.
///
/// Optional params follow the Stremio extras path-segment protocol:
///   /catalog/{type}/{id}.json                       — page 1 (default)
///   /catalog/{type}/{id}/skip=100.json              — page 2 (offset 100)
///   /catalog/{type}/{id}/genre=Action&skip=100.json — combined extras
///
/// `limit` slices the response client-side after JSON parse. The wire
/// response from a typical AIOMetadata catalog is ~100 items per page;
/// `limit` lets the Home view request "just enough for the 10/8 visible
/// cells" without touching the wire format. Sanitisation only runs on
/// the kept slice, so requesting limit=10 saves 90 metadata-validation
/// passes per row.
#[tauri::command]
pub async fn fetch_catalog(
    addon_url: String,
    catalog_type: String,
    catalog_id: String,
    skip: Option<u32>,
    limit: Option<u32>,
) -> Result<Vec<MetaPreview>, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    let url = match skip {
        Some(n) if n > 0 => {
            format!("{base}/catalog/{catalog_type}/{catalog_id}/skip={n}.json")
        }
        _ => format!("{base}/catalog/{catalog_type}/{catalog_id}.json"),
    };
    let label = log_label("", &base);

    // Soft-fail cache: if THIS specific catalog timed out recently,
    // skip the network call to avoid paying another 20 s timeout. The
    // cooldown is per-(addon, catalog) so a slow catalog only mutes
    // ITSELF — sibling catalogs from the same addon keep loading
    // normally. If we have a stale-but-cached payload for this
    // catalog, return it instead of an error so the home row stays
    // populated with the previous data while the cooldown drains.
    if is_catalog_soft_failed(&base, &catalog_type, &catalog_id) {
        if let Some(stale) = cached_catalog_metas(&base, &catalog_type, &catalog_id) {
            crate::devlog!(
                info, "catalog",
                "[{}] {}/{} cooldown — serving {} stale item(s) from cache",
                label, catalog_type, catalog_id, stale.len(),
            );
            return Ok(stale);
        }
        crate::devlog!(
            info, "catalog",
            "[{}] {}/{} skipped (catalog in 30s cooldown after recent timeout, no cache)",
            label, catalog_type, catalog_id,
        );
        return Err(format!("Catalog skipped: {catalog_type}/{catalog_id} timed out recently"));
    }

    crate::devlog!(
        info, "catalog",
        "[{}] GET {} (skip={:?} limit={:?})",
        label, url, skip, limit,
    );

    // Live fetch. Network-class failures fall through to the stale
    // cache (when available) so a flaky upstream doesn't blank out
    // the home row that previously had data.
    //
    // Catalog requests get a longer per-request timeout (20 s) than the
    // shared client default (`TIMEOUT`, 10 s). Aggregating catalog
    // builders (flixpatrol, the streaming.* rows) routinely need more
    // than 10 s on a cold request, and a timed-out catalog row is more
    // disruptive than a slow one. This is a per-request override, so
    // manifest / stream / meta fetches keep the snappier 10 s.
    let resp = match client().get(&url).timeout(Duration::from_secs(20)).send().await {
        Ok(r) => r,
        Err(e) => {
            let cat = describe_reqwest_err(&e);
            crate::devlog!(
                warn, "catalog", "[{}] {}/{} {}: {}",
                label, catalog_type, catalog_id, cat, e,
            );
            if e.is_timeout() || e.is_connect() || e.is_request() {
                mark_catalog_failed(&base, &catalog_type, &catalog_id);
                if let Some(stale) = cached_catalog_metas(&base, &catalog_type, &catalog_id) {
                    crate::devlog!(
                        info, "catalog",
                        "[{}] {}/{} live fetch failed ({}) — serving {} stale item(s)",
                        label, catalog_type, catalog_id, cat, stale.len(),
                    );
                    return Ok(stale);
                }
            }
            return Err(format!("Catalog fetch {cat}: {e}"));
        }
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "catalog", "[{}] HTTP {:?}", label, e.status());
            return Err(format!("Catalog HTTP error: {e}"));
        }
    };
    let response: CatalogResponse = match resp.json().await {
        Ok(r) => r,
        Err(e) => {
            // Include the catalog id so the user can pinpoint which builder
            // is returning malformed JSON — recurring "JSON parse error" with
            // no identifier was useless for triage.
            crate::devlog!(
                warn, "catalog", "[{}] {}/{} JSON parse error: {}",
                label, catalog_type, catalog_id, e,
            );
            return Err(format!("Catalog parse error: {e}"));
        }
    };

    let total_raw = response.metas.len();
    let raw_metas: Vec<_> = match limit {
        Some(n) => response.metas.into_iter().take(n as usize).collect(),
        None    => response.metas,
    };
    let (metas, dropped, errors) = parse_meta_array(raw_metas);
    for err in errors.iter().take(3) {
        crate::devlog!(
            warn, "catalog",
            "[{}] {}/{} skipped malformed meta: {}",
            label, catalog_type, catalog_id, err,
        );
    }
    let kept = metas.len();
    crate::devlog!(
        info, "catalog",
        "[{}] {}/{} skip={} → {} item(s){}{}",
        label, catalog_type, catalog_id,
        skip.unwrap_or(0), kept,
        if kept + dropped != total_raw { format!(" (sliced from {total_raw})") } else { String::new() },
        if dropped > 0 { format!(" ({dropped} dropped)") } else { String::new() },
    );
    let sanitized: Vec<MetaPreview> = metas.into_iter().map(sanitize_meta).collect();
    // Stash successful first-page responses into the stale-fallback
    // cache so a future timeout/cooldown for THIS catalog can serve
    // the previous payload instead of an empty row. Only first-page
    // responses are cached because subsequent pages aren't useful as
    // a standalone fallback (the user would see "items 100-200" with
    // no items 1-99 visible).
    if skip.unwrap_or(0) == 0 {
        store_catalog_metas(&base, &catalog_type, &catalog_id, &sanitized);
    }
    Ok(sanitized)
}

/// Walk catalog pages until we have `target` items or the addon
/// signals the end of the list. Stremio's catalog protocol uses
/// `skip` as a path segment in increments of the addon's page size
/// — for AIOMetadata that's 100 — so we step skip in 100s regardless
/// of `target`. De-duplicates by id across pages because some
/// catalogs (e.g. TMDB discover) drift between pages when items are
/// added upstream during pagination.
///
/// End-of-list detection: per the Stremio addon spec, "stop when the
/// response's metas array is empty or shorter than the previous page".
/// We DON'T stop on the first short page (e.g. some addons return a
/// curated 13-item first page but more on subsequent skips); we only
/// stop when:
///   • a page comes back empty, OR
///   • a page is shorter than the previous page (paging converging
///     on the end of the list), OR
///   • a page added zero NEW items after dedupe (addon ignoring
///     skip and returning the same payload every time — defensive
///     stop, otherwise we'd loop until MAX_PAGES burning round-trips).
///
/// Returns the deduped, sliced-to-target list. Used by the Home View's
/// "View all" popup to top off catalog rows that initially returned
/// fewer than 100 items, so the popup always shows a meaningful slice.
#[tauri::command]
pub async fn fetch_catalog_paginated(
    addon_url: String,
    catalog_type: String,
    catalog_id: String,
    target: u32,
) -> Result<Vec<MetaPreview>, String> {
    // Stremio addons disagree on page size — AIOMetadata returns 100,
    // AI Search returns ~10, Cinemeta returns 100, mdblist 50, etc.
    // The previous implementation hardcoded `skip` increments at 100,
    // which silently skipped over items 11-99 on a 10-item-per-page
    // addon (each call landed on item 101, returning the back half of
    // the catalog with the front half missing). We now infer the step
    // from the FIRST response's length and reuse it on every
    // subsequent call. HARD_PAGE_LIMIT bounds the inferred step so a
    // misbehaving addon returning "all items in one page" doesn't
    // produce a step of 1000+.
    const HARD_PAGE_LIMIT: u32 = 100;
    const MAX_PAGES: u32 = 10;

    let mut accumulated: Vec<MetaPreview> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut prev_page_len: Option<usize> = None;
    let mut step: u32 = HARD_PAGE_LIMIT;

    for page_idx in 0..MAX_PAGES {
        if accumulated.len() >= target as usize { break; }
        let skip = if page_idx == 0 { None } else { Some(page_idx * step) };
        let page = fetch_catalog(
            addon_url.clone(),
            catalog_type.clone(),
            catalog_id.clone(),
            skip,
            None,
        )
        .await?;
        let page_len = page.len();

        // First-page step inference: clamp to [1, HARD_PAGE_LIMIT]. We
        // only narrow the step when the addon's first page is smaller
        // than the default — never wider — because returning more than
        // 100 items in a single response would more often be a bug than
        // a feature, and stepping by it would inflate later request
        // skip values into addon-rejection territory.
        if page_idx == 0 && page_len > 0 {
            let observed = (page_len as u32).max(1);
            step = observed.min(HARD_PAGE_LIMIT);
        }

        // Empty page = unambiguous end-of-list.
        if page_len == 0 { break; }

        let before = accumulated.len();
        for m in page {
            // De-dupe by `${media_type}:${id}` because a few catalogs
            // (notably AI Search's combined feed) occasionally reach
            // across pages with the same surface id.
            let k = format!("{}:{}", m.media_type, m.id);
            if seen.contains(&k) { continue; }
            seen.insert(k);
            accumulated.push(m);
            if accumulated.len() >= target as usize { break; }
        }
        let added = accumulated.len() - before;

        // Defensive: addon returned a non-empty page but every entry
        // duplicated something we already had → addon is ignoring
        // skip / paginating broken. Stop instead of looping.
        if added == 0 { break; }

        // Shorter than previous page → converging on end-of-list.
        // First page has no prev to compare to, so we never bail
        // out on it even if the addon returned (e.g.) 13 items.
        if let Some(prev) = prev_page_len {
            if page_len < prev { break; }
        }
        prev_page_len = Some(page_len);
    }

    accumulated.truncate(target as usize);
    crate::devlog!(
        info, "catalog",
        "fetch_catalog_paginated {}/{} → {} item(s) (target={}, step={})",
        catalog_type, catalog_id, accumulated.len(), target, step,
    );
    Ok(accumulated)
}

// ---------------------------------------------------------------------------
// Commands: grouped search
// ---------------------------------------------------------------------------

/// Per-addon-catalog search results. Each entry maps to a `<DiscoveryRow>`
/// in the search view — the frontend renders one section per group and
/// preserves manifest order per addon.
#[derive(Clone, Serialize)]
pub struct SearchGroup {
    pub addon_name:   String,
    pub addon_url:    String,
    pub catalog_id:   String,
    pub catalog_name: String,
    pub media_type:   String,
    pub items:        Vec<MetaPreview>,
}

/// Search ONE addon's catalogs and return its groups. Splits the existing
/// `global_search_grouped` per-addon body into a standalone command so the
/// frontend can fan out N parallel calls (one per addon) and populate each
/// row independently as it completes — progressive display instead of the
/// "wait for the slowest addon" one-shot pattern.
///
/// Returns the addon's search-capable catalog groups in manifest order. An
/// empty Vec means: addon has no search-capable catalogs OR every catalog
/// returned zero items OR the manifest fetch failed (the warn devlog
/// captures the failure cause). Callers can treat empty as "this addon
/// contributed nothing" without distinguishing the underlying cause.
#[tauri::command]
pub async fn search_addon_grouped(
    addon: AddonEntry,
    query: String,
) -> Result<Vec<SearchGroup>, String> {
    let query = query.trim().to_string();
    if query.is_empty() || !addon.has_search {
        return Ok(vec![]);
    }
    let encoded = encode_query(&query);
    let base = normalise_addon_base(&addon.url);
    let Ok((wire, _)) = fetch_manifest(&base).await else {
        crate::devlog!(warn, "search", "[{}] manifest fetch failed", addon.name);
        return Ok(vec![]);
    };
    let addon_name_str = wire.name.clone();

    let mut out: Vec<SearchGroup> = Vec::new();
    for c in wire.catalogs.iter() {
        let supports_search = c.extra.iter().any(|ex| {
            ex.get("name").and_then(|v| v.as_str()) == Some("search")
        });
        if !supports_search { continue; }

        let url = format!(
            "{base}/catalog/{ty}/{id}/search={encoded}.json",
            ty = c.media_type,
            id = c.id,
        );
        crate::devlog!(info, "search", "[{}] GET {}", addon_name_str, redact_sensitive_url(&url));
        let items: Vec<MetaPreview> = match client().get(&url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    crate::devlog!(
                        warn, "search",
                        "[{}] {} → HTTP {}",
                        addon_name_str, url, resp.status().as_u16(),
                    );
                    continue;
                }
                match resp.json::<CatalogResponse>().await {
                    Ok(cr) => {
                        let (metas, _, _) = parse_meta_array(cr.metas);
                        metas.into_iter().map(sanitize_meta).collect()
                    }
                    Err(e) => {
                        crate::devlog!(
                            warn, "search",
                            "[{}] {} JSON parse failed: {}",
                            addon_name_str, url, e,
                        );
                        continue;
                    }
                }
            }
            Err(e) => {
                let cat = describe_reqwest_err(&e);
                crate::devlog!(
                    warn, "search",
                    "[{}] {} {}: {}",
                    addon_name_str, url, cat, e,
                );
                continue;
            }
        };
        if items.is_empty() { continue; }

        let display_name = c
            .name
            .clone()
            .unwrap_or_else(|| format!("{} · {}", title_case(&c.media_type), c.id));
        crate::devlog!(
            info, "search",
            "[{}] {} → {} item(s)",
            addon_name_str, display_name, items.len(),
        );
        out.push(SearchGroup {
            addon_name:   addon_name_str.clone(),
            addon_url:    base.clone(),
            catalog_id:   c.id.clone(),
            catalog_name: display_name,
            media_type:   c.media_type.clone(),
            items,
        });
    }
    Ok(out)
}

/// Expanded search — re-fetch a SINGLE search catalog with a `skip`
/// param present so a skip-aware addon (e.g. AI Search) returns its
/// full result set instead of the fast 10-item preview. Per the addon
/// contract the skip VALUE is irrelevant (it's clamped to offset 0 for
/// search); only its PRESENCE flips the addon into expanded mode. Same
/// catalog URL the initial search used, plus `&skip=0`. Used by the
/// "View all" affordance on a search-result row. Single-catalog, so
/// errors return `Err` (the client falls back to the preview items)
/// rather than the silent multi-catalog `continue` of
/// `search_addon_grouped`.
#[tauri::command]
pub async fn fetch_search_catalog_expanded(
    addon_url: String,
    media_type: String,
    catalog_id: String,
    query: String,
) -> Result<Vec<MetaPreview>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let base = normalise_addon_base(&addon_url);
    let encoded = encode_query(&query);
    let url = format!(
        "{base}/catalog/{media_type}/{catalog_id}/search={encoded}&skip=0.json",
    );
    crate::devlog!(info, "search", "[expand] GET {}", redact_sensitive_url(&url));
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("{}: {e}", describe_reqwest_err(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let cr = resp
        .json::<CatalogResponse>()
        .await
        .map_err(|e| format!("JSON parse failed: {e}"))?;
    let (metas, _, _) = parse_meta_array(cr.metas);
    let items: Vec<MetaPreview> = metas.into_iter().map(sanitize_meta).collect();
    crate::devlog!(info, "search", "[expand] {} → {} item(s)", redact_sensitive_url(&url), items.len());
    Ok(items)
}

/// Concurrent search across all search-enabled addons, returning results
/// grouped by addon + catalog so the search view can render Stremio-style
/// discrete sections. Iterates addons in install order; per addon, iterates
/// catalogs in manifest order.
#[tauri::command]
pub async fn global_search_grouped(
    addons: Vec<AddonEntry>,
    query: String,
) -> Result<Vec<SearchGroup>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let search_addons: Vec<AddonEntry> = addons.into_iter().filter(|a| a.has_search).collect();
    if search_addons.is_empty() {
        crate::devlog!(warn, "search", "global_search_grouped: no search-enabled addons");
        return Ok(vec![]);
    }

    let encoded = encode_query(&query);
    crate::devlog!(
        info,
        "search",
        "global_search_grouped query={query:?} across {} addon(s)",
        search_addons.len()
    );

    // We keep ordering deterministic: spawn a numbered task per addon, await
    // them in spawn-order so the resulting `Vec<SearchGroup>` reflects the
    // user's installed-addon order.
    let mut handles = Vec::with_capacity(search_addons.len());
    for addon in search_addons {
        let encoded = encoded.clone();
        let handle = tokio::spawn(async move {
            let base = normalise_addon_base(&addon.url);
            let Ok((wire, _)) = fetch_manifest(&base).await else {
                crate::devlog!(warn, "search", "[{}] manifest fetch failed", addon.name);
                return Vec::<SearchGroup>::new();
            };
            let addon_name_str = wire.name.clone();

            let mut out: Vec<SearchGroup> = Vec::new();
            // Manifest order is preserved by virtue of iterating
            // `wire.catalogs` in declaration order.
            for c in wire.catalogs.iter() {
                let supports_search = c.extra.iter().any(|ex| {
                    ex.get("name").and_then(|v| v.as_str()) == Some("search")
                });
                if !supports_search { continue; }

                let url = format!(
                    "{base}/catalog/{ty}/{id}/search={encoded}.json",
                    ty = c.media_type,
                    id = c.id,
                );
                crate::devlog!(info, "search", "[{}] GET {}", addon_name_str, redact_sensitive_url(&url));
                let items: Vec<MetaPreview> = match client().get(&url).send().await {
                    Ok(resp) => {
                        if !resp.status().is_success() {
                            crate::devlog!(
                                warn, "search",
                                "[{}] {} → HTTP {}",
                                addon_name_str, url, resp.status().as_u16(),
                            );
                            continue;
                        }
                        match resp.json::<CatalogResponse>().await {
                            Ok(cr) => {
                                let (metas, _, _) = parse_meta_array(cr.metas);
                                metas.into_iter().map(sanitize_meta).collect()
                            }
                            Err(e) => {
                                crate::devlog!(
                                    warn, "search",
                                    "[{}] {} JSON parse failed: {}",
                                    addon_name_str, url, e,
                                );
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        let cat = describe_reqwest_err(&e);
                        crate::devlog!(
                            warn, "search",
                            "[{}] {} {}: {}",
                            addon_name_str, url, cat, e,
                        );
                        continue;
                    }
                };
                if items.is_empty() { continue; }

                let display_name = c
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("{} · {}", title_case(&c.media_type), c.id));
                crate::devlog!(
                    info, "search",
                    "[{}] {} → {} item(s)",
                    addon_name_str, display_name, items.len(),
                );
                out.push(SearchGroup {
                    addon_name:   addon_name_str.clone(),
                    addon_url:    base.clone(),
                    catalog_id:   c.id.clone(),
                    catalog_name: display_name,
                    media_type:   c.media_type.clone(),
                    items,
                });
            }
            out
        });
        handles.push(handle);
    }

    let mut all: Vec<SearchGroup> = Vec::new();
    for h in handles {
        if let Ok(groups) = h.await {
            all.extend(groups);
        }
    }
    crate::devlog!(info, "search", "global_search_grouped done: {} group(s)", all.len());
    Ok(all)
}

// ---------------------------------------------------------------------------
// Commands — cloud sync (Task 2.3)
// ---------------------------------------------------------------------------

/// Add an addon to the user's Stremio cloud account.
///
/// Security: fetches the manifest before writing to the cloud — this validates
/// the URL is a real Stremio addon and prevents injection of arbitrary JSON
/// into the user's account. Only http/https URLs are accepted (validate_url).
#[tauri::command]
pub async fn cloud_add_addon(auth_key: String, url: String) -> Result<AddonEntry, String> {
    validate_url(&url)?;
    let base = normalise_addon_base(&url);

    // One HTTP call: validates the addon AND gives us the full manifest JSON
    // that addonCollectionSet requires.
    let manifest_json: serde_json::Value = client()
        .get(format!("{base}/manifest.json"))
        .send()
        .await
        .map_err(|e| format!("Manifest fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Manifest HTTP error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Manifest parse error: {e}"))?;

    let name = manifest_json
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Manifest missing 'name'")?
        .to_string();
    let manifest_id = manifest_json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let has_search = manifest_json
        .get("catalogs")
        .and_then(|c| c.as_array())
        .map(|cats| {
            cats.iter().any(|cat| {
                cat.get("extra")
                    .and_then(|e| e.as_array())
                    .map(|extras| {
                        extras
                            .iter()
                            .any(|ex| ex.get("name").and_then(|v| v.as_str()) == Some("search"))
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    let transport_url = format!("{base}/manifest.json");
    let base_norm = normalize_addon_url(&base);

    let mut collection = fetch_raw_collection(&auth_key).await?;

    if collection.iter().any(|a| {
        a.get("transportUrl")
            .and_then(|v| v.as_str())
            .map(|t| normalize_addon_url(t) == base_norm)
            .unwrap_or(false)
    }) {
        return Err("Addon already in your Stremio account".into());
    }

    collection.push(serde_json::json!({
        "manifest":     manifest_json,
        "transportUrl": transport_url,
    }));

    push_collection(&auth_key, collection).await?;

    let types       = extract_manifest_types(&manifest_json);
    let resources   = extract_manifest_resources(&manifest_json);
    let id_prefixes = extract_manifest_id_prefixes(&manifest_json);
    let (stream_types, stream_id_prefixes) = extract_stream_resource_info(&manifest_json);
    let configurable = extract_manifest_configurable(&manifest_json);

    Ok(AddonEntry {
        url: base,
        name,
        manifest_id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
        configurable,
    })
}

/// Remove an addon from the user's Stremio cloud account by URL.
#[tauri::command]
pub async fn cloud_remove_addon(auth_key: String, url: String) -> Result<(), String> {
    let norm = normalize_addon_url(url.trim_end_matches('/'));

    let mut collection = fetch_raw_collection(&auth_key).await?;
    let before = collection.len();
    collection.retain(|a| {
        a.get("transportUrl")
            .and_then(|v| v.as_str())
            .map(|t| normalize_addon_url(t) != norm)
            .unwrap_or(true)
    });

    if collection.len() == before {
        return Err("Addon not found in your Stremio account".into());
    }

    push_collection(&auth_key, collection).await
}

/// Reorder the user's Stremio cloud addon collection to match `urls`.
/// `urls` is the desired full order; matching is by normalized transportUrl
/// (the `/manifest.json` suffix and trailing slashes are ignored). Any cloud
/// entry not present in `urls` is preserved at the tail — defensive against
/// the cross-device race where device B added an addon between our most
/// recent get_synced_addons and this reorder call.
#[tauri::command]
pub async fn cloud_reorder_addons(auth_key: String, urls: Vec<String>) -> Result<(), String> {
    if urls.is_empty() {
        return Ok(());
    }
    let collection = fetch_raw_collection(&auth_key).await?;

    let target: Vec<String> = urls
        .iter()
        .map(|u| normalize_addon_url(u.trim_end_matches('/')).to_ascii_lowercase())
        .collect();

    let mut by_url: std::collections::HashMap<String, serde_json::Value> = collection
        .into_iter()
        .map(|entry| {
            let key = entry
                .get("transportUrl")
                .and_then(|v| v.as_str())
                .map(|t| normalize_addon_url(t).to_ascii_lowercase())
                .unwrap_or_default();
            (key, entry)
        })
        .collect();

    let mut next: Vec<serde_json::Value> = Vec::with_capacity(by_url.len());
    for tn in &target {
        if let Some(entry) = by_url.remove(tn) {
            next.push(entry);
        }
    }
    next.extend(by_url.into_values());

    push_collection(&auth_key, next).await
}

// ---------------------------------------------------------------------------
// Commands — meta detail (Phase 3 Task B)
// ---------------------------------------------------------------------------

/// Fetch the full meta object for a single id from a specific addon.
/// Used by the calendar (release dates) and the future detail view.
#[tauri::command]
pub async fn fetch_meta_detail(
    addon_url: String,
    media_type: String,
    id: String,
) -> Result<MetaDetail, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    let url = format!("{base}/meta/{media_type}/{id}.json");
    let label = log_label("", &base);

    crate::devlog!(info, "meta", "[{}] GET {}", label, redact_sensitive_url(&url));

    let json: serde_json::Value = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let cat = describe_reqwest_err(&e);
            crate::devlog!(warn, "meta", "[{}] {}: {}", label, cat, e);
            format!("Meta fetch {cat}: {e}")
        })?
        .error_for_status()
        .map_err(|e| {
            crate::devlog!(warn, "meta", "[{}] HTTP {:?}", label, e.status());
            format!("Meta HTTP error: {e}")
        })?
        .json()
        .await
        .map_err(|e| {
            crate::devlog!(warn, "meta", "[{}] JSON parse error: {}", label, e);
            format!("Meta parse error: {e}")
        })?;

    let meta = json.get("meta").ok_or_else(|| {
        crate::devlog!(warn, "meta", "[{}] response missing `meta` key", label);
        "Meta missing in response".to_string()
    })?;

    // ── Mapping summary ────────────────────────────────────────────────
    // Surfacing what we resolved from this addon's meta blob makes it
    // obvious in the DevConsole when a remote field is missing (e.g. the
    // logo URL didn't come back, or the videos array was empty for a
    // series id). Logged at INFO so it's visible without flipping debug.
    let name_str  = meta.get("name").and_then(|v| v.as_str()).unwrap_or("?");
    let has_logo  = meta.get("logo").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
    let has_bg    = meta.get("background").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
    let has_post  = meta.get("poster").and_then(|v| v.as_str()).map(|s| !s.is_empty()).unwrap_or(false);
    let video_ct  = meta.get("videos").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let cast_ct       = meta.get("cast").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let cast_extras_ct = meta.pointer("/app_extras/cast").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let rating_ct     = meta.get("ratings").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let status_str    = meta.get("status").and_then(|v| v.as_str()).unwrap_or("-");
    let relinfo_str   = meta.get("releaseInfo").and_then(|v| v.as_str()).unwrap_or("-");
    crate::devlog!(
        info, "meta",
        "[{}] mapped {:?} type={} poster={} bg={} logo={} videos={} cast={}+{}(app_extras) ratings={} status={:?} releaseInfo={:?}",
        label, name_str, media_type, has_post, has_bg, has_logo, video_ct, cast_ct, cast_extras_ct, rating_ct, status_str, relinfo_str,
    );

    let genres   = string_array(meta, "genres",   10, 32);

    // ── Cast / crew with AIOMetadata-shape fallbacks ───────────────────
    // The canonical Stremio addon-spec is `meta.cast: string[]` at the
    // top level (Cinemeta does this). AIOMetadata diverges: it puts
    // rich credit objects under `meta.app_extras.cast` as
    // `[{ name, character, photo }]` and emits `director` / `writer` as
    // comma-joined strings. We try the canonical shape first (covers
    // Cinemeta and any spec-compliant addon), then fall back to
    // AIOMetadata's app_extras and comma-string shapes. Either path
    // produces the same `Vec<String>` of names.
    // Cap every credit array at 20 — the user explicitly requested
    // "up to 20 of all types of cast meta". Old caps were a mix of
    // 4 / 6 / 8 / 12 / 20 which truncated rich-cast titles
    // (TMDB / TVDB) and hid voice ensembles on MAL anime.
    let cast_detailed = cast_members_from_objects(
        meta.pointer("/app_extras/cast"), 20, 64,
    );
    let cast = if !cast_detailed.is_empty() {
        cast_detailed.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    } else {
        // No rich shape — fall back to top-level `cast` (names only,
        // no character pairings). The Cinemeta path lands here.
        string_array(meta, "cast", 20, 64)
    };

    let director = array_or_comma(meta, &["director", "directors"], 20, 64);
    let writer   = array_or_comma(meta, &["writer",   "writers"],   20, 64);

    // Producers: canonical array, OR AIOMetadata's app_extras.producers
    // (TVmaze series only — same shape as app_extras.cast).
    let producer_detailed = cast_members_from_objects(
        meta.pointer("/app_extras/producers"), 20, 64,
    );
    let producer = if !producer_detailed.is_empty() {
        producer_detailed.iter().map(|c| c.name.clone()).collect::<Vec<_>>()
    } else {
        string_array_any(meta, &["producers", "producer"], 20, 64)
    };

    // Composers / creators / voice_actors / studios: AIOMetadata never
    // emits these as distinct top-level fields. We still try the
    // candidate spellings so spec-compliant addons (Cinemeta, custom
    // anime metadata) populate them when available.
    let composer = string_array_any(meta, &["composers", "composer", "music"], 20, 64);
    let creator  = string_array_any(meta, &["creators", "creator"], 20, 64);
    let voice_actors = string_array_any(meta, &["voiceActors", "voice_actors", "voiceCast"], 20, 64);
    let studios      = string_array_any(meta, &["studios", "studio", "studio_names"], 20, 64);

    // Diagnostic — surfaces what fields the addon actually emitted when
    // BOTH cast and voice_actors come back empty. Logs the top-level
    // meta keys plus any keys under `app_extras` so a "no cast on the
    // detail page" report can be triaged against the wire shape
    // without instrumenting further. Only fires on the empty-cast path
    // (no log noise on well-tagged metas).
    if cast.is_empty() && voice_actors.is_empty() {
        let mut top_keys: Vec<String> = meta.as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        top_keys.sort();
        let app_extras_keys: Vec<String> = meta.get("app_extras")
            .and_then(|v| v.as_object())
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        let id = meta.get("id").and_then(|v| v.as_str()).unwrap_or("?");
        crate::devlog!(
            info, "meta",
            "build_meta_detail({}): empty cast/voice_actors. top keys: {:?}; app_extras keys: {:?}",
            id, top_keys, app_extras_keys,
        );
    }

    // Multi-source ratings: addons sometimes ship `imdbRating`, `imdb_rating`,
    // `kpRating`, `malScore`, plus a structured `ratings` array of
    // `{source, value}`. We collect both shapes into a single list so the
    // detail view can render whatever is available without per-source code.
    let mut ratings: Vec<RatingEntry> = Vec::new();
    if let Some(arr) = meta.get("ratings").and_then(|v| v.as_array()) {
        for entry in arr.iter().take(8) {
            if let (Some(src), Some(val)) = (
                entry.get("source").and_then(|v| v.as_str()),
                entry.get("value").and_then(|v| v.as_str()),
            ) {
                ratings.push(RatingEntry {
                    source: cap(src.to_string(), 32),
                    value:  cap(val.to_string(), 16),
                });
            }
        }
    }
    let scalar_ratings: &[(&str, &str)] = &[
        ("imdbRating", "IMDb"),
        ("kpRating",   "Kinopoisk"),
        ("malScore",   "MAL"),
    ];
    for (key, label) in scalar_ratings {
        if let Some(v) = meta.get(*key).and_then(|x| x.as_str()) {
            if !v.is_empty() && !ratings.iter().any(|r| r.source == *label) {
                ratings.push(RatingEntry {
                    source: (*label).into(),
                    value:  cap(v.to_string(), 16),
                });
            }
        }
    }

    let videos = extract_videos(meta);

    // ── External anime-database ids (AniSkip + future history sync) ────
    // AIOMetadata stamps `_malId` / `_kitsuId` / `_anidbId` at top
    // level for anime metas (also in app_extras under camelCase
    // keys). Read whichever shape is present, parse to u32.
    fn read_numeric_id(meta: &serde_json::Value, candidates: &[&str]) -> Option<u32> {
        for k in candidates {
            // Top-level
            if let Some(v) = meta.get(*k) {
                if let Some(n) = v.as_u64().and_then(|n| u32::try_from(n).ok()) { return Some(n); }
                if let Some(s) = v.as_str() {
                    if let Ok(n) = s.parse::<u32>() { return Some(n); }
                }
            }
            // app_extras
            if let Some(v) = meta.pointer(&format!("/app_extras/{k}")) {
                if let Some(n) = v.as_u64().and_then(|n| u32::try_from(n).ok()) { return Some(n); }
                if let Some(s) = v.as_str() {
                    if let Ok(n) = s.parse::<u32>() { return Some(n); }
                }
            }
        }
        None
    }
    let mal_id   = read_numeric_id(meta, &["_malId",   "malId",   "mal_id"]);
    let kitsu_id = read_numeric_id(meta, &["_kitsuId", "kitsuId", "kitsu_id"]);
    let anidb_id = read_numeric_id(meta, &["_anidbId", "anidbId", "anidb_id"]);
    // TMDB id — AIOMetadata's `_tmdbId` (a JSON string like "61859" on
    // live-action series; null or the broken literal "[object Object]"
    // on anime — both yield None, since read_numeric_id's str branch
    // does a numeric parse). Widened to i64 for the publicmetadb lookup.
    let tmdb_id = read_numeric_id(meta, &["_tmdbId", "tmdbId", "tmdb_id"])
        .map(i64::from);
    crate::devlog!(
        info, "meta",
        "[{}] anime ids: mal={mal_id:?} kitsu={kitsu_id:?} anidb={anidb_id:?} tmdb={tmdb_id:?}",
        label,
    );

    // ── AIOMetadata extensions ─────────────────────────────────────────
    // `originalLanguage` is a single ISO 639-1 string. Try the canonical
    // camelCase first, then fall back to snake_case (`original_language`)
    // since some forks of AIOMetadata may emit either shape.
    let original_language = meta
        .get("originalLanguage")
        .or_else(|| meta.get("original_language"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s.len() <= 8);

    // `productionCountries` is an array of ISO 3166-1 alpha-2 codes.
    // Same camelCase / snake_case fallback. Cap to 8 entries.
    let production_countries: Vec<String> = meta
        .get("productionCountries")
        .or_else(|| meta.get("production_countries"))
        .or_else(|| meta.get("origin_country"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty() && s.len() <= 4)
                .take(8)
                .map(|s| s.trim().to_uppercase())
                .collect()
        })
        .unwrap_or_default();

    // One diagnostic line per fetch so we can see whether AIOMetadata is
    // actually surfacing the new fields. When `originalLanguage` is
    // missing, dump the top-level meta keys so the user can see what
    // AIOMetadata actually returned and report it back to the addon.
    crate::devlog!(
        info, "meta",
        "[{}] aio fields: originalLanguage={:?} productionCountries={:?}",
        label, original_language, production_countries,
    );
    if original_language.is_none() {
        let keys: Vec<&str> = meta.as_object()
            .map(|o| o.keys().map(|s| s.as_str()).collect::<Vec<_>>())
            .unwrap_or_default();
        if keys.is_empty() {
            // The addon returned no meta object at all. Expected and
            // common for search/catalog-only addons that get probed
            // during hover (e.g. AI Search) — NOT a warning condition;
            // keep it at debug so it doesn't flood the DevConsole on
            // every hover.
            crate::devlog!(
                debug, "meta",
                "[{}] no meta object returned — nothing to enrich", label,
            );
        } else {
            // A populated meta that simply lacks originalLanguage —
            // mildly notable for AIOMetadata field-coverage diagnostics,
            // but still not an error: info, not warn.
            crate::devlog!(
                info, "meta",
                "[{}] originalLanguage missing; meta keys present: {:?}",
                label, keys,
            );
        }
    }

    // ── seasonCredits + aggregateCredits ────────────────────────────────
    // TMDB / TVDB-only. AIOMetadata stamps these under `app_extras` for
    // series; movies and MAL-meta anime never carry them. We parse
    // tolerantly — any missing field collapses to None so the React
    // side falls back to show-level cast cleanly.
    let season_credits_raw = meta.pointer("/app_extras/seasonCredits");
    let season_credits: std::collections::BTreeMap<u32, SeasonCredits> = season_credits_raw
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    let season = k.parse::<u32>().ok()?;
                    let entry = parse_season_credits(v)?;
                    Some((season, entry))
                })
                .collect()
        })
        .unwrap_or_default();

    let aggregate_credits_raw = meta.pointer("/app_extras/aggregateCredits");
    let aggregate_credits: Option<AggregateCredits> = aggregate_credits_raw
        .and_then(parse_aggregate_credits);

    // Diagnostic: surface what the addon shipped vs what we parsed so
    // the user can tell at a glance whether a "cast doesn't swap on
    // season change" report is the addon not emitting seasonCredits
    // for that title vs Aura failing to parse it.
    let agg_cast_count = aggregate_credits.as_ref().map(|a| a.cast.len()).unwrap_or(0);
    crate::devlog!(
        info, "meta",
        "[{}] credits: seasonCredits raw={} parsed={} season(s) aggregateCredits raw={} parsed_cast={}",
        label,
        season_credits_raw.is_some(),
        season_credits.len(),
        aggregate_credits_raw.is_some(),
        agg_cast_count,
    );

    // ── Trailer YouTube id ─────────────────────────────────────────────
    // Stremio v5 metas expose `trailerStreams: [{ytId, title}]`; the older
    // Cinemeta shape uses `trailers: [{source, type}]` where `source` is a
    // bare id or a YouTube URL. Take the first usable entry; a missing or
    // non-YouTube source yields None and the "Watch Trailer" button is
    // suppressed. MPV can't open a YouTube page directly — the frontend
    // hands this id to `resolve_trailer_url` (yt-dlp) for a direct CDN URL.
    fn extract_yt_id(raw: &str) -> Option<String> {
        let s = raw.trim();
        let is_id = |t: &str| {
            t.len() == 11 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        };
        if is_id(s) {
            return Some(s.to_string());
        }
        // `watch?v=<id>` query form.
        if let Some(idx) = s.find("v=") {
            let cand: String = s[idx + 2..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect();
            if is_id(&cand) {
                return Some(cand);
            }
        }
        // Path forms: youtu.be/<id>, /embed/<id>, /shorts/<id>.
        for marker in ["youtu.be/", "/embed/", "/shorts/"] {
            if let Some(idx) = s.find(marker) {
                let cand: String = s[idx + marker.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if is_id(&cand) {
                    return Some(cand);
                }
            }
        }
        None
    }
    let trailer_yt_id: Option<String> = meta
        .pointer("/trailerStreams/0/ytId")
        .and_then(|v| v.as_str())
        .and_then(extract_yt_id)
        .or_else(|| {
            meta.pointer("/trailers/0/source")
                .and_then(|v| v.as_str())
                .and_then(extract_yt_id)
        });

    Ok(MetaDetail {
        id:           json_str(meta, "id", 256).unwrap_or_default(),
        name:         json_str(meta, "name", 200).unwrap_or_default(),
        media_type:   json_str(meta, "type", 32).unwrap_or_default(),
        poster:       json_url(meta, "poster"),
        background:   json_url(meta, "background"),
        logo:         json_url(meta, "logo"),
        description:  json_str(meta, "description", 4000),
        release_info: json_str(meta, "releaseInfo", 64),
        released:     json_str(meta, "released", 64),
        runtime:      json_str(meta, "runtime", 32),
        imdb_rating:  json_str(meta, "imdbRating", 8),
        genres,
        cast,
        cast_detailed,
        director,
        writer,
        producer,
        producer_detailed,
        composer,
        voice_actors,
        studios,
        creator,
        country:      json_str(meta, "country", 64),
        original_language,
        production_countries,
        ratings,
        videos,
        mal_id,
        kitsu_id,
        anidb_id,
        tmdb_id,
        season_credits,
        aggregate_credits,
        status:       json_str(meta, "status", 32),
        trailer_yt_id,
    })
}

/// Parse one season's `{cast, crew, name, overview, airDate, poster}`
/// payload into our typed `SeasonCredits`. Caps mirror the show-level
/// extractor (20 entries × 64 chars per field) so a TMDB series with
/// 60+ guest stars can't blow up memory. Returns `None` if the value
/// isn't an object so the BTreeMap parse loop drops it cleanly.
fn parse_season_credits(v: &serde_json::Value) -> Option<SeasonCredits> {
    let obj = v.as_object()?;
    let str_field = |k: &str, max: usize| -> Option<String> {
        obj.get(k).and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| cap(s.to_string(), max))
    };
    let cast = cast_members_from_objects(obj.get("cast"), 20, 64);
    let crew: Vec<CrewMember> = obj.get("crew")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(|n| n.as_str())?;
                    if name.is_empty() { return None; }
                    let job  = c.get("job").and_then(|n| n.as_str()).unwrap_or("");
                    if job.is_empty() { return None; }
                    let department = c.get("department").and_then(|d| d.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| cap(s.to_string(), 64));
                    let photo = c.get("photo").and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .and_then(|s| sanitize_url(Some(s.to_string())));
                    Some(CrewMember {
                        name: cap(name.to_string(), 64),
                        job:  cap(job.to_string(), 64),
                        department,
                        photo,
                    })
                })
                .take(20)
                .collect()
        })
        .unwrap_or_default();
    Some(SeasonCredits {
        name:     str_field("name", 200),
        overview: str_field("overview", 4000),
        air_date: str_field("airDate", 32),
        poster:   sanitize_url(str_field("poster", 512)),
        cast,
        crew,
    })
}

/// Parse `app_extras.aggregateCredits` (TMDB-only) into our typed
/// `AggregateCredits`. Returns `None` when the payload isn't an object
/// so the caller can fall through to the show-level cast cleanly.
fn parse_aggregate_credits(v: &serde_json::Value) -> Option<AggregateCredits> {
    let obj = v.as_object()?;
    let cast: Vec<AggCast> = obj.get("cast")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(|n| n.as_str())?;
                    if name.is_empty() { return None; }
                    let character = c.get("character").and_then(|n| n.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| cap(s.to_string(), 128));
                    let photo = c.get("photo").and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .and_then(|s| sanitize_url(Some(s.to_string())));
                    let total_episode_count = c.get("totalEpisodeCount")
                        .and_then(|n| n.as_u64())
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let roles: Vec<RoleSpan> = c.get("roles")
                        .and_then(|x| x.as_array())
                        .map(|rs| rs.iter().filter_map(|r| {
                            let character = r.get("character").and_then(|c| c.as_str())
                                .filter(|s| !s.is_empty())?;
                            let episode_count = r.get("episodeCount")
                                .and_then(|n| n.as_u64())
                                .and_then(|n| u32::try_from(n).ok())
                                .unwrap_or(0);
                            Some(RoleSpan {
                                character: cap(character.to_string(), 128),
                                episode_count,
                            })
                        }).take(10).collect())
                        .unwrap_or_default();
                    Some(AggCast {
                        name: cap(name.to_string(), 64),
                        character,
                        photo,
                        total_episode_count,
                        roles,
                    })
                })
                .take(40)
                .collect()
        })
        .unwrap_or_default();
    let crew: Vec<AggCrew> = obj.get("crew")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|c| {
                    let name = c.get("name").and_then(|n| n.as_str())?;
                    if name.is_empty() { return None; }
                    let department = c.get("department").and_then(|d| d.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| cap(s.to_string(), 64));
                    let photo = c.get("photo").and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .and_then(|s| sanitize_url(Some(s.to_string())));
                    let total_episode_count = c.get("totalEpisodeCount")
                        .and_then(|n| n.as_u64())
                        .and_then(|n| u32::try_from(n).ok())
                        .unwrap_or(0);
                    let jobs: Vec<JobSpan> = c.get("jobs")
                        .and_then(|x| x.as_array())
                        .map(|js| js.iter().filter_map(|j| {
                            let job = j.get("job").and_then(|j| j.as_str())
                                .filter(|s| !s.is_empty())?;
                            let episode_count = j.get("episodeCount")
                                .and_then(|n| n.as_u64())
                                .and_then(|n| u32::try_from(n).ok())
                                .unwrap_or(0);
                            Some(JobSpan {
                                job: cap(job.to_string(), 64),
                                episode_count,
                            })
                        }).take(10).collect())
                        .unwrap_or_default();
                    Some(AggCrew {
                        name: cap(name.to_string(), 64),
                        department,
                        jobs,
                        total_episode_count,
                        photo,
                    })
                })
                .take(40)
                .collect()
        })
        .unwrap_or_default();
    Some(AggregateCredits { cast, crew })
}

/// Repair video ids whose prefix is a JS-stringified bogus value (typically
/// `undefined`, but also `null` / `NaN` / `[object Object]`). Returns the
/// repaired id and whether a repair was performed; falls back to the raw id
/// when we don't have enough context to rebuild it (no parent id, no
/// season/episode on the entry).
fn repair_broken_video_id(raw_id: &str, parent_id: &str, video: &serde_json::Value) -> (String, bool) {
    const BROKEN_PREFIXES: &[&str] = &[
        "undefined:",
        "null:",
        "NaN:",
        "[object Object]:",
    ];
    let is_broken = BROKEN_PREFIXES.iter().any(|p| raw_id.starts_with(p));
    if !is_broken || parent_id.is_empty() {
        return (raw_id.to_string(), false);
    }
    let season = video.get("season").and_then(|x| x.as_i64()).unwrap_or(0);
    let episode = video.get("episode").and_then(|x| x.as_i64()).unwrap_or(0);
    if season == 0 || episode == 0 {
        return (raw_id.to_string(), false);
    }
    (format!("{}:{}:{}", parent_id, season, episode), true)
}

/// Parse an addon's `videos` array into typed entries. Episode IDs are
/// preserved verbatim — `kitsu:12345:1`, `tt0903747:1:5`, etc. — because
/// addons key streams off these strings exactly.
///
/// Exception: an addon-side bug seen in AIOMetadata for newer shows (Witch Hat
/// Atelier tt32550889 being the first reproduction) serves video entries with
/// `id: "undefined:1:1"` — the addon's template literal references a field
/// that's undefined for the show, and JS happily stringifies it. Without
/// repair the literal "undefined" prefix flows into fetch_streams, every
/// addon's id-prefix gate rejects it, and the user gets zero streams for an
/// otherwise-supported title. We rebuild the prefix from the parent meta id
/// when we detect this pattern; episode addons keyed off the canonical
/// `<imdb>:<s>:<e>` shape then resolve normally.
fn extract_videos(meta: &serde_json::Value) -> Vec<VideoEntry> {
    let parent_id = meta.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let Some(arr) = meta.get("videos").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut repaired_count: usize = 0;
    let videos: Vec<VideoEntry> = arr.iter()
        .take(2000) // generous cap; long-running anime can have 1000+ episodes
        .filter_map(|v| {
            // ID is required — without it we can't fetch streams.
            let raw_id = v.get("id").and_then(|x| x.as_str())?;
            let (repaired_id, was_repaired) = repair_broken_video_id(raw_id, parent_id, v);
            if was_repaired { repaired_count += 1; }
            // Cap at 256 — preserves the longest realistic episode IDs without
            // truncating multi-segment forms. We DON'T strip colons, slashes,
            // or other addon-specific path tokens.
            let id = cap(repaired_id, 256);

            // Name fallback hierarchy: title → name → "Episode N"
            let title = v
                .get("title").and_then(|x| x.as_str())
                .or_else(|| v.get("name").and_then(|x| x.as_str()))
                .map(|s| cap(s.into(), 240))
                .unwrap_or_default();

            // Episode kind — AIOMetadata's canonical contract emits
            // top-level booleans `filler: bool` and `recap: bool` on
            // every video (never undefined). We also accept a small
            // family of historical string aliases (`episodeKind`,
            // `episode_kind`, `kind`, `episodeType`, `episode_type`)
            // for addons that follow the Jikan/AniList per-episode
            // type-tag convention, mapping the canonical vocabulary
            // (filler / recap / canon / normal / mixed). Unknown
            // strings drop to None so the UI renders the standard row.
            let string_kind = ["episodeKind", "episode_kind", "kind", "episodeType", "episode_type"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
                .map(|s| s.to_lowercase())
                .filter(|s| matches!(s.as_str(), "filler" | "recap" | "normal" | "canon" | "mixed"));
            // Independent boolean flags — AIOMetadata's canonical wire
            // shape per release-search-spec §6.3. Both can be true on
            // the same episode; downstream code renders both banners.
            let is_filler = v.get("filler").and_then(|x| x.as_bool()).unwrap_or(false)
                || string_kind.as_deref() == Some("filler");
            let is_recap = v.get("recap").and_then(|x| x.as_bool()).unwrap_or(false)
                || string_kind.as_deref() == Some("recap");
            // Back-compat single-value field — preserves the existing
            // consumer surfaces (CinemaRows banners, autoAdvance
            // filter) while the new flags carry the full info. Filler
            // wins when both are true.
            let episode_kind = string_kind.or_else(|| {
                if is_filler { Some("filler".to_string()) }
                else if is_recap { Some("recap".to_string()) }
                else { None }
            });

            // Embedded AniList pair (Aura<->AIOMetadata scrobble contract).
            // Canonical wire key is camelCase (`anilistId` / `anilistEpisode`),
            // matching the addon's `episodeKind` convention; snake_case aliases
            // accepted for safety. Positive-only (a 0 / negative id is bogus).
            let anilist_id = ["anilistId", "anilist_id"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_i64()))
                .filter(|&n| n > 0);
            let anilist_episode = ["anilistEpisode", "anilist_episode"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_i64()))
                .filter(|&n| n > 0);

            Some(VideoEntry {
                id,
                title,
                season:    v.get("season")  .and_then(|x| x.as_i64()),
                episode:   v.get("episode") .and_then(|x| x.as_i64()),
                released:  json_str(v, "released",     64),
                thumbnail: json_url(v, "thumbnail"),
                overview:  json_str(v, "overview", 600),
                episode_kind,
                is_filler,
                is_recap,
                anilist_id,
                anilist_episode,
            })
        })
        .collect();

    // Summary log: how many of the parsed videos carry a recognised
    // filler/recap kind. Lets the user see at a glance whether the
    // wire actually emits truthy flags — useful when banners aren't
    // appearing (either the addon's sending all-false or the addon
    // doesn't carry the field at all). Also surfaces the presence/
    // absence of the canonical field names so a wire-shape mismatch
    // is diagnosable without the per-episode noise the previous log
    // produced.
    if !videos.is_empty() {
        let filler_count = videos.iter().filter(|v| v.episode_kind.as_deref() == Some("filler")).count();
        let recap_count  = videos.iter().filter(|v| v.episode_kind.as_deref() == Some("recap")).count();
        let canonical_keys_present = arr.first()
            .map(|first| ["filler", "recap"]
                .iter()
                .filter(|k| first.get(*k).is_some())
                .copied()
                .collect::<Vec<_>>())
            .unwrap_or_default();
        crate::devlog!(
            info, "meta",
            "extract_videos: parsed {} videos ({} filler, {} recap); canonical fields on first entry: {:?}",
            videos.len(), filler_count, recap_count, canonical_keys_present,
        );
        if repaired_count > 0 {
            crate::devlog!(
                warn, "meta",
                "extract_videos: repaired {repaired_count} video id(s) with bogus prefix (e.g. \"undefined:S:E\") \
                 — addon emitted a JS-stringified missing field. Reconstructed from parent meta id."
            );
        }
    }
    videos
}

/// Helper — pull a string array from arbitrary serde_json::Value, capping
/// per-element length and total entry count.
fn string_array(v: &serde_json::Value, field: &str, max: usize, per_entry: usize) -> Vec<String> {
    v.get(field)
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| cap(s.to_string(), per_entry)))
                .take(max)
                .collect()
        })
        .unwrap_or_default()
}

/// Try a list of candidate field names in order; first one whose value is a
/// non-empty array of strings wins. Used for crew fields that AIOMetadata and
/// other addons spell differently (`producers` vs `producer`, etc.).
fn string_array_any(
    v: &serde_json::Value,
    candidates: &[&str],
    max: usize,
    per_entry: usize,
) -> Vec<String> {
    for field in candidates {
        let out = string_array(v, field, max, per_entry);
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
}

/// Parse a comma-joined string field ("Tim Burton, John Doe") into a vec.
/// AIOMetadata emits `director` and `writer` in this shape for live-action
/// titles instead of the canonical Stremio array — caller falls back to
/// this when `string_array` returned empty.
fn comma_split(v: &serde_json::Value, field: &str, max: usize, per_entry: usize) -> Vec<String> {
    v.get(field)
        .and_then(|x| x.as_str())
        .map(|s| {
            s.split(", ")
                .map(|x| x.trim())
                .filter(|x| !x.is_empty())
                .take(max)
                .map(|x| cap(x.to_string(), per_entry))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

/// Combined "array OR comma-joined string" reader. Used for fields like
/// `director` / `writer` where AIOMetadata ships a comma-joined string
/// for live-action and an empty array for anime, while other addons
/// (Cinemeta, etc.) ship a real array. Tries the array form across
/// every candidate first, then falls back to comma-split on each in order.
fn array_or_comma(
    v: &serde_json::Value,
    candidates: &[&str],
    max: usize,
    per_entry: usize,
) -> Vec<String> {
    let arr = string_array_any(v, candidates, max, per_entry);
    if !arr.is_empty() {
        return arr;
    }
    for field in candidates {
        let split = comma_split(v, field, max, per_entry);
        if !split.is_empty() {
            return split;
        }
    }
    Vec::new()
}

/// Rich variant — preserves the character /
/// role and headshot URL alongside each name. Mirrors AIOMetadata's
/// `app_extras.cast: [{ name, character, photo }]` shape directly.
/// Empty fields collapse to `None` so the frontend can decide whether
/// to render an "as character" suffix or a hover photo.
fn cast_members_from_objects(
    arr: Option<&serde_json::Value>,
    max: usize,
    per_entry: usize,
) -> Vec<CastMember> {
    arr.and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|o| {
                    let name = o.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if name.is_empty() { return None; }
                    let character = o.get("character")
                        .and_then(|c| c.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| cap(s.to_string(), per_entry));
                    let photo = o.get("photo")
                        .and_then(|p| p.as_str())
                        .filter(|s| !s.is_empty())
                        .and_then(|s| sanitize_url(Some(s.to_string())));
                    Some(CastMember {
                        name: cap(name.to_string(), per_entry),
                        character,
                        photo,
                    })
                })
                .take(max)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Commands — Stremio library sync (Phase 3 Task B)
//
// The Stremio account API uses a generic key/value datastore for the
// `libraryItem` collection. Each item carries playback state (timeOffset,
// resolved video id, etc.) plus poster/background/logo metadata.
//
// We fetch every (non-removed) library item; the frontend filters into
// "Continue Watching" (state.timeOffset > 0) and the calendar source set.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn library_get(auth_key: String) -> Result<Vec<LibraryItem>, String> {
    let body = serde_json::json!({
        "authKey":    auth_key,
        "collection": "libraryItem",
        "all":        true,
    });

    let raw = account_client()
        .post(format!("{STREMIO_ACCOUNT_API}/datastoreGet"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .error_for_status()
        .map_err(|e| {
            if e.status().map(|s| s.as_u16()) == Some(401) { SESSION_EXPIRED.into() }
            else { format!("HTTP error: {e}") }
        })?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON parse error: {e}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(map_api_error(err));
    }

    let items = json
        .pointer("/result")
        .and_then(|v| v.as_array())
        .ok_or("Library result missing")?;

    Ok(items
        .iter()
        .filter_map(|v| serde_json::from_value::<LibraryItem>(v.clone()).ok())
        .filter(|i| !i.removed)
        .map(|mut i| {
            // Sanitize URLs & cap text on the way out so a malformed library
            // entry can't blow up the UI.
            i.poster     = sanitize_url(i.poster);
            i.background = sanitize_url(i.background);
            i.logo       = sanitize_url(i.logo);
            i.name       = cap(i.name, 200);
            i
        })
        .collect())
}

/// Push a list of library item changes to the Stremio cloud. The frontend
/// constructs the change objects (must include `_id`, `_mtime`, `removed`,
/// `state`, etc.) and we forward them verbatim.
#[tauri::command]
pub async fn library_put(
    auth_key: String,
    changes: Vec<serde_json::Value>,
) -> Result<(), String> {
    // Per-change diagnostic line. Helps the user (via DevConsole) confirm
    // exactly which records hit the wire and what flags they carried —
    // particularly useful when an "I clicked remove but it's still there"
    // problem turns out to be a stale cache vs. a failed write.
    for change in &changes {
        let id = change.get("_id").and_then(|v| v.as_str()).unwrap_or("?");
        let removed = change
            .get("removed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let temp = change
            .get("temp")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let mtime = change
            .get("_mtime")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let kind = if removed { "REMOVE" } else { "PUT" };
        crate::devlog!(
            info,
            "library",
            "{} id={} temp={} mtime={}",
            kind, id, temp, mtime
        );
    }

    let body = serde_json::json!({
        "authKey":    auth_key,
        "collection": "libraryItem",
        "changes":    changes,
    });

    let resp = account_client()
        .post(format!("{STREMIO_ACCOUNT_API}/datastorePut"))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            crate::devlog!(warn, "library", "datastorePut network error: {}", e);
            format!("Network error: {e}")
        })?
        .error_for_status()
        .map_err(|e| {
            let status = e.status().map(|s| s.as_u16()).unwrap_or(0);
            crate::devlog!(warn, "library", "datastorePut HTTP {}: {}", status, e);
            if status == 401 { SESSION_EXPIRED.into() }
            else { format!("HTTP error: {e}") }
        })?;

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("JSON parse error: {e}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        crate::devlog!(warn, "library", "datastorePut API error: {}", err);
        return Err(map_api_error(err));
    }

    crate::devlog!(info, "library", "datastorePut OK ({} changes)", changes.len());
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands — stream aggregation (Phase 5 Detail View)
//
// Fans out across every installed addon that exposes the `stream` resource,
// fetching `/stream/{type}/{id}.json` in parallel. Results are sanitized,
// deduplicated by (url | infoHash), and tagged with the source addon's name
// so the UI can group by provider.
// ---------------------------------------------------------------------------

/// Normalise an addon URL into a clean *base* form (no trailing slash, no
/// `/manifest.json` suffix). Used as a defensive guard so addons that were
/// stored with `/manifest.json` in the URL still resolve cleanly when we
/// build `/stream/...` paths off them.
fn normalise_addon_base(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches("/manifest.json")
        .trim_end_matches('/')
        .to_string()
}

// ---------------------------------------------------------------------------
// Landscape (16:9) art — AIOMeta art-resolution endpoint.
//
// AIOMeta owns art resolution (Fanart thumb → AniList banner → TMDB
// backdrop → TVDB bg → poster-crop, with language/provider matching and
// id-resolution Aura can't replicate client-side). Aura just asks for the
// resolved 16:9 image + whether the title is already baked into it, so the
// Continue-Watching card can render proper landscape art instead of a
// portrait poster cropped into a 16:9 box.
//
// The endpoint lives on the user's AIOMeta install (the same per-user base
// as the meta route, userUUID embedded in `addon_url`):
//   GET {base}/api/art/landscape/{type}/{id}.json[?w=N]
//
// Best-effort: any failure (endpoint not yet deployed, network, parse)
// returns an empty result so the card falls back to its existing
// background/poster chain rather than erroring.
// ---------------------------------------------------------------------------

/// Resolved landscape art for one title. Deserialised from AIOMeta's
/// camelCase JSON (`hasBakedTitle` / `dominantColor`) via deserialize-only
/// renames, then re-serialised to React using the Rust field names — so the
/// `LandscapeArt` TS interface reads snake_case (`has_baked_title` /
/// `dominant_color`). See the `LibraryItem` note in CLAUDE.md for why the
/// rename is deserialize-only.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LandscapeArt {
    #[serde(default)]
    pub id: String,
    /// The chosen 16:9 image URL. `None` when AIOMeta found nothing usable.
    #[serde(default)]
    pub landscape: Option<String>,
    /// Provenance, e.g. "fanart-thumb" | "anilist-banner" | "tmdb-backdrop"
    /// | "tvdb-bg" | "poster-crop".
    #[serde(default)]
    pub source: Option<String>,
    /// True when the title is already burned into `landscape` (Fanart thumb
    /// etc.) — the client renders the image alone. When false the client may
    /// overlay `logo` + a scrim.
    #[serde(default, rename(deserialize = "hasBakedTitle"))]
    pub has_baked_title: bool,
    /// Language-matched logo for client overlay when `has_baked_title` is
    /// false.
    #[serde(default)]
    pub logo: Option<String>,
    /// Vertical poster fallback so the client never shows a blank tile.
    #[serde(default)]
    pub poster: Option<String>,
    /// Optional dominant colour (`#rrggbb`) for scrim / loading placeholder.
    #[serde(default, rename(deserialize = "dominantColor"))]
    pub dominant_color: Option<String>,
}

/// Resolve 16:9 landscape art for a title from the user's AIOMeta addon.
/// `width` is an optional server-side resize hint (px). Returns an empty
/// `LandscapeArt` rather than erroring when the endpoint is unavailable, so
/// the caller falls back to its own art chain.
#[tauri::command]
pub async fn fetch_landscape_art(
    addon_url: String,
    media_type: String,
    id: String,
    width: Option<u32>,
) -> Result<LandscapeArt, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    let mut url = format!("{base}/api/art/landscape/{media_type}/{id}.json");
    if let Some(w) = width {
        url.push_str(&format!("?w={w}"));
    }
    let label = log_label("", &base);

    let resp = match client().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            // Endpoint not deployed yet / network blip — quiet, the card
            // falls back to its existing background/poster.
            crate::devlog!(debug, "meta", "[{}] landscape art fetch failed: {}", label, e);
            return Ok(LandscapeArt::default());
        }
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(debug, "meta", "[{}] landscape art HTTP {:?}", label, e.status());
            return Ok(LandscapeArt::default());
        }
    };
    match resp.json::<LandscapeArt>().await {
        Ok(mut art) => {
            // Baked-title backstop, ALLOWLIST form. AIOMeta's
            // hasBakedTitle detection under-reports (the client then
            // overlays its own logo on top of a baked one — double-title
            // CW cards). The first fix denylisted fanart-thumb/
            // poster-crop, but doubles persisted on other titles —
            // either the wire `source` strings differ from the spec'd
            // provenance values or AniList banners carry baked logos
            // (they very often do; banners are key art). So: trust
            // hasBakedTitle=false ONLY for sources that are textless by
            // PLATFORM RULE — TMDB backdrops and TVDB backgrounds both
            // mandate no text/logos in their submission guidelines.
            // Everything else (fanart thumbs, AniList banners, poster
            // crops, unknown/new sources) is treated as already-titled,
            // which kills the entire double-logo class at the single
            // resolution boundary. Worst case is a missing overlay on a
            // genuinely-textless banner — the card prints the title
            // underneath regardless.
            if !art.has_baked_title {
                let textless_by_rule = matches!(
                    art.source.as_deref(),
                    Some("tmdb-backdrop") | Some("tvdb-bg"),
                );
                if !textless_by_rule {
                    crate::devlog!(
                        debug, "meta",
                        "[{}] landscape art source '{}' not textless-by-rule — overriding hasBakedTitle=false",
                        label,
                        art.source.as_deref().unwrap_or(""),
                    );
                    art.has_baked_title = true;
                }
            }
            Ok(art)
        }
        Err(e) => {
            crate::devlog!(debug, "meta", "[{}] landscape art parse error: {}", label, e);
            Ok(LandscapeArt::default())
        }
    }
}

/// Cached-metadata version of the stream-resource gate — used by
/// fetch_streams so we don't have to re-fetch every addon's manifest on
/// every request. Reads `resources` / `stream_types` / `id_prefixes` /
/// `stream_id_prefixes` straight off the persisted AddonEntry. Returns
/// `(supports, declared_stream_types_for_logging)`.
fn addon_entry_supports_stream_for(
    addon: &AddonEntry,
    media_type: &str,
    id: &str,
) -> (bool, Option<Vec<String>>) {
    let has_stream = addon
        .resources
        .iter()
        .any(|r| r.eq_ignore_ascii_case("stream"));
    if !has_stream {
        return (false, None);
    }
    // The stream resource's per-resource `types` (if declared) takes
    // precedence; otherwise fall back to the manifest-level `types`.
    let supported = if !addon.stream_types.is_empty() {
        &addon.stream_types
    } else {
        &addon.types
    };
    let declared = if !addon.stream_types.is_empty() {
        Some(addon.stream_types.clone())
    } else {
        None
    };
    let type_ok = supported.is_empty()
        || supported.iter().any(|t| t.eq_ignore_ascii_case(media_type));
    if !type_ok {
        return (false, declared);
    }
    // idPrefixes gate. Per-resource override > manifest-level. Empty list
    // = "accepts every prefix".
    let prefixes: &Vec<String> = if !addon.stream_id_prefixes.is_empty() {
        &addon.stream_id_prefixes
    } else {
        &addon.id_prefixes
    };
    if !prefixes.is_empty()
        && !prefixes.iter().any(|p| id.starts_with(p))
    {
        return (false, declared);
    }
    (true, declared)
}

/// Per-task return type for the addon fan-out — the streams plus the four
/// AIOStreams metadata arrays from a single addon's response.
struct AddonFetchOutput {
    streams: Vec<StreamEntry>,
    errors: Vec<StreamMessage>,
    warnings: Vec<StreamMessage>,
    info: Vec<StreamMessage>,
    stats: Vec<StreamMessage>,
}

impl AddonFetchOutput {
    fn empty() -> Self {
        Self {
            streams: Vec::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
            info: Vec::new(),
            stats: Vec::new(),
        }
    }
}

#[tauri::command]
pub async fn fetch_streams(
    addons: Vec<AddonEntry>,
    media_type: String,
    id: String,
) -> Result<StreamFetchResult, String> {
    if addons.is_empty() {
        crate::devlog!(warn, "streams", "fetch_streams: no addons installed");
        return Ok(StreamFetchResult {
            streams: vec![],
            metadata: StreamMetadata::default(),
        });
    }
    // 256 fits the longest realistic IDs (multi-segment anime / episode forms
    // like `kitsu:12345:1` or `tt0903747:1:5`) without ever truncating valid
    // input. We DO NOT strip colons, slashes, or other addon-specific tokens —
    // addons key streams off the exact id string.
    let safe_type = cap(media_type, 64);
    let safe_id   = cap(id, 256);

    crate::devlog!(
        info,
        "streams",
        "fetch_streams type={safe_type} id={safe_id} addons={}",
        addons.len()
    );

    let mut set: tokio::task::JoinSet<AddonFetchOutput> = tokio::task::JoinSet::new();

    for addon in addons {
        let media_type = safe_type.clone();
        let id         = safe_id.clone();
        set.spawn(async move {
            let base = normalise_addon_base(&addon.url);
            let label = log_label(&addon.name, &base);

            // Use the AddonEntry's CACHED manifest metadata. We used to
            // re-fetch the manifest on every fetch_streams call which made
            // a single transient network failure cascade into "no streams
            // found" for every addon, including ones that were perfectly
            // healthy. The cache is populated at addon install time
            // (add_addon / cloud_add_addon / get_synced_addons) so we
            // already know each addon's resources, types, and idPrefixes.
            let (supports, declared) = addon_entry_supports_stream_for(&addon, &media_type, &id);
            if !supports {
                if declared.is_some() {
                    crate::devlog!(
                        info,
                        "streams",
                        "[{}] declares stream types {:?}, skipping {} {} (type or id-prefix mismatch)",
                        label, declared.unwrap_or_default(), media_type, id
                    );
                } else {
                    crate::devlog!(
                        info,
                        "streams",
                        "[{}] has no stream resource, skipping",
                        label
                    );
                }
                return AddonFetchOutput::empty();
            }
            let addon_name = addon.name.clone();

            let url = format!("{base}/stream/{media_type}/{id}.json");
            crate::devlog!(info, "streams", "[{}] GET {}", label, redact_sensitive_url(&url));

            // Per-request 35 s timeout overrides the global 10 s default.
            // AIOStreams orchestrators (TorBox Search, MediaFusion, etc.)
            // can take 25-30 s upstream when one of their backing
            // scrapers is timing out — a 10 s client cap turned those
            // into spurious "no streams found" failures even though the
            // server would have eventually responded. 35 s is generous
            // enough to cover the worst observed AIOStreams latency
            // without making the UI feel hung when an addon is genuinely
            // unreachable.
            let resp = match client()
                .get(&url)
                .timeout(Duration::from_secs(35))
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let cat = describe_reqwest_err(&e);
                    crate::devlog!(
                        warn,
                        "streams",
                        "[{}] {}: {}",
                        label, cat, e
                    );
                    return AddonFetchOutput::empty();
                }
            };
            let status = resp.status();
            if !status.is_success() {
                crate::devlog!(
                    warn,
                    "streams",
                    "[{}] HTTP {} for {}",
                    label, status.as_u16(), url
                );
                return AddonFetchOutput::empty();
            }

            let json = match resp.json::<serde_json::Value>().await {
                Ok(j) => j,
                Err(e) => {
                    crate::devlog!(
                        warn,
                        "streams",
                        "[{}] JSON parse failed: {}",
                        label, e
                    );
                    return AddonFetchOutput::empty();
                }
            };

            // Parse AIOStreams metadata payloads. The structured /api/search
            // endpoint exposes named arrays (errors / warnings / info /
            // statistics) at the top level; the public Stremio addon
            // endpoint instead interleaves these into the `streams` array
            // as pseudo-streams keyed by `streamData.type` (statistic |
            // error). We accept BOTH shapes here so the user sees notices
            // regardless of which endpoint the addon is configured to expose.
            let mut errors   = collect_messages(&json, "errors",     "error",   &addon_name);
            let mut warnings = collect_messages(&json, "warnings",   "warning", &addon_name);
            let info         = collect_messages(&json, "info",       "info",    &addon_name);
            let mut stats    = {
                // Both `statistics` and `stats` have appeared in the wild —
                // accept either, preferring the more specific name.
                let mut s = collect_messages(&json, "statistics", "stats",   &addon_name);
                if s.is_empty() {
                    s = collect_messages(&json, "stats", "stats", &addon_name);
                }
                s
            };

            let (playable_jsons, pseudo_notices) = match json
                .get("streams")
                .and_then(|v| v.as_array())
            {
                Some(arr) => partition_aio_pseudo_streams(arr, &addon_name),
                None => (Vec::new(), Vec::new()),
            };
            // Route partitioned pseudo-streams into the matching metadata
            // bucket — the existing UI reads from these four arrays.
            for n in pseudo_notices {
                match n.kind.as_str() {
                    "error"   => errors.push(n),
                    "warning" => warnings.push(n),
                    _         => stats.push(n), // "stats" is the info-blue bucket
                }
            }

            let raw_count = playable_jsons.len();
            let kept: Vec<StreamEntry> = playable_jsons
                .iter()
                .take(80)
                .filter_map(|s| sanitize_stream(s, &addon_name))
                .collect();
            crate::devlog!(
                info,
                "streams",
                "[{}] → {} streams (raw {}, kept {})",
                label, kept.len(), raw_count, kept.len()
            );

            if !errors.is_empty() || !warnings.is_empty() || !info.is_empty() || !stats.is_empty() {
                crate::devlog!(
                    info,
                    "streams",
                    "[{}] AIOStreams metadata: {} errors, {} warnings, {} info, {} stats",
                    label, errors.len(), warnings.len(), info.len(), stats.len()
                );
            }

            AddonFetchOutput { streams: kept, errors, warnings, info, stats }
        });
    }

    let mut all: Vec<StreamEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut metadata = StreamMetadata::default();
    while let Some(task_result) = set.join_next().await {
        if let Ok(out) = task_result {
            for s in out.streams {
                let key = s
                    .url
                    .clone()
                    .or_else(|| s.info_hash.clone())
                    .unwrap_or_else(|| s.title.clone());
                if seen.insert(key) {
                    all.push(s);
                }
            }
            metadata.errors.extend(out.errors);
            metadata.warnings.extend(out.warnings);
            metadata.info.extend(out.info);
            metadata.stats.extend(out.stats);
        }
    }

    crate::devlog!(
        info,
        "streams",
        "fetch_streams done: {} unique streams (msgs: {}E/{}W/{}I/{}S)",
        all.len(),
        metadata.errors.len(),
        metadata.warnings.len(),
        metadata.info.len(),
        metadata.stats.len(),
    );
    Ok(StreamFetchResult { streams: all, metadata })
}

/// Pluck an AIOStreams-style metadata array from the response and convert it
/// into typed StreamMessage values. Each entry may be:
///   • `{ title?, description?, message? }` object form, OR
///   • a bare string (treated as the description).
/// Empty / unparseable entries are silently dropped. Cap at 16 messages per
/// kind per addon so a malicious response can't blow up the panel.
fn collect_messages(
    root: &serde_json::Value,
    field: &str,
    kind: &str,
    addon_name: &str,
) -> Vec<StreamMessage> {
    let Some(arr) = root.get(field).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .take(16)
        .filter_map(|entry| {
            let (title, description) = match entry {
                serde_json::Value::String(s) => (None, s.trim().to_string()),
                serde_json::Value::Object(_) => {
                    let title = entry
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(|s| cap(s.trim().to_string(), 200))
                        .filter(|s| !s.is_empty());
                    let description = entry
                        .get("description")
                        .and_then(|v| v.as_str())
                        .or_else(|| entry.get("message").and_then(|v| v.as_str()))
                        .or_else(|| entry.get("text").and_then(|v| v.as_str()))
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    (title, description)
                }
                _ => return None,
            };
            // Skip rows with no usable text in either field.
            if title.is_none() && description.is_empty() {
                return None;
            }
            Some(StreamMessage {
                kind: kind.to_string(),
                title,
                description: cap(description, 1024),
                addon_name: cap(addon_name.to_string(), 64),
                forced: false,
            })
        })
        .collect()
}

/// Partition AIOStreams pseudo-streams (statistic / error) out of the
/// streams array. The Stremio addon endpoint (/stream/...) interleaves
/// these into the streams list with `streamData.type = "statistic" | "error"`
/// — they have no `url` / `infoHash` so sanitize_stream would drop them
/// silently, hiding the "Digital Release Filter" / "Removal Reasons"
/// warnings the user wants to see. We extract them BEFORE sanitize_stream
/// runs and route them into the existing metadata buckets:
///
///   • streamData.type == "error"     → metadata.errors
///   • statistic + category="filter"  → metadata.warnings (warning icon)
///   • statistic + category="timing"  → metadata.stats    (info icon, blue)
///   • statistic + category="addon"   → split by leading title-emoji
///       — 🟠 partial-success      → metadata.errors
///       — 🟢 clean / others       → metadata.stats
///
/// Category is read directly from `streamData.category` on the patched
/// AIOStreams fork (post-feat-surface-category-and-forced); falls back
/// to title-pattern inference for upstream / older instances. `forced`
/// is read from `streamData.forced` so the UI can keep showing notices
/// the user explicitly cannot suppress.
///
/// Returns `(playable_streams_json, notices)`. Caller feeds
/// `playable_streams_json` into the existing sanitize loop.
fn partition_aio_pseudo_streams(
    raw_streams: &[serde_json::Value],
    addon_name: &str,
) -> (Vec<serde_json::Value>, Vec<StreamMessage>) {
    let mut playable: Vec<serde_json::Value> = Vec::with_capacity(raw_streams.len());
    let mut notices:  Vec<StreamMessage>     = Vec::new();
    for entry in raw_streams.iter() {
        let stream_data = entry.get("streamData").and_then(|v| v.as_object());
        let pseudo_type = stream_data
            .and_then(|o| o.get("type"))
            .and_then(|v| v.as_str());
        match pseudo_type {
            Some("error") => {
                let (title, desc) = stream_data
                    .and_then(|o| o.get("error"))
                    .and_then(|e| e.as_object())
                    .map(|e| {
                        let t = e.get("title").and_then(|v| v.as_str()).unwrap_or("Addon error").to_string();
                        let d = e.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        (t, d)
                    })
                    .unwrap_or_else(|| {
                        // Fall back to the pseudo-stream's own name / description.
                        let t = entry.get("name").and_then(|v| v.as_str()).unwrap_or("Addon error").to_string();
                        let d = entry.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        (t, d)
                    });
                let forced = stream_data
                    .and_then(|o| o.get("forced"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                notices.push(StreamMessage {
                    kind: "error".to_string(),
                    title: Some(cap(title, 200)),
                    description: cap(desc, 1024),
                    addon_name: cap(addon_name.to_string(), 64),
                    forced,
                });
            }
            Some("statistic") => {
                let title_raw = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let description = entry.get("description").and_then(|v| v.as_str()).unwrap_or("");
                let category_wire = stream_data
                    .and_then(|o| o.get("category"))
                    .and_then(|v| v.as_str());
                let forced = stream_data
                    .and_then(|o| o.get("forced"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let category = category_wire
                    .and_then(parse_aio_category)
                    .unwrap_or_else(|| infer_aio_stat_category(title_raw));
                let kind = match category {
                    AioCategory::Filter => "warning",
                    AioCategory::Timing => "stats",
                    AioCategory::Addon  => {
                        // Leading emoji disambiguates: 🟠 = partial scrape (has errors), 🟢 = clean
                        if title_raw.trim_start().starts_with('🟠')
                            || title_raw.trim_start().starts_with('🔴')
                        {
                            "error"
                        } else {
                            "stats"
                        }
                    }
                };
                notices.push(StreamMessage {
                    kind: kind.to_string(),
                    title: Some(cap(title_raw.trim().to_string(), 200)),
                    description: cap(description.trim().to_string(), 4096),
                    addon_name: cap(addon_name.to_string(), 64),
                    forced,
                });
            }
            _ => {
                playable.push(entry.clone());
            }
        }
    }
    (playable, notices)
}

#[derive(Copy, Clone, Debug)]
enum AioCategory { Addon, Filter, Timing }

fn parse_aio_category(s: &str) -> Option<AioCategory> {
    match s {
        "addon"  => Some(AioCategory::Addon),
        "filter" => Some(AioCategory::Filter),
        "timing" => Some(AioCategory::Timing),
        _        => None,
    }
}

/// Title-pattern fallback for older AIOStreams instances that don't
/// surface streamData.category. Strips the leading emoji cluster, then
/// matches on the bare phrase. Anything unrecognised falls into Filter
/// since that bucket renders under the warning icon — safer than
/// burying an unknown notice in the info bucket.
fn infer_aio_stat_category(title: &str) -> AioCategory {
    let bare = strip_leading_emoji(title.trim()).trim();
    if bare.ends_with("Scrape Summary") {
        return AioCategory::Addon;
    }
    match bare {
        "Pipeline Timing"
        | "Filter Breakdown"
        | "Precompute Breakdown"
        | "Service Wrap Breakdown" => AioCategory::Timing,

        "Removal Reasons"
        | "Included Reasons"
        | "Digital Release Filter" => AioCategory::Filter,

        _ => AioCategory::Filter, // unknown future stat → safest bucket
    }
}

/// Strip one leading emoji cluster (the producers in AIOStreams use
/// 🔍 📅 🚫 ⏱️ ⚙️ 🔗 🟢 🟠 🔴) plus any combining variation selector
/// and the immediately-following whitespace. Lightweight: walks the
/// string and discards prefix codepoints that look like emoji.
fn strip_leading_emoji(s: &str) -> &str {
    let mut end = 0;
    for (i, c) in s.char_indices() {
        let is_emoji_prefix = (c as u32) >= 0x1F300       // misc symbols / pictographs +
            || ((c as u32) >= 0x2600 && (c as u32) <= 0x27BF) // misc + dingbats
            || c == '\u{FE0F}'                             // variation selector-16
            || c == '\u{200D}';                            // ZWJ
        if !is_emoji_prefix && !c.is_whitespace() {
            return &s[i..];
        }
        end = i + c.len_utf8();
    }
    &s[end..]
}

fn sanitize_stream(s: &serde_json::Value, addon_name: &str) -> Option<StreamEntry> {
    // Title is the primary display string; fall back to "name" then "<addon>".
    let raw_title = s
        .get("title")
        .and_then(|v| v.as_str())
        .or_else(|| s.get("name").and_then(|v| v.as_str()))
        .unwrap_or(addon_name);
    // Generous cap — addons like Torrentio pack resolution / codec / size /
    // seeder counts into multi-line titles. The frontend wants every byte for
    // chip-parsing; we trust the addon's content here.
    let title = cap(raw_title.to_string(), 1024);

    let url = s.get("url").and_then(|v| v.as_str()).map(String::from);
    let info_hash = s.get("infoHash").and_then(|v| v.as_str()).map(String::from);

    // A usable stream needs at least one of these.
    if url.is_none() && info_hash.is_none() {
        return None;
    }

    let url = url.and_then(|u| {
        let lower = u.to_lowercase();
        if (lower.starts_with("http://") || lower.starts_with("https://")) && u.len() <= 4096 {
            Some(u)
        } else {
            None
        }
    });

    // behaviorHints.filename — populated by AIOStreams (and some other
    // addons) with the raw release filename. Cap matches `title` to
    // protect against pathological addon payloads.
    let filename = s
        .get("behaviorHints")
        .and_then(|v| v.get("filename"))
        .and_then(|v| v.as_str())
        .map(|s| cap(s.to_string(), 512));

    // streamData.episodePack — AIOStreams (with PROVIDE_STREAM_DATA enabled)
    // sets this on a multi-episode / season-pack result whose actually-played
    // file can't be verified for a single-episode request. `None` when
    // streamData is absent (gated off, non-AIOStreams addon, or older build).
    // streamData is a sibling of the standard Stremio fields, NOT nested under
    // behaviorHints. Pseudo-streams (streamData.type "statistic"/"error") never
    // reach here — they're partitioned out before this sanitize loop runs.
    let episode_pack = s
        .get("streamData")
        .and_then(|v| v.get("episodePack"))
        .and_then(|v| v.as_bool());

    Some(StreamEntry {
        title,
        addon_name: cap(addon_name.to_string(), 64),
        url,
        info_hash:  info_hash.map(|h| cap(h, 80)),
        file_idx:   s.get("fileIdx").and_then(|v| v.as_i64()),
        description: s
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| cap(s.to_string(), 1024)),
        filename,
        episode_pack,
    })
}

// ---------------------------------------------------------------------------
// Manifest tag helpers — drive the colored tag list in the Addons UI.
// ---------------------------------------------------------------------------

fn collect_wire_types(wire: &WireManifest) -> Vec<String> {
    let mut out: Vec<String> = wire.types.iter().map(|t| cap(t.clone(), 32)).collect();
    // Some manifests omit `types` and only declare them on each catalog.
    for c in &wire.catalogs {
        let t = cap(c.media_type.clone(), 32);
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    out.into_iter().take(8).collect()
}

fn collect_wire_resources(wire: &WireManifest) -> Vec<String> {
    wire.resources
        .iter()
        .filter_map(|r| match r {
            serde_json::Value::String(s) => Some(cap(s.clone(), 32)),
            serde_json::Value::Object(o) => o.get("name").and_then(|v| v.as_str()).map(|s| cap(s.into(), 32)),
            _ => None,
        })
        .take(8)
        .collect()
}

/// Public helper consumed by `auth.rs::get_synced_addons` — extracts the
/// `types` array from a raw manifest JSON value.
pub fn extract_manifest_types(manifest: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = manifest
        .get("types")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect())
        .unwrap_or_default();

    if let Some(cats) = manifest.get("catalogs").and_then(|v| v.as_array()) {
        for c in cats {
            if let Some(t) = c.get("type").and_then(|v| v.as_str()) {
                let t = cap(t.into(), 32);
                if !out.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                    out.push(t);
                }
            }
        }
    }

    out.into_iter().take(8).collect()
}

/// Public helper — extracts the `resources` array (string or `{name, …}`
/// object form) from a raw manifest JSON value.
pub fn extract_manifest_resources(manifest: &serde_json::Value) -> Vec<String> {
    manifest
        .get("resources")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| match r {
                    serde_json::Value::String(s) => Some(cap(s.clone(), 32)),
                    serde_json::Value::Object(o) => o
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| cap(s.into(), 32)),
                    _ => None,
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default()
}

/// Manifest-level `idPrefixes` from a raw manifest JSON.
pub fn extract_manifest_id_prefixes(manifest: &serde_json::Value) -> Vec<String> {
    manifest
        .get("idPrefixes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect())
        .unwrap_or_default()
}

/// Public helper — whether the manifest declares
/// `behaviorHints.configurable == true` (the addon hosts a `/configure`
/// page). Consumed by `cloud_add_addon` and `auth.rs` cloud-sync, which
/// build `AddonEntry` from a raw manifest JSON rather than `WireManifest`.
pub fn extract_manifest_configurable(manifest: &serde_json::Value) -> bool {
    manifest
        .get("behaviorHints")
        .and_then(|v| v.get("configurable"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Per-resource overrides for the `stream` resource — its declared types
/// and idPrefixes — from a raw manifest. Either may be empty if the
/// resource is just a bare string ("stream") rather than the object form.
pub fn extract_stream_resource_info(
    manifest: &serde_json::Value,
) -> (Vec<String>, Vec<String>) {
    let mut types: Vec<String> = Vec::new();
    let mut prefixes: Vec<String> = Vec::new();
    if let Some(arr) = manifest.get("resources").and_then(|v| v.as_array()) {
        for r in arr {
            if let serde_json::Value::Object(o) = r {
                let name_match = o
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case("stream"))
                    .unwrap_or(false);
                if !name_match { continue; }
                if let Some(ts) = o.get("types").and_then(|v| v.as_array()) {
                    types = ts.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect();
                }
                if let Some(ps) = o.get("idPrefixes").and_then(|v| v.as_array()) {
                    prefixes = ps.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect();
                }
                break;
            }
        }
    }
    (types, prefixes)
}

fn collect_wire_id_prefixes(wire: &WireManifest) -> Vec<String> {
    wire.id_prefixes.iter().map(|t| cap(t.clone(), 32)).take(16).collect()
}

fn collect_wire_stream_resource_info(wire: &WireManifest) -> (Vec<String>, Vec<String>) {
    for r in &wire.resources {
        if let serde_json::Value::Object(o) = r {
            let name_match = o
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.eq_ignore_ascii_case("stream"))
                .unwrap_or(false);
            if !name_match { continue; }
            let types = o.get("types").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| cap(s.into(), 32))).collect())
                .unwrap_or_default();
            let prefixes = o.get("idPrefixes").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str().map(|s| cap(s.into(), 32))).collect())
                .unwrap_or_default();
            return (types, prefixes);
        }
    }
    (Vec::new(), Vec::new())
}

// ---------------------------------------------------------------------------
// External subtitles — companion to fetch_streams.
//
// Fans out across every addon that exposes the `subtitles` resource and pulls
// `/subtitles/{type}/{id}.json`. The frontend pipes the resulting URLs to
// MPV via `sub-add`. Lighter wrapper than the OpenSubtitles API: no auth, no
// downloads — addons return direct .srt/.vtt URLs.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct ExternalSubtitle {
    /// Direct https URL to a .srt/.vtt file.
    pub url: String,
    /// 2/3-letter language code (best-effort, blank if not provided).
    pub lang: String,
    /// Source addon's display name.
    pub addon_name: String,
    /// Optional release/title hint shown in the picker.
    pub label: Option<String>,
}

fn manifest_has_subtitle_resource(wire: &WireManifest) -> bool {
    wire.resources.iter().any(|r| match r {
        serde_json::Value::String(s) => s.eq_ignore_ascii_case("subtitles"),
        serde_json::Value::Object(o) => o
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.eq_ignore_ascii_case("subtitles"))
            .unwrap_or(false),
        _ => false,
    })
}

#[tauri::command]
pub async fn fetch_external_subtitles(
    addons: Vec<AddonEntry>,
    media_type: String,
    id: String,
) -> Result<Vec<ExternalSubtitle>, String> {
    if addons.is_empty() {
        return Ok(vec![]);
    }
    let safe_type = cap(media_type, 32);
    let safe_id   = cap(id, 128);

    let slot_len = addons.len();
    let mut set: tokio::task::JoinSet<(usize, Vec<ExternalSubtitle>)> = tokio::task::JoinSet::new();
    for (idx, addon) in addons.into_iter().enumerate() {
        let media_type = safe_type.clone();
        let id         = safe_id.clone();
        set.spawn(async move {
            let base = normalise_addon_base(&addon.url);

            let Ok((wire, _)) = fetch_manifest(&base).await else { return (idx, vec![]); };
            let label = log_label(&wire.name, &base);
            if !manifest_has_subtitle_resource(&wire) {
                return (idx, vec![]);
            }
            let addon_name = wire.name.clone();

            let url = format!("{base}/subtitles/{media_type}/{id}.json");
            crate::devlog!(info, "subtitles", "[{}] GET {}", label, redact_sensitive_url(&url));
            let Ok(resp) = client().get(&url).send().await else {
                crate::devlog!(warn, "subtitles", "[{}] request failed", label);
                return (idx, vec![]);
            };
            let Ok(resp) = resp.error_for_status() else {
                crate::devlog!(warn, "subtitles", "[{}] HTTP error", label);
                return (idx, vec![]);
            };
            let Ok(json) = resp.json::<serde_json::Value>().await else {
                crate::devlog!(warn, "subtitles", "[{}] JSON parse failed", label);
                return (idx, vec![]);
            };

            let Some(arr) = json.get("subtitles").and_then(|v| v.as_array()) else {
                crate::devlog!(info, "subtitles", "[{}] no `subtitles` array", label);
                return (idx, vec![]);
            };

            let kept: Vec<ExternalSubtitle> = arr.iter()
                .take(40)
                .filter_map(|s| sanitize_external_subtitle(s, &addon_name))
                .collect();
            crate::devlog!(info, "subtitles", "[{}] → {} subtitle(s)", label, kept.len());
            (idx, kept)
        });
    }

    // Collect into per-addon slots so the merged list follows installed-addon
    // order regardless of which network task finished first. JoinSet yields in
    // completion order — relying on that scrambled the subtitle list (the
    // ordering bug). Dedupe-by-URL is applied in addon order.
    let mut slots: Vec<Vec<ExternalSubtitle>> =
        std::iter::repeat_with(Vec::new).take(slot_len).collect();
    while let Some(task_result) = set.join_next().await {
        if let Ok((idx, items)) = task_result {
            if idx < slots.len() {
                slots[idx] = items;
            }
        }
    }

    let mut all: Vec<ExternalSubtitle> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for slot in slots {
        for s in slot {
            if seen.insert(s.url.clone()) {
                all.push(s);
            }
        }
    }

    Ok(all)
}

fn sanitize_external_subtitle(s: &serde_json::Value, addon_name: &str) -> Option<ExternalSubtitle> {
    let url_raw = s.get("url").and_then(|v| v.as_str())?;
    let lower = url_raw.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if url_raw.len() > 4096 {
        return None;
    }
    Some(ExternalSubtitle {
        url:        url_raw.to_string(),
        lang:       s.get("lang").and_then(|v| v.as_str()).map(|s| cap(s.into(), 16)).unwrap_or_default(),
        addon_name: cap(addon_name.into(), 64),
        label:      s.get("name").and_then(|v| v.as_str()).map(|s| cap(s.into(), 120)),
    })
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}
