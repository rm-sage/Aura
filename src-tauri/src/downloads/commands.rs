// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Tauri surface: five commands.
//!
//! Five, not fourteen, because every command needs THREE registration sites
//! (`lib.rs` `generate_handler!`, `permissions/player.toml`,
//! `capabilities/default.json`) and missing any one of them is a silent 401 at
//! runtime. `downloads_control` therefore takes a tagged `ControlAction` enum
//! and returns a fresh snapshot, collapsing pause / resume / cancel / retry /
//! relink / reorder / clear / pause-all into one entry.

use tauri::{AppHandle, Wry};

use super::manager;
use super::types::*;

/// Everything currently known, including the resolved root. The frontend calls
/// this on mount, which is what makes an F5 lossless.
#[tauri::command]
pub fn downloads_list() -> DownloadsSnapshot {
    manager::snapshot()
}

/// Resolve where a download WOULD go, without creating anything.
///
/// The detail page calls this on right-click so the menu can show the
/// destination and grey out an item that is already downloaded. `downloads_
/// enqueue` re-runs the same planning with the same input, so the two can never
/// disagree about the path.
#[tauri::command]
pub fn downloads_plan_path(input: NameInput) -> Result<PlannedPath, String> {
    let root = resolve_root()?;
    let plan = plan_for(&root, &input)?;
    let duplicate = plan.planned.exists() || manager::is_claimed(&plan.planned);
    Ok(PlannedPath {
        path: plan.planned.to_string_lossy().into_owned(),
        truncated: plan.truncated,
        duplicate,
    })
}

/// Set (and validate) the download root, persisting it to settings.
///
/// Returns the RESOLVED path, which can differ from what was passed: an 8.3
/// short name expands, and a trailing separator is normalised away. The
/// frontend stores what comes back so the Settings field shows the real path.
#[tauri::command]
pub async fn downloads_set_root(app: AppHandle<Wry>, path: String) -> Result<String, String> {
    let root = crate::download_path::validate_root(&path).map_err(|e| e.to_string())?;
    let resolved = root.to_string_lossy().into_owned();
    let patch = serde_json::json!({ "download_dir": resolved });
    crate::settings::update_settings(app, patch).await?;
    manager::set_root(resolved.clone());
    crate::devlog!(info, "downloads", "root set to {resolved}");
    Ok(resolved)
}

/// Start a download.
#[tauri::command]
pub async fn downloads_enqueue(req: EnqueueRequest) -> Result<DownloadJobDto, String> {
    let root = resolve_root()?;

    let kind = classify(&req.url)?;
    let plan = plan_for(&root, &req.naming)?;

    if !req.allow_duplicate {
        if manager::is_claimed(&plan.planned) {
            return Err("[dupe] That file is already in the download list.".into());
        }
        if plan.planned.exists() {
            return Err("[dupe] That file has already been downloaded.".into());
        }
    }

    crate::download_path::prepare_dir(&root, &plan)?;

    // Reserve the in-progress file. `create_new` is the claim, and it is the
    // only race-free test on Windows: an `exists()` check would both TOCTOU
    // against the other concurrent worker and miss `dune.mkv` when asking
    // about `Dune.mkv`, because NTFS is case-insensitive.
    let (part_path, dest_path) = match kind {
        JobKind::Http => {
            let (p, f) = crate::download_path::claim_part(&plan.dir, &plan.stem, &plan.ext)?;
            drop(f);
            // The claim may have landed on " (2)"; the destination has to match
            // it or the final rename would target a different name.
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_suffix(&format!(".{}", plan.ext)))
                .unwrap_or(&plan.stem)
                .to_string();
            let dest = plan.dir.join(format!("{stem}.{}", plan.ext));
            (p, dest)
        }
        JobKind::HlsLedger | JobKind::HlsPassthrough => {
            // The ledger owns a directory, kept UNDER the download root rather
            // than in %TEMP%: std::fs::rename fails with ERROR_NOT_SAME_DEVICE
            // across volumes, and a cross-volume copy of an 8 GB file is not an
            // atomic publish.
            let work = root
                .join(crate::download_path::WORK_DIR)
                .join(new_id());
            std::fs::create_dir_all(&work)
                .map_err(|e| format!("Could not create the working folder: {e}"))?;
            (work, plan.planned.clone())
        }
    };

    let job = DownloadJob {
        id: new_id(),
        state: DownloadState::Queued,
        kind,
        url: req.url,
        headers: req.headers,
        title: req.title,
        subtitle: req.subtitle,
        dest_path: dest_path.to_string_lossy().into_owned(),
        part_path: part_path.to_string_lossy().into_owned(),
        total_bytes: None,
        bytes_done: 0,
        resumable: false,
        validator: None,
        origin: req.origin,
        attempt: 0,
        error: None,
        created_at: req.created_at,
        completed_at: None,
        truncated: plan.truncated,
    };
    crate::devlog!(info, "downloads", "queued {} -> {}", job.title, job.dest_path);
    manager::enqueue(job)
}

/// Pause / resume / cancel / retry / relink / reorder / clear, in one command.
#[tauri::command]
pub fn downloads_control(action: ControlAction) -> Result<DownloadsSnapshot, String> {
    manager::control(action)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The configured root, revalidated RIGHT NOW. Called at enqueue and at every
/// resume, because those can be separated by hours and a removable drive.
fn resolve_root() -> Result<std::path::PathBuf, String> {
    let configured = crate::settings::snapshot().download_dir;
    crate::download_path::validate_root(&configured).map_err(|e| match e {
        // The frontend keys the folder-picker prompt off this exact sentinel,
        // so it must stay stable.
        crate::download_path::RootError::Unset => "[noroot] No download folder is set yet.".into(),
        other => other.to_string(),
    })
}

/// Which transport a URL needs.
fn classify(url: &str) -> Result<JobKind, String> {
    let lower = url.to_ascii_lowercase();
    let path_only = lower.split(['?', '#']).next().unwrap_or(&lower);
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        // Magnet and infoHash-only rows land here. Aura is Stremio-addon-only
        // with Debrid and has no torrent engine, so there is no file to fetch.
        return Err("That source has no direct file to download.".into());
    }
    if path_only.ends_with(".m3u8") || path_only.ends_with(".m3u") {
        // The gate in `hls` decides ledger vs passthrough once it has read the
        // playlist; both are HLS as far as classification goes.
        return Ok(JobKind::HlsLedger);
    }
    Ok(JobKind::Http)
}

/// Build the destination plan from a `NameInput`, honouring the organised/flat
/// setting. Shared by `downloads_plan_path` and `downloads_enqueue` so the
/// preview and the real thing cannot drift.
fn plan_for(
    root: &std::path::Path,
    input: &NameInput,
) -> Result<crate::download_path::PathPlan, String> {
    use crate::download_path as dp;

    let organised = crate::settings::snapshot().download_organise;
    let (ext, _src) = dp::choose_extension(
        input.release_name.as_deref(),
        input.url.as_deref(),
        None,
    );
    // Seeded on the job's own identity so two unusable names cannot collapse
    // into one file.
    let fallback = dp::fallback_stem(&format!(
        "{}|{}|{}",
        input.url.as_deref().unwrap_or(""),
        input.release_name.as_deref().unwrap_or(""),
        input.title
    ));

    let is_series = input.media_type != "movie";
    let organised_layout = if input.episode_pack && is_series {
        // A pack is one file holding many episodes, so it must never be named
        // as a single episode.
        let multi = input
            .release_name
            .as_deref()
            .map(looks_multi_season)
            .unwrap_or(false);
        dp::organised_pack(
            &input.title,
            input.year,
            input.season,
            input.release_name.as_deref(),
            multi,
            &ext,
            &fallback,
        )
    } else if is_series {
        dp::organised_series(
            &input.title,
            input.year,
            input.season,
            input.episode,
            input.episode_title.as_deref(),
            &ext,
            &fallback,
        )
    } else {
        dp::organised_movie(&input.title, input.year, &ext, &fallback)
    };

    let layout = if organised {
        organised_layout
    } else {
        dp::flat(
            input.release_name.as_deref(),
            &organised_layout.stem,
            &ext,
            &fallback,
        )
    };
    dp::plan(root, layout)
}

/// `S01-S05`, `S01-05`, or a COMPLETE tag: a pack that belongs to no single
/// season and therefore cannot live in a `Season NN` folder.
fn looks_multi_season(release: &str) -> bool {
    let u = release.to_ascii_uppercase();
    if u.contains("COMPLETE") {
        return true;
    }
    let bytes = u.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'S' && i + 3 <= bytes.len() {
            let rest = &u[i + 1..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.len() >= 2 {
                let after = &rest[digits.len()..];
                if after.starts_with('-') {
                    return true;
                }
            }
        }
    }
    false
}
