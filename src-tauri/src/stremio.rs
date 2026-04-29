use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

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

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent("Aura/0.1")
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
            .user_agent("Aura/0.1")
            .build()
            .expect("Account HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Stremio wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WireManifest {
    name: String,
    catalogs: Vec<WireCatalogEntry>,
    #[serde(default)]
    resources: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct WireCatalogEntry {
    #[serde(rename = "type")]
    media_type: String,
    id: String,
    name: Option<String>,
    #[serde(default)]
    extra: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct CatalogResponse {
    #[serde(default)]
    metas: Vec<WireMeta>,
}

#[derive(Deserialize)]
struct WireMeta {
    id: String,
    #[serde(rename = "type")]
    media_type: String,
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
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct CatalogInfo {
    pub media_type: String,
    pub id: String,
    pub name: String,
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
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LibraryItem {
    #[serde(rename = "_id")]
    pub id: String,
    #[serde(rename = "type")]
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
    #[serde(rename = "_ctime", default)]
    pub ctime: Option<String>,
    #[serde(rename = "_mtime", default)]
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
    }
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

pub fn validate_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("URL must use the http or https scheme".into())
    }
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

    Ok((wire, search_in_extra || search_in_resources))
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

#[tauri::command]
pub async fn get_addon_manifest(addon_url: String) -> Result<AddonManifest, String> {
    validate_url(&addon_url)?;
    let base = addon_url.trim_end_matches('/');
    let (wire, has_search) = fetch_manifest(base).await?;

    let catalogs = wire
        .catalogs
        .into_iter()
        .map(|c| {
            let display_name = c
                .name
                .unwrap_or_else(|| format!("{} · {}", title_case(&c.media_type), c.id));
            CatalogInfo { name: display_name, media_type: c.media_type, id: c.id }
        })
        .collect();

    Ok(AddonManifest { name: wire.name, catalogs, has_search })
}

#[tauri::command]
pub async fn add_addon<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
) -> Result<AddonEntry, String> {
    validate_url(&url)?;
    let base = url.trim_end_matches('/').to_string();
    let (wire, has_search) = fetch_manifest(&base).await?;

    let mut list = addons::load(&app)?;
    if list.iter().any(|a| a.url.trim_end_matches('/') == base) {
        return Err("Addon already added".into());
    }

    let entry = AddonEntry { url: base, name: wire.name, has_search };
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

// ---------------------------------------------------------------------------
// Commands — catalog browsing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_catalog(
    addon_url: String,
    catalog_type: String,
    catalog_id: String,
) -> Result<Vec<MetaPreview>, String> {
    validate_url(&addon_url)?;
    let base = addon_url.trim_end_matches('/');
    let url = format!("{base}/catalog/{catalog_type}/{catalog_id}.json");

    let response: CatalogResponse = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Catalog fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Catalog HTTP error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Catalog parse error: {e}"))?;

    Ok(response.metas.into_iter().map(sanitize_meta).collect())
}

// ---------------------------------------------------------------------------
// Commands — global search (Task 2.3)
// ---------------------------------------------------------------------------

/// Query all search-enabled addons concurrently via JoinSet and return a
/// deduplicated, sanitized result set.
///
/// Security: all returned poster URLs are validated (http/https only, ≤ 2048
/// chars); all text fields are capped to prevent memory inflation from a
/// malicious community addon.
#[tauri::command]
pub async fn global_search(
    addons: Vec<AddonEntry>,
    query: String,
) -> Result<Vec<MetaPreview>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }

    let search_addons: Vec<AddonEntry> = addons.into_iter().filter(|a| a.has_search).collect();
    if search_addons.is_empty() {
        return Ok(vec![]);
    }

    let encoded = encode_query(&query);
    let mut set: tokio::task::JoinSet<Vec<MetaPreview>> = tokio::task::JoinSet::new();

    for addon in search_addons {
        let encoded = encoded.clone();
        set.spawn(async move {
            let base = addon.url.trim_end_matches('/').to_string();
            let Ok((wire, _)) = fetch_manifest(&base).await else {
                return vec![];
            };

            // Collect search-capable catalog descriptors before any await so there
            // are no borrows of `wire` across await points.
            let search_cats: Vec<(String, String)> = wire
                .catalogs
                .iter()
                .filter(|c| {
                    c.extra.iter().any(|ex| {
                        ex.get("name").and_then(|v| v.as_str()) == Some("search")
                    })
                })
                .map(|c| (c.media_type.clone(), c.id.clone()))
                .collect();

            let mut results = Vec::new();
            for (media_type, id) in search_cats {
                let url =
                    format!("{base}/catalog/{media_type}/{id}/search={encoded}.json");
                if let Ok(resp) = client().get(&url).send().await {
                    if let Ok(resp) = resp.error_for_status() {
                        if let Ok(cr) = resp.json::<CatalogResponse>().await {
                            results.extend(cr.metas.into_iter().map(sanitize_meta));
                        }
                    }
                }
            }
            results
        });
    }

    let mut all: Vec<MetaPreview> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(task_result) = set.join_next().await {
        if let Ok(items) = task_result {
            for item in items {
                if seen.insert(item.id.clone()) {
                    all.push(item);
                }
            }
        }
    }

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
    let base = url.trim_end_matches('/').to_string();

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
    Ok(AddonEntry { url: base, name, has_search })
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
    let base = addon_url.trim_end_matches('/');
    let url = format!("{base}/meta/{media_type}/{id}.json");

    let json: serde_json::Value = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Meta fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Meta HTTP error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Meta parse error: {e}"))?;

    let meta = json.get("meta").ok_or("Meta missing in response")?;

    Ok(MetaDetail {
        id:           json_str(meta, "id", 128).unwrap_or_default(),
        name:         json_str(meta, "name", 200).unwrap_or_default(),
        media_type:   json_str(meta, "type", 32).unwrap_or_default(),
        poster:       json_url(meta, "poster"),
        background:   json_url(meta, "background"),
        logo:         json_url(meta, "logo"),
        description:  json_str(meta, "description", 1500),
        release_info: json_str(meta, "releaseInfo", 32),
        released:     json_str(meta, "released", 32),
        runtime:      json_str(meta, "runtime", 16),
        imdb_rating:  json_str(meta, "imdbRating", 8),
    })
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
    let body = serde_json::json!({
        "authKey":    auth_key,
        "collection": "libraryItem",
        "changes":    changes,
    });

    let raw = account_client()
        .post(format!("{STREMIO_ACCOUNT_API}/datastorePut"))
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
