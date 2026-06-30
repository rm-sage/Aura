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

use std::cmp::Ordering;
use std::sync::Arc;

use serde::Serialize;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

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
    // On-demand download dir (survives updates) — checked before the bundled
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
pub(crate) fn ffmpeg_command(app: &tauri::AppHandle) -> Command {
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

/// Inferred OP / title-sequence window (absolute stream seconds).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct OpWindow {
    pub start: f64,
    pub end:   f64,
}

#[derive(Debug, Serialize)]
pub struct SilenceDetectResult {
    /// True when ffmpeg (bundled or PATH) was found and produced
    /// parseable output. False = ffmpeg missing, the url was rejected,
    /// or an invocation error; `intervals` will be empty in that case.
    pub available: bool,
    pub intervals: Vec<SilenceInterval>,
    /// The inferred OP / title-sequence window when one surfaced. The
    /// caller stamps this directly as a prompt-only (auto:false) skip
    /// window; `None` means no OP-shaped block was found in the scan.
    pub op_window: Option<OpWindow>,
    /// Free-form note explaining a failure mode (when available=false)
    /// or the analysis window (when available=true). Surfaced to the
    /// DevConsole, not user-facing.
    pub note:      String,
}

/// Infer the OP / title-sequence window from a set of silence intervals.
///
/// Model: an OP / title sequence is a CONTINUOUS-audio block (music /
/// titles, no internal silence) bracketed by clear silences — the hard
/// cuts into and out of it — sitting either at the very start of the
/// episode (a cold-open-less anime OP) or after a cold open (a live-
/// action title card that lands several minutes in). A dialogue scene
/// gets fragmented into sub-OP-length blocks by its own pauses, so it
/// rarely masquerades as one continuous OP-length block.
///
/// Ranking: every OP-length block is scored by the STRENGTH of the
/// silences bracketing it — `min(leadSilence, trailSilence)` in seconds.
/// A real OP / title sequence is cut in AND out cleanly (both edges a
/// solid ~1 s drop), whereas a cold-open scene whose music merely fades
/// down into a brief lull is bracketed by a weak dip on at least one side
/// and so scores lower. We pick the HIGHEST-scoring block, NOT simply the
/// earliest — that earliest-wins rule was the bug where The Punisher
/// S01E11's cold open (a ~98 s music bed ending in a soft dip) out-ranked
/// the real 2:29 title card purely by coming first.
///
/// The leading block `[0, firstCut]` has no silence before it; the file
/// start is credited as a clean boundary (capped at `FIRST_CREDIT`) so a
/// genuine cold-open-less anime OP isn't penalised, while a strongly
/// bracketed INNER block (a title card after a cold open) can still
/// out-score it. Returns the best `(window, score)`, or `None` when no
/// OP-length block exists — or, with `min_score` set, when none clears
/// that bar (used to gate the parallel scan's confident early-exit).
fn infer_op_window(intervals: &[SilenceInterval], min_score: Option<f64>) -> Option<(OpWindow, f64)> {
    const BRACKET_MIN: f64 = 0.8;  // a real scene cut, not a micro dialogue gap
    const OP_MIN: f64 = 40.0;      // shorter blocks are transitions, not an OP
    const OP_MAX: f64 = 105.0;     // a real OP is ~90 s; longer = a scene / cold open
    const TARGET_LEN: f64 = 85.0;  // typical OP length, used only as the tie-break
    const MAX_START: f64 = 420.0;  // title sequences ~never begin past 7 min
    const FIRST_CREDIT: f64 = 1.0; // file-start counts as a clean (capped) boundary

    let mut bounds: Vec<&SilenceInterval> =
        intervals.iter().filter(|s| s.duration >= BRACKET_MIN).collect();
    bounds.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(Ordering::Equal));
    if bounds.is_empty() {
        return None;
    }

    // Candidate blocks as (start, end, leadSilence, trailSilence): the
    // leading [0, first] block, then every span between consecutive
    // bracket-silences. A block with no internal bracket-silence is a
    // continuous-audio span; an OP is one of OP-plausible length.
    let mut cands: Vec<(f64, f64, f64, f64)> = Vec::new();
    cands.push((0.0, bounds[0].start, FIRST_CREDIT, bounds[0].duration));
    for w in bounds.windows(2) {
        cands.push((w[0].end, w[1].start, w[0].duration, w[1].duration));
    }

    let mut best: Option<(OpWindow, f64)> = None;
    for (l, r, lead, trail) in cands {
        let len = r - l;
        if len < OP_MIN || len > OP_MAX || l > MAX_START {
            continue;
        }
        let score = lead.min(trail);
        let take = match &best {
            None => true,
            Some((w, s)) => {
                if score > s + 1e-6 {
                    true
                } else if (score - s).abs() <= 1e-6 {
                    // Tie on bracket strength → prefer the block whose length is
                    // closest to a typical OP (~TARGET_LEN). This replaces the
                    // old earliest-wins tie-break, which let a cold-open block
                    // win purely by coming first.
                    ((r - l) - TARGET_LEN).abs() < ((w.end - w.start) - TARGET_LEN).abs()
                } else {
                    false
                }
            }
        };
        if take {
            best = Some((OpWindow { start: l.max(0.0), end: r }, score));
        }
    }

    match (&best, min_score) {
        (Some((_, s)), Some(m)) if *s < m => None,
        _ => best,
    }
}

/// Scan ONE `[start_secs, start_secs + len_secs]` slice of the stream for
/// silence intervals, returning ABSOLUTE-timestamp intervals. `-ss` seeks
/// to the slice start and `-copyts` keeps the input PTS so the parsed
/// silence_start/end stay absolute (NOT slice-relative) — the OP
/// inference places windows on the real timeline. `-t` then bounds the
/// slice to `len_secs` of OUTPUT (proven by `detect_outro_boundary`'s
/// `-sseof -copyts -t` tail scan, which reports true absolute PTS).
/// Audio-only (`-vn`), so a fan-out of these is light on CPU — the
/// per-chunk cost is mostly the byte-range download. ffmpeg is killed on
/// drop, so an aborted task (early-exit) tears its process down at once.
async fn scan_silence_chunk(
    app: &tauri::AppHandle,
    url: &str,
    start_secs: f64,
    len_secs: f64,
) -> Vec<SilenceInterval> {
    let mut cmd = ffmpeg_command(app);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-protocol_whitelist").arg("http,https,tcp,tls,crypto");
    // Chunk 0 starts at the head, so no seek is needed; its timestamps are
    // already absolute. Later chunks seek + keep PTS.
    if start_secs > 0.0 {
        cmd.arg("-ss").arg(format!("{start_secs:.3}")).arg("-copyts");
    }
    cmd.arg("-i").arg(url)
        .arg("-vn")
        .arg("-af").arg("silencedetect=n=-30dB:d=0.5")
        .arg("-t").arg(format!("{len_secs:.3}"))
        .arg("-f").arg("null")
        .arg("-")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            crate::devlog!(warn, "silence", "chunk spawn failed @ {start_secs:.0}s: {e}");
            return vec![];
        }
    };
    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => return vec![],
    };
    let mut reader = BufReader::new(stderr).lines();
    let mut intervals: Vec<SilenceInterval> = Vec::new();
    let mut current_start: Option<f64> = None;

    let parse = async {
        while let Ok(Some(line)) = reader.next_line().await {
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

    // Per-chunk cap: a single ~150 s slice should never take minutes.
    let _ = tokio::time::timeout(Duration::from_secs(180), parse).await;
    let _ = child.kill().await;
    let _ = child.wait().await;
    intervals
}

/// Probe a stream for its OP / title-sequence window (and the raw silence
/// intervals) via a PARALLEL, early-exit silencedetect scan.
///
/// `url` is the direct stream URL (HTTPS). `max_secs` is the front window
/// to search (0 → default 600 s / 10 min — generous so a late live-action
/// title card 5-6 min in is reached). The window is split into overlapping
/// ~150 s chunks scanned by a bounded fan-out of audio-only ffmpeg passes,
/// so wall-clock is roughly one chunk instead of the whole window. As soon
/// as a confident "classic" anime OP surfaces in the fully-scanned prefix
/// the remaining chunks are aborted (their ffmpeg killed on drop); a title
/// card with no classic shape falls back to a generic block pick once the
/// window is covered.
///
/// Returns `available=false` immediately when no ffmpeg is resolvable or
/// when `url` is not http(s).
#[tauri::command]
pub async fn detect_silence_intervals(
    app: tauri::AppHandle,
    url: String,
    max_secs: u32,
) -> Result<SilenceDetectResult, String> {
    crate::devlog!(
        info, "silence",
        "detect_silence_intervals (parallel OP scan) max_secs={max_secs} url={}",
        url.chars().take(80).collect::<String>(),
    );

    // Security guard: only remote http(s) streams (what mpv already
    // plays) — reject local paths / ffmpeg pseudo-protocols at source.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        crate::devlog!(warn, "silence", "rejected non-http(s) url");
        return Ok(SilenceDetectResult {
            available: false,
            intervals: vec![],
            op_window: None,
            note: "non-http(s) url rejected".to_string(),
        });
    }

    // Probe ffmpeg presence first so the caller sees a clean "not
    // available" instead of a generic spawn error.
    if !ffmpeg_is_available(&app).await {
        return Ok(SilenceDetectResult {
            available: false,
            intervals: vec![],
            op_window: None,
            note: "ffmpeg unavailable (no bundled lib/ffmpeg.exe, none on PATH)".to_string(),
        });
    }

    // Window + chunking. Each chunk overlaps a few seconds into the next so
    // a silence straddling a chunk boundary is still caught whole by the
    // earlier chunk.
    //
    // MAX_PARALLEL bounds the concurrent ffmpeg passes — keep it SMALL.
    // Even though each pass is `-vn` (audio-only OUTPUT), ffmpeg still
    // DOWNLOADS the full muxed container for its slice to demux the audio,
    // at uncapped speed — so every chunk is a full-bandwidth range pull on
    // the SAME debrid link the player is already streaming. At 2 the worst
    // case is 2 scan pulls + playback; going higher risks saturating a
    // bandwidth-limited link or tripping a debrid per-link connection cap
    // (403/503 / throttled playback → a mid-playback rebuffer). The deep
    // demuxer cache (cache-secs=180) absorbs a brief hit and early-exit
    // keeps the pulls short. With abundant bandwidth you can raise this for
    // a faster scan (or instead bound each pass's burst with an ffmpeg
    // `-readrate` cap, version permitting).
    const CHUNK: f64 = 150.0;
    const OVERLAP: f64 = 4.0;
    const MAX_PARALLEL: usize = 2;
    let window = if max_secs == 0 { 600.0 } else { max_secs as f64 };
    let n_chunks = ((window / CHUNK).ceil() as usize).max(1);

    let sem = Arc::new(Semaphore::new(MAX_PARALLEL));
    let mut set: JoinSet<(usize, Vec<SilenceInterval>)> = JoinSet::new();
    for i in 0..n_chunks {
        let start = i as f64 * CHUNK;
        let len = CHUNK + OVERLAP;
        let app2 = app.clone();
        let url2 = url.clone();
        let sem2 = sem.clone();
        set.spawn(async move {
            // The permit gates how many chunks run at once; aborting the
            // task (early-exit) drops the permit and the ffmpeg child.
            let _permit = sem2.acquire_owned().await.ok();
            (i, scan_silence_chunk(&app2, &url2, start, len).await)
        });
    }

    let mut results: Vec<Option<Vec<SilenceInterval>>> = vec![None; n_chunks];
    let mut prefix_done: isize = -1;
    let mut found: Option<(OpWindow, f64)> = None;
    let mut early = false;

    while let Some(res) = set.join_next().await {
        let (idx, iv) = match res {
            Ok(v) => v,
            Err(_) => continue, // aborted / panicked task — ignore
        };
        results[idx] = Some(iv);
        // Advance the contiguous completed prefix (chunks 0..=prefix_done
        // all done) — early-exit needs a gapless front so it can't miss an
        // OP that lives in a not-yet-finished earlier chunk.
        while ((prefix_done + 1) as usize) < n_chunks
            && results[(prefix_done + 1) as usize].is_some()
        {
            prefix_done += 1;
        }
        if prefix_done >= 0 {
            let scanned_to = ((prefix_done as f64) + 1.0) * CHUNK;
            let prefix: Vec<SilenceInterval> = results[..=(prefix_done as usize)]
                .iter()
                .flatten()
                .flatten()
                .cloned()
                .collect();
            // Early-exit is ONLY the cold-open-less fast path: a confident
            // OP that sits essentially at t≈0 (anime), already covered by a
            // settle margin. The NEAR_START cap is the crucial guard — a
            // confident block that starts minutes in (a live-action title
            // card after a cold open, OR a cleanly-cut cold open itself)
            // must NOT short-circuit, or it could commit before the real
            // later title card is even scanned. Those fall through to the
            // full-window ranking below, where every block competes.
            const CONF: f64 = 1.0;
            const SETTLE: f64 = 45.0;
            // ONLY a true cold-open-less OP (anime, essentially at t≈0) may
            // short-circuit the scan. A block starting even a few seconds in is
            // ambiguous — it could be a live-action COLD OPEN that merely looks
            // OP-shaped (clean brackets, OP-ish length), which is exactly how
            // The Punisher S01E11 / S01E13 cold opens kept winning the
            // early-exit. Those must fall through to the full-window ranking;
            // ~3 s only tolerates a hard cut right at the head, not a prologue.
            const NEAR_START: f64 = 3.0;
            if let Some((op, score)) = infer_op_window(&prefix, Some(CONF)) {
                if op.start <= NEAR_START && op.end <= scanned_to - SETTLE {
                    found = Some((op, score));
                    early = true;
                    break;
                }
            }
        }
    }

    // Abort any still-running / queued chunks; kill_on_drop tears down the
    // ffmpeg processes and shutdown awaits them so they don't outlive us.
    set.shutdown().await;

    // Assemble every interval collected (sorted; light dedup of the near-
    // duplicates the chunk overlaps produce at boundaries).
    let mut all: Vec<SilenceInterval> =
        results.into_iter().flatten().flatten().collect();
    all.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(Ordering::Equal));
    all.dedup_by(|a, b| (a.start - b.start).abs() < 0.3 && (a.end - b.end).abs() < 0.3);

    // Confident early-exit pick wins; otherwise rank every block scanned.
    // The full-scan pick must clear FINAL_MIN — clean ~1 s silences on BOTH
    // sides. We would rather return NO window (no skip prompt) than a
    // weakly-bracketed guess that skips real content: precision over recall.
    const FINAL_MIN: f64 = 1.0;
    let best = found.or_else(|| infer_op_window(&all, Some(FINAL_MIN)));
    let note = match &best {
        Some((op, score)) => format!(
            "{} chunk(s){}, {} silence(s) → OP {:.0}-{:.0}s (score {:.2})",
            n_chunks,
            if early { ", early-exit" } else { "" },
            all.len(),
            op.start,
            op.end,
            score,
        ),
        None => format!(
            "{} chunk(s), {} silence(s), no OP-shaped block",
            n_chunks,
            all.len(),
        ),
    };
    crate::devlog!(info, "silence", "{note}");
    let op_window = best.map(|(w, _)| w);

    Ok(SilenceDetectResult {
        available: true,
        intervals: all,
        op_window,
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
