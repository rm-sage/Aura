// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/matcher.rs
//
// Layer 1: locate a KNOWN theme (an AnimeThemes OP / ED audio file) inside a
// region fingerprint (HEAD 0-600 s or TAIL, the last 480 s of media), decide
// whether the placement is trustworthy, and map it to a skip window.
//
// A port of the research harness, kept faithful because every gate was tuned
// on it: `common.py match_reference` (BER by offset, candidate diagonals,
// smoothed runs, refine, collinear merge), `at_eval/run.py locate` + `chain`
// (the 30 s / 0.35 accept floor and the chained mapping A_full), and
// `at_eval/pre_gates.py soft_cover` (the coverage gate). Times in the
// reference are rounded to the millisecond (BER to 1e-4) BEFORE the chain and
// the window are computed; this port rounds at the same points so the corpus
// parity test can compare to 0.15 s.
//
// Accept rule (spec "Layer 1", decisions 9-11), ALL must hold:
//   * the longest run (mean BER <= 0.35) is >= 30 s;
//   * margin: second-best full-overlap BER more than 5 s away minus the best
//     BER >= 0.15 (rejects every TV-edited theme; do NOT raise it);
//   * coverage `soft42` >= 0.85 on the longest run's diagonal (rejects a theme
//     truncated in the episode).
// Window = [ref0 of the first chained run, ref0 of the last chained run +
// reference length], clamped to [0, media_end]. No silence snapping: every
// snap variant pushed ED ends into after-credits scenes.
//
// BER is computed DIRECTLY (integer Hamming distance and valid-pair count per
// offset). The reference uses an FFT over the 32 bit planes and then rounds
// both sums to integers, so the two agree exactly; the BER formula itself is
// written the way numpy evaluates it so even the last ulp matches.

use super::fingerprint::{round_to, Fingerprint, FPS};

/// Offsets with less overlap than this (valid on both sides) score chance (0.5).
pub const MIN_OVERLAP_S: f64 = 10.0;
/// Smoothed per-code BER below this is "matching".
pub const RUN_THR: f64 = 0.35;
/// Per-code BER smoothing for run detection.
pub const SMOOTH_S: f64 = 2.0;
/// Shortest run kept by the matcher (before any accept gate).
pub const MIN_RUN_S: f64 = 5.0;
/// Candidate diagonals examined per match.
pub const TOP_DIAGONALS: usize = 6;
/// A diagonal is a candidate only when its full-overlap BER is at most this.
pub const CAND_MAX_BER: f64 = 0.45;
/// Candidate diagonals must be further apart than this.
pub const CAND_SEP_S: f64 = 2.0;
/// The "second best" BER is the best offset further than this from the best.
pub const SECOND_EXCL_S: f64 = 5.0;
/// Fine smoothing used to tighten run edges.
pub const FINE_S: f64 = 0.5;
/// Collinear runs merge across gaps up to this.
pub const MERGE_GAP_S: f64 = 3.0;
/// ...and diagonal drift up to this many codes.
pub const MERGE_DRIFT: i64 = 2;

/// Accept: longest run length floor.
pub const ACCEPT_LEN_S: f64 = 30.0;
/// Accept: run mean BER ceiling.
pub const ACCEPT_BER: f64 = 0.35;
/// Chain: same-theme runs continuing the reference within this query gap.
pub const CHAIN_GAP_S: f64 = 3.0;
/// Chain: shortest run that may join a chain.
pub const CHAIN_MIN_LEN_S: f64 = 8.0;
/// Accept: margin floor (second-best BER minus best BER). Do not raise.
pub const MARGIN_MIN: f64 = 0.15;
/// Coverage: per-code BER smoothing window.
pub const COVER_SMOOTH_S: f64 = 5.0;
/// Coverage: a code counts as covered below this smoothed BER.
pub const COVER_THR: f64 = 0.42;
/// Accept: share of the theme's audible codes that must be covered.
pub const COVER_MIN: f64 = 0.85;

/// Full-overlap BER for every offset. `ber[i]` is the BER of reference code j
/// against query code `j + off` with `off = first_off + i`, i.e. offsets
/// `-(K-1) ..= N-1`.
#[derive(Clone, Debug, Default)]
pub struct BerCurve {
    pub first_off: i64,
    pub ber: Vec<f64>,
}

impl BerCurve {
    #[inline]
    pub fn off(&self, i: usize) -> i64 {
        self.first_off + i as i64
    }
}

fn masks(fp: &Fingerprint) -> Vec<u32> {
    fp.valid.iter().map(|&v| if v { u32::MAX } else { 0 }).collect()
}

/// `common.py ber_by_offset`: BER of the reference placed at every query offset,
/// counting only codes valid on both sides; offsets with less than
/// `min_overlap_s` of such overlap score 0.5.
pub fn ber_by_offset(r: &Fingerprint, q: &Fingerprint, min_overlap_s: f64) -> BerCurve {
    let (k, n) = (r.len(), q.len());
    if k == 0 || n == 0 {
        return BerCurve::default();
    }
    let (mr, mq) = (masks(r), masks(q));
    let min_cnt = min_overlap_s * FPS;
    let first_off = -(k as i64 - 1);
    let mut ber = Vec::with_capacity(k + n - 1);
    for off in first_off..n as i64 {
        let r0 = (-off).max(0) as usize;
        let r1 = (k as i64).min(n as i64 - off) as usize;
        let q0 = (r0 as i64 + off) as usize;
        let len = r1 - r0;
        let (ra, rm) = (&r.codes[r0..r1], &mr[r0..r1]);
        let (qa, qm) = (&q.codes[q0..q0 + len], &mq[q0..q0 + len]);
        let mut h: u64 = 0;
        let mut c: u64 = 0;
        for i in 0..len {
            let m = rm[i] & qm[i];
            h += ((ra[i] ^ qa[i]) & m).count_ones() as u64;
            c += (m & 1) as u64;
        }
        if (c as f64) >= min_cnt {
            // numpy: 0.5 - dot / (64 * cnt) with dot = sum of +-1 sign products.
            let dot = 32.0 * c as f64 - 2.0 * h as f64;
            ber.push(0.5 - dot / (64.0 * c as f64));
        } else {
            ber.push(0.5);
        }
    }
    BerCurve { first_off, ber }
}

/// Aligned per-code BER at offset `off` over the overlap; a code invalid on
/// either side scores 0.5. Returns (reference index of element 0, BER array).
pub fn per_code_ber(r: &Fingerprint, q: &Fingerprint, off: i64) -> (usize, Vec<f64>) {
    let (k, n) = (r.len() as i64, q.len() as i64);
    let r0 = (-off).max(0);
    let r1 = k.min(n - off);
    if r1 <= r0 {
        return (r0.max(0) as usize, Vec::new());
    }
    let out = (r0..r1)
        .map(|i| {
            let j = (i + off) as usize;
            let i = i as usize;
            if r.valid[i] && q.valid[j] {
                (r.codes[i] ^ q.codes[j]).count_ones() as f64 / 32.0
            } else {
                0.5
            }
        })
        .collect();
    (r0 as usize, out)
}

/// Centred moving average of `n` samples with the edges padded by `pad`
/// (chance BER): zero padding would drag the ends toward a fake match.
pub fn smooth(x: &[f64], n: usize, pad: f64) -> Vec<f64> {
    let n = n.max(1);
    let left = n / 2;
    let w = 1.0 / n as f64;
    let at = |i: isize| -> f64 {
        if i < 0 || i as usize >= x.len() {
            pad
        } else {
            x[i as usize]
        }
    };
    (0..x.len())
        .map(|i| {
            let base = i as isize - left as isize;
            let mut s = 0.0;
            for j in 0..n as isize {
                s += at(base + j) * w;
            }
            s
        })
        .collect()
}

/// `[start, end)` index ranges where `mask` is true.
fn true_runs(mask: &[bool]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, &m) in mask.iter().enumerate() {
        match (m, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, mask.len()));
    }
    out
}

/// Tighten a run found on the SMOOTH_S curve using the FINE_S curve.
fn refine(ber: &[f64], s: usize, e: usize) -> (usize, usize) {
    let fine = smooth(ber, (FINE_S * FPS) as usize, 0.5);
    let pad = (SMOOTH_S * FPS) as usize;
    let lo = s.saturating_sub(pad);
    let hi = ber.len().min(e + pad);
    let idx: Vec<usize> = (lo..hi).filter(|&i| fine[i] < RUN_THR).collect();
    match (idx.first(), idx.last()) {
        (Some(&a), Some(&b)) => (a, b + 1),
        _ => (s, e),
    }
}

/// A run in code units: query start, reference start, length, mean BER, offset.
#[derive(Clone, Copy, Debug)]
struct RawRun {
    q: i64,
    r: i64,
    len: i64,
    ber: f64,
    off: i64,
}

fn merge_collinear(mut runs: Vec<RawRun>) -> Vec<RawRun> {
    runs.sort_by(|a, b| (a.off, a.q).cmp(&(b.off, b.q)));
    let gap = MERGE_GAP_S * FPS;
    let mut out: Vec<RawRun> = Vec::new();
    for r in runs {
        if let Some(p) = out.last_mut() {
            if (r.off - p.off).abs() <= MERGE_DRIFT
                && ((r.q - (p.q + p.len)) as f64) <= gap
                && r.q >= p.q
            {
                let end = (p.q + p.len).max(r.q + r.len);
                let len = end - p.q;
                let ber = (p.ber * p.len as f64 + r.ber * r.len as f64) / ((p.len + r.len).max(1) as f64);
                *p = RawRun { q: p.q, r: p.r, len, ber, off: p.off };
                continue;
            }
        }
        out.push(r);
    }
    out
}

/// One matched run, in seconds, rounded like the reference
/// (times to 1 ms, BER to 1e-4). `off` is the diagonal in codes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Run {
    pub q_start_s: f64,
    pub r_start_s: f64,
    pub len_s: f64,
    pub ber: f64,
    /// Query time where reference t=0 lands.
    pub ref0_s: f64,
    pub off: i64,
}

#[derive(Clone, Debug, Default)]
pub struct MatchResult {
    /// Longest first.
    pub runs: Vec<Run>,
    /// Mirrors the reference's output; kept for parity diagnostics.
    #[allow(dead_code)]
    pub best_offset_s: f64,
    pub best_ber: f64,
    pub second_ber: f64,
    #[allow(dead_code)]
    pub ref_len_s: f64,
}

/// `common.py match_reference` with its default parameters.
pub fn match_reference(r: &Fingerprint, q: &Fingerprint) -> MatchResult {
    let curve = ber_by_offset(r, q, MIN_OVERLAP_S);
    if curve.ber.is_empty() {
        return MatchResult { best_ber: 0.5, second_ber: 0.5, ..Default::default() };
    }
    let mut o = 0;
    for (i, &b) in curve.ber.iter().enumerate() {
        if b < curve.ber[o] {
            o = i;
        }
    }
    let excl = (SECOND_EXCL_S * FPS) as i64;
    let best_off = curve.off(o);
    let mut second = f64::INFINITY;
    for (i, &b) in curve.ber.iter().enumerate() {
        if (curve.off(i) - best_off).abs() > excl && b < second {
            second = b;
        }
    }
    if !second.is_finite() {
        second = 0.5;
    }
    // Candidate diagonals: best first, de-duplicated within CAND_SEP_S.
    let mut order: Vec<usize> = (0..curve.ber.len()).collect();
    order.sort_by(|&a, &b| curve.ber[a].total_cmp(&curve.ber[b]).then(a.cmp(&b)));
    let sep = CAND_SEP_S * FPS;
    let mut cands: Vec<i64> = Vec::new();
    for i in order {
        if curve.ber[i] > CAND_MAX_BER || cands.len() >= TOP_DIAGONALS {
            break;
        }
        let off = curve.off(i);
        if cands.iter().all(|&c| ((off - c).abs() as f64) > sep) {
            cands.push(off);
        }
    }
    let min_len = MIN_RUN_S * FPS;
    let mut raw = Vec::new();
    for &off in &cands {
        let (r0, b) = per_code_ber(r, q, off);
        if b.is_empty() {
            continue;
        }
        let sm = smooth(&b, (SMOOTH_S * FPS) as usize, 0.5);
        let mask: Vec<bool> = sm.iter().map(|&x| x < RUN_THR).collect();
        for (s, e) in true_runs(&mask) {
            if ((e - s) as f64) < min_len {
                continue;
            }
            let (s, e) = refine(&b, s, e);
            let mean = b[s..e].iter().sum::<f64>() / (e - s) as f64;
            raw.push(RawRun {
                q: r0 as i64 + s as i64 + off,
                r: r0 as i64 + s as i64,
                len: (e - s) as i64,
                ber: mean,
                off,
            });
        }
    }
    let mut merged = merge_collinear(raw);
    merged.sort_by(|a, b| b.len.cmp(&a.len)); // stable: longest first, ties keep order
    let runs = merged
        .iter()
        .map(|m| Run {
            q_start_s: round_to(q.t0 + m.q as f64 / FPS, 3),
            r_start_s: round_to(r.t0 + m.r as f64 / FPS, 3),
            len_s: round_to(m.len as f64 / FPS, 3),
            ber: round_to(m.ber, 4),
            ref0_s: round_to(q.t0 - r.t0 + m.off as f64 / FPS, 3),
            off: m.off,
        })
        .collect();
    MatchResult {
        runs,
        best_offset_s: round_to(q.t0 - r.t0 + best_off as f64 / FPS, 3),
        best_ber: round_to(curve.ber[o], 4),
        second_ber: round_to(second, 4),
        ref_len_s: round_to(r.len() as f64 / FPS, 3),
    }
}

/// `at_eval/run.py chain`: start from the longest run (runs[0]) and add runs
/// that continue it along the reference (query gap <= 3 s, reference order
/// preserved). `runs` must already be filtered to BER <= ACCEPT_BER and sorted
/// longest first. Returns the chain in query order.
pub fn chain(runs: &[Run]) -> Vec<Run> {
    if runs.is_empty() {
        return Vec::new();
    }
    let mut ch = vec![runs[0]];
    let mut used = vec![false; runs.len()];
    used[0] = true;
    let mut changed = true;
    while changed {
        changed = false;
        for (i, r) in runs.iter().enumerate() {
            if used[i] || r.len_s < CHAIN_MIN_LEN_S || r.ber > ACCEPT_BER {
                continue;
            }
            let (first, last) = (ch[0], ch[ch.len() - 1]);
            let after = r.q_start_s - (last.q_start_s + last.len_s);
            let before = first.q_start_s - (r.q_start_s + r.len_s);
            if (0.0..=CHAIN_GAP_S).contains(&after) && r.r_start_s >= last.r_start_s + last.len_s - 2.0 {
                ch.push(*r);
                used[i] = true;
                changed = true;
            } else if (0.0..=CHAIN_GAP_S).contains(&before) && r.r_start_s + r.len_s <= first.r_start_s + 2.0 {
                ch.insert(0, *r);
                used[i] = true;
                changed = true;
            }
        }
    }
    ch
}

/// `pre_gates.py soft_cover` at threshold `thr`: on diagonal `off`, the share of
/// the theme's audible codes `[int(lead * fps), ceil(trail * fps))` whose
/// 5 s-smoothed per-code BER is below `thr`. Codes invalid on either side or
/// outside the query count as 0.5.
pub fn soft_cover(r: &Fingerprint, q: &Fingerprint, off: i64, lead_s: f64, trail_s: f64, thr: f64) -> f64 {
    let k = r.len();
    if k == 0 {
        return 0.0;
    }
    let (r0, b) = per_code_ber(r, q, off);
    let mut full = vec![0.5; k];
    full[r0..r0 + b.len()].copy_from_slice(&b);
    let a0 = ((lead_s * FPS) as usize).min(k);
    let a1 = k.min((trail_s * FPS).ceil().max(0.0) as usize);
    if a1 <= a0 {
        return 0.0;
    }
    let sm = smooth(&full, (COVER_SMOOTH_S * FPS) as usize, 0.5);
    let hit = sm[a0..a1].iter().filter(|&&x| x < thr).count();
    hit as f64 / (a1 - a0) as f64
}

/// Why a theme was not accepted for a region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    /// No run with mean BER <= 0.35 of at least 5 s.
    NoRun,
    /// The longest such run is shorter than 30 s.
    RunTooShort,
    /// Second-best BER within 0.15 of the best (a TV edit, or ambiguous).
    Margin,
    /// soft42 below 0.85 (the theme is not complete in the region).
    Coverage,
}

impl Reject {
    pub fn as_str(self) -> &'static str {
        match self {
            Reject::NoRun => "no run",
            Reject::RunTooShort => "run < 30 s",
            Reject::Margin => "margin < 0.15",
            Reject::Coverage => "soft42 < 0.85",
        }
    }
}

/// Everything Layer 1 knows about one theme x region, for the decision and
/// the `[skipdetect]` log line (run length, BER, margin, soft42, verdict).
#[derive(Clone, Debug)]
pub struct ThemeMatch {
    pub accepted: bool,
    pub reject: Option<Reject>,
    /// Longest run (BER <= 0.35) in seconds, 0 when none.
    pub longest_run_s: f64,
    /// Its mean BER (None without a run).
    pub run_ber: Option<f64>,
    pub best_ber: f64,
    pub second_ber: f64,
    /// round(second_ber - best_ber, 4).
    pub margin: f64,
    /// Coverage on the longest run's diagonal (None without a run).
    pub soft42: Option<f64>,
    /// Number of chained runs (0 without a run >= 30 s).
    pub chained: usize,
    /// Mapping A_full before clamping: [ref0 of the first chained run,
    /// ref0 of the last chained run + reference length], rounded to 10 ms like
    /// the reference. Present whenever the 30 s run floor passed, even when a
    /// later gate rejected (diagnostics only; never publish a rejected window).
    pub raw_window: Option<(f64, f64)>,
    /// Query span the chain actually matched [first start, last end].
    pub matched_span: Option<(f64, f64)>,
    /// Query time where reference t=0 lands on the longest run.
    pub ref0_s: Option<f64>,
    pub ref_len_s: f64,
}

/// Run Layer 1 for one theme (`reference`, with its audible lead / trail in
/// seconds from `theme_audible`) against one region fingerprint (`query`,
/// whatever has been decoded so far).
pub fn evaluate_theme(reference: &Fingerprint, audible: (f64, f64), query: &Fingerprint) -> ThemeMatch {
    let m = match_reference(reference, query);
    let margin = round_to(m.second_ber - m.best_ber, 4);
    let runs: Vec<Run> = m.runs.iter().copied().filter(|r| r.ber <= ACCEPT_BER).collect();
    let mut out = ThemeMatch {
        accepted: false,
        reject: Some(Reject::NoRun),
        longest_run_s: 0.0,
        run_ber: None,
        best_ber: m.best_ber,
        second_ber: m.second_ber,
        margin,
        soft42: None,
        chained: 0,
        raw_window: None,
        matched_span: None,
        ref0_s: None,
        ref_len_s: reference.duration_s(),
    };
    let Some(best) = runs.first().copied() else {
        return out;
    };
    out.longest_run_s = best.len_s;
    out.run_ber = Some(best.ber);
    out.ref0_s = Some(best.ref0_s);
    out.soft42 = Some(soft_cover(reference, query, best.off, audible.0, audible.1, COVER_THR));
    if best.len_s < ACCEPT_LEN_S {
        out.reject = Some(Reject::RunTooShort);
        return out;
    }
    let ch = chain(&runs);
    let (first, last) = (ch[0], ch[ch.len() - 1]);
    let reflen = reference.duration_s();
    out.chained = ch.len();
    out.raw_window = Some((round_to(first.ref0_s, 2), round_to(last.ref0_s + reflen, 2)));
    out.matched_span = Some((round_to(first.q_start_s, 2), round_to(last.q_start_s + last.len_s, 2)));
    out.reject = if margin < MARGIN_MIN {
        Some(Reject::Margin)
    } else if out.soft42.unwrap_or(0.0) < COVER_MIN {
        Some(Reject::Coverage)
    } else {
        None
    };
    out.accepted = out.reject.is_none();
    out
}

/// The publishable window of an ACCEPTED match: the chained mapping clamped to
/// `[0, media_end]`. `media_end` is the end of the last decoded audio (TAIL
/// origin + samples / 11025 at EOF; before that the mapped track's DURATION
/// tag, else the container duration). The end is never extended past the
/// matched theme, and never the container duration by itself.
pub fn layer1_window(m: &ThemeMatch, media_end: f64) -> Option<(f64, f64)> {
    if !m.accepted {
        return None;
    }
    let (s, e) = m.raw_window?;
    let s = s.max(0.0);
    let e = e.min(media_end);
    (e > s).then_some((s, e))
}

/// Incremental matching cadence for one region: match once at least
/// `MATCH_MIN_S` of the region has decoded, then after every `MATCH_EVERY_S` of
/// new audio (decision 7). `region_complete` forces a final match at the end.
#[derive(Clone, Debug, Default)]
pub struct MatchSchedule {
    last_s: Option<f64>,
}

pub const MATCH_MIN_S: f64 = 40.0;
pub const MATCH_EVERY_S: f64 = 5.0;
/// HEAD is killed once its decoded position passes the accepted OP's end by this.
pub const HEAD_EXIT_MARGIN_S: f64 = 10.0;

impl MatchSchedule {
    /// `decoded_s` = seconds of the region decoded so far (samples / 11025).
    pub fn due(&mut self, decoded_s: f64, region_complete: bool) -> bool {
        let due = if region_complete {
            self.last_s.map_or(true, |l| decoded_s > l)
        } else if decoded_s < MATCH_MIN_S {
            false
        } else {
            self.last_s.map_or(true, |l| decoded_s - l >= MATCH_EVERY_S)
        };
        if due {
            self.last_s = Some(decoded_s);
        }
        due
    }
}

/// True once HEAD may be killed: an OP window is published and the decoded
/// position (absolute seconds) is at least its end + 10 s.
pub fn head_exit_ready(decoded_pos_s: f64, op_window_end: f64) -> bool {
    decoded_pos_s >= op_window_end + HEAD_EXIT_MARGIN_S
}

#[cfg(test)]
mod tests {
    use super::super::fingerprint::{fingerprint, theme_audible, SR};
    use super::*;

    /// Deterministic PCG-ish generator.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    /// A "song": broadband seeded noise under a beat-like envelope plus a
    /// chirp sweeping 300-3000 Hz every 2.3 s. Like music, it puts energy in
    /// every band, so every bit carries signal.
    fn song(secs: f64, seed: u64) -> Vec<f64> {
        let n = (secs * SR as f64) as usize;
        let mut rng = Rng(seed);
        let mut ph = 0.0f64;
        let sr = SR as f64;
        (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                let u = (t % 2.3) / 2.3;
                let f = 300.0 * 10f64.powf(u);
                ph += 2.0 * std::f64::consts::PI * f / sr;
                let env = 0.6 + 0.4 * (2.0 * std::f64::consts::PI * t / 0.45).sin();
                0.5 * env * (rng.next() * 2.0 - 1.0) + 0.3 * ph.sin()
            })
            .collect()
    }

    fn noise(secs: f64, seed: u64) -> Vec<f64> {
        let mut rng = Rng(seed);
        (0..(secs * SR as f64) as usize).map(|_| rng.next() * 2.0 - 1.0).collect()
    }

    fn to_pcm(x: &[f64], gain: f64) -> Vec<i16> {
        x.iter().map(|v| (v * gain * 32767.0).clamp(-32768.0, 32767.0) as i16).collect()
    }

    /// Episode = noise "story" with `insert` mixed in at `at_s`.
    fn episode(secs: f64, insert: &[f64], at_s: f64, seed: u64) -> Vec<i16> {
        let mut x: Vec<f64> = noise(secs, seed).iter().map(|v| v * 0.12).collect();
        let a = (at_s * SR as f64) as usize;
        for (i, v) in insert.iter().enumerate() {
            if a + i < x.len() {
                x[a + i] += v * 0.8;
            }
        }
        to_pcm(&x, 0.9)
    }

    fn theme_fp(x: &[f64]) -> (Fingerprint, (f64, f64)) {
        let pcm = to_pcm(x, 0.8);
        (fingerprint(&pcm, 0.0), theme_audible(&pcm))
    }

    #[test]
    fn ber_formula_matches_numpy_rounding() {
        // 0.5 - dot/(64 cnt) vs h/(32 cnt): identical values on these counts.
        let r = Fingerprint { codes: vec![0xFFFF_0000; 300], valid: vec![true; 300], t0: 0.0 };
        let q = Fingerprint { codes: vec![0xFFFF_FFFF; 300], valid: vec![true; 300], t0: 0.0 };
        let c = ber_by_offset(&r, &q, 10.0);
        let zero = c.ber[(0 - c.first_off) as usize];
        assert_eq!(zero, 0.5);
        // Too little overlap scores chance.
        assert_eq!(c.ber[0], 0.5);
    }

    #[test]
    fn chirp_in_noise_found_within_one_frame() {
        let th = song(45.0, 11);
        let (r, aud) = theme_fp(&th);
        let at = 57.3;
        let q = fingerprint(&episode(200.0, &th, at, 5), 0.0);
        let m = evaluate_theme(&r, aud, &q);
        assert!(m.accepted, "{m:?}");
        let ref0 = m.ref0_s.unwrap();
        assert!((ref0 - at).abs() <= 1.0 / FPS, "ref0 {ref0} vs {at}");
        let w = layer1_window(&m, 200.0).unwrap();
        assert!((w.0 - at).abs() <= 1.0 / FPS && (w.1 - (at + r.duration_s())).abs() <= 1.0 / FPS, "{w:?}");
    }

    #[test]
    fn eight_second_repeat_rejected_by_run_floor() {
        let th = song(60.0, 12);
        let (r, aud) = theme_fp(&th);
        let q = fingerprint(&episode(200.0, &th[..8 * SR as usize], 90.0, 6), 0.0);
        let m = evaluate_theme(&r, aud, &q);
        assert!(!m.accepted);
        assert!(m.longest_run_s < ACCEPT_LEN_S, "{m:?}");
        assert!(layer1_window(&m, 200.0).is_none());
    }

    #[test]
    fn theme_truncated_in_episode_never_accepted() {
        let th = song(90.0, 13);
        let (r, aud) = theme_fp(&th);
        let cut = (0.6 * th.len() as f64) as usize;
        // 60% of the theme, then different music where the rest should be.
        let mut ins = th[..cut].to_vec();
        ins.extend(song(36.0, 99));
        let q = fingerprint(&episode(240.0, &ins, 40.0, 7), 0.0);
        let m = evaluate_theme(&r, aud, &q);
        assert!(m.longest_run_s >= ACCEPT_LEN_S, "the 30 s floor alone would accept: {m:?}");
        assert!(!m.accepted, "{m:?}");
        assert!(layer1_window(&m, 240.0).is_none());
        // The coverage gate fails on its own (whichever gate reports first).
        assert!(m.soft42.unwrap() < COVER_MIN, "{m:?}");
    }

    #[test]
    fn tv_edit_cut_from_middle_never_accepted() {
        let th = song(90.0, 14);
        let (r, aud) = theme_fp(&th);
        for cut_s in [5.0, 10.0, 15.0, 20.0, 25.0, 30.0] {
            let mid = th.len() / 2;
            let half = (cut_s * SR as f64 / 2.0) as usize;
            let mut ins = th[..mid - half].to_vec();
            ins.extend_from_slice(&th[mid + half..]);
            let q = fingerprint(&episode(240.0, &ins, 50.0, 8), 0.0);
            let m = evaluate_theme(&r, aud, &q);
            assert!(!m.accepted, "cut {cut_s}: {m:?}");
            assert!(layer1_window(&m, 240.0).is_none());
            // The margin gate fails on its own: the other half of the theme is
            // the second-best diagonal.
            assert!(m.margin < MARGIN_MIN, "cut {cut_s}: {m:?}");
        }
    }

    #[test]
    fn truncated_reference_never_extends_past_matched_audio() {
        let th = song(90.0, 15);
        let short = &th[..(0.6 * th.len() as f64) as usize];
        let (r, aud) = theme_fp(short);
        let at = 70.0;
        let q = fingerprint(&episode(240.0, &th, at, 9), 0.0);
        let m = evaluate_theme(&r, aud, &q);
        // It may be accepted (no gate can tell); it must never overshoot.
        if let Some(w) = layer1_window(&m, 240.0) {
            let matched_end = at + short.len() as f64 / SR as f64;
            assert!(w.1 <= matched_end + 1.0 / FPS, "{w:?} vs {matched_end}");
            assert!(w.1 < at + 90.0 - 30.0);
        }
    }

    #[test]
    fn ed_end_clamped_to_media_end_not_container() {
        // A theme file with 6 s of trailing silence; the episode's audio ends
        // 0.5 s after the song does, so the mapped end (ref0 + file length)
        // lies past the last decoded sample. The window must end at media_end
        // (last decoded audio), never at the longer container duration.
        let mut th = song(45.0, 16);
        th.extend(std::iter::repeat(0.0).take(6 * SR as usize));
        let (r, aud) = theme_fp(&th);
        let at = 160.0;
        let pcm = episode(205.5, &th[..45 * SR as usize], at, 10);
        let q = fingerprint(&pcm, 1000.0);
        let m = evaluate_theme(&r, aud, &q);
        assert!(m.accepted, "{m:?}");
        let media_end = 1000.0 + pcm.len() as f64 / SR as f64;
        let container = media_end + 29.09;
        let w = layer1_window(&m, media_end).unwrap();
        assert!(w.1 <= media_end && w.1 < container);
        assert!((w.0 - (1000.0 + at)).abs() <= 1.0 / FPS);
    }

    #[test]
    fn schedule_cadence() {
        let mut s = MatchSchedule::default();
        assert!(!s.due(39.9, false));
        assert!(s.due(40.0, false));
        assert!(!s.due(44.0, false));
        assert!(s.due(45.0, false));
        assert!(s.due(46.0, true));
        assert!(!s.due(46.0, true));
        assert!(head_exit_ready(110.0, 100.0));
        assert!(!head_exit_ready(109.9, 100.0));
    }
}
