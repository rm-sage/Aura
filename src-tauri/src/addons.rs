// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Persisted addon entry
// ---------------------------------------------------------------------------

/// One installed addon. Every field except `url` is derived from the
/// addon's manifest, and an entry is built in exactly four places:
///
/// - `add_addon` (guest install) and `refresh_addon_manifest` share one
///   builder over the LIVE manifest. A refresh replaces a guest's entry in
///   `addons.json` in place (same position, same url), so a guest's fields
///   heal whenever the addon is refreshed (the Refresh button, or the
///   silent refresh after Configure).
/// - `cloud_add_addon` and `auth.rs::get_synced_addons` build from the
///   manifest SNAPSHOT stored in the user's Stremio addon collection. A
///   signed-in refresh also writes the manifest it fetched, verbatim, into
///   that addon's collection entry, under the guards listed on
///   `stremio.rs::refresh_addon_manifest`, so the next launch or sign-in
///   rebuilds the entry from the fresh snapshot. When that write is refused
///   or fails, the refresh heals the fields for the running session only,
///   and the next launch or sign-in rebuilds the entry from the old snapshot
///   again.
///
/// The two builders differ in one cap. The live-manifest one keeps the
/// first 16 manifest-level `id_prefixes`; the cloud one keeps them all. The
/// entry a refresh HANDS BACK to the frontend keeps them all too, so a
/// refresh never shortens a signed-in user's list (a shorter list makes the
/// prefix gates reject ids that matched). What a refresh SAVES for a guest
/// keeps the 16-entry cap, exactly as `add_addon` does, so a guest whose
/// manifest declares more than 16 holds the longer list until the next
/// launch only.
///
/// Nothing heals a field the manifest itself leaves empty: a bare-string
/// `"stream"` resource has no per-resource types or prefixes to read, so
/// `stream_types` and `stream_id_prefixes` stay empty after any rebuild.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddonEntry {
    pub url: String,
    pub name: String,
    pub has_search: bool,
    /// Manifest-level `id` field — the addon author's stable identifier
    /// (e.g. "com.linvo.cinemeta", "community.aiometadata"). Cached at
    /// install/sync time so the frontend can build defaults that survive
    /// instance changes (a user moving from one AIOMetadata host to
    /// another keeps the same `manifest_id` even though the URL differs).
    /// Default-empty for back-compat with existing addons.json files
    /// pre-dating this field. Such an entry does not participate in
    /// id-based matching until the addon's manifest is refreshed, which
    /// rebuilds and saves it. Cloud entries are rebuilt from the collection
    /// snapshot at every sync, so they always carry it.
    #[serde(default)]
    pub manifest_id: String,
    /// Distinct media types covered by this addon's catalogs (e.g., "movie",
    /// "series", "anime"). Sourced from manifest.catalogs[].type.
    /// Default-empty so older `addons.json` files load forward-compatibly.
    #[serde(default)]
    pub types: Vec<String>,
    /// Stremio resources this addon exposes — drives the colored tag list in
    /// the Addons UI ("stream", "subtitles", "meta", "catalog", …).
    #[serde(default)]
    pub resources: Vec<String>,
    /// Manifest's stream-resource type list (the `types` field on the
    /// resource object), if the addon advertised one. Empty = "any of
    /// `types` above". Cached at install time (and rebuilt on a manifest
    /// refresh, see the struct doc) so fetch_streams doesn't
    /// have to re-probe the manifest on every request — that re-probe
    /// was producing the "manifest fetch failed" cascade visible in the
    /// user's logs whenever the network flapped, killing all stream
    /// lookups even though we already had this metadata locally.
    #[serde(default)]
    pub stream_types: Vec<String>,
    /// Manifest-level `idPrefixes` list. Same caching rationale.
    #[serde(default)]
    pub id_prefixes: Vec<String>,
    /// Per-resource override of `idPrefixes` for the stream resource (the
    /// stricter of the two wins inside fetch_streams).
    #[serde(default)]
    pub stream_id_prefixes: Vec<String>,
    /// Whether the addon manifest declares `behaviorHints.configurable =
    /// true` — i.e. it hosts a `/configure` page. Drives the conditional
    /// "Configure" button in the Addons UI; Cinemeta and other
    /// non-configurable addons have this `false` so no button shows.
    /// `#[serde(default)]` (=> `false`) keeps older `addons.json` files —
    /// and addons whose manifest predates this capture — loading
    /// forward-compatibly; the value is (re)populated whenever the entry
    /// is rebuilt (local add, cloud add, the launch-time cloud sync, or a
    /// manifest refresh).
    #[serde(default)]
    pub configurable: bool,
}

// ---------------------------------------------------------------------------
// File-level lock — prevents concurrent read-modify-write races on the JSON
// file. Only held for the duration of synchronous I/O; never across awaits.
// ---------------------------------------------------------------------------

static FILE_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn addons_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("addons.json"))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Public API — all I/O scoped to app_data_dir/addons.json (least privilege)
// ---------------------------------------------------------------------------

pub fn load<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<AddonEntry>, String> {
    let _guard = FILE_LOCK.lock().unwrap();
    let path = addons_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read addons: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Parse addons: {e}"))
}

pub fn save<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    addons: &[AddonEntry],
) -> Result<(), String> {
    let _guard = FILE_LOCK.lock().unwrap();
    let path = addons_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Create data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(addons).map_err(|e| format!("Serialise addons: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write addons: {e}"))
}

/// Permute the on-disk addon list to match `urls` (matched by normalized URL —
/// trailing slash and `/manifest.json` are ignored). Any locally-persisted
/// addon not mentioned in `urls` is appended at the tail so a partial caller
/// list can't accidentally drop entries. Returns the new ordering.
pub fn reorder<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    urls: &[String],
) -> Result<Vec<AddonEntry>, String> {
    let current = load(app)?;
    let norm = |s: &str| {
        s.trim()
            .trim_end_matches('/')
            .trim_end_matches("/manifest.json")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let mut by_url: std::collections::HashMap<String, AddonEntry> = current
        .into_iter()
        .map(|a| (norm(&a.url), a))
        .collect();
    let mut next: Vec<AddonEntry> = Vec::with_capacity(by_url.len());
    for u in urls {
        if let Some(entry) = by_url.remove(&norm(u)) {
            next.push(entry);
        }
    }
    next.extend(by_url.into_values());
    save(app, &next)?;
    Ok(next)
}
