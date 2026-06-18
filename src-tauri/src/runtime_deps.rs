// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! On-demand runtime binaries.
//!
//! The large optional-feature binaries — `ffmpeg.exe` (silence detection) and
//! `ffprobe.exe` (casting transmux) — are NOT shipped in the installer; that
//! keeps ~314 MB out of every update download. Instead they're hosted as assets
//! on the `runtime-deps` GitHub *prerelease* (prerelease so it never becomes the
//! "Latest" release the updater's `releases/latest/...` URL resolves to) and
//! fetched on first use into a stable per-user directory that survives app
//! updates (`<app_local_data>/runtime`), each verified against a baked SHA-256.
//!
//! Resolution order is unchanged for users who already have the binary:
//! [`resolved_path`] (downloaded copy) is checked FIRST by
//! `silencedetect::ffmpeg_bin` and `cast::locate_tool`, then their existing
//! bundle/exe/dev candidates, then PATH — so a system ffmpeg, a hand-placed
//! `lib/ffmpeg.exe`, or an old bundled copy left over from a prior version all
//! still work and nothing regresses.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// One downloadable binary.
struct Dep {
    /// Filename on disk AND the GitHub asset name.
    name: &'static str,
    /// Direct download URL (runtime-deps prerelease asset).
    url: &'static str,
    /// Lowercase-hex SHA-256 of the expected file. Bump this (and replace the
    /// asset) to ship a newer binary — a mismatch forces a fresh download.
    sha256: &'static str,
}

const DEPS: &[Dep] = &[
    Dep {
        name: "ffmpeg.exe",
        url: "https://github.com/rm-sage/Aura/releases/download/runtime-deps/ffmpeg.exe",
        sha256: "228d7a8556258de907fdb55f36850078ebc7680b84ec30d84ea02e99bec1d1eb",
    },
    Dep {
        name: "ffprobe.exe",
        url: "https://github.com/rm-sage/Aura/releases/download/runtime-deps/ffprobe.exe",
        sha256: "0fde260f5abd35c9cafd96f594cc76365a780c1b73a90e35b6a3409ea1db1bf0",
    },
    // The mpv core (Windows). Unlike ffmpeg/ffprobe this is REQUIRED for any
    // playback — the first-run gate (PlaybackEngineGate) downloads it before the
    // engine starts. Only fresh installs fetch it: an update keeps the prior
    // version's libmpv-2.dll in the install dir, which the engine resolver finds.
    Dep {
        name: "libmpv-2.dll",
        url: "https://github.com/rm-sage/Aura/releases/download/runtime-deps/libmpv-2.dll",
        sha256: "9826b77fb42559752cd37a19191169a986aa4e929eb37705c3345d25a5f6d034",
    },
    // yt-dlp (Windows) — resolves a "Watch Trailer" YouTube id to a direct CDN
    // URL for in-player playback. Optional: absent ⇒ the trailer button shows a
    // one-time download prompt. SHA matches the binary uploaded to the
    // runtime-deps prerelease; bump both to ship a newer yt-dlp.
    Dep {
        name: "yt-dlp.exe",
        url: "https://github.com/rm-sage/Aura/releases/download/runtime-deps/yt-dlp.exe",
        sha256: "3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27",
    },
];

/// Resolved runtime directory, set once at startup by [`init`].
static RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Compute + cache `<app_local_data>/runtime` and make sure it exists. Call once
/// in setup. Idempotent. On failure the on-demand path is simply unavailable and
/// the resolvers fall back to their bundle/PATH candidates.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    if RUNTIME_DIR.get().is_some() {
        return;
    }
    let Ok(base) = app.path().app_local_data_dir() else {
        crate::devlog!(warn, "runtime", "no app_local_data_dir — on-demand binaries unavailable");
        return;
    };
    let dir = base.join("runtime");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        crate::devlog!(warn, "runtime", "could not create {}: {e}", dir.display());
        return;
    }
    let _ = RUNTIME_DIR.set(dir);
}

/// The runtime directory, if [`init`] has run.
pub fn dir() -> Option<PathBuf> {
    RUNTIME_DIR.get().cloned()
}

/// Path to a previously-downloaded binary in the runtime dir, if it exists.
/// Used as the first candidate by the feature resolvers. Existence-only (cheap);
/// integrity is enforced by [`ensure_runtime_dep`] before the feature runs.
pub fn resolved_path(name: &str) -> Option<PathBuf> {
    let p = dir()?.join(name);
    p.is_file().then_some(p)
}

fn dep_for(name: &str) -> Option<&'static Dep> {
    DEPS.iter().find(|d| d.name == name)
}

/// Streamed hex SHA-256 so a 200 MB binary isn't slurped into memory.
fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Cheap presence check (no hashing) — true when the binary is on disk in the
/// runtime dir. The frontend uses it to decide whether to offer/trigger a
/// download before invoking an optional feature.
#[tauri::command]
pub fn runtime_dep_present(name: String) -> bool {
    resolved_path(&name).is_some()
}

/// Ensure a runtime binary is downloaded + verified, returning its absolute
/// path. No-op when a correct copy already exists. Otherwise streams the asset
/// down (emitting `runtime-dep-progress` events `{name, downloaded, total,
/// done}`), verifies the SHA-256, and atomically moves it into place. A hash
/// mismatch (stale/corrupt) forces a fresh download.
#[tauri::command]
pub async fn ensure_runtime_dep<R: Runtime>(
    app: AppHandle<R>,
    name: String,
) -> Result<String, String> {
    let dep = dep_for(&name).ok_or_else(|| format!("unknown runtime dep: {name}"))?;
    let dir = dir().ok_or_else(|| "runtime dir unavailable".to_string())?;
    let target = dir.join(dep.name);

    // Already present + correct → done (no network).
    if target.is_file() {
        match sha256_file(&target) {
            Ok(h) if h.eq_ignore_ascii_case(dep.sha256) => {
                return Ok(target.to_string_lossy().into_owned());
            }
            Ok(_) => crate::devlog!(
                warn, "runtime", "{} present but hash mismatch — re-downloading", dep.name
            ),
            Err(e) => crate::devlog!(
                warn, "runtime", "{} present but unreadable ({e}) — re-downloading", dep.name
            ),
        }
    }

    crate::devlog!(info, "runtime", "downloading {} from {}", dep.name, dep.url);
    let mut resp = reqwest::Client::new()
        .get(dep.url)
        .send()
        .await
        .map_err(|e| format!("download {}: {e}", dep.name))?;
    if !resp.status().is_success() {
        return Err(format!("download {}: HTTP {}", dep.name, resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);

    // Stream to a `.part` sibling so an interrupted download never looks
    // complete; only verify + atomic-rename on success.
    let part = dir.join(format!("{}.part", dep.name));
    let mut file = std::fs::File::create(&part)
        .map_err(|e| format!("create {}: {e}", part.display()))?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    {
        use std::io::Write;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("read {}: {e}", dep.name))?
        {
            file.write_all(&chunk).map_err(|e| format!("write {}: {e}", part.display()))?;
            downloaded += chunk.len() as u64;
            // Throttle progress to ~every 2 MB so the event channel isn't spammed.
            if downloaded - last_emit >= 2 * 1024 * 1024 {
                last_emit = downloaded;
                let _ = app.emit(
                    "runtime-dep-progress",
                    serde_json::json!({ "name": dep.name, "downloaded": downloaded, "total": total }),
                );
            }
        }
        file.flush().map_err(|e| format!("flush {}: {e}", part.display()))?;
    }
    drop(file);

    // Verify before trusting it — these run as native code / are exec'd.
    let got = sha256_file(&part).map_err(|e| format!("hash {}: {e}", dep.name))?;
    if !got.eq_ignore_ascii_case(dep.sha256) {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "{} checksum mismatch (expected {}, got {})",
            dep.name, dep.sha256, got
        ));
    }

    // Replace any existing target with the freshly-verified file.
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&part, &target).map_err(|e| format!("install {}: {e}", dep.name))?;
    let _ = app.emit(
        "runtime-dep-progress",
        serde_json::json!({ "name": dep.name, "downloaded": downloaded, "total": total, "done": true }),
    );
    crate::devlog!(info, "runtime", "installed {} ({} bytes)", dep.name, downloaded);
    Ok(target.to_string_lossy().into_owned())
}
