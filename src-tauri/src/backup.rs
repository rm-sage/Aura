// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// User-data backup ledger
//
// Persists rolling snapshots of NON-Stremio-synced state — Aura's local
// Queue (manualWatched "planned"), watch History, manual "watched" /
// "in-progress" marks, and the AuraSettings localStorage blob — to disk
// under <app_data_dir>/backups/<scope>/<unix-millis>.aura-backup.json
//
// WHY — these stores live entirely in the WebView's localStorage, which is
// per-scope (auth_key hash). A scope mismatch (auth state momentarily
// reading as "guest" instead of "user-<hash>") makes the data appear
// wiped, even though the localStorage entry is intact. Disk-side
// snapshots give us a recovery path independent of the scope-detection
// dance: even if the live localStorage entry vanishes, a backup file
// holds the contents and the user can restore from Settings → Backups.
//
// CAUTION FOR FUTURE WORK — many flows touch the localStorage keys
// `aura:manual-state:<scope>`, `aura:history:<scope>`,
// `aura:auto-bumped-series:v1`, and `aura:settings:v1`. ANY code path
// that calls `localStorage.removeItem` / `localStorage.clear` on those
// keys MUST first invoke `create_user_backup` so the user has a
// rollback. The corresponding TS-side warning lives in
// src/userDataBackup.ts; check both.
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

const BACKUP_SUFFIX: &str = ".aura-backup.json";
const DEFAULT_MAX_KEEP: usize = 10;
/// Hard ceiling — even if a caller asks for more, never keep beyond this
/// per scope. Keeps the directory bounded if a misbehaving caller passes
/// a huge value.
const ABSOLUTE_MAX_KEEP: usize = 100;

/// Reasons that count as "manual" snapshots (user-initiated). Pruning
/// inside one bucket NEVER touches the other, so the user's manual
/// snapshots can't be silently overwritten by the auto-snapshot
/// scheduler firing every 30 s.
///
///   • "manual"      — explicit "Create snapshot now" button
///   • "pre-restore" — defensive snapshot taken before a Restore action
///                     (also user-initiated, also worth preserving)
///
/// Anything else ("auto-snapshot", "startup", future reasons we add)
/// falls into the auto bucket.
fn is_manual_reason(reason: &str) -> bool {
    matches!(reason, "manual" | "pre-restore")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
// camelCase serialization for the JS side — the TS BackupMeta interface
// uses fileName / createdAtMs / sizeBytes. Without this rename the
// frontend's `meta.fileName` was undefined; clicks on Delete then
// invoked delete_user_backup with file_name="" and silently failed
// while the optimistic toast announced "Snapshot deleted." Same effect
// for list rendering — every row reused the same React key.
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    /// Filename inside the scope directory — used as the stable id for
    /// read / delete / restore commands. Includes the unix-millis stamp
    /// and the `.aura-backup.json` suffix.
    pub file_name: String,
    /// The scope this backup was taken from ("guest", "user-<hash>").
    pub scope: String,
    /// Unix milliseconds when the backup was created. Convenient for
    /// front-end sort / display without reparsing the filename.
    pub created_at_ms: u64,
    /// Bytes on disk. Useful for the Settings UI to show storage usage.
    pub size_bytes: u64,
    /// Free-form short label the caller passed at creation time
    /// (e.g. "auto-snapshot", "pre-restore", "manual"). Stored in the
    /// JSON body and surfaced via list for sorting / filtering.
    pub reason: String,
}

#[derive(Serialize, Deserialize)]
struct BackupBody {
    /// Schema version. Bump when adding required fields.
    version: u32,
    created_at_ms: u64,
    scope: String,
    reason: String,
    /// Verbatim payload from the frontend — a JSON object holding the
    /// user-data slice we're snapshotting. Schema-agnostic on the Rust
    /// side; the frontend is the source of truth for shape.
    payload: serde_json::Value,
}

fn backups_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn scope_dir<R: Runtime>(app: &AppHandle<R>, scope: &str) -> Result<PathBuf, String> {
    let cleaned = sanitise_scope(scope);
    let dir = backups_root(app)?.join(&cleaned);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Defensive scope sanitiser — the scope arrives from the frontend as a
/// plain string, so we strip anything that could traverse out of the
/// backup root. Stable Aura scopes are "guest" and "user-<16hex>", but
/// belt-and-braces for forward-compat / malicious deep-links.
fn sanitise_scope(scope: &str) -> String {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return "guest".to_string();
    }
    trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_meta(path: &Path) -> Option<BackupMeta> {
    let file_name = path.file_name()?.to_str()?.to_string();
    if !file_name.ends_with(BACKUP_SUFFIX) {
        return None;
    }
    let bytes = std::fs::metadata(path).ok()?;
    let body: BackupBody = serde_json::from_str(
        &std::fs::read_to_string(path).ok()?,
    )
    .ok()?;
    Some(BackupMeta {
        file_name,
        scope: body.scope,
        created_at_ms: body.created_at_ms,
        size_bytes: bytes.len(),
        reason: body.reason,
    })
}

/// Drop oldest backups until at most `max_keep` remain PER BUCKET
/// (manual / auto) inside `scope_dir`. Manual snapshots are pruned
/// against other manual snapshots only, and the same for auto — so
/// the auto-snapshot scheduler firing every 30 s can NEVER push a
/// user's "Create snapshot now" entry off the cliff.
///
/// Returns the total number of files removed across both buckets.
/// Best-effort — a delete failure (file locked, permission denied) is
/// logged but not surfaced.
fn prune_dir(dir: &Path, max_keep: usize) -> usize {
    let max_keep = max_keep.min(ABSOLUTE_MAX_KEEP);
    let mut manual: Vec<(PathBuf, u64)> = Vec::new();
    let mut auto: Vec<(PathBuf, u64)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return 0; };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else { continue; };
        if !file_name.ends_with(BACKUP_SUFFIX) { continue; }
        // Filename is <ms>.aura-backup.json — cheap timestamp parse.
        let stem = file_name.trim_end_matches(BACKUP_SUFFIX);
        let ms: u64 = stem.parse().unwrap_or(0);
        // Reason classification requires reading the JSON body. Manual
        // snapshots are rare (~1/day at most) so the read cost is
        // negligible compared to the value of preserving them.
        let reason = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<BackupBody>(&s).ok())
            .map(|b| b.reason)
            .unwrap_or_default();
        if is_manual_reason(&reason) {
            manual.push((path, ms));
        } else {
            auto.push((path, ms));
        }
    }

    // Newest first within each bucket (descending mtime).
    manual.sort_by_key(|e| std::cmp::Reverse(e.1));
    auto.sort_by_key(|e| std::cmp::Reverse(e.1));

    let mut removed = 0;
    for (path, _) in manual.into_iter().skip(max_keep) {
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    for (path, _) in auto.into_iter().skip(max_keep) {
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Persist a new backup snapshot for `scope`. The frontend collects the
/// payload (manualWatched + history + autoBumped + auraSettings) and
/// passes it as a JSON object — Rust just frames it with metadata and
/// writes to disk. After writing, prunes the scope directory down to
/// `max_keep` (default 10).
#[tauri::command]
pub async fn create_user_backup<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    reason: String,
    payload: serde_json::Value,
    max_keep: Option<usize>,
) -> Result<BackupMeta, String> {
    let dir = scope_dir(&app, &scope)?;
    let cleaned_scope = sanitise_scope(&scope);
    let ms = now_unix_ms();
    let file_name = format!("{ms}{BACKUP_SUFFIX}");
    let path = dir.join(&file_name);

    let body = BackupBody {
        version: 1,
        created_at_ms: ms,
        scope: cleaned_scope.clone(),
        reason: reason.clone(),
        payload,
    };
    let json = serde_json::to_string(&body).map_err(|e| e.to_string())?;

    // Atomic write — rename a sibling .tmp onto the final path so a
    // crash mid-write never leaves a half-written file with the
    // canonical name.
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    let removed = prune_dir(&dir, max_keep.unwrap_or(DEFAULT_MAX_KEEP));
    if removed > 0 {
        crate::devlog!(
            info, "backup",
            "scope={cleaned_scope} pruned {removed} old backups",
        );
    }
    crate::devlog!(
        info, "backup",
        "wrote {} bytes for scope {cleaned_scope} ({reason})",
        json.len(),
    );

    Ok(BackupMeta {
        file_name,
        scope: cleaned_scope,
        created_at_ms: ms,
        size_bytes: json.len() as u64,
        reason,
    })
}

/// List backup metadata for one scope (or every scope when None).
/// Returned newest-first so the Settings UI can render directly.
#[tauri::command]
pub async fn list_user_backups<R: Runtime>(
    app: AppHandle<R>,
    scope: Option<String>,
) -> Result<Vec<BackupMeta>, String> {
    let root = backups_root(&app)?;
    let scopes: Vec<PathBuf> = match scope {
        Some(s) => vec![scope_dir(&app, &s)?],
        None => {
            // Walk every immediate child directory of `backups/`.
            std::fs::read_dir(&root)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.path())
                .collect()
        }
    };

    let mut out: Vec<BackupMeta> = Vec::new();
    for dir in scopes {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue; };
        for entry in rd.filter_map(|e| e.ok()) {
            if let Some(meta) = read_meta(&entry.path()) {
                out.push(meta);
            }
        }
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.created_at_ms));
    Ok(out)
}

/// Read a backup's full JSON body. Frontend `applyBackupPayload`
/// parses the `payload` field and writes the contents back into
/// localStorage, restoring the user's snapshot.
#[tauri::command]
pub async fn read_user_backup<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    file_name: String,
) -> Result<String, String> {
    let dir = scope_dir(&app, &scope)?;
    if !file_name.ends_with(BACKUP_SUFFIX) || file_name.contains('/') || file_name.contains('\\') {
        return Err("invalid backup file name".into());
    }
    let path = dir.join(&file_name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Delete a single backup file by filename. The matching scope dir is
/// resolved from the supplied `scope`; the file_name is whitelisted to
/// the .aura-backup.json suffix and a single path segment so a
/// malicious frontend can't traverse outside the backups root.
#[tauri::command]
pub async fn delete_user_backup<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    file_name: String,
) -> Result<(), String> {
    if !file_name.ends_with(BACKUP_SUFFIX) || file_name.contains('/') || file_name.contains('\\') {
        return Err("invalid backup file name".into());
    }
    let path = scope_dir(&app, &scope)?.join(&file_name);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Total bytes used by all backups across every scope. Surfaced in the
/// Settings UI so the user can see storage cost at a glance.
#[tauri::command]
pub async fn user_backup_storage_used<R: Runtime>(
    app: AppHandle<R>,
) -> Result<u64, String> {
    let root = backups_root(&app)?;
    let mut total = 0u64;
    let Ok(scopes) = std::fs::read_dir(&root) else { return Ok(0); };
    for s in scopes.filter_map(|e| e.ok()) {
        let dir = s.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&dir) else { continue; };
        for f in files.filter_map(|e| e.ok()) {
            if let Ok(m) = std::fs::metadata(f.path()) {
                total += m.len();
            }
        }
    }
    Ok(total)
}
