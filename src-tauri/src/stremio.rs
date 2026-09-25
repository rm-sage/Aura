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

    // Atomic write: temp file + rename, so a half-written file can never break the
    // next launch's parse.
    //
    // TWO CONCURRENCY BUGS LIVED HERE, and both fired constantly on startup, where
    // every installed addon's manifest resolves at once and each one calls this:
    //
    //   1. Every writer used the SAME temp path. Writer A renamed tmp -> path,
    //      consuming it; writer B then renamed a tmp that no longer existed and got
    //      "The system cannot find the file specified. (os error 2)". A unique temp
    //      name per write fixes that.
    //   2. Even with distinct temps, two renames landing on the same destination
    //      race on Windows, where MoveFileEx fails with "Access is denied.
    //      (os error 5)" if another handle holds the target. The mutex below
    //      serialises the rename so only one writer touches the destination at a
    //      time, and the short retry rides out a transient share violation from an
    //      unrelated reader (AV scanner, a concurrent load).
    //
    // The data is not lost either way — the cache is a rebuildable snapshot — but
    // it meant the file was usually NOT being refreshed, and it spammed warnings.
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp.{}.{seq}", std::process::id()));
    if let Err(e) = std::fs::write(&tmp, &json) {
        crate::devlog!(warn, "catalog", "manifest cache: tmp write failed: {e}");
        let _ = std::fs::remove_file(&tmp);
        return;
    }

    // Poisoning is irrelevant here (the guard protects a filesystem rename, not
    // in-memory state), so recover rather than give up on the write.
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut last_err = None;
    for attempt in 0..3 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return,
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
                }
            }
        }
    }
    if let Some(e) = last_err {
        crate::devlog!(warn, "catalog", "manifest cache: rename failed after 3 tries: {e}");
    }
    let _ = std::fs::remove_file(&tmp);
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
/// (`{url}|{type}/{id}`). It is only ever served in place of a failed or
/// cooling-down fetch (see above), never instead of a live one, so the
/// 10-minute TTL bounds how old a payload the home page may show while an
/// addon is failing. It is unrelated to the manifest cache, whose window
/// is `MANIFEST_TTL` (24 h).
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

/// Lift THIS catalog's cooldown. Only a forced fetch that succeeded calls
/// it: the catalog has just answered, so a cooldown stamped by the failure
/// the user retried past would otherwise keep serving other callers the
/// stale fallback for the rest of its 30 s.
fn clear_catalog_failed(base: &str, catalog_type: &str, catalog_id: &str) {
    let key = fail_key(base, catalog_type, catalog_id);
    if let Ok(mut cache) = addon_fail_cache().lock() {
        cache.remove(&key);
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

/// Deserialise a field the Stremio spec types as a STRING but that real addons
/// sometimes emit as a JSON number.
///
/// AIOMetadata sends `releaseInfo: 2027` (integer, not `"2027"`) for
/// not-yet-released titles, and `imdbRating` is routinely a float upstream.
/// Strict `Option<String>` rejected those, and because `parse_meta_array` drops
/// the WHOLE meta on ANY field error, one wrong-typed year silently removed the
/// entire entry from the catalog - Frieren S3 disappeared from Upcoming Anime on
/// every launch, logged only as a `warn` nobody reads.
///
/// Numbers render back to their compact JSON form (`2027` -> `"2027"`,
/// `8.5` -> `"8.5"`). Anything else (bool / array / object) is genuinely
/// malformed for these fields, so it degrades to `None` rather than being
/// stringified into `"[object]"` in the UI.
fn de_lenient_string<'de, D>(de: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match serde_json::Value::deserialize(de)? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
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
    /// Year or year range ("2024", "2020-2024"). Lenient: addons emit a bare
    /// integer for upcoming titles. See `de_lenient_string`.
    #[serde(rename = "releaseInfo", default, deserialize_with = "de_lenient_string")]
    release_info: Option<String>,
    description: Option<String>,
    /// Lenient for the same reason - upstream sends this as a float as often
    /// as a string.
    #[serde(rename = "imdbRating", default, deserialize_with = "de_lenient_string")]
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
    /// Streams the meta addon embedded in this Video object (Stremio parity,
    /// see `extract_embedded_streams`). When non-empty, the detail page and
    /// Next-Up show these INSTEAD of the addon stream fan-out for this video.
    /// Omitted from the JSON when empty, so a meta that embeds nothing (nearly
    /// all of them) costs the IPC payload and the meta cache no extra bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<StreamEntry>,
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
    /// `behaviorHints.proxyHeaders.request` — headers the addon says the
    /// origin REQUIRES, typically a Referer or a specific User-Agent.
    ///
    /// Playback never needed these because mpv connects direct and sends its
    /// own Lavf User-Agent, which is what provider gating is usually keyed on
    /// (the same gating CLAUDE.md's HLS bypass exists for). A download goes out
    /// through reqwest instead, so without forwarding these a stream that
    /// plays perfectly would 403 the moment you tried to save it. Emitted as
    /// pairs rather than a map so the order the addon gave is preserved and
    /// the TS type stays a plain array.
    pub proxy_headers: Option<Vec<(String, String)>>,
    /// `behaviorHints.videoSize` — the file size in BYTES, when the addon
    /// bothers to send it. Everything else on the wire is a human string
    /// parsed out of the title text (`streamMeta.ts` produces "12.6 GB", never
    /// a number), so this is the only real byte count available before the
    /// first response, and it is what the free-space preflight uses.
    pub video_size: Option<u64>,
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

/// A reqwest error as a log line may print it. reqwest's own Display ends
/// ` for url (<the full request url>)`, and an addon URL carries the user's
/// config (often a debrid key too) in its path, so a log line never prints
/// the error itself. The class from `describe_reqwest_err` says what went
/// wrong; the innermost cause (the OS error, the TLS alert, serde's line
/// and column) tells two failures of one class apart. reqwest gives the URL
/// to the top-level error only, and a cause that carries one anyway is
/// dropped rather than printed.
fn reqwest_err_for_log(e: &reqwest::Error) -> String {
    let class = describe_reqwest_err(e);
    let mut root = None;
    let mut next = std::error::Error::source(e);
    while let Some(err) = next {
        root = Some(err);
        next = std::error::Error::source(err);
    }
    match root.map(|err| err.to_string()) {
        Some(cause) if !cause.is_empty() && !cause.contains("://") => {
            format!("{class}: {}", cap(cause, 200))
        }
        _ => class.to_string(),
    }
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

    let has_search = manifest_declares_search(
        wire.catalogs.iter().map(|c| c.extra.as_slice()),
        &wire.resources,
    );
    remember_manifest(base, &wire, has_search);

    Ok((wire, has_search))
}

/// `fetch_manifest` for `refresh_addon_manifest`: always the network, and the
/// manifest comes back RAW as well as typed. One GET, parsed once into a
/// `Value`, with the `WireManifest` deserialized from that same value, so the
/// JSON the refresh may write to the Stremio collection and the fields Aura
/// reads from it can never disagree. Cached exactly as `fetch_manifest`
/// caches, under `base`. `url` is the literal address fetched (the caller
/// keeps it, because the collection write compares an entry's transportUrl
/// against exactly that string). Its errors go through `reqwest_err_for_log`
/// because the manifest URL carries the addon's config; `fetch_manifest`
/// keeps its own error text for its callers.
async fn fetch_manifest_fresh(base: &str, url: &str) -> Result<(serde_json::Value, WireManifest, bool), String> {
    let resp = client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Manifest fetch failed: {}", reqwest_err_for_log(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Manifest HTTP error: {status}"));
    }
    let raw: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Manifest parse error: {}", reqwest_err_for_log(&e)))?;
    let wire = WireManifest::deserialize(&raw)
        .map_err(|e| format!("Manifest parse error: {e}"))?;

    let has_search = manifest_declares_search(
        wire.catalogs.iter().map(|c| c.extra.as_slice()),
        &wire.resources,
    );
    remember_manifest(base, &wire, has_search);

    Ok((raw, wire, has_search))
}

/// Cache a manifest just fetched from the network, in memory and on disk.
fn remember_manifest(base: &str, wire: &WireManifest, has_search: bool) {
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
}

/// One writer at a time for the Stremio addon collection. Every
/// read-modify-write of it (`cloud_add_addon`, `cloud_remove_addon`,
/// `cloud_reorder_addons` and the signed-in write in
/// `refresh_addon_manifest`) holds this from its `fetch_raw_collection` to its
/// `push_collection`, and no longer (the refresh's read-back runs after it is
/// released). `addonCollectionSet` replaces the WHOLE array, so two
/// Aura writes that overlapped would each push the collection they read and
/// the later push would silently undo the earlier one.
///
/// It cannot cover another device: the Stremio API has no conditional write,
/// so a change made elsewhere between our read and our push is still lost.
/// That window is why each writer re-reads immediately before it pushes and
/// does nothing slow in between (an addon's own manifest fetch always happens
/// BEFORE the lock is taken).
static COLLECTION_WRITE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn collection_write_lock() -> &'static tokio::sync::Mutex<()> {
    COLLECTION_WRITE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// What a collection writer returns when its fresh read does not hold what
/// the frontend showed the user (`check_collection_read`). Shown as is by
/// every caller, and never a sign-out: the session is fine, the list is not.
const COLLECTION_CHANGED: &str = "Your Stremio account changed; reload the addon list and try again";

/// Why `check_collection_read` refused. Either way nothing was written.
#[derive(Debug, PartialEq)]
enum CollectionDrift {
    /// The read came back empty although the frontend showed addons, or
    /// (add, remove and reorder) at all: a real collection keeps Stremio's
    /// protected defaults, which no client can remove.
    Empty,
    /// This many addons the frontend showed are not in the read.
    Missing(usize),
}

/// Addons `cloud_remove_addon` has just taken out of an account, so the
/// writers queued behind it on `COLLECTION_WRITE_LOCK` do not read their
/// absence as a partial read. The frontend drops a row only once its remove
/// resolves, so an add, remove, refresh or drag the user starts during that
/// half second still lists the removed addon in `expected_urls`, and would
/// otherwise be refused as "account changed" for a change Aura itself made.
/// Each record is (a hash of the auth key, never the key itself; the entry's
/// collection key, `normalize_addon_url` of its transportUrl; when), bounded
/// to `RECENT_REMOVALS_CAP` records and dropped after `RECENT_REMOVAL_TTL`.
static RECENT_REMOVALS: OnceLock<Mutex<std::collections::VecDeque<(u64, String, Instant)>>> = OnceLock::new();
const RECENT_REMOVALS_CAP: usize = 32;
const RECENT_REMOVAL_TTL: Duration = Duration::from_secs(60);

/// Which account a `RECENT_REMOVALS` record belongs to, without keeping the
/// auth key itself.
fn account_tag(auth_key: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    auth_key.hash(&mut h);
    h.finish()
}

/// Record `keys` (collection keys) as just removed from `auth_key`'s
/// account. Called under `COLLECTION_WRITE_LOCK`, after the push landed.
fn note_recent_removals(auth_key: &str, keys: Vec<String>) {
    let (tag, now) = (account_tag(auth_key), Instant::now());
    let Ok(mut recent) = RECENT_REMOVALS.get_or_init(Default::default).lock() else { return; };
    recent.retain(|(_, _, at)| now.duration_since(*at) < RECENT_REMOVAL_TTL);
    recent.extend(keys.into_iter().map(|k| (tag, k, now)));
    while recent.len() > RECENT_REMOVALS_CAP {
        recent.pop_front();
    }
}

/// Drop `key` from `auth_key`'s recent removals: Aura has just added it
/// back, so its absence from a read would be news again.
fn forget_recent_removal(auth_key: &str, key: &str) {
    let tag = account_tag(auth_key);
    if let Ok(mut recent) = RECENT_REMOVALS.get_or_init(Default::default).lock() {
        recent.retain(|(t, k, _)| !(*t == tag && k == key));
    }
}

/// The collection keys Aura removed from `auth_key`'s account within
/// `RECENT_REMOVAL_TTL`. Read by each writer AFTER it takes the lock, so a
/// remove that just finished is always in it.
fn recent_removals(auth_key: &str) -> Vec<String> {
    let (tag, now) = (account_tag(auth_key), Instant::now());
    let Ok(mut recent) = RECENT_REMOVALS.get_or_init(Default::default).lock() else { return Vec::new(); };
    recent.retain(|(_, _, at)| now.duration_since(*at) < RECENT_REMOVAL_TTL);
    recent.iter().filter(|(t, ..)| *t == tag).map(|(_, k, _)| k.clone()).collect()
}

/// The read-side guard every collection writer runs under
/// `COLLECTION_WRITE_LOCK`, on the read it is about to push from, before it
/// changes anything. `addonCollectionSet` replaces the WHOLE array, so a
/// partial read (which `addonCollectionGet` has returned during a
/// near-simultaneous write on another device; see the suspicion check in
/// App.tsx `syncAddonList`) would permanently delete every addon it left
/// out, on every device. `expected` is the url of every addon the frontend
/// currently shows; the read must hold each one, and must not be empty while
/// the frontend showed any. `excused` is left out of the check: the url
/// `cloud_add_addon` is about to add, which is naturally absent, and the
/// addons Aura itself just removed (`recent_removals`).
///
/// An expected url is compared exactly as Rust handed it to the frontend,
/// trailing slashes trimmed, against each entry's `normalize_addon_url`
/// (both lowercased when `fold_case`, the reorder's matching): that is
/// precisely how `get_synced_addons` and `cloud_add_addon` derive the url the
/// frontend holds. Normalizing it AGAIN would strip a second `/manifest.json`
/// from an entry at `.../manifest.json/manifest.json`, whose frontend url
/// then never matched, and every write was refused because of that one
/// entry. `None` is an
/// older caller that sent no list: no check here, and each command applies
/// its own rule for an empty read instead. An empty url in `expected`
/// carries no expectation and is skipped.
fn check_collection_read(
    collection: &[serde_json::Value],
    expected: Option<&[String]>,
    excused: &[String],
    fold_case: bool,
) -> Result<(), CollectionDrift> {
    let Some(expected) = expected else { return Ok(()); };
    let fold = |k: &str| if fold_case { k.to_ascii_lowercase() } else { k.to_string() };
    let key = |u: &str| fold(u.trim_end_matches('/'));
    let excused: HashSet<String> = excused.iter().map(|u| key(u)).collect();
    let wanted: Vec<String> = expected
        .iter()
        .filter(|u| !u.trim().is_empty())
        .map(|u| key(u))
        .filter(|k| !excused.contains(k))
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    if collection.is_empty() {
        return Err(CollectionDrift::Empty);
    }
    let held: HashSet<String> = collection
        .iter()
        .filter_map(|a| a.get("transportUrl").and_then(|v| v.as_str()))
        .map(|t| fold(normalize_addon_url(t)))
        .collect();
    let missing = wanted.iter().filter(|k| !held.contains(*k)).count();
    if missing > 0 {
        return Err(CollectionDrift::Missing(missing));
    }
    Ok(())
}

/// Log one refusal by `check_collection_read` ("{action} refused: ...") and
/// return the error the command hands the frontend. Counts only, never a url.
fn collection_drift_error(action: &str, drift: CollectionDrift) -> String {
    match drift {
        CollectionDrift::Empty => crate::devlog!(
            warn, "catalog",
            "{} refused: the Stremio collection read came back empty; nothing was written",
            action,
        ),
        CollectionDrift::Missing(n) => crate::devlog!(
            warn, "catalog",
            "{} refused: {} addon(s) the addon list shows are missing from the Stremio collection read; nothing was written",
            action, n,
        ),
    }
    COLLECTION_CHANGED.to_string()
}

/// A collection entry the official apps refuse to upgrade or uninstall
/// (stremio-core `AddonIsProtected`): Cinemeta and the other defaults.
/// Anything but an absent or `false` flag counts, so an odd value refuses.
fn entry_is_protected(entry: &serde_json::Value) -> bool {
    !matches!(entry.pointer("/flags/protected"), None | Some(serde_json::Value::Bool(false)))
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

    if let Some(err) = account_api_error(&json, "the Stremio API refused the read") {
        return Err(err);
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

    // Missing the object form here would report a refused write as done.
    if let Some(err) = account_api_error(&json, "the Stremio API refused the write") {
        return Err(err);
    }

    Ok(())
}

/// The error an account API answer carries, mapped for the frontend, or
/// `None` when it carries none. The API refuses with HTTP 200 and
/// `{ "error": { "message", "code" } }` (stremio-core `APIResult` /
/// `APIError`); a bare string is the older shape, and both are recognised.
/// An invalid session answers `{"error":{"code":1,"message":"Session does
/// not exist"}}`, which `map_api_error` turns into `SESSION_EXPIRED` so the
/// frontend signs out; any other message passes through unchanged, and an
/// object with no message becomes `fallback`. Shared by `fetch_raw_collection`
/// and `push_collection`, so every collection writer sees an expired session
/// at its first call, the read, and by the two account READS the app starts
/// with (`auth::get_synced_addons`, `library_get`): a string-only check there
/// read an expired session as an ordinary failure, so Aura never signed out
/// and its addon writes stayed gated behind a sync that could never succeed.
pub(crate) fn account_api_error(json: &serde_json::Value, fallback: &str) -> Option<String> {
    let err = match json.get("error") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => s.as_str(),
        Some(e @ serde_json::Value::Object(_)) => e
            .get("message")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback),
        _ => return None,
    };
    Some(map_api_error(err))
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
/// path segments, and most keep them in a bare path segment instead: a
/// debrid download link's id, an AIOStreams / AIOMetadata config UUID, a
/// Torrentio `realdebrid=<key>` config. Devlog'ing the raw URL persists
/// them to `aura-mpv.log` AND the DevConsole ring buffer (which gets
/// exported from the Help menu). The redacted form preserves the host and
/// the readable path so debugging still works.
///
/// Query parameters are redacted ONLY when their name reads as a secret or
/// their value is itself a URL carrying one (`redact_query`), so Aura's own
/// addon URLs (configured by the user, e.g. AIOMetadata `?lang=en&…`) stay
/// readable. The path and any `user:pass@` are handled by
/// `redact_path_tokens`.
pub(crate) fn redact_sensitive_url(input: &str) -> String {
    redact_url_at(input, 0)
}

/// How deep `query_pair_is_secret` may look into a query value that is
/// itself a URL. Past it the value is redacted whole without a look: a
/// proxy's `d=<upstream>` is one level, and nothing legitimate nests three.
/// Unbounded, a crafted chain of `?d=` levels (an M3U channel line has no
/// length cap) recursed once per level and overflowed the stack.
const MAX_NESTED_URL_DEPTH: u8 = 2;

fn redact_url_at(input: &str, depth: u8) -> String {
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
                s.replace_range(abs..abs + end, REDACTED);
            }
            // Advance past the redaction so we don't re-scan it, or to just
            // after the marker when there was nothing to redact. Always
            // stepping REDACTED's length could land inside a multibyte
            // char (a decoded nested URL can hold any text) and panic on
            // the next slice.
            search_start = if end > 0 { abs + REDACTED.len() } else { abs };
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
                    s.replace_range(abs..abs + end, REDACTED);
                }
                search_start = if end > 0 { abs + REDACTED.len() } else { abs };
                if search_start >= s.len() {
                    break;
                }
            }
        }
    }

    // Pass 3: userinfo and opaque path segments, then the query values the
    // exact names above miss. Split before the query, so a `://` inside it
    // (a magnet's `tr=udp://…`) is never taken for the scheme.
    let path_end = s.find(|c: char| c == '?' || c == '#').unwrap_or(s.len());
    let (head, rest) = s.split_at(path_end);
    let mut out = redact_path_tokens(head);
    out.push_str(&redact_query(rest, depth));
    out
}

/// Every URL inside a free-text line, redacted as `redact_sensitive_url`
/// would. For text Aura does not compose itself: libmpv's own messages name
/// the file they open (`Playing: <url>`, `Failed to open <url>.`, an HLS
/// `Opening '<segment url>' for reading`). Borrowed when the line holds no
/// URL, which is nearly every line, so it stays cheap on the engine thread.
pub(crate) fn redact_urls_in_text(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("://") {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for (i, word) in text.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if !word.contains("://") {
            out.push_str(word);
            continue;
        }
        // Quotes, brackets and a sentence's full stop wrap the URL; they
        // are not part of it.
        let start = word.len() - word.trim_start_matches(|c: char| "(['\"<".contains(c)).len();
        let end = word.trim_end_matches(|c: char| ".,;:)]'\">".contains(c)).len();
        out.push_str(&word[..start]);
        out.push_str(&redact_sensitive_url(&word[start..end]));
        out.push_str(&word[end..]);
    }
    std::borrow::Cow::Owned(out)
}

const REDACTED: &str = "<redacted>";

/// Stremio resource names, for spotting the protocol tail of an addon
/// request: `…/{resource}/{type}/{id}[/{extra}].json`.
const STREMIO_RESOURCES: &[&str] = &["catalog", "meta", "stream", "subtitles", "addon_catalog"];

/// The path half of `redact_sensitive_url` (`head` stops before any `?` or
/// `#`): any `user:pass@` in the authority, and every path segment that
/// reads as a credential rather than a word (see `segment_looks_opaque`).
///
/// An addon request's tail (`/stream/series/tt0903747:1:5.json`) is the
/// Stremio protocol, not the user's config, and it is what says which
/// catalog, meta or stream a log line is about, so it is kept verbatim.
/// Only a path that ENDS in `.json`, with a resource name three or four
/// segments from the end followed by a word-shaped type, has one. A
/// debrid link has no such tail, so every segment of it is checked.
fn redact_path_tokens(head: &str) -> String {
    let auth_start = head.find("://").map_or(0, |i| i + 3);
    let auth_end = head[auth_start..].find('/').map_or(head.len(), |i| auth_start + i);
    let authority = &head[auth_start..auth_end];

    let mut out = String::with_capacity(head.len());
    out.push_str(&head[..auth_start]);
    match authority.rfind('@') {
        Some(at) => {
            out.push_str(REDACTED);
            out.push_str(&authority[at..]);
        }
        None => out.push_str(authority),
    }

    let path = &head[auth_end..];
    if let Some(path) = path.strip_prefix('/') {
        let segs: Vec<&str> = path.split('/').collect();
        let n = segs.len();
        let is_request = segs[n - 1].ends_with(".json");
        let tail_from = [4usize, 3]
            .into_iter()
            .filter_map(|k| n.checked_sub(k))
            .find(|&i| {
                is_request
                    && STREMIO_RESOURCES.contains(&segs[i])
                    && !segment_looks_opaque(segs[i + 1])
            })
            .unwrap_or(n);
        for (i, seg) in segs.iter().enumerate() {
            out.push('/');
            if i < tail_from {
                out.push_str(&redact_segment(seg));
            } else {
                out.push_str(seg);
            }
        }
    }
    out
}

/// Query names whose value is a credential, matched as a SUFFIX of the
/// lowercased name so a prefixed one is caught too: MediaFlow's
/// `api_password`, an `access_token`, a forwarded `h_authorization` header.
const SECRET_QUERY_SUFFIXES: &[&str] = &[
    "password", "passwd", "token", "key", "secret", "auth", "authorization", "signature", "sig", "pin",
];

/// The query half of `redact_sensitive_url` (`rest` starts at the `?` or
/// `#`). A value goes when its name ends in a secret word, or when it is
/// itself a URL that carries a credential (a proxy's `d=<upstream>`,
/// encoded or not). A nested URL goes whole: its own `/`, `?` and `&` cannot
/// be told apart from the outer query's once it is written back. Every other
/// value stays, since `lang=en` or a magnet's `xt=` is what makes a line
/// readable.
fn redact_query(rest: &str, depth: u8) -> String {
    let frag_at = rest.find('#').unwrap_or(rest.len());
    let (query, frag) = rest.split_at(frag_at);
    let Some(query) = query.strip_prefix('?') else {
        return rest.to_string();
    };
    let mut out = String::with_capacity(rest.len());
    out.push('?');
    for (i, pair) in query.split('&').enumerate() {
        if i > 0 {
            out.push('&');
        }
        match pair.split_once('=') {
            Some((name, _)) if query_pair_is_secret(pair, depth) => {
                out.push_str(name);
                out.push('=');
                out.push_str(REDACTED);
            }
            _ => out.push_str(pair),
        }
    }
    out.push_str(frag);
    out
}

/// One raw `name=value` pair, judged on its DECODED name and value, so a
/// percent-encoded upstream URL is seen for what it is.
fn query_pair_is_secret(pair: &str, depth: u8) -> bool {
    let Some((name, value)) = url::form_urlencoded::parse(pair.as_bytes()).next() else {
        return false;
    };
    if value.is_empty() || value == REDACTED {
        return false;
    }
    let name = name.to_ascii_lowercase();
    SECRET_QUERY_SUFFIXES.iter().any(|s| name.ends_with(s))
        // A nested URL is judged by redacting it in turn, to a bounded
        // depth; one nested deeper than that goes unexamined, as secret.
        || (value.contains("://")
            && (depth >= MAX_NESTED_URL_DEPTH || redact_url_at(&value, depth + 1) != value))
}

/// One path segment, redacted when it reads as a credential. A short file
/// extension survives (`<redacted>.m3u8`), so a log still tells an HLS load
/// from a file.
fn redact_segment(seg: &str) -> String {
    let (stem, ext) = match seg.rfind('.') {
        Some(i) if i > 0 && is_short_extension(&seg[i + 1..]) => seg.split_at(i),
        _ => (seg, ""),
    };
    if stem != REDACTED && segment_looks_opaque(stem) {
        format!("{REDACTED}{ext}")
    } else {
        seg.to_string()
    }
}

/// 1-5 ASCII alphanumerics with at least one letter (`mkv`, `m3u8`, `json`).
/// All digits is a token fragment (`abc.12345`), not an extension.
fn is_short_extension(ext: &str) -> bool {
    (1..=5).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        && ext.bytes().any(|b| b.is_ascii_alphabetic())
}

/// Credential-shaped: 24+ chars of anything, or 10+ that are not a plain
/// lowercase word. That catches UUIDs, base64 / hex / JWT blobs,
/// percent-encoded configs and Real-Debrid's 13-char link id, and leaves
/// `stremio`, `playlist`, `d`, `v3` or `api` readable. A token under 10
/// chars, or one of lowercase letters only, gets through: this is a
/// heuristic for log lines, not a parser.
fn segment_looks_opaque(seg: &str) -> bool {
    let n = seg.chars().count();
    n >= 24 || (n >= 10 && !seg.chars().all(|c| c.is_ascii_lowercase() || c == '-' || c == '_'))
}

/// What `refresh_addon_manifest` returns: exactly what `get_addon_manifest`
/// returns, flattened so `name` / `catalogs` / `has_search` stay top-level,
/// plus `entry`, the `AddonEntry` rebuilt from the fresh manifest (with the
/// complete idPrefixes list, see the command), and `collection`, what became
/// of the signed-in write (`None` for a guest, who has no collection, and for
/// an unreported refresh, whose write runs on after the command returns).
#[derive(Serialize)]
pub struct RefreshedAddonManifest {
    #[serde(flatten)]
    pub manifest: AddonManifest,
    pub entry: AddonEntry,
    pub collection: Option<CollectionWrite>,
}

/// The outcome of writing a refreshed manifest to the user's Stremio
/// collection, for the frontend. Serialize-only, so the tag and variant
/// names are exactly the wire strings AddonsView matches on. Only
/// `Written` changed the account. `Unchanged` wrote nothing because the
/// account already holds this manifest (guard e), so the refresh persists
/// anyway. Every other outcome means the refresh lasts this session only,
/// as before.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum CollectionWrite {
    Written,
    Unchanged,
    /// No collection entry has this url (an addon only in addons.json).
    NotInCollection,
    /// The entry is flagged `protected` (Cinemeta and the other official
    /// defaults), which Stremio never lets a client upgrade. Expected and
    /// permanent, so nothing the user can act on: the UI stays silent.
    Protected,
    /// A guard refused the write. `reason` is short UI copy, never a URL.
    Refused { reason: String },
    /// The collection read does not hold what the addon list shows
    /// (`check_collection_read`), so it may be partial and nothing was
    /// pushed. The UI says to reload the list (`COLLECTION_CHANGED`).
    AccountChanged,
    /// The account API failed (network, HTTP, a malformed response).
    Failed,
    SessionExpired,
}

/// Why `apply_refreshed_manifest` wrote nothing. Every variant leaves the
/// collection exactly as it was read.
#[derive(Debug, PartialEq)]
enum ManifestWriteSkip {
    /// Guard c: no entry has this transportUrl.
    NotInCollection,
    /// Guard c: this many entries share it, so which one is meant is a guess.
    Ambiguous(usize),
    /// The one match's transportUrl is not literally the url the manifest
    /// was fetched from, so the official apps load it from elsewhere.
    OtherAddress,
    /// Guard a: the official apps could not parse it (see
    /// `check_collection_manifest`).
    Invalid(&'static str),
    /// Guard b: the url now answers as a different addon (`stored` is `None`
    /// when the stored entry has no readable id to compare against).
    IdChanged { stored: Option<String>, fresh: String },
    /// Guard e: the entry already holds the fresh manifest, deep-equal as
    /// served or equal in stremio-core terms on both sides
    /// (`stremio_core_manifest`).
    Unchanged,
    /// Guard d: the fresh manifest declares `configurationRequired`.
    ConfigurationRequired,
    /// The entry is flagged `protected`, which the official apps refuse to
    /// upgrade (stremio-core `UpgradeAddon`), so Aura does not either.
    Protected,
    /// The fresh manifest offers LESS than the stored one (see
    /// `manifest_reduction`): an addon that wraps others, such as
    /// AIOStreams, answers 200 with the same id and simply leaves out an
    /// upstream that is down, and writing that would strip its catalogs from
    /// every official app until the next refresh.
    Reduced { lost: ManifestReduction, stored_version: String, fresh_version: String },
    /// The stored manifest does not parse in stremio-core terms, so what the
    /// fresh one would remove cannot be proved to be nothing.
    StoredUnreadable,
}

/// What a fresh manifest would take away from the stored one, compared in
/// stremio-core terms (`manifest_reduction`). Counts only, so it can be
/// logged and shown without naming an addon's configured catalogs.
#[derive(Debug, Default, PartialEq)]
struct ManifestReduction {
    resources:      usize,
    types:          usize,
    catalogs:       usize,
    addon_catalogs: usize,
    id_prefixes:    usize,
    /// Resources still offered whose types or ids the fresh manifest
    /// narrows, read the way stremio-core gates a request on one (counted
    /// by name; a resource dropped outright is in `resources` instead).
    narrowed_resources: usize,
    /// Catalogs and addon catalogs still offered (by id and type) whose
    /// extras the fresh manifest narrows, read the way stremio-core gates a
    /// catalog request on them: an extra name dropped, an extra newly
    /// required, or a required extra's options emptied (see
    /// `manifest_reduction`).
    narrowed_catalogs: usize,
    /// The manifest-level `idPrefixes` go from every id (null or []) to a
    /// list.
    narrowed_ids:   bool,
    /// The fresh `version` has LOWER semver precedence than the stored one.
    older_version:  bool,
}

impl ManifestReduction {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// "remove 1 resource and 2 catalogs, narrow what 1 resource serves,
    /// narrow 1 catalog's filters, and lower its version", for the log line
    /// and the Refresh notice.
    fn describe(&self) -> String {
        let counted = [
            (self.resources, "resource", "resources"),
            (self.types, "type", "types"),
            (self.catalogs, "catalog", "catalogs"),
            (self.addon_catalogs, "addon catalog", "addon catalogs"),
            (self.id_prefixes, "id prefix", "id prefixes"),
        ];
        let parts: Vec<String> = counted
            .iter()
            .filter(|(n, ..)| *n > 0)
            .map(|(n, one, many)| format!("{n} {}", if *n == 1 { one } else { many }))
            .collect();
        let mut clauses: Vec<String> = Vec::new();
        match parts.as_slice() {
            [] => {}
            [only] => clauses.push(format!("remove {only}")),
            [head @ .., last] => clauses.push(format!("remove {} and {last}", head.join(", "))),
        }
        match self.narrowed_resources {
            0 => {}
            1 => clauses.push("narrow what 1 resource serves".to_string()),
            n => clauses.push(format!("narrow what {n} resources serve")),
        }
        match self.narrowed_catalogs {
            0 => {}
            1 => clauses.push("narrow 1 catalog's filters".to_string()),
            n => clauses.push(format!("narrow {n} catalogs' filters")),
        }
        if self.narrowed_ids {
            clauses.push("narrow the ids it serves".to_string());
        }
        if self.older_version {
            clauses.push("lower its version".to_string());
        }
        match clauses.as_slice() {
            [] => String::new(),
            [only] => only.clone(),
            [head @ .., last] => format!("{}, and {last}", head.join(", ")),
        }
    }
}

/// The largest manifest Aura will write into a collection entry, serialized.
/// Real manifests are well under 100 KiB even with dozens of catalogs; this
/// only stops a runaway or hostile response from bloating the account.
const MAX_COLLECTION_MANIFEST_BYTES: usize = 1 << 20;

/// The deepest a manifest Aura writes into a collection entry may nest,
/// counting the manifest object itself as level 1. Real manifests nest about
/// 6 deep. stremio-core (and Aura's own `fetch_raw_collection` /
/// `get_synced_addons`) parse the WHOLE collection under serde_json's
/// 128-level recursion limit, with the manifest 4 levels down
/// (result, addons, entry, manifest), and buffer unknown keys inside a
/// catalog or resource through a depth-checked path. A manifest that passes
/// every field check but nests 120-odd levels deep would therefore fail
/// every client's collection parse: locked in the official apps, unreadable
/// in Aura, and unrepairable by any client that reads before it writes.
const MAX_COLLECTION_MANIFEST_DEPTH: usize = 32;

/// Whether any array or object in `v` sits deeper than `max`, counting `v`
/// itself as level 1. An explicit stack rather than recursion, so no value
/// can overflow the stack here.
fn json_nests_deeper_than(v: &serde_json::Value, max: usize) -> bool {
    use serde_json::Value;
    let mut stack: Vec<(&Value, usize)> = vec![(v, 1)];
    while let Some((v, depth)) = stack.pop() {
        match v {
            Value::Array(a) => {
                if depth > max { return true; }
                stack.extend(a.iter().map(|c| (c, depth + 1)));
            }
            Value::Object(o) => {
                if depth > max { return true; }
                stack.extend(o.values().map(|c| (c, depth + 1)));
            }
            _ => {}
        }
    }
    false
}

/// Guard a: `m` is a manifest the official Stremio apps can parse. stremio-core
/// reads the collection as one `Vec<Descriptor>`, so a SINGLE entry that fails
/// to deserialize fails the whole pull, and the apps then fall back to the
/// default addons and lock the user's list (`addons_locked`). Aura writes the
/// addon's own JSON, not a struct it controls, so this mirrors every field
/// stremio-core's `Manifest` parses strictly (src/types/addon/manifest.rs) and
/// refuses whatever it would reject. It is stricter where that costs nothing:
/// `name` non-empty, `types` and `resources` non-empty, `catalogs` present
/// (the Stremio SDK's minimum, and what `WireManifest` already requires),
/// `logo` / `background` strings (stremio-core ignores a bad one; an older
/// build may not), and a catalog's short-form extras well-formed even when its
/// `extra` array alone would parse. It also bounds what no field check can
/// see: nesting (`MAX_COLLECTION_MANIFEST_DEPTH`, checked first, before
/// anything recursive touches the value) and size. Used by the refresh write
/// and by `cloud_add_addon` (`check_addable_manifest`).
fn check_collection_manifest(m: &serde_json::Value) -> Result<(), &'static str> {
    use serde_json::Value;
    fn absent_or(o: &serde_json::Map<String, Value>, key: &str, ok: impl Fn(&Value) -> bool) -> bool {
        match o.get(key) {
            None => true,
            Some(v) => ok(v),
        }
    }
    fn nullable_str(v: &Value) -> bool { v.is_null() || v.is_string() }
    fn str_array(v: &Value) -> bool {
        v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
    }
    fn nullable_str_array(v: &Value) -> bool { v.is_null() || str_array(v) }
    fn non_empty_str(o: &serde_json::Map<String, Value>, key: &str) -> bool {
        o.get(key).and_then(Value::as_str).is_some_and(|s| !s.is_empty())
    }
    fn catalog_ok(c: &Value) -> bool {
        let Some(c) = c.as_object() else { return false; };
        c.get("id").is_some_and(Value::is_string)
            && c.get("type").is_some_and(Value::is_string)
            && absent_or(c, "name", nullable_str)
            && absent_or(c, "extraRequired", str_array)
            && absent_or(c, "extraSupported", str_array)
    }
    fn catalogs_ok(v: &Value) -> bool {
        v.as_array().is_some_and(|a| a.iter().all(catalog_ok))
    }
    fn resource_ok(r: &Value) -> bool {
        match r {
            Value::String(_) => true,
            Value::Object(o) => {
                o.get("name").is_some_and(Value::is_string)
                    && absent_or(o, "types", nullable_str_array)
                    && absent_or(o, "idPrefixes", nullable_str_array)
            }
            _ => false,
        }
    }
    fn hints_ok(v: &Value) -> bool {
        let Some(h) = v.as_object() else { return false; };
        ["adult", "p2p", "configurable", "configurationRequired", "epgProvider"]
            .iter()
            .all(|k| absent_or(h, k, Value::is_boolean))
    }

    let Some(o) = m.as_object() else { return Err("the manifest is not a JSON object"); };
    if json_nests_deeper_than(m, MAX_COLLECTION_MANIFEST_DEPTH) {
        return Err("the manifest nests more than 32 levels deep");
    }
    if !non_empty_str(o, "id") { return Err("the manifest has no id"); }
    if !non_empty_str(o, "name") { return Err("the manifest has no name"); }
    if !o.get("version").and_then(Value::as_str).is_some_and(is_semver) {
        return Err("the manifest version is not a valid semver string");
    }
    let non_empty = |key: &str| o.get(key).and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    if !non_empty("types") || !o.get("types").is_some_and(str_array) {
        return Err("the manifest has no valid types list");
    }
    if !non_empty("resources")
        || !o.get("resources").and_then(Value::as_array).is_some_and(|a| a.iter().all(resource_ok))
    {
        return Err("the manifest has no valid resources list");
    }
    if !o.get("catalogs").is_some_and(catalogs_ok) || !absent_or(o, "addonCatalogs", catalogs_ok) {
        return Err("the manifest has a malformed catalog");
    }
    let optional_ok = absent_or(o, "idPrefixes", nullable_str_array)
        && absent_or(o, "contactEmail", nullable_str)
        && absent_or(o, "description", nullable_str)
        && absent_or(o, "logo", nullable_str)
        && absent_or(o, "background", nullable_str)
        && absent_or(o, "behaviorHints", hints_ok);
    if !optional_ok {
        return Err("the manifest has a malformed optional field");
    }
    let size = serde_json::to_vec(m).map(|b| b.len()).unwrap_or(usize::MAX);
    if size > MAX_COLLECTION_MANIFEST_BYTES {
        return Err("the manifest is larger than 1 MiB");
    }
    Ok(())
}

/// A version string the `semver` crate (1.0) accepts, which is what
/// stremio-core deserializes `Manifest::version` with: MAJOR.MINOR.PATCH as
/// u64s without leading zeros, then optional `-pre` and `+build` made of
/// non-empty dot-separated [0-9A-Za-z-] identifiers, where a numeric `pre`
/// identifier may not have a leading zero either. No `v` prefix, no spaces.
fn is_semver(s: &str) -> bool {
    fn numeric(p: &str) -> bool {
        !p.is_empty()
            && p.bytes().all(|b| b.is_ascii_digit())
            && (p == "0" || !p.starts_with('0'))
            && p.parse::<u64>().is_ok()
    }
    fn identifiers(s: &str, pre: bool) -> bool {
        s.split('.').all(|id| {
            !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !(pre && id.len() > 1 && id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit()))
        })
    }
    let (rest, build) = match s.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (s, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| numeric(p))
        && pre.map_or(true, |p| identifiers(p, true))
        && build.map_or(true, |b| identifiers(b, false))
}

/// SemVer 2.0 precedence of `a` against `b`, or `None` unless both pass
/// `is_semver`. MAJOR, MINOR, PATCH numerically; then a version with a
/// pre-release sorts BEFORE the same version without one, and two
/// pre-releases compare identifier by identifier (numeric ones by value and
/// below any alphanumeric one, alphanumeric ones in ASCII order, and a longer
/// run wins when every shared identifier ties). Build metadata is ignored,
/// so `1.0.0+a` and `1.0.0+b` are equal.
fn semver_precedence(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    fn split(s: &str) -> Option<([u64; 3], Option<&str>)> {
        if !is_semver(s) {
            return None;
        }
        let rest = s.split_once('+').map_or(s, |(rest, _)| rest);
        let (core, pre) = match rest.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (rest, None),
        };
        let mut n = [0u64; 3];
        for (slot, part) in n.iter_mut().zip(core.split('.')) {
            *slot = part.parse().ok()?;
        }
        Some((n, pre))
    }
    fn identifier(x: &str, y: &str) -> Ordering {
        let numeric = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
        match (numeric(x), numeric(y)) {
            // No leading zeros (`is_semver`), so length then digits is value
            // order, with no overflow on a very long identifier.
            (true, true) => x.len().cmp(&y.len()).then_with(|| x.cmp(y)),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        }
    }
    let (an, ap) = split(a)?;
    let (bn, bp) = split(b)?;
    Some(an.cmp(&bn).then_with(|| match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let (mut xs, mut ys) = (x.split('.'), y.split('.'));
            loop {
                match (xs.next(), ys.next()) {
                    (None, None) => break Ordering::Equal,
                    (None, Some(_)) => break Ordering::Less,
                    (Some(_), None) => break Ordering::Greater,
                    (Some(p), Some(q)) => match identifier(p, q) {
                        Ordering::Equal => continue,
                        o => break o,
                    },
                }
            }
        }
    }))
}

/// `m` exactly as the official Stremio apps store it in the collection, or
/// `None` when stremio-core could not parse it. They push the collection as
/// stremio-core's typed `Vec<Descriptor>` (src/types/addon/manifest.rs on the
/// development branch), so an entry an official app last wrote never holds
/// the raw manifest, even when nothing changed: it holds only the fields
/// `Manifest` models, every `Option` written out as its value or null,
/// `addonCatalogs` defaulted to [], all five behaviorHints bools, each catalog
/// extra with its defaults filled in (a `skip` extra becomes stremio-core's own
/// `SKIP_EXTRA_PROP`), catalogs unique by (id, type) and extras unique by name,
/// and a logo / background re-serialized as a parsed URL (empty or unparseable
/// becomes null). Everything else, catalog `genres` and unknown behaviorHints
/// included, is dropped.
///
/// The refresh write compares the stored and the fresh manifest through this,
/// on BOTH sides: guard e (unchanged, so no write) and `manifest_reduction`
/// (what the fresh one would take away). A stored entry may be raw (written
/// by Aura) or re-serialized (written by an official app), and a raw
/// manifest may carry per-request noise such as AIOMetadata's `_timestamp`
/// and `_debug`; in this form all of those compare alike, so an unchanged
/// addon is never rewritten. What it drops is only what stremio-core does
/// not model, so no official app reads it, and every field
/// `get_synced_addons` reads is one this keeps. A value copied here is never
/// altered beyond stremio-core's own defaults, and the function is
/// idempotent (this of a stored stremio-core form is that form).
fn stremio_core_manifest(m: &serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::{json, Value};
    fn nullable_str(v: Option<&Value>) -> Option<Value> {
        match v {
            None | Some(Value::Null) => Some(Value::Null),
            Some(Value::String(s)) => Some(Value::String(s.clone())),
            Some(_) => None,
        }
    }
    fn str_array(v: &Value) -> Option<Value> {
        let a = v.as_array()?;
        a.iter().all(Value::is_string).then(|| Value::Array(a.clone()))
    }
    fn nullable_str_array(v: Option<&Value>) -> Option<Value> {
        match v {
            None | Some(Value::Null) => Some(Value::Null),
            Some(v) => str_array(v),
        }
    }
    /// `#[serde(default)]` Vec<String> read through `UniqueVec`: absent is
    /// [], repeats after the first are dropped, null fails.
    fn unique_strs(v: Option<&Value>) -> Option<Value> {
        let Some(v) = v else { return Some(json!([])); };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for s in v.as_array()? {
            let s = s.as_str()?;
            if seen.insert(s) {
                out.push(Value::String(s.to_owned()));
            }
        }
        Some(Value::Array(out))
    }
    /// `DefaultOnError<NoneAsEmptyString>` over `Option<Url>`.
    fn url_or_null(v: Option<&Value>) -> Value {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .and_then(|s| url::Url::parse(s).ok())
            .map_or(Value::Null, |u| Value::String(u.into()))
    }
    /// `ManifestExtra::Full`: `None` when `extra` is absent or not a valid
    /// `Vec<ExtraProp>`, in which case the untagged enum falls back to `Short`.
    fn full_extra(v: Option<&Value>) -> Option<Vec<Value>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for p in v?.as_array()? {
            let p = p.as_object()?;
            let name = p.get("name")?.as_str()?;
            let is_required = match p.get("isRequired") {
                None => false,
                Some(v) => v.as_bool()?,
            };
            let options = match p.get("options") {
                None | Some(Value::Null) => json!([]),
                Some(v) => str_array(v)?,
            };
            let options_limit = match p.get("optionsLimit") {
                None => 1,
                Some(v) => v.as_u64()?,
            };
            if !seen.insert(name) {
                continue;
            }
            out.push(if name == "skip" {
                json!({ "name": "skip", "isRequired": false, "options": [], "optionsLimit": 1 })
            } else {
                json!({ "name": name, "isRequired": is_required, "options": options, "optionsLimit": options_limit })
            });
        }
        Some(out)
    }
    fn catalogs(v: Option<&Value>) -> Option<Value> {
        let Some(v) = v else { return Some(json!([])); };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for c in v.as_array()? {
            let c = c.as_object()?;
            let id = c.get("id")?.as_str()?;
            let kind = c.get("type")?.as_str()?;
            let mut view = json!({ "id": id, "type": kind, "name": nullable_str(c.get("name"))? });
            match full_extra(c.get("extra")) {
                Some(props) => view["extra"] = Value::Array(props),
                None => {
                    view["extraRequired"] = unique_strs(c.get("extraRequired"))?;
                    view["extraSupported"] = unique_strs(c.get("extraSupported"))?;
                }
            }
            if seen.insert((id, kind)) {
                out.push(view);
            }
        }
        Some(Value::Array(out))
    }
    fn resource(r: &Value) -> Option<Value> {
        match r {
            Value::String(s) => Some(Value::String(s.clone())),
            Value::Object(o) => Some(json!({
                "name": o.get("name")?.as_str()?,
                "types": nullable_str_array(o.get("types"))?,
                "idPrefixes": nullable_str_array(o.get("idPrefixes"))?,
            })),
            _ => None,
        }
    }

    let o = m.as_object()?;
    let version = o.get("version")?.as_str().filter(|v| is_semver(v))?;
    let resources = o.get("resources")?.as_array()?.iter().map(resource).collect::<Option<Vec<_>>>()?;
    let hints = match o.get("behaviorHints") {
        None => serde_json::Map::new(),
        Some(v) => v.as_object()?.clone(),
    };
    let hint = |key: &str| match hints.get(key) {
        None => Some(false),
        Some(v) => v.as_bool(),
    };
    Some(json!({
        "id": o.get("id")?.as_str()?,
        "version": version,
        "name": o.get("name")?.as_str()?,
        "contactEmail": nullable_str(o.get("contactEmail"))?,
        "description": nullable_str(o.get("description"))?,
        "logo": url_or_null(o.get("logo")),
        "background": url_or_null(o.get("background")),
        "types": str_array(o.get("types")?)?,
        "resources": resources,
        "idPrefixes": nullable_str_array(o.get("idPrefixes"))?,
        "catalogs": catalogs(o.get("catalogs"))?,
        "addonCatalogs": catalogs(o.get("addonCatalogs"))?,
        "behaviorHints": {
            "adult": hint("adult")?,
            "p2p": hint("p2p")?,
            "configurable": hint("configurable")?,
            "configurationRequired": hint("configurationRequired")?,
            "epgProvider": hint("epgProvider")?,
        },
    }))
}

/// What `fresh` would take away from `stored`, both already in stremio-core
/// form (`stremio_core_manifest`): a resource name, a type, a catalog or an
/// addon catalog (by id and type), or a manifest-level idPrefix that `stored`
/// declares and `fresh` does not; a resource still offered that serves fewer
/// types or ids; a catalog or addon catalog still offered whose extras
/// narrow; manifest-level ids narrowed from every id to a list; and a LOWER
/// semver `version`. An empty result means the change only adds or keeps (a
/// new catalog or resource, a renamed one, an extra added, given options or
/// no longer required, wider types or ids, a higher version), which is all
/// the refresh ever writes.
///
/// A catalog offered on both sides is read the way stremio-core's
/// `is_extra_supported` and `default_required_extra` gate a request on it,
/// through its extras as `ManifestExtra::iter` yields them (a short-form
/// catalog yields its `extraSupported` names, each required when
/// `extraRequired` also names it, with no options). It is narrowed when an
/// extra name the stored one declares is gone (a request carrying it, such as
/// a search, is no longer sent to it), when an extra is required where it was
/// not (a request without it is no longer sent), or when a required extra's
/// options go from some to none (`default_required_extra` then has no value
/// to send, so the Board cannot request the catalog and it disappears). An
/// addon that derives its extras from an upstream (a genre list) can do any
/// of those while the upstream is down, keeping every catalog's id and type.
///
/// A resource is read the way stremio-core's `is_resource_supported` gates a
/// meta, stream or subtitles request on it (`catalog` and `addon_catalog`
/// are gated on the catalog lists instead): a short-form resource serves the
/// manifest's `types` and `idPrefixes`, a full one ONLY its own `types` (none
/// when absent) and its own `idPrefixes`, where null, absent or [] means
/// every id. Wrapping addons such as AIOStreams declare everything per
/// resource and nothing at manifest level, so a degraded answer that drops
/// an upstream narrows a stream resource's `idPrefixes` while every name,
/// type and catalog stays; that is the case this catches. stremio-core
/// consults only the FIRST resource of a name, so every stored resource of
/// that name must fit inside the first fresh one, which holds whichever of
/// a repeated name a client reads. An id prefix covers another when the
/// other starts with it (`tt` covers `tt1`), since every id matching the
/// longer one matches the shorter.
///
/// A manifest-level `idPrefixes` of null or [] also means every id, so a
/// fresh list there narrows the addon (`narrowed_ids`); a fresh null against
/// a stored list counts every stored prefix as lost although stremio-core
/// reads it as wider, because it drops what the stored manifest declares and
/// the write goes ahead only when nothing it declares is taken away.
fn manifest_reduction(stored: &serde_json::Value, fresh: &serde_json::Value) -> ManifestReduction {
    use serde_json::Value;
    fn strs(v: Option<&Value>) -> HashSet<&str> {
        v.and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }
    fn resource_name(r: &Value) -> Option<&str> {
        r.as_str().or_else(|| r.get("name").and_then(Value::as_str))
    }
    fn resources(m: &Value) -> &[Value] {
        m.get("resources").and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
    }
    fn resource_names(m: &Value) -> HashSet<&str> {
        resources(m).iter().filter_map(resource_name).collect()
    }
    /// The ids a prefix list admits: `None` for every id (null, absent or
    /// []), else the prefixes.
    fn id_scope(v: Option<&Value>) -> Option<Vec<&str>> {
        let prefixes: Vec<&str> = v.and_then(Value::as_array)?.iter().filter_map(Value::as_str).collect();
        (!prefixes.is_empty()).then_some(prefixes)
    }
    /// The types and ids resource `r` of manifest `m` serves (see above).
    fn serves<'a>(m: &'a Value, r: &'a Value) -> (HashSet<&'a str>, Option<Vec<&'a str>>) {
        match r {
            Value::String(_) => (strs(m.get("types")), id_scope(m.get("idPrefixes"))),
            _ => (strs(r.get("types")), id_scope(r.get("idPrefixes"))),
        }
    }
    /// Every id `inner` admits is one `outer` admits.
    fn ids_cover(outer: &Option<Vec<&str>>, inner: &Option<Vec<&str>>) -> bool {
        match (outer, inner) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(o), Some(i)) => i.iter().all(|p| o.iter().any(|q| p.starts_with(q))),
        }
    }
    let narrowed_resources: HashSet<&str> = resources(stored)
        .iter()
        .filter_map(|r| {
            let name = resource_name(r)?;
            // stremio-core gates these on the catalog lists, compared by
            // (id, type) below, never on the resource's types or ids.
            if name == "catalog" || name == "addon_catalog" {
                return None;
            }
            // Gone outright: counted in `resources`, not here.
            let first_fresh = resources(fresh).iter().find(|f| resource_name(f) == Some(name))?;
            let (stored_types, stored_ids) = serves(stored, r);
            let (fresh_types, fresh_ids) = serves(fresh, first_fresh);
            // A resource that serves no type serves nothing to lose.
            let kept = stored_types.is_empty()
                || (stored_types.is_subset(&fresh_types) && ids_cover(&fresh_ids, &stored_ids));
            (!kept).then_some(name)
        })
        .collect();
    fn catalog_keys<'a>(m: &'a Value, key: &str) -> HashSet<(&'a str, &'a str)> {
        m.get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|c| Some((c.get("id")?.as_str()?, c.get("type")?.as_str()?)))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn lost<T: Eq + std::hash::Hash>(stored: HashSet<T>, fresh: HashSet<T>) -> usize {
        stored.difference(&fresh).count()
    }
    fn catalog_list<'a>(m: &'a Value, key: &str) -> &'a [Value] {
        m.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
    }
    fn catalog_key(c: &Value) -> Option<(&str, &str)> {
        Some((c.get("id")?.as_str()?, c.get("type")?.as_str()?))
    }
    /// A catalog's extras as stremio-core's `ManifestExtra::iter` yields
    /// them (see above): name to (required, has options). Names are unique in
    /// stremio-core form.
    fn extras(c: &Value) -> HashMap<&str, (bool, bool)> {
        if let Some(props) = c.get("extra").and_then(Value::as_array) {
            return props
                .iter()
                .filter_map(|p| {
                    let required = p.get("isRequired").and_then(Value::as_bool).unwrap_or(false);
                    let options = p.get("options").and_then(Value::as_array).is_some_and(|o| !o.is_empty());
                    Some((p.get("name")?.as_str()?, (required, options)))
                })
                .collect();
        }
        let required = strs(c.get("extraRequired"));
        c.get("extraSupported")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(|n| (n, (required.contains(n), false))).collect())
            .unwrap_or_default()
    }
    /// How many catalogs under `key` both manifests offer (by id and type)
    /// whose extras `fresh` narrows (see above).
    fn narrowed_catalogs(stored: &Value, fresh: &Value, key: &str) -> usize {
        catalog_list(stored, key)
            .iter()
            .filter(|s| {
                let Some(k) = catalog_key(s) else { return false; };
                // Gone outright: counted in `catalogs` or `addon_catalogs`.
                let Some(f) = catalog_list(fresh, key).iter().find(|f| catalog_key(f) == Some(k)) else {
                    return false;
                };
                let (was, now) = (extras(s), extras(f));
                was.keys().any(|name| !now.contains_key(name))
                    || now.iter().any(|(name, &(required, options))| {
                        let before = was.get(name);
                        (required && !before.is_some_and(|&(r, _)| r))
                            || (required && !options && before.is_some_and(|&(_, o)| o))
                    })
            })
            .count()
    }
    let version = |m: &Value| m.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
    ManifestReduction {
        resources:      lost(resource_names(stored), resource_names(fresh)),
        types:          lost(strs(stored.get("types")), strs(fresh.get("types"))),
        catalogs:       lost(catalog_keys(stored, "catalogs"), catalog_keys(fresh, "catalogs")),
        addon_catalogs: lost(catalog_keys(stored, "addonCatalogs"), catalog_keys(fresh, "addonCatalogs")),
        id_prefixes:    lost(strs(stored.get("idPrefixes")), strs(fresh.get("idPrefixes"))),
        narrowed_resources: narrowed_resources.len(),
        narrowed_catalogs: narrowed_catalogs(stored, fresh, "catalogs")
            + narrowed_catalogs(stored, fresh, "addonCatalogs"),
        narrowed_ids:   id_scope(stored.get("idPrefixes")).is_none() && id_scope(fresh.get("idPrefixes")).is_some(),
        older_version:  semver_precedence(&version(fresh), &version(stored)) == Some(std::cmp::Ordering::Less),
    }
}

/// The manifest declares `behaviorHints.configurationRequired: true`, which
/// stremio-core refuses to install or upgrade to.
fn requires_configuration(m: &serde_json::Value) -> bool {
    m.pointer("/behaviorHints/configurationRequired") == Some(&serde_json::Value::Bool(true))
}

/// What `cloud_add_addon` requires of a manifest before it may go into the
/// collection, checked BEFORE the lock is taken: everything
/// `check_collection_manifest` requires of the refresh write (ONE entry
/// stremio-core cannot parse locks the user's addon list in every official
/// app), and no `configurationRequired` (stremio-core refuses to install such
/// a manifest; the addon's configure page gives the link to add instead).
/// The error is the copy AddAddonForm shows.
fn check_addable_manifest(m: &serde_json::Value) -> Result<(), String> {
    const REFUSED: &str = "This addon's manifest can't be added to your Stremio account";
    check_collection_manifest(m).map_err(|why| format!("{REFUSED}: {why}"))?;
    if requires_configuration(m) {
        return Err(format!("{REFUSED}: the addon needs configuring first"));
    }
    Ok(())
}

/// The pure half of the signed-in collection write: put `fresh` into the one
/// collection entry whose normalized transportUrl is `target`, or say why not.
/// On `Ok` the ONLY change is that entry's `manifest`, now `fresh` verbatim;
/// its `transportUrl` string (not re-normalized), `flags`, any other keys,
/// every other entry and the order are exactly as read. On `Err` nothing
/// changed at all. `target` is the refreshed addon's collection key
/// (`normalize_addon_url` of its base), `fetched_url` is the literal address
/// `fresh` was served from, and the
/// guards run in this order: exactly one match, not protected, that entry's
/// transportUrl is `fetched_url`, `fresh` would parse in stremio-core, same
/// manifest id, not already held, no `configurationRequired`, and nothing the
/// stored manifest offers taken away (`manifest_reduction`).
fn apply_refreshed_manifest(
    collection: &mut [serde_json::Value],
    target: &str,
    fetched_url: &str,
    fresh: &serde_json::Value,
) -> Result<usize, ManifestWriteSkip> {
    let hits: Vec<usize> = collection
        .iter()
        .enumerate()
        .filter(|(_, a)| {
            a.get("transportUrl")
                .and_then(|v| v.as_str())
                .map(|t| normalize_addon_url(t) == target)
                .unwrap_or(false)
        })
        .map(|(i, _)| i)
        .collect();
    let index = match hits.as_slice() {
        [] => return Err(ManifestWriteSkip::NotInCollection),
        [i] => *i,
        many => return Err(ManifestWriteSkip::Ambiguous(many.len())),
    };
    // A protected entry is never written, whatever it holds or serves, so it
    // is checked first: nothing below may report it as a refusal the user
    // could act on.
    if entry_is_protected(&collection[index]) {
        return Err(ManifestWriteSkip::Protected);
    }
    // The official apps fetch the entry's transportUrl as written, so
    // anything but the very url Aura fetched (a legacy `/stremio/v1`
    // transport, a doubled or trailing slash) means what Aura fetched is not
    // provably what this entry serves. Compared against the literal url, not
    // one re-derived from `target`, which two different addresses can share.
    if collection[index].get("transportUrl").and_then(|v| v.as_str()) != Some(fetched_url) {
        return Err(ManifestWriteSkip::OtherAddress);
    }
    check_collection_manifest(fresh).map_err(ManifestWriteSkip::Invalid)?;

    let entry = &collection[index];
    let stored = entry.get("manifest");
    let stored_id = stored.and_then(|m| m.get("id")).and_then(|v| v.as_str());
    // `check_collection_manifest` has proved `id` is a non-empty string.
    let fresh_id = fresh.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if stored_id != Some(fresh_id) {
        return Err(ManifestWriteSkip::IdChanged {
            stored: stored_id.map(str::to_string),
            fresh:  fresh_id.to_string(),
        });
    }
    // Both comparisons below are in stremio-core terms on BOTH sides
    // (`stremio_core_manifest`), whichever form the stored entry is in.
    // `check_collection_manifest` has proved the fresh one parses there.
    let Some(fresh_core) = stremio_core_manifest(fresh) else {
        return Err(ManifestWriteSkip::Invalid("the manifest would not parse in Stremio"));
    };
    let stored_core = stored.and_then(stremio_core_manifest);
    // Deep-equal as served, or equal in stremio-core terms: the official
    // apps re-serialize every entry on each push, and AIOMetadata stamps a
    // per-request `_timestamp` / `_debug` into every manifest, so a raw
    // compare alone would rewrite the whole collection on every refresh of
    // an unchanged addon.
    if stored == Some(fresh) || stored_core.as_ref() == Some(&fresh_core) {
        return Err(ManifestWriteSkip::Unchanged);
    }
    // Refused whenever the fresh manifest asks for configuration, not only
    // when it newly does: stremio-core refuses to install or upgrade to such
    // a manifest, and a transient fault that serves the unconfigured
    // manifest must not make the official apps think a configured addon
    // needs setting up again.
    if requires_configuration(fresh) {
        return Err(ManifestWriteSkip::ConfigurationRequired);
    }
    // Only additive or equal-shape changes are written. A same-id 200 that
    // offers less is as likely a transient upstream fault as a real change,
    // and writing it strips the account in every official app; reinstalling
    // the addon is how a user makes a reduction stick on purpose.
    let Some(stored_core) = stored_core else {
        return Err(ManifestWriteSkip::StoredUnreadable);
    };
    let lost = manifest_reduction(&stored_core, &fresh_core);
    if !lost.is_empty() {
        let version = |m: &serde_json::Value| {
            m.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_string()
        };
        return Err(ManifestWriteSkip::Reduced {
            lost,
            stored_version: version(&stored_core),
            fresh_version:  version(&fresh_core),
        });
    }

    match collection[index].as_object_mut() {
        Some(o) => {
            o.insert("manifest".to_string(), fresh.clone());
            Ok(index)
        }
        // A non-object entry has no transportUrl, so it can never be a hit.
        None => Err(ManifestWriteSkip::NotInCollection),
    }
}

/// The signed-in half of `refresh_addon_manifest`: write the fresh manifest,
/// verbatim, into this addon's entry of the user's Stremio collection, under
/// `check_collection_read` (against `expected`, the urls the addon list
/// shows) and the guards in `apply_refreshed_manifest`. Never an error: the
/// refresh has already succeeded, so every failure is logged and reported as
/// an outcome. It waits for the read and the push only; the read-back that
/// follows runs in the background. `fetched_url` is the literal address
/// `fresh` came from.
async fn write_refreshed_manifest(
    auth_key: &str,
    base: &str,
    fetched_url: &str,
    fresh: serde_json::Value,
    label: &str,
    expected: Option<&[String]>,
) -> CollectionWrite {
    let target = normalize_addon_url(base);
    let failed = |step: &str, e: String| {
        crate::devlog!(
            warn, "catalog",
            "[{}] manifest refreshed but the Stremio collection {} failed ({}); the refresh lasts this session only",
            label, step, cap(redact_urls_in_text(&e).into_owned(), 200),
        );
        if e == SESSION_EXPIRED { CollectionWrite::SessionExpired } else { CollectionWrite::Failed }
    };

    let writer = collection_write_lock().lock().await;
    // Read under the lock and immediately before the push, never reusing an
    // earlier read (see `COLLECTION_WRITE_LOCK`).
    let mut collection = match fetch_raw_collection(auth_key).await {
        Ok(c) => c,
        Err(e) => return failed("read", e),
    };
    // The push carries the WHOLE array, so a read that lacks an addon the
    // list shows would delete it from the account, however right the one
    // entry below is. An addon Aura itself just removed is expected absent.
    if let Err(drift) = check_collection_read(&collection, expected, &recent_removals(auth_key), false) {
        let _ = collection_drift_error(&format!("[{label}] collection write (the refresh lasts this session only)"), drift);
        return CollectionWrite::AccountChanged;
    }
    let before = collection.len();
    // A slice, so the entry count cannot change: the push carries exactly
    // the entries just read, one manifest replaced.
    let index = match apply_refreshed_manifest(&mut collection, target, fetched_url, &fresh) {
        Ok(i) => i,
        Err(skip) => return collection_write_skipped(label, skip),
    };
    if let Err(e) = push_collection(auth_key, collection).await {
        return failed("write", e);
    }
    // The write is done. Release the lock before the read-back, so a queued
    // add, remove or reorder never waits on what is only a log line. A
    // writer that runs in between is why the read-back below reports "since
    // the write" rather than a failed write when it does not find exactly
    // what was pushed.
    drop(writer);

    // Read back once to confirm the entry now holds the WHOLE manifest that
    // was written: a catalog-only change keeps the id and version, so those
    // alone would "confirm" a write that never landed. In the background,
    // because the outcome returned below does not depend on it and the
    // refresh (spinner, catalog rows) should not wait another account round
    // trip. No retry loop: a mismatch is logged, and the next refresh writes
    // again if the manifest still differs.
    let (auth_key, target, label) = (auth_key.to_string(), target.to_string(), label.to_string());
    tauri::async_runtime::spawn(async move {
        let version = fresh.get("version").and_then(|v| v.as_str()).unwrap_or_default();
        match fetch_raw_collection(&auth_key).await {
            Ok(after) => {
                let entries: Vec<&serde_json::Value> = after
                    .iter()
                    .filter(|a| {
                        a.get("transportUrl").and_then(|v| v.as_str()).map(normalize_addon_url)
                            == Some(target.as_str())
                    })
                    .collect();
                let fresh_core = stremio_core_manifest(&fresh);
                if entries.is_empty() {
                    crate::devlog!(
                        info, "catalog",
                        "[{}] refreshed manifest written to the Stremio collection (version {}); the read-back finds no entry for it, so it was removed or changed since the write",
                        label, version,
                    );
                } else if entries.iter().any(|a| a.get("manifest") == Some(&fresh)) {
                    crate::devlog!(
                        info, "catalog",
                        "[{}] refreshed manifest written to the Stremio collection (entry {} of {}, version {}); read-back confirmed",
                        label, index + 1, before, version,
                    );
                } else if fresh_core.is_some()
                    && entries.iter().any(|a| a.get("manifest").and_then(stremio_core_manifest) == fresh_core)
                {
                    crate::devlog!(
                        info, "catalog",
                        "[{}] refreshed manifest written to the Stremio collection (version {}); read-back confirmed, as an official app has since re-saved it",
                        label, version,
                    );
                } else {
                    crate::devlog!(
                        warn, "catalog",
                        "[{}] refreshed manifest written to the Stremio collection (version {}), but the entry has changed since the write: the read-back shows a different manifest",
                        label, version,
                    );
                }
            }
            Err(e) => crate::devlog!(
                warn, "catalog",
                "[{}] refreshed manifest written to the Stremio collection; the read-back failed ({})",
                label, cap(redact_urls_in_text(&e).into_owned(), 200),
            ),
        }
    });
    CollectionWrite::Written
}

/// Log one refused or skipped collection write and map it to its outcome.
fn collection_write_skipped(label: &str, skip: ManifestWriteSkip) -> CollectionWrite {
    let refused = |reason: &str| CollectionWrite::Refused { reason: reason.to_string() };
    match skip {
        ManifestWriteSkip::NotInCollection => {
            crate::devlog!(
                info, "catalog",
                "[{}] not in the Stremio collection (a local addon); refreshed for this session only",
                label,
            );
            CollectionWrite::NotInCollection
        }
        ManifestWriteSkip::Unchanged => {
            crate::devlog!(info, "catalog", "[{}] Stremio collection already holds this manifest; nothing written", label);
            CollectionWrite::Unchanged
        }
        ManifestWriteSkip::Ambiguous(n) => {
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: {} entries share this addon's url, so which one to update is ambiguous",
                label, n,
            );
            refused("more than one entry in your list uses this address")
        }
        ManifestWriteSkip::OtherAddress => {
            crate::devlog!(
                info, "catalog",
                "[{}] collection write skipped: the entry's transportUrl is not the manifest url Aura fetched (a legacy or unusual address)",
                label,
            );
            refused("Stremio loads this addon from a different address")
        }
        ManifestWriteSkip::Invalid(why) => {
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: {}, which would break the addon list in the official Stremio apps",
                label, why,
            );
            refused("the addon's manifest would not load in Stremio")
        }
        ManifestWriteSkip::IdChanged { stored, fresh } => {
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: the url now serves addon id '{}' but the collection entry holds '{}'",
                label, cap(fresh, 100), stored.map_or_else(|| "(no id)".to_string(), |s| cap(s, 100)),
            );
            refused("the address now serves a different addon")
        }
        ManifestWriteSkip::ConfigurationRequired => {
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: the fresh manifest declares configurationRequired",
                label,
            );
            refused("the addon says it needs configuring")
        }
        ManifestWriteSkip::Protected => {
            crate::devlog!(
                info, "catalog",
                "[{}] collection write skipped: the entry is protected, which Stremio does not let clients upgrade",
                label,
            );
            CollectionWrite::Protected
        }
        ManifestWriteSkip::Reduced { lost, stored_version, fresh_version } => {
            let what = lost.describe();
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: the fresh manifest would {} (stored version {}, fresh {}); a same-id answer that offers less can be a transient upstream fault, so the stored manifest is kept",
                label, what, cap(stored_version, 40), cap(fresh_version, 40),
            );
            CollectionWrite::Refused {
                reason: format!(
                    "the addon now offers less than before (this would {what}); reinstalling the addon updates your account on purpose"
                ),
            }
        }
        ManifestWriteSkip::StoredUnreadable => {
            crate::devlog!(
                warn, "catalog",
                "[{}] collection write refused: the stored manifest does not parse in stremio-core terms, so what the fresh one would remove cannot be checked",
                label,
            );
            refused("your account's copy of it could not be compared with the new one")
        }
    }
}

/// Force a fresh manifest fetch, bypassing the 24 h `MANIFEST_TTL`. Used
/// by the per-addon "Refresh" button in AddonsView (and the silent refresh
/// after Configure) so users can pick up newly-added catalogs (typical for
/// self-hosted AIOMetadata where catalogs are toggled in the addon's
/// configure page) without removing and re-adding the addon.
///
/// It also REBUILDS the addon's `AddonEntry` from the fresh manifest, with
/// the same builder `add_addon` uses, because every capability field
/// (`resources`, `types`, `id_prefixes`, the stream overrides, `has_search`)
/// was otherwise frozen at install forever, and the frontend election reads
/// them on every request. When the addon is in the local `addons.json` (a
/// guest install) the entry is replaced in place, same position and same
/// url, and saved. The rebuilt entry is returned either way so the frontend
/// can swap it into its list. The returned copy can differ from the saved
/// one in one respect only: it keeps every idPrefix, where addons.json
/// keeps `add_addon`'s first 16 (see the note at the end of the body).
///
/// For a signed-in user (`auth_key` given) it ALSO writes the fresh manifest
/// into this addon's entry of the Stremio addon collection, the snapshot the
/// official Stremio apps share and `get_synced_addons` reads at launch. That
/// is an outward write to the user's account, approved by the maintainer on
/// the condition that it is definitely accurate and not potentially harmful,
/// so it is surgical, and whenever a guard is in doubt it refuses (harmless:
/// the refresh still applies for the session). The guards: under the
/// one-writer `COLLECTION_WRITE_LOCK` the collection is re-read and must hold
/// every addon the frontend list shows (`expected_urls`, less any Aura itself
/// just removed), exactly one entry must match, not `protected` and at the
/// very url the manifest was fetched from, and the manifest, written verbatim
/// as served and never as an Aura struct, must parse in stremio-core within
/// 32 levels of nesting and 1 MiB, keep the stored manifest id, not declare
/// `configurationRequired`, differ from the stored one in stremio-core terms,
/// and take nothing away (no resource, type, catalog, addon catalog or
/// manifest-level idPrefix dropped, no resource serving fewer types or ids as
/// stremio-core reads it, no catalog losing an extra, gaining a required one
/// or emptying a required one's options, no manifest-level ids narrowed, no
/// lower version; `manifest_reduction`). The frontend sends an `auth_key`
/// only once this session's `get_synced_addons` has loaded the list
/// `expected_urls` comes from. Only that entry's `manifest` changes; its
/// `transportUrl`, flags, the other entries and the order stay as read. A
/// read-back in the background, after the lock is released, confirms the
/// entry holds the whole manifest written. With `report` true (the default:
/// the Refresh button) the read and the push are awaited and their outcome
/// returned in `collection`; false (the silent refresh after Configure)
/// spawns the write and returns at once with `collection` None, so the fresh
/// catalogs never wait on the account API. A refused or failed write never
/// fails the refresh, whose fields then last this session only (until the
/// next launch or sign-in, when the collection's stored snapshot is read
/// again).
#[tauri::command]
pub async fn refresh_addon_manifest<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    addon_url: String,
    auth_key: Option<String>,
    expected_urls: Option<Vec<String>>,
    report: Option<bool>,
) -> Result<RefreshedAddonManifest, String> {
    let auth_key = auth_key.filter(|k| !k.is_empty());
    let report = report.unwrap_or(true);
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

    // Always the network (the cache entry was just dropped, but a concurrent
    // fetch could have refilled it), and the raw manifest alongside the typed
    // one, for the collection write below. `manifest_url` is kept because
    // that write compares an entry's transportUrl against exactly it.
    let manifest_url = format!("{base}/manifest.json");
    let (raw_manifest, wire, has_search) = fetch_manifest_fresh(&base, &manifest_url).await?;
    let label = log_label(&wire.name, &base);
    let entry = addon_entry_from_wire(base.clone(), &wire, has_search);

    // Guest persistence. A persist failure is logged, not returned: the
    // manifest refresh itself succeeded, and the fields still reach this
    // session through the returned entry.
    match addons::load(&app) {
        Ok(mut list) => {
            let mut hits = 0usize;
            for slot in list.iter_mut() {
                if normalise_addon_base(&slot.url) != base { continue; }
                // Keep the stored url verbatim: it is the key the frontend
                // list, the Settings provider lists and dnd-kit all hold.
                *slot = AddonEntry { url: std::mem::take(&mut slot.url), ..entry.clone() };
                hits += 1;
            }
            if hits == 0 {
                // Signed in, the collection write below says what happened.
                if auth_key.is_none() {
                    crate::devlog!(
                        info, "catalog",
                        "[{}] manifest refreshed; not in addons.json, rebuilt fields last this session only",
                        label,
                    );
                }
            } else if let Err(e) = addons::save(&app, &list) {
                crate::devlog!(
                    warn, "catalog",
                    "[{}] manifest refreshed but saving the rebuilt entry failed: {}",
                    label, e,
                );
            } else {
                crate::devlog!(
                    info, "catalog",
                    "[{}] manifest refreshed; entry rebuilt and saved to addons.json",
                    label,
                );
            }
        }
        Err(e) => crate::devlog!(
            warn, "catalog",
            "[{}] manifest refreshed but addons.json could not be read to save it: {}",
            label, e,
        ),
    }

    // The entry handed back keeps EVERY manifest-level idPrefix, the rule
    // the cloud builders follow (`extract_manifest_id_prefixes` has no
    // count cap). For a signed-in user it replaces an entry
    // `get_synced_addons` built uncapped, and `add_addon`'s 16-entry cap
    // would make the prefix gates (`fetch_streams`, addonElection.ts) reject
    // ids that matched before the refresh. This is unconditional rather
    // than keyed on `hits == 0`, because signing in does not clear
    // addons.json and a signed-in user can still hold a guest entry for the
    // same url. addons.json above keeps the add_addon-identical entry, so a
    // guest whose manifest declares more than 16 prefixes holds the longer
    // list until the next launch, which only ever accepts more ids.
    let entry = AddonEntry { id_prefixes: collect_wire_id_prefixes_complete(&wire), ..entry };

    // Signed-in persistence, after the fetch and validation succeeded. Like
    // the guest save above it never fails the refresh. Unreported, the write
    // runs on its own task (still queued on the lock, still logged) and the
    // entry goes back now.
    let collection = match auth_key {
        Some(key) if report => Some(
            write_refreshed_manifest(&key, &base, &manifest_url, raw_manifest, &label, expected_urls.as_deref()).await,
        ),
        Some(key) => {
            let (base, label) = (base.clone(), label.clone());
            tauri::async_runtime::spawn(async move {
                write_refreshed_manifest(&key, &base, &manifest_url, raw_manifest, &label, expected_urls.as_deref()).await;
            });
            None
        }
        None => None,
    };

    crate::devlog!(
        info, "manifest",
        "[{}] {} catalogs, has_search={}",
        label, wire.catalogs.len(), has_search,
    );
    Ok(RefreshedAddonManifest { manifest: addon_manifest_from_wire(wire, has_search), entry, collection })
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
    Ok(addon_manifest_from_wire(wire, has_search))
}

/// The frontend view of a manifest: display-ready catalogs plus the search
/// flag. Shared by `get_addon_manifest` and `refresh_addon_manifest`.
fn addon_manifest_from_wire(wire: WireManifest, has_search: bool) -> AddonManifest {
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

    AddonManifest { name: wire.name, catalogs, has_search }
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

    let entry = addon_entry_from_wire(base, &wire, has_search);
    list.push(entry.clone());
    addons::save(&app, &list)?;
    Ok(entry)
}

/// Build an `AddonEntry` from a parsed manifest. The ONE builder for the
/// live-manifest paths (`add_addon` and `refresh_addon_manifest`), so a
/// refresh derives every field exactly as an install did.
///
/// Types/resources let the Addons UI render colored tags without
/// re-fetching the manifest. The stream-resource metadata + idPrefixes are
/// cached so fetch_streams doesn't have to re-probe the manifest on every
/// request (a transient network failure during that re-probe was killing
/// all stream lookups).
fn addon_entry_from_wire(url: String, wire: &WireManifest, has_search: bool) -> AddonEntry {
    let (stream_types, stream_id_prefixes) = collect_wire_stream_resource_info(wire);
    AddonEntry {
        url,
        name: wire.name.clone(),
        manifest_id: wire.id.clone(),
        has_search,
        types: collect_wire_types(wire),
        resources: collect_wire_resources(wire),
        stream_types,
        id_prefixes: collect_wire_id_prefixes(wire),
        stream_id_prefixes,
        configurable: wire.behavior_hints.configurable,
    }
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
///
/// `force` (default false) skips the soft-fail cooldown below for this one
/// catalog: it is an explicit user Retry (a failed Home row), which asks
/// for the network, not for the answer the last timeout left behind. The
/// outcome is still recorded: a failure re-stamps the cooldown and can
/// still fall back to a stale payload, a success refreshes that payload
/// and lifts the cooldown. Every other caller omits it.
#[tauri::command]
pub async fn fetch_catalog(
    addon_url: String,
    catalog_type: String,
    catalog_id: String,
    skip: Option<u32>,
    limit: Option<u32>,
    force: Option<bool>,
) -> Result<Vec<MetaPreview>, String> {
    let force = force.unwrap_or(false);
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
    // A forced fetch (user Retry) goes to the network regardless.
    if !force && is_catalog_soft_failed(&base, &catalog_type, &catalog_id) {
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
        "[{}] GET {} (skip={:?} limit={:?}){}",
        label, redact_sensitive_url(&url), skip, limit,
        if force { " forced (retry)" } else { "" },
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
                warn, "catalog", "[{}] {}/{} {}",
                label, catalog_type, catalog_id, reqwest_err_for_log(&e),
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
                warn, "catalog", "[{}] {}/{} JSON parse error ({})",
                label, catalog_type, catalog_id, reqwest_err_for_log(&e),
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
    if force {
        clear_catalog_failed(&base, &catalog_type, &catalog_id);
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
                        "[{}] {}/{} → HTTP {}",
                        addon_name_str, c.media_type, c.id, resp.status().as_u16(),
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
                            "[{}] {}/{} JSON parse failed ({})",
                            addon_name_str, c.media_type, c.id, reqwest_err_for_log(&e),
                        );
                        continue;
                    }
                }
            }
            Err(e) => {
                crate::devlog!(
                    warn, "search",
                    "[{}] {}/{} {}",
                    addon_name_str, c.media_type, c.id, reqwest_err_for_log(&e),
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
                                "[{}] {}/{} → HTTP {}",
                                addon_name_str, c.media_type, c.id, resp.status().as_u16(),
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
                                    "[{}] {}/{} JSON parse failed ({})",
                                    addon_name_str, c.media_type, c.id, reqwest_err_for_log(&e),
                                );
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        crate::devlog!(
                            warn, "search",
                            "[{}] {}/{} {}",
                            addon_name_str, c.media_type, c.id, reqwest_err_for_log(&e),
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
/// The manifest must also pass `check_addable_manifest` before the lock is
/// taken, and the fresh read must pass `add_to_collection`, because the push
/// replaces the whole array.
#[tauri::command]
pub async fn cloud_add_addon(
    auth_key: String,
    url: String,
    expected_urls: Option<Vec<String>>,
) -> Result<AddonEntry, String> {
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

    // The entry goes into the collection verbatim, where one manifest
    // stremio-core cannot parse fails the official apps' whole addon pull.
    check_addable_manifest(&manifest_json)?;

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

    let has_search = extract_manifest_has_search(&manifest_json);

    // Taken after the manifest fetch, so the addon's own latency never sits
    // inside the read-to-write window (see `COLLECTION_WRITE_LOCK`).
    let _writer = collection_write_lock().lock().await;
    let collection = fetch_raw_collection(&auth_key).await?;
    let next = add_to_collection(
        collection,
        &base,
        manifest_json.clone(),
        expected_urls.as_deref(),
        &recent_removals(&auth_key),
    )?;
    push_collection(&auth_key, next).await?;
    // Back in the account, so a later read that lacks it is a partial read
    // again, even within a minute of Aura removing it.
    forget_recent_removal(&auth_key, normalize_addon_url(&base));

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

/// The pure half of `cloud_add_addon`: `collection` with a new entry for the
/// addon at `base` (`manifest` verbatim, transportUrl `{base}/manifest.json`)
/// appended, or the error the frontend shows. Refused, with nothing written,
/// when the read is empty at all, whatever `expected` holds (a real
/// collection keeps Stremio's protected defaults, which no client can
/// remove, so an empty read is the glitch, and pushing `[new]` from it would
/// delete every other addon from the account), when it does not hold every
/// addon in `expected` other than `excused` (`check_collection_read`; `base`
/// itself is left out, being naturally absent), and when an entry already
/// has `base`'s collection key.
fn add_to_collection(
    mut collection: Vec<serde_json::Value>,
    base: &str,
    manifest: serde_json::Value,
    expected: Option<&[String]>,
    excused: &[String],
) -> Result<Vec<serde_json::Value>, String> {
    if collection.is_empty() {
        return Err(collection_drift_error("addon add", CollectionDrift::Empty));
    }
    let mut excused = excused.to_vec();
    excused.push(base.to_string());
    check_collection_read(&collection, expected, &excused, false)
        .map_err(|drift| collection_drift_error("addon add", drift))?;
    let key = normalize_addon_url(base);
    if collection.iter().any(|a| {
        a.get("transportUrl")
            .and_then(|v| v.as_str())
            .is_some_and(|t| normalize_addon_url(t) == key)
    }) {
        return Err("Addon already in your Stremio account".into());
    }
    collection.push(serde_json::json!({
        "manifest":     manifest,
        "transportUrl": format!("{base}/manifest.json"),
    }));
    Ok(collection)
}

/// Remove an addon from the user's Stremio cloud account by URL. The rules
/// are `remove_from_collection`'s; `expected_urls` is the list the frontend
/// shows.
#[tauri::command]
pub async fn cloud_remove_addon(
    auth_key: String,
    url: String,
    expected_urls: Option<Vec<String>>,
) -> Result<(), String> {
    let _writer = collection_write_lock().lock().await;
    let collection = fetch_raw_collection(&auth_key).await?;
    let (next, removed) =
        remove_from_collection(collection, &url, expected_urls.as_deref(), &recent_removals(&auth_key))?;
    if removed.is_empty() {
        // Aura removed this entry itself a moment ago: nothing to write.
        crate::devlog!(info, "catalog", "addon removal: already removed from the Stremio collection; nothing was written");
        return Ok(());
    }
    push_collection(&auth_key, next).await?;
    // Still under the lock, so the writer queued behind this one already
    // knows these are gone on purpose.
    note_recent_removals(&auth_key, removed);
    Ok(())
}

/// The pure half of `cloud_remove_addon`: `collection` without the entries
/// `url` names, plus the collection keys of the entries removed, or the
/// error the frontend shows. `url` names the entries whose collection key
/// (`normalize_addon_url` of the transportUrl) is `url` as Rust handed it to
/// the frontend, trailing slashes trimmed, and only when none is, the
/// entries whose key is `url` normalized again: the exact-then-normalized
/// order `reorder_collection` uses. Normalizing first would strip a second
/// `/manifest.json` from the row of an entry at
/// `.../manifest.json/manifest.json` and remove its sibling at
/// `.../manifest.json` instead, the one the user did not click. Several
/// entries sharing that one key all go.
///
/// When no entry has `url`'s key but `url` is in `excused`, the clicked
/// entry is one Aura itself removed a moment ago (a second remove of the
/// same row, queued behind the first), and the result is the read unchanged
/// with NO keys, which means nothing to push. The normalized fallback is
/// never tried then: with the entry gone, it could only reach a different
/// one, the sibling above. With the frontend's lists this is in fact the
/// only way the fallback can be reached, since `check_collection_read`
/// already requires every shown url, the clicked row's included, to match
/// exactly unless it is excused; it stays for an older caller (`None`).
///
/// Refused, with nothing
/// written, when the read does not hold every addon in `expected` other
/// than `excused` (`check_collection_read`), when it is empty at all (even
/// for an older caller that sent no list: an empty read never leads to a
/// push), when no entry matches, and when any matching entry is `protected`
/// (`entry_is_protected`, the refresh write's predicate): the official apps
/// refuse to uninstall Cinemeta and the other defaults (stremio-core
/// `AddonIsProtected`), and a copy re-added from the catalog comes back
/// unprotected. Every other entry keeps its place.
fn remove_from_collection(
    mut collection: Vec<serde_json::Value>,
    url: &str,
    expected: Option<&[String]>,
    excused: &[String],
) -> Result<(Vec<serde_json::Value>, Vec<String>), String> {
    check_collection_read(&collection, expected, excused, false)
        .map_err(|drift| collection_drift_error("addon removal", drift))?;
    if collection.is_empty() {
        return Err(collection_drift_error("addon removal", CollectionDrift::Empty));
    }
    let has_key = |a: &serde_json::Value, key: &str| {
        a.get("transportUrl")
            .and_then(|v| v.as_str())
            .is_some_and(|t| normalize_addon_url(t) == key)
    };
    let exact = url.trim_end_matches('/');
    let key = if collection.iter().any(|a| has_key(a, exact)) {
        exact
    } else if excused.iter().any(|k| k.trim_end_matches('/') == exact) {
        return Ok((collection, Vec::new()));
    } else {
        normalize_addon_url(exact)
    };
    let matches = |a: &serde_json::Value| has_key(a, key);
    if !collection.iter().any(|a| matches(a)) {
        return Err("Addon not found in your Stremio account".into());
    }
    if let Some(entry) = collection.iter().find(|a| matches(a) && entry_is_protected(a)) {
        let name = entry
            .pointer("/manifest/name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map_or_else(|| "This addon".to_string(), |s| cap(s.trim().to_string(), 80));
        return Err(format!("{name} is a built-in Stremio addon and can't be removed from your account."));
    }
    let removed: Vec<String> = collection
        .iter()
        .filter(|a| matches(a))
        .filter_map(|a| a.get("transportUrl").and_then(|v| v.as_str()))
        .map(|t| normalize_addon_url(t).to_string())
        .collect();
    collection.retain(|a| !matches(a));
    Ok((collection, removed))
}

/// Reorder the user's Stremio cloud addon collection to match `urls`.
/// `urls` is the desired full order; each url matches an entry's collection
/// key exactly as the frontend holds it, and only failing that normalized
/// (case-insensitively either way; see `reorder_collection`). Any cloud
/// entry not present in `urls` is preserved at the tail, in its original
/// relative order: defensive against the cross-device race where device B
/// added an addon between our most recent get_synced_addons and this reorder
/// call. See `reorder_collection` for the rules; nothing is ever dropped.
///
/// Refused, with nothing written, when the fresh read does not hold every
/// addon in `expected_urls` (the list the frontend showed before the drag;
/// `check_collection_read`), when the read is empty (even for an older
/// caller that sent no list), and when any url in `urls` claims no entry: a
/// read that lacks addons the frontend just listed is a partial read, and
/// pushing a permutation of it would delete the rest from the account. An
/// addon Aura itself removed a moment ago (`recent_removals`) is expected
/// absent from both, since the drag may have started before that remove
/// resolved.
#[tauri::command]
pub async fn cloud_reorder_addons(
    auth_key: String,
    urls: Vec<String>,
    expected_urls: Option<Vec<String>>,
) -> Result<(), String> {
    if urls.is_empty() {
        return Ok(());
    }
    let _writer = collection_write_lock().lock().await;
    let collection = fetch_raw_collection(&auth_key).await?;
    let excused = recent_removals(&auth_key);
    check_collection_read(&collection, expected_urls.as_deref(), &excused, true)
        .map_err(|drift| collection_drift_error("addon reorder", drift))?;
    if collection.is_empty() {
        return Err(collection_drift_error("addon reorder", CollectionDrift::Empty));
    }
    let next = reorder_collection(collection, &urls, &excused)
        .map_err(|unclaimed| collection_drift_error("addon reorder", CollectionDrift::Missing(unclaimed)))?;

    push_collection(&auth_key, next).await
}

/// The pure half of `cloud_reorder_addons`: `collection` rearranged so the
/// entries `urls` names come first, in that order, followed by every entry
/// no url claimed, in its ORIGINAL relative order. Matching is by
/// lowercased collection key (`normalize_addon_url` of the transportUrl),
/// and each url claims the FIRST still-unclaimed entry with that key, so two
/// entries sharing a url are both kept (a repeat of the url claims the
/// second; otherwise it trails with the rest). A url is tried as Rust handed
/// it to the frontend (trailing slashes trimmed; see `check_collection_read`)
/// and only then normalized, so an entry at `.../manifest.json/manifest.json`
/// is claimed by its own frontend url. An entry without a transportUrl is
/// never claimed. On `Ok` the result is always a permutation of the input:
/// no entry is dropped, duplicated or modified. `Err` carries how many urls
/// claimed no entry (unknown, or repeated more often than the read holds
/// them), and then nothing may be pushed: the read lacks what the frontend
/// listed. A url in `excused` (an addon Aura just removed) that claims
/// nothing is skipped instead of counted.
///
/// This replaced a HashMap keyed by that url, which collapsed two entries
/// with the same key into one, so the push DROPPED the other from the
/// user's account, and which returned the leftovers in random order.
fn reorder_collection(
    collection: Vec<serde_json::Value>,
    urls: &[String],
    excused: &[String],
) -> Result<Vec<serde_json::Value>, usize> {
    let keys: Vec<Option<String>> = collection
        .iter()
        .map(|entry| {
            entry
                .get("transportUrl")
                .and_then(|v| v.as_str())
                .map(|t| normalize_addon_url(t).to_ascii_lowercase())
        })
        .collect();
    let excused: HashSet<String> =
        excused.iter().map(|k| k.trim_end_matches('/').to_ascii_lowercase()).collect();
    let mut claimed = vec![false; collection.len()];
    let mut order: Vec<usize> = Vec::with_capacity(collection.len());
    let mut unclaimed = 0usize;
    for u in urls {
        let exact = u.trim_end_matches('/').to_ascii_lowercase();
        let normalized = normalize_addon_url(&exact).to_string();
        let free = |want: &str| (0..keys.len()).find(|&i| !claimed[i] && keys[i].as_deref() == Some(want));
        let hit = free(&exact).or_else(|| free(&normalized));
        match hit {
            Some(i) => {
                claimed[i] = true;
                order.push(i);
            }
            None if excused.contains(&exact) || excused.contains(&normalized) => {}
            None => unclaimed += 1,
        }
    }
    if unclaimed > 0 {
        return Err(unclaimed);
    }
    order.extend((0..collection.len()).filter(|&i| !claimed[i]));

    let mut slots: Vec<Option<serde_json::Value>> = collection.into_iter().map(Some).collect();
    Ok(order.into_iter().filter_map(|i| slots[i].take()).collect())
}

// ---------------------------------------------------------------------------
// Commands — meta detail (Phase 3 Task B)
// ---------------------------------------------------------------------------

/// Fetch the full meta object for a single id from a specific addon.
/// Which addon to ask is decided on the frontend (`electMetaAddons` in
/// `src/addonElection.ts`); this command only fetches and maps.
///
/// `addon_name` is optional and only names the addon in the `[meta]` log
/// lines. Every caller holds the `AddonEntry`, so it passes the name; without
/// one `log_label` falls back to a redacted raw URL.
#[tauri::command]
pub async fn fetch_meta_detail(
    addon_url: String,
    media_type: String,
    id: String,
    addon_name: Option<String>,
) -> Result<MetaDetail, String> {
    validate_url(&addon_url)?;
    let base = normalise_addon_base(&addon_url);
    let url = format!("{base}/meta/{media_type}/{id}.json");
    let addon_name = cap(addon_name.unwrap_or_default(), 64);
    let label = log_label(&addon_name, &base);
    // What embedded per-video streams carry as `addon_name`, which the stream
    // list groups and keys by, so it is shown and compared. When the caller
    // named no addon the host stands in, never `label`: that is a LOG string,
    // and its fallback is redacted for logs (`<redacted>` segments on screen).
    let stream_addon_name = if addon_name.is_empty() {
        url::Url::parse(&base)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default()
    } else {
        addon_name.clone()
    };

    crate::devlog!(info, "meta", "[{}] GET {}", label, redact_sensitive_url(&url));

    let json: serde_json::Value = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let cat = describe_reqwest_err(&e);
            crate::devlog!(warn, "meta", "[{}] {}/{} {}", label, media_type, id, reqwest_err_for_log(&e));
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
            crate::devlog!(warn, "meta", "[{}] {}/{} JSON parse error ({})", label, media_type, id, reqwest_err_for_log(&e));
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

    let videos = extract_videos(meta, &stream_addon_name);

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
///
/// `addon_name` is the meta addon's display name, stamped on any streams a
/// video embeds (`extract_embedded_streams`).
fn extract_videos(meta: &serde_json::Value, addon_name: &str) -> Vec<VideoEntry> {
    let parent_id = meta.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let Some(arr) = meta.get("videos").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut repaired_count: usize = 0;
    // What is left of EMBEDDED_STREAMS_TOTAL_CAP, spent in video order, and
    // how many videos it cut short or left out.
    let mut embed_budget: usize = EMBEDDED_STREAMS_TOTAL_CAP;
    let mut embeds_cut: usize = 0;
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

            let (streams, cut) = extract_embedded_streams(v, addon_name, embed_budget);
            embed_budget -= streams.len();
            if cut { embeds_cut += 1; }

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
                streams,
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
        // Rare enough to be worth a line: these videos skip the stream
        // fan-out on the detail page and in Next-Up.
        let embedding = videos.iter().filter(|v| !v.streams.is_empty()).count();
        if embedding > 0 {
            crate::devlog!(
                info, "meta",
                "extract_videos: {embedding} video(s) embed their own streams, shown instead of the addon fan-out",
            );
        }
        if embeds_cut > 0 {
            crate::devlog!(
                info, "meta",
                "extract_videos: {addon_name}'s embedded streams reached the per-title cap of \
                 {EMBEDDED_STREAMS_TOTAL_CAP}; kept {}, {embeds_cut} later video(s) cut short or left to the addon fan-out",
                EMBEDDED_STREAMS_TOTAL_CAP - embed_budget,
            );
        }
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

/// Per-video cap on embedded streams: the same raw cap `fetch_streams`
/// applies to one addon's stream response.
const EMBEDDED_STREAMS_CAP: usize = 80;

/// Per-meta cap on embedded streams, across all of its videos. Real addons
/// embed one to three per video, but the per-video cap alone lets a long
/// series that embeds on every episode hold episodes x 80 entries, here and
/// again in the frontend's meta cache. Spent in video order: once it runs out,
/// later videos carry no embedded streams and take the addon fan-out, as a
/// video that embeds nothing already does.
const EMBEDDED_STREAMS_TOTAL_CAP: usize = 2000;

/// The streams a meta addon embedded in one Video object (Stremio parity).
///
/// The SDK lets a Video carry `streams`, and Stremio then shows those INSTEAD
/// of the addon stream fan-out for that video. stremio-core reads the key as
/// `OneOrMany`, so a bare object is a list of one, and the SDK also accepts
/// the singular `stream`. A key holding anything else (null, a string) is
/// ignored, and the other spelling is tried.
///
/// Each entry goes through `sanitize_stream`, so stream-list invariant 1 holds
/// here too: an entry with no usable url and no info hash is dropped rather
/// than rendered as a row that cannot play. NOT through
/// `partition_aio_pseudo_streams`, which strips AIOStreams' notice rows from a
/// stream response; a meta response carries none. Deduplicated on the key
/// `fetch_streams` merges with, so the list keeps the uniqueness a fan-out
/// result has.
///
/// Stricter than a fan-out on one point: an entry must carry a url, and an
/// info-hash-only one is dropped. Aura has no torrent engine (the bridge's
/// `/magnet` route is a permanent 501), and this list REPLACES the fan-out on
/// the detail page and in Next-Up, so a magnet here would stand in for
/// playable debrid rows, with no way back (Refresh takes the same branch). An
/// embed of magnets only therefore yields an empty list, and the fan-out runs
/// as it would without one.
///
/// `budget` is what is left of EMBEDDED_STREAMS_TOTAL_CAP for this meta. The
/// list is cut to it, and with none left nothing is kept. The flag says the
/// budget dropped at least one playable stream from this video's embed, so an
/// embed that would have kept nothing anyway (magnets only) is not counted.
fn extract_embedded_streams(
    v: &serde_json::Value,
    addon_name: &str,
    budget: usize,
) -> (Vec<StreamEntry>, bool) {
    let raw = ["streams", "stream"]
        .iter()
        .find_map(|k| v.get(*k).filter(|x| x.is_array() || x.is_object()));
    let list: &[serde_json::Value] = match raw {
        Some(serde_json::Value::Array(arr)) => arr,
        Some(obj) => std::slice::from_ref(obj),
        None => return (Vec::new(), false),
    };
    if budget == 0 {
        let would_keep = list.iter()
            .take(EMBEDDED_STREAMS_CAP)
            .filter_map(|s| sanitize_stream(s, addon_name))
            .any(|s| s.url.is_some());
        return (Vec::new(), would_keep);
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut streams: Vec<StreamEntry> = list.iter()
        .take(EMBEDDED_STREAMS_CAP)
        .filter_map(|s| sanitize_stream(s, addon_name))
        .filter(|s| s.url.is_some())
        .filter(|s| seen.insert(stream_dedup_key(s)))
        .collect();
    let cut = streams.len() > budget;
    streams.truncate(budget);
    (streams, cut)
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

    if let Some(err) = account_api_error(&json, "Library request refused") {
        return Err(err);
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
            crate::devlog!(warn, "library", "datastorePut network error: {}", reqwest_err_for_log(&e));
            format!("Network error: {e}")
        })?
        .error_for_status()
        .map_err(|e| {
            let status = e.status().map(|s| s.as_u16()).unwrap_or(0);
            crate::devlog!(warn, "library", "datastorePut HTTP {}", status);
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
            crate::devlog!(debug, "meta", "[{}] landscape art fetch failed: {}", label, reqwest_err_for_log(&e));
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
            crate::devlog!(debug, "meta", "[{}] landscape art parse error ({})", label, reqwest_err_for_log(&e));
            Ok(LandscapeArt::default())
        }
    }
}

/// Verdict of [`addon_entry_supports_stream_for`]. Only `Supported` is
/// queried; the other variants name the gate that failed so the `[streams]`
/// log line can say why. The old `(bool, Option<declared types>)` return
/// told a skip apart by whether `stream_types` was set, which printed "has
/// no stream resource" for every type or id-prefix miss on an addon without
/// per-resource stream types.
enum StreamGate<'a> {
    Supported,
    /// `resources` does not name `stream`, or is empty (an entry that
    /// predates the field).
    NoStreamResource,
    /// `types` is the list the type gate read; `per_resource` says whether
    /// it was the stream resource's own `types` or the manifest-level list.
    TypeMismatch { types: &'a [String], per_resource: bool },
    /// Same shape for the idPrefixes gate.
    PrefixMismatch { prefixes: &'a [String], per_resource: bool },
}

/// Cached-metadata version of the stream-resource gate — used by
/// fetch_streams so we don't have to re-fetch every addon's manifest on
/// every request. Reads `resources` / `stream_types` / `id_prefixes` /
/// `stream_id_prefixes` straight off the persisted AddonEntry.
fn addon_entry_supports_stream_for<'a>(
    addon: &'a AddonEntry,
    media_type: &str,
    id: &str,
) -> StreamGate<'a> {
    let has_stream = addon
        .resources
        .iter()
        .any(|r| r.eq_ignore_ascii_case("stream"));
    if !has_stream {
        return StreamGate::NoStreamResource;
    }
    // The stream resource's per-resource `types` (if declared) takes
    // precedence; otherwise fall back to the manifest-level `types`.
    let per_resource_types = !addon.stream_types.is_empty();
    let supported = if per_resource_types {
        &addon.stream_types
    } else {
        &addon.types
    };
    let type_ok = supported.is_empty()
        || supported.iter().any(|t| t.eq_ignore_ascii_case(media_type));
    if !type_ok {
        return StreamGate::TypeMismatch { types: supported, per_resource: per_resource_types };
    }
    // idPrefixes gate. Per-resource override > manifest-level. Empty list
    // = "accepts every prefix".
    let per_resource_prefixes = !addon.stream_id_prefixes.is_empty();
    let prefixes: &Vec<String> = if per_resource_prefixes {
        &addon.stream_id_prefixes
    } else {
        &addon.id_prefixes
    };
    if !prefixes.is_empty()
        && !prefixes.iter().any(|p| id.starts_with(p))
    {
        return StreamGate::PrefixMismatch { prefixes, per_resource: per_resource_prefixes };
    }
    StreamGate::Supported
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

    // Tagged with the addon's position so results can be re-ordered below.
    // `JoinSet::join_next` yields COMPLETION order, which made the stream list
    // depend on which addon happened to answer first - a different order on
    // every call, for the same episode. That is invisible with one stream addon
    // and actively confusing with several: the source switcher and the Next-Up
    // pre-resolve issue separate fetches, so they could disagree about which
    // stream is "first" and auto-advance would play something other than the
    // top of the list the user was looking at.
    let mut set: tokio::task::JoinSet<(usize, AddonFetchOutput)> = tokio::task::JoinSet::new();

    for (addon_idx, addon) in addons.into_iter().enumerate() {
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
            // (add_addon / cloud_add_addon / get_synced_addons) and
            // rebuilt by refresh_addon_manifest, so we already know each
            // addon's resources, types, and idPrefixes.
            //
            // The gate decides; the match below only logs WHY an addon is
            // skipped. Every skip returns the same empty slot as before.
            match addon_entry_supports_stream_for(&addon, &media_type, &id) {
                StreamGate::Supported => {}
                StreamGate::NoStreamResource => {
                    if addon.resources.is_empty() {
                        crate::devlog!(
                            info,
                            "streams",
                            "[{}] skipping {} {}: no resources cached (an old entry; Refresh the addon to rebuild it)",
                            label, media_type, id
                        );
                    } else {
                        crate::devlog!(
                            info,
                            "streams",
                            "[{}] skipping {} {}: no stream resource (declares {:?})",
                            label, media_type, id, addon.resources
                        );
                    }
                    return (addon_idx, AddonFetchOutput::empty());
                }
                // The manifest-level lists are Aura's CACHED copies, and a
                // copy at its count cap may have lost the very entry that
                // would have matched. Say so rather than blame the
                // manifest: that is exactly the case where the frontend
                // election (fail-open at TYPES_CAP) and this gate disagree.
                StreamGate::TypeMismatch { types, per_resource } => {
                    let maybe_cut = !per_resource && types.len() >= CACHED_TYPES_CAP;
                    crate::devlog!(
                        info,
                        "streams",
                        "[{}] skipping {} {}: type not in the {} {:?}{}",
                        label, media_type, id,
                        if per_resource { "stream resource's types" } else { "cached manifest types" },
                        types,
                        if maybe_cut {
                            format!(" (the list is at its {CACHED_TYPES_CAP}-entry cap and may have dropped a declared type)")
                        } else {
                            String::new()
                        }
                    );
                    return (addon_idx, AddonFetchOutput::empty());
                }
                StreamGate::PrefixMismatch { prefixes, per_resource } => {
                    // Only a guest-built list is capped; a cloud-built one
                    // of exactly this length is complete, hence "may".
                    let maybe_cut = !per_resource && prefixes.len() == GUEST_ID_PREFIXES_CAP;
                    crate::devlog!(
                        info,
                        "streams",
                        "[{}] skipping {} {}: id matches none of the {} {:?}{}",
                        label, media_type, id,
                        if per_resource { "stream resource's idPrefixes" } else { "cached manifest idPrefixes" },
                        prefixes,
                        if maybe_cut {
                            format!(" (the list has {GUEST_ID_PREFIXES_CAP} entries, the install-time cap, and may be missing declared prefixes)")
                        } else {
                            String::new()
                        }
                    );
                    return (addon_idx, AddonFetchOutput::empty());
                }
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
                    crate::devlog!(
                        warn,
                        "streams",
                        "[{}] {}/{} {}",
                        label, media_type, id, reqwest_err_for_log(&e)
                    );
                    return (addon_idx, AddonFetchOutput::empty());
                }
            };
            let status = resp.status();
            if !status.is_success() {
                crate::devlog!(
                    warn,
                    "streams",
                    "[{}] HTTP {} for {}/{}",
                    label, status.as_u16(), media_type, id
                );
                return (addon_idx, AddonFetchOutput::empty());
            }

            let json = match resp.json::<serde_json::Value>().await {
                Ok(j) => j,
                Err(e) => {
                    crate::devlog!(
                        warn,
                        "streams",
                        "[{}] {}/{} JSON parse failed ({})",
                        label, media_type, id, reqwest_err_for_log(&e)
                    );
                    return (addon_idx, AddonFetchOutput::empty());
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

            (addon_idx, AddonFetchOutput { streams: kept, errors, warnings, info, stats })
        });
    }

    let mut all: Vec<StreamEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut metadata = StreamMetadata::default();
    // Drain, then restore addon order before merging. Sorting here rather than
    // awaiting the tasks in sequence keeps the fan-out fully parallel.
    let mut outputs: Vec<(usize, AddonFetchOutput)> = Vec::new();
    while let Some(task_result) = set.join_next().await {
        if let Ok(tagged) = task_result {
            outputs.push(tagged);
        }
    }
    outputs.sort_by_key(|(idx, _)| *idx);

    for (_, out) in outputs {
        for s in out.streams {
            if seen.insert(stream_dedup_key(&s)) {
                all.push(s);
            }
        }
        metadata.errors.extend(out.errors);
        metadata.warnings.extend(out.warnings);
        metadata.info.extend(out.info);
        metadata.stats.extend(out.stats);
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

/// The identity two streams are deduplicated on, in `fetch_streams`' merge and
/// in an embedded per-video list. The title fallback is a leftover from before
/// `sanitize_stream` guaranteed a url or an info hash (CLAUDE.md, stream-list
/// invariant 1), not a case that still arises.
fn stream_dedup_key(s: &StreamEntry) -> String {
    s.url
        .clone()
        .or_else(|| s.info_hash.clone())
        .unwrap_or_else(|| s.title.clone())
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

    // ORDER IS LOAD-BEARING: reject an unusable url BEFORE the gate below,
    // never after. The scheme/length filter used to run underneath the gate,
    // so a stream whose only address was a non-http(s) scheme or an over-long
    // url PASSED the gate, then had its url nulled, and was emitted with both
    // `url == None` and `info_hash == None`. Two visible consequences:
    //
    //   * the row still rendered in the source list but could not be played -
    //     `handlePlayStream` builds `magnet:?xt=urn:btih:null` from it and the
    //     bridge answers 501.
    //   * it silently shifted what Next-Up auto-advanced into. That picker
    //     skips unplayable entries, so a dead row at the top of the list moved
    //     the pick down to a source the user had not chosen, while the source
    //     switcher still showed the dead one first.
    //
    // Filtering first makes the invariant real: every StreamEntry that reaches
    // the frontend is playable, so the list the user sees and the entry the
    // picker takes can no longer disagree.
    let url = s
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|u| {
            let lower = u.to_lowercase();
            (lower.starts_with("http://") || lower.starts_with("https://")) && u.len() <= 4096
        })
        .map(String::from);
    let info_hash = s.get("infoHash").and_then(|v| v.as_str()).map(String::from);

    // A usable stream needs at least one of these.
    if url.is_none() && info_hash.is_none() {
        return None;
    }

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
    // behaviorHints. On the `fetch_streams` path, pseudo-streams
    // (streamData.type "statistic"/"error") never reach here:
    // `partition_aio_pseudo_streams` takes them out first. Embedded per-video
    // streams (`extract_embedded_streams`) come here WITHOUT that step, so a
    // pseudo-stream there is an ordinary entry: a real one has no url or
    // infoHash and the gate above drops it, and one that carries an address
    // is kept as a row.
    let episode_pack = s
        .get("streamData")
        .and_then(|v| v.get("episodePack"))
        .and_then(|v| v.as_bool());

    // behaviorHints.proxyHeaders.request — see the struct field for why this
    // matters only on the download path. Bounded hard on every axis: an addon
    // is untrusted input and these end up on a real outbound request.
    let proxy_headers = s
        .get("behaviorHints")
        .and_then(|v| v.get("proxyHeaders"))
        .and_then(|v| v.get("request"))
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    let val = v.as_str()?;
                    // Reject anything that could smuggle a second header or a
                    // body separator into the request line.
                    if k.is_empty()
                        || k.len() > 128
                        || val.len() > 1024
                        // is_control() already covers CR and LF, which are the
                        // two that would smuggle a second header.
                        || k.chars().any(|c| c.is_control() || c == ':')
                        || val.chars().any(|c| c.is_control())
                    {
                        return None;
                    }
                    Some((k.clone(), val.to_string()))
                })
                .take(16)
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<(String, String)>| !v.is_empty());

    // behaviorHints.videoSize, in bytes. Some addons send it as a JSON number,
    // some as a numeric string; accept both and reject anything implausible.
    let video_size = s
        .get("behaviorHints")
        .and_then(|v| v.get("videoSize"))
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse::<u64>().ok()))
        .filter(|n| *n > 0 && *n < 1024u64.pow(5));

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
        proxy_headers,
        video_size,
    })
}

// ---------------------------------------------------------------------------
// Manifest tag helpers — drive the colored tag list in the Addons UI.
// ---------------------------------------------------------------------------

/// Count cap on the cached manifest-level `types` (the manifest's `types`
/// first, then catalog types), on the live and the cloud builders alike. A
/// list AT the cap may have dropped a type the manifest declares, which the
/// `fetch_streams` skip log and `src/addonElection.ts` (`TYPES_CAP`) both
/// account for.
const CACHED_TYPES_CAP: usize = 8;

/// Count cap on manifest-level `idPrefixes` in the live-manifest builder
/// only (`add_addon`, and what a refresh saves to addons.json). The cloud
/// builders (`extract_manifest_id_prefixes`) and the entry a refresh hands
/// back keep every prefix.
const GUEST_ID_PREFIXES_CAP: usize = 16;

fn collect_wire_types(wire: &WireManifest) -> Vec<String> {
    let mut out: Vec<String> = wire.types.iter().map(|t| cap(t.clone(), 32)).collect();
    // Some manifests omit `types` and only declare them on each catalog.
    for c in &wire.catalogs {
        let t = cap(c.media_type.clone(), 32);
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    out.into_iter().take(CACHED_TYPES_CAP).collect()
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

    out.into_iter().take(CACHED_TYPES_CAP).collect()
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

/// The ONE `has_search` rule: some catalog declares a `search` extra, OR
/// `resources` names `search` (bare string or `{ name }` object form).
/// Every path that builds an `AddonEntry` goes through it: `fetch_manifest`
/// (local add and refresh) directly, `cloud_add_addon` and
/// `auth.rs::get_synced_addons` via [`extract_manifest_has_search`]. The two
/// cloud paths used to check the catalog extra only, so an addon declaring
/// `"resources": ["search"]` read `true` in guest mode and `false` once
/// signed in.
fn manifest_declares_search<'a>(
    catalog_extras: impl IntoIterator<Item = &'a [serde_json::Value]>,
    resources: &[serde_json::Value],
) -> bool {
    let in_extra = catalog_extras.into_iter().any(|extras| {
        extras.iter().any(|ex| ex.get("name").and_then(|v| v.as_str()) == Some("search"))
    });
    let in_resources = resources.iter().any(|r| match r {
        serde_json::Value::String(s) => s == "search",
        serde_json::Value::Object(o) => o.get("name").and_then(|v| v.as_str()) == Some("search"),
        _ => false,
    });
    in_extra || in_resources
}

/// Public helper - [`manifest_declares_search`] over a raw manifest JSON
/// value, for the two cloud paths that never parse a `WireManifest`.
pub fn extract_manifest_has_search(manifest: &serde_json::Value) -> bool {
    fn as_slice(v: Option<&serde_json::Value>) -> &[serde_json::Value] {
        v.and_then(|v| v.as_array()).map(Vec::as_slice).unwrap_or(&[])
    }
    manifest_declares_search(
        as_slice(manifest.get("catalogs")).iter().map(|c| as_slice(c.get("extra"))),
        as_slice(manifest.get("resources")),
    )
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
    wire.id_prefixes.iter().map(|t| cap(t.clone(), 32)).take(GUEST_ID_PREFIXES_CAP).collect()
}

/// [`collect_wire_id_prefixes`] without the count cap: the cloud builders'
/// rule (`extract_manifest_id_prefixes`) over a parsed manifest. Only
/// `refresh_addon_manifest` uses it, for the entry it hands back, so a
/// refresh never shortens a list the cloud path built complete.
fn collect_wire_id_prefixes_complete(wire: &WireManifest) -> Vec<String> {
    wire.id_prefixes.iter().map(|t| cap(t.clone(), 32)).collect()
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
// `/subtitles/{type}/{id}.json`, or `/subtitles/{type}/{id}/{extra}.json` once
// the playing file's filename / hash / size are known. The frontend pipes the
// resulting URLs to MPV via `sub-add`. Lighter wrapper than the OpenSubtitles
// API: no auth, no downloads, since addons return direct .srt/.vtt URLs.
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

/// Longest `filename` extra sent, in chars. Its own cap rather than the id's
/// 128, because a release name legitimately runs longer than that. 255 is the
/// per-component limit on NTFS and ext4 alike, so nothing longer can be a real
/// file name, and a longer value is DROPPED, not truncated: a cut-off name is a
/// plausible wrong value, which is worse than no value.
const SUBTITLE_FILENAME_CAP: usize = 255;

/// Percent-encode with JavaScript's `encodeURIComponent` set: every byte of the
/// UTF-8 form except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`, as uppercase `%XX`. That
/// is the set stremio-core applies to each extra key and value, and the SDK
/// router's inverse (`querystring.parse`) reads a raw `+` as a space, so `+`
/// must go out as `%2B`, which this set does.
fn encode_uri_component(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => { let _ = write!(out, "%{b:02X}"); }
        }
    }
    out
}

/// The `{extra}` path segment of a Stremio subtitles request, or `None` when
/// no extra is known (the caller then keeps the bare URL, byte for byte).
///
/// Keys are exactly `videoHash`, `videoSize` and `filename` (there is no
/// `videoFilename` on the wire). Each key and each value is encoded on its own
/// and joined with a literal `&`; the joined string is NOT encoded again, or
/// the separators would arrive as `%26` / `%3D` and the addon would see one
/// garbage key. An unusable value is omitted, never sent empty: a hash that is
/// not the 16 lowercase hex `compute_opensubtitles_hash` produces, a zero
/// size, a blank or over-cap filename.
fn subtitle_extra_segment(
    video_hash: Option<&str>,
    video_size: Option<u64>,
    filename:   Option<&str>,
) -> Option<String> {
    let mut pairs: Vec<(&str, String)> = Vec::new();
    if let Some(h) = video_hash {
        if h.len() == 16 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            pairs.push(("videoHash", h.to_string()));
        }
    }
    if let Some(n) = video_size.filter(|n| *n > 0) {
        pairs.push(("videoSize", n.to_string()));
    }
    if let Some(f) = filename {
        if !f.trim().is_empty() && f.chars().count() <= SUBTITLE_FILENAME_CAP {
            pairs.push(("filename", f.to_string()));
        }
    }
    if pairs.is_empty() {
        return None;
    }
    Some(
        pairs.iter()
            .map(|(k, v)| format!("{}={}", encode_uri_component(k), encode_uri_component(v)))
            .collect::<Vec<_>>()
            .join("&"),
    )
}

/// `/subtitles/{type}/{id}.json`, or `/subtitles/{type}/{id}/{extra}.json` when
/// an extras segment is known. The id is spliced in raw, as it always was, so
/// an episode id keeps its literal colons (`tt0903747:1:1`).
fn subtitles_request_url(base: &str, media_type: &str, id: &str, extra: Option<&str>) -> String {
    match extra {
        Some(extra) => format!("{base}/subtitles/{media_type}/{id}/{extra}.json"),
        None        => format!("{base}/subtitles/{media_type}/{id}.json"),
    }
}

/// Fans the subtitles request out across `addons`. The three extras are
/// Stremio's (`videoHash`, `videoSize`, `filename`) and all optional: with none
/// of them the request is the bare URL, exactly as before they existed. They
/// are a ranking input for addons that read them, never an admission ticket,
/// so a missing extra never skips the fan-out.
///
/// Returns one slot per addon, in the order `addons` was passed, rather than a
/// merged list. The frontend asks twice per file (bare, then with extras) and
/// merges the answers PER ADDON, which a flattened list made impossible: an
/// addon that failed on the second request looked exactly like one that had
/// no subtitles, and the whole list was replaced without it. An empty slot is
/// still ambiguous (failed, or nothing to offer); the merge treats both alike.
#[tauri::command]
pub async fn fetch_external_subtitles(
    addons: Vec<AddonEntry>,
    media_type: String,
    id: String,
    video_hash: Option<String>,
    video_size: Option<u64>,
    filename: Option<String>,
) -> Result<Vec<Vec<ExternalSubtitle>>, String> {
    if addons.is_empty() {
        return Ok(vec![]);
    }
    let safe_type = cap(media_type, 32);
    let safe_id   = cap(id, 128);
    let extra = subtitle_extra_segment(video_hash.as_deref(), video_size, filename.as_deref());
    // The GET line names the extras rather than printing them: the filename is
    // a release name, and `redact_sensitive_url` only knows secret-shaped keys.
    let extra_note = match &extra {
        Some(e) => format!(
            " +extras[{}]",
            e.split('&').map(|p| p.split('=').next().unwrap_or("")).collect::<Vec<_>>().join(","),
        ),
        None => String::new(),
    };

    let slot_len = addons.len();
    let mut set: tokio::task::JoinSet<(usize, Vec<ExternalSubtitle>)> = tokio::task::JoinSet::new();
    for (idx, addon) in addons.into_iter().enumerate() {
        let media_type = safe_type.clone();
        let id         = safe_id.clone();
        let extra      = extra.clone();
        let extra_note = extra_note.clone();
        set.spawn(async move {
            let base = normalise_addon_base(&addon.url);

            let (wire, _) = match fetch_manifest(&base).await {
                Ok(m) => m,
                Err(e) => {
                    // Only the text before the first ':' is logged. That is
                    // fetch_manifest's own category ("Manifest fetch failed",
                    // "Manifest HTTP error", "Manifest parse error"); the rest
                    // is a reqwest error, whose Display carries the request
                    // URL, and addon URLs routinely embed the user's config
                    // or debrid token in the path.
                    crate::devlog!(
                        warn, "subtitles",
                        "[{}] skipped: {}",
                        log_label(&addon.name, &base),
                        e.split(':').next().unwrap_or("manifest error"),
                    );
                    return (idx, vec![]);
                }
            };
            let label = log_label(&wire.name, &base);
            if !manifest_has_subtitle_resource(&wire) {
                crate::devlog!(info, "subtitles", "[{}] skipped: manifest has no subtitles resource", label);
                return (idx, vec![]);
            }
            let addon_name = wire.name.clone();

            let url = subtitles_request_url(&base, &media_type, &id, extra.as_deref());
            crate::devlog!(
                info, "subtitles",
                "[{}] GET {}{}",
                label,
                redact_sensitive_url(&subtitles_request_url(&base, &media_type, &id, None)),
                extra_note,
            );
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

    // Collect into per-addon slots so the result follows installed-addon order
    // regardless of which network task finished first. JoinSet yields in
    // completion order — relying on that scrambled the subtitle list (the
    // ordering bug). Dedupe-by-URL now happens in the frontend merge
    // (`mergeSubtitleAnswers`, src/subtitleExtras.ts), still in addon order.
    let mut slots: Vec<Vec<ExternalSubtitle>> =
        std::iter::repeat_with(Vec::new).take(slot_len).collect();
    while let Some(task_result) = set.join_next().await {
        if let Ok((idx, items)) = task_result {
            if idx < slots.len() {
                slots[idx] = items;
            }
        }
    }

    Ok(slots)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: AIOMetadata emits `releaseInfo` as a bare INTEGER for
    /// not-yet-released titles. `WireMeta` typed it as a strict
    /// `Option<String>`, so serde failed the whole struct - and because
    /// `parse_meta_array` drops the entire meta on any field error, the row
    /// vanished from the catalog. Observed live as Frieren S3 disappearing
    /// from `series/mal.upcoming_anime` on every launch, with only a
    /// `skipped malformed meta: invalid type: integer 2027, expected a string`
    /// warning to show for it.
    #[test]
    fn integer_release_info_does_not_drop_the_meta() {
        let raw = serde_json::json!({
            "id": "mal:63816",
            "type": "series",
            "name": "Sousou no Frieren 3rd Season",
            "releaseInfo": 2027,
        });
        let (metas, dropped, errors) = parse_meta_array(vec![raw]);
        assert!(errors.is_empty(), "unexpected parse errors: {errors:?}");
        assert_eq!(dropped, 0, "meta was dropped instead of coerced");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].release_info.as_deref(), Some("2027"));
    }

    /// The same coercion has to hold for `imdbRating`, which upstream sends as
    /// a float at least as often as a string.
    #[test]
    fn float_imdb_rating_does_not_drop_the_meta() {
        let raw = serde_json::json!({
            "id": "tt0903747", "type": "series", "name": "Breaking Bad",
            "imdbRating": 9.5, "releaseInfo": "2008-2013",
        });
        let (metas, dropped, _) = parse_meta_array(vec![raw]);
        assert_eq!(dropped, 0);
        assert_eq!(metas[0].imdb_rating.as_deref(), Some("9.5"));
        assert_eq!(metas[0].release_info.as_deref(), Some("2008-2013"));
    }

    /// String values must still pass through untouched, and a genuinely
    /// malformed shape (object / array / bool) degrades to None rather than
    /// stringifying into the UI or killing the row.
    #[test]
    fn strings_pass_through_and_junk_degrades_to_none() {
        let raw = serde_json::json!({
            "id": "tt1", "type": "movie", "name": "A",
            "releaseInfo": "2024", "imdbRating": { "value": 8 },
        });
        let (metas, dropped, _) = parse_meta_array(vec![raw]);
        assert_eq!(dropped, 0);
        assert_eq!(metas[0].release_info.as_deref(), Some("2024"));
        assert_eq!(metas[0].imdb_rating, None);
    }

    /// The guest path (`fetch_manifest` over a `WireManifest`) and the two
    /// signed-in paths (`extract_manifest_has_search` over raw JSON) must
    /// agree. They used to disagree on a `search` resource with no search
    /// extra, which read `true` in guest mode and `false` once signed in.
    #[test]
    fn has_search_is_one_rule_on_every_path() {
        let cases = [
            (serde_json::json!({
                "name": "resource form", "resources": ["catalog", "search"],
                "catalogs": [{ "type": "movie", "id": "top" }],
            }), true),
            (serde_json::json!({
                "name": "object form", "resources": [{ "name": "search", "types": ["movie"] }],
                "catalogs": [],
            }), true),
            (serde_json::json!({
                "name": "extra form", "resources": ["catalog"],
                "catalogs": [{ "type": "movie", "id": "s", "extra": [{ "name": "search", "isRequired": true }] }],
            }), true),
            (serde_json::json!({
                "name": "neither", "resources": ["stream"],
                "catalogs": [{ "type": "movie", "id": "top", "extra": [{ "name": "genre" }] }],
            }), false),
        ];
        for (raw, expected) in cases {
            let wire: WireManifest = serde_json::from_value(raw.clone()).expect("fixture parses");
            let local = manifest_declares_search(
                wire.catalogs.iter().map(|c| c.extra.as_slice()),
                &wire.resources,
            );
            assert_eq!(local, expected, "guest path: {}", wire.name);
            assert_eq!(extract_manifest_has_search(&raw), expected, "cloud path: {}", wire.name);
        }
    }

    fn entry(resources: &[&str], types: &[&str], stream_types: &[&str], id_prefixes: &[&str]) -> AddonEntry {
        let own = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        AddonEntry {
            url: "https://example.invalid".into(),
            name: "Test".into(),
            has_search: false,
            manifest_id: String::new(),
            types: own(types),
            resources: own(resources),
            stream_types: own(stream_types),
            id_prefixes: own(id_prefixes),
            stream_id_prefixes: Vec::new(),
            configurable: false,
        }
    }

    /// Each skip names the gate that actually failed. The type and prefix
    /// misses on an addon WITHOUT per-resource stream types are the cases
    /// the old `(bool, Option<declared>)` return logged as "has no stream
    /// resource".
    #[test]
    fn stream_gate_names_the_failing_gate() {
        let bare = entry(&[], &["movie"], &[], &[]);
        assert!(matches!(addon_entry_supports_stream_for(&bare, "movie", "tt1"), StreamGate::NoStreamResource));

        let meta_only = entry(&["catalog", "meta"], &["movie"], &[], &[]);
        assert!(matches!(addon_entry_supports_stream_for(&meta_only, "movie", "tt1"), StreamGate::NoStreamResource));

        let movies = entry(&["stream"], &["movie"], &[], &[]);
        assert!(matches!(
            addon_entry_supports_stream_for(&movies, "series", "tt1:1:1"),
            StreamGate::TypeMismatch { per_resource: false, .. },
        ));
        assert!(matches!(addon_entry_supports_stream_for(&movies, "MOVIE", "tt1"), StreamGate::Supported));

        let own_types = entry(&["stream"], &["movie", "series"], &["movie"], &[]);
        assert!(matches!(
            addon_entry_supports_stream_for(&own_types, "series", "tt1:1:1"),
            StreamGate::TypeMismatch { per_resource: true, .. },
        ));

        let tt_only = entry(&["stream"], &["series"], &[], &["tt"]);
        assert!(matches!(
            addon_entry_supports_stream_for(&tt_only, "series", "kitsu:1:1"),
            StreamGate::PrefixMismatch { per_resource: false, .. },
        ));
        assert!(matches!(addon_entry_supports_stream_for(&tt_only, "series", "tt1:1:1"), StreamGate::Supported));

        // Empty type and prefix lists accept everything.
        let open = entry(&["stream"], &[], &[], &[]);
        assert!(matches!(addon_entry_supports_stream_for(&open, "anime", "kitsu:1"), StreamGate::Supported));
    }

    /// A refresh hands back the idPrefixes list the cloud builders would
    /// have built, never the live builder's 16-entry cut. A signed-in
    /// user's entry is cloud-built and complete, and swapping in the cut
    /// list made the prefix gates reject an id that matched prefix 17+.
    #[test]
    fn refreshed_id_prefixes_match_the_cloud_builder() {
        let prefixes: Vec<String> = (0..20).map(|i| format!("p{i}:")).collect();
        let raw = serde_json::json!({
            "name": "Many prefixes", "resources": ["stream"], "types": ["series"],
            "catalogs": [], "idPrefixes": prefixes,
        });
        let wire: WireManifest = serde_json::from_value(raw.clone()).expect("fixture parses");
        let cloud = extract_manifest_id_prefixes(&raw);
        assert_eq!(cloud.len(), 20);
        assert_eq!(collect_wire_id_prefixes_complete(&wire), cloud);
        // The saved guest entry keeps add_addon's cap, which is unchanged.
        assert_eq!(collect_wire_id_prefixes(&wire).len(), GUEST_ID_PREFIXES_CAP);

        let refreshed = AddonEntry {
            id_prefixes: collect_wire_id_prefixes_complete(&wire),
            ..addon_entry_from_wire("https://example.invalid".into(), &wire, false)
        };
        assert!(matches!(addon_entry_supports_stream_for(&refreshed, "series", "p19:1:1"), StreamGate::Supported));
    }

    /// Embedded per-video streams, in every shape stremio-core accepts: an
    /// array, a bare object, and the singular `stream` key. Each entry goes
    /// through sanitize_stream, so one with no usable address is dropped
    /// rather than rendered as a row that cannot play, and the list is capped.
    /// An info-hash-only entry is dropped too (Aura cannot play a magnet), so
    /// an embed of magnets only is empty and the fan-out runs instead.
    #[test]
    fn embedded_video_streams_parse() {
        let url = |n: &str| format!("https://cdn.example.invalid/{n}.mkv");
        let many: Vec<serde_json::Value> = (0..100)
            .map(|i| serde_json::json!({ "url": url(&i.to_string()) }))
            .collect();
        let meta = serde_json::json!({
            "id": "tt1",
            "videos": [
                { "id": "tt1:1:1", "streams": [
                    { "title": "A", "url": url("a") },
                    { "title": "no address" },
                    { "title": "wrong scheme", "url": "ftp://example.invalid/b.mkv" },
                    { "title": "B", "infoHash": "abc123" },
                    { "title": "C", "url": url("c"), "infoHash": "def456" },
                    { "title": "A again", "url": url("a") },
                ] },
                { "id": "tt1:1:2", "streams": { "title": "One", "url": url("one") } },
                { "id": "tt1:1:3", "stream": [{ "url": url("singular") }] },
                { "id": "tt1:1:4", "streams": many },
                { "id": "tt1:1:5" },
                { "id": "tt1:1:6", "streams": null, "stream": { "url": url("fallback") } },
                { "id": "tt1:1:7", "streams": [{ "infoHash": "abc123" }, { "infoHash": "def456" }] },
            ],
        });
        let videos = extract_videos(&meta, "Meta Addon");
        assert_eq!(videos.len(), 7);

        // Array: the address-less, non-http and info-hash-only entries are
        // dropped, a url that also carries a hash is kept, a repeated url is
        // kept once, order holds.
        let titles: Vec<&str> = videos[0].streams.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["A", "C"]);
        assert!(videos[0].streams.iter().all(|s| s.addon_name == "Meta Addon"));
        assert_eq!(videos[0].streams[1].info_hash.as_deref(), Some("def456"));

        // A bare object is a list of one.
        assert_eq!(videos[1].streams.len(), 1);
        assert_eq!(videos[1].streams[0].url.as_deref(), Some(url("one").as_str()));

        // The singular key; with no title the addon name stands in.
        assert_eq!(videos[2].streams.len(), 1);
        assert_eq!(videos[2].streams[0].title, "Meta Addon");

        // Capped, keeping the first entries.
        assert_eq!(videos[3].streams.len(), EMBEDDED_STREAMS_CAP);
        assert_eq!(videos[3].streams[0].url.as_deref(), Some(url("0").as_str()));

        // No key at all, and a null `streams` that falls through to `stream`.
        assert!(videos[4].streams.is_empty());
        assert_eq!(videos[5].streams.len(), 1);
        assert_eq!(videos[5].streams[0].url.as_deref(), Some(url("fallback").as_str()));

        // Magnets only: nothing survives, so this video takes the fan-out.
        assert!(videos[6].streams.is_empty());
        assert!(videos.iter().flat_map(|v| &v.streams).all(|s| s.url.is_some()));

        // Empty lists stay off the wire, so a meta that embeds nothing costs
        // the IPC payload and the meta cache nothing.
        let json = serde_json::to_value(&videos[4]).expect("serializes");
        assert!(json.get("streams").is_none());
        assert!(serde_json::to_value(&videos[0]).expect("serializes").get("streams").is_some());
    }

    /// The per-meta total cap, spent in video order. 40 episodes embedding a
    /// full 80 each: the first 25 fill EMBEDDED_STREAMS_TOTAL_CAP exactly and
    /// every later one carries nothing, so it takes the fan-out. A video that
    /// straddles the cap keeps only what is left of it.
    #[test]
    fn embedded_streams_total_cap_truncates_later_videos() {
        let video = |ep: usize, n: usize| {
            let streams: Vec<serde_json::Value> = (0..n)
                .map(|i| serde_json::json!({ "url": format!("https://cdn.example.invalid/{ep}/{i}.mkv") }))
                .collect();
            serde_json::json!({ "id": format!("tt1:1:{ep}"), "streams": streams })
        };
        let full = EMBEDDED_STREAMS_TOTAL_CAP / EMBEDDED_STREAMS_CAP;
        assert_eq!(full, 25);

        let meta = serde_json::json!({
            "id": "tt1",
            "videos": (1..=40).map(|ep| video(ep, EMBEDDED_STREAMS_CAP)).collect::<Vec<_>>(),
        });
        let videos = extract_videos(&meta, "Meta Addon");
        assert_eq!(videos.len(), 40);
        assert!(videos[..full].iter().all(|v| v.streams.len() == EMBEDDED_STREAMS_CAP));
        assert!(videos[full..].iter().all(|v| v.streams.is_empty()));
        let total: usize = videos.iter().map(|v| v.streams.len()).sum();
        assert_eq!(total, EMBEDDED_STREAMS_TOTAL_CAP);
        // A later video with nothing embedded stays off the wire, exactly
        // like one that never embedded anything.
        assert!(serde_json::to_value(&videos[full]).expect("serializes").get("streams").is_none());

        // 30 first moves the boundary into the middle of a video.
        let mut shifted = vec![video(0, 30)];
        shifted.extend((1..=40).map(|ep| video(ep, EMBEDDED_STREAMS_CAP)));
        let videos = extract_videos(&serde_json::json!({ "id": "tt1", "videos": shifted }), "Meta Addon");
        let left = EMBEDDED_STREAMS_TOTAL_CAP - 30;
        let whole = left / EMBEDDED_STREAMS_CAP;
        assert_eq!(videos[0].streams.len(), 30);
        assert!(videos[1..=whole].iter().all(|v| v.streams.len() == EMBEDDED_STREAMS_CAP));
        let straddle = &videos[whole + 1].streams;
        assert_eq!(straddle.len(), left % EMBEDDED_STREAMS_CAP);
        assert!(!straddle.is_empty() && straddle.len() < EMBEDDED_STREAMS_CAP);
        // The first entries are the ones kept.
        assert_eq!(
            straddle[0].url.as_deref(),
            Some(format!("https://cdn.example.invalid/{}/0.mkv", whole + 1).as_str()),
        );
        assert!(videos[whole + 2..].iter().all(|v| v.streams.is_empty()));
        assert_eq!(videos.iter().map(|v| v.streams.len()).sum::<usize>(), EMBEDDED_STREAMS_TOTAL_CAP);

        // With the budget spent, only an embed that would have kept something
        // counts as cut: magnets only take the fan-out whatever the budget.
        let magnets = serde_json::json!({ "id": "tt1:1:41", "streams": [{ "infoHash": "abc" }] });
        let (kept, cut) = extract_embedded_streams(&magnets, "Meta Addon", 0);
        assert!(kept.is_empty() && !cut);
        let (kept, cut) = extract_embedded_streams(&video(41, 3), "Meta Addon", 0);
        assert!(kept.is_empty() && cut);
    }

    const SUB_BASE: &str = "https://subs.example.invalid/cfg";
    const SUB_HASH: &str = "8e245d9679d31e12";

    /// The whole printable ASCII range, against the output of JavaScript's own
    /// `encodeURIComponent` over the same string (captured from Node). Any
    /// drift from that set breaks a value's round trip through the SDK router.
    #[test]
    fn encode_uri_component_matches_javascript() {
        let printable: String = (0x20u8..0x7f).map(char::from).collect();
        assert_eq!(
            encode_uri_component(&printable),
            "%20!%22%23%24%25%26'()*%2B%2C-.%2F0123456789%3A%3B%3C%3D%3E%3F%40\
             ABCDEFGHIJKLMNOPQRSTUVWXYZ%5B%5C%5D%5E_%60abcdefghijklmnopqrstuvwxyz%7B%7C%7D~",
        );
    }

    /// No extras means the URL Aura always sent, byte for byte, including the
    /// raw colons of an episode id. Values that are present but unusable
    /// count as absent, so they cannot turn a bare request into `/.json`.
    #[test]
    fn subtitle_url_is_bare_without_usable_extras() {
        let bare = "https://subs.example.invalid/cfg/subtitles/series/tt0903747:1:1.json";
        assert_eq!(subtitles_request_url(SUB_BASE, "series", "tt0903747:1:1", None), bare);
        assert_eq!(subtitle_extra_segment(None, None, None), None);
        let junk = subtitle_extra_segment(Some(""), Some(0), Some("   "));
        assert_eq!(junk, None);
        assert_eq!(subtitles_request_url(SUB_BASE, "series", "tt0903747:1:1", junk.as_deref()), bare);
    }

    #[test]
    fn subtitle_extras_each_key_alone() {
        assert_eq!(
            subtitle_extra_segment(Some(SUB_HASH), None, None).as_deref(),
            Some("videoHash=8e245d9679d31e12"),
        );
        assert_eq!(
            subtitle_extra_segment(None, Some(1_468_006_400), None).as_deref(),
            Some("videoSize=1468006400"),
        );
        assert_eq!(
            subtitle_extra_segment(None, None, Some("Show.S01E01.1080p.WEB-DL.mkv")).as_deref(),
            Some("filename=Show.S01E01.1080p.WEB-DL.mkv"),
        );
    }

    /// All three, in stremio-core's order, joined by a RAW `&` and spliced into
    /// the path as its own segment before `.json`.
    #[test]
    fn subtitle_extras_all_three_build_the_extra_segment() {
        let extra = subtitle_extra_segment(
            Some(SUB_HASH), Some(1_468_006_400), Some("Breaking Bad S01E01.mkv"),
        );
        assert_eq!(
            subtitles_request_url(SUB_BASE, "series", "tt0903747:1:1", extra.as_deref()),
            "https://subs.example.invalid/cfg/subtitles/series/tt0903747:1:1/\
             videoHash=8e245d9679d31e12&videoSize=1468006400&filename=Breaking%20Bad%20S01E01.mkv.json",
        );
    }

    /// Every separator the router splits on is escaped INSIDE a value, so a
    /// filename carrying `&`, `=`, `#`, `%`, `/` or `+` still arrives as one
    /// value. The SDK router undoes this with `querystring.parse`;
    /// `form_urlencoded::parse` applies the same rules (split on `&` then the
    /// first `=`, `+` as space, percent-decode), so it stands in for it here.
    #[test]
    fn subtitle_filename_round_trips_reserved_and_unicode() {
        let cases = [
            ("A B&C=D#E%F/G+H.mkv", "filename=A%20B%26C%3DD%23E%25F%2FG%2BH.mkv"),
            ("It's (a) ~test*!.mkv", "filename=It's%20(a)%20~test*!.mkv"),
            ("Amélie.2001.1080p.mkv", "filename=Am%C3%A9lie.2001.1080p.mkv"),
            (
                "葬送のフリーレン S01E01.mkv",
                "filename=%E8%91%AC%E9%80%81%E3%81%AE%E3%83%95%E3%83%AA%E3%83%BC%E3%83%AC%E3%83%B3%20S01E01.mkv",
            ),
        ];
        for (name, want) in cases {
            let seg = subtitle_extra_segment(None, None, Some(name)).expect("filename kept");
            assert_eq!(seg, want, "encoding of {name:?}");
            assert!(!seg.contains(&['/', '#', '?', ' '][..]), "{seg} would break the path");

            let all = subtitle_extra_segment(Some(SUB_HASH), Some(42_000_000), Some(name)).expect("kept");
            let parsed: Vec<(String, String)> = url::form_urlencoded::parse(all.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            assert_eq!(
                parsed,
                vec![
                    ("videoHash".to_string(), SUB_HASH.to_string()),
                    ("videoSize".to_string(), "42000000".to_string()),
                    ("filename".to_string(), name.to_string()),
                ],
            );
        }
    }

    /// The filename has its own cap, well above the id's 128, and a name past
    /// it is dropped whole rather than cut: the other extras still go out.
    #[test]
    fn subtitle_filename_cap_drops_rather_than_truncates() {
        let release = format!(
            "{}.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-GROUP.mkv",
            "A.Long.Title".repeat(10),
        );
        let len = release.chars().count();
        assert!(len > 128 && len <= SUBTITLE_FILENAME_CAP, "fixture is {len} chars");
        let seg = subtitle_extra_segment(None, None, Some(&release)).expect("long release name kept");
        assert_eq!(seg, format!("filename={release}"));

        // Counted in chars, not bytes: a CJK name at the cap is 3x that in UTF-8.
        let at_cap: String = "の".repeat(SUBTITLE_FILENAME_CAP);
        assert!(subtitle_extra_segment(None, None, Some(&at_cap)).is_some());

        let over = format!("{}.mkv", "a".repeat(SUBTITLE_FILENAME_CAP));
        assert_eq!(subtitle_extra_segment(None, None, Some(&over)), None);
        assert_eq!(
            subtitle_extra_segment(Some(SUB_HASH), Some(7), Some(&over)).as_deref(),
            Some("videoHash=8e245d9679d31e12&videoSize=7"),
        );
    }

    /// Only the exact shape `compute_opensubtitles_hash` emits is sent. Anything
    /// else is dropped on its own, and the size beside it still goes out.
    #[test]
    fn subtitle_hash_must_be_sixteen_lowercase_hex() {
        let bad_hashes = [
            "8E245D9679D31E12",  // uppercase
            "8e245d9679d31e1",   // 15 chars
            "8e245d9679d31e123", // 17 chars
            "8e245d9679d31e1g",  // not hex
            " 8e245d9679d31e1",  // padded
            "",
        ];
        for bad in bad_hashes {
            assert_eq!(
                subtitle_extra_segment(Some(bad), Some(99), None).as_deref(),
                Some("videoSize=99"),
                "hash {bad:?} should be dropped",
            );
        }
        assert_eq!(
            subtitle_extra_segment(Some("0000000000000000"), None, None).as_deref(),
            Some("videoHash=0000000000000000"),
        );
    }

    const CONFIG_UUID: &str = "9f2c1b1e-5d2a-4c1f-9e7b-3a4d5c6b7a81";

    /// An addon's config lives in its base path. It goes; the Stremio request
    /// tail after it stays, since that says which catalog or stream it was.
    #[test]
    fn redact_collapses_addon_config_and_keeps_the_request_tail() {
        let aiostreams = format!(
            "https://aiostreams.example.dev/stremio/{CONFIG_UUID}/eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0/stream/series/tt0903747:1:5.json",
        );
        assert_eq!(
            redact_sensitive_url(&aiostreams),
            "https://aiostreams.example.dev/stremio/<redacted>/<redacted>/stream/series/tt0903747:1:5.json",
        );
        let catalog = format!("https://meta.example.dev/stremio/{CONFIG_UUID}/catalog/movie/tmdb.trending/skip=100.json");
        assert_eq!(
            redact_sensitive_url(&catalog),
            "https://meta.example.dev/stremio/<redacted>/catalog/movie/tmdb.trending/skip=100.json",
        );
        let torrentio = "https://torrentio.strem.fun/sort=qualitysize|realdebrid=ABCDEFGHIJKLMNOP1234/stream/movie/tt0111161.json";
        assert_eq!(
            redact_sensitive_url(torrentio),
            "https://torrentio.strem.fun/<redacted>/stream/movie/tt0111161.json",
        );
        // A nameless addon's log label is its base, and a base has no tail.
        assert_eq!(
            log_label("", &format!("https://meta.example.dev/stremio/{CONFIG_UUID}")),
            "https://meta.example.dev/stremio/<redacted>",
        );
    }

    /// A debrid link has no request tail, so each segment is judged on its
    /// own. A short extension survives so HLS still reads as HLS.
    #[test]
    fn redact_collapses_link_ids_and_keeps_the_extension() {
        assert_eq!(
            redact_sensitive_url("https://27.download.real-debrid.com/d/ABCDEFGHIJ234/Breaking.Bad.S01E01.1080p.WEB-DL.mkv"),
            "https://27.download.real-debrid.com/d/<redacted>/<redacted>.mkv",
        );
        assert_eq!(
            redact_sensitive_url("https://live.example.dev/hls/0f3a9c2e7b4d6a8f1e2c/index.m3u8"),
            "https://live.example.dev/hls/<redacted>/index.m3u8",
        );
        // The bridge percent-encodes the whole upstream into one segment.
        assert_eq!(
            redact_sensitive_url("http://127.0.0.1:11471/proxy/http%3A%2F%2Fcdn.example.dev%2Fv%2Fabc%3Ftoken%3Dxyz"),
            "http://127.0.0.1:11471/proxy/<redacted>",
        );
        // `.json` alone does not make a tail: the segment after `stream` must
        // be a type, and this one is a token.
        assert_eq!(
            redact_sensitive_url("https://cdn.example.dev/stream/0123456789ABCDEFtoken/file.json"),
            "https://cdn.example.dev/stream/<redacted>/file.json",
        );
    }

    #[test]
    fn redact_masks_userinfo_and_still_masks_query_keys() {
        assert_eq!(
            redact_sensitive_url("https://someone:hunter2@members.example.dev/dl/abc/file.mkv"),
            "https://<redacted>@members.example.dev/dl/abc/file.mkv",
        );
        assert_eq!(
            redact_sensitive_url(&format!("https://x.example.dev/{CONFIG_UUID}/stream/movie/tt0111161.json?token=abc&lang=en")),
            "https://x.example.dev/<redacted>/stream/movie/tt0111161.json?token=<redacted>&lang=en",
        );
        assert_eq!(
            redact_sensitive_url("https://x.example.dev/api_key/SECRET/stream/movie/tt0111161.json"),
            "https://x.example.dev/api_key/<redacted>/stream/movie/tt0111161.json",
        );
    }

    /// Readable URLs come back byte-identical, and a second pass is a no-op.
    #[test]
    fn redact_leaves_readable_urls_alone_and_is_idempotent() {
        for url in [
            "https://v3-cinemeta.strem.io/manifest.json",
            "https://v3-cinemeta.strem.io/catalog/movie/top.json",
            "https://opensubtitles-v3.strem.io/subtitles/series/tt0903747:1:5.json",
            "https://cdn.example.dev/api/v1/playlist.m3u8",
            "https://cdn.example.dev",
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp://tracker.example.dev:80/announce",
            "https://mfp.example.dev/proxy/stream?d=https%3A%2F%2Fcdn.example.dev%2Fvideo.mp4&lang=en",
        ] {
            assert_eq!(redact_sensitive_url(url), url);
        }
        for url in [
            format!("https://x.example.dev/stremio/{CONFIG_UUID}/stream/movie/tt0111161.json?token=abc"),
            "https://someone:hunter2@cdn.example.dev/d/ABCDEFGHIJ234/Movie.2020.1080p.mkv".to_string(),
            format!("https://mfp.example.dev/proxy/stream?d={MFP_UPSTREAM}&api_password=hunter2"),
        ] {
            let once = redact_sensitive_url(&url);
            assert_eq!(redact_sensitive_url(&once), once);
        }
    }

    /// A MediaFlow-style proxy link, whose upstream (a debrid link id and
    /// all) is percent-encoded into the `d=` query value.
    const MFP_UPSTREAM: &str =
        "https%3A%2F%2F27.download.real-debrid.com%2Fd%2FABCDEFGHIJ234%2Ffile.mkv";

    /// A query value goes when its name ENDS in a secret word, or when it is
    /// itself a URL carrying a credential, encoded or not, in either order.
    #[test]
    fn redact_masks_nested_upstream_urls_and_suffix_named_secrets() {
        assert_eq!(
            redact_sensitive_url(&format!("https://mfp.example.dev/proxy/stream?d={MFP_UPSTREAM}&api_password=hunter2")),
            "https://mfp.example.dev/proxy/stream?d=<redacted>&api_password=<redacted>",
        );
        assert_eq!(
            redact_sensitive_url("https://mfp.example.dev/proxy/stream?api_password=hunter2&d=https://27.download.real-debrid.com/d/ABCDEFGHIJ234/file.mkv"),
            "https://mfp.example.dev/proxy/stream?api_password=<redacted>&d=<redacted>",
        );
        assert_eq!(
            redact_sensitive_url("https://cdn.example.dev/v.m3u8?access_token=abc&h_authorization=Bearer%20xyz&lang=en#t=10"),
            "https://cdn.example.dev/v.m3u8?access_token=<redacted>&h_authorization=<redacted>&lang=en#t=10",
        );
    }

    /// Two inputs that crashed the first version. An all-ASCII URL whose
    /// DECODED nested value holds multibyte text next to an empty secret
    /// used to panic on a mid-char slice (it ran in load_video, before the
    /// stream reached mpv, and on the engine thread for mpv's own lines).
    /// A deep chain of nested `?d=` URLs used to recurse once per level and
    /// overflow the stack; it must now finish, and quickly.
    #[test]
    fn redact_survives_decoded_multibyte_and_deep_nesting() {
        let multibyte = "https://mfp.example.dev/proxy/stream?d=https%3A%2F%2Fcdn.example.dev%2Fv.mkv%3Ftoken%3D%26name%3D%E3%83%AF%E3%83%B3%E3%83%94%E3%83%BC%E3%82%B9&api_password=x";
        assert_eq!(
            redact_sensitive_url(multibyte),
            "https://mfp.example.dev/proxy/stream?d=https%3A%2F%2Fcdn.example.dev%2Fv.mkv%3Ftoken%3D%26name%3D%E3%83%AF%E3%83%B3%E3%83%94%E3%83%BC%E3%82%B9&api_password=<redacted>",
        );
        // The same shape, undecoded, straight into pass 2.
        let _ = redact_sensitive_url("https://h/v.mkv?token=&name=ワンピース&pin=&x=ü");

        let deep = format!("https://a/{}", "?d=https://a/".repeat(20_000));
        let started = std::time::Instant::now();
        let out = redact_sensitive_url(&deep);
        assert!(out.starts_with("https://a/?d=<redacted>"), "{}", &out[..40.min(out.len())]);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    /// libmpv's own lines are prose around a URL. Only the URL changes, the
    /// wrapping punctuation stays put, and a line without one is not copied.
    #[test]
    fn redact_urls_in_text_rewrites_only_the_urls() {
        assert_eq!(
            redact_urls_in_text("Failed to open https://27.download.real-debrid.com/d/ABCDEFGHIJ234/Breaking.Bad.S01E01.1080p.WEB-DL.mkv."),
            "Failed to open https://27.download.real-debrid.com/d/<redacted>/<redacted>.mkv.",
        );
        assert_eq!(
            redact_urls_in_text("Opening 'https://live.example.dev/hls/0f3a9c2e7b4d6a8f1e2c/seg1.ts' for reading"),
            "Opening 'https://live.example.dev/hls/<redacted>/seg1.ts' for reading",
        );
        // A `?` in the prose ahead of the URL does not hide the URL's path.
        assert_eq!(
            redact_urls_in_text(&format!("retry? Playing: https://mfp.example.dev/proxy/stream?d={MFP_UPSTREAM}")),
            "retry? Playing: https://mfp.example.dev/proxy/stream?d=<redacted>",
        );
        assert!(matches!(
            redact_urls_in_text("Multiple Dolby Vision RPUs found in one AU"),
            std::borrow::Cow::Borrowed(_),
        ));
    }

    /// A one-shot loopback server that answers with `reply`, or hangs up
    /// without answering when it is `None`. Returns the port.
    fn one_shot_server(reply: Option<&'static [u8]>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            if let Some(reply) = reply {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf);
                let _ = sock.write_all(reply);
            }
        });
        (port, handle)
    }

    /// The premise first: reqwest's own Display names the request URL. The
    /// log text must not, and must still say what kind of failure it was.
    #[tokio::test]
    async fn reqwest_error_log_text_never_carries_the_url() {
        let (port, server) = one_shot_server(None);
        let url = format!("http://127.0.0.1:{port}/stremio/{CONFIG_UUID}/stream/movie/tt0111161.json");
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let err = client.get(&url).send().await.expect_err("the server hung up");
        server.join().expect("server thread");
        assert!(err.to_string().contains(CONFIG_UUID), "premise: {err}");
        let line = reqwest_err_for_log(&err);
        assert!(!line.contains(CONFIG_UUID) && !line.contains("://"), "{line}");
        assert!(line.starts_with(describe_reqwest_err(&err)), "{line}");
    }

    /// A malformed body keeps serde's position, which is what makes a
    /// "JSON parse error" line worth reading.
    #[tokio::test]
    async fn reqwest_decode_error_log_text_keeps_the_serde_cause() {
        let (port, server) = one_shot_server(Some(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope",
        ));
        let url = format!("http://127.0.0.1:{port}/stremio/{CONFIG_UUID}/meta/movie/tt0111161.json");
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let resp = client.get(&url).send().await.expect("a 200");
        let err = resp.json::<serde_json::Value>().await.expect_err("not JSON");
        server.join().expect("server thread");
        let line = reqwest_err_for_log(&err);
        assert!(line.starts_with("decode failed: ") && line.contains("line 1"), "{line}");
        assert!(!line.contains(CONFIG_UUID), "{line}");
    }

    // ---- Stremio collection writes -----------------------------------------

    /// A manifest `check_collection_manifest` accepts, for `id` at `version`.
    fn collection_manifest(id: &str, version: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "version": version,
            "name": "Test Addon",
            "description": "for tests",
            "resources": ["catalog", { "name": "stream", "types": ["movie"], "idPrefixes": ["tt"] }],
            "types": ["movie", "series"],
            "catalogs": [{ "type": "movie", "id": "top", "name": "Top", "extra": [{ "name": "skip" }] }],
            "behaviorHints": { "configurable": true },
            "logo": "https://example.com/logo.png",
        })
    }

    /// A collection entry as the Stremio API returns one, with an extra key
    /// Aura does not model so the tests can prove it survives.
    fn collection_entry(url: &str, manifest: serde_json::Value, protected: bool) -> serde_json::Value {
        serde_json::json!({
            "transportUrl": url,
            "manifest": manifest,
            "flags": { "official": false, "protected": protected },
            "installedAt": 1_700_000_000,
        })
    }

    fn sample_collection() -> Vec<serde_json::Value> {
        vec![
            collection_entry("https://a.example/manifest.json", collection_manifest("a.addon", "1.0.0"), false),
            collection_entry("https://b.example/cfg/manifest.json", collection_manifest("b.addon", "2.0.0"), false),
            collection_entry("https://c.example/manifest.json", collection_manifest("c.addon", "3.0.0"), false),
        ]
    }

    /// `apply_refreshed_manifest` as the refresh calls it for `target`: the
    /// manifest fetched from `{target}/manifest.json`, literally.
    fn apply(
        collection: &mut [serde_json::Value],
        target: &str,
        fresh: &serde_json::Value,
    ) -> Result<usize, ManifestWriteSkip> {
        apply_refreshed_manifest(collection, target, &format!("{target}/manifest.json"), fresh)
    }

    #[test]
    fn refresh_merge_replaces_only_the_matching_manifest() {
        let mut collection = sample_collection();
        let original = collection.clone();
        let mut fresh = collection_manifest("b.addon", "2.1.0");
        fresh["catalogs"].as_array_mut().unwrap().push(serde_json::json!({ "type": "series", "id": "new" }));
        // A field Aura does not model must travel verbatim too.
        fresh["contactEmail"] = serde_json::json!("dev@example.com");

        let index = apply(&mut collection, "https://b.example/cfg", &fresh);
        assert_eq!(index, Ok(1));
        assert_eq!(collection.len(), original.len());
        assert_eq!(collection[0], original[0]);
        assert_eq!(collection[2], original[2]);
        assert_eq!(collection[1]["manifest"], fresh);
        // Everything else on the entry, byte for byte: the un-normalized
        // transportUrl string, the flags, the unmodelled key.
        assert_eq!(collection[1]["transportUrl"], "https://b.example/cfg/manifest.json");
        assert_eq!(collection[1]["flags"], original[1]["flags"]);
        assert_eq!(collection[1]["installedAt"], original[1]["installedAt"]);
        assert_eq!(collection[1].as_object().unwrap().len(), original[1].as_object().unwrap().len());
    }

    #[test]
    fn refresh_merge_refuses_an_invalid_manifest() {
        let bad: Vec<(&str, Box<dyn Fn(&mut serde_json::Value)>)> = vec![
            ("not an object", Box::new(|m| *m = serde_json::json!("nope"))),
            ("missing id", Box::new(|m| { m.as_object_mut().unwrap().remove("id"); })),
            ("empty name", Box::new(|m| m["name"] = serde_json::json!(""))),
            ("missing version", Box::new(|m| { m.as_object_mut().unwrap().remove("version"); })),
            ("non-semver version", Box::new(|m| m["version"] = serde_json::json!("1.0"))),
            ("numeric version", Box::new(|m| m["version"] = serde_json::json!(1))),
            ("empty resources", Box::new(|m| m["resources"] = serde_json::json!([]))),
            ("resource without a name", Box::new(|m| m["resources"] = serde_json::json!([{ "types": ["movie"] }]))),
            ("empty types", Box::new(|m| m["types"] = serde_json::json!([]))),
            ("non-string type", Box::new(|m| m["types"] = serde_json::json!(["movie", 3]))),
            ("missing catalogs", Box::new(|m| { m.as_object_mut().unwrap().remove("catalogs"); })),
            ("catalog without a type", Box::new(|m| m["catalogs"] = serde_json::json!([{ "id": "x" }]))),
            ("null behaviorHints", Box::new(|m| m["behaviorHints"] = serde_json::Value::Null)),
            ("string hint", Box::new(|m| m["behaviorHints"]["configurable"] = serde_json::json!("yes"))),
            ("numeric description", Box::new(|m| m["description"] = serde_json::json!(5))),
            ("over 1 MiB", Box::new(|m| m["description"] = serde_json::json!("x".repeat(MAX_COLLECTION_MANIFEST_BYTES)))),
        ];
        for (what, spoil) in bad {
            let mut collection = sample_collection();
            let original = collection.clone();
            let mut fresh = collection_manifest("b.addon", "2.1.0");
            spoil(&mut fresh);
            let out = apply(&mut collection, "https://b.example/cfg", &fresh);
            assert!(matches!(out, Err(ManifestWriteSkip::Invalid(_))), "{what}: {out:?}");
            assert_eq!(collection, original, "{what}: collection changed");
        }
    }

    #[test]
    fn refresh_merge_refuses_a_different_addon_id() {
        let mut collection = sample_collection();
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("someone.else", "9.0.0"));
        assert_eq!(out, Err(ManifestWriteSkip::IdChanged {
            stored: Some("b.addon".into()),
            fresh:  "someone.else".into(),
        }));
        assert_eq!(collection, original);

        // A stored entry with no readable id cannot be proved the same addon.
        let mut collection = sample_collection();
        collection[1]["manifest"].as_object_mut().unwrap().remove("id");
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("b.addon", "2.1.0"));
        assert!(matches!(out, Err(ManifestWriteSkip::IdChanged { stored: None, .. })), "{out:?}");
        assert_eq!(collection, original);
    }

    #[test]
    fn refresh_merge_needs_exactly_one_matching_entry() {
        let mut collection = sample_collection();
        let original = collection.clone();
        let out = apply(&mut collection, "https://z.example", &collection_manifest("z.addon", "1.0.0"));
        assert_eq!(out, Err(ManifestWriteSkip::NotInCollection));
        assert_eq!(collection, original);

        // The same url twice, once with the suffix and once without.
        let mut collection = sample_collection();
        collection.push(collection_entry("https://b.example/cfg/", collection_manifest("b.addon", "2.0.0"), false));
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("b.addon", "2.1.0"));
        assert_eq!(out, Err(ManifestWriteSkip::Ambiguous(2)));
        assert_eq!(collection, original);
    }

    /// One match is not enough: its transportUrl must be the very url the
    /// manifest was fetched from, since that is what the official apps load.
    #[test]
    fn refresh_merge_needs_the_exact_manifest_address() {
        for stored_url in ["https://b.example/cfg", "https://b.example/cfg/", "https://b.example/cfg//manifest.json"] {
            let mut collection = sample_collection();
            collection[1]["transportUrl"] = serde_json::json!(stored_url);
            let original = collection.clone();
            let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("b.addon", "2.1.0"));
            assert_eq!(out, Err(ManifestWriteSkip::OtherAddress), "{stored_url}");
            assert_eq!(collection, original, "{stored_url}");
        }
    }

    #[test]
    fn refresh_merge_refuses_configuration_required() {
        let mut fresh = collection_manifest("b.addon", "2.1.0");
        fresh["behaviorHints"]["configurationRequired"] = serde_json::json!(true);

        // Newly declared: the case a transient server fault produces.
        let mut collection = sample_collection();
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &fresh);
        assert_eq!(out, Err(ManifestWriteSkip::ConfigurationRequired));
        assert_eq!(collection, original);

        // Already declared by the stored manifest: still refused, as
        // stremio-core refuses to upgrade to such a manifest at all.
        let mut collection = sample_collection();
        collection[1]["manifest"]["behaviorHints"]["configurationRequired"] = serde_json::json!(true);
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &fresh);
        assert_eq!(out, Err(ManifestWriteSkip::ConfigurationRequired));
        assert_eq!(collection, original);
    }

    #[test]
    fn refresh_merge_skips_an_unchanged_manifest() {
        let mut collection = sample_collection();
        let original = collection.clone();
        // Deep-equal, not byte-equal: key order does not count as a change.
        let stored = collection[1]["manifest"].as_object().unwrap().clone();
        let reversed: serde_json::Map<String, serde_json::Value> =
            stored.into_iter().rev().collect();
        let out = apply(&mut collection, "https://b.example/cfg", &serde_json::Value::Object(reversed));
        assert_eq!(out, Err(ManifestWriteSkip::Unchanged));
        assert_eq!(collection, original);
    }

    #[test]
    fn refresh_merge_refuses_a_protected_entry() {
        let mut collection = sample_collection();
        collection[1]["flags"]["protected"] = serde_json::json!(true);
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("b.addon", "2.1.0"));
        assert_eq!(out, Err(ManifestWriteSkip::Protected));
        assert_eq!(collection, original);
    }

    /// A protected entry (Cinemeta) is never written, so it must never
    /// surface as a refusal the UI would report: Protected wins over every
    /// other guard.
    #[test]
    fn refresh_merge_reports_protected_before_any_other_guard() {
        let cases: Vec<(&str, Box<dyn Fn(&mut Vec<serde_json::Value>, &mut serde_json::Value)>)> = vec![
            ("unchanged", Box::new(|c, f| *f = c[1]["manifest"].clone())),
            ("other address", Box::new(|c, _| c[1]["transportUrl"] = serde_json::json!("https://b.example/cfg/"))),
            ("invalid", Box::new(|_, f| f["version"] = serde_json::json!("1.0"))),
            ("different id", Box::new(|_, f| f["id"] = serde_json::json!("someone.else"))),
            ("configuration required", Box::new(|_, f| f["behaviorHints"]["configurationRequired"] = serde_json::json!(true))),
        ];
        for (what, set_up) in cases {
            let mut collection = sample_collection();
            collection[1]["flags"]["protected"] = serde_json::json!(true);
            let mut fresh = collection_manifest("b.addon", "2.1.0");
            set_up(&mut collection, &mut fresh);
            let original = collection.clone();
            let out = apply(&mut collection, "https://b.example/cfg", &fresh);
            assert_eq!(out, Err(ManifestWriteSkip::Protected), "{what}");
            assert_eq!(collection, original, "{what}");
        }
    }

    /// `collection_manifest("b.addon", "2.0.0")` written out BY HAND as
    /// stremio-core's `Manifest` serializes it, i.e. what the entry holds once
    /// an official app has pushed the collection. Hand-written, not computed,
    /// so the tests below check `stremio_core_manifest` against an
    /// independent statement of that serialization.
    fn stremio_core_stored_manifest() -> serde_json::Value {
        serde_json::json!({
            "id": "b.addon",
            "version": "2.0.0",
            "name": "Test Addon",
            "contactEmail": null,
            "description": "for tests",
            "logo": "https://example.com/logo.png",
            "background": null,
            "types": ["movie", "series"],
            "resources": ["catalog", { "name": "stream", "types": ["movie"], "idPrefixes": ["tt"] }],
            "idPrefixes": null,
            "catalogs": [{
                "id": "top", "type": "movie", "name": "Top",
                "extra": [{ "name": "skip", "isRequired": false, "options": [], "optionsLimit": 1 }],
            }],
            "addonCatalogs": [],
            "behaviorHints": {
                "adult": false, "p2p": false, "configurable": true,
                "configurationRequired": false, "epgProvider": false,
            },
        })
    }

    /// The common case guard e exists for: an official app last wrote the
    /// collection, so the stored entry is stremio-core's serialization and
    /// never deep-equal to the raw manifest, yet nothing changed.
    #[test]
    fn refresh_merge_skips_a_manifest_an_official_app_stored() {
        let mut collection = sample_collection();
        collection[1]["manifest"] = stremio_core_stored_manifest();
        let original = collection.clone();
        let fresh = collection_manifest("b.addon", "2.0.0");
        assert_ne!(collection[1]["manifest"], fresh, "the fixture must differ as raw JSON");
        let out = apply(&mut collection, "https://b.example/cfg", &fresh);
        assert_eq!(out, Err(ManifestWriteSkip::Unchanged));
        assert_eq!(collection, original);

        // A real change against the same stored form still writes, verbatim.
        let mut fresh = collection_manifest("b.addon", "2.0.0");
        fresh["catalogs"].as_array_mut().unwrap().push(serde_json::json!({ "type": "series", "id": "new" }));
        let out = apply(&mut collection, "https://b.example/cfg", &fresh);
        assert_eq!(out, Ok(1));
        assert_eq!(collection[1]["manifest"], fresh);
        assert_eq!(collection[0], original[0]);
        assert_eq!(collection[2], original[2]);

        // So does a change to a field stremio-core keeps but Aura never
        // reads (an extra's options), since the official apps read it.
        let mut collection = original.clone();
        let mut fresh = collection_manifest("b.addon", "2.0.0");
        fresh["catalogs"][0]["extra"] = serde_json::json!([{ "name": "skip" }, { "name": "genre", "options": ["Drama"] }]);
        assert_eq!(apply(&mut collection, "https://b.example/cfg", &fresh), Ok(1));
    }

    #[test]
    fn stremio_core_manifest_matches_the_stremio_core_serialization() {
        assert_eq!(stremio_core_manifest(&collection_manifest("b.addon", "2.0.0")), Some(stremio_core_stored_manifest()));

        // Every normalization at once: unmodelled keys dropped (top level,
        // catalog, behaviorHints), a catalog repeated by (id, type) dropped,
        // an extra repeated by name dropped, extra defaults filled (null
        // options is []), a short-form catalog defaulted, a resource's
        // missing lists as null, an empty logo as null, a background URL
        // re-serialized as parsed.
        let raw = serde_json::json!({
            "id": "x.addon", "version": "1.2.3-beta.1+build", "name": "X",
            "logo": "", "background": "https://Example.com",
            "types": ["movie"],
            "resources": [{ "name": "meta" }, "stream"],
            "idPrefixes": ["tt", "tt"],
            "stremioAddonsConfig": { "issuer": "x" },
            "catalogs": [
                { "type": "movie", "id": "a", "genres": ["Drama"], "showInHome": true,
                  "extra": [{ "name": "genre", "options": null, "isRequired": true },
                            { "name": "genre", "options": ["Ignored"] },
                            { "name": "search", "optionsLimit": 3 }] },
                { "type": "movie", "id": "a", "name": "Repeat" },
                { "type": "series", "id": "a", "extraSupported": ["search", "search"] },
                { "type": "movie", "id": "b", "extra": null, "extraRequired": ["genre"] },
            ],
            "behaviorHints": { "newEpisodeNotifications": true, "p2p": true },
        });
        let expected = serde_json::json!({
            "id": "x.addon", "version": "1.2.3-beta.1+build", "name": "X",
            "contactEmail": null, "description": null,
            "logo": null, "background": "https://example.com/",
            "types": ["movie"],
            "resources": [{ "name": "meta", "types": null, "idPrefixes": null }, "stream"],
            "idPrefixes": ["tt", "tt"],
            "catalogs": [
                { "id": "a", "type": "movie", "name": null,
                  "extra": [{ "name": "genre", "isRequired": true, "options": [], "optionsLimit": 1 },
                            { "name": "search", "isRequired": false, "options": [], "optionsLimit": 3 }] },
                { "id": "a", "type": "series", "name": null, "extraRequired": [], "extraSupported": ["search"] },
                { "id": "b", "type": "movie", "name": null, "extraRequired": ["genre"], "extraSupported": [] },
            ],
            "addonCatalogs": [],
            "behaviorHints": {
                "adult": false, "p2p": true, "configurable": false,
                "configurationRequired": false, "epgProvider": false,
            },
        });
        assert_eq!(stremio_core_manifest(&raw), Some(expected));

        // What stremio-core cannot parse has no stored form, so guard e can
        // never match it.
        for bad in [
            serde_json::json!({ "id": "x", "version": "1.0", "name": "X", "types": [], "resources": [] }),
            serde_json::json!({ "id": "x", "version": "1.0.0", "name": "X", "types": [], "resources": [], "behaviorHints": null }),
            serde_json::json!({ "id": "x", "version": "1.0.0", "name": "X", "types": [], "resources": [],
                                "catalogs": [{ "id": "a", "type": "movie", "extraRequired": null }] }),
        ] {
            assert_eq!(stremio_core_manifest(&bad), None, "{bad}");
        }
    }

    #[test]
    fn semver_check_matches_the_semver_crate() {
        for ok in ["0.0.1", "1.2.3", "10.20.30", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-0.3.7",
                   "1.0.0-x-y-z.--", "1.0.0+001", "1.0.0-beta+exp.sha.5114f85", "1.0.0-rc.1+build.1"] {
            assert!(is_semver(ok), "{ok} should pass");
        }
        for bad in ["", "1", "1.0", "1.0.0.0", "v1.0.0", " 1.0.0", "1.0.0 ", "01.0.0", "1.00.0",
                    "1.0.0-", "1.0.0+", "1.0.0-01", "1.0.0-a..b", "1.0.0+a..b", "1.0.0-a+b+c",
                    "1.0.0-alpha_1", "99999999999999999999.0.0", "1.x.0"] {
            assert!(!is_semver(bad), "{bad:?} should fail");
        }
    }

    fn urls_of(collection: &[serde_json::Value]) -> Vec<&str> {
        collection.iter().map(|e| e["transportUrl"].as_str().unwrap_or("-")).collect()
    }

    #[test]
    fn reorder_keeps_duplicate_urls() {
        let collection = vec![
            collection_entry("https://a.example/manifest.json", collection_manifest("a.addon", "1.0.0"), false),
            collection_entry("https://b.example/manifest.json", collection_manifest("b.addon", "1.0.0"), false),
            collection_entry("https://B.example/", collection_manifest("b.addon", "1.0.1"), false),
            collection_entry("https://c.example/manifest.json", collection_manifest("c.addon", "1.0.0"), false),
        ];
        let urls = vec!["https://c.example".to_string(), "https://b.example".to_string(), "https://a.example".to_string()];
        let next = reorder_collection(collection.clone(), &urls, &[]).unwrap();
        assert_eq!(next.len(), collection.len());
        // `b` claims the FIRST b entry; the second trails with the leftovers.
        assert_eq!(urls_of(&next), vec![
            "https://c.example/manifest.json",
            "https://b.example/manifest.json",
            "https://a.example/manifest.json",
            "https://B.example/",
        ]);
        // A repeated url claims the second duplicate.
        let urls = vec!["https://b.example".to_string(), "https://b.example".to_string()];
        let next = reorder_collection(collection, &urls, &[]).unwrap();
        assert_eq!(urls_of(&next), vec![
            "https://b.example/manifest.json",
            "https://B.example/",
            "https://a.example/manifest.json",
            "https://c.example/manifest.json",
        ]);
    }

    #[test]
    fn reorder_leftovers_keep_their_original_order() {
        let collection: Vec<serde_json::Value> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|n| collection_entry(&format!("https://{n}.example/manifest.json"), collection_manifest(&format!("{n}.addon"), "1.0.0"), false))
            .collect();
        let next = reorder_collection(collection, &["https://d.example/".to_string()], &[]).unwrap();
        assert_eq!(urls_of(&next), vec![
            "https://d.example/manifest.json",
            "https://a.example/manifest.json",
            "https://b.example/manifest.json",
            "https://c.example/manifest.json",
            "https://e.example/manifest.json",
            "https://f.example/manifest.json",
        ]);
    }

    #[test]
    fn reorder_preserves_every_entry_including_one_without_a_url() {
        let mut collection = sample_collection();
        // An entry with no transportUrl is never claimed, and never dropped.
        collection.insert(1, serde_json::json!({ "manifest": collection_manifest("x.addon", "1.0.0") }));
        let urls = vec!["https://c.example/manifest.json".to_string()];
        let next = reorder_collection(collection.clone(), &urls, &[]).unwrap();
        assert_eq!(next.len(), collection.len());
        assert_eq!(urls_of(&next), vec![
            "https://c.example/manifest.json",
            "https://a.example/manifest.json",
            "-",
            "https://b.example/cfg/manifest.json",
        ]);
        // A permutation: every entry is still there, unmodified.
        for e in &collection {
            assert_eq!(next.iter().filter(|n| *n == e).count(), 1);
        }
    }

    /// A url the read cannot satisfy means the read lacks what the frontend
    /// listed (a partial read): refused, since pushing a permutation of it
    /// would delete the rest from the account.
    #[test]
    fn reorder_refuses_a_url_that_claims_no_entry() {
        let cases: Vec<(&str, Vec<&str>, usize)> = vec![
            ("unknown", vec!["https://nowhere.example", "https://c.example"], 1),
            ("empty", vec!["https://c.example", ""], 1),
            ("repeated past the entries held", vec!["https://a.example", "https://a.example/"], 1),
            ("every url unknown", vec!["https://x.example", "https://y.example"], 2),
        ];
        for (what, urls, unclaimed) in cases {
            let urls: Vec<String> = urls.into_iter().map(str::to_string).collect();
            assert_eq!(reorder_collection(sample_collection(), &urls, &[]), Err(unclaimed), "{what}");
        }
        // An empty read claims nothing, so it can never push [].
        assert_eq!(reorder_collection(Vec::new(), &["https://a.example".to_string()], &[]), Err(1));

        // A url for an addon Aura itself just removed claims nothing, and is
        // skipped rather than counted: the drag began before the remove
        // resolved. Any other unclaimed url still refuses.
        let urls: Vec<String> = ["https://c.example", "https://b.example/cfg", "https://a.example"]
            .iter()
            .map(|u| u.to_string())
            .collect();
        let without_b: Vec<serde_json::Value> = sample_collection().into_iter().filter(|e| e["transportUrl"] != "https://b.example/cfg/manifest.json").collect();
        let excused = vec!["https://b.example/cfg".to_string()];
        let next = reorder_collection(without_b.clone(), &urls, &excused).unwrap();
        assert_eq!(urls_of(&next), vec!["https://c.example/manifest.json", "https://a.example/manifest.json"]);
        let mut with_unknown = urls.clone();
        with_unknown.push("https://nowhere.example".to_string());
        assert_eq!(reorder_collection(without_b, &with_unknown, &excused), Err(1));
    }

    #[test]
    fn collection_read_guard_needs_every_shown_addon() {
        let collection = sample_collection();
        let shown = |urls: &[&str]| urls.iter().map(|u| u.to_string()).collect::<Vec<_>>();

        // No list (an older caller): nothing to check, even on an empty read.
        assert_eq!(check_collection_read(&collection, None, &[], false), Ok(()));
        assert_eq!(check_collection_read(&[], None, &[], false), Ok(()));

        // Every shown addon present, as Rust hands the url to the frontend
        // (a trailing slash aside).
        let all = shown(&["https://a.example", "https://b.example/cfg/", "https://c.example"]);
        assert_eq!(check_collection_read(&collection, Some(&all), &[], false), Ok(()));
        // A subset is fine: the read may hold more (added on another device).
        assert_eq!(check_collection_read(&collection, Some(&shown(&["https://a.example"])), &[], false), Ok(()));

        // A partial read.
        let partial = &collection[..1];
        assert_eq!(check_collection_read(partial, Some(&all), &[], false), Err(CollectionDrift::Missing(2)));
        // An empty read while the list showed addons.
        assert_eq!(check_collection_read(&[], Some(&all), &[], false), Err(CollectionDrift::Empty));
        // An empty list expects nothing, and empty urls carry no expectation.
        assert_eq!(check_collection_read(&[], Some(&[]), &[], false), Ok(()));
        assert_eq!(check_collection_read(&collection, Some(&shown(&["", "https://a.example"])), &[], false), Ok(()));

        // The url being added is naturally absent, so it is left out.
        let new = shown(&["https://new.example"]);
        let with_new = shown(&["https://a.example", "https://new.example"]);
        assert_eq!(check_collection_read(&collection, Some(&with_new), &[], false), Err(CollectionDrift::Missing(1)));
        assert_eq!(check_collection_read(&collection, Some(&with_new), &new, false), Ok(()));
        // Excluding it does not excuse an empty read of everything else.
        assert_eq!(check_collection_read(&[], Some(&with_new), &new, false), Err(CollectionDrift::Empty));
        assert_eq!(check_collection_read(&[], Some(&shown(&["https://new.example"])), &new, false), Ok(()));

        // So is an addon Aura itself just removed (a collection key, as
        // `note_recent_removals` records it), and only that one.
        let removed_b = shown(&["https://b.example/cfg"]);
        let without_b: Vec<serde_json::Value> = collection.iter().filter(|e| e["transportUrl"] != "https://b.example/cfg/manifest.json").cloned().collect();
        assert_eq!(check_collection_read(&without_b, Some(&all), &[], false), Err(CollectionDrift::Missing(1)));
        assert_eq!(check_collection_read(&without_b, Some(&all), &removed_b, false), Ok(()));
        assert_eq!(check_collection_read(&collection[..1], Some(&all), &removed_b, false), Err(CollectionDrift::Missing(1)));

        // Case matters unless the command matches case-insensitively.
        let upper = shown(&["https://A.example"]);
        assert_eq!(check_collection_read(&collection, Some(&upper), &[], false), Err(CollectionDrift::Missing(1)));
        assert_eq!(check_collection_read(&collection, Some(&upper), &[], true), Ok(()));
    }

    /// An entry an official app stored at `.../manifest.json/manifest.json`
    /// reaches the frontend as `.../manifest.json` (`get_synced_addons`
    /// strips one suffix). The guard must match that url as it is, not
    /// normalize it a second time, or the one entry refuses every write.
    #[test]
    fn collection_read_guard_matches_a_doubled_manifest_address() {
        let mut collection = sample_collection();
        collection.push(collection_entry(
            "https://d.example/x/manifest.json/manifest.json",
            collection_manifest("d.addon", "1.0.0"),
            false,
        ));
        let shown: Vec<String> = ["https://a.example", "https://b.example/cfg", "https://c.example", "https://d.example/x/manifest.json"]
            .iter()
            .map(|u| u.to_string())
            .collect();
        assert_eq!(check_collection_read(&collection, Some(&shown), &[], false), Ok(()));
        assert_eq!(check_collection_read(&collection, Some(&shown), &[], true), Ok(()));
        // And a reorder claims it by that same url, so nothing is unclaimed.
        let urls: Vec<String> = shown.iter().rev().cloned().collect();
        let next = reorder_collection(collection, &urls, &[]).unwrap();
        assert_eq!(urls_of(&next)[0], "https://d.example/x/manifest.json/manifest.json");
    }

    #[test]
    fn remove_refuses_a_protected_entry() {
        let mut collection = sample_collection();
        collection[1]["flags"]["protected"] = serde_json::json!(true);
        collection[1]["manifest"]["name"] = serde_json::json!("Cinemeta");
        assert_eq!(
            remove_from_collection(collection.clone(), "https://b.example/cfg", None, &[]),
            Err("Cinemeta is a built-in Stremio addon and can't be removed from your account.".to_string()),
        );
        // Any value but false counts, and a nameless entry still gets a sentence.
        collection[1]["flags"]["protected"] = serde_json::json!("yes");
        collection[1]["manifest"].as_object_mut().unwrap().remove("name");
        assert_eq!(
            remove_from_collection(collection, "https://b.example/cfg/manifest.json", None, &[]),
            Err("This addon is a built-in Stremio addon and can't be removed from your account.".to_string()),
        );
    }

    #[test]
    fn remove_drops_only_the_matching_entries() {
        let mut collection = sample_collection();
        // Two forms of one url both go; the rest keep their order.
        collection.push(collection_entry("https://b.example/cfg/", collection_manifest("b.addon", "2.0.0"), false));
        let shown: Vec<String> = ["https://a.example", "https://b.example/cfg", "https://c.example"]
            .iter()
            .map(|u| u.to_string())
            .collect();
        let (next, removed) = remove_from_collection(collection, "https://b.example/cfg/", Some(&shown), &[]).unwrap();
        assert_eq!(urls_of(&next), vec!["https://a.example/manifest.json", "https://c.example/manifest.json"]);
        // Reported by collection key, for `note_recent_removals`.
        assert_eq!(removed, vec!["https://b.example/cfg".to_string(), "https://b.example/cfg".to_string()]);

        assert_eq!(
            remove_from_collection(sample_collection(), "https://z.example", None, &[]),
            Err("Addon not found in your Stremio account".to_string()),
        );
    }

    #[test]
    fn remove_never_pushes_from_a_short_read() {
        // An empty read, with or without a list, is never pushed.
        assert_eq!(remove_from_collection(Vec::new(), "https://a.example", None, &[]), Err(COLLECTION_CHANGED.to_string()));
        // A read missing an addon the list shows would delete it too.
        let shown: Vec<String> = ["https://a.example", "https://c.example"].iter().map(|u| u.to_string()).collect();
        let partial = vec![sample_collection().remove(0)];
        assert_eq!(remove_from_collection(partial.clone(), "https://a.example", Some(&shown), &[]), Err(COLLECTION_CHANGED.to_string()));
        // Unless the missing one is an addon Aura itself just removed: a
        // second remove queued behind the first still lists it.
        let excused = vec!["https://c.example".to_string()];
        let (next, _) = remove_from_collection(partial, "https://a.example", Some(&shown), &excused).unwrap();
        assert!(next.is_empty());
    }

    /// An entry an official app stored at `.../manifest.json/manifest.json`
    /// (P) reaches the frontend as `.../manifest.json`, the very address of
    /// its sibling Q's transportUrl. Each row removes its own entry.
    #[test]
    fn remove_takes_the_clicked_entry_not_its_sibling() {
        let q = "https://h/x/manifest.json";
        let p = "https://h/x/manifest.json/manifest.json";
        let collection = vec![
            collection_entry(q, collection_manifest("q.addon", "1.0.0"), false),
            collection_entry(p, collection_manifest("p.addon", "1.0.0"), false),
        ];
        // The two rows, as `get_synced_addons` derives them.
        let (q_row, p_row) = ("https://h/x", "https://h/x/manifest.json");
        let shown: Vec<String> = vec![q_row.to_string(), p_row.to_string()];

        let (next, removed) = remove_from_collection(collection.clone(), p_row, Some(&shown), &[]).unwrap();
        assert_eq!(urls_of(&next), vec![q]);
        assert_eq!(removed, vec![p_row.to_string()]);

        let (next, removed) = remove_from_collection(collection.clone(), q_row, Some(&shown), &[]).unwrap();
        assert_eq!(urls_of(&next), vec![p]);
        assert_eq!(removed, vec![q_row.to_string()]);

        // P alone is removable by its own row too.
        let (next, _) = remove_from_collection(vec![collection[1].clone()], p_row, Some(&shown[1..]), &[]).unwrap();
        assert!(next.is_empty());
        // A second remove of P's row, queued behind the one that took P out
        // (so P's key is excused and its row still listed), must not fall
        // back to the normalized key, which is Q's: nothing to push, Q kept.
        let other = collection_entry("https://c.example/manifest.json", collection_manifest("c.addon", "1.0.0"), false);
        let after_p = vec![collection[0].clone(), other];
        let mut shown_c = shown.clone();
        shown_c.push("https://c.example".to_string());
        let excused = vec![p_row.to_string()];
        let (next, removed) = remove_from_collection(after_p.clone(), p_row, Some(&shown_c), &excused).unwrap();
        assert!(removed.is_empty());
        assert_eq!(next, after_p);
        // Likewise for an older caller that sent no list.
        let (next, removed) = remove_from_collection(after_p.clone(), p_row, None, &excused).unwrap();
        assert!(removed.is_empty());
        assert_eq!(next, after_p);
        // Q's own row still removes Q while P is excused.
        let (next, removed) = remove_from_collection(after_p, q_row, Some(&shown_c), &excused).unwrap();
        assert_eq!(urls_of(&next), vec!["https://c.example/manifest.json"]);
        assert_eq!(removed, vec![q_row.to_string()]);
        // And a url that matches no key exactly still falls back to the
        // normalized form, as before.
        let (next, _) = remove_from_collection(sample_collection(), "https://a.example/manifest.json", None, &[]).unwrap();
        assert_eq!(urls_of(&next), vec!["https://b.example/cfg/manifest.json", "https://c.example/manifest.json"]);
    }

    #[test]
    fn add_never_pushes_from_an_empty_or_short_read() {
        let manifest = collection_manifest("new.addon", "1.0.0");
        let add = |collection: Vec<serde_json::Value>, expected: Option<&[String]>, excused: &[String]| {
            add_to_collection(collection, "https://new.example", manifest.clone(), expected, excused)
        };
        // An empty read is refused whatever the list held, even an empty
        // list (the list never loaded) or none at all (an older caller):
        // pushing [new] from it would delete every other addon.
        let none: &[String] = &[];
        assert_eq!(add(Vec::new(), None, &[]), Err(COLLECTION_CHANGED.to_string()));
        assert_eq!(add(Vec::new(), Some(none), &[]), Err(COLLECTION_CHANGED.to_string()));
        let shown: Vec<String> = ["https://a.example", "https://b.example/cfg", "https://c.example"]
            .iter()
            .map(|u| u.to_string())
            .collect();
        assert_eq!(add(Vec::new(), Some(&shown), &[]), Err(COLLECTION_CHANGED.to_string()));
        // A read missing a shown addon, unless Aura itself just removed it.
        let partial: Vec<serde_json::Value> = sample_collection().into_iter().take(2).collect();
        assert_eq!(add(partial.clone(), Some(&shown), &[]), Err(COLLECTION_CHANGED.to_string()));
        assert!(add(partial, Some(&shown), &["https://c.example".to_string()]).is_ok());

        // A full read gains exactly the new entry, at the end, and the new
        // url may already be in the list without being refused as missing.
        let mut with_new = shown.clone();
        with_new.push("https://new.example".to_string());
        let next = add(sample_collection(), Some(&with_new), &[]).unwrap();
        assert_eq!(next.len(), 4);
        assert_eq!(&next[..3], &sample_collection()[..]);
        assert_eq!(next[3], serde_json::json!({ "manifest": manifest, "transportUrl": "https://new.example/manifest.json" }));

        // Already there under any form of its url.
        let mut held = sample_collection();
        held.push(collection_entry("https://new.example/", collection_manifest("new.addon", "1.0.0"), false));
        assert_eq!(add(held, Some(&shown), &[]), Err("Addon already in your Stremio account".to_string()));
    }

    /// The writers queued behind a remove read its record, for that account
    /// only, and the record is bounded.
    #[test]
    fn recent_removals_are_per_account_and_bounded() {
        let (one, two) = ("test-account-one-7f3a", "test-account-two-7f3a");
        note_recent_removals(one, vec!["https://gone.example".to_string(), "https://back.example".to_string()]);
        assert!(recent_removals(one).contains(&"https://gone.example".to_string()));
        assert!(!recent_removals(two).contains(&"https://gone.example".to_string()));
        // Added back by Aura: its absence is news again.
        forget_recent_removal(one, "https://back.example");
        assert!(!recent_removals(one).contains(&"https://back.example".to_string()));
        assert!(recent_removals(one).contains(&"https://gone.example".to_string()));
        note_recent_removals(two, (0..RECENT_REMOVALS_CAP + 5).map(|i| format!("https://{i}.example")).collect());
        assert!(RECENT_REMOVALS.get().unwrap().lock().unwrap().len() <= RECENT_REMOVALS_CAP);
        assert!(!recent_removals(one).contains(&"https://gone.example".to_string()), "evicted by the cap");
    }

    #[test]
    fn add_refuses_a_manifest_stremio_could_not_load() {
        assert_eq!(check_addable_manifest(&collection_manifest("a.addon", "1.0.0")), Ok(()));
        let refused = |m: serde_json::Value| {
            let err = check_addable_manifest(&m).unwrap_err();
            assert!(err.starts_with("This addon's manifest can't be added to your Stremio account: "), "{err}");
            err
        };
        // stremio-addon-linter accepts a `v` prefix; stremio-core does not.
        let mut m = collection_manifest("a.addon", "1.0.0");
        m["version"] = serde_json::json!("v1.0.0");
        refused(m);
        let mut m = collection_manifest("a.addon", "1.0.0");
        m["behaviorHints"] = serde_json::Value::Null;
        refused(m);
        let mut m = collection_manifest("a.addon", "1.0.0");
        m["behaviorHints"]["configurationRequired"] = serde_json::json!(true);
        assert!(refused(m).ends_with("the addon needs configuring first"));
        let mut m = collection_manifest("a.addon", "1.0.0");
        m["resources"][1]["x"] = nested_arrays(30);
        assert!(refused(m).ends_with("the manifest nests more than 32 levels deep"));
    }

    /// `k` arrays nested inside each other, `[[[...]]]`.
    fn nested_arrays(k: usize) -> serde_json::Value {
        let mut v = serde_json::json!([]);
        for _ in 1..k {
            v = serde_json::json!([v]);
        }
        v
    }

    #[test]
    fn nesting_bound_is_32_levels() {
        // manifest (1) > resources (2) > resource object (3) > k arrays.
        let mut ok = collection_manifest("b.addon", "2.1.0");
        ok["resources"][1]["x"] = nested_arrays(29);
        assert_eq!(check_collection_manifest(&ok), Ok(()));
        let mut deep = collection_manifest("b.addon", "2.1.0");
        deep["resources"][1]["x"] = nested_arrays(30);
        assert_eq!(check_collection_manifest(&deep), Err("the manifest nests more than 32 levels deep"));
        // Well past serde_json's own 128-level parse limit, walked without
        // recursion.
        assert!(json_nests_deeper_than(&nested_arrays(500), MAX_COLLECTION_MANIFEST_DEPTH));
        assert!(!json_nests_deeper_than(&serde_json::json!({ "a": { "b": [1, 2] } }), 3));
        assert!(json_nests_deeper_than(&serde_json::json!({ "a": { "b": [1, 2] } }), 2));
        assert!(!json_nests_deeper_than(&serde_json::json!("scalar"), 0));

        // And through the refresh write, which must not push it.
        let mut collection = sample_collection();
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &deep);
        assert_eq!(out, Err(ManifestWriteSkip::Invalid("the manifest nests more than 32 levels deep")));
        assert_eq!(collection, original);
    }

    /// AIOMetadata stamps `_timestamp` and `_debug` into every response, so
    /// once the stored entry is raw a raw compare never matches. In
    /// stremio-core terms on both sides it does.
    #[test]
    fn refresh_merge_ignores_fields_stremio_core_drops() {
        let mut collection = sample_collection();
        collection[1]["manifest"]["_timestamp"] = serde_json::json!(1_700_000_000_000u64);
        collection[1]["manifest"]["_debug"] = serde_json::json!({ "timestamp": "2026-09-01T00:00:00Z" });
        collection[1]["manifest"]["catalogs"][0]["genres"] = serde_json::json!(["Drama"]);
        let original = collection.clone();
        let mut fresh = collection_manifest("b.addon", "2.0.0");
        fresh["_timestamp"] = serde_json::json!(1_800_000_000_000u64);
        fresh["_debug"] = serde_json::json!({ "timestamp": "2026-09-25T00:00:00Z" });
        fresh["catalogs"][0]["genres"] = serde_json::json!(["Comedy"]);
        assert_eq!(apply(&mut collection, "https://b.example/cfg", &fresh), Err(ManifestWriteSkip::Unchanged));
        assert_eq!(collection, original);
    }

    #[test]
    fn stremio_core_manifest_is_idempotent() {
        let stored = stremio_core_stored_manifest();
        assert_eq!(stremio_core_manifest(&stored), Some(stored));
    }

    #[test]
    fn refresh_merge_refuses_a_manifest_that_offers_less() {
        type Change = Box<dyn Fn(&mut serde_json::Value, &mut serde_json::Value)>;
        let cases: Vec<(&str, Change, ManifestReduction)> = vec![
            ("a catalog", Box::new(|_, f| { f["catalogs"].as_array_mut().unwrap().remove(0); }),
                ManifestReduction { catalogs: 1, ..Default::default() }),
            ("a catalog of another type", Box::new(|_, f| f["catalogs"][0]["type"] = serde_json::json!("series")),
                ManifestReduction { catalogs: 1, ..Default::default() }),
            ("a resource", Box::new(|_, f| f["resources"] = serde_json::json!(["catalog"])),
                ManifestReduction { resources: 1, ..Default::default() }),
            ("a type", Box::new(|_, f| f["types"] = serde_json::json!(["movie"])),
                ManifestReduction { types: 1, ..Default::default() }),
            ("an addon catalog", Box::new(|s, _| s["addonCatalogs"] = serde_json::json!([{ "type": "other", "id": "x" }])),
                ManifestReduction { addon_catalogs: 1, ..Default::default() }),
            ("an idPrefix", Box::new(|s, f| {
                s["idPrefixes"] = serde_json::json!(["tt", "kitsu"]);
                f["idPrefixes"] = serde_json::json!(["tt"]);
            }), ManifestReduction { id_prefixes: 1, ..Default::default() }),
            ("idPrefixes nulled", Box::new(|s, _| s["idPrefixes"] = serde_json::json!(["tt", "kitsu"])),
                ManifestReduction { id_prefixes: 2, ..Default::default() }),
            ("a lower version", Box::new(|_, f| f["version"] = serde_json::json!("1.9.9")),
                ManifestReduction { older_version: true, ..Default::default() }),
            ("a pre-release of the same version", Box::new(|_, f| f["version"] = serde_json::json!("2.0.0-beta.1")),
                ManifestReduction { older_version: true, ..Default::default() }),
            ("several at once", Box::new(|_, f| {
                f["catalogs"].as_array_mut().unwrap().remove(0);
                f["resources"] = serde_json::json!(["catalog"]);
                f["version"] = serde_json::json!("1.0.0");
            }), ManifestReduction { catalogs: 1, resources: 1, older_version: true, ..Default::default() }),
            // Every id (no manifest-level list) narrowed to a list.
            ("idPrefixes declared where none were", Box::new(|_, f| f["idPrefixes"] = serde_json::json!(["tt"])),
                ManifestReduction { narrowed_ids: true, ..Default::default() }),
            // AIOStreams-shaped: types and ids live on the full-form stream
            // resource only, and an upstream that failed simply leaves its
            // part out while every name, type and catalog stays.
            ("a stream resource's id prefix", Box::new(|s, f| {
                s["resources"][1]["idPrefixes"] = serde_json::json!(["tt", "kitsu", "tmdb:"]);
                f["resources"][1]["idPrefixes"] = serde_json::json!(["tt", "kitsu"]);
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            ("a stream resource from every id to a list", Box::new(|s, _| {
                s["resources"][1].as_object_mut().unwrap().remove("idPrefixes");
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            ("a stream resource's empty id list (every id) to a list", Box::new(|s, _| {
                s["resources"][1]["idPrefixes"] = serde_json::json!([]);
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            ("a stream resource's type, the manifest's types unchanged", Box::new(|s, _| {
                s["resources"][1]["types"] = serde_json::json!(["movie", "series"]);
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            ("a stream resource's types dropped (none served)", Box::new(|_, f| {
                f["resources"][1].as_object_mut().unwrap().remove("types");
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            ("a short-form stream narrowed by the manifest's idPrefixes", Box::new(|s, f| {
                s["resources"] = serde_json::json!(["catalog", "stream"]);
                f["resources"] = serde_json::json!(["catalog", "stream"]);
                f["idPrefixes"] = serde_json::json!(["tt"]);
            }), ManifestReduction { narrowed_resources: 1, narrowed_ids: true, ..Default::default() }),
            ("a short-form stream losing a manifest type", Box::new(|s, f| {
                s["resources"] = serde_json::json!(["catalog", "stream"]);
                f["resources"] = serde_json::json!(["catalog", "stream"]);
                f["types"] = serde_json::json!(["movie"]);
            }), ManifestReduction { types: 1, narrowed_resources: 1, ..Default::default() }),
            // stremio-core reads only the FIRST resource of a name, so a
            // second one that still offers everything does not help.
            ("a first stream resource narrowed behind a wide second one", Box::new(|_, f| {
                f["resources"][1]["idPrefixes"] = serde_json::json!(["kitsu"]);
                f["resources"].as_array_mut().unwrap().push(serde_json::json!({ "name": "stream", "types": ["movie"] }));
            }), ManifestReduction { narrowed_resources: 1, ..Default::default() }),
            // A catalog kept by id and type whose extras narrow: stremio-core
            // stops sending it a search, or the Board can no longer request it.
            ("a catalog's search extra", Box::new(|s, _| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "skip" }, { "name": "search" }]);
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            ("an extra newly required", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "options": ["Drama"] }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": ["Drama"] }]);
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            ("a new required extra", Box::new(|_, f| {
                f["catalogs"][0]["extra"].as_array_mut().unwrap()
                    .push(serde_json::json!({ "name": "genre", "isRequired": true, "options": ["Drama"] }));
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            ("a required extra's options emptied", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": ["Drama"] }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": [] }]);
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            // The degraded genre upstream: required and optionless at once,
            // one catalog narrowed.
            ("an extra newly required with no options", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "options": ["Drama"] }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": null }]);
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            // Short form (`extraSupported` / `extraRequired`) reads the same.
            ("a short-form extra name", Box::new(|s, f| {
                s["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["search", "skip"] });
                f["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["skip"] });
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            ("a short-form extra newly required", Box::new(|s, f| {
                s["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["genre"] });
                f["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["genre"], "extraRequired": ["genre"] });
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            // A short-form extra carries no options, so a required one with
            // options that turns short form loses them.
            ("a required extra's options lost to the short form", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": ["Drama"] }]);
                f["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["genre"], "extraRequired": ["genre"] });
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
            ("an addon catalog's extra", Box::new(|s, f| {
                s["addonCatalogs"] = serde_json::json!([{ "type": "other", "id": "x", "extra": [{ "name": "search" }] }]);
                f["addonCatalogs"] = serde_json::json!([{ "type": "other", "id": "x" }]);
            }), ManifestReduction { narrowed_catalogs: 1, ..Default::default() }),
        ];
        for (what, change, expected) in cases {
            let mut collection = sample_collection();
            let mut fresh = collection_manifest("b.addon", "2.0.0");
            // Something real must change, or guard e would answer first.
            fresh["catalogs"].as_array_mut().unwrap().push(serde_json::json!({ "type": "series", "id": "extra" }));
            change(&mut collection[1]["manifest"], &mut fresh);
            let original = collection.clone();
            let out = apply(&mut collection, "https://b.example/cfg", &fresh);
            match out {
                Err(ManifestWriteSkip::Reduced { lost, .. }) => assert_eq!(lost, expected, "{what}"),
                other => panic!("{what}: {other:?}"),
            }
            assert_eq!(collection, original, "{what}: collection changed");
        }
    }

    #[test]
    fn refresh_merge_writes_additive_and_equal_shape_changes() {
        type Change = Box<dyn Fn(&mut serde_json::Value, &mut serde_json::Value)>;
        let cases: Vec<(&str, Change)> = vec![
            ("a new catalog", Box::new(|_, f| {
                f["catalogs"].as_array_mut().unwrap().push(serde_json::json!({ "type": "series", "id": "new" }));
            })),
            ("a renamed catalog", Box::new(|_, f| f["catalogs"][0]["name"] = serde_json::json!("Popular"))),
            ("a new resource and type", Box::new(|_, f| {
                f["resources"].as_array_mut().unwrap().push(serde_json::json!("meta"));
                f["types"].as_array_mut().unwrap().push(serde_json::json!("anime"));
            })),
            ("an optional extra added", Box::new(|_, f| {
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "skip" }, { "name": "genre", "options": ["Drama"] }]);
            })),
            ("an extra's options added", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "skip" }, { "name": "genre" }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "skip" }, { "name": "genre", "options": ["Drama"] }]);
            })),
            ("a required extra given options", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": [] }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": ["Drama"] }]);
            })),
            ("isRequired relaxed", Box::new(|s, f| {
                s["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "isRequired": true, "options": ["Drama"] }]);
                f["catalogs"][0]["extra"] = serde_json::json!([{ "name": "genre", "options": ["Drama"] }]);
            })),
            ("a short-form catalog written in full form", Box::new(|s, f| {
                s["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["search"] });
                f["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extra": [{ "name": "search" }] });
            })),
            // stremio-core yields only `extraSupported` names, so a name only
            // in `extraRequired` was never an extra to lose.
            ("a short-form required-only name dropped", Box::new(|s, f| {
                s["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["skip"], "extraRequired": ["genre"] });
                f["catalogs"][0] = serde_json::json!({ "type": "movie", "id": "top", "extraSupported": ["skip"], "name": "Top" });
            })),
            ("a higher version only", Box::new(|_, f| f["version"] = serde_json::json!("2.0.1"))),
            ("idPrefixes widened", Box::new(|s, f| {
                s["idPrefixes"] = serde_json::json!(["tt"]);
                f["idPrefixes"] = serde_json::json!(["tt", "kitsu"]);
            })),
            ("a release of a stored pre-release", Box::new(|s, _| s["version"] = serde_json::json!("2.0.0-rc.1"))),
            ("a stream resource's id prefixes widened", Box::new(|_, f| {
                f["resources"][1]["idPrefixes"] = serde_json::json!(["tt", "kitsu"]);
            })),
            ("a stream resource opened to every id", Box::new(|_, f| {
                f["resources"][1].as_object_mut().unwrap().remove("idPrefixes");
            })),
            ("a stream resource's prefix generalized", Box::new(|s, f| {
                s["resources"][1]["idPrefixes"] = serde_json::json!(["tmdb:movie"]);
                f["resources"][1]["idPrefixes"] = serde_json::json!(["tmdb:"]);
            })),
            ("a stream resource's types widened", Box::new(|_, f| {
                f["resources"][1]["types"] = serde_json::json!(["movie", "series"]);
            })),
            // A resource that served no type (full form, no `types`) had
            // nothing to lose.
            ("a typeless resource narrowed", Box::new(|s, f| {
                s["resources"].as_array_mut().unwrap().push(serde_json::json!({ "name": "meta" }));
                f["resources"].as_array_mut().unwrap().push(serde_json::json!({ "name": "meta", "idPrefixes": ["tt"] }));
            })),
            // Catalog resources are gated on the catalog lists, which are
            // unchanged here.
            ("a catalog resource's types narrowed", Box::new(|s, f| {
                s["resources"][0] = serde_json::json!({ "name": "catalog", "types": ["movie", "series"] });
                f["resources"][0] = serde_json::json!({ "name": "catalog", "types": ["movie"] });
            })),
        ];
        for (what, change) in cases {
            let mut collection = sample_collection();
            let mut fresh = collection_manifest("b.addon", "2.0.0");
            change(&mut collection[1]["manifest"], &mut fresh);
            let original = collection.clone();
            assert_eq!(apply(&mut collection, "https://b.example/cfg", &fresh), Ok(1), "{what}");
            assert_eq!(collection[1]["manifest"], fresh, "{what}");
            assert_eq!(collection[0], original[0], "{what}");
            assert_eq!(collection[2], original[2], "{what}");
        }
    }

    /// A stored manifest stremio-core cannot parse gives nothing to prove a
    /// reduction against, so the write is refused rather than guessed.
    #[test]
    fn refresh_merge_refuses_when_the_stored_manifest_is_unreadable() {
        let mut collection = sample_collection();
        collection[1]["manifest"]["version"] = serde_json::json!("2.0");
        let original = collection.clone();
        let out = apply(&mut collection, "https://b.example/cfg", &collection_manifest("b.addon", "2.1.0"));
        assert_eq!(out, Err(ManifestWriteSkip::StoredUnreadable));
        assert_eq!(collection, original);
    }

    #[test]
    fn reduction_is_described_by_counts() {
        let r = |lost: ManifestReduction| lost.describe();
        assert_eq!(r(ManifestReduction { catalogs: 1, ..Default::default() }), "remove 1 catalog");
        assert_eq!(r(ManifestReduction { catalogs: 2, resources: 1, ..Default::default() }), "remove 1 resource and 2 catalogs");
        assert_eq!(
            r(ManifestReduction { resources: 2, types: 1, catalogs: 3, id_prefixes: 1, ..Default::default() }),
            "remove 2 resources, 1 type, 3 catalogs and 1 id prefix",
        );
        assert_eq!(r(ManifestReduction { older_version: true, ..Default::default() }), "lower its version");
        assert_eq!(
            r(ManifestReduction { addon_catalogs: 2, older_version: true, ..Default::default() }),
            "remove 2 addon catalogs, and lower its version",
        );
        assert_eq!(r(ManifestReduction { narrowed_resources: 1, ..Default::default() }), "narrow what 1 resource serves");
        assert_eq!(r(ManifestReduction { narrowed_ids: true, ..Default::default() }), "narrow the ids it serves");
        assert_eq!(r(ManifestReduction { narrowed_catalogs: 1, ..Default::default() }), "narrow 1 catalog's filters");
        assert_eq!(r(ManifestReduction { narrowed_catalogs: 2, ..Default::default() }), "narrow 2 catalogs' filters");
        assert_eq!(
            r(ManifestReduction { narrowed_resources: 1, narrowed_catalogs: 3, older_version: true, ..Default::default() }),
            "narrow what 1 resource serves, narrow 3 catalogs' filters, and lower its version",
        );
        assert_eq!(
            r(ManifestReduction { catalogs: 1, narrowed_resources: 2, narrowed_ids: true, older_version: true, ..Default::default() }),
            "remove 1 catalog, narrow what 2 resources serve, narrow the ids it serves, and lower its version",
        );
        assert!(ManifestReduction::default().is_empty());
    }

    /// The literal fetched url is what counts: an address whose base itself
    /// ends in `/manifest.json` normalizes like the plain one, yet the
    /// official apps load a different url.
    #[test]
    fn refresh_merge_compares_the_literal_fetched_url() {
        let mut collection = sample_collection();
        let original = collection.clone();
        let out = apply_refreshed_manifest(
            &mut collection,
            "https://a.example",
            "https://a.example/manifest.json/manifest.json",
            &collection_manifest("a.addon", "1.0.1"),
        );
        assert_eq!(out, Err(ManifestWriteSkip::OtherAddress));
        assert_eq!(collection, original);
    }

    #[test]
    fn semver_precedence_follows_the_spec() {
        use std::cmp::Ordering::{Equal, Greater, Less};
        // The chain from semver.org section 11, plus the core numbers.
        let chain = [
            "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2",
            "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "1.10.0", "2.0.0",
        ];
        for pair in chain.windows(2) {
            assert_eq!(semver_precedence(pair[0], pair[1]), Some(Less), "{} < {}", pair[0], pair[1]);
            assert_eq!(semver_precedence(pair[1], pair[0]), Some(Greater), "{} > {}", pair[1], pair[0]);
        }
        assert_eq!(semver_precedence("1.0.0+a", "1.0.0+b"), Some(Equal));
        assert_eq!(semver_precedence("1.0.0-99999999999999999999999", "1.0.0-100000000000000000000000"), Some(Less));
        assert_eq!(semver_precedence("1.0", "1.0.0"), None);
        assert_eq!(semver_precedence("1.0.0", "v1.0.0"), None);
    }

    #[test]
    fn account_api_errors_are_recognised_in_both_shapes() {
        let err = |v: serde_json::Value| account_api_error(&v, "refused");
        // The live API's answer to an invalid session.
        assert_eq!(
            err(serde_json::json!({ "error": { "code": 1, "message": "Session does not exist" } })),
            Some(SESSION_EXPIRED.to_string()),
        );
        assert_eq!(err(serde_json::json!({ "error": "session expired" })), Some(SESSION_EXPIRED.to_string()));
        assert_eq!(
            err(serde_json::json!({ "error": { "code": 7, "message": "Addon collection too large" } })),
            Some("Addon collection too large".to_string()),
        );
        assert_eq!(err(serde_json::json!({ "error": { "code": 7 } })), Some("refused".to_string()));
        assert_eq!(err(serde_json::json!({ "error": "" })), None);
        assert_eq!(err(serde_json::json!({ "error": null, "result": { "addons": [] } })), None);
        assert_eq!(err(serde_json::json!({ "result": { "success": true } })), None);
    }
}
