// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Download manager.
//!
//! Right-click a stream source on the detail page to download the file. A
//! title-bar button relays status and opens a panel with pause / resume /
//! cancel. Downloads are FILE downloads: Aura gains no offline playback, and
//! `load_video` (`lib.rs:153-168`) still refuses local paths.
//!
//! Ownership: Rust is authoritative. The React store is a projection that
//! rehydrates from `downloads_list` on mount, because the webview can be
//! reloaded (F5, the stream-lost modal's Reload button, an HMR module swap)
//! while a 40 GB transfer is halfway through, and none of those may lose the
//! job list.
//!
//! Layout:
//!   * `types`    wire and persistence types
//!   * `manager`  the registry, the scheduler pump, the snapshot cadence
//!   * `store`    `downloads.json`
//!   * `http`     direct-file transport
//!   * `hls`      the two HLS modes
//!   * `taskbar`  Windows taskbar progress
//!   * `commands` the five Tauri commands
//!
//! Path safety lives one level up in `crate::download_path`, because it is a
//! standalone concern with its own tests and no dependency on any of this.

pub mod commands;
mod hls;
mod http;
mod manager;
mod store;
mod taskbar;
pub mod types;

use types::{DownloadJob, JobKind};

pub use manager::{active_count, shutdown, unpausable_active};

/// Called once from the lib.rs setup hook, after settings have loaded (the
/// root path comes from there) and after `runtime_deps` has resolved, so an
/// HLS job can find ffmpeg.
pub fn init(app: tauri::AppHandle<tauri::Wry>) {
    manager::init(app);
}

/// Remove whatever a cancelled job left behind.
///
/// The HLS ledger owns a directory, the HTTP transport owns one file. Both are
/// inside the download root, and both are named so that nothing the user
/// created can be matched by accident.
pub fn cleanup_partial(job: &DownloadJob) {
    let p = std::path::Path::new(&job.part_path);
    match job.kind {
        JobKind::Http => {
            if p.is_file() {
                if let Err(e) = std::fs::remove_file(p) {
                    crate::devlog!(warn, "downloads", "could not remove {}: {e}", p.display());
                }
            }
        }
        JobKind::HlsLedger | JobKind::HlsPassthrough => {
            if p.is_dir() {
                if let Err(e) = std::fs::remove_dir_all(p) {
                    crate::devlog!(warn, "downloads", "could not remove {}: {e}", p.display());
                }
            } else if p.is_file() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

/// Upgrade a job's container once a real `Content-Type` arrives.
///
/// Only ever fires when the extension was the DEFAULT guess. A container the
/// addon filename or the URL path stated explicitly is more trustworthy than a
/// header, and `application/octet-stream` (what most debrid hosts send) says
/// nothing at all.
/// Returns the new `(dest_path, part_path)` when the container was upgraded,
/// so the CALLER can keep using paths that exist.
///
/// The worker holds an owned clone of its `DownloadJob`, and updating only the
/// registry left that clone pointing at a file this function had just renamed:
/// the next `open()` hit a missing path and killed the job with `Fatal` at zero
/// bytes, on the first response, for every source whose container is elected
/// from `Content-Type`.
fn refine_extension(job: &DownloadJob, content_type: &str) -> Option<(String, String)> {
    let dest = std::path::Path::new(&job.dest_path);
    let current = dest.extension().and_then(|e| e.to_str()).unwrap_or("");
    if current != crate::download_path::DEFAULT_EXT {
        return None;
    }
    let (elected, source) = crate::download_path::choose_extension(None, None, Some(content_type));
    if source != crate::download_path::ExtSource::ContentType || elected == current {
        return None;
    }
    let new_dest = dest.with_extension(&elected);
    let new_part = std::path::PathBuf::from(format!(
        "{}.{}",
        new_dest.display(),
        crate::download_path::PART_SUFFIX
    ));
    // Move the bytes we already have, so a refinement mid-transfer does not
    // orphan the partial.
    if std::path::Path::new(&job.part_path).exists() {
        if let Err(e) = std::fs::rename(&job.part_path, &new_part) {
            crate::devlog!(
                warn, "downloads",
                "could not rename the partial to {}: {e}", new_part.display()
            );
            return None;
        }
    }
    crate::devlog!(
        info, "downloads",
        "{}: container refined to .{elected} from Content-Type", job.title
    );
    let dest_s = new_dest.to_string_lossy().into_owned();
    let part_s = new_part.to_string_lossy().into_owned();
    manager::record_dest(&job.id, dest_s.clone(), part_s.clone());
    Some((dest_s, part_s))
}
