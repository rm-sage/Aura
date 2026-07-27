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
/// inference places windows on the real timeline.
///
/// THE SLICE IS BOUNDED WITH `-to`, NOT `-t`. Under `-copyts` ffmpeg measures a
/// `-t` duration against the COPIED (absolute) timestamps, so `-t` silently
/// means `-to`: a chunk seeking to 600 s with `-t 300` asks ffmpeg to "stop once
/// the timestamp reaches 300", which is already in the past, so it decodes NOTHING
/// and the chunk returns zero intervals. That was this function's behaviour for
/// every chunk past the first, i.e. only the head of the file was ever scanned.
/// Measured against the bundled ffmpeg.exe: `-ss 600 -copyts -t 300` decodes 0 s;
/// `-ss 600 -copyts -to 900` decodes the expected 300 s. Chunk 0 passes no
/// `-copyts`, so `-t` and `-to` are equivalent there and one shape covers both.
///
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
    let end_secs = start_secs + len_secs;
    cmd.arg("-i").arg(url)
        .arg("-vn")
        .arg("-af").arg("silencedetect=n=-30dB:d=0.5")
        .arg("-to").arg(format!("{end_secs:.3}"))
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

/// Closest a returned boundary may sit to the end of the file. The whole point
/// of an inferred ED start is to beat the Next-Up card's fixed lead time, so a
/// boundary inside the last 45 s buys nothing and is far more likely to be the
/// fade-out at EOF than the start of the credits.
const OUTRO_MIN_TAIL_SECS: f64 = 45.0;
/// How close a silence boundary has to be to a black boundary for the two to
/// count as ONE transition. A cut into the credits normally drops both the
/// picture and the audio bed within a beat of each other.
const OUTRO_COINCIDENCE_SLACK_SECS: f64 = 3.0;
/// Shortest black run that counts as a transition. A cut between shots is a
/// frame or two; a transition into credits holds black for around a second.
const BLACK_MIN_RUN_SECS: f64 = 0.5;
/// Shortest audio gap that counts. Deliberately left at the threshold this
/// scan has always effectively used: with the LATEST-wins rule above, extra
/// candidates can only move the answer later (and everything in the window is
/// already a plausible credits position), so tightening recall here would lose
/// files that have one weak boundary and nothing else, for no accuracy gain.
const SILENCE_MIN_RUN_SECS: f64 = 1.5;

/// Hybrid-mode ED detection (the bounded, low-risk slice — NO 90× scan).
///
/// Scans only the LAST `tail_secs` of the stream with a SINGLE ffmpeg
/// pass running `blackdetect` (downscaled, cheap) + `silencedetect`
/// together. Credits/ED almost always begin with a hard scene→black
/// cut and/or a music/dialogue→silence transition.
///
/// SELECTION IS BIASED LATE, ON PURPOSE. This used to take the EARLIEST
/// qualifying boundary in a 420 s tail, which is wrong in a specific and
/// user-visible way: a 24-minute episode's tail starts around 17:25, and every
/// fade-to-black act break between there and the real credits is a candidate.
/// Reported on Hell's Paradise S02E11 (AniSkip has NO data for that episode, so
/// this scan was the only ED source): the Next-Up card appeared a minute or two
/// before the ending. The credits are the LAST major A/V discontinuity in the
/// file, so the latest qualifying boundary that still leaves `OUTRO_MIN_TAIL_SECS`
/// of runtime is the one to take. Being late costs nothing (the Next-Up card's
/// fixed lead time still fires); being early yanks a card over the climax.
///
/// Confidence order, all within the same window:
///   1. a black boundary with a silence boundary within a few seconds of it
///      (a real cut into the credits drops picture and audio bed together),
///   2. a black boundary alone,
///   3. a long silence alone.
///
/// `duration` (container seconds, 0 when unknown) anchors the window. Without
/// it the scan can only guess the end from the timestamps it happened to
/// observe, which is exactly how a bad answer used to look plausible.
///
/// The caller stamps the returned boundary as a PROMPT-ONLY `ed` window so the
/// inference is visible on the scrubber rather than silently timing a card.
/// ffmpeg-on-PATH best-effort, same graceful `available=false` contract as
/// `detect_silence_intervals`.
#[tauri::command]
pub async fn detect_outro_boundary(
    app: tauri::AppHandle,
    url: String,
    tail_secs: u32,
    duration: f64,
) -> Result<OutroBoundaryResult, String> {
    let tail = if tail_secs == 0 { 300 } else { tail_secs.min(900) };
    crate::devlog!(
        info, "silence",
        "detect_outro_boundary tail={tail}s duration={duration:.1} url={}",
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
    // blackdetect so the tail video decode is cheap.
    //
    // NO `-t` HERE. It used to pass `-t (tail + 30)`, which under `-copyts` is
    // measured against the ABSOLUTE timestamps: in the tail those are around
    // (duration - tail), which exceeds `tail + 30` on any real episode, so
    // ffmpeg stopped immediately and decoded NOTHING. This scan has therefore
    // been silently returning no intervals. `-sseof` already bounds the read to
    // the tail (it runs to EOF), so no output limit is needed at all. Measured
    // against the bundled ffmpeg.exe: `-sseof -120 -copyts -t 150` decodes 0 s;
    // dropping `-t` decodes the expected ~120 s.
    let mut cmd = ffmpeg_command(&app);
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-protocol_whitelist").arg("http,https,tcp,tls,crypto")
        .arg("-sseof").arg(format!("-{tail}"))
        .arg("-copyts")
        .arg("-i").arg(&url)
        // Filter thresholds match the post-filters below so ffmpeg does not
        // emit runs the parser will only discard.
        .arg("-vf").arg("scale=160:-2,blackdetect=d=0.50:pic_th=0.98")
        .arg("-af").arg("silencedetect=n=-30dB:d=1.5")
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

    let mut blacks: Vec<f64> = Vec::new();   // black_start of a run ≥ BLACK_MIN_RUN_SECS
    let mut sils:   Vec<f64> = Vec::new();   // silence_start of a gap ≥ SILENCE_MIN_RUN_SECS
    let mut sil_start: Option<f64> = None;
    let mut ts_min = f64::INFINITY;
    let mut ts_max = f64::NEG_INFINITY;

    /// Number that follows `tag` on a line, if any.
    fn field(line: &str, tag: &str) -> Option<f64> {
        line.split(tag).nth(1)?.split_whitespace().next()?.parse::<f64>().ok()
    }

    let parse = async {
        while let Ok(Some(line)) = reader.next_line().await {
            // blackdetect emits ONE line per run carrying all three fields:
            //   [blackdetect @ ...] black_start:1376.2 black_end:1378.1 black_duration:1.9
            // The previous parser was an if/else-if chain that tested
            // `black_start:` first, so the `black_end:` arm could never be
            // reached on that same line and NOTHING was ever pushed to
            // `blacks`. Every ED this scan has ever reported came from the
            // silence list alone, which is also why the "a hard black cut is a
            // stronger credits signal, so prefer it" comment described
            // behaviour that did not exist.
            if line.contains("black_start:") {
                let start = field(&line, "black_start:");
                let end   = field(&line, "black_end:");
                let run   = field(&line, "black_duration:")
                    .or_else(|| match (start, end) { (Some(s), Some(e)) => Some(e - s), _ => None });
                if let Some(s) = start {
                    ts_min = ts_min.min(s);
                    ts_max = ts_max.max(end.unwrap_or(s));
                    if run.unwrap_or(0.0) >= BLACK_MIN_RUN_SECS { blacks.push(s) }
                }
                continue;
            }
            // silencedetect DOES split across lines: `silence_start: X`, then
            // `silence_end: Y | silence_duration: Z`.
            if let Some(s) = field(&line, "silence_start:") {
                sil_start = Some(s);
                ts_min = ts_min.min(s);
                ts_max = ts_max.max(s);
                continue;
            }
            if let Some(e) = field(&line, "silence_end:") {
                ts_max = ts_max.max(e);
                let run = field(&line, "silence_duration:")
                    .or_else(|| sil_start.map(|s| e - s));
                if let Some(s) = sil_start.take() {
                    if run.unwrap_or(0.0) >= SILENCE_MIN_RUN_SECS { sils.push(s) }
                }
            }
        }
    };

    let timed = tokio::time::timeout(Duration::from_secs(300), parse).await;
    if timed.is_err() {
        crate::devlog!(warn, "silence", "outro ffmpeg readline timed out — killing");
        let _ = child.kill().await;
        let _ = child.wait().await;
        // A truncated scan is NOT a partial answer. Selection below takes the
        // LATEST qualifying boundary, and a scan cut short is missing exactly
        // the late ones, so continuing would hand back a systematically early
        // guess wearing a clean `available: true`.
        return Ok(OutroBoundaryResult {
            available: false,
            ed_start:  None,
            note:      format!(
                "outro scan timed out after 300s (tail {tail}s, partial: {} black + {} silence)",
                blacks.len(), sils.len(),
            ),
        });
    }
    let exit_ok = matches!(child.wait().await, Ok(s) if s.success());
    if !exit_ok {
        // Same reasoning: an ffmpeg that died mid-stream (dropped debrid link,
        // decode error) has an incomplete tail, and its last boundary is not
        // the file's last boundary.
        crate::devlog!(warn, "silence", "outro ffmpeg exited non-zero, discarding scan");
        return Ok(OutroBoundaryResult {
            available: false,
            ed_start:  None,
            note:      format!(
                "ffmpeg exited non-zero (tail {tail}s, partial: {} black + {} silence)",
                blacks.len(), sils.len(),
            ),
        });
    }

    // Anchor the window on the CONTAINER duration when the caller knows it;
    // fall back to the largest observed timestamp only when it doesn't (the old
    // behaviour, kept so a duration-less caller still gets an answer rather
    // than nothing). `ts_max` is the last timestamp any detector reported, NOT
    // the end of the file: on a stream whose final minute has neither a black
    // frame nor a silence it under-reads the end by however long that quiet
    // stretch is, and every offset derived from it shifts with it.
    let end_ref = if duration > 0.0 {
        duration
    } else if ts_max.is_finite() {
        ts_max
    } else {
        f64::NAN
    };
    // Low edge excludes the seek-in artifact; high edge excludes both the
    // fade-out at EOF and anything too close to the end to be worth reporting.
    //
    // The floor comes from the SCAN ORIGIN (`-sseof -tail` starts the read at
    // end_ref - tail), never from ts_min. ts_min is just the first timestamp a
    // detector happened to report, so folding it in would push the floor past
    // the only boundary in a file that has exactly one - the clean case. It is
    // used only when the caller could not supply a duration and there is
    // nothing else to anchor to.
    let (lo, hi) = outro_window(end_ref, tail, ts_min);

    let (ed_start, how, coincident) = pick_outro_boundary(&blacks, &sils, lo, hi);

    let note = match ed_start {
        Some(t) => format!(
            "tail {tail}s window {lo:.1}-{hi:.1}s: {} black + {} silence \
             ({coincident} coincident) → ED≈{t:.1}s via {how}",
            blacks.len(), sils.len(),
        ),
        None => format!(
            "tail {tail}s window {lo:.1}-{hi:.1}s: {} black + {} silence boundary(s), \
             none qualified",
            blacks.len(), sils.len(),
        ),
    };
    crate::devlog!(info, "silence", "{note}");

    Ok(OutroBoundaryResult { available: true, ed_start, note })
}

/// Acceptance window for a credits boundary, in absolute stream seconds.
///
/// Anchored on the SCAN ORIGIN. `-sseof -tail` starts the read at
/// `end_ref - tail`, so that plus a couple of seconds is the seek-in artifact
/// floor. The floor must NOT be folded together with `ts_min`: that is only the
/// first timestamp some detector happened to report, so on a file whose tail
/// contains exactly one boundary (the clean case) `ts_min + 2` lands PAST it and
/// the answer is thrown away. `ts_min` is the fallback only when the caller
/// could not supply a duration and there is nothing else to anchor to.
fn outro_window(end_ref: f64, tail: u32, ts_min: f64) -> (f64, f64) {
    if end_ref.is_finite() {
        (end_ref - tail as f64 + 2.0, end_ref - OUTRO_MIN_TAIL_SECS)
    } else if ts_min.is_finite() {
        (ts_min + 2.0, f64::INFINITY)
    } else {
        (0.0, f64::INFINITY)
    }
}

/// Choose the credits boundary out of the scan's two boundary lists. Pure, so
/// the selection rule is testable without ffmpeg or a network stream.
///
/// LATEST qualifying boundary, not earliest: the credits are the last major A/V
/// discontinuity in a file, and every act break before them is a candidate an
/// earliest-wins rule prefers - which is precisely how the Next-Up card ended up
/// a minute early. Everything inside [lo, hi] is already a plausible credits
/// position by construction, so taking the last one is uniformly the
/// conservative choice: worst case the card fires a few seconds into the credits
/// instead of at their first frame.
///
/// The two lists are a UNION, not a priority ladder. Tiering them (coincident,
/// then black, then silence) re-created the original bug in miniature: an act
/// break that happened to drop both picture and audio outranked a later, real
/// credits cut that only showed up in one list. Coincidence is still computed,
/// but only to describe how well corroborated the answer is.
///
/// Returns (boundary, how well corroborated, how many coincident candidates).
fn pick_outro_boundary(
    blacks: &[f64], sils: &[f64], lo: f64, hi: f64,
) -> (Option<f64>, &'static str, usize) {
    let in_window = |t: f64| t >= lo && t <= hi;
    let coincident: Vec<f64> = blacks.iter().copied()
        .filter(|&b| in_window(b))
        .filter(|&b| sils.iter().any(|&s| (s - b).abs() <= OUTRO_COINCIDENCE_SLACK_SECS))
        .collect();
    let best = blacks.iter().chain(sils.iter()).copied()
        .filter(|&t| in_window(t))
        .fold(f64::NEG_INFINITY, f64::max);
    if !best.is_finite() { return (None, "none", coincident.len()) }
    let how = if coincident.iter().any(|&c| (c - best).abs() < f64::EPSILON) {
        "black+silence"
    } else if blacks.contains(&best) {
        "black"
    } else {
        "silence"
    };
    (Some(best), how, coincident.len())
}

#[cfg(test)]
mod outro_tests {
    use super::*;

    // Hell's Paradise S02: 1465.1 s runtime, credits at 1376 (AniSkip rows for
    // episodes 1/2/5/6/7/12 all land within 13 s of it). The scan window for a
    // 240 s tail is [1227.1, 1420.1].
    const LO: f64 = 1227.1;
    const HI: f64 = 1420.1;

    #[test]
    fn latest_boundary_wins_over_an_earlier_act_break() {
        // The reported failure: an act break at 1246 and the real credits at
        // 1376. Earliest-wins returned 1246 and put the Next-Up card 130 s early.
        let (t, how, _) = pick_outro_boundary(&[1246.0, 1376.0], &[], LO, HI);
        assert_eq!(t, Some(1376.0));
        assert_eq!(how, "black");
    }

    #[test]
    fn corroboration_does_not_promote_an_earlier_candidate() {
        // A coincident act break at 1300 must NOT beat a later lone black at
        // 1390: tiering the two lists re-created the reported bug in miniature.
        let (t, how, n) = pick_outro_boundary(&[1300.0, 1390.0], &[1301.5], LO, HI);
        assert_eq!(t, Some(1390.0));
        assert_eq!(how, "black");
        assert_eq!(n, 1, "the 1300 coincidence is still counted, just not preferred");
    }

    #[test]
    fn a_silence_only_file_still_gets_an_answer() {
        let (t, how, _) = pick_outro_boundary(&[], &[1290.0, 1376.0], LO, HI);
        assert_eq!(t, Some(1376.0));
        assert_eq!(how, "silence");
    }

    #[test]
    fn boundaries_outside_the_window_never_qualify() {
        // 1170 is in the final act but before the window; 1450 is inside the
        // last OUTRO_MIN_TAIL_SECS and would be the fade-out at EOF.
        let (t, how, _) = pick_outro_boundary(&[1170.0, 1450.0], &[1170.5], LO, HI);
        assert_eq!(t, None);
        assert_eq!(how, "none");
    }

    #[test]
    fn empty_input_is_not_an_answer() {
        assert_eq!(pick_outro_boundary(&[], &[], LO, HI).0, None);
    }

    #[test]
    fn a_single_clean_credits_transition_is_found() {
        // Drives the REAL window computation, not hardcoded bounds: the old
        // event-derived trim (lo = ts_min + 2, hi = ts_max - 8) inverted on
        // exactly this input - one black at 1376, one silence at 1374.5 - and
        // threw the perfectly-detected answer away.
        let (lo, hi) = outro_window(1465.1, 240, 1374.5);
        let (t, how, _) = pick_outro_boundary(&[1376.0], &[1374.5], lo, hi);
        assert_eq!(t, Some(1376.0));
        assert_eq!(how, "black+silence");
    }

    #[test]
    fn the_window_is_anchored_on_the_scan_origin_not_on_the_events() {
        let (lo, hi) = outro_window(1465.1, 240, 1374.5);
        assert!((lo - 1227.1).abs() < 0.001, "lo was {lo}");
        assert!((hi - (1465.1 - OUTRO_MIN_TAIL_SECS)).abs() < 0.001, "hi was {hi}");
        // The first observed event must still be inside the window.
        assert!(1374.5 >= lo && 1374.5 <= hi);
    }

    #[test]
    fn without_a_duration_the_window_degrades_rather_than_inverting() {
        let (lo, hi) = outro_window(f64::NAN, 240, 1300.0);
        assert_eq!(lo, 1302.0);
        assert_eq!(hi, f64::INFINITY);
        assert!(lo < hi, "the window must never invert");
    }
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
