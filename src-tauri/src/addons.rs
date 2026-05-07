// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Persisted addon entry
// ---------------------------------------------------------------------------

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
    /// pre-dating this field — those addons just won't participate in
    /// id-based default matching until the next manifest refresh.
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
    /// `types` above". Cached at install time so fetch_streams doesn't
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
