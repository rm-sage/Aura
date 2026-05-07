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

#[tauri::command]
pub async fn get_storage_report() -> Result<StorageReport, String> {
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
    Ok(StorageReport { entries: out, total_bytes: total })
}

#[tauri::command]
pub async fn clear_storage_item(id: String) -> Result<(), String> {
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
