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
// Graceful degradation: if ffmpeg isn't on PATH, we return an empty
// list with a clear `available=false` flag rather than erroring out.
// Aura doesn't bundle ffmpeg, so this feature is best-effort by design.
// ---------------------------------------------------------------------------

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

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
    /// True when ffmpeg was found on PATH and produced parseable output.
    /// False = ffmpeg missing or invocation error; `intervals` will be
    /// empty in that case.
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
/// Returns `available=false` immediately when ffmpeg is not on PATH;
/// callers should surface a "ffmpeg not installed" hint to the user
/// in that case.
#[tauri::command]
pub async fn detect_silence_intervals(
    url: String,
    max_secs: u32,
) -> Result<SilenceDetectResult, String> {
    crate::devlog!(
        info, "silence",
        "detect_silence_intervals max_secs={max_secs} url={}",
        url.chars().take(80).collect::<String>(),
    );

    // Probe ffmpeg presence first so the caller sees a clean "not
    // available" instead of a generic spawn error.
    if !ffmpeg_is_available().await {
        return Ok(SilenceDetectResult {
            available: false,
            intervals: vec![],
            note: "ffmpeg not found on PATH".to_string(),
        });
    }

    // Build args. We discard video (`-vn`), apply silencedetect to
    // audio, write nothing (`-f null -`). Bound the runtime via -t
    // when caller asked for it.
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-hide_banner")
        .arg("-nostdin")
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
                if let Some(token) = rest.trim().split_whitespace().next() {
                    if let Ok(s) = token.parse::<f64>() { current_start = Some(s); }
                }
            } else if let Some(rest) = line.split("silence_end:").nth(1) {
                if let Some(token) = rest.trim().split_whitespace().next() {
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

async fn ffmpeg_is_available() -> bool {
    // `ffmpeg -version` exits 0 when the binary is on PATH and
    // executable. We don't care about the version string itself.
    let res = Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    matches!(res, Ok(s) if s.success())
}
