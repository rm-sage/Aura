// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Live Subtitle Sync: the cue-list supplier.
//!
//! The player panel shows the subtitle LINES around the current playback
//! position; the user clicks the line they just heard and Aura derives the
//! subtitle delay from the gap between that cue's RAW file time and the
//! playback clock. This module only sources the cues. Applying the delay is
//! `set_subtitle_delay` in lib.rs, so there is deliberately NO mpv property
//! code in here.
//!
//! Two tiers, deliberately different code paths:
//!
//! TIER A - external tracks (`parse_subtitle_cues`). The text is already ours:
//! either a file `subtitles.rs` downloaded into `app_data_dir()/subtitles`
//! (OpenSubtitles) or an https `.srt` / `.vtt` URL handed over by a Stremio
//! addon. Fetch or read the bytes, sniff the format from the CONTENT, parse in
//! pure Rust. Nothing in Aura's pipeline normalises subtitle formats (the
//! downloader writes whatever byte stream the server sent), so an "it is a
//! .srt" assumption breaks on real files: SRT, WebVTT and ASS/SSA are all
//! handled, and the extension is never trusted.
//!
//! TIER B - embedded tracks (`extract_embedded_cues`). The text lives inside
//! the mkv/mp4 and we have to ask ffmpeg for it. A full-file extraction would
//! make ffmpeg demux the WHOLE container: on a remote 20 GB debrid mkv that is
//! minutes of wall time and a full re-download of the file, on the same link
//! the player is already streaming. Unshippable. So we extract a WINDOW around
//! the current playback position instead: the user is identifying "the line I
//! just heard", which needs a couple of minutes of cues, not the episode.
//! `-ss` before `-i` makes it a fast input seek, and `-copyts` is what keeps
//! the emitted timestamps ABSOLUTE (without it every cue comes back relative to
//! the window start and every computed delay is silently wrong). The slice is
//! bounded with `-to` (an absolute end time), NOT `-t`: under `-copyts` ffmpeg
//! measures a `-t` duration against the copied absolute timestamps, so `-t`
//! silently means `-to` and any window starting past it emits nothing at all.
//!
//! `probe_subtitle_streams` (ffprobe) is the bridge between the two: it maps
//! mpv's track ids onto ffmpeg's subtitle-relative index (the N in `-map
//! 0:s:N`) and flags BITMAP subtitle codecs, which can never yield text without
//! OCR and so must not be offered in the panel at all.
//!
//! Degradation: ffmpeg / ffprobe are on-demand runtime deps (`runtime_deps.rs`)
//! and may simply be absent. Tier B then returns a clear Err naming the missing
//! binary; it never panics, and Tier A keeps working regardless.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Bounds. Standing project rule: never ship an unbounded buffer / cache.
// ---------------------------------------------------------------------------

/// Hard cap on any subtitle payload we will hold in memory, whether read off
/// disk, streamed from an https URL, or piped out of ffmpeg. A real subtitle
/// file is tens of KB; 8 MiB is already absurdly generous and exists purely so
/// a mislabelled / hostile URL cannot balloon the process.
const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;

/// Hard cap on the cue count handed back to the webview. A movie is ~1 500
/// cues, an episode ~300. Anything past this is a concatenated monster; see
/// [`cap_cues`] for which 5 000 survive.
const MAX_CUES: usize = 5_000;

/// Extraction window bounds (seconds of media around the playback position).
const MIN_WINDOW_SECS: f64 = 30.0;
const MAX_WINDOW_SECS: f64 = 900.0;

/// Subprocess wall-clock ceilings. ffmpeg has to open the remote container and
/// demux the window, so it gets more room than ffprobe's metadata-only read.
/// Neither is ever allowed to hang the app: on timeout the child is killed.
// Generous, because the input is a REMOTE debrid mkv that the player is already
// streaming on the same link. Before ffmpeg can seek at all it has to open the
// URL, negotiate TLS, and fetch the Matroska Cues index, which for a large file
// lives at the END: that is a second range request against a host that may well
// be throttling us because mpv holds a connection too. 25 s was not enough for a
// real remux and users just saw "ffmpeg timed out".
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(90);
const FFPROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on the subtitle streams reported by a single probe. A sane container
/// has a handful; the cap keeps a pathological file from producing a huge list.
const MAX_PROBED_STREAMS: usize = 64;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
pub struct SubCue {
    /// Cue start in seconds (RAW file time, never delay-shifted). The whole
    /// point of the feature is to diff this against the playback clock, so it
    /// must stay exactly what the file said.
    pub start: f64,
    /// Cue end in seconds. Always >= start.
    pub end: f64,
    /// Plain text, all markup stripped (SRT/VTT tags, ASS `{\...}` override
    /// blocks and `\N` / `\h` escapes), newlines collapsed to a single space.
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProbedSubStream {
    /// Subtitle-relative index: the N in `-map 0:s:N`.
    pub sub_index: u32,
    pub codec: String,
    pub language: String,
    pub title: String,
    /// True for image-based subs (hdmv_pgs_subtitle, dvd_subtitle,
    /// dvb_subtitle, xsub). These can never yield text without OCR.
    pub is_bitmap: bool,
}

/// Image-based subtitle codecs. ffmpeg cannot transcode these to text at all
/// ("subtitle encoding currently only possible from text to text or bitmap to
/// bitmap"), so the panel must exclude them rather than run a doomed extract.
const BITMAP_CODECS: &[&str] = &[
    "hdmv_pgs_subtitle",
    "dvd_subtitle",
    "dvb_subtitle",
    "xsub",
];

fn codec_is_bitmap(codec: &str) -> bool {
    let c = codec.trim().to_ascii_lowercase();
    BITMAP_CODECS.contains(&c.as_str())
}

// ---------------------------------------------------------------------------
// HTTP client (external-subtitle fetch)
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(HTTP_TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura subsync")
            .build()
            .expect("subsync HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Binary resolution (mirrors silencedetect::ffmpeg_bin)
// ---------------------------------------------------------------------------

/// Resolve an ffmpeg-family binary. Candidate order, first existing wins:
///   1. `AURA_FFMPEG` / `AURA_FFPROBE` env override (power users / CI).
///   2. The on-demand download dir (`runtime_deps`) - survives app updates.
///   3. `<resource_dir>/lib/<name>`       - bundled / installed.
///   4. `<exe_dir>/lib/<name>`            - portable layout.
///   5. `<CARGO_MANIFEST_DIR>/lib/<name>` - `tauri dev`.
/// Falls back to the bare name so a system install on PATH still works. When
/// nothing resolves, the spawn fails with NotFound and the caller turns that
/// into a clear "download ffmpeg" error rather than crashing.
fn tool_bin<R: Runtime>(app: &AppHandle<R>, name: &str, env_key: &str) -> std::ffi::OsString {
    if let Ok(p) = std::env::var(env_key) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return pb.into_os_string();
        }
    }
    if let Some(p) = crate::runtime_deps::resolved_path(name) {
        return p.into_os_string();
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("lib").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("lib").join(name));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib").join(name));

    for c in candidates {
        if c.is_file() {
            return c.into_os_string();
        }
    }
    // PATH fallback (bare name, no `.exe` on non-Windows).
    std::ffi::OsString::from(name.trim_end_matches(".exe"))
}

/// Build a subprocess [`Command`] with its console window suppressed.
///
/// Aura is a GUI app with no console of its own. Without CREATE_NO_WINDOW
/// (0x08000000) every ffmpeg/ffprobe spawn pops a visible console window for
/// the life of the process, which looks alarming to users. Every spawn in this
/// module goes through here so the flag cannot be forgotten at a call site.
fn tool_command<R: Runtime>(app: &AppHandle<R>, name: &str, env_key: &str) -> Command {
    let mut cmd = Command::new(tool_bin(app, name, env_key));
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn missing_tool_err(name: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!(
            "{name} is not installed. It is an on-demand runtime dependency: \
             download it (Settings > Components) and try again."
        )
    } else {
        format!("{name} could not be started: {e}")
    }
}

/// Media URLs reach ffmpeg/ffprobe on `-i`, which honours pseudo-protocols
/// (`concat:`, `subfile:`, plain local paths). Aura only ever plays remote
/// http(s) streams, so anything else is rejected at source. Note the asymmetry
/// with the external-subtitle fetch below: THAT one is https-only (it goes
/// through reqwest with `https_only(true)`), while a media URL may legitimately
/// be plain http - the in-process bridge on `127.0.0.1:11471` serves one.
fn guard_media_url(url: &str) -> Result<(), String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(())
    } else {
        Err("only http(s) media URLs are supported".to_string())
    }
}

// ---------------------------------------------------------------------------
// Byte decoding
// ---------------------------------------------------------------------------

/// Decode subtitle bytes to text, defensively.
///
/// Subtitle files in the wild are frequently NOT UTF-8: Windows-1252 and
/// Latin-1 are everywhere (a Spanish or French .srt from a 2009 release group
/// is usually cp1252). `String::from_utf8` on those returns Err, and erroring
/// out would blank the whole sync panel over a couple of accented characters.
/// So: strip a BOM if present, decode UTF-16 properly when its BOM says so, and
/// otherwise fall back to a LOSSY UTF-8 decode. A cp1252 file then yields
/// readable lines with the odd U+FFFD where an accent was, which is exactly the
/// tradeoff we want (the user is matching a line by eye, not proofreading it).
fn decode_subtitle_bytes(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn ensure_within_cap(len: usize, what: &str) -> Result<(), String> {
    if len > MAX_SUBTITLE_BYTES {
        return Err(format!(
            "{what} is {} bytes, over the {} MiB subtitle cap",
            len,
            MAX_SUBTITLE_BYTES / (1024 * 1024),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/// Drop `<i>`, `<b>`, `<font color="#fff">`, `<v Roger>`, `<c.yellow>` and the
/// inline `<00:01:02.000>` karaoke timestamps that WebVTT allows.
///
/// A `<` only opens a tag if it actually CLOSES. Subtitle dialogue genuinely
/// contains bare angle brackets ("if x < 5", "<<sigh>>", a stray "<" from a bad
/// OCR), and the previous depth-counting version treated the first unbalanced
/// `<` as an unterminated tag and silently ate the entire rest of the line.
fn strip_angle_tags(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '<' {
            // A tag only OPENS when a tag-name character follows: a letter or
            // digit (`<i>`, `<font ...>`, `<00:01:02.000>`), or a slash (`</i>`).
            // "if x < 5" has a space after the bracket, so it is arithmetic, not
            // markup. Requiring this is what stops "5 < 6 and 7 > 2" from being
            // read as one big tag and eaten.
            let opens_tag = chars
                .get(i + 1)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '/');
            if opens_tag {
                if let Some(close) = chars[i + 1..].iter().position(|&c| c == '>') {
                    i += close + 2; // skip the whole `<...>` span
                    continue;
                }
            }
            // Not a tag (or never closed): literal text.
            out.push('<');
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Drop ASS `{\pos(120,45)\i1}` override blocks. Also applied to SRT/VTT: files
/// converted from .ass regularly leak `{\an8}` into the text.
fn strip_braced_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '{' {
            for c2 in chars.by_ref() {
                if c2 == '}' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// ASS escapes: `\N` (hard break), `\n` (soft break), `\h` (non-breaking
/// space). All become a plain space; the caller collapses runs afterwards.
fn unescape_ass(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('N') | Some('n') | Some('h') => {
                    chars.next();
                    out.push(' ');
                }
                _ => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// The handful of entities that actually show up in SRT/VTT payloads.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    // &amp; is decoded LAST so "&amp;lt;" does not turn into "<".
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// Collapse every run of whitespace (including the newlines that separate a
/// cue's own lines) into one space, and trim.
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, word) in s.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

fn clean_timed_text(raw: &str) -> String {
    collapse_ws(&decode_entities(&unescape_ass(&strip_braced_blocks(&strip_angle_tags(raw)))))
}

fn clean_ass_text(raw: &str) -> String {
    collapse_ws(&unescape_ass(&strip_braced_blocks(raw)))
}

/// True when an ASS line is a DRAWING (a `{\p1}`-guarded vector shape used for
/// typesetting / signs), not dialogue. Its "text" is a stream of coordinates
/// like `m 0 0 l 100 0 100 50`, which would be noise in the picker. `\pos(...)`
/// is not a false positive: the char after `\p` there is `o`, not a digit.
fn ass_is_drawing(s: &str) -> bool {
    let b = s.as_bytes();
    let mut in_block = false;
    for i in 0..b.len() {
        match b[i] {
            b'{' => in_block = true,
            b'}' => in_block = false,
            b'\\' if in_block => {
                if i + 2 < b.len()
                    && (b[i + 1] == b'p' || b[i + 1] == b'P')
                    && b[i + 2].is_ascii_digit()
                    && b[i + 2] != b'0'
                {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Parse `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm` (WebVTT drops the hour) and
/// ASS's `H:MM:SS.cc`. The ASS "centiseconds" field needs no special case: `.18`
/// read as a decimal fraction of a second IS 18 cs.
fn parse_timestamp(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    let norm = t.replace(',', ".");
    let mut parts: Vec<&str> = norm.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let secs: f64 = parts.pop()?.trim().parse().ok()?;
    let mut total = secs;
    let mut mult = 60.0_f64;
    while let Some(p) = parts.pop() {
        let v: f64 = p.trim().parse().ok()?;
        total += v * mult;
        mult *= 60.0;
    }
    if !total.is_finite() || total < 0.0 {
        return None;
    }
    Some(total)
}

/// Parse a `... --> ...` cue-timing line. Tolerates a stray index on the left
/// (some malformed SRTs put it on the same line) and WebVTT cue settings on the
/// right (`line:80% align:middle`).
fn parse_arrow_line(line: &str) -> Option<(f64, f64)> {
    let (lhs, rhs) = line.split_once("-->")?;
    let start = parse_timestamp(lhs.split_whitespace().next_back()?)?;
    let end = parse_timestamp(rhs.split_whitespace().next()?)?;
    Some((start, end))
}

// ---------------------------------------------------------------------------
// Parsers (pure - no AppHandle, so the tests can call them directly)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubFormat {
    Srt,
    Vtt,
    Ass,
}

/// Sniff the format from the CONTENT. The extension lies constantly: Aura never
/// normalises subtitle formats, so an OpenSubtitles "srt" download can be an
/// ASS file and an addon's `.srt` URL can serve WebVTT.
fn sniff_format(text: &str) -> SubFormat {
    let head: String = text.chars().take(4096).collect::<String>().to_ascii_lowercase();
    let trimmed = head.trim_start();
    if trimmed.starts_with("webvtt") {
        return SubFormat::Vtt;
    }
    if head.contains("[script info]") || head.contains("[events]") {
        return SubFormat::Ass;
    }
    SubFormat::Srt
}

fn is_index_line(l: &str) -> bool {
    let t = l.trim();
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

fn push_cue(out: &mut Vec<SubCue>, start: f64, end: f64, text: String) {
    if text.is_empty() {
        return;
    }
    out.push(SubCue { start, end, text });
}

/// SRT. Tolerates CRLF, `.` as the millisecond separator, missing index
/// numbers, and stray blank lines: the only thing we key on is the `-->` line,
/// everything up to the next blank / index+arrow pair is the cue text.
fn parse_srt(text: &str) -> Vec<SubCue> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut out: Vec<SubCue> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let Some((start, end)) = parse_arrow_line(lines[i]) else {
            i += 1;
            continue;
        };
        i += 1;
        let mut buf: Vec<&str> = Vec::new();
        while i < lines.len() {
            let l = lines[i];
            if l.trim().is_empty() {
                i += 1;
                break;
            }
            // The next cue can start without a preceding blank line: either an
            // index line followed by an arrow line, or a bare arrow line.
            if l.contains("-->") {
                break;
            }
            if is_index_line(l) && lines.get(i + 1).is_some_and(|n| n.contains("-->")) {
                break;
            }
            buf.push(l);
            i += 1;
        }
        push_cue(&mut out, start, end, clean_timed_text(&buf.join("\n")));
    }
    out
}

/// WebVTT. Skips the `WEBVTT` header (which may carry a trailing description),
/// optional cue ids, and whole `NOTE` / `STYLE` / `REGION` blocks. Hourless
/// timestamps (`MM:SS.mmm`) are handled by [`parse_timestamp`].
fn parse_vtt(text: &str) -> Vec<SubCue> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut out: Vec<SubCue> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let t = lines[i].trim_start_matches('\u{feff}').trim();
        if t.is_empty() {
            i += 1;
            continue;
        }
        let upper = t.to_ascii_uppercase();
        if upper.starts_with("WEBVTT") {
            i += 1;
            continue;
        }
        // Comment / styling blocks run to the next blank line. They are skipped
        // wholesale rather than line-by-line because a NOTE body is free text
        // and could itself contain an "-->" that would otherwise be parsed as a
        // cue.
        let is_block_header = |kw: &str| upper == kw || upper.starts_with(&format!("{kw} "));
        if is_block_header("NOTE") || is_block_header("STYLE") || is_block_header("REGION") {
            i += 1;
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        let Some((start, end)) = parse_arrow_line(t) else {
            // A cue id (or junk) - the timing line is next.
            i += 1;
            continue;
        };
        i += 1;
        let mut buf: Vec<&str> = Vec::new();
        while i < lines.len() {
            let l = lines[i];
            if l.trim().is_empty() || l.contains("-->") {
                break;
            }
            buf.push(l);
            i += 1;
        }
        push_cue(&mut out, start, end, clean_timed_text(&buf.join("\n")));
    }
    out
}

/// ASS / SSA. The `[Events]` section declares its own column order in a
/// `Format:` line, and real files DO reorder it, so the field positions are read
/// from that header rather than hardcoded. Only `Dialogue:` lines are cues
/// (`Comment:` lines are not).
///
/// Per the ASS spec, Text is the LAST field precisely because it may contain
/// commas; splitting keeps the remainder intact in that case. If a file moves
/// Text out of last position (malformed), its unescaped commas are unrecoverable
/// by ANY parser, and we simply take the field at its declared position.
fn parse_ass(text: &str) -> Vec<SubCue> {
    let mut out: Vec<SubCue> = Vec::new();
    let mut in_events = false;
    let mut fields: Vec<String> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            in_events = line.eq_ignore_ascii_case("[events]");
            fields.clear();
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(rest) = strip_prefix_ci(line, "Format:") {
            fields = rest
                .split(',')
                .map(|f| f.trim().to_ascii_lowercase())
                .collect();
            continue;
        }
        let Some(rest) = strip_prefix_ci(line, "Dialogue:") else {
            continue;
        };
        if fields.is_empty() {
            // No Format line seen yet: fall back to the canonical V4+ order.
            fields = [
                "layer", "start", "end", "style", "name", "marginl", "marginr", "marginv",
                "effect", "text",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
        }
        let idx = |name: &str| fields.iter().position(|f| f == name);
        let (Some(i_start), Some(i_end), Some(i_text)) =
            (idx("start"), idx("end"), idx("text"))
        else {
            continue;
        };
        // splitn(n) leaves the final part holding every remaining comma, which is
        // what preserves a Text field containing commas.
        let parts: Vec<&str> = rest.splitn(fields.len(), ',').collect();
        if parts.len() < fields.len() {
            continue;
        }
        let (Some(start), Some(end)) = (
            parse_timestamp(parts[i_start]),
            parse_timestamp(parts[i_end]),
        ) else {
            continue;
        };
        let body = parts[i_text];
        if ass_is_drawing(body) {
            continue;
        }
        push_cue(&mut out, start, end, clean_ass_text(body));
    }
    out
}

/// Case-insensitive prefix strip. Uses `get(..n)` rather than `[..n]` because a
/// line can start with a multi-byte character and slicing mid-codepoint panics.
fn strip_prefix_ci<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let head = line.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        line.get(prefix.len()..)
    } else {
        None
    }
}

/// Drop empty / zero-length cues, force `end >= start`, sort by start, cap.
fn finalize_cues(mut cues: Vec<SubCue>) -> Vec<SubCue> {
    cues.retain(|c| !c.text.is_empty() && c.start.is_finite() && c.end.is_finite());
    for c in cues.iter_mut() {
        if c.end < c.start {
            // A file that gives end < start is corrupt for that cue; clamping to
            // a zero-length cue is dropped by the retain below.
            c.end = c.start;
        }
    }
    cues.retain(|c| c.end > c.start);
    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    cap_cues(cues)
}

/// Keep the 5 000 cues NEAREST THE MIDDLE of the file rather than the first
/// 5 000. Over-cap files are effectively always concatenations (a dual-language
/// dump, or a whole season in one file); the middle is the least-bad blind guess
/// when we have no playback position to centre on, and the caller re-queries with
/// the embedded path when it needs a specific window.
fn cap_cues(mut cues: Vec<SubCue>) -> Vec<SubCue> {
    if cues.len() <= MAX_CUES {
        return cues;
    }
    let excess = cues.len() - MAX_CUES;
    let head = excess / 2;
    cues.drain(..head);
    cues.truncate(MAX_CUES);
    cues
}

/// Sniff + dispatch + normalise. The single entry point for every text payload,
/// whatever its origin (disk, https, or ffmpeg's stdout).
fn parse_cues(text: &str) -> Vec<SubCue> {
    let cues = match sniff_format(text) {
        SubFormat::Vtt => parse_vtt(text),
        SubFormat::Ass => parse_ass(text),
        SubFormat::Srt => parse_srt(text),
    };
    finalize_cues(cues)
}

// ---------------------------------------------------------------------------
// Source resolution (external tier)
// ---------------------------------------------------------------------------

/// Path containment, lifted from `subtitles.rs::add_subtitle_to_mpv`.
///
/// A local subtitle path must canonicalize to somewhere INSIDE
/// `app_data_dir()/subtitles` - the only directory `download_subtitle` ever
/// writes to. Without this a renderer-side bug or a malicious addon could hand
/// us `C:\Users\...\id_rsa` and have us read it back into the webview as
/// "subtitle lines". canonicalize() resolves `..` before the check, so traversal
/// is covered; `file://`, UNC shares and bare drive letters are rejected outright.
fn resolve_local_source<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<PathBuf, String> {
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("file://") {
        return Err("file:// URLs are not allowed".to_string());
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err("UNC paths are not allowed".to_string());
    }
    let subs_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("subtitles");
    // Mirror subtitles_dir(): make sure the root exists so canonicalize can
    // resolve it even before the first OpenSubtitles download.
    std::fs::create_dir_all(&subs_root).map_err(|e| e.to_string())?;

    let canon_root = std::fs::canonicalize(&subs_root)
        .map_err(|e| format!("subtitle root not initialised: {e}"))?;
    let canon_path =
        std::fs::canonicalize(path).map_err(|e| format!("subtitle path not found: {e}"))?;
    if !canon_path.starts_with(&canon_root) {
        return Err("subtitle path is outside the allowed downloads directory".to_string());
    }
    Ok(canon_path)
}

/// Stream an https subtitle down, enforcing the byte cap AS WE GO. The body is
/// never buffered unbounded: a Content-Length over the cap fails immediately,
/// and a chunked / lying response is cut off the moment the accumulated bytes
/// cross it.
async fn fetch_remote_subtitle(url: &str) -> Result<Vec<u8>, String> {
    let mut resp = client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("subtitle fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("subtitle HTTP error: {e}"))?;

    if let Some(len) = resp.content_length() {
        ensure_within_cap(len as usize, "subtitle response")?;
    }

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("subtitle read failed: {e}"))?
    {
        ensure_within_cap(buf.len() + chunk.len(), "subtitle response")?;
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Parse cues from an external subtitle source: a LOCAL PATH (must resolve
/// inside `app_data_dir()/subtitles`) or an https URL. The format is sniffed
/// from the content, not the extension (the extension lies).
#[tauri::command]
pub async fn parse_subtitle_cues<R: Runtime>(
    app: AppHandle<R>,
    source: String,
) -> Result<Vec<SubCue>, String> {
    let src = source.trim().to_string();
    if src.is_empty() {
        return Err("parse_subtitle_cues: empty source".to_string());
    }

    let bytes: Vec<u8> = if src.starts_with("https://") {
        fetch_remote_subtitle(&src).await?
    } else if src.starts_with("http://") {
        // The HTTP client is https_only(true) and Aura does not ship a
        // plaintext fallback (every one removed followed a real wire-capture
        // incident). Say so plainly instead of leaking a reqwest scheme error.
        return Err("plain-HTTP subtitle URLs are not supported (https only)".to_string());
    } else {
        let path = resolve_local_source(&app, &src)?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("subtitle stat failed: {e}"))?;
        ensure_within_cap(meta.len() as usize, "subtitle file")?;
        std::fs::read(&path).map_err(|e| format!("subtitle read failed: {e}"))?
    };

    ensure_within_cap(bytes.len(), "subtitle payload")?;
    let text = decode_subtitle_bytes(&bytes);
    let format = sniff_format(&text);
    let cues = parse_cues(&text);
    crate::devlog!(
        info, "subsync",
        "external: {} cue(s) from {:?} ({} bytes) src={}",
        cues.len(),
        format,
        bytes.len(),
        src.chars().take(80).collect::<String>(),
    );
    if cues.is_empty() {
        return Err("no subtitle cues could be parsed from that source".to_string());
    }
    Ok(cues)
}

/// Extract cues for an EMBEDDED subtitle stream by running ffmpeg over a time
/// window of the media. `sub_index` is the SUBTITLE-RELATIVE stream index
/// (0 = first subtitle stream), which is what `-map 0:s:<n>` takes.
/// `around_seconds` centres the window; `window_seconds` is its total width.
///
/// Windowed on purpose: a full-file extract on a remote 20 GB mkv forces ffmpeg
/// to demux the entire container (minutes of wall time, a full re-download on
/// the same debrid link the player is streaming). See the module doc.
#[tauri::command]
pub async fn extract_embedded_cues<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    sub_index: u32,
    around_seconds: f64,
    window_seconds: f64,
) -> Result<Vec<SubCue>, String> {
    guard_media_url(&url)?;

    let around = if around_seconds.is_finite() {
        around_seconds.max(0.0)
    } else {
        0.0
    };
    let window = if window_seconds.is_finite() {
        window_seconds.clamp(MIN_WINDOW_SECS, MAX_WINDOW_SECS)
    } else {
        MIN_WINDOW_SECS * 4.0
    };
    let start = (around - window / 2.0).max(0.0);

    // `-ss` BEFORE `-i` is the fast INPUT seek (ffmpeg jumps via the container
    // index / byte range instead of decoding from zero). `-copyts` keeps the
    // input timestamps, so the emitted SRT carries ABSOLUTE cue times; without
    // it every cue would come back relative to the window start and every delay
    // the user computes would be silently wrong.
    //
    // BOUND THE SLICE WITH `-to`, NOT `-t`. Under `-copyts` ffmpeg measures the
    // recording limit against the ABSOLUTE (copied) timestamps, so `-t` behaves
    // exactly like `-to`: `-ss 330 -copyts -t 300` asks for "stop once the
    // timestamp reaches 300", which is already in the past at the seek point, so
    // ffmpeg writes ZERO bytes. Measured against the real ffmpeg.exe: `-ss 330
    // -copyts -t 300` -> 0 bytes; `-ss 330 -copyts -to 630` -> the correct
    // window. With `-t` this whole feature was dead for any playhead past
    // roughly 7m30s.
    let end = start + window;
    let mut cmd = tool_command(&app, "ffmpeg.exe", "AURA_FFMPEG");
    cmd.arg("-hide_banner")
        .arg("-nostdin")
        // MANDATORY: Aura plays remote https debrid streams and ffmpeg refuses
        // them without an explicit whitelist. Do not revert. It doubles as the
        // guard that keeps `-i` off local-file / concat: / subfile: reads.
        .arg("-protocol_whitelist")
        .arg("http,https,tcp,tls,crypto")
        // Cap the OPENING probe. By default ffmpeg will read and analyse a large
        // prefix of the input before it does anything, which over HTTP is a real
        // download against a link the player is already saturating. We only need
        // the stream layout, and the container header carries that.
        .arg("-probesize")
        .arg("5M")
        .arg("-analyzeduration")
        .arg("5M")
        .arg("-ss")
        .arg(format!("{start:.3}"))
        .arg("-copyts")
        .arg("-i")
        .arg(&url)
        .arg("-to")
        .arg(format!("{end:.3}"))
        .arg("-map")
        .arg(format!("0:s:{sub_index}"))
        // Subtitles only: never let ffmpeg touch the video or audio streams.
        .arg("-vn")
        .arg("-an")
        .arg("-f")
        .arg("srt")
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    // Log the exact slice we are asking for. When a remote extraction is slow or
    // empty, the first question is always "what did we actually run", and the
    // answer needs to be in the DevConsole, not reconstructed from memory.
    crate::devlog!(
        info, "subsync",
        "embedded: ffmpeg -ss {start:.3} -copyts -to {end:.3} -map 0:s:{sub_index} (window {window:.0}s)"
    );
    let started = std::time::Instant::now();

    let mut child = cmd
        .spawn()
        .map_err(|e| missing_tool_err("ffmpeg", &e))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture ffmpeg stdout".to_string())?;

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let read = async {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let n = stdout
                .read(&mut chunk)
                .await
                .map_err(|e| format!("ffmpeg read failed: {e}"))?;
            if n == 0 {
                break;
            }
            ensure_within_cap(buf.len() + n, "ffmpeg subtitle output")?;
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok::<(), String>(())
    };

    let timed = tokio::time::timeout(FFMPEG_TIMEOUT, read).await;
    // Always tear the child down: on the happy path it has already exited, on a
    // timeout / cap breach this is what stops it hammering the stream.
    let _ = child.kill().await;
    let _ = child.wait().await;

    match timed {
        Err(_) => {
            crate::devlog!(
                warn, "subsync",
                "embedded: ffmpeg timed out after {}s (read {} bytes). The source is remote and the \
                 player is streaming the same link; an external subtitle is the reliable path here.",
                FFMPEG_TIMEOUT.as_secs(), buf.len()
            );
            return Err(format!(
                "Could not read this track in time ({} s). The file is being streamed remotely, and \
                 pulling subtitles out of the container competes with playback for the same link. \
                 Loading an external subtitle instead will work.",
                FFMPEG_TIMEOUT.as_secs()
            ));
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }

    let text = decode_subtitle_bytes(&buf);
    // ffmpeg emits SRT (we asked for `-f srt`), but route it through the same
    // sniff + parse path anyway so there is exactly one parser to maintain.
    let cues = parse_cues(&text);
    crate::devlog!(
        info, "subsync",
        "embedded: {} cue(s) from 0:s:{} window {:.0}-{:.0}s ({} bytes) in {:.1}s",
        cues.len(),
        sub_index,
        start,
        start + window,
        buf.len(),
        started.elapsed().as_secs_f64(),
    );
    if cues.is_empty() {
        return Err(
            "no text cues in that window. The track may be bitmap-based (PGS / VobSub), \
             the index may be wrong, or the window may fall in a silent stretch."
                .to_string(),
        );
    }
    Ok(cues)
}

/// Enumerate the container's subtitle streams via ffprobe, so the caller can map
/// mpv's track id onto ffmpeg's subtitle-relative index and can detect BITMAP
/// subtitle codecs before offering the track in the panel.
#[tauri::command]
pub async fn probe_subtitle_streams<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<Vec<ProbedSubStream>, String> {
    guard_media_url(&url)?;

    let mut cmd = tool_command(&app, "ffprobe.exe", "AURA_FFPROBE");
    cmd.arg("-hide_banner")
        .arg("-v")
        .arg("quiet")
        // Bound every protocol read at 15 s (microseconds) so a stalled upstream
        // cannot wedge the probe even before our own timeout fires.
        .arg("-rw_timeout")
        .arg("15000000")
        .arg("-protocol_whitelist")
        .arg("http,https,tcp,tls,crypto")
        .arg("-print_format")
        .arg("json")
        .arg("-show_streams")
        .arg("-select_streams")
        .arg("s")
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| missing_tool_err("ffprobe", &e))?;

    // On timeout the future is dropped, which drops the Child, which (via
    // kill_on_drop) kills the process. Nothing is left hanging.
    let out = match tokio::time::timeout(FFPROBE_TIMEOUT, child.wait_with_output()).await {
        Err(_) => {
            crate::devlog!(warn, "subsync", "probe: ffprobe timed out");
            return Err(format!(
                "ffprobe timed out after {} s probing the container",
                FFPROBE_TIMEOUT.as_secs()
            ));
        }
        Ok(Err(e)) => return Err(format!("ffprobe failed: {e}")),
        Ok(Ok(o)) => o,
    };

    ensure_within_cap(out.stdout.len(), "ffprobe output")?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("ffprobe returned unparseable JSON: {e}"))?;
    let streams = json
        .get("streams")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ffprobe returned no streams".to_string())?;

    // `-select_streams s` already narrowed the list to subtitle streams IN
    // CONTAINER ORDER, so the ORDINAL POSITION here is exactly the N that
    // `-map 0:s:N` takes. The container's absolute `index` field is NOT that
    // number (it counts video / audio streams too) and must not be used.
    let mut out_streams: Vec<ProbedSubStream> = Vec::new();
    for (ordinal, s) in streams.iter().take(MAX_PROBED_STREAMS).enumerate() {
        let codec = s
            .get("codec_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let language = s
            .pointer("/tags/language")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let title = s
            .pointer("/tags/title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out_streams.push(ProbedSubStream {
            sub_index: ordinal as u32,
            is_bitmap: codec_is_bitmap(&codec),
            codec,
            language,
            title,
        });
    }
    crate::devlog!(
        info, "subsync",
        "probe: {} subtitle stream(s) ({} bitmap)",
        out_streams.len(),
        out_streams.iter().filter(|s| s.is_bitmap).count(),
    );
    Ok(out_streams)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // CRLF line endings + the standard `,` millisecond separator, a missing
    // index number on the second cue, a `.` separator on the third, and stray
    // blank lines throughout.
    const SRT_SAMPLE: &str = "1\r\n\
        00:00:01,000 --> 00:00:03,500\r\n\
        <i>Hello,</i> world.\r\n\
        Second line.\r\n\
        \r\n\
        \r\n\
        00:01:00,250 --> 00:01:02,000\r\n\
        No index here &amp; that's fine.\r\n\
        \r\n\
        3\r\n\
        00:02:05.100 --> 00:02:07.900\r\n\
        {\\an8}Dot separator.\r\n";

    const VTT_SAMPLE: &str = "WEBVTT - Some description\n\
        \n\
        NOTE\n\
        This is a comment block. It even contains a bogus 00:00:00.000 --> 00:00:01.000 line.\n\
        \n\
        STYLE\n\
        ::cue { color: yellow }\n\
        \n\
        intro-cue\n\
        00:01.000 --> 00:04.000 line:80% align:middle\n\
        <v Roger>Hourless timestamp.\n\
        \n\
        00:00:10.000 --> 00:00:12.500\n\
        <c.yellow>Styled</c> text.\n";

    // REORDERED Format line: Start / End come FIRST, Layer is shoved to the end
    // of the metadata fields. A parser that assumed the canonical column order
    // would read "0" as the start time and produce garbage. Text stays last (per
    // the ASS spec) so its commas survive.
    const ASS_SAMPLE: &str = "[Script Info]\n\
        Title: Reordered\n\
        ScriptType: v4.00+\n\
        \n\
        [V4+ Styles]\n\
        Format: Name, Fontname, Fontsize\n\
        Style: Default,Arial,48\n\
        \n\
        [Events]\n\
        Format: Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Layer, Text\n\
        Dialogue: 0:00:02.18,0:00:04.50,Default,,0,0,0,,0,{\\pos(190,230)\\i1}Line one,\\Nwith a comma.\n\
        Comment: 0:00:05.00,0:00:06.00,Default,,0,0,0,,0,This must be ignored.\n\
        Dialogue: 0:01:00.00,0:01:02.00,Sign,,0,0,0,,0,{\\p1}m 0 0 l 100 0 100 50\n\
        Dialogue: 0:02:00.00,0:02:01.00,Default,,0,0,0,,0,Hard\\Nbreak\\hspaced.\n";

    #[test]
    fn srt_parses_crlf_dot_separator_and_missing_index() {
        let cues = parse_cues(SRT_SAMPLE);
        assert_eq!(cues.len(), 3, "got {cues:?}");

        assert!((cues[0].start - 1.0).abs() < 1e-6);
        assert!((cues[0].end - 3.5).abs() < 1e-6);
        // <i> stripped, the cue's own newline collapsed to one space.
        assert_eq!(cues[0].text, "Hello, world. Second line.");

        // No index number in front of the arrow line.
        assert!((cues[1].start - 60.25).abs() < 1e-6);
        assert_eq!(cues[1].text, "No index here & that's fine.");

        // `.` used as the millisecond separator instead of `,`.
        assert!((cues[2].start - 125.1).abs() < 1e-6);
        assert!((cues[2].end - 127.9).abs() < 1e-6);
        // A leaked ASS override block is stripped from an SRT too.
        assert_eq!(cues[2].text, "Dot separator.");
    }

    #[test]
    fn vtt_skips_note_and_style_blocks_and_handles_hourless_timestamps() {
        let cues = parse_cues(VTT_SAMPLE);
        // The NOTE block's bogus arrow line must NOT become a cue, and the STYLE
        // block must not either.
        assert_eq!(cues.len(), 2, "got {cues:?}");

        // MM:SS.mmm - the hour is omitted.
        assert!((cues[0].start - 1.0).abs() < 1e-6);
        assert!((cues[0].end - 4.0).abs() < 1e-6);
        // Cue id line skipped, <v Roger> voice span stripped, cue settings on the
        // timing line ignored.
        assert_eq!(cues[0].text, "Hourless timestamp.");

        assert!((cues[1].start - 10.0).abs() < 1e-6);
        assert_eq!(cues[1].text, "Styled text.");
    }

    #[test]
    fn ass_reads_the_format_header_rather_than_assuming_column_order() {
        let cues = parse_cues(ASS_SAMPLE);
        // Dialogue x3, minus the {\p1} drawing = 2. The Comment: line is ignored.
        assert_eq!(cues.len(), 2, "got {cues:?}");

        // Proof the Format header was honoured: Start is field 0 here, not the
        // canonical field 1. Assuming the canonical order would have read the
        // Layer value ("0") as the start time.
        assert!((cues[0].start - 2.18).abs() < 1e-6, "start was {}", cues[0].start);
        assert!((cues[0].end - 4.50).abs() < 1e-6, "end was {}", cues[0].end);
        // Override block stripped, \N -> space, and the comma inside Text
        // survived the split (Text is the last field).
        assert_eq!(cues[0].text, "Line one, with a comma.");

        assert!((cues[1].start - 120.0).abs() < 1e-6);
        assert_eq!(cues[1].text, "Hard break spaced.");
    }

    #[test]
    fn format_is_sniffed_from_content_not_extension() {
        assert_eq!(sniff_format(SRT_SAMPLE), SubFormat::Srt);
        assert_eq!(sniff_format(VTT_SAMPLE), SubFormat::Vtt);
        assert_eq!(sniff_format(ASS_SAMPLE), SubFormat::Ass);
        // An [Events]-only file (no [Script Info] header) is still ASS.
        assert_eq!(sniff_format("\n[Events]\nFormat: Start, End, Text\n"), SubFormat::Ass);
        // A BOM-prefixed WEBVTT header still sniffs as VTT once decoded.
        assert_eq!(
            sniff_format(&decode_subtitle_bytes(b"\xEF\xBB\xBFWEBVTT\n\n00:00.000 --> 00:01.000\nhi\n")),
            SubFormat::Vtt,
        );
    }

    #[test]
    fn markup_stripping() {
        assert_eq!(
            clean_timed_text("<font color=\"#ffffff\">Bright</font>\n<b>bold</b>"),
            "Bright bold",
        );
        assert_eq!(clean_timed_text("{\\an8}Top&nbsp;line"), "Top line");
        assert_eq!(clean_ass_text("{\\i1}Two{\\i0}\\Nlines\\hhere"), "Two lines here");
        // Karaoke inline timestamps are angle-bracketed in WebVTT.
        assert_eq!(clean_timed_text("<00:00:01.000><c>Word</c> up"), "Word up");
        // A lone backslash that is not an ASS escape survives.
        assert_eq!(clean_ass_text("path C:\\temp"), "path C:\\temp");
        // An UNBALANCED `<` is literal dialogue, not an unterminated tag. The
        // depth-counting stripper used to swallow everything after it, which
        // silently truncated the line the user is trying to click on.
        assert_eq!(clean_timed_text("if x < 5 then run"), "if x < 5 then run");
        assert_eq!(clean_timed_text("<i>tilt</i> 5 < 6 and 7 > 2"), "tilt 5 < 6 and 7 > 2");
        assert!(ass_is_drawing("{\\p1}m 0 0 l 5 5"));
        assert!(!ass_is_drawing("{\\pos(10,20)}Real dialogue"));
        assert!(!ass_is_drawing("{\\p0}Drawing mode off"));
    }

    #[test]
    fn timestamps() {
        assert_eq!(parse_timestamp("00:00:01,500"), Some(1.5));
        assert_eq!(parse_timestamp("00:00:01.500"), Some(1.5));
        assert_eq!(parse_timestamp("01:02.250"), Some(62.25)); // hourless VTT
        assert_eq!(parse_timestamp("1:02:03.04"), Some(3723.04)); // ASS centiseconds
        assert_eq!(parse_timestamp("garbage"), None);
        assert_eq!(parse_timestamp(""), None);
        assert_eq!(parse_timestamp("1:2:3:4"), None);
        assert_eq!(parse_arrow_line("00:00:01,000 --> 00:00:02,000"), Some((1.0, 2.0)));
        assert_eq!(parse_arrow_line("no arrow here"), None);
    }

    #[test]
    fn finalize_drops_empties_clamps_ends_and_sorts() {
        let cues = vec![
            SubCue { start: 10.0, end: 12.0, text: "second".into() },
            SubCue { start: 1.0, end: 2.0, text: "first".into() },
            SubCue { start: 5.0, end: 5.0, text: "zero length".into() },
            // end < start -> clamped to end == start -> then dropped as zero-length.
            SubCue { start: 8.0, end: 4.0, text: "backwards".into() },
            SubCue { start: 20.0, end: 21.0, text: String::new() },
        ];
        let out = finalize_cues(cues);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "first");
        assert_eq!(out[1].text, "second");
        assert!(out.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(out.iter().all(|c| c.end >= c.start));
    }

    #[test]
    fn cue_count_is_capped_at_5000_keeping_the_middle() {
        let total = MAX_CUES + 1_000; // 6 000
        let cues: Vec<SubCue> = (0..total)
            .map(|i| SubCue {
                start: i as f64,
                end: i as f64 + 0.5,
                text: format!("line {i}"),
            })
            .collect();
        let out = finalize_cues(cues);
        assert_eq!(out.len(), MAX_CUES);
        // 1 000 excess -> 500 dropped from the head, 500 from the tail.
        assert_eq!(out.first().unwrap().text, "line 500");
        assert_eq!(out.last().unwrap().text, format!("line {}", total - 500 - 1));
    }

    #[test]
    fn size_cap_is_enforced() {
        assert!(ensure_within_cap(MAX_SUBTITLE_BYTES, "x").is_ok());
        let err = ensure_within_cap(MAX_SUBTITLE_BYTES + 1, "subtitle file").unwrap_err();
        assert!(err.contains("8 MiB"), "unexpected message: {err}");
        assert!(err.contains("subtitle file"));
    }

    #[test]
    fn non_utf8_bytes_decode_lossily_instead_of_erroring() {
        // Windows-1252: 0xE9 is `é`, which is invalid UTF-8 on its own. The line
        // must still come back readable rather than blowing up the whole parse.
        let raw: Vec<u8> = b"1\n00:00:01,000 --> 00:00:02,000\nCaf\xE9 ferm\xE9\n".to_vec();
        let text = decode_subtitle_bytes(&raw);
        let cues = parse_cues(&text);
        assert_eq!(cues.len(), 1);
        assert!(cues[0].text.starts_with("Caf"));
        assert!(cues[0].text.contains("ferm"));

        // UTF-8 BOM is stripped so it cannot corrupt the first cue's index line.
        let bom = b"\xEF\xBB\xBF1\n00:00:01,000 --> 00:00:02,000\nWith BOM\n";
        let cues = parse_cues(&decode_subtitle_bytes(bom));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "With BOM");

        // UTF-16 LE (BOM FF FE) is decoded as UTF-16, not byte-wise.
        let utf16: Vec<u8> = {
            let s = "1\n00:00:01,000 --> 00:00:02,000\nWide\n";
            let mut v = vec![0xFF, 0xFE];
            for u in s.encode_utf16() {
                v.extend_from_slice(&u.to_le_bytes());
            }
            v
        };
        let cues = parse_cues(&decode_subtitle_bytes(&utf16));
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Wide");
    }

    #[test]
    fn bitmap_codecs_are_flagged() {
        assert!(codec_is_bitmap("hdmv_pgs_subtitle"));
        assert!(codec_is_bitmap("DVD_SUBTITLE"));
        assert!(codec_is_bitmap("dvb_subtitle"));
        assert!(codec_is_bitmap("xsub"));
        assert!(!codec_is_bitmap("subrip"));
        assert!(!codec_is_bitmap("ass"));
        assert!(!codec_is_bitmap("mov_text"));
        assert!(!codec_is_bitmap("webvtt"));
    }
}
