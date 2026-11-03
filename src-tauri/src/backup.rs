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
// `aura:manual-state:<scope>`, `aura:auto-bumped-series:v1`, and
// `aura:settings:v1` (history moved to history_store.rs; see below). ANY code path
// that calls `localStorage.removeItem` / `localStorage.clear` on those
// keys MUST first invoke `create_user_backup` so the user has a
// rollback. The corresponding TS-side warning lives in
// src/userDataBackup.ts; check both.
//
// HISTORY COMES FROM THE STORE, NOT THE PAYLOAD. Watch history moved to a
// Rust-owned file with no row cap (history_store.rs), so the frontend sends
// `historyFromStore: true` instead of the list and `values.history` is filled
// here, from the store, as the same JSON-array STRING it always was. A large
// history therefore never crosses IPC on every auto-snapshot, and every
// backup old or new restores through one path.
//
// BODIES ARE GZIPPED ON DISK, under their own suffix `.aura-backup.json.gz`.
// With history uncapped, ten auto plus ten manual snapshots of a 10k-row
// history were ~130 MB of JSON; gzip makes that ~5 MB. Every reader here
// accepts both suffixes and both a plain and a gzipped body, so snapshots
// written before this change read exactly as before. The suffix is distinct
// ON PURPOSE: an older Aura (after a downgrade) classifies a snapshot as
// manual or auto by reading its body as text, and a gzipped body read as
// text has no reason, so it would file the user's manual and pre-restore
// snapshots under auto and prune them. Its suffix filter skips `.gz`
// instead, so it neither lists nor deletes them.
//
// EXCLUDED BY CONSTRUCTION: a backup is only ever the payload the frontend
// hands in. Machine-local caches under app_data_dir (skipdetect's
// animethemes-v1.json, theme-fp/ and skipdetect-v1.json, the arcs / manga
// caches) are never read here and must never be added to a payload: they
// are rebuildable, and the skipdetect result cache records what the user
// played.
// ---------------------------------------------------------------------------

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

/// Plain JSON body: what every Aura before gzipped bodies wrote.
const BACKUP_SUFFIX: &str = ".aura-backup.json";
/// Gzipped body: what this build writes (see "BODIES ARE GZIPPED").
const BACKUP_SUFFIX_GZ: &str = ".aura-backup.json.gz";
/// A snapshot being written. `backup_stem` rejects it, so a listing never sees one.
const BACKUP_SUFFIX_TMP: &str = ".aura-backup.tmp";
/// A tmp older than this is a crash's leftover. Snapshots are not serialized, so
/// a younger one can be another call's write in flight and must be left alone.
const STALE_TMP_MS: u64 = 60 * 60 * 1000;

/// The `<ms>` stem of a snapshot file name under either suffix, or None for
/// any other file.
fn backup_stem(file_name: &str) -> Option<&str> {
    file_name
        .strip_suffix(BACKUP_SUFFIX_GZ)
        .or_else(|| file_name.strip_suffix(BACKUP_SUFFIX))
}

/// A file name a command may address: exactly what `create_user_backup`
/// writes (and every Aura before it did), `<unix-millis>` plus a snapshot
/// suffix. Requiring an all-digit stem is what keeps the name ONE path
/// component inside the scope directory: rejecting only `/` and `\` let a
/// drive-relative name through ("D:x.aura-backup.json"), and on Windows
/// `PathBuf::join` with a prefix-but-no-root component REPLACES the base, so
/// read / delete then reached a file in that drive's current directory. A
/// digit stem has no `:`, no prefix, no dots and no stream name.
fn valid_backup_name(file_name: &str) -> bool {
    backup_stem(file_name).is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
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

/// Reasons whose snapshot is still worth taking when history cannot be read:
/// the user-initiated ones and the "pre-cleanup" rollback point the
/// userDataBackup.ts DANGER note asks for. Never the automatic ones.
fn history_optional(reason: &str) -> bool {
    is_manual_reason(reason) || reason == "pre-cleanup"
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
    /// and the `.aura-backup.json` (or, since bodies are gzipped,
    /// `.aura-backup.json.gz`) suffix.
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

/// Serialize-only: nothing here parses a whole body into this (see
/// `read_meta_fields`). Field order is LOAD-BEARING: serde writes fields in
/// declaration order, and the listing reads the metadata from the first few
/// KB of the body, so `payload` (the bulk) must stay LAST. Every Aura so far
/// has written this order.
#[derive(Serialize)]
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

/// Ceiling on a body's JSON text, on read (an inflate past it is an ERROR,
/// never a silent truncation) and on write (a snapshot that could not be read
/// back is refused rather than written). Real bodies are ~0.5 MB today, and
/// nearly all of it is `values.history`, one JSON string. History has no row
/// cap, so this follows the history store's own ceiling instead: the ~280k
/// plays its 1 GiB decode budget loads are ~190 MB as that escaped string,
/// under 256 MiB. It used to be 1 GiB, silently truncated.
const MAX_BODY_BYTES: u64 = 256 << 20;

/// Ceiling on what a body's STRUCTURE (not its string bytes) costs to parse:
/// `json_parse_cost` minus the text length. An honest body is a few dozen
/// nodes (every `values.*` entry is one string), ~2 KB of this; 1 MiB is
/// ~16k nodes. Without it a body of `[0,0,0,...]` within the text cap costs
/// ~32x its size to parse (measured ~18-26 GiB of demand for a ~1 MB file),
/// in the frontend's restore as in any Rust parse.
const MAX_BODY_STRUCTURE_COST: u64 = 1 << 20;

/// How much of a body's start the listing and the pruning read for its
/// metadata. Everything they need precedes `payload` and is ~150 bytes.
const META_PREFIX_BYTES: u64 = 4096;

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

/// A snapshot file's body as a stream, whether it was written plain (before
/// bodies were gzipped) or gzipped, read from disk as it is consumed: a
/// reader that stops early never reads the rest of the file.
fn open_body(path: &Path) -> Result<Box<dyn Read>, String> {
    let mut file = std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
    let gz = file.fill_buf().map_err(|e| e.to_string())?.starts_with(&[0x1f, 0x8b]);
    Ok(if gz { Box::new(flate2::read::GzDecoder::new(file)) } else { Box::new(file) })
}

/// The structural check every body passes before it is handed on for a
/// full parse (and before one is written): within `MAX_BODY_BYTES`, and a
/// structure within `MAX_BODY_STRUCTURE_COST`.
fn check_body(text: &str) -> Result<(), String> {
    if text.len() as u64 > MAX_BODY_BYTES {
        return Err(format!("backup body is over the {MAX_BODY_BYTES}-byte cap"));
    }
    let structure = crate::history_store::json_parse_cost(text.as_bytes()).saturating_sub(text.len() as u64);
    if structure > MAX_BODY_STRUCTURE_COST {
        return Err(format!("backup body structure is over its cap ({structure} bytes estimated)"));
    }
    Ok(())
}

/// A backup body as text, for a restore. Bounded: an inflate past
/// `MAX_BODY_BYTES` is an error (it used to be silently truncated at 1 GiB,
/// handing on a body that was cut short), and so is a body whose structure
/// would be costly to parse (`check_body`).
fn read_body_text(path: &Path) -> Result<String, String> {
    let text = read_text_capped(open_body(path)?, MAX_BODY_BYTES)?;
    check_body(&text)?;
    Ok(text)
}

/// All of `r` as UTF-8 text, or an error when it holds more than `cap` bytes:
/// one byte past the cap is read so that a body cut at the cap can never pass
/// for a whole one.
fn read_text_capped(r: impl Read, cap: u64) -> Result<String, String> {
    let mut out = Vec::new();
    r.take(cap + 1).read_to_end(&mut out).map_err(|e| format!("inflate: {e}"))?;
    if out.len() as u64 > cap {
        return Err(format!("backup body is over the {cap}-byte cap"));
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

/// The metadata a body starts with.
#[derive(Default)]
struct MetaFields {
    version: Option<u32>,
    created_at_ms: Option<u64>,
    scope: Option<String>,
    reason: Option<String>,
}

impl MetaFields {
    fn complete(&self) -> bool {
        self.version.is_some() && self.created_at_ms.is_some() && self.scope.is_some() && self.reason.is_some()
    }
}

/// Reads the body's top-level keys into `MetaFields` and STOPS once it has
/// them, or at `payload`, which it never reads. It writes through the
/// reference rather than returning, because the prefix it parses ends
/// mid-body: the parse is expected to fail after the visitor returns, and
/// what was captured before that is the answer.
struct MetaSeed<'a>(&'a mut MetaFields);

impl<'de> serde::de::DeserializeSeed<'de> for MetaSeed<'_> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for MetaSeed<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a backup body object")
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "version" => self.0.version = Some(map.next_value()?),
                "created_at_ms" => self.0.created_at_ms = Some(map.next_value()?),
                "scope" => self.0.scope = Some(map.next_value()?),
                "reason" => self.0.reason = Some(map.next_value()?),
                "payload" => return Ok(()),
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                }
            }
            if self.0.complete() {
                return Ok(());
            }
        }
        Ok(())
    }
}

/// A body's metadata from its first `META_PREFIX_BYTES` only, so listing and
/// pruning cost a few KB per file however large (or hostile) the body is:
/// they used to inflate up to 1 GiB and parse the whole `payload` into a
/// `Value` with no cost cap, on every snapshot. None when the prefix does not
/// hold all four fields (not a snapshot, or a corrupt one).
fn read_meta_fields(path: &Path) -> Option<MetaFields> {
    let mut head = Vec::with_capacity(META_PREFIX_BYTES as usize);
    open_body(path).ok()?.take(META_PREFIX_BYTES).read_to_end(&mut head).ok()?;
    let mut fields = MetaFields::default();
    let mut de = serde_json::Deserializer::from_slice(&head);
    let _ = serde::de::DeserializeSeed::deserialize(MetaSeed(&mut fields), &mut de);
    fields.complete().then_some(fields)
}

fn read_meta(path: &Path) -> Option<BackupMeta> {
    let file_name = path.file_name()?.to_str()?.to_string();
    backup_stem(&file_name)?;
    let bytes = std::fs::metadata(path).ok()?;
    let body = read_meta_fields(path)?;
    Some(BackupMeta {
        file_name,
        scope: body.scope?,
        created_at_ms: body.created_at_ms?,
        size_bytes: bytes.len(),
        reason: body.reason?,
    })
}

/// Drop oldest backups until at most `max_keep` remain PER BUCKET
/// (manual / auto) inside `scope_dir`. Manual snapshots are pruned
/// against other manual snapshots only, and the same for auto — so
/// the auto-snapshot scheduler firing every 30 s can NEVER push a
/// user's "Create snapshot now" entry off the cliff.
///
/// `protect` names a snapshot that is never removed, however old (the one a
/// Restore is about to read). It still counts toward its bucket's `max_keep`,
/// so the bucket never grows past what the Settings panel shows.
///
/// `pin_before` is when the history file was set aside as undecodable: for each
/// time, the newest auto snapshot from before then is kept the same way. It is
/// the last one holding that history, and the autos after it hold only what has
/// come back since, so ten of those would otherwise roll it out. The choice is
/// stable (older snapshots stay older), and a later set-aside adds a pin rather
/// than moving this one onto a snapshot taken after the damage. Times sharing a
/// snapshot pin it once, and each pin counts toward the bucket's `max_keep`.
///
/// Returns the total number of snapshots removed across both buckets, and also
/// sweeps stale tmp files (`STALE_TMP_MS`).
/// Best-effort: a delete failure (file locked, permission denied) is
/// logged but not surfaced.
fn prune_dir(dir: &Path, max_keep: usize, protect: Option<&str>, pin_before: &[u64]) -> usize {
    let max_keep = max_keep.min(ABSOLUTE_MAX_KEEP);
    let mut manual: Vec<(PathBuf, u64)> = Vec::new();
    let mut auto: Vec<(PathBuf, u64)> = Vec::new();
    let now = now_unix_ms();
    let Ok(rd) = std::fs::read_dir(dir) else { return 0; };
    for entry in rd.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else { continue; };
        if let Some(ms) = file_name.strip_suffix(BACKUP_SUFFIX_TMP).and_then(|s| s.parse::<u64>().ok()) {
            if now.saturating_sub(ms) > STALE_TMP_MS {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        // Filename is <ms>.aura-backup.json[.gz]: cheap timestamp parse.
        let Some(stem) = backup_stem(file_name) else { continue; };
        let ms: u64 = stem.parse().unwrap_or(0);
        // Reason classification reads the body's metadata prefix only (a
        // few KB), never the payload.
        let reason = read_meta_fields(&path).and_then(|m| m.reason).unwrap_or_default();
        if is_manual_reason(&reason) {
            manual.push((path, ms));
        } else {
            auto.push((path, ms));
        }
    }

    // Newest first within each bucket (descending mtime).
    manual.sort_by_key(|e| std::cmp::Reverse(e.1));
    auto.sort_by_key(|e| std::cmp::Reverse(e.1));

    let pinned: Vec<PathBuf> = pin_before
        .iter()
        .filter_map(|t| auto.iter().find(|(_, ms)| ms < t).map(|(p, _)| p.clone()))
        .collect();
    let is_protected = |p: &Path| {
        (protect.is_some() && p.file_name().and_then(|s| s.to_str()) == protect)
            || pinned.iter().any(|q| q.as_path() == p)
    };
    let mut removed = 0;
    for bucket in [manual, auto] {
        let kept = bucket.iter().filter(|(p, _)| is_protected(p)).count();
        let budget = max_keep.saturating_sub(kept);
        for (path, _) in bucket.into_iter().filter(|(p, _)| !is_protected(p)).skip(budget) {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Atomic write: rename a sibling tmp onto the final path so a crash mid-write
/// never leaves a half-written file with the canonical name. Blocking (the
/// rename's retry sleeps). The tmp is removed on every failure: its name carries
/// the ms, so each one left behind would be another full body nothing reuses.
fn write_snapshot_file(tmp: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(tmp);
        return Err(e.to_string());
    }
    crate::history_store::rename_retrying(tmp, path)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Persist a new backup snapshot for `scope`. The frontend collects the
/// payload (manualWatched + history + autoBumped + auraSettings) and
/// passes it as a JSON object — Rust just frames it with metadata and
/// writes to disk. After writing, prunes the scope directory down to
/// `max_keep` (default 10), never removing the snapshot named by `protect`.
#[tauri::command]
pub async fn create_user_backup<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    reason: String,
    mut payload: serde_json::Value,
    max_keep: Option<usize>,
    protect: Option<String>,
) -> Result<BackupMeta, String> {
    if protect.as_deref().is_some_and(|name| !valid_backup_name(name)) {
        return Err("invalid backup file name".into());
    }
    let history_scope = payload
        .get("historyScope")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("scope").and_then(|v| v.as_str()))
        .unwrap_or("guest")
        .to_string();
    if payload.get("historyFromStore").and_then(|v| v.as_bool()) == Some(true) {
        let app2 = app.clone();
        let hs = history_scope.clone();
        let history = tauri::async_runtime::spawn_blocking(move || {
            crate::history_store::backup_json(&app2, &hs)
        })
        .await
        .map_err(|e| e.to_string())?;
        let history = match history {
            Ok(h) => Some(h),
            // The history file cannot be read right now. An AUTO snapshot
            // still fails (a history-less one would roll the good snapshots
            // out of the auto bucket), but a user-initiated one is written
            // without history: the other stores are readable, and a Restore
            // must have its rollback point. `historyUnavailable` makes a
            // restore of it leave history alone instead of emptying it.
            Err(e) if history_optional(&reason) => {
                crate::devlog!(warn, "backup", "history unavailable ({e}); {reason} snapshot taken without it");
                None
            }
            Err(e) => return Err(e),
        };
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("historyFromStore");
            match history {
                Some(h) => {
                    if let Some(values) = obj.get_mut("values").and_then(|v| v.as_object_mut()) {
                        values.insert("history".into(), serde_json::Value::String(h));
                    }
                }
                None => {
                    obj.insert("historyUnavailable".into(), serde_json::Value::Bool(true));
                }
            }
        }
    }
    let dir = scope_dir(&app, &scope)?;
    let cleaned_scope = sanitise_scope(&scope);
    let ms = now_unix_ms();
    let file_name = format!("{ms}{BACKUP_SUFFIX_GZ}");
    let path = dir.join(&file_name);

    let body = BackupBody {
        version: 1,
        created_at_ms: ms,
        scope: cleaned_scope.clone(),
        reason: reason.clone(),
        payload,
    };
    let json = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    // Never write a snapshot a restore would refuse.
    check_body(&json)?;
    let gz = {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        enc.finish().map_err(|e| e.to_string())?
    };

    let gz_len = gz.len();
    let keep = max_keep.unwrap_or(DEFAULT_MAX_KEEP);
    let removed = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let tmp = dir.join(format!("{ms}{BACKUP_SUFFIX_TMP}"));
        write_snapshot_file(&tmp, &path, &gz)?;
        // The history scope, not `scope`: the two differ (see userDataBackup.ts).
        let pin_before = crate::history_store::set_aside_times(&app, &history_scope);
        Ok(prune_dir(&dir, keep, protect.as_deref(), &pin_before))
    })
    .await
    .map_err(|e| e.to_string())??;
    if removed > 0 {
        crate::devlog!(
            info, "backup",
            "scope={cleaned_scope} pruned {removed} old backups",
        );
    }
    crate::devlog!(
        info, "backup",
        "wrote {} bytes ({} as JSON) for scope {cleaned_scope} ({reason})",
        gz_len,
        json.len(),
    );

    Ok(BackupMeta {
        file_name,
        scope: cleaned_scope,
        created_at_ms: ms,
        size_bytes: gz_len as u64,
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
    if !valid_backup_name(&file_name) {
        return Err("invalid backup file name".into());
    }
    let path = dir.join(&file_name);
    read_body_text(&path)
}

/// Delete a single backup file by filename. The matching scope dir is
/// resolved from the supplied `scope`; the file_name is whitelisted to
/// a snapshot suffix and a single path segment so a
/// malicious frontend can't traverse outside the backups root.
#[tauri::command]
pub async fn delete_user_backup<R: Runtime>(
    app: AppHandle<R>,
    scope: String,
    file_name: String,
) -> Result<(), String> {
    if !valid_backup_name(&file_name) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_suffixes_are_snapshots_and_nothing_else_is() {
        assert_eq!(backup_stem("1793000000000.aura-backup.json"), Some("1793000000000"));
        assert_eq!(backup_stem("1793000000000.aura-backup.json.gz"), Some("1793000000000"));
        assert_eq!(backup_stem("1793000000000.aura-backup.tmp"), None);
        assert!(valid_backup_name("1.aura-backup.json.gz"));
        assert!(valid_backup_name("1793000000000.aura-backup.json"));
        assert!(!valid_backup_name("../1.aura-backup.json.gz"));
        // Drive-relative names: `dir.join` would REPLACE the scope dir.
        assert!(!valid_backup_name("D:loot.aura-backup.json"));
        assert!(!valid_backup_name("C:..aura-backup.json.gz"));
        assert!(!valid_backup_name("1:stream.aura-backup.json"));
        assert!(!valid_backup_name(".aura-backup.json"));
        assert!(!valid_backup_name("1.2.aura-backup.json"));
        assert!(!valid_backup_name("a\\1.aura-backup.json"));
        // An older Aura's filter: `ends_with(".aura-backup.json")`. A gzipped
        // snapshot must not pass it, or its prune would misfile it as auto.
        assert!(!"1.aura-backup.json.gz".ends_with(BACKUP_SUFFIX));
    }

    #[test]
    fn prune_reads_the_reason_of_a_gzipped_body() {
        let dir = std::env::temp_dir().join(format!("aura-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |ms: u64, reason: &str| {
            let body = BackupBody { version: 1, created_at_ms: ms, scope: "t".into(), reason: reason.into(), payload: serde_json::json!({}) };
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(serde_json::to_string(&body).unwrap().as_bytes()).unwrap();
            std::fs::write(dir.join(format!("{ms}{BACKUP_SUFFIX_GZ}")), enc.finish().unwrap()).unwrap();
        };
        write(1, "manual");
        for ms in 2..6 {
            write(ms, "auto-snapshot");
        }
        // Keep 2 per bucket: two of the four autos go, the lone manual stays.
        assert_eq!(prune_dir(&dir, 2, None, &[]), 2);
        assert!(dir.join(format!("1{BACKUP_SUFFIX_GZ}")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Restoring the oldest manual snapshot: the pre-restore snapshot must not
    /// prune the very file about to be read, and the bucket stays at its cap.
    #[test]
    fn prune_keeps_the_protected_snapshot_within_the_cap() {
        let dir = scratch("protect");
        let name = |ms: u64| format!("{ms}{BACKUP_SUFFIX_GZ}");
        for ms in 1..=4 {
            std::fs::write(dir.join(name(ms)), gz(honest_body(ms, "manual", 1).as_bytes())).unwrap();
        }
        assert_eq!(prune_dir(&dir, 3, Some(&name(1)), &[]), 1);
        let left = [1u64, 2, 3, 4].map(|ms| dir.join(name(ms)).exists());
        assert_eq!(left, [true, false, true, true], "the oldest stays, the next-oldest goes");
        // Protecting a name in no bucket changes nothing.
        assert_eq!(prune_dir(&dir, 3, Some(&name(99)), &[]), 0);
        // An auto snapshot is protected in its own bucket, never the other's.
        std::fs::write(dir.join(name(5)), gz(honest_body(5, "auto-snapshot", 1).as_bytes())).unwrap();
        std::fs::write(dir.join(name(6)), gz(honest_body(6, "auto-snapshot", 1).as_bytes())).unwrap();
        assert_eq!(prune_dir(&dir, 1, Some(&name(5)), &[]), 3);
        assert!(dir.join(name(5)).exists() && dir.join(name(4)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A set-aside history: the autos after it hold almost nothing, and however
    /// many of them come, the last auto from before it stays, within the cap.
    #[test]
    fn prune_pins_the_last_auto_from_before_a_set_aside() {
        let dir = scratch("pin");
        let name = |ms: u64| format!("{ms}{BACKUP_SUFFIX_GZ}");
        let add = |ms: u64, reason: &str| {
            std::fs::write(dir.join(name(ms)), gz(honest_body(ms, reason, 1).as_bytes())).unwrap();
        };
        for ms in 1..=4 {
            add(ms, "auto-snapshot");
        }
        // A manual one newer than the pin's choice is not a candidate.
        add(5, "manual");
        let set_aside = 6;
        // Binge after binge: the pin holds, the rest roll, the cap holds.
        for ms in 7..=14 {
            add(ms, "startup");
            prune_dir(&dir, 3, None, &[set_aside]);
            assert!(dir.join(name(4)).exists(), "after {ms}");
            let autos = (1..=ms).filter(|m| *m != 5 && dir.join(name(*m)).exists()).count();
            assert!(autos <= 3, "after {ms}: {autos} autos");
            assert!(dir.join(name(ms)).exists());
        }
        assert!(dir.join(name(5)).exists(), "the manual bucket is its own");
        assert!(!dir.join(name(3)).exists());
        // A later set-aside adds a pin: the snapshot from before the first
        // damage stays through the rolling that follows, beside the new one.
        prune_dir(&dir, 3, None, &[set_aside, 14]);
        assert!(dir.join(name(4)).exists() && dir.join(name(13)).exists());
        add(15, "startup");
        add(16, "startup");
        prune_dir(&dir, 3, None, &[set_aside, 14]);
        assert!(dir.join(name(4)).exists() && dir.join(name(13)).exists());
        assert!(dir.join(name(16)).exists() && !dir.join(name(15)).exists());
        // Two times with no snapshot between them hold one place in the cap.
        assert_eq!(prune_dir(&dir, 3, None, &[set_aside, 5]), 0);
        // With no set-aside, and with no auto older than it, plain newest-first.
        add(17, "startup");
        assert_eq!(prune_dir(&dir, 2, None, &[]), 2);
        assert!(dir.join(name(16)).exists() && dir.join(name(17)).exists());
        assert_eq!(prune_dir(&dir, 1, None, &[1]), 1);
        assert!(dir.join(name(17)).exists() && !dir.join(name(16)).exists());
        // It works beside a Restore's protected name, each counted in the cap.
        for ms in 20..=23 {
            add(ms, "auto-snapshot");
        }
        prune_dir(&dir, 2, Some(&name(20)), &[22]);
        assert!(dir.join(name(20)).exists() && dir.join(name(21)).exists());
        assert!(!dir.join(name(22)).exists() && !dir.join(name(23)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A crash's leftover tmp goes; a young one may be another call's in flight.
    #[test]
    fn prune_sweeps_only_stale_tmp_files() {
        let dir = scratch("tmp-sweep");
        let now = now_unix_ms();
        let stale = dir.join(format!("{}{BACKUP_SUFFIX_TMP}", now - STALE_TMP_MS - 1000));
        let young = dir.join(format!("{}{BACKUP_SUFFIX_TMP}", now - 1000));
        let other = dir.join(format!("notes{BACKUP_SUFFIX_TMP}"));
        for f in [&stale, &young, &other] {
            std::fs::write(f, b"x").unwrap();
        }
        assert_eq!(prune_dir(&dir, 2, None, &[]), 0, "only snapshots count as pruned");
        assert!(!stale.exists() && young.exists() && other.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_snapshot_write_leaves_no_tmp() {
        let dir = scratch("write-fail");
        let tmp = dir.join(format!("1{BACKUP_SUFFIX_TMP}"));
        let path = dir.join(format!("1{BACKUP_SUFFIX_GZ}"));
        write_snapshot_file(&tmp, &path, b"body").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"body");
        assert!(!tmp.exists());
        // The target is a non-empty directory: the rename can never work.
        let blocked = dir.join(format!("2{BACKUP_SUFFIX_GZ}"));
        std::fs::create_dir_all(blocked.join("x")).unwrap();
        let tmp = dir.join(format!("2{BACKUP_SUFFIX_TMP}"));
        assert!(write_snapshot_file(&tmp, &blocked, b"body").is_err());
        assert!(!tmp.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    use crate::history_store::alloc_probe::measured;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aura-backup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn gz(text: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(text).unwrap();
        enc.finish().unwrap()
    }

    /// An honest body, in the frontend's shape: every value a string, the
    /// history one a JSON array of rows.
    fn honest_body(ms: u64, reason: &str, rows: usize) -> String {
        let history: Vec<serde_json::Value> = (0..rows)
            .map(|i| serde_json::json!({
                "id": format!("tt{:07}:1:{i}", 1_000_000 + i % 17),
                "name": format!("Show {} \"quoted\"", i % 17),
                "played_at": "2026-10-31T11:29:46.668Z",
                "poster": "https://example.invalid/p.jpg",
                "watched_seconds": 1096.012,
            }))
            .collect();
        let body = BackupBody {
            version: 1,
            created_at_ms: ms,
            scope: "user-0123456789abcdef".into(),
            reason: reason.into(),
            payload: serde_json::json!({
                "capturedAt": "2026-11-01T00:00:00.000Z",
                "values": {
                    "manualState": "{\"a\":1}",
                    "skipMarks": null,
                    "history": serde_json::to_string(&history).unwrap(),
                    "autoBumped": "[]",
                    "auraSettings": "{\"theme\":\"midnight\"}",
                },
            }),
        };
        serde_json::to_string(&body).unwrap()
    }

    /// Honest bodies, plain and gzipped, still list, prune and restore
    /// exactly, with the metadata read from the prefix alone.
    #[test]
    fn honest_bodies_round_trip() {
        let dir = scratch("honest");
        let big = honest_body(2, "manual", 20_000);
        assert!(big.len() > 2 << 20, "a body far past the metadata prefix");
        std::fs::write(dir.join(format!("1{BACKUP_SUFFIX}")), honest_body(1, "auto-snapshot", 50)).unwrap();
        std::fs::write(dir.join(format!("2{BACKUP_SUFFIX_GZ}")), gz(big.as_bytes())).unwrap();
        let m = read_meta(&dir.join(format!("1{BACKUP_SUFFIX}"))).unwrap();
        assert_eq!((m.scope.as_str(), m.created_at_ms, m.reason.as_str()), ("user-0123456789abcdef", 1, "auto-snapshot"));
        let (m, peak, _) = measured(|| read_meta(&dir.join(format!("2{BACKUP_SUFFIX_GZ}"))).unwrap());
        assert_eq!((m.created_at_ms, m.reason.as_str()), (2, "manual"));
        assert!(peak < 256 << 10, "a listing reads the prefix only: {peak}");
        assert_eq!(read_body_text(&dir.join(format!("2{BACKUP_SUFFIX_GZ}"))).unwrap(), big);
        assert!(check_body(&big).is_ok());
        // Not a snapshot: no metadata.
        std::fs::write(dir.join(format!("3{BACKUP_SUFFIX}")), b"{\"payload\":{},\"reason\":\"manual\"}").unwrap();
        assert!(read_meta(&dir.join(format!("3{BACKUP_SUFFIX}"))).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reproduced attack: a ~1 MB gzipped body whose payload is millions
    /// of `0,` (16 MiB of text here; 64 MiB was ~18-26 GiB of parse demand).
    /// List and prune read a few KB of it; a restore refuses it on its
    /// structure without parsing it; and no snapshot like it can be written.
    #[test]
    fn a_hostile_body_is_cheap_to_list_and_refused_on_restore() {
        let dir = scratch("hostile");
        let mut text = String::from(r#"{"version":1,"created_at_ms":7,"scope":"g","reason":"manual","payload":["#);
        text.push_str(&"0,".repeat(8 << 20));
        text.push_str("0]}");
        let file = dir.join(format!("7{BACKUP_SUFFIX_GZ}"));
        std::fs::write(&file, gz(text.as_bytes())).unwrap();
        for i in 8..12u64 {
            std::fs::write(dir.join(format!("{i}{BACKUP_SUFFIX_GZ}")), gz(honest_body(i, "auto-snapshot", 5).as_bytes())).unwrap();
        }
        let (m, peak, _) = measured(|| read_meta(&file).unwrap());
        assert_eq!(m.reason, "manual");
        assert!(peak < 256 << 10, "listing: {peak}");
        let (removed, peak, _) = measured(|| prune_dir(&dir, 2, None, &[]));
        assert_eq!(removed, 2, "two autos go; the 'manual' one is classified from its prefix");
        assert!(file.exists());
        assert!(peak < 1 << 20, "pruning: {peak}");
        let (res, peak, _) = measured(|| read_body_text(&file));
        assert!(res.unwrap_err().contains("structure"));
        // The text alone (and its Vec's doubling), never a parsed tree.
        assert!((peak as usize) < 2 * text.len() + (1 << 20), "restore: {peak}");
        assert!(check_body(&text).is_err(), "and create_user_backup refuses to write one");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A body that inflates past the cap is an ERROR: it used to be cut at
    /// 1 GiB and handed on as if whole.
    #[test]
    fn an_inflate_past_the_cap_is_an_error_not_a_truncation() {
        let text = honest_body(1, "manual", 200);
        let packed = gz(text.as_bytes());
        let cap = text.len() as u64;
        assert_eq!(read_text_capped(flate2::read::GzDecoder::new(&packed[..]), cap).unwrap(), text);
        let err = read_text_capped(flate2::read::GzDecoder::new(&packed[..]), cap - 1).unwrap_err();
        assert!(err.contains("cap"), "{err}");
        // A gzip stream cut short is an error too, not a shorter body.
        assert!(read_text_capped(flate2::read::GzDecoder::new(&packed[..packed.len() / 2]), cap).is_err());
    }

    /// Against real snapshots (never committed): every body's prefix metadata
    /// matches a full parse, and its restore text is the file's. Run with
    /// `AURA_HISTORY_CORPUS=<one backup file> cargo test --lib backup -- --ignored`
    /// (its whole directory is read).
    #[test]
    #[ignore]
    fn real_backups_read_as_before() {
        let Ok(path) = std::env::var("AURA_HISTORY_CORPUS") else { return };
        let dir = Path::new(&path).parent().unwrap();
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if !p.file_name().and_then(|f| f.to_str()).is_some_and(valid_backup_name) {
                continue;
            }
            let text = read_body_text(&p).unwrap();
            let full: serde_json::Value = serde_json::from_str(&text).unwrap();
            let m = read_meta(&p).unwrap();
            assert_eq!(full["reason"].as_str(), Some(m.reason.as_str()));
            assert_eq!(full["scope"].as_str(), Some(m.scope.as_str()));
            assert_eq!(full["created_at_ms"].as_u64(), Some(m.created_at_ms));
            let structure = crate::history_store::json_parse_cost(text.as_bytes()) - text.len() as u64;
            println!("{}: {} B text, structure {structure} B, reason {}", m.file_name, text.len(), m.reason);
            n += 1;
        }
        assert!(n > 0);
    }
}
