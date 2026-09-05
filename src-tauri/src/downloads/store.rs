// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Job-list persistence.
//!
//! The list lives at `<app_data_dir>/downloads.json`. It is scope-independent
//! on purpose: a download is a file on this machine's disk, not a property of
//! whichever Stremio account happens to be signed in, and losing the list on a
//! logout would strand `.aurapart` files with nothing pointing at them.
//!
//! Write cadence is the whole design problem here. Progress moves continuously,
//! and a naive "persist on change" would hammer the disk. Two rules keep the
//! steady state at zero writes:
//!
//!   1. `bytes_done` is NEVER persisted as a moving value. It is recomputed
//!      from `metadata(part).len()` on load, so the file on disk IS the
//!      progress record.
//!   2. Writes are debounced and only happen on a STATE TRANSITION (enqueue,
//!      pause, complete, fail, reorder), never on a progress tick.
//!
//! A running download therefore performs no periodic writes at all.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

use super::types::{DownloadJob, DownloadState, JobKind};

/// Bumped when the on-disk shape changes incompatibly. An unknown version is
/// treated as "start empty" rather than as an error, so a downgrade cannot
/// wedge the app on a file it cannot parse.
const SCHEMA_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct Persisted {
    version: u32,
    jobs: Vec<DownloadJob>,
}

static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static DIRTY: AtomicBool = AtomicBool::new(false);

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let p = app.path().app_data_dir().ok().map(|d| d.join("downloads.json"));
    let _ = PATH.set(p);
}

fn path() -> Option<&'static PathBuf> {
    PATH.get().and_then(|o| o.as_ref())
}

/// Load the persisted list, repairing anything the last run left inconsistent.
///
/// Two repairs, both mandatory:
///
///   * `Running` becomes `Paused`. The worker that owned it died with the
///     process, so the state is a lie the moment it is read back.
///   * `Relinking` becomes `NeedsSource`. The frontend that was going to
///     answer is gone, and leaving it `Relinking` would show a spinner nothing
///     will ever resolve.
///
/// A parse failure returns an empty list and moves the bad file aside rather
/// than deleting it, so a bug here is recoverable by hand.
pub fn load() -> Vec<DownloadJob> {
    let Some(p) = path() else { return Vec::new() };
    if !p.is_file() {
        return Vec::new();
    }
    let raw = match std::fs::read_to_string(p) {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(warn, "downloads", "could not read job list: {e}");
            return Vec::new();
        }
    };
    let parsed: Persisted = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(error, "downloads", "job list is unreadable ({e}); setting it aside");
            let _ = std::fs::rename(p, p.with_extension("json.bad"));
            return Vec::new();
        }
    };
    if parsed.version != SCHEMA_VERSION {
        crate::devlog!(
            warn, "downloads",
            "job list schema {} is not {SCHEMA_VERSION}; starting empty", parsed.version
        );
        return Vec::new();
    }

    let mut jobs = parsed.jobs;
    for j in &mut jobs {
        match j.state {
            // Nothing auto-starts on launch. Both of these were mid-flight when
            // the process ended, and the close prompt tells the user they will
            // be "waiting, paused" next time; silently resuming a 40 GB
            // transfer the moment Aura opens would make that a lie and would
            // surprise anyone on a metered connection.
            DownloadState::Running | DownloadState::Queued => {
                j.state = DownloadState::Paused
            }
            DownloadState::Relinking => {
                j.state = DownloadState::NeedsSource;
                j.error = Some("Aura closed while refreshing this link.".into());
            }
            _ => {}
        }
        // The partial on disk is the truth about progress. For the HLS ledger
        // `part_path` is a DIRECTORY, so its metadata length is meaningless;
        // the accumulation file inside it is the real figure. Without this an
        // interrupted HLS download came back reading 0 bytes and 0%, as if
        // nothing had been fetched.
        j.bytes_done = match j.kind {
            JobKind::Http => std::fs::metadata(&j.part_path).map(|m| m.len()).unwrap_or(0),
            JobKind::HlsLedger | JobKind::HlsPassthrough => {
                std::fs::metadata(std::path::Path::new(&j.part_path).join("media.bin"))
                    .or_else(|_| {
                        std::fs::metadata(std::path::Path::new(&j.part_path).join("out.mkv"))
                    })
                    .map(|m| m.len())
                    .unwrap_or(0)
            }
        };
    }
    crate::devlog!(info, "downloads", "loaded {} job(s)", jobs.len());
    jobs
}

/// Mark the list as needing a write. Cheap enough to call from any transition.
pub fn mark_dirty() {
    DIRTY.store(true, Ordering::Relaxed);
}

/// Write the list if anything changed. Called from the manager's own cadence
/// and unconditionally at shutdown.
pub fn flush_if_dirty(jobs: &[DownloadJob]) {
    if DIRTY.swap(false, Ordering::Relaxed) {
        write(jobs);
    }
}

/// Write the list now, whatever the dirty flag says.
pub fn flush(jobs: &[DownloadJob]) {
    DIRTY.store(false, Ordering::Relaxed);
    write(jobs);
}

fn write(jobs: &[DownloadJob]) {
    let Some(p) = path() else { return };
    // `Running` is never persisted: it would be a lie on the next load, and
    // `load` would have to undo it anyway.
    let snapshot: Vec<DownloadJob> = jobs
        .iter()
        .map(|j| {
            let mut c = j.clone();
            if c.state == DownloadState::Running {
                c.state = DownloadState::Paused;
            }
            c
        })
        .collect();

    let body = match serde_json::to_string_pretty(&Persisted {
        version: SCHEMA_VERSION,
        jobs: snapshot,
    }) {
        Ok(s) => s,
        Err(e) => {
            crate::devlog!(error, "downloads", "could not serialise job list: {e}");
            return;
        }
    };

    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write-then-rename so a crash mid-write cannot leave a truncated list
    // where a valid one used to be.
    let tmp = p.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, body) {
        crate::devlog!(error, "downloads", "could not write job list: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, p) {
        crate::devlog!(error, "downloads", "could not commit job list: {e}");
        let _ = std::fs::remove_file(&tmp);
    }
}
