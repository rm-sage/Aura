// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Local-only "fun stats" — total seconds watched (split by media type),
//! total seconds spent on the home screen, etc. Persisted to a small
//! JSON file in app_data_dir, surfaced in the Settings → About panel.
//!
//! Never sent to a remote service. Best-effort: a corrupt or missing
//! file is treated as a fresh slate so a partial loss never blocks the
//! main flow.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AuraStats {
    /// Total seconds spent watching movies.
    #[serde(default)]
    pub watched_movie_secs: f64,
    /// Total seconds spent watching series episodes (live-action).
    #[serde(default)]
    pub watched_series_secs: f64,
    /// Total seconds spent watching anime (any subtype).
    #[serde(default)]
    pub watched_anime_secs: f64,
    /// Distinct stream-loads (one bump per `load_video` call from a fresh
    /// activeTarget). Approximates "things played".
    #[serde(default)]
    pub streams_played: u64,
    /// Total seconds the user has spent on the Home view. Cosmic but
    /// makes for funny stats.
    #[serde(default)]
    pub home_view_secs: f64,
}

static CACHE: OnceLock<Mutex<AuraStats>> = OnceLock::new();
static FILE_LOCK: Mutex<()> = Mutex::new(());

fn cache() -> &'static Mutex<AuraStats> {
    CACHE.get_or_init(|| Mutex::new(AuraStats::default()))
}

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&dir).is_err() { return None; }
    Some(dir.join("aura_stats.json"))
}

fn ensure_loaded<R: Runtime>(app: &AppHandle<R>) {
    let _g = FILE_LOCK.lock().ok();
    let mut guard = match cache().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    // Re-loading is cheap; we just check the "default" fingerprint. If
    // every counter is zero we may legitimately need to re-pull from
    // disk (a freshly-launched session before any bump).
    if *guard != AuraStats::default() { return; }
    if let Some(p) = path(app) {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(s) = serde_json::from_str::<AuraStats>(&text) {
                *guard = s;
            }
        }
    }
}

fn save_to_disk<R: Runtime>(app: &AppHandle<R>, s: &AuraStats) {
    let _g = FILE_LOCK.lock().ok();
    let Some(p) = path(app) else { return };
    if let Ok(text) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(p, text);
    }
}

impl PartialEq for AuraStats {
    fn eq(&self, other: &Self) -> bool {
        self.watched_movie_secs == other.watched_movie_secs
            && self.watched_series_secs == other.watched_series_secs
            && self.watched_anime_secs == other.watched_anime_secs
            && self.streams_played == other.streams_played
            && self.home_view_secs == other.home_view_secs
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_stats<R: Runtime>(app: AppHandle<R>) -> AuraStats {
    ensure_loaded(&app);
    cache().lock().map(|g| g.clone()).unwrap_or_default()
}

/// Bump a stat by an arbitrary delta (in the unit native to that stat —
/// seconds for time fields, count for counters). Persists to disk best-
/// effort. Negative deltas are accepted (rarely useful).
#[tauri::command]
pub async fn bump_stat<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
    delta: f64,
) -> Result<(), String> {
    ensure_loaded(&app);
    let snapshot = {
        let mut g = cache().lock().map_err(|e| e.to_string())?;
        match kind.as_str() {
            "watched_movie_secs"  => g.watched_movie_secs  += delta,
            "watched_series_secs" => g.watched_series_secs += delta,
            "watched_anime_secs"  => g.watched_anime_secs  += delta,
            "streams_played"      => g.streams_played      = g.streams_played.saturating_add(delta as u64),
            "home_view_secs"      => g.home_view_secs      += delta,
            _ => return Err(format!("unknown stat kind: {kind}")),
        }
        g.clone()
    };
    save_to_disk(&app, &snapshot);
    Ok(())
}
