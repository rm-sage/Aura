// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/audio.rs
//
// The process half of skipdetect's ffmpeg plumbing: the probe run (with its
// retry-once policy), one region pass (HEAD or TAIL) streaming PCM from stdout
// while stderr is drained CONCURRENTLY on its own task (a full stderr pipe
// would otherwise stall ffmpeg and deadlock the stdout read), and the theme
// decode that feeds an in-memory .ogg through ffmpeg's stdin.
//
// The argv itself comes from `probe.rs` (pure, unit-tested). The rules it
// keeps are restated here because every spawn goes through this file:
//   * never `-t` (with or without `-copyts`), never `-sseof`;
//   * `-copyts` only together with an INPUT-side `-ss` (TAIL);
//   * `-to` only as HEAD's output bound, where there is no `-copyts`.
//
// PCM is handed to the caller in chunks and never retained here. Every child
// is spawned with `kill_on_drop(true)`, so dropping a pass (a cancelled detect,
// an early HEAD exit) kills ffmpeg. The URL is an argv element only: nothing
// in this file formats it into a message, and stderr lines kept for an error
// report have every URL replaced first (`strip_urls`).

use std::collections::VecDeque;
use std::ffi::OsStr;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdout};
use tokio::task::JoinHandle;

use super::continuity::Silence;
use super::fingerprint::SR;
use super::probe::{self, ProbeFailure, ProbeInfo, SilenceParser};

/// A region pass that delivers no PCM byte for this long is treated as dead
/// (mpv's own `network-timeout` is 60 s; a debrid host can take 30 s or more
/// to mux a fresh chunk).
pub const INACTIVITY: Duration = Duration::from_secs(90);
/// The bounded probe reads at most ~1 MB plus the container header (89.6 MB of
/// fonts on one measured release), so this is generous.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
/// After stdout EOF (or a kill), how long to wait for ffmpeg to exit.
const EXIT_WAIT: Duration = Duration::from_secs(20);
/// One stderr line is never kept longer than this (ffmpeg's `\r` stats lines
/// and attachment metadata can be long).
const STDERR_LINE_CAP: usize = 4096;
/// Redacted stderr lines kept for a failure note.
const STDERR_TAIL: usize = 6;
/// The probe's stderr is kept up to this size (the rest is drained and dropped).
const PROBE_STDERR_CAP: usize = 1 << 20;
/// PCM bytes read per stdout read.
const READ_CHUNK: usize = 64 * 1024;

/// A theme file is at most this large (AnimeThemes audio is 2-4 MB; the
/// longest corpus file, an insert song, is 189 s).
pub const MAX_THEME_BYTES: usize = 16 * 1024 * 1024;
/// Decoded theme PCM is capped at 10 minutes of 11025 Hz mono s16.
const MAX_THEME_PCM_BYTES: usize = 600 * SR as usize * 2;
const THEME_DECODE_TIMEOUT: Duration = Duration::from_secs(60);

/// Replace every URL-looking word with `<url>`. Stricter than the house
/// `redact_urls_in_text` (which keeps the host and readable path segments):
/// nothing of the stream's address survives into a skipdetect note or log.
pub fn strip_urls(text: &str) -> String {
    text.split(' ')
        .map(|w| if w.contains("://") { "<url>" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

fn command(bin: &OsStr) -> tokio::process::Command {
    crate::silencedetect::ffmpeg_command_at(bin)
}

/// `ffmpeg ... -i pipe:0 -vn -ac 1 -ar 11025 -f s16le pipe:1`: decode one
/// in-memory theme file. Measured bit-identical to the reference's file
/// decode (`-i <path> -vn -ac 1 -ar 11025 -c:a pcm_s16le`) on 16 of 16 corpus
/// themes. Only the `pipe` protocol is whitelisted: a theme file can never
/// make ffmpeg open anything else.
pub fn theme_decode_args() -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-protocol_whitelist",
        "pipe",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "11025",
        "-f",
        "s16le",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

// ── stderr ──────────────────────────────────────────────────────────────────

/// What a region pass learns from stderr while it runs.
#[derive(Debug, Default)]
pub struct StderrState {
    /// `pts_time` of the first decoded frame (`ashowinfo`, n:0), raw.
    pub first_pts: Option<f64>,
    pub silences: SilenceParser,
    /// Last few lines, URL-redacted, for a failure note.
    pub tail: VecDeque<String>,
}

impl StderrState {
    /// `rebase` is subtracted from silencedetect times (the container `start:`
    /// on TAIL, which runs with `-copyts`; 0 on HEAD).
    pub fn new(rebase: f64) -> Self {
        Self { first_pts: None, silences: SilenceParser::new(rebase), tail: VecDeque::new() }
    }

    pub fn feed(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        if self.first_pts.is_none() {
            if let Some(p) = probe::parse_first_pts(line) {
                self.first_pts = Some(p);
                return;
            }
        }
        if self.silences.feed(line).is_some() || line.contains("silence_start:") {
            return;
        }
        // Progress lines (`size=... time=...`) are noise for a failure note.
        if line.starts_with("size=") || line.contains(" time=") {
            return;
        }
        if self.tail.len() == STDERR_TAIL {
            self.tail.pop_front();
        }
        self.tail.push_back(strip_urls(line).chars().take(200).collect());
    }
}

/// Splits a byte stream into lines on `\n` OR `\r` (ffmpeg rewrites its
/// progress line with `\r`), each capped at `STDERR_LINE_CAP` bytes.
#[derive(Default)]
struct LineSplitter {
    cur: Vec<u8>,
    overflow: bool,
}

impl LineSplitter {
    fn push(&mut self, bytes: &[u8], mut on_line: impl FnMut(&str)) {
        for &b in bytes {
            if b == b'\n' || b == b'\r' {
                if !self.cur.is_empty() {
                    on_line(&String::from_utf8_lossy(&self.cur));
                }
                self.cur.clear();
                self.overflow = false;
            } else if self.cur.len() < STDERR_LINE_CAP {
                self.cur.push(b);
            } else {
                self.overflow = true;
            }
        }
    }

    fn finish(&mut self, mut on_line: impl FnMut(&str)) {
        if !self.cur.is_empty() {
            on_line(&String::from_utf8_lossy(&self.cur));
        }
        self.cur.clear();
    }
}

/// Drain `r` to EOF, feeding complete lines to `state`.
async fn drain_stderr<R: AsyncRead + Unpin>(mut r: R, state: Arc<Mutex<StderrState>>) {
    let mut sp = LineSplitter::default();
    let mut buf = vec![0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if let Ok(mut st) = state.lock() {
                    sp.push(&buf[..n], |l| st.feed(l));
                }
            }
        }
    }
    if let Ok(mut st) = state.lock() {
        sp.finish(|l| st.feed(l));
    }
}

/// Drain `r` to EOF keeping at most `cap` bytes.
async fn read_capped<R: AsyncRead + Unpin>(mut r: R, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = cap.saturating_sub(out.len());
                out.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    out
}

// ── probe ───────────────────────────────────────────────────────────────────

/// Why a probe gave up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProbeError {
    Spawn(String),
    Timeout,
    /// No audio line. `code` is ffmpeg's exit code; `retried` says whether the
    /// one retry was spent.
    Failed { code: Option<i32>, retried: bool, note: String },
}

impl ProbeError {
    pub fn note(&self) -> String {
        match self {
            ProbeError::Spawn(e) => format!("probe spawn failed: {e}"),
            ProbeError::Timeout => "probe timed out".to_string(),
            ProbeError::Failed { code, retried, note } => {
                format!("probe found no audio (exit {code:?}{}){note}", if *retried { ", after one retry" } else { "" })
            }
        }
    }
}

async fn probe_once(bin: &OsStr, url: &str) -> Result<(Option<i32>, String), ProbeError> {
    let mut cmd = command(bin);
    cmd.args(probe::probe_args(url))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| ProbeError::Spawn(e.kind().to_string()))?;
    let Some(err) = child.stderr.take() else {
        return Err(ProbeError::Spawn("no stderr pipe".into()));
    };
    let run = async {
        let text = read_capped(err, PROBE_STDERR_CAP).await;
        let status = child.wait().await.ok();
        (status.and_then(|s| s.code()), String::from_utf8_lossy(&text).into_owned())
    };
    tokio::time::timeout(PROBE_TIMEOUT, run).await.map_err(|_| ProbeError::Timeout)
}

/// The probe with the spec's failure policy: an HTTP 4xx other than 403 / 404
/// retries ONCE after 1.5 s; 403 / 404, a map error, a second failure or no
/// audio line abstain. Exit 1 with streams listed is the normal result.
pub async fn run_probe(bin: &OsStr, url: &str) -> Result<ProbeInfo, ProbeError> {
    let mut retried = false;
    loop {
        let (code, stderr) = probe_once(bin, url).await?;
        let info = probe::parse_probe(&stderr);
        if !info.audio.is_empty() {
            return Ok(info);
        }
        let policy = probe::classify_probe_failure(code.unwrap_or(0), &stderr);
        if policy == ProbeFailure::RetryOnce && !retried {
            retried = true;
            tokio::time::sleep(Duration::from_millis(probe::PROBE_RETRY_DELAY_MS)).await;
            continue;
        }
        let last = stderr
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with("At least one output"))
            .map(|l| format!(": {}", strip_urls(l).chars().take(160).collect::<String>()))
            .unwrap_or_default();
        return Err(ProbeError::Failed { code, retried, note: last });
    }
}

// ── region pass ─────────────────────────────────────────────────────────────

/// How a region pass ended.
#[derive(Debug, Default)]
pub struct RegionEnd {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub first_pts: Option<f64>,
    pub silences: Vec<Silence>,
    pub tail: Vec<String>,
}

/// One running region pass (HEAD or TAIL).
pub struct RegionPass {
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    state: Arc<Mutex<StderrState>>,
    err_task: Option<JoinHandle<()>>,
    odd: Option<u8>,
    samples: u64,
    buf: Vec<u8>,
}

impl RegionPass {
    /// Spawn ffmpeg with `args` (from `probe::head_args` / `probe::tail_args`).
    pub fn spawn(bin: &OsStr, args: &[String], rebase: f64) -> std::io::Result<Self> {
        let mut cmd = command(bin);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let state = Arc::new(Mutex::new(StderrState::new(rebase)));
        let err_task = child.stderr.take().map(|e| tokio::spawn(drain_stderr(e, state.clone())));
        Ok(Self {
            child: Some(child),
            stdout,
            state,
            err_task,
            odd: None,
            samples: 0,
            buf: vec![0u8; READ_CHUNK],
        })
    }

    /// Samples delivered so far.
    pub fn samples(&self) -> u64 {
        self.samples
    }

    /// The first decoded PTS, once ashowinfo has printed it.
    pub fn first_pts(&self) -> Option<f64> {
        self.state.lock().ok().and_then(|s| s.first_pts)
    }

    /// Next PCM chunk (mono s16 at 11025 Hz). `Ok(None)` at EOF. Errors on a
    /// read failure or `INACTIVITY` without a byte.
    pub async fn next_pcm(&mut self) -> std::io::Result<Option<Vec<i16>>> {
        let Some(out) = self.stdout.as_mut() else { return Ok(None) };
        let n = match tokio::time::timeout(INACTIVITY, out.read(&mut self.buf)).await {
            Ok(r) => r?,
            Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no PCM for 90 s")),
        };
        if n == 0 {
            self.stdout = None;
            return Ok(None);
        }
        let pcm = s16le(&self.buf[..n], &mut self.odd);
        self.samples += pcm.len() as u64;
        Ok(Some(pcm))
    }

    async fn reap(&mut self, killed: bool) -> RegionEnd {
        self.stdout = None;
        let mut end = RegionEnd::default();
        if let Some(mut child) = self.child.take() {
            if killed {
                let _ = child.start_kill();
            }
            match tokio::time::timeout(EXIT_WAIT, child.wait()).await {
                Ok(Ok(st)) => {
                    end.exit_code = st.code();
                    end.success = st.success() && !killed;
                }
                _ => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
        }
        if let Some(t) = self.err_task.take() {
            if tokio::time::timeout(EXIT_WAIT, t).await.is_err() {
                // The JoinHandle was consumed by the timeout; the task ends on
                // its own once the (now dead) process's pipe closes.
            }
        }
        if let Ok(mut st) = self.state.lock() {
            end.first_pts = st.first_pts;
            end.silences = std::mem::take(&mut st.silences.silences);
            end.tail = st.tail.drain(..).collect();
        }
        end
    }

    /// Wait for a pass that reached stdout EOF to exit and collect stderr.
    pub async fn finish(mut self) -> RegionEnd {
        self.reap(false).await
    }

    /// Kill the pass (early exit) and collect what stderr had so far.
    pub async fn kill(mut self) -> RegionEnd {
        self.reap(true).await
    }
}

impl Drop for RegionPass {
    fn drop(&mut self) {
        // The child is killed by kill_on_drop; the stderr task would end on its
        // own when the pipe closes, but abort it so nothing outlives a cancel.
        if let Some(t) = self.err_task.take() {
            t.abort();
        }
    }
}

/// Little-endian s16 bytes to samples, carrying an odd trailing byte over to
/// the next read.
fn s16le(bytes: &[u8], odd: &mut Option<u8>) -> Vec<i16> {
    let mut out = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut rest = bytes;
    if let Some(lo) = odd.take() {
        if let Some((&hi, r)) = rest.split_first() {
            out.push(i16::from_le_bytes([lo, hi]));
            rest = r;
        } else {
            *odd = Some(lo);
            return out;
        }
    }
    let mut it = rest.chunks_exact(2);
    for c in &mut it {
        out.push(i16::from_le_bytes([c[0], c[1]]));
    }
    if let [b] = it.remainder() {
        *odd = Some(*b);
    }
    out
}

// ── theme decode ────────────────────────────────────────────────────────────

/// Decode one theme file (its bytes, in memory) to 11025 Hz mono s16 PCM.
pub async fn decode_theme(bin: &OsStr, bytes: Vec<u8>) -> Result<Vec<i16>, String> {
    let mut cmd = command(bin);
    cmd.args(theme_decode_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("theme decode spawn failed: {}", e.kind()))?;
    let mut stdin = child.stdin.take().ok_or("no stdin pipe")?;
    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let run = async move {
        // Feed stdin and read stdout CONCURRENTLY: ffmpeg blocks on a full
        // stdout pipe long before it has read the whole input.
        let writer = async move {
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
            drop(stdin);
        };
        let reader = async move {
            let mut out = Vec::new();
            let mut r = stdout;
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match r.read(&mut buf).await {
                    Ok(0) => break Ok(out),
                    Ok(n) => {
                        if out.len() + n > MAX_THEME_PCM_BYTES {
                            break Err("theme longer than 10 minutes".to_string());
                        }
                        out.extend_from_slice(&buf[..n]);
                    }
                    Err(e) => break Err(format!("theme decode read failed: {}", e.kind())),
                }
            }
        };
        let ((), pcm) = tokio::join!(writer, reader);
        let pcm = pcm?;
        let status = child.wait().await.map_err(|e| format!("theme decode wait failed: {}", e.kind()))?;
        if !status.success() {
            return Err(format!("theme decode exit {:?}", status.code()));
        }
        let mut odd = None;
        Ok(s16le(&pcm, &mut odd))
    };
    tokio::time::timeout(THEME_DECODE_TIMEOUT, run).await.map_err(|_| "theme decode timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.invalid/x.mkv";

    /// Every argv skipdetect can build obeys the ffmpeg landmines.
    fn check_argv(a: &[String]) {
        let pos = |k: &str| a.iter().position(|x| x == k);
        assert!(pos("-t").is_none(), "-t in {a:?}");
        assert!(a.iter().all(|x| !x.contains("sseof")), "-sseof in {a:?}");
        let i = pos("-i").expect("-i");
        if let Some(c) = pos("-copyts") {
            let ss = pos("-ss").expect("-copyts without -ss");
            assert!(ss < i && c < i, "-copyts needs an INPUT-side -ss: {a:?}");
            assert!(pos("-to").is_none(), "-to with -copyts: {a:?}");
        }
        if let Some(to) = pos("-to") {
            assert!(to > i, "-to must be an output option");
            assert!(pos("-copyts").is_none());
        }
        if let Some(ss) = pos("-ss") {
            assert!(ss < i, "-ss must be an input option");
        }
    }

    #[test]
    fn argv_never_t_never_copyts_without_input_ss() {
        check_argv(&probe::probe_args(URL));
        for n in 0..3 {
            check_argv(&probe::head_args(URL, n));
            for s in [0.0, 970.938, 1234.5] {
                check_argv(&probe::tail_args(URL, n, s));
            }
        }
        check_argv(&theme_decode_args());
        // Every network-facing argv starts with the shared prefix (whitelist).
        for a in [probe::probe_args(URL), probe::head_args(URL, 0), probe::tail_args(URL, 0, 1.0)] {
            assert_eq!(&a[..4], &probe::COMMON_ARGS.map(String::from));
        }
        // The theme decode can open nothing but its pipe.
        let t = theme_decode_args();
        assert!(t.windows(2).any(|w| w[0] == "-protocol_whitelist" && w[1] == "pipe"));
    }

    #[test]
    fn s16_conversion_carries_odd_bytes() {
        let mut odd = None;
        let a = s16le(&[0x01, 0x00, 0xff], &mut odd);
        assert_eq!(a, vec![1]);
        assert_eq!(odd, Some(0xff));
        let b = s16le(&[0x7f], &mut odd);
        assert_eq!(b, vec![i16::from_le_bytes([0xff, 0x7f])]);
        assert_eq!(odd, None);
        assert!(s16le(&[], &mut odd).is_empty());
        let c = s16le(&[0x10], &mut odd);
        assert!(c.is_empty() && odd == Some(0x10));
        assert_eq!(s16le(&[], &mut odd), Vec::<i16>::new());
        assert_eq!(odd, Some(0x10));
    }

    #[test]
    fn stderr_lines_split_on_cr_and_lf() {
        let mut st = StderrState::new(0.0);
        let mut sp = LineSplitter::default();
        let text = b"size=   10kB time=00:00:01.00\rsize=   20kB time=00:00:02.00\r\
[Parsed_ashowinfo_2 @ 0x1] n:0 pts:0 pts_time:0.021 fmt:fltp\n\
[Parsed_silencedetect_4 @ 0x2] silence_start: 3.5\r\n[Parsed_silencedetect_4 @ 0x2] silence_end: 5 | silence_duration: 1.5\n\
[https @ 0x3] HTTP error 403 Forbidden for https://host.invalid/p?token=abc\n";
        // Feed in awkward pieces.
        for piece in text.chunks(7) {
            sp.push(piece, |l| st.feed(l));
        }
        sp.finish(|l| st.feed(l));
        assert_eq!(st.first_pts, Some(0.021));
        assert_eq!(st.silences.silences.len(), 1);
        assert_eq!((st.silences.silences[0].start, st.silences.silences[0].end), (3.5, 5.0));
        assert_eq!(st.tail.len(), 1, "progress lines are not kept: {:?}", st.tail);
        assert!(!st.tail[0].contains("token=abc") && !st.tail[0].contains("host.invalid"), "{:?}", st.tail);
        assert_eq!(strip_urls("open 'https://h.invalid/a?b' failed"), "open <url> failed");
    }

    #[test]
    fn stderr_line_cap() {
        let mut sp = LineSplitter::default();
        let long = vec![b'x'; STDERR_LINE_CAP * 3];
        let mut seen = Vec::new();
        sp.push(&long, |l| seen.push(l.len()));
        sp.push(b"\nab\n", |l| seen.push(l.len()));
        assert_eq!(seen, vec![STDERR_LINE_CAP, 2]);
    }

    fn local_ffmpeg() -> std::ffi::OsString {
        std::env::var_os("AURA_FFMPEG").unwrap_or_else(|| {
            let la = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
            std::path::PathBuf::from(la).join("com.aura.app").join("runtime").join("ffmpeg.exe").into_os_string()
        })
    }

    /// The region graph on a synthetic source: 20 s of tone with a 2 s gap.
    fn lavfi_region_args() -> Vec<String> {
        let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-f", "lavfi", "-i"].iter().map(|s| s.to_string()).collect();
        a.push("sine=frequency=440:sample_rate=48000:duration=20,volume='if(between(t,8,10),0,1)':eval=frame".into());
        a.extend(["-filter_complex".to_string(), probe::region_graph(0)]);
        a.extend(["-map", "[o]", "-ac", "1", "-to", "600", "-f", "s16le", "pipe:1"].map(String::from));
        a
    }

    #[tokio::test]
    #[ignore = "needs the runtime-deps ffmpeg"]
    async fn region_pass_on_synthetic_audio() {
        let ff = local_ffmpeg();
        let mut p = RegionPass::spawn(&ff, &lavfi_region_args(), 0.0).unwrap();
        let mut n = 0usize;
        while let Some(c) = p.next_pcm().await.unwrap() {
            n += c.len();
        }
        let end = p.finish().await;
        assert!(end.success, "exit {:?} {:?}", end.exit_code, end.tail);
        assert_eq!(end.first_pts, Some(0.0));
        assert!((n as f64 / SR as f64 - 20.0).abs() < 0.05, "{n} samples");
        assert_eq!(end.silences.len(), 1, "{:?}", end.silences);
        assert!((end.silences[0].start - 8.0).abs() < 0.05 && (end.silences[0].end - 10.0).abs() < 0.05);
        // A kill mid-stream reaps the child and keeps what stderr had.
        let mut p = RegionPass::spawn(&ff, &lavfi_region_args(), 0.0).unwrap();
        let _ = p.next_pcm().await.unwrap();
        let end = p.kill().await;
        assert!(!end.success);
        // Theme decode through stdin of a WAV made in memory.
        let pcm: Vec<i16> = (0..SR as usize * 2).map(|i| ((i as f64 * 0.05).sin() * 8000.0) as i16).collect();
        let mut wav = Vec::new();
        let data_len = (pcm.len() * 2) as u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&SR.to_le_bytes());
        wav.extend_from_slice(&(SR * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for s in &pcm {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        let back = decode_theme(&ff, wav).await.unwrap();
        assert_eq!(back, pcm, "11025 Hz mono s16 in, identical PCM out");
        assert!(decode_theme(&ff, b"not audio at all".to_vec()).await.is_err());
    }

    #[test]
    fn tail_silences_are_rebased() {
        let mut st = StderrState::new(0.5);
        st.feed("[Parsed_silencedetect_4 @ 0x1] silence_start: 1000.5");
        st.feed("[Parsed_silencedetect_4 @ 0x1] silence_end: 1002 | silence_duration: 1.5");
        assert_eq!(st.silences.silences[0].start, 1000.0);
        assert_eq!(st.silences.silences[0].end, 1001.5);
    }
}
