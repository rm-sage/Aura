// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Per-title persistence — small JSON file in app_data_dir mapping
//! `{media_type}:{id}` → `TitleState`. Used to remember the user's
//! preferred volume, shader, audio language and subtitle language so
//! every replay of the same title (or sibling episodes of the same
//! series) starts in the same audio/visual state.
//!
//! Playback speed is *deliberately* NOT persisted — it's a transient
//! "this scene is talkative" tweak, not a per-title preference.
//!
//! All accessors are best-effort: a corrupt or missing file returns
//! `None`, never an error to the caller. Writes are non-fatal.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TitleState {
    /// 0..100. None = use the global default the user picks each session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    /// Cinema profile id (e.g. "hq", "performance", "off"). Free-form
    /// string so we don't have to keep this enum in sync with cinema.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shader: Option<String>,
    /// 2-letter ISO audio language code (e.g. "ja"). On reload the player
    /// auto-selects the closest track by `lang` prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_lang: Option<String>,
    /// 2-letter ISO subtitle language code, or the literal "off" to mean
    /// "user disabled subs for this title".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_lang: Option<String>,
}

// ---------------------------------------------------------------------------
// File-backed cache
// ---------------------------------------------------------------------------

static CACHE: OnceLock<Mutex<HashMap<String, TitleState>>> = OnceLock::new();
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn cache() -> &'static Mutex<HashMap<String, TitleState>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&dir).is_err() { return None; }
    Some(dir.join("per_title.json"))
}

fn load_from_disk<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, TitleState> {
    let _guard = FILE_LOCK.lock().ok();
    let Some(p) = path(app) else { return HashMap::new(); };
    let Ok(text) = std::fs::read_to_string(&p) else { return HashMap::new(); };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_to_disk<R: Runtime>(app: &AppHandle<R>, map: &HashMap<String, TitleState>) {
    let _guard = FILE_LOCK.lock().ok();
    let Some(p) = path(app) else { return; };
    if let Ok(text) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(p, text);
    }
}

fn ensure_loaded<R: Runtime>(app: &AppHandle<R>) {
    let mut guard = match cache().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    // Empty cache + first call → pull from disk. After that, the in-mem
    // map is the source of truth (writes touch both).
    if guard.is_empty() {
        *guard = load_from_disk(app);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Look up the saved state for `{media_type}:{id}`. Returns `None` when
/// nothing is stored — caller falls back to global defaults.
#[tauri::command]
pub async fn get_title_state<R: Runtime>(
    app: AppHandle<R>,
    media_type: String,
    id: String,
) -> Result<Option<TitleState>, String> {
    ensure_loaded(&app);
    let key = format!("{media_type}:{id}");
    let guard = cache().lock().map_err(|e| e.to_string())?;
    Ok(guard.get(&key).cloned())
}

/// Merge `patch` into the saved state for `{media_type}:{id}`. Fields
/// that are `None` in the patch are left alone; fields that are present
/// (even with a `null` JSON value) overwrite. Persists to disk.
#[tauri::command]
pub async fn set_title_state<R: Runtime>(
    app: AppHandle<R>,
    media_type: String,
    id: String,
    patch: TitleState,
) -> Result<(), String> {
    ensure_loaded(&app);
    let key = format!("{media_type}:{id}");

    let snapshot = {
        let mut guard = cache().lock().map_err(|e| e.to_string())?;
        let entry = guard.entry(key).or_default();
        if patch.volume.is_some()     { entry.volume     = patch.volume; }
        if patch.shader.is_some()     { entry.shader     = patch.shader; }
        if patch.audio_lang.is_some() { entry.audio_lang = patch.audio_lang; }
        if patch.sub_lang.is_some()   { entry.sub_lang   = patch.sub_lang; }
        guard.clone()
    };

    // Persist outside the lock so disk I/O doesn't block other readers.
    save_to_disk(&app, &snapshot);
    // Fire a JS-side change event for sync.ts to debounce + push.
    use tauri::Emitter;
    let _ = app.emit("title-state-changed", ());
    Ok(())
}

// ---------------------------------------------------------------------------
// Bulk get/set used by the cloud sync layer (sync.rs).
//
// These let `sync_pull_all` lift the entire map out of the local file
// for a push, and let an inbound merge result write the merged state
// back in one shot. The single-entry get_title_state / set_title_state
// commands above are still the primary read/write path during normal
// playback; bulk operations only fire on sync events.
// ---------------------------------------------------------------------------

/// Snapshot the full title-state map. Used by sync push to forward
/// the user's per-title preferences (volume / shader / lang choices)
/// to the proxy. Empty map is a valid response and means "no per-
/// title overrides yet".
#[tauri::command]
pub async fn get_all_title_state<R: Runtime>(
    app: AppHandle<R>,
) -> Result<HashMap<String, TitleState>, String> {
    ensure_loaded(&app);
    let guard = cache().lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

/// Replace the title-state map with the given snapshot. Used by sync
/// pull when the proxy returns a merged version. The replacement is
/// total: keys not in `state` are dropped from the in-memory map AND
/// from disk. Callers MUST pass the post-merge result, not a delta.
#[tauri::command]
pub async fn set_all_title_state<R: Runtime>(
    app: AppHandle<R>,
    state: HashMap<String, TitleState>,
) -> Result<(), String> {
    {
        let mut guard = cache().lock().map_err(|e| e.to_string())?;
        *guard = state.clone();
    }
    save_to_disk(&app, &state);
    Ok(())
}
