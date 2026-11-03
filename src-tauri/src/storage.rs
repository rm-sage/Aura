// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// storage.rs — disk-side cache + log inspection / clearing.
//
// Surfaces a small `get_storage_report` command that walks the
// known-set of files Aura writes to disk during normal use and reports
// their sizes back. Used by the Settings → Storage panel so the user
// can see what Aura's footprint actually is — and `clear_storage_item`
// lets them delete individual entries when they want to reclaim disk
// or bust a stale cache.
//
// Things tracked:
//   • aura-mpv.log + aura-mpv.log.old             (verbose MPV log)
//   • aura-panic.log + aura-panic.log.old         (panic dumps)
//   • skipdetect caches under app_data_dir         (AnimeThemes theme lists,
//     theme fingerprints, per-file OP/ED results; see skipdetect/cache.rs)
//   • watch history under app_data_dir/history     (USER DATA, not a cache;
//     see history_store.rs). Reported here, but cleared only through the
//     frontend store (StorageReport routes its Clear to clearHistory), since
//     deleting the file under a hydrated in-memory list would be undone by
//     that list's next write. That clears the scope IN USE only, so the row's
//     Clear button follows that scope's rows, not the byte total.
//
// In-memory caches (Rust-side AniSkip, mal-resolve, inflight searches)
// aren't tracked here since they vanish on restart anyway. localStorage
// is enumerated on the React side directly.
// ---------------------------------------------------------------------------

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct StorageEntry {
    /// Stable id consumed by `clear_storage_item` to identify which
    /// file to delete. Mirrors the variant names rather than raw paths
    /// so callers don't have to know the filesystem layout.
    pub id: String,
    /// Human-readable label shown in the Settings UI.
    pub label: String,
    /// Optional subtext — e.g. "verbose MPV log" — for tooltips.
    pub description: String,
    /// Actual disk path, surfaced so the UI can show it as a hint.
    pub path: String,
    /// File size in bytes. 0 when the file doesn't exist (the entry
    /// is still listed so the user can see what Aura WOULD write).
    pub bytes: u64,
    /// True when this file currently exists on disk.
    pub exists: bool,
}

#[derive(Clone, Serialize)]
pub struct StorageReport {
    pub entries: Vec<StorageEntry>,
    /// Sum of bytes across every present file.
    pub total_bytes: u64,
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
}

/// Static catalogue of files Aura touches. id, label, description,
/// relative-to-home filename. Defined once so `report` and `clear`
/// can share the same surface.
fn entries() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    vec![
        ("mpv-log",        "MPV log (current)",         "Verbose libmpv log written every playback session. Useful for crash triage. Capped at 50 MB; rotated to .old on overflow.", "aura-mpv.log"),
        ("mpv-log-old",    "MPV log (previous)",        "One-rotation backup of the verbose libmpv log.",          "aura-mpv.log.old"),
        ("panic-log",      "Panic log (current)",       "Captured Rust panics with backtrace. Append-only, capped at 5 MB then rotated.", "aura-panic.log"),
        ("panic-log-old",  "Panic log (previous)",      "One-rotation backup of the panic log.",                   "aura-panic.log.old"),
    ]
}

/// Id of the skipdetect cache entry (a set of files under app_data_dir, not a
/// home-dir file, so it is handled beside the static catalogue).
const SKIPDETECT_ID: &str = "skipdetect-cache";
/// Id of the watch-history entry. StorageReport.tsx matches it by this id.
const HISTORY_ID: &str = "history-store";

#[tauri::command]
pub async fn get_storage_report(app: tauri::AppHandle) -> Result<StorageReport, String> {
    let home = home_dir().ok_or("no HOME / USERPROFILE")?;
    let mut total: u64 = 0;
    let mut out = Vec::new();
    for (id, label, description, file) in entries() {
        let path = format!("{home}\\{file}");
        let (bytes, exists) = match std::fs::metadata(&path) {
            Ok(m) => (m.len(), true),
            Err(_) => (0, false),
        };
        total += bytes;
        out.push(StorageEntry {
            id: id.to_string(),
            label: label.to_string(),
            description: description.to_string(),
            path,
            bytes,
            exists,
        });
    }
    let sd_app = app.clone();
    let (dir, bytes) = tauri::async_runtime::spawn_blocking(move || crate::skipdetect::storage_usage(&sd_app))
        .await
        .map_err(|e| e.to_string())?;
    total += bytes;
    let hist_app = app.clone();
    let hist = tauri::async_runtime::spawn_blocking(move || crate::history_store::storage_usage(&hist_app))
        .await
        .map_err(|e| e.to_string())?;
    total += hist.total_bytes;
    out.push(StorageEntry {
        id: HISTORY_ID.to_string(),
        label: "Watch history".to_string(),
        description: history_description(hist.other_bytes),
        path: hist.dir,
        // The whole footprint, every account's file: this is what the disk
        // holds. `exists` (which shows the Clear button) asks instead whether
        // the history IN USE has rows, because Clear empties only that one: a
        // byte count kept the button up after a clear (an empty file is still
        // a few bytes of gzip, and other accounts' files never go), and a
        // second press did nothing.
        bytes: hist.total_bytes,
        exists: hist.active_has_rows.unwrap_or(hist.total_bytes > 0),
    });
    out.push(StorageEntry {
        id: SKIPDETECT_ID.to_string(),
        label: "Skip detection cache".to_string(),
        description: "Theme song lists from AnimeThemes, fingerprints of those songs (never the audio) and the opening / ending found in each file, so a replay skips without scanning again. Capped. Clearing it means the next play of each episode scans its audio again. Safe to clear.".to_string(),
        path: dir,
        bytes,
        exists: bytes > 0,
    });
    Ok(StorageReport { entries: out, total_bytes: total })
}

/// The watch-history row's text. Says which history Clear empties (the one in
/// use, which is the guest history when signed out) and, when other files
/// count toward the size, that those are not touched.
fn history_description(other_bytes: u64) -> String {
    let mut d = String::from(
        "Every play you finished and every episode you skipped, with no entry limit, stored compressed (one file per account). Synced to Aura Cloud when you're signed in. Clearing empties the history in use now (the guest history when you're signed out) and, signed in, its Aura Cloud copy within seconds; another signed-in device that still holds those rows can bring them back. Anything already scrobbled stays on the services it went to. This is your data, not a cache.",
    );
    if other_bytes > 0 {
        d.push_str(&format!(
            " {} of the size is other accounts' history on this device, which Clear does not touch.",
            human_bytes(other_bytes),
        ));
    }
    d
}

fn human_bytes(b: u64) -> String {
    const KB: f64 = 1024.0;
    let f = b as f64;
    if f < KB {
        format!("{b} B")
    } else if f < KB * KB {
        format!("{:.1} KB", f / KB)
    } else {
        format!("{:.1} MB", f / (KB * KB))
    }
}

#[tauri::command]
pub async fn clear_storage_item(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id == HISTORY_ID {
        return Err("watch history is cleared through the History store, not as a file".into());
    }
    if id == SKIPDETECT_ID {
        return tauri::async_runtime::spawn_blocking(move || crate::skipdetect::storage_clear(&app))
            .await
            .map_err(|e| e.to_string())?;
    }
    let home = home_dir().ok_or("no HOME / USERPROFILE")?;
    for (entry_id, _label, _description, file) in entries() {
        if entry_id == id {
            let path = format!("{home}\\{file}");
            // remove_file returns NotFound when the file isn't there —
            // treat that as success since the user's intent (file
            // gone) is satisfied either way.
            match std::fs::remove_file(&path) {
                Ok(_) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(format!("delete failed: {e}")),
            }
        }
    }
    Err(format!("unknown storage id: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_text_names_other_accounts_only_when_they_count() {
        assert!(!history_description(0).contains("other accounts"));
        let d = history_description(3 * 1024 * 1024 / 2);
        assert!(d.contains("1.5 MB of the size is other accounts"), "{d}");
        assert!(d.contains("guest history when you're signed out"));
        assert!(d.contains("Aura Cloud copy within seconds"), "{d}");
        assert!(d.contains("can bring them back"), "{d}");
        assert!(d.contains("already scrobbled stays"), "{d}");
        assert_eq!(human_bytes(512), "512 B");
    }
}
