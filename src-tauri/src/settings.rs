use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

// ---------------------------------------------------------------------------
// Persistent application settings
//
// Stored as JSON in the platform's app_data_dir. New keys are additive and
// fall back to defaults via `#[serde(default)]` so older settings.json files
// load forward-compatibly.
//
// Theme is the only setting validated on write; the rest are typed and
// constrained at the wire boundary by serde.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String, // "mica" | "glass" | "midnight"

    // ── Playback defaults ──────────────────────────────────────────────────
    #[serde(default = "default_global_audio")]
    pub global_audio_lang: String,
    #[serde(default = "default_global_subs")]
    pub global_subs_lang: String,
    #[serde(default = "default_anime_audio")]
    pub anime_audio_lang: String,
    #[serde(default = "default_anime_subs")]
    pub anime_subs_lang: String,

    // ── Discord Rich Presence ──────────────────────────────────────────────
    #[serde(default = "default_true")]
    pub discord_rpc_enabled: bool,
    /// When false, RPC shows only "Watching something on Aura"; titles hidden.
    #[serde(default = "default_true")]
    pub discord_rpc_show_titles: bool,
    /// Per-title hide list (case-insensitive name match). Used even when
    /// show_titles is true: lets users hide *specific* titles.
    #[serde(default)]
    pub discord_rpc_blocked_titles: Vec<String>,

    // ── Window behaviours ──────────────────────────────────────────────────
    #[serde(default = "default_true")]
    pub pause_on_minimize: bool,
    #[serde(default = "default_true")]
    pub pause_on_lost_focus: bool,
    /// When the user closes the window, exit cleanly (no tray persistence).
    #[serde(default = "default_true")]
    pub close_on_exit: bool,

    // ── Scrobbling ─────────────────────────────────────────────────────────
    /// Optional addon URL exposing /scrobble/{type}/{id}.json (AIOMetadata).
    /// When empty, scrobble events become no-ops.
    #[serde(default)]
    pub scrobble_addon_url: String,
}

fn default_theme() -> String { "mica".into() }
fn default_global_audio() -> String { "en".into() }
fn default_global_subs() -> String { "en".into() }
fn default_anime_audio() -> String { "ja".into() }
fn default_anime_subs() -> String { "en".into() }
fn default_true() -> bool { true }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme:                       default_theme(),
            global_audio_lang:           default_global_audio(),
            global_subs_lang:            default_global_subs(),
            anime_audio_lang:            default_anime_audio(),
            anime_subs_lang:             default_anime_subs(),
            discord_rpc_enabled:         true,
            discord_rpc_show_titles:     true,
            discord_rpc_blocked_titles:  Vec::new(),
            pause_on_minimize:           true,
            pause_on_lost_focus:         true,
            close_on_exit:               true,
            scrobble_addon_url:          String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// In-memory cache so high-traffic readers (window event handlers) don't have
// to hit disk. The cache is the source of truth during a session; disk is
// only used to persist on writes.
// ---------------------------------------------------------------------------

static CACHE: OnceLock<Arc<Mutex<AppSettings>>> = OnceLock::new();

fn cache() -> &'static Arc<Mutex<AppSettings>> {
    CACHE.get_or_init(|| Arc::new(Mutex::new(AppSettings::default())))
}

pub fn snapshot() -> AppSettings {
    cache().lock().unwrap().clone()
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppSettings {
    let Ok(path) = settings_path(app) else { return AppSettings::default(); };
    let parsed: AppSettings = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<AppSettings>(&t).ok())
        .unwrap_or_default();
    *cache().lock().unwrap() = parsed.clone();
    parsed
}

pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    *cache().lock().unwrap() = settings.clone();
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> AppSettings {
    load(&app)
}

/// Validates and persists the theme. Unknown themes are rejected so the
/// frontend can't drift the stored value to something the CSS won't render.
#[tauri::command]
pub async fn set_theme<R: Runtime>(app: AppHandle<R>, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), "mica" | "glass" | "midnight") {
        return Err(format!("Unknown theme: {theme}"));
    }
    let mut s = load(&app);
    s.theme = theme;
    save(&app, &s)
}

/// Patch any subset of settings — used by the Settings page.
#[tauri::command]
pub async fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let mut current =
        serde_json::to_value(load(&app)).map_err(|e| e.to_string())?;

    if let (Some(target), Some(updates)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in updates {
            target.insert(k.clone(), v.clone());
        }
    }

    let next: AppSettings =
        serde_json::from_value(current).map_err(|e| format!("Invalid settings patch: {e}"))?;

    if !matches!(next.theme.as_str(), "mica" | "glass" | "midnight") {
        return Err(format!("Unknown theme: {}", next.theme));
    }

    save(&app, &next)?;
    Ok(next)
}
