// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Crash-reporting consent + DSN persistence.
//!
//! These two values used to live inside per-scope `AppSettings`, which
//! caused the user-visible bug where opting in as a guest then logging
//! into Stremio created a fresh scope where consent was still `null`,
//! re-prompting on every account change. They are SYSTEM-LEVEL prefs
//! (the same DSN should report errors regardless of which Stremio user
//! is signed in), so they belong outside the scope-aware settings layer.
//!
//! Storage: a single JSON file at `<app_data_dir>/crash-reporting.json`,
//! atomic-renamed on write to survive crashes mid-save.
//!
//! Migration: on first read, if the sidecar doesn't exist, we walk the
//! scope-aware `settings/*.json` files for legacy `crash_reporting_*`
//! fields and seed the sidecar from any non-default value found. After
//! that the legacy fields are ignored.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct CrashReportingConfig {
    /// `None` = the consent prompt has not been shown yet, `Some(false)`
    /// = user declined, `Some(true)` = user opted in.
    #[serde(default)]
    pub consent: Option<bool>,
    /// User-supplied Sentry DSN. Empty by default; release builds may
    /// also bake one in via the `SENTRY_DSN` env var, in which case
    /// this field overrides it when both are non-empty.
    #[serde(default)]
    pub dsn: String,
}

fn cache() -> &'static Mutex<CrashReportingConfig> {
    static CACHE: OnceLock<Mutex<CrashReportingConfig>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CrashReportingConfig::default()))
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("crash-reporting.json"))
}

/// Load the config from disk (or migrate from legacy AppSettings).
/// Caches on first read; subsequent calls hit the cache.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> CrashReportingConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return cache().lock().unwrap().clone(),
    };
    if path.exists() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<CrashReportingConfig>(&text) {
                *cache().lock().unwrap() = cfg.clone();
                return cfg;
            }
        }
    }
    // Migration: scan scope files for legacy `crash_reporting_*` fields.
    // We use serde_json::Value rather than AppSettings so a stale schema
    // doesn't fail the read.
    let migrated = migrate_from_legacy(app).unwrap_or_default();
    if migrated.consent.is_some() || !migrated.dsn.is_empty() {
        let _ = save(app, &migrated);
    } else {
        // Persist a default-shaped sidecar so subsequent reads bypass
        // the migration walk entirely.
        let _ = save(app, &CrashReportingConfig::default());
    }
    *cache().lock().unwrap() = migrated.clone();
    migrated
}

fn migrate_from_legacy<R: Runtime>(app: &AppHandle<R>) -> Option<CrashReportingConfig> {
    let dir = app.path().app_data_dir().ok()?.join("settings");
    if !dir.exists() {
        return None;
    }
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut found = CrashReportingConfig::default();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        // Last writer wins across scopes — if the user opted in on one
        // account and later opted out on another, we want the more-
        // recent intent. In practice these files were written within
        // the same session so any ordering ties out the same.
        if let Some(c) = parsed.get("crash_reporting_consent").and_then(|v| v.as_bool()) {
            found.consent = Some(c);
        }
        if let Some(d) = parsed.get("crash_reporting_dsn").and_then(|v| v.as_str()) {
            if !d.is_empty() {
                found.dsn = d.to_string();
            }
        }
    }
    Some(found)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &CrashReportingConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    *cache().lock().unwrap() = cfg.clone();
    Ok(())
}

// ---------------------------------------------------------------------------
// Pre-init load — used by lib.rs::run before the Tauri AppHandle exists.
// Mirrors settings::load_pre_init's strategy: walk known app_data_dir
// layouts and read the sidecar if present, falling back to legacy scope
// files for migration. Failure → defaults (Sentry stays disabled).
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn pre_init_app_dir() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(appdata).join("com.aura.app"))
}

#[cfg(not(target_os = "windows"))]
fn pre_init_app_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join("Library").join("Application Support").join("com.aura.app"))
    } else {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".config").join("com.aura.app"))
    }
}

pub fn load_pre_init() -> CrashReportingConfig {
    let Some(root) = pre_init_app_dir() else {
        return CrashReportingConfig::default();
    };
    let sidecar = root.join("crash-reporting.json");
    if let Ok(text) = std::fs::read_to_string(&sidecar) {
        if let Ok(cfg) = serde_json::from_str::<CrashReportingConfig>(&text) {
            return cfg;
        }
    }
    // No sidecar — try scope files as a last-resort fallback so a user
    // who set consent before this refactor still has it on first run
    // post-upgrade. We DON'T write the migrated value here; that's the
    // job of `load()` once an AppHandle exists.
    let scopes = root.join("settings");
    if let Ok(entries) = std::fs::read_dir(&scopes) {
        let mut out = CrashReportingConfig::default();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            if let Some(c) = parsed.get("crash_reporting_consent").and_then(|v| v.as_bool()) {
                out.consent = Some(c);
            }
            if let Some(d) = parsed.get("crash_reporting_dsn").and_then(|v| v.as_str()) {
                if !d.is_empty() {
                    out.dsn = d.to_string();
                }
            }
        }
        if out.consent.is_some() || !out.dsn.is_empty() {
            return out;
        }
    }
    CrashReportingConfig::default()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_crash_reporting<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CrashReportingConfig, String> {
    Ok(load(&app))
}

#[tauri::command]
pub async fn set_crash_reporting<R: Runtime>(
    app: AppHandle<R>,
    consent: Option<bool>,
    dsn: Option<String>,
) -> Result<CrashReportingConfig, String> {
    let mut cfg = load(&app);
    if let Some(c) = consent {
        cfg.consent = Some(c);
    }
    if let Some(d) = dsn {
        cfg.dsn = d;
    }
    save(&app, &cfg)?;
    Ok(cfg)
}
