// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! HLS downloads, in two modes.
//!
//! ## Why the primary mode inverts the obvious design
//!
//! The obvious design is "let ffmpeg fetch and remux, kill it on pause, resume
//! with `-ss <where we stopped>`". It is wrong, and it fails SILENTLY.
//! Measured against the bundled ffmpeg 8.1.1 on a 5 x 6.000 s VOD playlist:
//!
//! | `-ss` | media produced | actual start |
//! |-------|----------------|--------------|
//! | 15    | 18 s           | 12 s         |
//! | 18    | 18 s           | 12 s         |
//!
//! `-ss 15` and `-ss 18` produced BYTE-IDENTICAL 4,493,012-byte files. On a
//! mid-segment value ffmpeg lands on the start of the containing segment, which
//! looks like harmless rounding; on an exact segment BOUNDARY it lands one
//! whole segment early. A resume point is always a boundary, so the error is
//! not occasional, it is every single resume, and the mpegts muxer rebases each
//! run to the same origin so the duplicate is invisible downstream. ffmpeg
//! exits 0 with no diagnostic. The offset is not a constant that could be
//! subtracted: 1 segment at boundaries, 0 mid-segment, dependent on
//! `#EXT-X-TARGETDURATION`, and undocumented behaviour of `hls.c`. Correcting
//! it would need `-copyts` plus `-to`, which is the documented zero-bytes
//! landmine in CLAUDE.md.
//!
//! **No download-job ffmpeg invocation here passes `-ss`, `-copyts`, `-t` or
//! `-to`.** Both modes read from byte zero to the end.
//!
//! Suspending the process is not a pause either: the sockets stall and debrid
//! hosts drop idle connections within tens of seconds, `-seg_max_retry`
//! defaults to 0 so the job then dies on resume, signed segment URLs expire
//! while suspended, and the held-open output has no container trailer so
//! quitting leaves an unopenable file.
//!
//! ## Mode A, the ledger (primary)
//!
//! Aura fetches segments serially into one accumulation file; ffmpeg does
//! exactly one local `-c copy` remux at the end. Pause is exact: appending
//! segments 3-4 to an accumulation file holding 0-2 produced a file
//! `cmp`-identical to an uninterrupted download, and remuxed to the same
//! 30.023000 s. This works because every HLS media segment is independently
//! decodable and starts on a keyframe, and MPEG-TS is a byte-concatenable
//! packet stream. Verified for fMP4/CMAF too, with the `#EXT-X-MAP` init
//! segment written at byte 0.
//!
//! ## Mode B, passthrough (fallback)
//!
//! ffmpeg fetches and remuxes in one pass, for playlists Mode A declines. NOT
//! pausable, and the row says so rather than offering a control that cannot
//! work.

use std::io::Write;
use std::process::Stdio;
use std::time::Duration;

use tokio::sync::watch;

use super::types::{DownloadJob, JobKind, Outcome, StopReason};

/// Refuse absurd playlists rather than trying to stream them.
const MAX_SEGMENTS: usize = 20_000;
const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
/// One level of master-playlist indirection, no more.
const MAX_PLAYLIST_FETCHES: usize = 2;

const LEDGER_FILE: &str = "ledger.json";
const MEDIA_FILE: &str = "media.bin";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Segment {
    url: String,
    /// `#EXT-X-BYTERANGE`, as (length, offset).
    #[serde(default)]
    byte_range: Option<(u64, u64)>,
    duration: f64,
}

/// Persisted beside the accumulation file so a resume knows exactly which
/// segment is next and how many bytes belong to the ones already written.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Ledger {
    segments: Vec<Segment>,
    /// Index of the next segment to fetch.
    next: usize,
    /// Bytes committed by the segments before `next`. Any tail past this is a
    /// partially-written segment from an interrupted run and is truncated away.
    committed: u64,
    total_duration: f64,
    /// `#EXT-X-MAP` init segment, written at byte 0.
    #[serde(default)]
    init: Option<String>,
}

// ---------------------------------------------------------------------------
// Playlist parsing
// ---------------------------------------------------------------------------

struct Parsed {
    segments: Vec<Segment>,
    total_duration: f64,
    init: Option<String>,
    /// Reasons Mode A cannot be used. Empty means the ledger is safe.
    blockers: Vec<&'static str>,
    /// A master playlist's chosen variant, to fetch next.
    variant: Option<String>,
    has_endlist: bool,
}

fn resolve(base: &str, rel: &str) -> Option<String> {
    // `url` handles `../`, absolute paths, scheme-relative `//host/...` and
    // query-bearing URIs. Hand-rolling RFC 3986 here is a bug farm, and a
    // resolution bug means downloading the wrong bytes.
    let b = url::Url::parse(base).ok()?;
    b.join(rel).ok().map(|u| u.to_string())
}

fn attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let idx = line.find(key)?;
    let rest = &line[idx + key.len()..];
    let rest = rest.strip_prefix('=')?;
    if let Some(q) = rest.strip_prefix('"') {
        q.split('"').next()
    } else {
        Some(rest.split(',').next().unwrap_or(rest))
    }
}

fn parse_playlist(body: &str, base: &str) -> Parsed {
    let mut segments = Vec::new();
    let mut blockers = Vec::new();
    let mut total = 0.0f64;
    let mut init = None;
    let mut has_endlist = false;

    let mut pending_dur: Option<f64> = None;
    let mut pending_range: Option<(u64, u64)> = None;
    let mut next_range_offset: u64 = 0;

    // Master-playlist handling: pick the highest BANDWIDTH variant.
    let mut best_variant: Option<(u64, String)> = None;
    let mut variant_pending: Option<u64> = None;

    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            variant_pending = Some(
                attr(rest, "BANDWIDTH")
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0),
            );
            continue;
        }
        if line.starts_with("#EXT-X-ENDLIST") {
            has_endlist = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let method = attr(rest, "METHOD").unwrap_or("NONE");
            if !method.eq_ignore_ascii_case("NONE") {
                // ffmpeg decrypts AES-128 natively; there is no AES crate in
                // the dependency graph, so doing it ourselves is a genuine new
                // dependency and is out of scope.
                blockers.push("the stream is encrypted");
            }
            continue;
        }
        if line.starts_with("#EXT-X-DISCONTINUITY") {
            // The HLS demuxer applies per-discontinuity-sequence timestamp
            // offsets. A raw byte concat does not, and the result is a broken
            // timeline.
            blockers.push("the stream has timeline discontinuities");
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            if let Some(uri) = attr(rest, "URI") {
                init = resolve(base, uri);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let ty = attr(rest, "TYPE").unwrap_or("");
            // A demuxed rendition is a separate playlist needing a real mux,
            // not a concat.
            if (ty.eq_ignore_ascii_case("AUDIO") || ty.eq_ignore_ascii_case("SUBTITLES"))
                && attr(rest, "URI").is_some()
            {
                blockers.push("the audio or subtitles are in a separate stream");
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending_dur = rest
                .split(',')
                .next()
                .and_then(|v| v.trim().parse::<f64>().ok());
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            let mut it = rest.trim().split('@');
            let len = it.next().and_then(|v| v.parse::<u64>().ok());
            let off = it.next().and_then(|v| v.parse::<u64>().ok());
            if let Some(l) = len {
                let o = off.unwrap_or(next_range_offset);
                pending_range = Some((l, o));
                next_range_offset = o + l;
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        // A bare line is a URI: either a variant (after STREAM-INF) or a
        // media segment.
        if let Some(bw) = variant_pending.take() {
            if let Some(abs) = resolve(base, line) {
                if best_variant.as_ref().map(|(b, _)| bw > *b).unwrap_or(true) {
                    best_variant = Some((bw, abs));
                }
            }
            continue;
        }
        let Some(abs) = resolve(base, line) else { continue };
        let d = pending_dur.take().unwrap_or(0.0);
        total += d;
        segments.push(Segment {
            url: abs,
            byte_range: pending_range.take(),
            duration: d,
        });
    }

    blockers.sort_unstable();
    blockers.dedup();

    Parsed {
        segments,
        total_duration: total,
        init,
        blockers,
        variant: best_variant.map(|(_, u)| u),
        has_endlist,
    }
}

async fn fetch_text(url: &str, job: &DownloadJob) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    let mut saw_ua = false;
    for (k, v) in &job.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            saw_ua = true;
        }
        req = req.header(k, v);
    }
    if !saw_ua {
        req = req.header(reqwest::header::USER_AGENT, super::http::DEFAULT_UA);
    }
    let resp = req.send().await.map_err(|e| format!("could not fetch the playlist: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("playlist returned HTTP {}", status.as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PLAYLIST_BYTES {
        return Err("that playlist is implausibly large".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "the playlist is not valid text".into())
}

/// Fetch, following one level of master indirection, and decide the mode.
async fn admit(job: &DownloadJob) -> Result<(JobKind, Parsed), Outcome> {
    let mut url = job.url.clone();
    let mut parsed = None;
    for _ in 0..MAX_PLAYLIST_FETCHES {
        let body = match fetch_text(&url, job).await {
            Ok(b) => b,
            Err(e) => return Err(Outcome::Transient(e)),
        };
        let p = parse_playlist(&body, &url);
        if let Some(v) = p.variant.clone() {
            if p.segments.is_empty() {
                url = v;
                continue;
            }
        }
        parsed = Some(p);
        break;
    }
    let Some(p) = parsed else {
        return Err(Outcome::Fatal("Could not read that stream's playlist.".into()));
    };

    // A live stream has no end to download. This is a refusal, not a fallback:
    // Mode B would run until the disk filled.
    if !p.has_endlist {
        return Err(Outcome::Fatal(
            "This is a live stream, so it has no end to download.".into(),
        ));
    }
    if p.segments.is_empty() {
        return Err(Outcome::Fatal("That playlist contains no video.".into()));
    }
    if p.segments.len() > MAX_SEGMENTS {
        return Err(Outcome::Fatal("That playlist is too long to download.".into()));
    }

    if p.blockers.is_empty() {
        Ok((JobKind::HlsLedger, p))
    } else {
        crate::devlog!(
            info, "downloads",
            "{}: using single-pass remux ({})", job.title, p.blockers.join(", ")
        );
        Ok((JobKind::HlsPassthrough, p))
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub async fn run(job: &DownloadJob, stop: watch::Receiver<Option<StopReason>>) -> Outcome {
    let work = std::path::PathBuf::from(&job.part_path);
    if let Err(e) = std::fs::create_dir_all(&work) {
        return Outcome::Fatal(format!("Could not create the working folder: {e}"));
    }

    // A resume reuses the ledger it already has rather than re-fetching the
    // playlist, so a re-signed manifest cannot renumber the segments under a
    // half-written accumulation file.
    let ledger_path = work.join(LEDGER_FILE);
    let existing: Option<Ledger> = std::fs::read_to_string(&ledger_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    let (kind, ledger) = match existing {
        Some(l) => (JobKind::HlsLedger, l),
        None => match admit(job).await {
            Ok((JobKind::HlsPassthrough, p)) => {
                return passthrough(job, &work, p.total_duration, stop).await;
            }
            Ok((_, p)) => {
                let l = Ledger {
                    segments: p.segments,
                    next: 0,
                    committed: 0,
                    total_duration: p.total_duration,
                    init: p.init,
                };
                (JobKind::HlsLedger, l)
            }
            Err(o) => return o,
        },
    };
    let _ = kind;
    ledger_run(job, &work, ledger, stop).await
}

// ---------------------------------------------------------------------------
// Mode A
// ---------------------------------------------------------------------------

fn save_ledger(work: &std::path::Path, l: &Ledger) {
    if let Ok(s) = serde_json::to_string(l) {
        let tmp = work.join("ledger.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, work.join(LEDGER_FILE));
        }
    }
}

async fn ledger_run(
    job: &DownloadJob,
    work: &std::path::Path,
    mut ledger: Ledger,
    mut stop: watch::Receiver<Option<StopReason>>,
) -> Outcome {
    let media = work.join(MEDIA_FILE);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Outcome::Fatal(format!("Could not start the download: {e}")),
    };

    // Truncate any partially-written trailing segment from a previous run.
    // `committed` is the only length the ledger vouches for.
    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .read(true)
        .open(&media)
    {
        Ok(f) => f,
        Err(e) => return Outcome::Fatal(format!("Could not open the working file: {e}")),
    };
    if let Err(e) = file.set_len(ledger.committed) {
        return Outcome::Fatal(format!("Could not reset the working file: {e}"));
    }
    if let Err(e) = std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(ledger.committed)) {
        return Outcome::Fatal(format!("Could not position the working file: {e}"));
    }

    // The init segment belongs at byte 0 and only on a fresh start.
    if ledger.next == 0 && ledger.committed == 0 {
        if let Some(init_url) = ledger.init.clone() {
            match fetch_segment(&client, job, &init_url, None, &mut stop).await {
                Ok(Some(bytes)) => {
                    if let Err(e) = file.write_all(&bytes) {
                        return Outcome::Fatal(format!("Could not write to the download folder: {e}"));
                    }
                    ledger.committed += bytes.len() as u64;
                    save_ledger(work, &ledger);
                }
                Ok(None) => return Outcome::Stopped(current_reason(&stop)),
                Err(o) => return o,
            }
        }
    }

    let seg_count = ledger.segments.len();
    while ledger.next < seg_count {
        let seg = ledger.segments[ledger.next].clone();
        match fetch_segment(&client, job, &seg.url, seg.byte_range, &mut stop).await {
            Ok(Some(bytes)) => {
                if let Err(e) = file.write_all(&bytes) {
                    return Outcome::Fatal(format!("Could not write to the download folder: {e}"));
                }
                ledger.committed += bytes.len() as u64;
                ledger.next += 1;
                // Persist per segment: it is a few hundred bytes every ~6
                // seconds of media, and it is what makes a pause exact.
                save_ledger(work, &ledger);

                // Progress is time-based, which is the only honest basis here:
                // there is no Content-Length for the stream as a whole.
                let done_secs: f64 =
                    ledger.segments[..ledger.next].iter().map(|s| s.duration).sum();
                let frac = if ledger.total_duration > 0.0 {
                    (done_secs / ledger.total_duration).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                // Report bytes-on-disk against a projected total so the row
                // shows a real size rather than a fake one.
                let projected = if frac > 0.02 {
                    Some((ledger.committed as f64 / frac) as u64)
                } else {
                    None
                };
                super::manager::record_progress(&job.id, ledger.committed, projected);
            }
            Ok(None) => {
                let _ = file.flush();
                save_ledger(work, &ledger);
                return Outcome::Stopped(current_reason(&stop));
            }
            Err(o) => {
                let _ = file.flush();
                save_ledger(work, &ledger);
                return o;
            }
        }
    }
    let _ = file.flush();
    drop(file);

    remux(job, work, &media).await
}

fn current_reason(stop: &watch::Receiver<Option<StopReason>>) -> StopReason {
    stop.borrow().unwrap_or(StopReason::Pause)
}

/// Fetch one segment. `Ok(None)` means a stop was requested.
async fn fetch_segment(
    client: &reqwest::Client,
    job: &DownloadJob,
    url: &str,
    range: Option<(u64, u64)>,
    stop: &mut watch::Receiver<Option<StopReason>>,
) -> Result<Option<Vec<u8>>, Outcome> {
    // Check before spending a request, so a pause during a long queue of
    // segments takes effect at once.
    if stop.borrow().is_some() {
        return Ok(None);
    }
    let mut req = client.get(url);
    let mut saw_ua = false;
    for (k, v) in &job.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            saw_ua = true;
        }
        req = req.header(k, v);
    }
    if !saw_ua {
        req = req.header(reqwest::header::USER_AGENT, super::http::DEFAULT_UA);
    }
    if let Some((len, off)) = range {
        req = req.header(reqwest::header::RANGE, format!("bytes={off}-{}", off + len - 1));
    }

    tokio::select! {
        biased;

        // Same rule as the HTTP transport: control wins over a stalled read.
        changed = stop.changed() => {
            if changed.is_err() {
                return Err(Outcome::Transient("The download was interrupted.".into()));
            }
            Ok(None)
        }

        res = req.send() => {
            let resp = res.map_err(|e| Outcome::Transient(format!("Could not fetch a segment: {e}")))?;
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
                || status == reqwest::StatusCode::GONE
                || status == reqwest::StatusCode::NOT_FOUND
            {
                return Err(Outcome::Expired(format!("HTTP {}", status.as_u16())));
            }
            if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(Outcome::Transient(format!("A segment returned HTTP {}.", status.as_u16())));
            }
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| Outcome::Transient(format!("A segment download failed: {e}")))?;
            Ok(Some(bytes.to_vec()))
        }
    }
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

fn ffmpeg_path() -> Result<std::path::PathBuf, Outcome> {
    crate::runtime_deps::resolved_path("ffmpeg").ok_or_else(|| {
        // A legible state the user can act on, not a raw missing-file error.
        // The frontend keys the "fetch it" offer off this sentinel.
        Outcome::Fatal(
            "[noffmpeg] This stream needs the video tools, which are not installed yet.".into(),
        )
    })
}

#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_cmd: &mut std::process::Command) {}

/// Local remux of the accumulated segments into the final container.
///
/// No `-ss`, no `-copyts`, no `-t`, no `-to`. Reads from byte zero to the end.
async fn remux(
    job: &DownloadJob,
    work: &std::path::Path,
    media: &std::path::Path,
) -> Outcome {
    let ff = match ffmpeg_path() {
        Ok(p) => p,
        Err(o) => return o,
    };
    let out = work.join("out.mkv");
    let mut cmd = std::process::Command::new(&ff);
    cmd.args([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i",
    ])
    .arg(media)
    .args([
        "-map", "0",
        "-c", "copy",
        // Matroska, deliberately without -bsf:a aac_adtstoasc. That filter
        // converts ADTS AAC to the MP4/MOV form, is meaningless for Matroska,
        // and is NOT a no-op: ffmpeg errors out when the audio is not AAC.
        // Addon HLS routinely carries AC3, E-AC3 or MP3.
        "-f", "matroska",
    ])
    .arg(&out)
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let output = match tokio::task::spawn_blocking(move || cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Outcome::Fatal(format!("Could not run the video tools: {e}")),
        Err(e) => return Outcome::Fatal(format!("Could not run the video tools: {e}")),
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let tail = err.lines().rev().take(2).collect::<Vec<_>>().join(" ");
        return Outcome::Fatal(format!("Could not assemble the video. {tail}"));
    }
    publish(job, &out)
}

/// Mode B: one ffmpeg pass that both fetches and remuxes.
async fn passthrough(
    job: &DownloadJob,
    work: &std::path::Path,
    total_duration: f64,
    mut stop: watch::Receiver<Option<StopReason>>,
) -> Outcome {
    let ff = match ffmpeg_path() {
        Ok(p) => p,
        Err(o) => return o,
    };
    let out = work.join("out.mkv");

    let mut cmd = std::process::Command::new(&ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    // Forward the addon's headers, including the User-Agent. Provider gating
    // is real, and ffmpeg does not inherit anything from the reqwest client.
    let mut ua = super::http::DEFAULT_UA.to_string();
    let mut extra = String::new();
    for (k, v) in &job.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            ua = v.clone();
        } else {
            extra.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    cmd.args(["-user_agent", &ua]);
    if !extra.is_empty() {
        cmd.args(["-headers", &extra]);
    }
    cmd.args(["-i"])
        .arg(&job.url)
        .args(["-map", "0", "-c", "copy", "-f", "matroska"])
        .arg(&out)
        .args(["-progress", "pipe:1", "-nostats"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::Fatal(format!("Could not run the video tools: {e}")),
    };
    let pid = child.id();

    // Read `-progress` on a blocking thread and publish it. `out_time_us`
    // against the #EXTINF sum is the only progress basis available: there is
    // no Content-Length for an HLS stream.
    if let Some(stdout) = child.stdout.take() {
        let id = job.id.clone();
        let out_for_progress = out.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let Some(v) = line.strip_prefix("out_time_us=") else { continue };
                let Ok(us) = v.trim().parse::<u64>() else { continue };
                if total_duration <= 0.0 {
                    continue;
                }
                let frac = ((us as f64 / 1_000_000.0) / total_duration).clamp(0.0, 1.0);
                // REAL bytes off the growing output file, with the total
                // projected through the time fraction. Reporting the fraction
                // itself as a byte count made the row read "1000 B of 1000 B".
                let done = std::fs::metadata(&out_for_progress).map(|m| m.len()).unwrap_or(0);
                let projected = if frac > 0.02 && done > 0 {
                    Some((done as f64 / frac) as u64)
                } else {
                    None
                };
                super::manager::record_progress(&id, done, projected);
            }
        });
    }

    // Poll the child, letting a cancel win immediately.
    loop {
        tokio::select! {
            biased;

            changed = stop.changed() => {
                if changed.is_ok() && stop.borrow_and_update().is_some() {
                    kill_tree(&mut child, pid);
                    // Pause is not offered for this kind, so any stop is
                    // effectively a cancel: there is nothing resumable.
                    return Outcome::Stopped(StopReason::Cancel);
                }
            }

            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                match child.try_wait() {
                    Ok(Some(st)) => {
                        if st.success() {
                            return publish(job, &out);
                        }
                        return Outcome::Fatal(
                            "Could not download that stream. The host may have ended it.".into(),
                        );
                    }
                    Ok(None) => {}
                    Err(e) => return Outcome::Fatal(format!("Lost track of the video tools: {e}")),
                }
            }
        }
    }
}

/// `taskkill /F /T` kills ffmpeg AND anything it spawned, the canonical Windows
/// orphan-proofing; `kill` + `wait` then reaps the handle so no zombie is left
/// even if taskkill missed. Same sequence as `cast/hls.rs:41-57`.
fn kill_tree(child: &mut std::process::Child, pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut k = std::process::Command::new("taskkill");
        k.args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_console(&mut k);
        let _ = k.output();
    }
    #[cfg(not(target_os = "windows"))]
    let _ = pid;
    let _ = child.kill();
    let _ = child.wait();
}

/// Move the remuxed file to its final name and drop the work dir.
fn publish(job: &DownloadJob, out: &std::path::Path) -> Outcome {
    let dest = std::path::Path::new(&job.dest_path);
    let Some(dir) = dest.parent() else {
        return Outcome::Fatal("The download destination is not a valid path.".into());
    };
    if let Err(e) = std::fs::create_dir_all(dir) {
        return Outcome::Fatal(format!("Could not create the destination folder: {e}"));
    }
    let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("download").to_string();
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or(crate::download_path::DEFAULT_EXT)
        .to_string();

    match crate::download_path::finalize(dir, &stem, &ext, out) {
        Ok(final_path) => {
            let size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
            super::manager::record_final_path(&job.id, final_path.to_string_lossy().into_owned());
            super::manager::record_progress(&job.id, size, Some(size));
            // The work dir has served its purpose.
            let _ = std::fs::remove_dir_all(std::path::Path::new(&job.part_path));
            Outcome::Completed
        }
        Err(e) => Outcome::Fatal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOD: &str = "#EXTM3U\n\
#EXT-X-TARGETDURATION:6\n\
#EXTINF:6.000,\n\
seg0.ts\n\
#EXTINF:6.000,\n\
seg1.ts\n\
#EXT-X-ENDLIST\n";

    #[test]
    fn parses_a_vod_playlist() {
        let p = parse_playlist(VOD, "https://h/media/index.m3u8");
        assert!(p.has_endlist);
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[0].url, "https://h/media/seg0.ts");
        assert!((p.total_duration - 12.0).abs() < 0.001);
        assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    }

    #[test]
    fn a_live_playlist_has_no_endlist() {
        // The refusal case: without ENDLIST there is no end to download, and
        // a single-pass remux would run until the disk filled.
        let live = VOD.replace("#EXT-X-ENDLIST\n", "");
        let p = parse_playlist(&live, "https://h/l.m3u8");
        assert!(!p.has_endlist);
    }

    #[test]
    fn encryption_and_discontinuity_block_the_ledger() {
        let enc = VOD.replace(
            "#EXT-X-TARGETDURATION:6",
            "#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.key\"",
        );
        assert!(!parse_playlist(&enc, "https://h/i.m3u8").blockers.is_empty());

        let disc = VOD.replace("#EXTINF:6.000,\nseg1.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:6.000,\nseg1.ts");
        assert!(!parse_playlist(&disc, "https://h/i.m3u8").blockers.is_empty());

        // METHOD=NONE is not encryption and must not block.
        let none = VOD.replace(
            "#EXT-X-TARGETDURATION:6",
            "#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=NONE",
        );
        assert!(parse_playlist(&none, "https://h/i.m3u8").blockers.is_empty());
    }

    #[test]
    fn a_master_playlist_elects_the_highest_bandwidth() {
        let master = "#EXTM3U\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000\n\
low/index.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=5000000\n\
high/index.m3u8\n";
        let p = parse_playlist(master, "https://h/master.m3u8");
        assert!(p.segments.is_empty());
        assert_eq!(p.variant.as_deref(), Some("https://h/high/index.m3u8"));
    }

    #[test]
    fn byterange_offsets_accumulate() {
        let br = "#EXTM3U\n\
#EXTINF:6.000,\n\
#EXT-X-BYTERANGE:1000@0\n\
all.ts\n\
#EXTINF:6.000,\n\
#EXT-X-BYTERANGE:2000\n\
all.ts\n\
#EXT-X-ENDLIST\n";
        let p = parse_playlist(br, "https://h/i.m3u8");
        assert_eq!(p.segments[0].byte_range, Some((1000, 0)));
        // A BYTERANGE with no explicit offset continues from the last one.
        assert_eq!(p.segments[1].byte_range, Some((2000, 1000)));
    }

    #[test]
    fn relative_uris_resolve_against_the_playlist() {
        let up = "#EXTM3U\n#EXTINF:6.000,\n../v/seg.ts\n#EXT-X-ENDLIST\n";
        let p = parse_playlist(up, "https://h/a/b/index.m3u8");
        assert_eq!(p.segments[0].url, "https://h/a/v/seg.ts");
    }

    #[test]
    fn init_segment_is_picked_up_for_fmp4() {
        let fmp4 = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.000,\nseg0.m4s\n#EXT-X-ENDLIST\n";
        let p = parse_playlist(fmp4, "https://h/i.m3u8");
        assert_eq!(p.init.as_deref(), Some("https://h/init.mp4"));
    }
}
