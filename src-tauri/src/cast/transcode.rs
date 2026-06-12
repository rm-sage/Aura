// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Phase-4 transmux planning — locate ffmpeg/ffprobe, probe the source's
//! codecs, decide copy-vs-reencode per stream, and build the ffmpeg HLS
//! command. The actual process + segment serving lives in `hls.rs`.
//!
//! Why HLS (vs a raw MPEG-TS pipe): Chromecast's Default Media Receiver
//! plays MP4/WebM/MP3/HLS reliably but not a standalone progressive `.ts`
//! stream, so a transmuxed cast targets an HLS media playlist. The
//! transcode always starts at the head of the file; the resume offset is
//! handed to the DEVICE as the LOAD `currentTime`, so the HLS timeline
//! stays 1:1 with real media time (no offset bookkeeping anywhere). With
//! `-c copy` (an h264/aac MKV is just a container remux) ffmpeg races
//! through the skipped prefix in a fraction of real time.

use std::path::PathBuf;
use std::process::Command;

/// Bundled-tool locations (`lib/ffmpeg.exe`, `lib/ffprobe.exe`). ffmpeg
/// is shipped already (silencedetect / thumbs); ffprobe must be dropped
/// alongside it for transmux — absent ⇒ the feature degrades to
/// direct-play-only (see `super::cast_ffmpeg_present`).
pub(super) fn ffmpeg_path() -> Option<PathBuf> {
    super::locate_tool("ffmpeg.exe")
}
pub(super) fn ffprobe_path() -> Option<PathBuf> {
    super::locate_tool("ffprobe.exe")
}

/// First video + audio codec names as ffprobe reports them (lowercased),
/// plus the video pixel format (for the bit-depth/chroma gate).
#[derive(Debug, Default, Clone)]
pub(super) struct Codecs {
    pub video: Option<String>,
    pub audio: Option<String>,
    /// Video pixel format, e.g. `yuv420p` (8-bit 4:2:0) vs `yuv420p10le`
    /// (10-bit). Only 8-bit 4:2:0 h264 is safe to stream-copy.
    pub video_pix_fmt: Option<String>,
}

/// Audio codecs the Default Media Receiver plays without re-encoding.
const AUDIO_COPY_OK: &[&str] = &["aac", "mp3"];

/// Whether the source video can be stream-copied (vs re-encoded) for the
/// Default Media Receiver. h264 ONLY, and ONLY 8-bit 4:2:0 (`yuv420p`):
/// the receiver tops out at H.264 High@L4.1 8-bit, so a `-c:v copy` of a
/// 10-bit (`yuv420p10le`) / 4:2:2 / 4:4:4 h264 — extremely common in anime
/// (Hi10P), which Aura explicitly targets — yields valid TS the device
/// can't decode (black video + audio). Those fall through to libx264.
fn can_copy_video(c: &Codecs) -> bool {
    c.video.as_deref() == Some("h264") && c.video_pix_fmt.as_deref() == Some("yuv420p")
}

/// Containers that need a transmux for Chromecast (the Default Media
/// Receiver won't open them directly even when the codecs inside are
/// fine). `.mp4/.m4v/.webm` direct-play; `.m3u8` is handled upstream
/// (handed to the device as HLS); everything below routes through ffmpeg.
const TRANSMUX_EXT: &[&str] = &[
    "mkv", "avi", "flv", "wmv", "m2ts", "mts", "ts", "vob", "mpg", "mpeg",
    "ogv", "ogm", "divx", "rmvb", "rm", "asf", "3gp",
];

/// Extension-based decision (no network probe — kept cheap so the cast
/// hot path stays snappy; the codec probe runs only once a transmux is
/// actually chosen). HLS/`.mp4`/`.webm` are NOT here — they direct-play.
pub(super) fn should_transmux(url: &str) -> bool {
    let path = url.split('?').next().unwrap_or("").to_ascii_lowercase();
    match path.rsplit('.').next() {
        Some(ext) => TRANSMUX_EXT.contains(&ext),
        None => false,
    }
}

/// Probe the first video + audio codec via ffprobe. Returns an empty
/// `Codecs` on any failure (missing ffprobe, network error, parse error)
/// — the caller then re-encodes both streams, which is always safe.
/// Blocking (run under `spawn_blocking`); network ops are bounded by
/// `-rw_timeout` so a dead URL can't hang the call.
pub(super) fn probe(url: &str) -> Codecs {
    let Some(ffprobe) = ffprobe_path() else { return Codecs::default() };
    let out = Command::new(ffprobe)
        .args([
            "-hide_banner", "-v", "error",
            // Bound every protocol read/write at 15 s so a stalled upstream
            // can't wedge the probe (microseconds).
            "-rw_timeout", "15000000",
            "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
            "-print_format", "json",
            "-show_streams",
            url,
        ])
        .output();
    let Ok(out) = out else { return Codecs::default() };
    if !out.status.success() {
        return Codecs::default();
    }
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return Codecs::default();
    };
    let mut codecs = Codecs::default();
    if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let kind = s.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            let name = s
                .get("codec_name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_ascii_lowercase());
            match kind {
                "video" if codecs.video.is_none() => {
                    codecs.video = name;
                    codecs.video_pix_fmt = s
                        .get("pix_fmt")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_ascii_lowercase());
                }
                "audio" if codecs.audio.is_none() => codecs.audio = name,
                _ => {}
            }
        }
    }
    codecs
}

/// Build the ffmpeg argument vector for an HLS transmux of `url` into
/// `out_dir` (writing `index.m3u8` + `seg%05d.ts`). Copies streams the
/// receiver accepts; re-encodes the rest (libx264 veryfast capped at
/// 1080p, AAC stereo).
///
/// `start_seconds` input-seeks ffmpeg (`-ss` BEFORE `-i`, a fast keyframe
/// seek) so a resumed cast begins at the resume point — the device is then
/// told `currentTime=0` and the caller tracks the offset, so the receiver
/// never has to seek to a position ffmpeg hasn't produced yet (which on a
/// re-encode is minutes away and hangs the LOAD).
pub(super) fn build_hls_args(
    url: &str,
    codecs: &Codecs,
    out_dir: &std::path::Path,
    start_seconds: f64,
) -> Vec<String> {
    let playlist = out_dir.join("index.m3u8");
    let seg_pattern = out_dir.join("seg%05d.ts");

    let copy_video = can_copy_video(codecs);
    let copy_audio = codecs
        .audio
        .as_deref()
        .map(|c| AUDIO_COPY_OK.contains(&c))
        .unwrap_or(false);

    let mut a: Vec<String> = vec![
        "-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into(),
        // Resilience for long debrid streams.
        "-reconnect".into(), "1".into(),
        "-reconnect_streamed".into(), "1".into(),
        "-reconnect_delay_max".into(), "2".into(),
        "-rw_timeout".into(), "30000000".into(),
        "-protocol_whitelist".into(), "file,http,https,tcp,tls,crypto".into(),
    ];
    // Input seek for resume (keyframe-accurate, fast). Placed before -i.
    if start_seconds.is_finite() && start_seconds > 1.0 {
        a.extend(["-ss".into(), format!("{:.3}", start_seconds)]);
    }
    a.extend([
        "-i".into(), url.into(),
        // First video + (optional) first audio track only.
        "-map".into(), "0:v:0".into(),
        "-map".into(), "0:a:0?".into(),
        // Drop subtitles + data — the Default Media Receiver has no sub UI
        // and embedded subs don't survive a TS remux.
        "-sn".into(), "-dn".into(),
    ]);

    if copy_video {
        a.extend(["-c:v".into(), "copy".into()]);
    } else {
        a.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "veryfast".into(),
            "-crf".into(), "20".into(),
            "-maxrate".into(), "8M".into(),
            "-bufsize".into(), "16M".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            // Downscale to ≤1080p, keep aspect, force even dims for yuv420p.
            "-vf".into(), "scale='min(1920,iw)':'-2'".into(),
            // Force a keyframe every 2 s so the first HLS segment closes
            // (and becomes fetchable) quickly even on a slow re-encode,
            // rather than waiting for libx264's default ~10 s GOP.
            "-force_key_frames".into(), "expr:gte(t,n_forced*2)".into(),
        ]);
    }
    if copy_audio {
        a.extend(["-c:a".into(), "copy".into()]);
    } else {
        a.extend([
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "160k".into(),
            "-ac".into(), "2".into(),
        ]);
    }

    a.extend([
        "-f".into(), "hls".into(),
        "-hls_time".into(), "4".into(),
        // Keep every segment in the playlist so the device can seek across
        // the whole produced range (event playlist that grows, then gets an
        // ENDLIST when ffmpeg finishes) — a movie cast wants a full VOD
        // scrub bar, not a live stream. Cost: the temp dir grows to ~the
        // transmuxed size for the cast's lifetime (bounded by the file, and
        // `-ss` resume trims the head); reclaimed by hls.rs on stop / idle /
        // app-close. See cast/hls.rs.
        "-hls_list_size".into(), "0".into(),
        "-hls_playlist_type".into(), "event".into(),
        "-hls_segment_type".into(), "mpegts".into(),
        "-hls_flags".into(), "independent_segments".into(),
        "-hls_segment_filename".into(), seg_pattern.to_string_lossy().into_owned(),
        playlist.to_string_lossy().into_owned(),
    ]);
    a
}
