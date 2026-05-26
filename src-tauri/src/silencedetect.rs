// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// silencedetect.rs ─────────────────────────────────────────────────────────
//
// Manual fallback for the anime-skip pipeline: when AniSkip has no data
// AND no chapter markers were detected, the user can invoke this to
// probe the stream's audio for silence breaks. Anime openings typically
// end with a clear silence gap before dialogue resumes — silencedetect
// surfaces those boundaries.
//
// Implementation: shell out to ffmpeg (`-af silencedetect`), parse the
// stderr stream for `silence_start` / `silence_end` lines, return the
// intervals as floats. Does NOT do heuristic OP-window classification
// — that's left to the caller. The intent is "raw silences, you decide".
//
// Graceful degradation: if no ffmpeg is resolvable (neither the bundled
// `lib/ffmpeg.exe` nor one on PATH), we return an empty list with a
// clear `available=false` flag rather than erroring out — best-effort
// by design.
//
// Security: these detectors run UNATTENDED (auto-fallback from the skip
// pipeline, not only on an explicit user action), so the input is
// constrained to remote http(s) streams — the same URLs mpv already
// plays — via a scheme guard plus an ffmpeg `-protocol_whitelist`. That
// closes local-path / `concat:` / `subfile:` and similar pseudo-protocol
// reads that ffmpeg would otherwise honour on `-i`.
// ---------------------------------------------------------------------------

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Resolve the ffmpeg binary. Prefers a BUNDLED `lib/ffmpeg.exe`
/// (shipped via the existing `resources: ["lib/**/*"]` glob — drop the
/// binary into `src-tauri/lib/` exactly like the git-ignored libmpv
/// DLLs and the installer picks it up), so the user doesn't need ffmpeg
/// on PATH. Candidate order, first existing wins:
///   1. `AURA_FFMPEG` env override (power users / CI).
///   2. `<resource_dir>/lib/ffmpeg.exe`         — bundled / installed.
///   3. `<exe_dir>/lib/ffmpeg.exe`              — portable layout.
///   4. `<CARGO_MANIFEST_DIR>/lib/ffmpeg.exe`   — `tauri dev` (points
///      at `src-tauri/`; the dev binary lives in target/ so a relative
///      path wouldn't resolve).
/// Falls back to the bare name `ffmpeg` (PATH) so a system install
/// still works and nothing regresses for users who never add the
/// bundled binary.
fn ffmpeg_bin(app: &tauri::AppHandle) -> std::ffi::OsString {
    const NAME: &str = "ffmpeg.exe";

    if let Ok(p) = std::env::var("AURA_FFMPEG") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return pb.into_os_string();
        }
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
    // PATH fallback — unchanged behaviour for system-ffmpeg users.
    std::ffi::OsString::from("ffmpeg")
}

/// Build an ffmpeg [`Command`] with its console window suppressed.
///
/// Aura is a GUI app with no console of its own. Without `CREATE_NO_WINDOW`,
/// every ffmpeg spawn pops a visible console window for the lifetime of the
/// process — a few seconds on each stream start, which looks alarming (and
/// outright suspicious) to users. Every ffmpeg invocation in this module
/// goes through here so the flag can't be forgotten at a call site. This
/// mirrors the bridge subprocess spawn in `lib.rs`.
fn ffmpeg_command(app: &tauri::AppHandle) -> Command {
    let mut cmd = Command::new(ffmpeg_bin(app));
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW = 0x08000000. tokio's Command exposes
        // `creation_flags` directly on Windows (forwards to the inner
        // std Command), so no `CommandExt` import is needed.
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// One silence interval reported by ffmpeg, in seconds.
#[derive(Debug, Clone, Serialize)]
pub struct SilenceInterval {
    pub start:    f64,
    pub end:      f64,
    /// `end - start`. Pre-computed because the React caller filters by
    /// duration first (only silences ≥1 s are interesting for OP
    /// boundary detection).
    pub duration: f64,
}

#[derive(Debug, Serialize)]
pub struct SilenceDetectResult {
    /// True when ffmpeg (bundled or PATH) was found and produced
    /// parseable output. False = ffmpeg missing, the url was rejected,
    /// or an invocation error; `intervals` will be empty in that case.
    pub available: bool,
    pub intervals: Vec<SilenceInterval>,
    /// Free-form note explaining a failure mode (when available=false)
    /// or the analysis window (when available=true). Surfaced to the
    /// DevConsole, not user-facing.
    pub note:      String,
}

/// Probe ffmpeg's silencedetect filter for silence intervals in a
/// stream. `url` is the direct stream URL (HTTPS or local path).
/// `max_secs` caps the analysis duration via ffmpeg's `-t` flag —
/// pass 0 to scan the whole file (slow on large remuxes).
///
/// Threshold: -30 dB, minimum silence duration: 0.5 s. Typical anime
/// OPs end in a clear musical-to-dialogue silence break of ~1-2 s.
///
/// Returns `available=false` immediately when no ffmpeg is resolvable
/// (neither bundled nor on PATH) or when `url` is not http(s); callers
/// should surface a "ffmpeg not installed" hint to the user in that case.
#[tauri::command]
pub async fn detect_silence_intervals(
    app: tauri::AppHandle,
    url: String,
    max_secs: u32,
) -> Result<SilenceDetectResult, String> {
    crate::devlog!(
        info, "silence",
        "detect_silence_intervals max_secs={max_secs} url={}",
        url.chars().take(80).collect::<String>(),
    );

    // Security guard: only remote http(s) streams (what mpv already
    // plays) — reject local paths / ffmpeg pseudo-protocols at source.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        crate::devlog!(warn, "silence", "rejected non-http(s) url");
        return Ok(SilenceDetectResult {
            available: false,
            intervals: vec![],
            note: "non-http(s) url rejected".to_string(),
        });
    }

    // Probe ffmpeg presence first so the caller sees a clean "not
    // available" instead of a generic spawn error.
    if !ffmpeg_is_available(&app).await {
        return Ok(SilenceDetectResult {
            available: false,
            intervals: vec![],
            note: "ffmpeg unavailable (no bundled lib/ffmpeg.exe, none on PATH)".to_string(),
        });
    }

    // Build args. We discard video (`-vn`), apply silencedetect to
    // audio, write nothing (`-f null -`). Bound the runtime via -t
    // when caller asked for it.
    let mut cmd = ffmpeg_command(&app);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-protocol_whitelist").arg("http,https,tcp,tls,crypto")
        .arg("-i").arg(&url)
        .arg("-vn")
        .arg("-af").arg("silencedetect=n=-30dB:d=0.5")
        .arg("-f").arg("null");
    if max_secs > 0 {
        cmd.arg("-t").arg(max_secs.to_string());
    }
    cmd.arg("-")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            crate::devlog!(warn, "silence", "spawn failed: {e}");
            return Ok(SilenceDetectResult {
                available: false,
                intervals: vec![],
                note: format!("ffmpeg spawn failed: {e}"),
            });
        }
    };

    // Read stderr line-by-line; silencedetect emits one line per event.
    // Cap total run time to a generous 5 minutes so a frozen ffmpeg
    // doesn't hang the command — kill_on_drop handles the actual
    // process termination.
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None    => return Err("could not capture ffmpeg stderr".to_string()),
    };
    let mut reader = BufReader::new(stderr).lines();

    let mut intervals: Vec<SilenceInterval> = Vec::new();
    let mut current_start: Option<f64> = None;

    let parse = async {
        while let Ok(Some(line)) = reader.next_line().await {
            // Lines look like:
            //   [silencedetect @ 0xbeef] silence_start: 12.345
            //   [silencedetect @ 0xbeef] silence_end: 18.901 | silence_duration: 6.556
            if let Some(rest) = line.split("silence_start:").nth(1) {
                if let Some(token) = rest.split_whitespace().next() {
                    if let Ok(s) = token.parse::<f64>() { current_start = Some(s); }
                }
            } else if let Some(rest) = line.split("silence_end:").nth(1) {
                if let Some(token) = rest.split_whitespace().next() {
                    if let Ok(end) = token.parse::<f64>() {
                        if let Some(start) = current_start.take() {
                            intervals.push(SilenceInterval {
                                start,
                                end,
                                duration: (end - start).max(0.0),
                            });
                        }
                    }
                }
            }
        }
    };

    let timed = tokio::time::timeout(Duration::from_secs(300), parse).await;
    if timed.is_err() {
        crate::devlog!(warn, "silence", "ffmpeg readline timed out — killing");
        let _ = child.kill().await;
    }

    let _ = child.wait().await;

    let note = if max_secs > 0 {
        format!("scanned first {max_secs}s, found {} interval(s)", intervals.len())
    } else {
        format!("scanned whole stream, found {} interval(s)", intervals.len())
    };
    crate::devlog!(info, "silence", "{note}");

    Ok(SilenceDetectResult {
        available: true,
        intervals,
        note,
    })
}

/// Result of the outro/ED boundary tail-scan.
#[derive(Debug, Serialize)]
pub struct OutroBoundaryResult {
    pub available: bool,
    /// Absolute timestamp (seconds, stream PTS) where the ED / credits
    /// most likely begin, or null when no confident boundary was found.
    pub ed_start:  Option<f64>,
    pub note:      String,
}

/// Hybrid-mode ED detection (the bounded, low-risk slice — NO 90× scan).
///
/// Scans only the LAST `tail_secs` of the stream with a SINGLE ffmpeg
/// pass running `blackdetect` (downscaled, cheap) + `silencedetect`
/// together. Credits/ED almost always begin with a hard scene→black
/// cut and/or a music/dialogue→silence transition; the EARLIEST such
/// significant boundary inside the tail (excluding the seek-in artifact
/// and the final fade-to-black at EOF) is the ED start.
///
/// This does NOT stamp a skip window (no reliable end without the
/// container duration) — its job is to hand the desktop an ED-start so
/// the Next-Up CTA fires at the right moment for live-action / any
/// series AniSkip + chapters don't cover. ffmpeg-on-PATH best-effort,
/// same graceful `available=false` contract as `detect_silence_intervals`.
#[tauri::command]
pub async fn detect_outro_boundary(
    app: tauri::AppHandle,
    url: String,
    tail_secs: u32,
) -> Result<OutroBoundaryResult, String> {
    let tail = if tail_secs == 0 { 300 } else { tail_secs.min(900) };
    crate::devlog!(
        info, "silence",
        "detect_outro_boundary tail={tail}s url={}",
        url.chars().take(80).collect::<String>(),
    );

    // Security guard: only remote http(s) streams (what mpv already
    // plays) — reject local paths / ffmpeg pseudo-protocols at source.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        crate::devlog!(warn, "silence", "outro: rejected non-http(s) url");
        return Ok(OutroBoundaryResult {
            available: false,
            ed_start:  None,
            note:      "non-http(s) url rejected".to_string(),
        });
    }

    if !ffmpeg_is_available(&app).await {
        return Ok(OutroBoundaryResult {
            available: false,
            ed_start:  None,
            note:      "ffmpeg unavailable (no bundled lib/ffmpeg.exe, none on PATH)".to_string(),
        });
    }

    // `-sseof -tail` seeks to (duration - tail). `-copyts` MUST follow
    // it: without it ffmpeg rebases the output timeline to ~0, so the
    // silencedetect/blackdetect PTS would be tail-RELATIVE (0..tail).
    // The parser below assumes ABSOLUTE container PTS (the ts_min/ts_max
    // artifact-trim and the dispatched `ed_start`), so tail-relative
    // values produced a bogus early ED — a 1420 s episode reported
    // "ED≈46 s" (~1090 s too early), which made the Next-Up card fire at
    // the episode midpoint. `-copyts` keeps input timestamps intact so
    // `ed_start` is a true absolute container timestamp. Downscale before
    // blackdetect so the tail video decode is cheap; `-t` bounds the
    // worst case.
    let mut cmd = ffmpeg_command(&app);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-protocol_whitelist").arg("http,https,tcp,tls,crypto")
        .arg("-sseof").arg(format!("-{tail}"))
        .arg("-copyts")
        .arg("-i").arg(&url)
        .arg("-vf").arg("scale=160:-2,blackdetect=d=0.30:pic_th=0.98")
        .arg("-af").arg("silencedetect=n=-30dB:d=0.5")
        .arg("-t").arg((tail + 30).to_string())
        .arg("-f").arg("null")
        .arg("-")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            crate::devlog!(warn, "silence", "outro spawn failed: {e}");
            return Ok(OutroBoundaryResult {
                available: false,
                ed_start:  None,
                note:      format!("ffmpeg spawn failed: {e}"),
            });
        }
    };

    let stderr = match child.stderr.take() {
        Some(s) => s,
        None    => return Err("could not capture ffmpeg stderr".to_string()),
    };
    let mut reader = BufReader::new(stderr).lines();

    // (start, kind) — kind: true=black, false=long-silence. We also
    // track the scanned PTS range to drop the seek-in artifact and the
    // final EOF fade without needing the container duration.
    let mut blacks: Vec<f64> = Vec::new();   // black_start where black_duration ≥ 0.30
    let mut sils:   Vec<f64> = Vec::new();   // silence_start where silence ≥ 1.5 s
    let mut sil_start: Option<f64> = None;
    let mut black_start: Option<f64> = None;
    let mut ts_min = f64::INFINITY;
    let mut ts_max = f64::NEG_INFINITY;

    let parse = async {
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.split("black_start:").nth(1) {
                if let Some(tok) = rest.split_whitespace().next() {
                    if let Ok(s) = tok.parse::<f64>() {
                        black_start = Some(s);
                        ts_min = ts_min.min(s);
                        ts_max = ts_max.max(s);
                    }
                }
            } else if let Some(rest) = line.split("black_end:").nth(1) {
                if let Some(tok) = rest.split_whitespace().next() {
                    if let Ok(e) = tok.parse::<f64>() {
                        ts_max = ts_max.max(e);
                        if let Some(bs) = black_start.take() {
                            if e - bs >= 0.30 { blacks.push(bs); }
                        }
                    }
                }
            } else if let Some(rest) = line.split("silence_start:").nth(1) {
                if let Some(tok) = rest.split_whitespace().next() {
                    if let Ok(s) = tok.parse::<f64>() {
                        sil_start = Some(s);
                        ts_min = ts_min.min(s);
                        ts_max = ts_max.max(s);
                    }
                }
            } else if let Some(rest) = line.split("silence_end:").nth(1) {
                if let Some(tok) = rest.split_whitespace().next() {
                    if let Ok(e) = tok.parse::<f64>() {
                        ts_max = ts_max.max(e);
                        if let Some(ss) = sil_start.take() {
                            if e - ss >= 1.5 { sils.push(ss); }
                        }
                    }
                }
            }
        }
    };

    let timed = tokio::time::timeout(Duration::from_secs(300), parse).await;
    if timed.is_err() {
        crate::devlog!(warn, "silence", "outro ffmpeg readline timed out — killing");
        let _ = child.kill().await;
    }
    let _ = child.wait().await;

    // Exclude the seek-in artifact (first ~2 s of the scan) and the
    // final fade-to-black at the very end (~last 8 s). The ED begins at
    // the EARLIEST qualifying boundary in between; a hard black cut is
    // a stronger credits signal than silence, so prefer it.
    let lo = if ts_min.is_finite() { ts_min + 2.0 } else { 0.0 };
    let hi = if ts_max.is_finite() { ts_max - 8.0 } else { f64::INFINITY };
    let in_window = |t: f64| t >= lo && t <= hi;

    let earliest_black = blacks.iter().copied().filter(|&t| in_window(t))
        .fold(f64::INFINITY, f64::min);
    let earliest_sil = sils.iter().copied().filter(|&t| in_window(t))
        .fold(f64::INFINITY, f64::min);

    let ed_start = if earliest_black.is_finite() {
        Some(earliest_black)
    } else if earliest_sil.is_finite() {
        Some(earliest_sil)
    } else {
        None
    };

    let note = match ed_start {
        Some(t) => format!(
            "tail {tail}s: {} black + {} silence boundary(s) → ED≈{:.1}s",
            blacks.len(), sils.len(), t,
        ),
        None => format!(
            "tail {tail}s: {} black + {} silence boundary(s), none qualified",
            blacks.len(), sils.len(),
        ),
    };
    crate::devlog!(info, "silence", "{note}");

    Ok(OutroBoundaryResult { available: true, ed_start, note })
}

async fn ffmpeg_is_available(app: &tauri::AppHandle) -> bool {
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
