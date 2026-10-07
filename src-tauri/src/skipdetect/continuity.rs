// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/continuity.rs
//
// Layer 3: loudness continuity. LOW trust: prompt-only, never auto-skipped,
// never a Next-Up trigger. It runs for a kind only when Layer 1 had NO themes
// of that kind (a Layer 1 "themes but no match" is an informative abstain and
// must not fall through to here: that is how a post-credits story block would
// become an ED prompt).
//
// An exact port of the research reference `skipbench/cont/method.py select`
// with the tuned `eval_continuity.json` "recommended" parameters:
//
//   * candidates are blocks bracketed by silencedetect rows (-30 dB, d >= 0.5):
//     one bracket >= 0.5 s and the other >= 0.8 s; HEAD's file start counts as
//     an unbounded lead; no internal silence >= 0.8 s; length 40-100 s;
//   * rank by q35 + len_pen * max(0, |len - 89| - 3) / 10 ascending, ties to
//     the higher mrel (q35 = share of 0.4 s RMS windows below -35 dBFS, mrel =
//     block median dB minus the region median dB);
//   * OP: HEAD, start <= 300 s, len_pen 0.05, abstain if q35 > 0.10 or
//     mrel < 0.5; window [lead-silence end, min(trail-silence end,
//     trail-silence start + 1.0)];
//   * ED: TAIL, len_pen 0.1, abstain if q35 > 0.125 or mrel < 0.0; the start
//     walks back across lead silences < 0.8 s while each crossed audible gap is
//     <= 6 s (12 s total); window [start, min(trail-silence end,
//     trail-silence start + 3.0)].
//
// The window end is always a silence inside the region, NEVER the file or
// container duration.

/// One silencedetect interval in absolute seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Silence {
    pub start: f64,
    pub end: f64,
    pub dur: f64,
}

impl Silence {
    pub fn new(start: f64, end: f64) -> Self {
        Self { start, end, dur: end - start }
    }
}

/// RMS window length (s) for the loudness features.
pub const RMS_WIN_S: f64 = 0.4;
/// Samples per RMS window at 11025 Hz (round(0.4 * 11025)).
pub const RMS_WIN: usize = 4410;

/// Streaming 0.4 s RMS levels in dBFS (`common.py rms_windows`, stored as f32
/// like the reference's float32 arrays). A trailing partial window is dropped.
#[derive(Clone, Debug, Default)]
pub struct RmsMeter {
    levels: Vec<f32>,
    acc: f64,
    n: usize,
}

impl RmsMeter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, pcm: &[i16]) {
        for &s in pcm {
            let x = s as f64 / 32768.0;
            self.acc += x * x;
            self.n += 1;
            if self.n == RMS_WIN {
                let db = 20.0 * ((self.acc / RMS_WIN as f64).sqrt() + 1e-9).log10();
                self.levels.push(db as f32);
                self.acc = 0.0;
                self.n = 0;
            }
        }
    }

    pub fn into_levels(self) -> Vec<f32> {
        self.levels
    }
}

/// 0.4 s RMS levels of a whole buffer.
#[cfg(test)]
pub fn rms_levels(pcm: &[i16]) -> Vec<f32> {
    let mut m = RmsMeter::new();
    m.push(pcm);
    m.into_levels()
}

/// A complete region: its RMS levels (window i starts at `t0 + 0.4 i`) and the
/// silences silencedetect reported in it (absolute seconds, any order).
#[derive(Clone, Debug)]
pub struct Region<'a> {
    pub levels: &'a [f32],
    pub t0: f64,
    pub silences: &'a [Silence],
}

/// Tuned parameters (`eval_continuity.json` method.recommended).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Params {
    pub g_min: f64,
    pub g_max: f64,
    pub g_int: f64,
    pub k: usize,
    pub len_min: f64,
    pub len_max: f64,
    pub max_start: Option<f64>,
    pub len_pen: f64,
    pub ext: f64,
    pub ext_max: f64,
    pub ext_seg: f64,
    pub qmax: f64,
    pub margin: f64,
    pub mrel_min: f64,
    pub x_end: f64,
}

pub const OP_PARAMS: Params = Params {
    g_min: 0.5,
    g_max: 0.8,
    g_int: 0.8,
    k: 0,
    len_min: 40.0,
    len_max: 100.0,
    max_start: Some(300.0),
    len_pen: 0.05,
    ext: 0.0,
    ext_max: 12.0,
    ext_seg: 6.0,
    qmax: 0.1,
    margin: 0.0,
    mrel_min: 0.5,
    x_end: 1.0,
};

pub const ED_PARAMS: Params = Params {
    g_min: 0.5,
    g_max: 0.8,
    g_int: 0.8,
    k: 0,
    len_min: 40.0,
    len_max: 100.0,
    max_start: None,
    len_pen: 0.1,
    ext: 0.8,
    ext_max: 12.0,
    ext_seg: 6.0,
    qmax: 0.125,
    margin: 0.0,
    mrel_min: 0.0,
    x_end: 3.0,
};

/// Silences shorter than this never bracket or split a block.
const SIL_MIN: f64 = 0.5;
/// Song length the ranking prefers (s) and the free band around it.
const TARGET_LEN: f64 = 89.0;
const TARGET_FREE: f64 = 3.0;

/// One scored candidate block.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Block {
    pub l: f64,
    pub r: f64,
    pub q35: f64,
    pub mrel: f64,
    pub score: f64,
}

/// Why Layer 3 produced no window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Abstain {
    NoCandidate,
    Q35,
    Mrel,
    Margin,
}

impl Abstain {
    pub fn as_str(self) -> &'static str {
        match self {
            Abstain::NoCandidate => "no candidate",
            Abstain::Q35 => "q35 > qmax",
            Abstain::Mrel => "mrel < mrel_min",
            Abstain::Margin => "rival within margin",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Outcome {
    /// Prompt-only window (rounded to 10 ms like the reference).
    pub window: Option<(f64, f64)>,
    pub abstain: Option<Abstain>,
    pub best: Option<Block>,
    /// Best non-overlapping rival.
    pub rival: Option<Block>,
    pub gap: Option<f64>,
    pub extended_left_s: f64,
    pub n_candidates: usize,
}

/// Loudness features of [l, r] (`common.py continuity`): q35 and mrel.
fn features(levels: &[f32], t0: f64, region_median: f32, l: f64, r: f64) -> Option<(f64, f64)> {
    let a = ((l - t0) / RMS_WIN_S).ceil();
    let b = ((r - t0) / RMS_WIN_S).trunc();
    let a = a.max(0.0) as usize;
    let b = (b.max(0.0) as usize).min(levels.len());
    if b <= a {
        return None;
    }
    let seg = &levels[a..b];
    let below = seg.iter().filter(|&&x| x < -35.0f32).count();
    let q35 = below as f64 / seg.len() as f64;
    let mrel = (median_f32(seg) - region_median) as f64;
    Some((q35, mrel))
}

/// numpy median of a float32 array (mean of the two middles, in f32).
pub fn median_f32(x: &[f32]) -> f32 {
    if x.is_empty() {
        return f32::NAN;
    }
    let mut v = x.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

struct Cand {
    l: f64,
    r: f64,
    /// Lead silence (None = HEAD file start).
    ls: Option<Silence>,
    rs: Silence,
    q35: f64,
    mrel: f64,
}

fn score(p: &Params, c: &Cand) -> f64 {
    c.q35 + p.len_pen * f64::max(0.0, ((c.r - c.l) - TARGET_LEN).abs() - TARGET_FREE) / 10.0
}

fn round2(x: f64) -> f64 {
    super::fingerprint::round_to(x, 2)
}

/// `method.py select` for one region. `head` = the region starts at the file
/// start (HEAD: the start is an unbounded lead silence and `max_start` applies).
pub fn select(region: &Region, head: bool, p: &Params) -> Outcome {
    let mut sil_all: Vec<Silence> = region.silences.to_vec();
    sil_all.sort_by(|a, b| {
        a.start.total_cmp(&b.start).then(a.end.total_cmp(&b.end)).then(a.dur.total_cmp(&b.dur))
    });
    let sil: Vec<Silence> = sil_all.iter().copied().filter(|s| s.dur >= SIL_MIN).collect();
    let end = region.t0 + region.levels.len() as f64 * RMS_WIN_S;
    let region_median = median_f32(region.levels);

    // starts: (l, lead, lead silence)
    let mut starts: Vec<(f64, f64, Option<Silence>)> = Vec::new();
    if head {
        starts.push((region.t0, f64::INFINITY, None));
    }
    starts.extend(sil.iter().map(|s| (s.end, s.dur, Some(*s))));

    let mut cands: Vec<Cand> = Vec::new();
    for &(l, lead, ls) in &starts {
        if head {
            if let Some(ms) = p.max_start {
                if l > ms {
                    continue;
                }
            }
        }
        for rs in &sil {
            let (r, trail) = (rs.start, rs.dur);
            if r <= l + p.len_min - 1e-9 {
                continue;
            }
            if r - l > p.len_max {
                break;
            }
            if lead.min(trail) < p.g_min || lead.max(trail) < p.g_max {
                continue;
            }
            let nint = sil
                .iter()
                .filter(|s| s.dur >= p.g_int && s.start > l + 1e-6 && s.end < r - 1e-6)
                .count();
            if nint > p.k {
                continue;
            }
            if r > end {
                continue;
            }
            let Some((q35, mrel)) = features(region.levels, region.t0, region_median, l, r) else {
                continue;
            };
            cands.push(Cand { l, r, ls, rs: *rs, q35, mrel });
        }
    }
    let mut out = Outcome {
        window: None,
        abstain: Some(Abstain::NoCandidate),
        best: None,
        rival: None,
        gap: None,
        extended_left_s: 0.0,
        n_candidates: cands.len(),
    };
    if cands.is_empty() {
        return out;
    }
    // Stable sort: score ascending, then mrel descending.
    cands.sort_by(|a, b| score(p, a).total_cmp(&score(p, b)).then(b.mrel.total_cmp(&a.mrel)));
    let best = &cands[0];
    let block = |c: &Cand| Block { l: c.l, r: c.r, q35: c.q35, mrel: c.mrel, score: score(p, c) };
    out.best = Some(block(best));
    let rival = cands[1..].iter().find(|c| c.r.min(best.r) - c.l.max(best.l) <= 0.0);
    out.rival = rival.map(block);
    if best.q35 > p.qmax {
        out.abstain = Some(Abstain::Q35);
        return out;
    }
    if best.mrel < p.mrel_min {
        out.abstain = Some(Abstain::Mrel);
        return out;
    }
    let gap = rival.map_or(9.0, |r| score(p, r) - score(p, best));
    out.gap = Some(gap);
    if gap < p.margin - 1e-9 {
        out.abstain = Some(Abstain::Margin);
        return out;
    }
    // Extend left across short lead silences (the song often opens with a
    // sub-second blip after the real lead silence), bounded per gap and total.
    let mut l = best.l;
    let mut ls = best.ls;
    while p.ext > 0.0 {
        let Some(cur) = ls else { break };
        if cur.dur >= p.ext {
            break;
        }
        let mut prev: Option<Silence> = None;
        for s in &sil_all {
            if s.end <= cur.start + 1e-6 && prev.map_or(true, |p| s.end > p.end) {
                prev = Some(*s);
            }
        }
        let Some(pv) = prev else { break };
        if best.l - pv.end > p.ext_max {
            break;
        }
        if cur.start - pv.end > p.ext_seg {
            break;
        }
        l = pv.end;
        ls = Some(pv);
    }
    out.extended_left_s = round2(best.l - l);
    let r = best.rs.end.min(best.r + p.x_end);
    out.window = Some((round2(l), round2(r)));
    out.abstain = None;
    out
}

/// Layer 3 OP over a complete HEAD region.
pub fn detect_op(region: &Region) -> Outcome {
    select(region, true, &OP_PARAMS)
}

/// Layer 3 ED over a complete TAIL region.
pub fn detect_ed(region: &Region) -> Outcome {
    select(region, false, &ED_PARAMS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Levels: `quiet` dB everywhere, `loud` dB inside each block.
    fn levels(secs: f64, blocks: &[(f64, f64, f32)], quiet: f32) -> Vec<f32> {
        let n = (secs / RMS_WIN_S) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 * RMS_WIN_S;
                blocks.iter().find(|b| t >= b.0 && t < b.1).map_or(quiet, |b| b.2)
            })
            .collect()
    }

    #[test]
    fn op_block_between_silences() {
        // Story at -30 dB, a loud 88 s song from 30.8 to 118.8 bracketed by silences.
        let lv = levels(600.0, &[(30.8, 118.8, -14.0)], -30.0);
        let sil = [Silence::new(29.5, 30.8), Silence::new(118.8, 120.4), Silence::new(300.0, 301.0)];
        let o = detect_op(&Region { levels: &lv, t0: 0.0, silences: &sil });
        assert_eq!(o.window, Some((30.8, 119.8)), "{o:?}");
    }

    #[test]
    fn ed_never_ends_at_region_end() {
        // A song with no trailing silence before EOF has no candidate at all.
        let lv = levels(480.0, &[(380.0, 480.0, -12.0)], -28.0);
        let sil = [Silence::new(378.0, 380.0)];
        let o = detect_ed(&Region { levels: &lv, t0: 1000.0, silences: &sil });
        assert!(o.window.is_none());
        assert_eq!(o.abstain, Some(Abstain::NoCandidate));
    }

    #[test]
    fn ed_extends_left_across_short_lead_silence() {
        // Lead silence 0.6 s (< 0.8) right after a 1.5 s silence 3 s earlier.
        let lv = levels(480.0, &[(100.0, 190.0, -12.0)], -26.0);
        let sil = [
            Silence::new(95.5, 97.0),
            Silence::new(99.4, 100.0),
            Silence::new(190.0, 194.0),
        ];
        let o = detect_ed(&Region { levels: &lv, t0: 0.0, silences: &sil });
        assert_eq!(o.window, Some((97.0, 193.0)), "{o:?}");
        assert_eq!(o.extended_left_s, 3.0);
    }

    #[test]
    fn quiet_block_abstains() {
        let lv = levels(600.0, &[(30.0, 120.0, -40.0)], -20.0);
        let sil = [Silence::new(28.0, 30.0), Silence::new(120.0, 122.0)];
        let o = detect_op(&Region { levels: &lv, t0: 0.0, silences: &sil });
        assert!(o.window.is_none());
    }
}
