// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The direct-file transport.
//!
//! Three things here are not obvious and all three were paid for:
//!
//! 1. **One request, not a probe.** The `Range` + `If-Range` GET learns the
//!    size, the resumability and the validator from its own response. A
//!    separate HEAD would be a second round trip against a host that may 405
//!    on HEAD, may disagree with its own GET about `Content-Length`, and may
//!    have single-use link semantics that the probe would burn.
//!
//! 2. **`biased` select.** The control channel is polled BEFORE the body read
//!    on every iteration. Without `biased`, a pause issued while the body is
//!    stalled waits on the network future, and a stalled body is the single
//!    most common debrid failure mode. The row would sit at "Downloading" with
//!    a Pause button that does nothing.
//!
//! 3. **A stream that ends early looks exactly like success.** `chunk()`
//!    returning `None` is not proof of completion. Aura already shipped a fix
//!    for the mpv face of this in v2.0.1 (a dropped body read as a permanent
//!    fake EOF). Here, completion requires the byte count to match the length
//!    the origin promised; anything short is a transient error that resumes.

use std::io::{Seek, SeekFrom, Write};
use std::time::Duration;

use tokio::sync::watch;

use super::types::{DownloadJob, Outcome, StopReason};

/// Matches the Lavf User-Agent mpv sends, because playback works today and the
/// download must not be treated as a different client. Provider User-Agent
/// gating is real: it is why CLAUDE.md's HLS bypass exists.
pub const DEFAULT_UA: &str = "Lavf/61.7.100";

/// Generous: debrid hosts can take 30+ seconds to mux a fresh chunk, and
/// CLAUDE.md explicitly forbids dropping below 60 s for that reason. This is a
/// per-read timeout, not a whole-transfer one.
const READ_TIMEOUT: Duration = Duration::from_secs(90);

/// How much of the tail to re-fetch and compare when the origin offers no
/// validator. 64 KiB is enough that a coincidental match is not a real risk and
/// small enough to be free.
const TAIL_VERIFY_BYTES: u64 = 64 * 1024;

/// Progress that counts as "this link is alive", used to reset the attempt
/// counter. A link that drops thirty times but advances a megabyte each time is
/// healthy; one that dies at the same byte is dead.
const PROGRESS_RESETS_ATTEMPT: u64 = 1024 * 1024;

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(READ_TIMEOUT)
        .connect_timeout(Duration::from_secs(30))
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        // Redirects are the norm for debrid: the addon URL resolves to a
        // signed CDN link.
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .expect("download HTTP client init failed")
}

fn apply_headers(mut req: reqwest::RequestBuilder, job: &DownloadJob) -> reqwest::RequestBuilder {
    let mut saw_ua = false;
    for (k, v) in &job.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            saw_ua = true;
        }
        req = req.header(k, v);
    }
    if !saw_ua {
        req = req.header(reqwest::header::USER_AGENT, DEFAULT_UA);
    }
    req
}

/// Map a response status onto an outcome. The 4xx family here is what a rotated
/// or expired signed link actually returns.
fn status_outcome(status: reqwest::StatusCode) -> Option<Outcome> {
    use reqwest::StatusCode as S;
    match status {
        s if s.is_success() => None,
        S::UNAUTHORIZED | S::FORBIDDEN | S::NOT_FOUND | S::GONE => {
            Some(Outcome::Expired(format!("HTTP {}", status.as_u16())))
        }
        S::TOO_MANY_REQUESTS | S::REQUEST_TIMEOUT => {
            Some(Outcome::Transient(format!("The host is busy (HTTP {}).", status.as_u16())))
        }
        s if s.is_server_error() => {
            Some(Outcome::Transient(format!("The host returned HTTP {}.", status.as_u16())))
        }
        _ => Some(Outcome::Fatal(format!("The host refused the download (HTTP {}).", status.as_u16()))),
    }
}

fn header_str(h: &reqwest::header::HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    h.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

/// Total size implied by a response: `Content-Range` when the server ranged,
/// `Content-Length` otherwise.
fn total_from(h: &reqwest::header::HeaderMap, ranged: bool, from: u64) -> Option<u64> {
    if ranged {
        // `bytes 100-999/1000` -> 1000
        if let Some(cr) = header_str(h, reqwest::header::CONTENT_RANGE) {
            if let Some(total) = cr.rsplit('/').next() {
                if let Ok(n) = total.trim().parse::<u64>() {
                    return Some(n);
                }
            }
        }
        return h
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|len| from + len);
    }
    h.get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

/// Re-fetch the last `TAIL_VERIFY_BYTES` of what we already hold and compare.
///
/// This is the fallback for origins that send neither `ETag` nor
/// `Last-Modified`, which is common for debrid direct links. Without it,
/// `If-Range` degrades to "trust any 206", and a link that has since rotated to
/// a different release answers 206 at the stored offset and the two get spliced
/// into one file that is corrupt in the middle and reports no error at all.
async fn tail_matches(job: &DownloadJob, have: u64) -> Result<bool, String> {
    if have == 0 {
        return Ok(true);
    }
    let window = TAIL_VERIFY_BYTES.min(have);
    let start = have - window;

    let mut local = vec![0u8; window as usize];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(&job.part_path)
            .map_err(|e| format!("could not reopen the partial file: {e}"))?;
        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        f.read_exact(&mut local).map_err(|e| e.to_string())?;
    }

    let req = apply_headers(client().get(&job.url), job)
        .header(reqwest::header::RANGE, format!("bytes={start}-{}", have - 1));
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // No ranged answer means we cannot verify, so we must not append.
        return Ok(false);
    }
    let remote = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(remote.len() as u64 == window && remote[..] == local[..])
}

pub async fn run(
    job: &DownloadJob,
    mut stop: watch::Receiver<Option<StopReason>>,
) -> Outcome {
    // What is already on disk. The partial IS the progress record.
    let mut have = std::fs::metadata(&job.part_path).map(|m| m.len()).unwrap_or(0);

    // A resume with bytes on disk but no validator has to be proven safe
    // before a single byte is appended.
    if have > 0 && job.validator.is_none() {
        match tail_matches(job, have).await {
            Ok(true) => {}
            Ok(false) => {
                crate::devlog!(
                    warn, "downloads",
                    "{}: the source changed under a partial download; restarting it",
                    job.title
                );
                if let Err(e) = std::fs::write(&job.part_path, b"") {
                    return Outcome::Fatal(format!("Could not reset the partial file: {e}"));
                }
                have = 0;
            }
            Err(e) => return Outcome::Transient(format!("Could not verify the partial file: {e}")),
        }
    }

    let mut req = apply_headers(client().get(&job.url), job);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
        if let Some(v) = &job.validator {
            // If the file changed, the origin answers 200 with the whole thing
            // instead of a 206, and we restart rather than splice.
            req = req.header(reqwest::header::IF_RANGE, v);
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Outcome::Transient(format!("Could not reach the host: {}", short_err(&e)))
        }
    };

    if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // We asked past the end. Either the file is complete or it shrank.
        if let Some(total) = job.total_bytes {
            if have >= total {
                return finish(&job.dest_path, &job.part_path);
            }
        }
        let _ = std::fs::write(&job.part_path, b"");
        return Outcome::Transient("The host lost track of the partial download; restarting it.".into());
    }
    if let Some(o) = status_outcome(resp.status()) {
        return o;
    }

    let ranged = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if have > 0 && !ranged {
        // A 200 to a ranged request means the origin ignored Range, or the
        // If-Range validator failed. Either way the bytes coming back start at
        // zero and must not be appended to what we hold.
        crate::devlog!(info, "downloads", "{}: host will not resume; starting over", job.title);
        have = 0;
    }

    let headers = resp.headers().clone();
    let total = total_from(&headers, ranged, have);
    let validator = header_str(&headers, reqwest::header::ETAG)
        .or_else(|| header_str(&headers, reqwest::header::LAST_MODIFIED));
    super::manager::record_probe(&job.id, total, ranged || have == 0, validator);

    // Refine the container now that a real Content-Type is in hand, but only
    // when nothing more confident already decided it.
    //
    // The worker tracks its OWN paths from here on. `job` is an owned clone
    // made when the task was spawned, so once the refinement renames the file
    // on disk that clone points at something that no longer exists.
    let mut dest_path = job.dest_path.clone();
    let mut part_path = job.part_path.clone();
    if let Some(ct) = header_str(&headers, reqwest::header::CONTENT_TYPE) {
        if let Some((d, p)) = super::refine_extension(job, &ct) {
            dest_path = d;
            part_path = p;
        }
    }

    // Free-space preflight. This cannot run earlier: there is no byte count on
    // the wire (StreamEntry has no size field), so the first response is the
    // first moment a real number exists.
    if let Some(t) = total {
        let dir = std::path::Path::new(&part_path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        if let Some(free) = crate::download_path::free_bytes_for(&dir) {
            let need = t.saturating_sub(have);
            if free < need.saturating_add(crate::download_path::FREE_SPACE_SLACK) {
                return Outcome::Fatal(format!(
                    "Not enough free space: this needs {} and the drive has {} available.",
                    human(need),
                    human(free)
                ));
            }
        }
    }

    // Open for append at the right offset.
    let mut file = match std::fs::OpenOptions::new().write(true).read(true).open(&part_path) {
        Ok(f) => f,
        Err(e) => return Outcome::Fatal(format!("Could not open the partial file: {e}")),
    };
    if let Err(e) = file.set_len(have).and_then(|_| file.seek(SeekFrom::Start(have)).map(|_| ())) {
        return Outcome::Fatal(format!("Could not position the partial file: {e}"));
    }

    let started_at = have;
    let mut written = have;
    let mut resp = resp;

    loop {
        tokio::select! {
            biased;

            // Control ALWAYS wins. A stalled body must not be able to hold a
            // pause hostage.
            changed = stop.changed() => {
                if changed.is_err() {
                    return Outcome::Transient("The download was interrupted.".into());
                }
                if let Some(reason) = *stop.borrow_and_update() {
                    let _ = file.flush();
                    return Outcome::Stopped(reason);
                }
            }

            chunk = resp.chunk() => {
                match chunk {
                    Ok(Some(bytes)) => {
                        if let Err(e) = file.write_all(&bytes) {
                            return Outcome::Fatal(format!("Could not write to the download folder: {e}"));
                        }
                        written += bytes.len() as u64;
                    }
                    Ok(None) => {
                        let _ = file.flush();
                        // The end of the body is NOT proof of completion.
                        if let Some(t) = total {
                            if written < t {
                                let progressed = written.saturating_sub(started_at);
                                if progressed >= PROGRESS_RESETS_ATTEMPT {
                                    super::manager::reset_attempt(&job.id);
                                }
                                return Outcome::Transient(format!(
                                    "The connection dropped at {} of {}.",
                                    human(written), human(t)
                                ));
                            }
                        }
                        // CLOSE THE HANDLE FIRST. Rust opens files without
                        // FILE_SHARE_DELETE, so on Windows the rename inside
                        // `finish` fails with a sharing violation while this
                        // handle is alive. `return finish(...)` would evaluate
                        // the call BEFORE dropping `file`, so the drop has to
                        // be explicit and has to come first.
                        drop(file);
                        return finish(&dest_path, &part_path);
                    }
                    Err(e) => {
                        let _ = file.flush();
                        let progressed = written.saturating_sub(started_at);
                        if progressed >= PROGRESS_RESETS_ATTEMPT {
                            super::manager::reset_attempt(&job.id);
                        }
                        return Outcome::Transient(format!("The connection dropped: {}", short_err(&e)));
                    }
                }
            }
        }
    }
}

/// Rename the partial onto its final name, claiming a free one first.
///
/// The caller MUST have dropped its handle on the partial: Rust opens files
/// without FILE_SHARE_DELETE, so on Windows the rename below fails with a
/// sharing violation while any handle is still open.
fn finish(dest_path: &str, part_path: &str) -> Outcome {
    let dest = std::path::Path::new(dest_path);
    let Some(dir) = dest.parent() else {
        return Outcome::Fatal("The download destination is not a valid path.".into());
    };
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or(crate::download_path::DEFAULT_EXT)
        .to_string();

    match crate::download_path::finalize(dir, &stem, &ext, std::path::Path::new(part_path)) {
        Ok(final_path) => Outcome::Finished(final_path.to_string_lossy().into_owned()),
        Err(e) => Outcome::Fatal(e),
    }
}

/// reqwest error chains are long and mention internal types. Keep the row
/// legible.
fn short_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "the host stopped responding".into()
    } else if e.is_connect() {
        "could not connect".into()
    } else {
        "network error".into()
    }
}

pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}
