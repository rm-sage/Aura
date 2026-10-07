// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/probe.rs
//
// The pure half of skipdetect's ffmpeg plumbing: argv builders for the three
// opens (probe, HEAD, TAIL), the probe-stderr parser and audio-track rule, and
// the line parsers for the first decoded PTS (`ashowinfo`) and silencedetect.
// Nothing here spawns a process or touches the network; the URL is only ever
// an argv element handed back to the caller and is never formatted into a
// message.
//
// ffmpeg landmines (CLAUDE.md, spec "Signals"):
//   * HEAD bounds its output with `-to 600` and has NO `-ss`, `-copyts` or `-t`;
//   * TAIL seeks with input `-ss <S> -copyts` and has NO `-t` or `-to` (it runs
//     to EOF, because the media end is read there);
//   * no `-sseof` anywhere (both forms count back from the CONTAINER duration,
//     and the plain form restarts timestamps at 0);
//   * no `-map 0:a:m:language:jpn?` (fails to parse on the bundled 8.1.1).

use super::continuity::Silence;
use super::fingerprint::SR;

/// HEAD covers media seconds 0-600.
pub const HEAD_SECS: f64 = 600.0;
/// TAIL covers the last 480 s of MEDIA (TYBW 3:14's ED starts 418 s before EOF).
pub const TAIL_SECS: f64 = 480.0;
/// Every skipdetect ffmpeg call starts with these.
pub const COMMON_ARGS: [&str; 4] = ["-hide_banner", "-nostdin", "-protocol_whitelist", "http,https,tcp,tls,crypto"];

/// ffmpeg exit codes the probe distinguishes (`FFERRTAG(0xF8, '4', x, y)`).
pub const AVERROR_HTTP_BAD_REQUEST: i32 = -808_465_656; // 400
pub const AVERROR_HTTP_UNAUTHORIZED: i32 = -825_243_896; // 401
pub const AVERROR_HTTP_FORBIDDEN: i32 = -858_797_304; // 403
pub const AVERROR_HTTP_NOT_FOUND: i32 = -875_574_520; // 404
pub const AVERROR_HTTP_OTHER_4XX: i32 = -1_482_175_736;
/// AVERROR(EINVAL): what an out-of-range `-map 0:a:N` exits with, before any read.
pub const AVERROR_EINVAL: i32 = -22;

fn common() -> Vec<String> {
    COMMON_ARGS.iter().map(|s| s.to_string()).collect()
}

/// The filter graph shared by HEAD and TAIL: one branch prints the FIRST frame's
/// `pts_time` (the region origin), the other runs silencedetect and resamples
/// to 11025 Hz. `\,` is lavfi's own escape (argv elements are passed unquoted).
///
/// `async=1` (fill / trim only, no stretching) keeps sample index == PTS: every
/// position in skipdetect is `origin + samples / 11025`, and mpv plays by PTS.
/// Measured 2026-10-05 on real streams: on a release whose audio track has
/// timestamp gaps (JJK S1E3 iAHD, DTS-HD MA: 14 discontinuities summing 6.66 s
/// in the first 600 s, the first +1.37 s at 127.5 s) plain `aresample` put the
/// OP 1.75 s and the ED about 2.2 s EARLY against the frame-verified truth, and
/// `-to 600` stopped after 593.35 s of samples. With `async=1` the gaps are
/// filled with silence; on a clean release the PCM is bit-identical to the
/// plain form (Demon Slayer S1E2: 0 of 6,615,000 samples differ). A gap
/// shorter than swr's `min_hard_comp` (0.1 s) is not filled, so the residual
/// stays under 0.1 s.
pub fn region_graph(audio_n: usize) -> String {
    format!(
        "[0:a:{audio_n}]asplit=2[m][p];[p]aselect=eq(n\\,0),ashowinfo,anullsink;\
         [m]silencedetect=n=-30dB:d=0.5,aresample={SR}:async=1[o]"
    )
}

/// `... -probesize 1000000 -analyzeduration 0 -i <url>` (exit 1 "no output file"
/// is expected; parse stderr).
pub fn probe_args(url: &str) -> Vec<String> {
    let mut a = common();
    a.extend(["-probesize", "1000000", "-analyzeduration", "0", "-i", url].map(String::from));
    a
}

/// HEAD: from the file start to 600 s (an output-side `-to`, no seek).
pub fn head_args(url: &str, audio_n: usize) -> Vec<String> {
    let mut a = common();
    a.extend(["-i".to_string(), url.to_string(), "-filter_complex".to_string(), region_graph(audio_n)]);
    a.extend(["-map", "[o]", "-ac", "1", "-to", "600", "-f", "s16le", "pipe:1"].map(String::from));
    a
}

/// TAIL: input-side seek to `start_s` with `-copyts`, to EOF (no output bound).
pub fn tail_args(url: &str, audio_n: usize, start_s: f64) -> Vec<String> {
    let mut a = common();
    a.extend([
        "-ss".to_string(),
        format!("{start_s:.3}"),
        "-copyts".to_string(),
        "-i".to_string(),
        url.to_string(),
        "-filter_complex".to_string(),
        region_graph(audio_n),
    ]);
    a.extend(["-map", "[o]", "-ac", "1", "-f", "s16le", "pipe:1"].map(String::from));
    a
}

/// TAIL start `S = max(0, min(container, mapped DURATION tag) - 480)`; the
/// container alone without a tag, the tag alone without a container.
pub fn tail_start(container: Option<f64>, duration_tag: Option<f64>) -> Option<f64> {
    let end = match (container, duration_tag) {
        (Some(c), Some(t)) => c.min(t),
        (Some(c), None) => c,
        (None, Some(t)) => t,
        (None, None) => return None,
    };
    Some((end - TAIL_SECS).max(0.0))
}

/// Media end before TAIL reaches EOF: the mapped track's DURATION tag, else the
/// container duration.
pub fn early_media_end(duration_tag: Option<f64>, container: Option<f64>) -> Option<f64> {
    duration_tag.or(container)
}

/// Media end at TAIL EOF: origin + decoded samples / 11025.
pub fn media_end(tail_origin: f64, decoded_samples: u64) -> f64 {
    tail_origin + decoded_samples as f64 / SR as f64
}

/// Dispositions ffmpeg prints as trailing `(...)` tokens on a stream line. Other
/// parenthesised tokens (`(LC)`, `(mp4a / 0x6134706D)`, `(24 bit)`) are not.
const DISPOSITIONS: [&str; 19] = [
    "default",
    "dub",
    "original",
    "comment",
    "lyrics",
    "karaoke",
    "forced",
    "hearing impaired",
    "visual impaired",
    "clean effects",
    "attached pic",
    "timed thumbnails",
    "non diegetic",
    "captions",
    "descriptions",
    "metadata",
    "dependent",
    "still image",
    "multilayer",
];
/// A jpn track with any of these is not the main programme audio.
const SKIP_JPN: [&str; 3] = ["comment", "visual impaired", "hearing impaired"];

#[derive(Clone, Debug, PartialEq)]
pub struct AudioTrack {
    /// Audio-relative index: the N of `-map 0:a:N`.
    pub rel: usize,
    /// Absolute stream index (`#0:<abs>`).
    pub abs: usize,
    pub lang: Option<String>,
    pub dispositions: Vec<String>,
    /// mkv per-stream `DURATION` tag (seconds); mp4 has none.
    pub duration_tag: Option<f64>,
    pub title: Option<String>,
}

impl AudioTrack {
    pub fn is_default(&self) -> bool {
        self.dispositions.iter().any(|d| d == "default")
    }

    pub fn is_jpn(&self) -> bool {
        matches!(self.lang.as_deref().map(str::to_ascii_lowercase).as_deref(), Some("jpn" | "ja" | "jap"))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProbeInfo {
    /// `Duration:` of the container (None for `N/A`).
    pub container_duration: Option<f64>,
    /// `start:` of the container (0 when absent).
    pub start: f64,
    pub audio: Vec<AudioTrack>,
}

/// `HH:MM:SS.fff...` -> seconds.
fn hms(s: &str) -> Option<f64> {
    let mut it = s.trim().split(':');
    let h: f64 = it.next()?.trim().parse().ok()?;
    let m: f64 = it.next()?.trim().parse().ok()?;
    let sec: f64 = it.next()?.trim().parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Parse `Stream #0:<abs>[<id>](<lang>): <Kind>: <rest>`.
fn parse_stream_line(line: &str) -> Option<(usize, Option<String>, String, String)> {
    let t = line.trim_start();
    let s = t.strip_prefix("Stream #0:")?;
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    let abs: usize = s[..digits].parse().ok()?;
    let mut s = &s[digits..];
    if let Some(rest) = s.strip_prefix('[') {
        s = &rest[rest.find(']')? + 1..];
    }
    let mut lang = None;
    if let Some(rest) = s.strip_prefix('(') {
        let close = rest.find(')')?;
        lang = Some(rest[..close].to_string());
        s = &rest[close + 1..];
    }
    let s = s.strip_prefix(": ")?;
    let colon = s.find(": ")?;
    let kind = s[..colon].to_string();
    if kind.contains(' ') {
        return None;
    }
    Some((abs, lang, kind, s[colon + 2..].to_string()))
}

fn dispositions(rest: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut s = rest;
    while let Some(open) = s.find('(') {
        let after = &s[open + 1..];
        let Some(close) = after.find(')') else { break };
        let tok = &after[..close];
        if DISPOSITIONS.contains(&tok) {
            out.push(tok.to_string());
        }
        s = &after[close + 1..];
    }
    out
}

/// Parse the stderr of the probe (`ffmpeg ... -i <url>`, no output).
pub fn parse_probe(stderr: &str) -> ProbeInfo {
    let mut info = ProbeInfo::default();
    // Index into info.audio of the stream block we are inside, or None (inside
    // a non-audio stream block, or outside any block).
    let mut cur_audio: Option<usize> = None;
    let mut in_stream = false;
    for line in stderr.lines() {
        if let Some((abs, lang, kind, rest)) = parse_stream_line(line) {
            in_stream = true;
            cur_audio = None;
            if kind == "Audio" {
                info.audio.push(AudioTrack {
                    rel: info.audio.len(),
                    abs,
                    lang,
                    dispositions: dispositions(&rest),
                    duration_tag: None,
                    title: None,
                });
                cur_audio = Some(info.audio.len() - 1);
            }
            continue;
        }
        let t = line.trim();
        if let Some(d) = t.strip_prefix("Duration:") {
            let mut parts = d.split(',');
            info.container_duration = parts.next().and_then(hms);
            for p in parts {
                if let Some(st) = p.trim().strip_prefix("start:") {
                    info.start = st.trim().parse().unwrap_or(0.0);
                }
            }
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            // A top-level line ("Input #0", "At least one output file ...")
            // closes any stream block.
            in_stream = false;
            cur_audio = None;
            continue;
        }
        if !in_stream {
            continue;
        }
        let Some(ai) = cur_audio else { continue };
        if let Some((key, val)) = t.split_once(':') {
            let key = key.trim();
            let tr = &mut info.audio[ai];
            if (key == "DURATION" || key.starts_with("DURATION-")) && tr.duration_tag.is_none() {
                tr.duration_tag = hms(val);
            } else if key == "title" && tr.title.is_none() {
                tr.title = Some(val.trim().to_string());
            }
        }
    }
    info
}

/// Why a track was picked (for the `[skipdetect]` log).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackWhy {
    FirstJpn,
    Default,
    First,
}

impl TrackWhy {
    pub fn as_str(self) -> &'static str {
        match self {
            TrackWhy::FirstJpn => "first jpn",
            TrackWhy::Default => "default",
            TrackWhy::First => "first",
        }
    }
}

/// The analysis track: the first jpn track that is not commentary / impaired,
/// else the first default track, else the first audio track. Returns the
/// position in `audio` (== its `rel`, the N of `-map 0:a:N`).
pub fn pick_track(audio: &[AudioTrack]) -> Option<(usize, TrackWhy)> {
    if let Some(i) = audio
        .iter()
        .position(|a| a.is_jpn() && !a.dispositions.iter().any(|d| SKIP_JPN.contains(&d.as_str())))
    {
        return Some((i, TrackWhy::FirstJpn));
    }
    if let Some(i) = audio.iter().position(AudioTrack::is_default) {
        return Some((i, TrackWhy::Default));
    }
    (!audio.is_empty()).then_some((0, TrackWhy::First))
}

/// What to do after a failed probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    /// Retry ONCE after 1.5 s (an HTTP 4xx other than 403 / 404, e.g. the 400 a
    /// freshly resolved debrid link can answer on first open).
    RetryOnce,
    /// Abstain: 403 / 404, a map error, or anything else.
    Abstain,
}

pub const PROBE_RETRY_DELAY_MS: u64 = 1500;

/// Classify a probe that printed no audio line. Exit 1 with streams listed is
/// the NORMAL probe result and is not a failure.
pub fn classify_probe_failure(exit_code: i32, stderr: &str) -> ProbeFailure {
    match exit_code {
        AVERROR_HTTP_FORBIDDEN | AVERROR_HTTP_NOT_FOUND | AVERROR_EINVAL => ProbeFailure::Abstain,
        AVERROR_HTTP_BAD_REQUEST | AVERROR_HTTP_UNAUTHORIZED | AVERROR_HTTP_OTHER_4XX => ProbeFailure::RetryOnce,
        _ => {
            if stderr.contains("403 Forbidden") || stderr.contains("404 Not Found") {
                ProbeFailure::Abstain
            } else if stderr.contains("Server returned 4") {
                ProbeFailure::RetryOnce
            } else {
                ProbeFailure::Abstain
            }
        }
    }
}

/// `pts_time` of the FIRST `ashowinfo` frame line (`n:0`), or None.
pub fn parse_first_pts(line: &str) -> Option<f64> {
    if !line.contains("ashowinfo") {
        return None;
    }
    let body = &line[line.find(']')? + 1..];
    let mut toks = body.split_whitespace();
    if toks.next()? != "n:0" {
        return None;
    }
    for t in toks {
        if let Some(v) = t.strip_prefix("pts_time:") {
            let v: f64 = v.parse().ok()?;
            return v.is_finite().then_some(v);
        }
    }
    None
}

/// Region origin = first decoded PTS minus the container `start:` (rebased like
/// mpv's `rebase-start-time`). None when the PTS line never came: the region
/// then ABSTAINS; it never falls back to the `-ss` value.
pub fn region_origin(first_pts: Option<f64>, container_start: f64) -> Option<f64> {
    first_pts.map(|p| p - container_start)
}

/// Incremental silencedetect stderr parser. An interval is recorded on
/// `silence_end` only (a silence still open at EOF is dropped, like the
/// reference). Times are shifted by `-rebase` (the container `start:` on TAIL).
#[derive(Clone, Debug, Default)]
pub struct SilenceParser {
    rebase: f64,
    open: Option<f64>,
    pub silences: Vec<Silence>,
}

fn num_after(line: &str, key: &str) -> Option<f64> {
    let rest = &line[line.find(key)? + key.len()..];
    let tok = rest.split(|c: char| c.is_whitespace() || c == '|').find(|t| !t.is_empty())?;
    tok.parse().ok()
}

impl SilenceParser {
    pub fn new(rebase: f64) -> Self {
        Self { rebase, ..Default::default() }
    }

    /// Feed one stderr line; returns the interval it completed, if any.
    pub fn feed(&mut self, line: &str) -> Option<Silence> {
        if !line.contains("silencedetect") {
            return None;
        }
        if let Some(s) = num_after(line, "silence_start:") {
            self.open = Some(s - self.rebase);
            return None;
        }
        if let Some(e) = num_after(line, "silence_end:") {
            let s = self.open.take()?;
            let sil = Silence::new(s, e - self.rebase);
            self.silences.push(sil);
            return Some(sil);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://example.invalid/x.mkv";

    fn has_pair(a: &[String], k: &str, v: &str) -> bool {
        a.windows(2).any(|w| w[0] == k && w[1] == v)
    }
    fn pos(a: &[String], k: &str) -> Option<usize> {
        a.iter().position(|x| x == k)
    }

    #[test]
    fn argv_probe() {
        let a = probe_args(URL);
        assert_eq!(&a[..4], &COMMON_ARGS.map(String::from));
        assert!(has_pair(&a, "-probesize", "1000000") && has_pair(&a, "-analyzeduration", "0"));
        assert!(has_pair(&a, "-i", URL));
        assert!(pos(&a, "-map").is_none());
        assert!(a.iter().all(|x| !x.contains("sseof")));
    }

    #[test]
    fn argv_head() {
        let a = head_args(URL, 1);
        for bad in ["-ss", "-copyts", "-t", "-sseof"] {
            assert!(pos(&a, bad).is_none(), "{bad} in HEAD");
        }
        let i = pos(&a, "-i").unwrap();
        let to = pos(&a, "-to").unwrap();
        assert!(to > i, "-to must be an OUTPUT option");
        assert_eq!(a[to + 1], "600");
        assert!(a.iter().any(|x| x.starts_with("[0:a:1]asplit=2")));
        assert!(has_pair(&a, "-f", "s16le") && a.last().unwrap() == "pipe:1");
        assert!(a.iter().all(|x| !x.contains("sseof") && !x.contains("language:jpn")));
    }

    #[test]
    fn argv_tail() {
        let s = tail_start(Some(1480.02), Some(1450.938)).unwrap();
        assert!((s - 970.938).abs() < 1e-9, "min(container, tag) - 480");
        let a = tail_args(URL, 0, s);
        let ss = pos(&a, "-ss").unwrap();
        assert!(ss < pos(&a, "-i").unwrap(), "-ss must be an INPUT option");
        assert_eq!(a[ss + 1], "970.938");
        assert!(pos(&a, "-copyts").is_some());
        for bad in ["-t", "-to", "-sseof"] {
            assert!(pos(&a, bad).is_none(), "{bad} in TAIL");
        }
        assert!(a.iter().all(|x| !x.contains("sseof")));
        assert_eq!(tail_start(Some(1430.0), None), Some(950.0));
        assert_eq!(tail_start(Some(300.0), Some(299.0)), Some(0.0));
        assert_eq!(tail_start(None, None), None);
    }

    #[test]
    fn graph_shape() {
        assert_eq!(
            region_graph(2),
            "[0:a:2]asplit=2[m][p];[p]aselect=eq(n\\,0),ashowinfo,anullsink;[m]silencedetect=n=-30dB:d=0.5,aresample=11025:async=1[o]"
        );
    }

    // Real stderr shapes (pre_latency.md 3a), wrapped in a plausible probe block.
    const MKV_SPY: &str = "Input #0, matroska,webm, from '<redacted>':
  Metadata:
    title           : Spy x Family
  Duration: 00:24:40.02, start: 0.000000, bitrate: 4321 kb/s
  Chapters:
    Chapter #0:0: start 0.000000, end 90.000000
      Metadata:
        title           : Opening
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 1920x1080, SAR 1:1 DAR 16:9, 23.98 fps (default)
      Metadata:
        DURATION        : 00:24:09.950000000
  Stream #0:1(jpn): Audio: opus, 48000 Hz, stereo, fltp, delay 312 (default)
      Metadata:
        title           : Japanese
        DURATION        : 00:24:10.938000000
  Stream #0:2(eng): Audio: aac (LC), 44100 Hz, stereo, fltp
      Metadata:
        DURATION        : 00:24:10.900000000
  Stream #0:3(eng): Subtitle: ass (default)
      Metadata:
        DURATION        : 00:24:00.520000000
  Stream #0:4: Attachment: ttf
      Metadata:
        filename        : font.ttf
At least one output file must be specified
";

    #[test]
    fn probe_mkv_jpn_default() {
        let p = parse_probe(MKV_SPY);
        assert_eq!(p.container_duration, Some(1480.02));
        assert_eq!(p.start, 0.0);
        assert_eq!(p.audio.len(), 2);
        assert_eq!(p.audio[0].abs, 1);
        assert_eq!(p.audio[0].lang.as_deref(), Some("jpn"));
        assert!(p.audio[0].is_default());
        assert_eq!(p.audio[0].title.as_deref(), Some("Japanese"));
        // The MAPPED audio stream's tag, never the video's or the subtitle's.
        assert!((p.audio[0].duration_tag.unwrap() - 1450.938).abs() < 1e-9);
        assert_eq!(pick_track(&p.audio), Some((0, TrackWhy::FirstJpn)));
        let s = tail_start(p.container_duration, p.audio[0].duration_tag).unwrap();
        assert!((s - 970.938).abs() < 1e-9);
    }

    #[test]
    fn probe_eng_default_then_jpn() {
        // Frieren E2: eng default, jpn second -> 0:a:1.
        let err = "  Duration: 00:26:00.98, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080, 23.98 fps (default)
  Stream #0:1(eng): Audio: aac (LC), 44100 Hz, stereo, fltp (default)
  Stream #0:2(jpn): Audio: eac3, 48000 Hz, stereo, fltp, 224 kb/s
      Metadata:
        DURATION        : 00:26:00.032000000
";
        let p = parse_probe(err);
        assert_eq!(pick_track(&p.audio), Some((1, TrackWhy::FirstJpn)));
        assert!((p.audio[1].duration_tag.unwrap() - 1560.032).abs() < 1e-9);
        assert_eq!(p.audio[0].duration_tag, None);
    }

    #[test]
    fn probe_flac_24bit_and_mp4() {
        let flac = "  Duration: 00:23:50.00, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:1(jpn): Audio: flac, 48000 Hz, stereo, s16 (default)
  Stream #0:2(eng): Audio: flac, 48000 Hz, stereo, s32 (24 bit)
";
        let p = parse_probe(flac);
        assert_eq!(p.audio[1].dispositions, Vec::<String>::new(), "(24 bit) is not a disposition");
        assert_eq!(pick_track(&p.audio), Some((0, TrackWhy::FirstJpn)));

        let mp4 = "  Duration: 00:23:40.05, start: 0.021333, bitrate: 2000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 23.98 fps (default)
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 69 kb/s (default)
";
        let p = parse_probe(mp4);
        assert!((p.start - 0.021333).abs() < 1e-12);
        assert_eq!(p.audio.len(), 1);
        assert_eq!(p.audio[0].abs, 1);
        assert_eq!(p.audio[0].dispositions, vec!["default".to_string()]);
        assert_eq!(pick_track(&p.audio), Some((0, TrackWhy::Default)));
    }

    #[test]
    fn track_rule_jpn_counts() {
        let line = |abs: usize, lang: Option<&str>, disp: &str| match lang {
            Some(l) => format!("  Stream #0:{abs}({l}): Audio: aac (LC), 48000 Hz, stereo, fltp{disp}\n"),
            None => format!("  Stream #0:{abs}: Audio: aac (LC), 48000 Hz, stereo, fltp{disp}\n"),
        };
        let video = "  Stream #0:0: Video: h264, yuv420p, 1920x1080 (default)\n  Stream #0:1: Video: mjpeg, yuvj420p, 600x600 (attached pic)\n";
        let cases: [(String, Option<(usize, TrackWhy)>); 7] = [
            // 0 jpn
            (line(2, Some("eng"), " (default)") + &line(3, None, ""), Some((0, TrackWhy::Default))),
            (line(2, Some("eng"), "") + &line(3, Some("spa"), " (default)"), Some((1, TrackWhy::Default))),
            (line(2, Some("eng"), "") + &line(3, Some("fre"), ""), Some((0, TrackWhy::First))),
            // 1 jpn
            (line(2, Some("eng"), " (default)") + &line(3, Some("jpn"), ""), Some((1, TrackWhy::FirstJpn))),
            // 2 jpn
            (
                line(2, Some("eng"), " (default)") + &line(3, Some("jpn"), "") + &line(4, Some("jpn"), ""),
                Some((1, TrackWhy::FirstJpn)),
            ),
            // jpn commentary listed first is skipped
            (
                line(2, Some("eng"), " (default)") + &line(3, Some("jpn"), " (comment)") + &line(4, Some("jpn"), ""),
                Some((2, TrackWhy::FirstJpn)),
            ),
            (String::new(), None),
        ];
        for (body, want) in cases {
            let p = parse_probe(&(video.to_string() + &body));
            assert_eq!(pick_track(&p.audio), want, "{body}");
        }
        // Only a jpn commentary track: falls back to the default rule.
        let p = parse_probe(&(line(1, Some("jpn"), " (comment)") + &line(2, Some("eng"), " (default)")));
        assert_eq!(pick_track(&p.audio), Some((1, TrackWhy::Default)));
    }

    #[test]
    fn probe_failure_policy() {
        assert_eq!(classify_probe_failure(AVERROR_HTTP_BAD_REQUEST, ""), ProbeFailure::RetryOnce);
        assert_eq!(classify_probe_failure(AVERROR_HTTP_FORBIDDEN, ""), ProbeFailure::Abstain);
        assert_eq!(classify_probe_failure(AVERROR_HTTP_NOT_FOUND, ""), ProbeFailure::Abstain);
        assert_eq!(classify_probe_failure(AVERROR_EINVAL, ""), ProbeFailure::Abstain);
        assert_eq!(classify_probe_failure(1, "Server returned 400 Bad Request"), ProbeFailure::RetryOnce);
        assert_eq!(classify_probe_failure(1, "Server returned 403 Forbidden (access denied)"), ProbeFailure::Abstain);
    }

    #[test]
    fn first_pts_and_origin() {
        let l = "[Parsed_ashowinfo_2 @ 000001e2c3a4b5c0] n:0 pts:45898752 pts_time:956.24 fmt:fltp channels:2 chlayout:stereo rate:48000 nb_samples:1024 checksum:9A1B2C3D plane_checksums: [ 1 2 ]";
        assert_eq!(parse_first_pts(l), Some(956.24));
        assert_eq!(parse_first_pts("[Parsed_ashowinfo_2 @ 0x1] n:1 pts:1024 pts_time:0.0213 fmt:fltp"), None);
        assert_eq!(parse_first_pts("[Parsed_ashowinfo_2 @ 0x1] n:0 pts:0 pts_time:0 fmt:fltp"), Some(0.0));
        assert_eq!(parse_first_pts("[silencedetect @ 0x1] silence_start: 3"), None);
        assert_eq!(region_origin(Some(956.24), 0.0), Some(956.24));
        assert_eq!(region_origin(Some(1.5), 0.5), Some(1.0));
        // A missing first-PTS line: the region abstains (no fallback to S).
        let lines = ["[silencedetect @ 0x1] silence_start: 1000.5", "size=N/A time=00:08:00.00"];
        let pts = lines.iter().find_map(|l| parse_first_pts(l));
        assert_eq!(region_origin(pts, 0.0), None);
    }

    #[test]
    fn silence_lines() {
        let mut p = SilenceParser::new(0.5);
        assert_eq!(p.feed("[Parsed_silencedetect_3 @ 0x1] silence_start: 10.5"), None);
        let s = p.feed("[Parsed_silencedetect_3 @ 0x1] silence_end: 12.75 | silence_duration: 2.25").unwrap();
        assert_eq!((s.start, s.end), (10.0, 12.25));
        assert!((s.dur - 2.25).abs() < 1e-12);
        // A dangling start at EOF is not an interval.
        assert_eq!(p.feed("[Parsed_silencedetect_3 @ 0x1] silence_start: 99"), None);
        assert_eq!(p.silences.len(), 1);
        assert_eq!(p.feed("[aac @ 0x1] silence_end: 3"), None);
    }

    #[test]
    fn media_end_formula() {
        assert!((media_end(970.938, 480 * 11025) - 1450.938).abs() < 1e-9);
        assert_eq!(early_media_end(Some(1450.938), Some(1480.02)), Some(1450.938));
        assert_eq!(early_media_end(None, Some(1480.02)), Some(1480.02));
    }
}
