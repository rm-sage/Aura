// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// silencedetect.rs ─────────────────────────────────────────────────────────
//
// The ffmpeg resolver shared by every on-device ffmpeg user: the layered skip
// detector (`skipdetect/`), hover thumbnails (`thumbs.rs`) and anything else
// that spawns the bundled / downloaded / PATH ffmpeg.
//
// It used to also hold Aura's first automatic skip detectors: a chunked
// silencedetect OP scan (`detect_silence_intervals` + `infer_op_window`) and
// a blackdetect / silencedetect outro tail scan (`detect_outro_boundary`).
// Both are RETIRED, replaced by `skipdetect/` (AnimeThemes theme match plus
// loudness continuity). Measured on a 31-episode frame-verified corpus, the
// old OP scan was 10 correct / 7 wrong / 2 false positives and the old ED scan
// was 0 correct, skipping the after-credits scene on 10 of the 11 episodes
// that have one. Their commands are gone from all three registration sites.
// Do not bring back an ED window that ends at the container duration.
//
// The module keeps its name so the resolver's callers stay put.
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::process::Stdio;

use tauri::Manager;
use tokio::process::Command;

/// Resolve the ffmpeg binary. Prefers a BUNDLED `lib/ffmpeg.exe`
/// (shipped via the existing `resources: ["lib/**/*"]` glob - drop the
/// binary into `src-tauri/lib/` exactly like the git-ignored libmpv
/// DLLs and the installer picks it up), so the user doesn't need ffmpeg
/// on PATH. Candidate order, first existing wins:
///   1. `AURA_FFMPEG` env override (power users / CI).
///   2. `<resource_dir>/lib/ffmpeg.exe`         - bundled / installed.
///   3. `<exe_dir>/lib/ffmpeg.exe`              - portable layout.
///   4. `<CARGO_MANIFEST_DIR>/lib/ffmpeg.exe`   - `tauri dev` (points
///      at `src-tauri/`; the dev binary lives in target/ so a relative
///      path wouldn't resolve).
/// Falls back to the bare name `ffmpeg` (PATH) so a system install
/// still works and nothing regresses for users who never add the
/// bundled binary.
pub(crate) fn ffmpeg_bin(app: &tauri::AppHandle) -> std::ffi::OsString {
    const NAME: &str = "ffmpeg.exe";

    if let Ok(p) = std::env::var("AURA_FFMPEG") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return pb.into_os_string();
        }
    }
    // On-demand download dir (survives updates) - checked before the bundled
    // candidates so a fetched copy wins, but after the explicit env override.
    if let Some(p) = crate::runtime_deps::resolved_path(NAME) {
        crate::devlog!(info, "silence", "using downloaded ffmpeg: {}", p.display());
        return p.into_os_string();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("lib").join(NAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("lib").join(NAME));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib").join(NAME));

    for c in candidates {
        if c.is_file() {
            crate::devlog!(info, "silence", "using bundled ffmpeg: {}", c.display());
            return c.into_os_string();
        }
    }
    // PATH fallback - unchanged behaviour for system-ffmpeg users.
    std::ffi::OsString::from("ffmpeg")
}

/// Build an ffmpeg [`Command`] with its console window suppressed.
///
/// Aura is a GUI app with no console of its own. Without `CREATE_NO_WINDOW`,
/// every ffmpeg spawn pops a visible console window for the lifetime of the
/// process - a few seconds on each stream start, which looks alarming (and
/// outright suspicious) to users. Every ffmpeg invocation in this module
/// goes through here so the flag can't be forgotten at a call site. This
/// mirrors the bridge subprocess spawn in `lib.rs`.
pub(crate) fn ffmpeg_command(app: &tauri::AppHandle) -> Command {
    ffmpeg_command_at(&ffmpeg_bin(app))
}

/// [`ffmpeg_command`] for an already-resolved binary (skipdetect resolves it
/// once per detect and spawns several passes from it).
pub(crate) fn ffmpeg_command_at(bin: &std::ffi::OsStr) -> Command {
    let mut cmd = Command::new(bin);
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW = 0x08000000. tokio's Command exposes
        // `creation_flags` directly on Windows (forwards to the inner
        // std Command), so no `CommandExt` import is needed.
        cmd.creation_flags(0x08000000);
    }
    cmd
}

pub(crate) async fn ffmpeg_is_available(app: &tauri::AppHandle) -> bool {
    // `ffmpeg -version` exits 0 when the resolved binary (bundled or
    // PATH) is present + executable. We don't care about the version.
    let res = ffmpeg_command(app)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    matches!(res, Ok(s) if s.success())
}
