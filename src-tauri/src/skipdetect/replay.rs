// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/replay.rs (tests only)
//
// A replay source for the REAL job (`job::run`): a recorded probe and cached
// region PCM (the skipbench corpora's head.wav / tail.wav) stand in for the
// three ffmpeg opens, and everything after that is production code: the
// streaming loop, the region worker (fingerprint, RMS, incremental match, the
// early provisional-opening tracker), HEAD early exit, the theme catalogue and
// download cap, sibling cours, Layer 1 / Layer 3, the media end and the
// result-cache rules.
//
// What the replay decides instead of ffmpeg:
//   * the probe (container duration, `start:`, audio tracks and their DURATION
//     tags): a recorded production probe's stderr parsed by `parse_probe`, or a
//     ProbeInfo built from the corpus' ffprobe record;
//   * HEAD's first decoded PTS (the region origin) and how many samples HEAD
//     yields (`-to 600` on the output clock);
//   * TAIL's origin: the production `-ss` value read back from the argv, cut
//     from the cached tail at sample precision. A production S EARLIER than
//     the cached tail start cannot be honoured (the audio was never read):
//     the replay then starts at the cached start and records a note;
//   * silencedetect: the corpus' recorded intervals on the same track and the
//     same filter (`n=-30dB:d=0.5`), limited to what was decoded.
//
// Pacing: with `keep_up`, the next chunk is handed out only once the analysis
// worker has consumed the previous one (`worker_progress`), so every match and
// early-tracker step happens at exactly the decoded position it would on a
// link the analysis keeps up with. With `pace_*` > 0 a region also delivers no
// faster than that many wall seconds per audio second after `startup_s`, so
// the real AnimeThemes downloads and sibling lookups race the decode the way
// they do on a real link. `clock` records the region and decoded position, so
// a test can stamp every published snapshot with WHERE it was decided.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::audio::RegionEnd;
use super::continuity::Silence;
use super::fingerprint::SR;
use super::probe::{self, ProbeInfo};

/// Samples the CURRENT region's analysis worker has consumed. One replayed
/// region runs at a time (the job's pass gate), so one counter suffices.
static WORKER: AtomicU64 = AtomicU64::new(0);

/// Called by the region worker after every command it processed.
pub fn worker_progress(samples: u64) {
    WORKER.store(samples, Ordering::SeqCst);
}

/// PCM handed out per read (production reads up to 64 KiB from the pipe).
const CHUNK: usize = 32 * 1024;
/// Longest the replay waits for a worker that stopped consuming.
const KEEP_UP_LIMIT: Duration = Duration::from_secs(300);

/// One cached region.
pub struct RegionData {
    pub pcm: Arc<Vec<i16>>,
    /// Absolute media second of `pcm[0]`.
    pub t0: f64,
    /// silencedetect intervals, media seconds.
    pub silences: Vec<Silence>,
}

/// Where the replay is: which region and how far into it (media seconds).
#[derive(Clone, Debug, Default)]
pub struct Clock {
    pub region: &'static str,
    /// Absolute media second reached (origin + delivered).
    pub pos_s: f64,
    /// Seconds of the region delivered so far.
    pub delivered_s: f64,
    /// Seconds HEAD delivered in total (set once TAIL starts).
    pub head_total_s: f64,
}

pub struct Replay {
    pub probe: ProbeInfo,
    pub head: Option<RegionData>,
    pub tail: Option<RegionData>,
    /// HEAD's first decoded PTS (no `-ss`, no `-copyts`: the audio stream's
    /// start relative to the container start).
    pub head_first_pts: f64,
    pub keep_up: bool,
    /// Wall seconds per audio second for HEAD / TAIL (0 = as fast as the
    /// analysis allows), and the wall seconds before a region's first PCM.
    pub pace_head: f64,
    pub pace_tail: f64,
    pub startup_s: f64,
    pub clock: Arc<Mutex<Clock>>,
    pub notes: Mutex<Vec<String>>,
}

impl Replay {
    fn note(&self, n: String) {
        if let Ok(mut v) = self.notes.lock() {
            v.push(n);
        }
    }

    /// The source for one region, from the production argv.
    pub fn pass(&self, head: bool, args: &[String]) -> ReplayPass {
        WORKER.store(0, Ordering::SeqCst);
        let empty = RegionData { pcm: Arc::new(Vec::new()), t0: 0.0, silences: Vec::new() };
        let (data, region) = match (head, &self.head, &self.tail) {
            (true, Some(h), _) => (h, "head"),
            (false, _, Some(t)) => (t, "tail"),
            _ => {
                self.note(format!("{} region missing from the replay", if head { "HEAD" } else { "TAIL" }));
                (&empty, if head { "head" } else { "tail" })
            }
        };
        let (start, origin, first_pts, end) = if head {
            let origin = self.head_first_pts;
            // `-to 600` bounds the OUTPUT clock, which starts at the first PTS.
            let n = (((probe::HEAD_SECS - origin).max(0.0)) * SR as f64).round() as usize;
            (0, origin, origin, n.min(data.pcm.len()))
        } else {
            let s = args
                .iter()
                .position(|a| a == "-ss")
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(data.t0);
            let (skip, origin) = if s >= data.t0 {
                let k = ((s - data.t0) * SR as f64).round() as usize;
                (k.min(data.pcm.len()), data.t0 + k as f64 / SR as f64)
            } else {
                self.note(format!(
                    "TAIL -ss {s:.3} is {:.3}s before the cached tail start {:.3}: replay starts at the cached start",
                    data.t0 - s,
                    data.t0
                ));
                (0, data.t0)
            };
            // TAIL runs with -copyts: the PTS carries the container start,
            // which region_origin subtracts again.
            (skip, origin, origin + self.probe.start, data.pcm.len())
        };
        let silences = data.silences.iter().filter(|s| s.start >= origin - 1e-6).copied().collect();
        if let Ok(mut c) = self.clock.lock() {
            let head_total_s = if head { 0.0 } else if c.region == "head" { c.delivered_s } else { c.head_total_s };
            *c = Clock { region, pos_s: origin, delivered_s: 0.0, head_total_s };
        }
        ReplayPass {
            data: data.pcm.clone(),
            start,
            end,
            pos: start,
            origin,
            first_pts,
            silences,
            region,
            clock: self.clock.clone(),
            keep_up: self.keep_up,
            pace: if head { self.pace_head } else { self.pace_tail },
            startup_s: self.startup_s,
            born: Instant::now(),
        }
    }
}

pub struct ReplayPass {
    data: Arc<Vec<i16>>,
    start: usize,
    end: usize,
    pos: usize,
    origin: f64,
    first_pts: f64,
    silences: Vec<Silence>,
    region: &'static str,
    clock: Arc<Mutex<Clock>>,
    keep_up: bool,
    pace: f64,
    startup_s: f64,
    born: Instant,
}

impl ReplayPass {
    pub fn samples(&self) -> u64 {
        (self.pos - self.start) as u64
    }

    pub fn first_pts(&self) -> Option<f64> {
        Some(self.first_pts)
    }

    pub async fn next_pcm(&mut self) -> std::io::Result<Option<Vec<i16>>> {
        if self.keep_up {
            let want = self.samples();
            let t = Instant::now();
            while WORKER.load(Ordering::SeqCst) < want && t.elapsed() < KEEP_UP_LIMIT {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }
        if self.pos >= self.end {
            return Ok(None);
        }
        let n = CHUNK.min(self.end - self.pos);
        if self.pace > 0.0 || self.startup_s > 0.0 {
            let due = self.startup_s + (self.samples() + n as u64) as f64 / SR as f64 * self.pace;
            let now = self.born.elapsed().as_secs_f64();
            if due > now {
                tokio::time::sleep(Duration::from_secs_f64(due - now)).await;
            }
        }
        let v = self.data[self.pos..self.pos + n].to_vec();
        self.pos += n;
        let delivered = self.samples() as f64 / SR as f64;
        if let Ok(mut c) = self.clock.lock() {
            c.region = self.region;
            c.pos_s = self.origin + delivered;
            c.delivered_s = delivered;
        }
        Ok(Some(v))
    }

    /// How the "process" ended: clean at EOF, or killed (HEAD early exit).
    pub fn end(self, killed: bool) -> RegionEnd {
        let upto = self.origin + self.samples() as f64 / SR as f64;
        RegionEnd {
            exit_code: Some(if killed { 1 } else { 0 }),
            success: !killed,
            first_pts: Some(self.first_pts),
            silences: self.silences.into_iter().filter(|s| s.end <= upto + 1e-6).collect(),
            tail: Vec::new(),
        }
    }
}
