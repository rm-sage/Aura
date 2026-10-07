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
// reference length], clamped to [0, media_end] (mapping A, the research
// port; the job publishes it refined by `refine_layer1_window`: the audible
// start and an end gated by the episode's own fade). No silence snapping:
// every snap variant pushed ED ends into after-credits scenes.
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

/// A theme whose audible span is shorter than the 30 s run gate can never be
/// accepted (a run cannot outlast the audible reference): short-form anime
/// whose OP / ED reference is under 30 s. Such a theme is no evidence either
/// way, so the job does not count it as "themes exist, none matched".
pub fn too_short_to_match(audible: (f64, f64)) -> bool {
    audible.1 - audible.0 < ACCEPT_LEN_S
}

// ── edge refinement (what the job publishes) ────────────────────────────────
//
// `layer1_window` above is mapping A, the research reference's chained
// mapping, and stays its exact port (the corpus parity tests hold it to the
// reference within 0.15 s). The job PUBLISHES it refined by two facts the
// mapping ignores (measured on the 89-episode end-to-end set, 2026-10-07,
// `scratchpad/e2e/edge_mapping.md`, variant REC):
//
//   * START = the theme's AUDIBLE start (`ref0 + lead`), never earlier than
//     mapping A's. The reference start is usually exact but ran 0.5 to 2.3 s
//     early into story on 17 windows (the file's lead silence: Steins;Gate 24
//     2.3 s); the audible start was never more than 0.18 s early.
//   * END = decided by the EPISODE's own loudness inside the theme file's
//     trailing fade, `[ref0 + trail + FADE_FROM_S, ref0 + reflen)`, from the
//     region's 0.4 s RMS levels (windows starting inside it, aligned to the
//     region origin like `RmsMeter`):
//       - a window at or above ONSET_DB there is new content starting (a
//         preview, an omake, the next scene): end = onset - ONSET_CUT_S, both
//         kinds;
//       - else an OPENING keeps mapping A's end (an OP quiet trim made Mob
//         Psycho S3E4 wrong; the openings that overran are all followed by
//         sound, so the onset rule covers them);
//       - else an ENDING whose fade is at or above LOUD_FADE_DB is being
//         talked or played over: end = audible end + LOUD_FADE_PAD_S;
//       - else (a quiet, held card): end = reference end - QUIET_FADE_TRIM_S.
//     Never past mapping A's end. The truth cut sat INSIDE the fade on every
//     one of the 10 endings that overran into a preview or after-credits
//     scene, and the same theme (TYBW ED1) both overran (3:2, 3:3) and held its
//     card (3:9 to 3:12), so the theme file alone cannot separate the two; the
//     episode audio can (a held card is quiet, a preview is loud).
//
// Measured against mapping A on the 89 episodes, every mode and both links:
// every Layer 1 preview / after-credits overrun gone (6.88 s + 1.10 s on 9
// episodes, fast link), all-auto HARM 9 -> 1 (the one left is not Layer 1),
// no verdict or class worse anywhere; the cost is three under-skips that
// cross the 2 s "correct" bar (JJK S1E3 OP start, TYBW 1:1 ED end, Solo
// Leveling 1 ED end). Thresholds sit mid-plateau: identical results for the
// loud-fade level -58 to -65 dB, the onset cut 0.75 to 1.25 s, the quiet trim
// 0.25 to 0.5 s; the onset level is 7 dB clear of both sides. They rest on 6
// OP and 6 ED onsets: re-validate on new episodes before moving any of them.
//
// The fade needs the region's levels, which reach the job when the region
// worker finishes (HEAD: its early exit, OP end + 10 s; TAIL: EOF). Before
// that a window is published with the audible start and mapping A's end
// (`levels` None); measured identical to gating the moment the fade decodes.

/// The fade window begins this far after the theme's audible end.
pub const FADE_FROM_S: f64 = 0.25;
/// An episode window this loud inside the fade is new content (an onset).
pub const ONSET_DB: f32 = -40.0;
/// The window ends this long before an onset.
pub const ONSET_CUT_S: f64 = 1.0;
/// An ending's fade this loud (no onset) is talked or played over.
pub const LOUD_FADE_DB: f32 = -60.0;
/// ...and then ends this long after the theme's audible end.
pub const LOUD_FADE_PAD_S: f64 = 0.5;
/// A quiet fade (a held card) ends this long before the reference end.
pub const QUIET_FADE_TRIM_S: f64 = 0.5;

/// A finished region's 0.4 s RMS levels (`RmsMeter`): window i starts at
/// `t0 + RMS_WIN_S * i`, `t0` = the region origin (first decoded PTS).
#[derive(Clone, Copy, Debug)]
pub struct RegionLevels<'a> {
    pub levels: &'a [f32],
    pub t0: f64,
}

/// The published window of an ACCEPTED match: `layer1_window` refined at
/// both edges (see the block comment above). `audible` = the theme's
/// audible (lead, trail) in reference seconds; `ending` = an ED (only an
/// ending takes the loud / quiet fade rules); `levels` = the finished
/// region's levels, None while the region is still decoding.
pub fn refine_layer1_window(
    m: &ThemeMatch,
    audible: (f64, f64),
    ending: bool,
    levels: Option<RegionLevels<'_>>,
    media_end: f64,
) -> Option<(f64, f64)> {
    let today = layer1_window(m, media_end)?;
    let raw = m.raw_window?;
    refine_edges(raw, today, m.ref_len_s, m.chained <= 1, audible, ending, levels, media_end)
}

/// `refine_layer1_window` on a raw chained window (mapping A before
/// clamping) and its clamped form `today`. `single` = one diagonal (one
/// chained run): its ref0 is then read from the START (`raw.0`, rounded to
/// 10 ms like the end), exactly as the measurement did, rather than from
/// `raw.1 - ref_len_s`, which carries the end's rounding and the reference
/// length's fraction (up to a few ms: enough to move a fade boundary across
/// a 0.4 s level window, Demon Slayer 3:5's ED). A start clamped at 0 has no
/// ref0 left in it, so the end's is used. Public for the corpus tests, which
/// refine the reference's own A_full windows (single diagonals).
#[allow(clippy::too_many_arguments)]
pub fn refine_edges(
    raw: (f64, f64),
    today: (f64, f64),
    ref_len_s: f64,
    single: bool,
    audible: (f64, f64),
    ending: bool,
    levels: Option<RegionLevels<'_>>,
    media_end: f64,
) -> Option<(f64, f64)> {
    let (first_ref0, ref_end_raw) = raw;
    // The ref0 the END is measured from: the last chained run's.
    let last_ref0 = if single && first_ref0 > 0.0 { first_ref0 } else { ref_end_raw - ref_len_s };
    let ref_end = last_ref0 + ref_len_s;
    let start = round_to((first_ref0 + audible.0).max(today.0), 2).max(0.0);
    let aud_end = last_ref0 + audible.1;
    let mut end = ref_end;
    if let Some(r) = levels {
        let from = aud_end + FADE_FROM_S;
        let mut onset = None;
        let mut loudest = f32::NEG_INFINITY;
        // Window starts as sample offsets, and a microsecond of slack at both
        // bounds: a window starting exactly ON a bound must not flip with the
        // last bit of a float product.
        const EPS: f64 = 1e-6;
        for (i, &db) in r.levels.iter().enumerate() {
            let t = r.t0 + (i * super::continuity::RMS_WIN) as f64 / super::fingerprint::SR as f64;
            if t + EPS < from {
                continue;
            }
            // The fade is read up to the published (mapping A) end.
            if t + EPS >= ref_end_raw {
                break;
            }
            if onset.is_none() && db >= ONSET_DB {
                onset = Some(t);
            }
            loudest = loudest.max(db);
        }
        end = match onset {
            Some(t) => t - ONSET_CUT_S,
            None if !ending => ref_end,
            None if loudest >= LOUD_FADE_DB => aud_end + LOUD_FADE_PAD_S,
            None => ref_end - QUIET_FADE_TRIM_S,
        }
        .min(ref_end);
    }
    let end = round_to(end.min(today.1), 2).min(media_end);
    (end > start).then_some((start, end))
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

// ── early provisional opening ───────────────────────────────────────────────
//
// The accept rule above needs a 30 s run AND 85% of the theme covered, so a
// 0:00 opening is accepted only after about 75-77 s of it has decoded, and the
// prompt landed 10-34 s into the opening in the app. The EARLY rule publishes a
// PROMPT (never an auto-skip) once the theme's own beginning has matched:
//
//   * a run of at least EARLY_RUN_S (12 s) with mean BER <= ACCEPT_BER;
//   * that starts within EARLY_NEAR_S (5 s) of the theme's audible lead, i.e.
//     it is the start of the song, not a chorus heard later;
//   * on the GLOBAL best placement (the run's diagonal within MERGE_DRIFT codes
//     of the best full-overlap offset);
//   * with the same margin floor as the full gate (MARGIN_MIN).
//
// Measured on the skipbench corpus (Python prototype followups/early_accept.py
// + rules.py: 12.2-13.7 s; this Rust implementation in
// `skipdetect_early_rule_corpus`: every opening fires 12.3-14.1 s after the
// theme starts, 0:00 ones at 13.0 s, 27 of 28 endings at 12.4-14.6 s, the
// top-ranked candidate on 55/55 slots), with zero false fires across 6,696
// theme x region pairings once "Over" themes are left out. 8 s let the Bleach
// "Over" insert song through and 10 s had a thin margin, so do NOT go below
// 12 s. The ignored corpus test `skipdetect_early_rule_corpus` checks zero
// false fires, every opening firing, at least 27 endings, window accuracy, the
// top-ranked candidate firing on every slot, and the fire timing with a little
// headroom (OP <= 14.5 s, ED <= 15.0 s after the theme starts).
//
// The provisional window is withdrawn when it is contradicted: the best
// placement moves, the margin falls below the floor, or the run stops short of
// the 30 s accept floor. The full gate replaces it as soon as it accepts.
//
// Cost: the curve is folded INCREMENTALLY (each new query code adds K
// reference comparisons, the same total work as ONE full match), so a check is
// a scan of the curve plus run detection on 5 diagonals, and run detection is
// skipped outright while the margin is below the floor (no theme present). The
// early rule only fires while the region's decoded audio is under
// EARLY_HORIZON_S; after that only an already published provisional theme is
// tracked, until the full gate settles it.

/// Early rule: shortest run that may publish a provisional window. Do not lower.
pub const EARLY_RUN_S: f64 = 12.0;
/// Early rule: the run must start this close to the theme's audible lead.
pub const EARLY_NEAR_S: f64 = 5.0;
/// Early rule cadence, in decoded seconds of the region.
pub const EARLY_EVERY_S: f64 = 1.0;
/// The early rule fires only while the region's decoded audio is shorter than
/// this (an opening that starts later is far behind the decoder by the time
/// the playhead gets there, so the full gate is in time on its own).
pub const EARLY_HORIZON_S: f64 = 300.0;
/// Retract once the provisional run has visibly stopped (the decoded frontier
/// is this far past its end) without reaching ACCEPT_LEN_S.
pub const EARLY_STOP_S: f64 = 4.0;
/// Retract when the best placement moves further than this from the
/// provisional diagonal.
pub const EARLY_MOVE_S: f64 = 2.0;

/// `ber_by_offset` folded incrementally over a GROWING query: push the query
/// prefix as it decodes and read the curve at any time. Identical, value for
/// value, to `ber_by_offset(r, q_prefix, MIN_OVERLAP_S)` (integer sums, same
/// formula).
#[derive(Clone, Debug, Default)]
pub struct EarlyCurve {
    k: usize,
    /// Query codes folded so far.
    n: usize,
    /// Hamming sum and valid-pair count per offset, index `off + k - 1`.
    ham: Vec<u64>,
    cnt: Vec<u32>,
}

impl EarlyCurve {
    pub fn new(r: &Fingerprint) -> Self {
        Self { k: r.len(), n: 0, ham: Vec::new(), cnt: Vec::new() }
    }

    /// Fold the query codes not seen yet (`q` must be the same growing
    /// fingerprint every call; codes never change once emitted).
    pub fn extend(&mut self, r: &Fingerprint, q: &Fingerprint) {
        let k = self.k;
        if k == 0 || q.len() <= self.n {
            return;
        }
        let total = k - 1 + q.len();
        self.ham.resize(total, 0);
        self.cnt.resize(total, 0);
        for j in self.n..q.len() {
            if !q.valid[j] {
                continue;
            }
            let qc = q.codes[j];
            // off = j - i, index = off + k - 1 = j + (k - 1 - i).
            for i in 0..k {
                if r.valid[i] {
                    let idx = j + k - 1 - i;
                    self.ham[idx] += (r.codes[i] ^ qc).count_ones() as u64;
                    self.cnt[idx] += 1;
                }
            }
        }
        self.n = q.len();
    }

    /// The full-overlap BER curve of the folded prefix.
    pub fn curve(&self) -> BerCurve {
        if self.k == 0 || self.n == 0 {
            return BerCurve::default();
        }
        let min_cnt = MIN_OVERLAP_S * FPS;
        let ber = self
            .ham
            .iter()
            .zip(&self.cnt)
            .map(|(&h, &c)| {
                if (c as f64) >= min_cnt {
                    let dot = 32.0 * c as f64 - 2.0 * h as f64;
                    0.5 - dot / (64.0 * c as f64)
                } else {
                    0.5
                }
            })
            .collect();
        BerCurve { first_off: -(self.k as i64 - 1), ber }
    }
}

/// What the early rule sees on one prefix.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EarlyCheck {
    /// Best full-overlap offset (codes) and its BER.
    pub best_off: i64,
    pub best_ber: f64,
    /// round(second - best, 4), as the full gate computes it.
    pub margin: f64,
    /// The longest run (BER <= ACCEPT_BER) on the best diagonal (+- MERGE_DRIFT)
    /// that starts within EARLY_NEAR_S of the theme's audible lead. Only
    /// computed while the margin clears the floor (None otherwise).
    pub run: Option<Run>,
}

impl EarlyCheck {
    /// The early rule: the opening of the theme matched, unambiguously.
    pub fn fires(&self) -> bool {
        self.margin >= MARGIN_MIN && self.run.is_some_and(|r| r.len_s >= EARLY_RUN_S)
    }
}

/// Best offset (first minimum, as numpy's argmin) and the second-best BER more
/// than SECOND_EXCL_S away, rounded like `match_reference`.
fn best_and_second(curve: &BerCurve) -> Option<(i64, f64, f64)> {
    if curve.ber.is_empty() {
        return None;
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
    Some((best_off, round_to(curve.ber[o], 4), round_to(second, 4)))
}

/// Matcher-faithful runs (smooth, threshold, refine, collinear merge) on the
/// diagonals `center - MERGE_DRIFT ..= center + MERGE_DRIFT`, rounded like
/// `match_reference`, longest first.
fn runs_near(r: &Fingerprint, q: &Fingerprint, center: i64) -> Vec<Run> {
    let min_len = MIN_RUN_S * FPS;
    let mut raw = Vec::new();
    for off in center - MERGE_DRIFT..=center + MERGE_DRIFT {
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
            raw.push(RawRun { q: r0 as i64 + s as i64 + off, r: r0 as i64 + s as i64, len: (e - s) as i64, ber: mean, off });
        }
    }
    let mut merged = merge_collinear(raw);
    merged.sort_by(|a, b| b.len.cmp(&a.len));
    merged
        .iter()
        .map(|m| Run {
            q_start_s: round_to(q.t0 + m.q as f64 / FPS, 3),
            r_start_s: round_to(r.t0 + m.r as f64 / FPS, 3),
            len_s: round_to(m.len as f64 / FPS, 3),
            ber: round_to(m.ber, 4),
            ref0_s: round_to(q.t0 - r.t0 + m.off as f64 / FPS, 3),
            off: m.off,
        })
        .collect()
}

/// Evaluate the early rule on the current prefix `q` (with `curve` its folded
/// BER curve against `r`). `audible` = the theme's audible lead / trail.
pub fn early_check(r: &Fingerprint, audible: (f64, f64), q: &Fingerprint, curve: &BerCurve) -> Option<EarlyCheck> {
    let (best_off, best_ber, second) = best_and_second(curve)?;
    let margin = round_to(second - best_ber, 4);
    let mut out = EarlyCheck { best_off, best_ber, margin, run: None };
    if margin < MARGIN_MIN {
        // No unambiguous placement: run detection would be wasted work.
        return Some(out);
    }
    out.run = runs_near(r, q, best_off)
        .into_iter()
        .find(|run| run.ber <= ACCEPT_BER && run.r_start_s <= audible.0 + EARLY_NEAR_S);
    Some(out)
}

/// The provisional window of a fired early check: the reference mapped through
/// the run's diagonal, `[ref0, ref0 + reference length]` rounded like the full
/// gate's mapping (clamping to the media end is the caller's).
pub fn early_window(run: &Run, ref_len_s: f64) -> (f64, f64) {
    (round_to(run.ref0_s, 2).max(0.0), round_to(run.ref0_s + ref_len_s, 2))
}

/// The early provisional window's start under the published edge rule: the
/// theme's audible start on the run's diagonal, never before `early_window`'s
/// own start (`window_start`).
pub fn early_audible_start(run: &Run, lead_s: f64, window_start: f64) -> f64 {
    round_to((run.ref0_s + lead_s).max(window_start), 2).max(0.0)
}

/// Once the decoded frontier is this far past the provisional theme's audible
/// end, the full gate has had its chance (it matches every MATCH_EVERY_S): a
/// provisional window it has not confirmed by then is withdrawn.
pub const EARLY_SETTLE_S: f64 = 2.0 * MATCH_EVERY_S;

/// Why a provisional window was withdrawn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EarlyRetract {
    /// The best placement moved away from the provisional diagonal.
    Moved,
    /// The second-best placement came within the margin floor.
    Margin,
    /// The run stopped before reaching the 30 s accept floor.
    Stopped,
    /// The whole theme has decoded and the full gate did not accept it (a
    /// theme cut short in the episode, or TV-edited).
    Unconfirmed,
}

impl EarlyRetract {
    pub fn as_str(self) -> &'static str {
        match self {
            EarlyRetract::Moved => "best placement moved",
            EarlyRetract::Margin => "margin < 0.15",
            EarlyRetract::Stopped => "run stopped short of 30 s",
            EarlyRetract::Unconfirmed => "the whole theme decoded without passing the full checks",
        }
    }
}

/// Re-check a published provisional window (`fired` = the run it fired on)
/// against a longer prefix. `frontier_s` = absolute time of the decoded
/// frontier; `audible_trail_s` = the theme's audible end in the reference.
/// None = it still stands. The caller stops asking once the full gate has
/// accepted, so `Unconfirmed` means the full gate had its chance and passed.
pub fn early_retract(
    r: &Fingerprint,
    q: &Fingerprint,
    curve: &BerCurve,
    fired: &Run,
    frontier_s: f64,
    audible_trail_s: f64,
) -> Option<EarlyRetract> {
    if frontier_s >= fired.ref0_s + audible_trail_s + EARLY_SETTLE_S {
        return Some(EarlyRetract::Unconfirmed);
    }
    let Some((best_off, best_ber, second)) = best_and_second(curve) else {
        return Some(EarlyRetract::Moved);
    };
    if ((best_off - fired.off).abs() as f64) > EARLY_MOVE_S * FPS {
        return Some(EarlyRetract::Moved);
    }
    if round_to(second - best_ber, 4) < MARGIN_MIN {
        return Some(EarlyRetract::Margin);
    }
    // The run that continues the fired one (same placement, overlapping it).
    let cont = runs_near(r, q, fired.off).into_iter().find(|run| {
        run.ber <= ACCEPT_BER
            && (run.off - fired.off).abs() <= MERGE_DRIFT
            && run.q_start_s <= fired.q_start_s + fired.len_s
            && run.q_start_s + run.len_s >= fired.q_start_s
    });
    match cont {
        Some(run) if run.len_s >= ACCEPT_LEN_S => None,
        Some(run) if frontier_s < run.q_start_s + run.len_s + EARLY_STOP_S => None,
        _ => Some(EarlyRetract::Stopped),
    }
}

/// One theme the early rule may fire on (the caller leaves out "Over" themes
/// and a Transition version while its full version is a candidate). In
/// candidate order: the first theme that fires wins.
pub struct EarlyRef<'a> {
    pub idx: usize,
    pub fp: &'a Fingerprint,
    /// Audible lead / trail (s) of the theme file.
    pub audible: (f64, f64),
}

/// What the early tracker reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EarlyEvent {
    /// Publish a provisional window for theme `idx`.
    Fire { idx: usize, run: Run, margin: f64, window: (f64, f64) },
    /// Withdraw it.
    Retract { idx: usize, why: EarlyRetract },
}

/// The early rule over one streaming region: fires at most once, then watches
/// the fired theme until the caller reports the full gate's acceptance
/// (`stop`) or a contradiction withdraws it. After a withdrawal it stays quiet
/// for the rest of the region (the full gate still decides).
#[derive(Clone, Debug)]
pub struct EarlyTracker {
    curves: Vec<(usize, EarlyCurve)>,
    last_s: Option<f64>,
    /// The theme it fired on, the run, and the theme's audible trail.
    fired: Option<(usize, Run, f64)>,
    done: bool,
    /// Decoded seconds after which it no longer fires (EARLY_HORIZON_S).
    horizon_s: f64,
}

impl Default for EarlyTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl EarlyTracker {
    pub fn new() -> Self {
        Self::with_horizon(EARLY_HORIZON_S)
    }

    /// A tracker with another firing horizon (the corpus test measures the
    /// RULE on endings deep inside TAIL, which production never asks for).
    pub fn with_horizon(horizon_s: f64) -> Self {
        Self { curves: Vec::new(), last_s: None, fired: None, done: false, horizon_s }
    }

    /// The full gate accepted (or the region ended): stop tracking.
    pub fn stop(&mut self) {
        self.done = true;
        self.fired = None;
        self.curves = Vec::new();
    }

    fn curve_for(&mut self, t: &EarlyRef, q: &Fingerprint) -> BerCurve {
        let pos = match self.curves.iter().position(|(i, _)| *i == t.idx) {
            Some(p) => p,
            None => {
                self.curves.push((t.idx, EarlyCurve::new(t.fp)));
                self.curves.len() - 1
            }
        };
        let c = &mut self.curves[pos].1;
        c.extend(t.fp, q);
        c.curve()
    }

    /// One step on the prefix `q` (`decoded_s` seconds of the region decoded).
    /// Runs at most every EARLY_EVERY_S of decoded audio.
    pub fn step(&mut self, decoded_s: f64, q: &Fingerprint, themes: &[EarlyRef]) -> Option<EarlyEvent> {
        if self.done {
            return None;
        }
        if self.last_s.is_some_and(|l| decoded_s - l < EARLY_EVERY_S) {
            return None;
        }
        self.last_s = Some(decoded_s);
        if let Some((idx, run, trail)) = self.fired {
            let t = themes.iter().find(|t| t.idx == idx)?;
            let curve = self.curve_for(t, q);
            let why = early_retract(t.fp, q, &curve, &run, q.t0 + decoded_s, trail)?;
            self.stop();
            return Some(EarlyEvent::Retract { idx, why });
        }
        if decoded_s > self.horizon_s {
            self.stop();
            return None;
        }
        if decoded_s < EARLY_RUN_S {
            return None;
        }
        for t in themes {
            let curve = self.curve_for(t, q);
            let Some(chk) = early_check(t.fp, t.audible, q, &curve) else { continue };
            if !chk.fires() {
                continue;
            }
            let run = chk.run.expect("fires() implies a run");
            self.fired = Some((t.idx, run, t.audible.1));
            // Only the fired theme is tracked from here on.
            self.curves.retain(|(i, _)| *i == t.idx);
            return Some(EarlyEvent::Fire { idx: t.idx, run, margin: chk.margin, window: early_window(&run, t.fp.duration_s()) });
        }
        None
    }
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

    // ── early provisional opening ──

    /// Stream `pcm` through the early tracker the way the region worker does
    /// (chunks of 0.25 s, a step after each), returning every event with the
    /// decoded seconds it came at. `stop_at` = decoded seconds at which the
    /// "full gate" accepts and stops the tracker.
    fn stream_early(r: &Fingerprint, aud: (f64, f64), pcm: &[i16], t0: f64, stop_at: Option<f64>) -> Vec<(f64, EarlyEvent)> {
        let mut fpr = super::super::fingerprint::Fingerprinter::new(t0);
        let mut tr = EarlyTracker::new();
        let refs = [EarlyRef { idx: 0, fp: r, audible: aud }];
        let mut out = Vec::new();
        for chunk in pcm.chunks(SR as usize / 4) {
            fpr.push(chunk);
            let decoded_s = fpr.samples() as f64 / SR as f64;
            if stop_at.is_some_and(|s| decoded_s >= s) {
                tr.stop();
            }
            if let Some(e) = tr.step(decoded_s, fpr.fingerprint(), &refs) {
                out.push((decoded_s, e));
            }
        }
        out
    }

    fn random_fp(n: usize, seed: u64) -> Fingerprint {
        let mut rng = Rng(seed);
        Fingerprint {
            codes: (0..n).map(|_| (rng.next() * u32::MAX as f64) as u32).collect(),
            valid: (0..n).map(|_| rng.next() > 0.1).collect(),
            t0: 0.0,
        }
    }

    #[test]
    fn early_curve_equals_ber_by_offset_on_every_prefix() {
        let r = random_fp(300, 21);
        let full = random_fp(900, 22);
        let mut c = EarlyCurve::new(&r);
        // Uneven growth, including a prefix shorter than the overlap floor.
        for n in [0usize, 7, 150, 151, 400, 655, 900] {
            let q = Fingerprint { codes: full.codes[..n].to_vec(), valid: full.valid[..n].to_vec(), t0: 0.0 };
            c.extend(&r, &q);
            let inc = c.curve();
            let direct = ber_by_offset(&r, &q, MIN_OVERLAP_S);
            assert_eq!(inc.first_off, direct.first_off, "prefix {n}");
            assert_eq!(inc.ber, direct.ber, "prefix {n}: incremental curve must be value-identical");
        }
    }

    #[test]
    fn early_prompt_fires_12_s_into_an_opening_at_zero_and_stands() {
        let th = song(90.0, 31);
        let (r, aud) = theme_fp(&th);
        let pcm = episode(240.0, &th, 0.0, 41);
        let ev = stream_early(&r, aud, &pcm, 0.0, None);
        let (at, first) = ev.first().copied().expect("the early rule fires");
        let EarlyEvent::Fire { window, run, margin, .. } = first else { panic!("{first:?}") };
        assert!((EARLY_RUN_S..EARLY_RUN_S + 3.0).contains(&at), "fired after {at} s of audio");
        assert!(run.len_s >= EARLY_RUN_S && run.ber <= ACCEPT_BER && margin >= MARGIN_MIN, "{run:?} {margin}");
        assert!(window.0.abs() <= 1.0 / FPS && (window.1 - r.duration_s()).abs() <= 1.0 / FPS, "{window:?}");
        // No full gate here: it stands for the whole theme, then is withdrawn
        // as unconfirmed (never before the theme has finished decoding).
        let retracts: Vec<_> = ev.iter().filter(|(_, e)| matches!(e, EarlyEvent::Retract { .. })).collect();
        assert_eq!(retracts.len(), 1, "{ev:?}");
        let (t_ret, e) = retracts[0];
        assert!(matches!(e, EarlyEvent::Retract { why: EarlyRetract::Unconfirmed, .. }), "{e:?}");
        assert!(*t_ret >= aud.1 + EARLY_SETTLE_S - 0.5, "withdrawn at {t_ret} before the theme decoded");
    }

    #[test]
    fn early_prompt_never_withdrawn_once_the_full_gate_accepts() {
        let th = song(90.0, 32);
        let (r, aud) = theme_fp(&th);
        let at = 57.3;
        let pcm = episode(260.0, &th, at, 42);
        // The full gate accepts this theme at about at + 77 s; the caller stops
        // the tracker then.
        let ev = stream_early(&r, aud, &pcm, 0.0, Some(at + 80.0));
        assert_eq!(ev.len(), 1, "fire only: {ev:?}");
        let (t, EarlyEvent::Fire { window, .. }) = ev[0] else { panic!() };
        assert!(t >= at + EARLY_RUN_S && t <= at + EARLY_RUN_S + 3.0, "fired at {t}");
        assert!((window.0 - at).abs() <= 1.0 / FPS, "{window:?}");
    }

    #[test]
    fn early_rule_ignores_short_snippets_and_mid_song_entries() {
        let th = song(90.0, 33);
        let (r, aud) = theme_fp(&th);
        // 8 s of the theme's start: below EARLY_RUN_S.
        let pcm = episode(200.0, &th[..8 * SR as usize], 30.0, 43);
        assert!(stream_early(&r, aud, &pcm, 0.0, None).is_empty());
        // 40 s of the theme heard from its middle (a chorus as an insert song):
        // long enough, but it is not the song's beginning.
        let mid = &th[40 * SR as usize..80 * SR as usize];
        let pcm = episode(200.0, mid, 30.0, 44);
        assert!(stream_early(&r, aud, &pcm, 0.0, None).is_empty());
    }

    #[test]
    fn early_prompt_withdrawn_when_the_run_dies_young() {
        let th = song(90.0, 34);
        let (r, aud) = theme_fp(&th);
        // 20 s of the theme's beginning, then different music.
        let mut ins = th[..20 * SR as usize].to_vec();
        ins.extend(song(60.0, 77));
        let pcm = episode(220.0, &ins, 10.0, 45);
        let ev = stream_early(&r, aud, &pcm, 0.0, None);
        assert!(matches!(ev.first(), Some((_, EarlyEvent::Fire { .. }))), "{ev:?}");
        let (t, e) = ev.get(1).copied().expect("withdrawn");
        assert!(matches!(e, EarlyEvent::Retract { .. }), "{e:?}");
        // Withdrawn within a few seconds of the run's end (10 + 20 s).
        assert!(t <= 30.0 + EARLY_STOP_S + 3.0, "withdrawn only at {t}");
        assert_eq!(ev.len(), 2, "quiet after a withdrawal: {ev:?}");
    }

    #[test]
    fn early_prompt_withdrawn_for_truncated_and_tv_edited_themes() {
        let th = song(90.0, 35);
        let (r, aud) = theme_fp(&th);
        // 60% of the theme then other music: the full gate's coverage check
        // rejects it, so the provisional window must not outlive the theme.
        let cut = (0.6 * th.len() as f64) as usize;
        let mut ins = th[..cut].to_vec();
        ins.extend(song(36.0, 99));
        let pcm = episode(260.0, &ins, 40.0, 46);
        let ev = stream_early(&r, aud, &pcm, 0.0, None);
        assert!(matches!(ev.first(), Some((_, EarlyEvent::Fire { .. }))), "{ev:?}");
        let (t, e) = ev.get(1).copied().expect("withdrawn");
        assert!(matches!(e, EarlyEvent::Retract { .. }), "{e:?}");
        assert!(t <= 40.0 + aud.1 + EARLY_SETTLE_S + 2.0, "withdrawn at {t}");
        // A TV edit (20 s cut from the middle): the second half sits on another
        // diagonal; the provisional window goes when that becomes visible.
        let mid = th.len() / 2;
        let half = (10.0 * SR as f64) as usize;
        let mut tv = th[..mid - half].to_vec();
        tv.extend_from_slice(&th[mid + half..]);
        let pcm = episode(260.0, &tv, 50.0, 47);
        let ev = stream_early(&r, aud, &pcm, 0.0, None);
        assert!(matches!(ev.first(), Some((_, EarlyEvent::Fire { .. }))), "{ev:?}");
        let (t, e) = ev.get(1).copied().expect("withdrawn");
        assert!(matches!(e, EarlyEvent::Retract { .. }), "{e:?}");
        assert!(t <= 50.0 + 90.0, "withdrawn at {t}, after the edited theme ended");
    }

    #[test]
    fn early_rule_respects_its_horizon() {
        let th = song(60.0, 36);
        let (r, aud) = theme_fp(&th);
        // Starts after the horizon: the full gate alone handles it.
        let at = EARLY_HORIZON_S + 5.0;
        let pcm = episode(at + 90.0, &th, at, 48);
        assert!(stream_early(&r, aud, &pcm, 0.0, None).is_empty());
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

    #[test]
    fn a_reference_shorter_than_the_run_gate_is_never_accepted() {
        // A short-form cour's 20 s theme, present whole in the episode: the
        // 30 s run floor can never pass (the documented limit the job turns
        // into an undecided kind, not an informative abstain).
        let th = song(20.0, 3);
        let (r, aud) = theme_fp(&th);
        assert!(too_short_to_match(aud));
        let q = fingerprint(&episode(120.0, &th, 40.0, 8), 0.0);
        let m = evaluate_theme(&r, aud, &q);
        assert!(!m.accepted);
        assert_eq!(m.reject, Some(Reject::RunTooShort), "{m:?}");
        assert!(!too_short_to_match((0.4, 89.6)));
    }

    /// An accepted single-diagonal match at `ref0` with reference length 90.
    fn accepted_at(ref0: f64) -> ThemeMatch {
        ThemeMatch {
            accepted: true,
            reject: None,
            longest_run_s: 85.0,
            run_ber: Some(0.1),
            best_ber: 0.1,
            second_ber: 0.45,
            margin: 0.35,
            soft42: Some(0.95),
            chained: 1,
            raw_window: Some((ref0, ref0 + 90.0)),
            matched_span: None,
            ref0_s: Some(ref0),
            ref_len_s: 90.0,
        }
    }

    /// Region levels from t0 = 900: quiet (-80 dB) except `loud` = [(from,
    /// to, dB)] spans, on the 0.4 s grid.
    fn levels(loud: &[(f64, f64, f32)]) -> Vec<f32> {
        (0..1000)
            .map(|i| {
                let t = 900.0 + i as f64 * 0.4;
                loud.iter().find(|(a, b, _)| t >= *a && t < *b).map_or(-80.0, |x| x.2)
            })
            .collect()
    }

    #[test]
    fn edge_refinement_rules() {
        // Theme file: 90 s, audible 0.5 to 86.0 s. Matched at 1000: reference
        // end 1090, audible end 1086, the fade window [1086.25, 1090).
        let m = accepted_at(1000.0);
        let aud = (0.5, 86.0);
        let me = 2000.0;
        let r = |lv: &Vec<f32>, ending: bool| refine_layer1_window(&m, aud, ending, Some(RegionLevels { levels: lv, t0: 900.0 }), me).unwrap();
        // Still decoding: the audible start, mapping A's end.
        assert_eq!(refine_layer1_window(&m, aud, true, None, me), Some((1000.5, 1090.0)));
        assert_eq!(layer1_window(&m, me), Some((1000.0, 1090.0)), "mapping A is unchanged");
        // A preview starts inside the fade (window at 1088.0 is -30 dB): both
        // kinds end ONSET_CUT_S before it.
        let preview = levels(&[(1088.0, 1200.0, -30.0)]);
        assert_eq!(r(&preview, true), (1000.5, 1087.0));
        assert_eq!(r(&preview, false), (1000.5, 1087.0));
        // A fade talked over (-50 dB, no onset): an ending stops just after
        // the song, an opening keeps its end.
        let talked = levels(&[(1086.0, 1095.0, -50.0)]);
        assert_eq!(r(&talked, true), (1000.5, 1086.5));
        assert_eq!(r(&talked, false), (1000.5, 1090.0));
        // A quiet held card: an ending ends QUIET_FADE_TRIM_S early, an
        // opening keeps its end.
        let card = levels(&[]);
        assert_eq!(r(&card, true), (1000.5, 1089.5));
        assert_eq!(r(&card, false), (1000.5, 1090.0));
        // Only windows STARTING inside the fade count: loud audio at 1086.0
        // (before the fade) or from 1090.0 (after the reference end) is not
        // an onset, and not a loud fade either.
        let outside = levels(&[(1085.6, 1086.25, -20.0), (1090.0, 1200.0, -20.0)]);
        assert_eq!(r(&outside, true), (1000.5, 1089.5));
        // Exactly at the -40 dB onset level counts; just below it is a loud fade.
        assert_eq!(r(&levels(&[(1088.0, 1090.0, ONSET_DB)]), true).1, 1087.0);
        assert_eq!(r(&levels(&[(1088.0, 1090.0, ONSET_DB - 0.1)]), true).1, 1086.5);
        // Never past the media end, never past mapping A.
        let near_end = refine_layer1_window(&m, aud, true, Some(RegionLevels { levels: &card, t0: 900.0 }), 1088.8).unwrap();
        assert_eq!(near_end, (1000.5, 1088.8));
        // An opening at 0:00 whose reference starts before the file: the
        // audible start on its diagonal, never below 0.
        let m0 = accepted_at(-1.0);
        assert_eq!(refine_layer1_window(&m0, (2.0, 86.0), false, None, me), Some((1.0, 89.0)));
        assert_eq!(refine_layer1_window(&m0, (0.5, 86.0), false, None, me), Some((0.0, 89.0)));
        // Nothing left: None (the job abstains).
        let gone = refine_layer1_window(&m, aud, true, Some(RegionLevels { levels: &preview, t0: 900.0 }), 1000.4);
        assert_eq!(gone, None);
        // A rejected match publishes nothing.
        let mut rej = accepted_at(1000.0);
        rej.accepted = false;
        assert_eq!(refine_layer1_window(&rej, aud, true, None, me), None);
    }

    #[test]
    fn early_window_takes_the_audible_start() {
        let run = Run { off: 0, q_start_s: 10.0, r_start_s: 2.0, len_s: 12.0, ber: 0.2, ref0_s: 8.0 };
        let w = early_window(&run, 90.0);
        assert_eq!(w, (8.0, 98.0));
        assert_eq!(early_audible_start(&run, 2.3, w.0), 10.3);
        let run0 = Run { ref0_s: -1.0, ..run };
        assert_eq!(early_audible_start(&run0, 0.5, early_window(&run0, 90.0).0), 0.0);
    }
}
