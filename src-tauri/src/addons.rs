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
