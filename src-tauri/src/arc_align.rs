// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Story-arc episode alignment: TMDB numbering to Aura (Cinemeta / TVDB) numbering.
//!
//! # Why this module exists (read before "simplifying" it)
//!
//! Story Arcs come from TMDB's episode-group API, which describes an arc as a set of
//! TMDB `(season, episode)` pairs. Aura's own episode list comes from Stremio meta addons,
//! which use Cinemeta / TVDB numbering. **The two numbering systems disagree**, and a naive
//! "join on absolute index" (or on season/episode) is catastrophically, silently wrong.
//!
//! The canonical proof is One Piece. TMDB promotes the Toriko / One Piece / Dragon Ball Z
//! crossover special into the MAIN RUN at absolute episode 590. Cinemeta files that very same
//! episode as a special, `S0E39`, so it never enters the main-run list at all. The consequence:
//!
//! ```text
//!   TMDB abs N  ==  Cinemeta abs N        for N <= 589
//!   TMDB abs N  ==  Cinemeta abs N - 1    for N >= 591
//! ```
//!
//! A naive absolute-index join misplaces 579 of One Piece's 1168 episodes (49.6 percent): every
//! arc from Punk Hazard onward starts and ends exactly one episode late, and nothing anywhere
//! reports an error. It just quietly shows the wrong episodes for the rest of the series.
//!
//! Neither of the obvious single keys is sufficient either:
//!
//! * **Air date is not a key.** Weekly anime run duplicate air dates: 40 of Naruto Shippuden's
//!   air dates carry two episodes, and an exact-date join resolves only about 84 percent of
//!   Shippuden uniquely.
//! * **Title is not a key.** TVDB and TMDB use different English translations of the same
//!   episode ("Shichibukai! Trafalgar Law" vs "The Warlord! Trafalgar Law"); some genuinely
//!   matching pairs score 0.00 on bigram similarity. TVDB also glues arc names onto titles
//!   ("Kakashi: Shadow of the ANBU Black Ops - Minato's Death" vs "Minato's Death").
//!
//! # The fix
//!
//! Banded Needleman-Wunsch **global sequence alignment** of two lists that are both already in
//! broadcast order. Monotonicity (an alignment path can never cross itself) is what defeats both
//! failure modes at once: it absorbs the extra TMDB episode as a single gap instead of
//! propagating a +1 shift, and it disambiguates duplicate air dates by order.
//!
//! ```text
//!   score(a, b) = 0.55 * date_proximity + 0.45 * dice_bigram(norm(a.title), norm(b.title))
//!   date_proximity by |delta days|:  <=1 -> 1.0, <=3 -> 0.9, <=7 -> 0.75,
//!                                    <=14 -> 0.4, <=35 -> 0.1, else -2.5
//!                                    (either side dateless -> 0.0, neutral, never negative)
//!   strong-exact-far: EXACT normalized-title equality + a FAR date (> 35 days) scores a fixed
//!                     0.70, above a date-perfect mismatch (0.55), so a mis-dated block stays on
//!                     its title diagonal instead of sliding onto the one its wrong dates fit
//!   gap penalty: -0.35 per unmatched episode, on either side
//!   band: only cells with |i - j| <= 64 are considered (O(n * band), forbids absurd reorderings)
//! ```
//!
//! Two soft terms, each of which is individually unreliable, plus a hard monotonic constraint.
//! Measured 100 percent correct on One Piece (1168/1168) and Naruto Shippuden (500/500).
//!
//! # The AIOMetadata date-shift case (why strong-exact-far + interior-fill exist)
//!
//! A meta addon can carry the RIGHT title but a badly WRONG date for a whole block. AIOMetadata
//! dates original Naruto's "Jiraiya Returns" block (17 episodes) ~18 weeks early, with titles
//! byte-identical to TMDB's. Those wrong dates line up perfectly with a DIFFERENT positional
//! diagonal, so a plain date+title DP slides the entire middle of the show over by 17 and strands
//! two DISJOINT unmatched tails (TMDB's finale vs the addon's Jiraiya block) that share no titles,
//! so no residual can bridge them: only 20 of 23 arcs survived. Two additions fix it without
//! disturbing the general weights (which keep date-carried filler runs above the arc-confidence
//! gate):
//!
//! * **strong-exact-far** (in `pair_score`): pins an exact-title far-date pair in place, so the DP
//!   cannot take the mis-dated diagonal. This recovers the exactly-equal titles (16 of the block's
//!   17), holding the correct diagonal.
//! * **interior-bracket-fill** (a residual): between two matched anchors, if the two sides have the
//!   SAME number of leftover episodes, pair them positionally. This recovers the near-exact titles
//!   (e.g. "Byakugan vs. Shadow Clone" vs "...Shadow Clone Jutsu!") that the exact gate skips,
//!   bracketed and made safe by the pins around them.
//!
//! With both, original Naruto aligns 220/220 (all 23 arcs), One Piece and Shippuden unchanged.
//! Requires the caller to sort both lists by (season, episode), NOT air date: the addon's numbering
//! is its reliable broadcast order, and sorting by its corrupted dates re-scatters the very block
//! this fixes (see `arcs.rs`).
//!
//! Both input lists must already be sorted in broadcast order and filtered to the main run
//! (season >= 1). Specials on either side are the thing this module exists to survive, not to
//! consume: a TMDB-only entry lands in [`Alignment::left_only`] and is simply dropped from the arc.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Weight of the air-date term in the pair score.
const W_DATE: f64 = 0.55;
/// Weight of the title-similarity term in the pair score.
const W_TITLE: f64 = 0.45;
/// Cost of leaving one episode unmatched on either side.
const GAP: f64 = -0.35;
/// A |delta days| past this is "far": almost never the same episode by date alone. Used by both
/// the date-proximity floor and the strong-exact-far override below.
const FAR_DELTA: i64 = 35;
/// Score awarded to a pair whose normalized titles are EXACTLY equal but whose dates are FAR apart
/// (the [`FAR_DELTA`] regime). This is the AIOMetadata date-shift case: an addon carries the right
/// title but a badly wrong date (Naruto's "Jiraiya Returns" is dated ~18 weeks early), and those
/// wrong dates line up perfectly with a different positional diagonal. A date-led DP would slide
/// the whole block onto that diagonal; pinning exact-title pairs at a score ABOVE a date-perfect
/// mismatch (`W_DATE * 1.0 = 0.55`, plus a little for any incidental title overlap it carries)
/// keeps the DP on the correct title diagonal. 0.70 clears that with margin while staying below a
/// genuine near-date exact match (which scores up to ~0.95), so it never out-competes a real match.
/// Gated on EXACT equality (not a dice threshold) so it can never cross formulaic "Part 1"/"Part 2"
/// titles, which are 0.95 similar but distinct.
const STRONG_EXACT_FAR_SCORE: f64 = 0.70;
/// Base half-width of the alignment band. This bounds how far apart in position two episodes may
/// be and still match, which is what keeps the DP O(n * band) and forbids absurd re-orderings.
///
/// It has to be wider than the LONGEST run of consecutive gaps the two sources can force. Real
/// addon metadata (AIOMetadata) and TMDB routinely disagree on where filler episodes sit and how
/// they are dated, so a whole filler block can need gapping on one side; a band of 12 could not
/// span that and the alignment fell off-band and left every later episode unmatched (Naruto showed
/// only its first arc or two). 64 spans any realistic block while staying cheap even for One Piece
/// (~1168 * 129 cells). The far-date floor below is what keeps a wide band SAFE: a clearly-wrong
/// pair scores worse than a gap, so the DP gaps a mismatch rather than reaching across the band to
/// force a bad match.
const BAND: i64 = 64;
/// Refuse to align lists longer than this (a real series never comes close). Over the cap the
/// aligner returns an empty [`Alignment`] rather than allocating an enormous DP table.
const MAX_EPISODES: usize = 4000;
/// Second safety valve on the DP table: pathological length mismatches widen the band, and a
/// wide band on a long list is what would actually blow the allocation. Same bail-out.
const MAX_CELLS: usize = 8_000_000;

// Traceback directions.
const DIR_NONE: u8 = 0;
/// Matched left[i - 1] with right[j - 1].
const DIR_DIAG: u8 = 1;
/// left[i - 1] is unmatched (a gap on the TMDB side).
const DIR_UP: u8 = 2;
/// right[j - 1] is unmatched (a gap on the Aura side).
const DIR_LEFT: u8 = 3;

/// One episode on either side of the alignment. Both lists must already be
/// sorted in broadcast order and filtered to the MAIN RUN (season >= 1).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlignEpisode {
    /// Opaque handle the caller uses to identify this episode (an Aura video
    /// id, or a TMDB "s:e" key). Never interpreted here.
    pub key: String,
    /// Episode title, may be empty.
    pub title: String,
    /// Release date as days since the Unix epoch. None when unknown/unparseable.
    pub day: Option<i64>,
}

/// A matched pair plus the confidence the aligner had in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AlignPair {
    /// TMDB side.
    pub left_key: String,
    /// Aura side.
    pub right_key: String,
    /// The RAW pair score, roughly -0.5 ..= 1.0. This is what the DP maximises.
    /// It is NOT a confidence: a pair with no air date on one side can never
    /// exceed `W_TITLE` (0.45) no matter how perfectly its title matches, so
    /// comparing it against an absolute threshold punishes missing data rather
    /// than bad data. Use `confidence` for that.
    pub score: f64,
    /// The pair score renormalised against the evidence that was actually
    /// AVAILABLE for this pair: `score / (W_DATE if both have a date) + (W_TITLE
    /// if both have a title)`. So a title-perfect pair with no date scores 0.45
    /// raw but 1.0 confidence, while a pair whose available signals DISAGREE
    /// still scores low. 0.0 when neither side offers any signal at all (no
    /// evidence is not the same as good evidence).
    pub confidence: f64,
}

/// The result of aligning a TMDB list (left) against an Aura list (right).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Alignment {
    pub pairs: Vec<AlignPair>,
    /// TMDB episodes with no Aura counterpart.
    pub left_only: Vec<String>,
    /// Aura episodes with no TMDB counterpart.
    pub right_only: Vec<String>,
}

impl Alignment {
    /// Map a TMDB key to an Aura key. None when unmatched. `arcs.rs` builds its
    /// own HashMap for the hot per-episode loop; this stays as the type's
    /// single-lookup API and is exercised by the tests.
    #[allow(dead_code)]
    pub fn map(&self, left_key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|p| p.left_key == left_key)
            .map(|p| p.right_key.as_str())
    }

    /// The lowest pair score in the alignment (1.0 when there are no pairs).
    /// A low value is the signal that the alignment should not be trusted.
    pub fn min_score(&self) -> f64 {
        let mut min = f64::INFINITY;
        for p in &self.pairs {
            if p.score < min {
                min = p.score;
            }
        }
        if min.is_finite() {
            min
        } else {
            1.0
        }
    }

    /// RAW score of a specific pair, by TMDB key. For diagnostics and tests.
    /// Gate on `confidence_of` instead: this value is not comparable across
    /// pairs that carry different signals.
    #[allow(dead_code)]
    pub fn score_of(&self, left_key: &str) -> Option<f64> {
        self.pairs
            .iter()
            .find(|p| p.left_key == left_key)
            .map(|p| p.score)
    }

    /// Evidence-normalised confidence of a specific pair, by TMDB key. THIS is
    /// what a trust threshold should compare against. (arcs.rs reads confidence
    /// straight off the indexed pairs; kept as the by-key accessor.)
    #[allow(dead_code)]
    pub fn confidence_of(&self, left_key: &str) -> Option<f64> {
        self.pairs
            .iter()
            .find(|p| p.left_key == left_key)
            .map(|p| p.confidence)
    }

    /// The lowest pair confidence in the alignment (1.0 when there are no pairs).
    pub fn min_confidence(&self) -> f64 {
        let mut min = f64::INFINITY;
        for p in &self.pairs {
            if p.confidence < min {
                min = p.confidence;
            }
        }
        if min.is_finite() { min } else { 1.0 }
    }
}

/// Bigram multiset of a normalised title.
type BigramMap = HashMap<(char, char), u32>;

/// An episode with its comparison terms precomputed once, so the O(n * band) DP never
/// re-normalises a title or rebuilds a bigram map.
struct Prepped {
    key: String,
    norm: String,
    bigrams: BigramMap,
    bigram_total: u32,
    day: Option<i64>,
}

fn prep(e: &AlignEpisode) -> Prepped {
    let norm = normalize_title(&e.title);
    let (bigrams, bigram_total) = bigram_profile(&norm);
    Prepped {
        key: e.key.clone(),
        norm,
        bigrams,
        bigram_total,
        day: e.day,
    }
}

/// Align two broadcast-ordered main-run episode lists.
///
/// `left` is the TMDB side, `right` is the Aura side. Deterministic: equal-scoring paths always
/// resolve the same way (ties prefer the diagonal, so a match never drifts into a pair of gaps).
pub fn align(left: &[AlignEpisode], right: &[AlignEpisode]) -> Alignment {
    let n = left.len();
    let m = right.len();

    if n == 0 || m == 0 || n > MAX_EPISODES || m > MAX_EPISODES {
        return unaligned(left, right);
    }

    // A path from (0, 0) to (n, m) has to reach |i - j| = |n - m| at some point, so the band must
    // be at least that wide or there would be no complete path at all.
    let diff = (n as i64 - m as i64).abs();
    let band = if diff > BAND { BAND + diff } else { BAND };

    // Banded row layout: row i spans columns lo[i] ..= hi[i], clamped to [0, m].
    let mut lo = Vec::with_capacity(n + 1);
    let mut hi = Vec::with_capacity(n + 1);
    let mut offsets = Vec::with_capacity(n + 1);
    let mut cells: usize = 0;
    for i in 0..=n {
        let l = (i as i64 - band).max(0) as usize;
        let h = ((i as i64 + band).min(m as i64)) as usize;
        lo.push(l);
        hi.push(h);
        offsets.push(cells);
        cells += h - l + 1;
        if cells > MAX_CELLS {
            return unaligned(left, right);
        }
    }

    let lefts: Vec<Prepped> = left.iter().map(prep).collect();
    let rights: Vec<Prepped> = right.iter().map(prep).collect();

    let mut best = vec![f64::NEG_INFINITY; cells];
    let mut back = vec![DIR_NONE; cells];

    let at = |i: usize, j: usize| -> usize { offsets[i] + (j - lo[i]) };
    let in_band = |i: usize, j: usize| -> bool { j >= lo[i] && j <= hi[i] };

    best[at(0, 0)] = 0.0;

    for i in 0..=n {
        for j in lo[i]..=hi[i] {
            if i == 0 && j == 0 {
                continue;
            }
            let mut cell = f64::NEG_INFINITY;
            let mut dir = DIR_NONE;

            // Diagonal (a match) is evaluated first and every later candidate needs to beat it
            // strictly, so ties prefer the match and equal-scoring paths do not drift.
            if i > 0 && j > 0 && in_band(i - 1, j - 1) {
                let prev = best[at(i - 1, j - 1)];
                if prev > f64::NEG_INFINITY {
                    let s = prev + pair_score(&lefts[i - 1], &rights[j - 1]);
                    if s > cell {
                        cell = s;
                        dir = DIR_DIAG;
                    }
                }
            }
            // Up: left[i - 1] goes unmatched.
            if i > 0 && in_band(i - 1, j) {
                let prev = best[at(i - 1, j)];
                if prev > f64::NEG_INFINITY {
                    let s = prev + GAP;
                    if s > cell {
                        cell = s;
                        dir = DIR_UP;
                    }
                }
            }
            // Left: right[j - 1] goes unmatched.
            if j > 0 && in_band(i, j - 1) {
                let prev = best[at(i, j - 1)];
                if prev > f64::NEG_INFINITY {
                    let s = prev + GAP;
                    if s > cell {
                        cell = s;
                        dir = DIR_LEFT;
                    }
                }
            }

            let idx = at(i, j);
            best[idx] = cell;
            back[idx] = dir;
        }
    }

    // Traceback from (n, m). The band guarantees that cell is reachable. Work in
    // INDICES so the residual pass can reach each episode's Prepped comparison
    // terms; keys are built at the very end.
    let mut matched: Vec<(usize, usize)> = Vec::new(); // (left idx, right idx)
    let mut left_unmatched: Vec<usize> = Vec::new();
    let mut right_unmatched: Vec<usize> = Vec::new();

    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        match back[at(i, j)] {
            DIR_DIAG if i > 0 && j > 0 => {
                matched.push((i - 1, j - 1));
                i -= 1;
                j -= 1;
            }
            DIR_UP if i > 0 => {
                left_unmatched.push(i - 1);
                i -= 1;
            }
            DIR_LEFT if j > 0 => {
                right_unmatched.push(j - 1);
                j -= 1;
            }
            _ => {
                // Unreachable with a well formed band. Fail loudly in the result rather than
                // silently truncating: everything still unconsumed becomes unmatched.
                for k in (0..i).rev() {
                    left_unmatched.push(k);
                }
                for k in (0..j).rev() {
                    right_unmatched.push(k);
                }
                break;
            }
        }
    }
    matched.reverse();
    left_unmatched.reverse();
    right_unmatched.reverse();

    let mut pairs: Vec<AlignPair> = matched
        .iter()
        .map(|&(li, ri)| {
            let score = pair_score(&lefts[li], &rights[ri]);
            AlignPair {
                left_key: lefts[li].key.clone(),
                right_key: rights[ri].key.clone(),
                score,
                confidence: pair_confidence(score, attainable(&lefts[li], &rights[ri])),
            }
        })
        .collect();
    // `matched` is kept alive past this point: the residual passes append their
    // (left, right) index pairs to it so the interior-bracket-fill below sees the
    // FULL set of anchors, DP and residual alike.

    // Residual pass, over the episodes the monotone DP left UNMATCHED on both
    // sides. Where the two sources ORDER a block differently (a shuffle or a
    // re-sorted run) the positional DP cannot pair it and gaps the block on both
    // sides. Real addons do this to the tail filler of long anime (Naruto's last
    // ~17 episodes came back reordered relative to TMDB, with the SAME air
    // dates). We recover those order-independently by matching on a NEAR-EXACT
    // air date.
    //
    // The near-exact date gate (`RESIDUAL_MAX_DELTA` days) is what keeps this
    // safe. Weekly episodic content is only 7 days apart, so accepting a looser
    // date would let a 1-week reorder pair adjacent-but-different episodes, which
    // is exactly the off-by-one this whole module exists to prevent. A same-date
    // shuffle is unambiguous; a one-week reorder is not, so we only take the
    // former. The One Piece crossover (unmatched on ONE side only) has no
    // counterpart and stays a clean gap. Bounded so a total misalignment does not
    // become O(n^2) work.
    const RESIDUAL_MAX: usize = 512;
    const RESIDUAL_MAX_DELTA: i64 = 3;
    // Sub-pass 2 (below) only fires when the two dates are at least `FAR_DELTA`
    // apart, so it never touches the near-date regime the off-by-one protection
    // guards.
    let mut left_consumed = vec![false; left_unmatched.len()];
    let mut right_consumed = vec![false; right_unmatched.len()];
    if !left_unmatched.is_empty()
        && !right_unmatched.is_empty()
        && left_unmatched.len() <= RESIDUAL_MAX
        && right_unmatched.len() <= RESIDUAL_MAX
    {
        for (lk, &li) in left_unmatched.iter().enumerate() {
            let Some(lday) = lefts[li].day else { continue };
            let mut best_rk: Option<usize> = None;
            let mut best_delta = i64::MAX;
            let mut best_dice = -1.0;
            for (rk, &ri) in right_unmatched.iter().enumerate() {
                if right_consumed[rk] {
                    continue;
                }
                let Some(rday) = rights[ri].day else { continue };
                let delta = (lday - rday).abs();
                if delta > RESIDUAL_MAX_DELTA {
                    continue;
                }
                // Among near-exact-date candidates, prefer the closest date, then
                // the best title, so a run of same-date episodes still resolves.
                let dice = dice_from_counts(
                    &lefts[li].norm, &lefts[li].bigrams, lefts[li].bigram_total,
                    &rights[ri].norm, &rights[ri].bigrams, rights[ri].bigram_total,
                );
                if delta < best_delta || (delta == best_delta && dice > best_dice) {
                    best_delta = delta;
                    best_dice = dice;
                    best_rk = Some(rk);
                }
            }
            if let Some(rk) = best_rk {
                let ri = right_unmatched[rk];
                let score = pair_score(&lefts[li], &rights[ri]);
                right_consumed[rk] = true;
                left_consumed[lk] = true;
                matched.push((li, ri));
                pairs.push(AlignPair {
                    left_key: lefts[li].key.clone(),
                    right_key: rights[ri].key.clone(),
                    score,
                    confidence: pair_confidence(score, attainable(&lefts[li], &rights[ri])),
                });
            }
        }

        // Sub-pass 2: STRONG-TITLE recovery, for the case where an addon has the
        // right titles but WRONG dates for a block. AIOMetadata dates Naruto's
        // "Jiraiya Returns" four months early (2003-06 vs the real 2003-10), so
        // neither the monotone DP nor sub-pass 1 can place it, yet its title is
        // byte-identical to TMDB's. We pair such leftovers on EXACT normalized
        // title, under three guards that keep it as safe as the date path:
        //   1. Exact normalized-title equality, NOT a dice threshold. dice("...
        //      part 1", "... part 2") is 0.95, so a threshold would cross
        //      formulaic titles; exact string equality keeps "part 1" and
        //      "part 2" distinct and un-crossable.
        //   2. The title must be UNIQUE among the still-unmatched pool on BOTH
        //      sides. A genuinely duplicated title ("Assault!" twice) stays a gap
        //      rather than risk pairing the wrong instance.
        //   3. FAR dates only (or a side dateless). This confines the branch to
        //      gross mis-dating and leaves the near-date off-by-one protection
        //      (a 7-day reorder is still refused) completely untouched.
        // Confidence is scored on the TITLE axis alone, so a recovered exact-title
        // pair reads as confidence 1.0 (its raw date-poisoned score would be
        // negative and would otherwise make arcs.rs drop the whole arc).
        let mut left_norm_count: HashMap<&str, u32> = HashMap::new();
        let mut right_norm_count: HashMap<&str, u32> = HashMap::new();
        for (lk, &li) in left_unmatched.iter().enumerate() {
            if !left_consumed[lk] && !lefts[li].norm.is_empty() {
                *left_norm_count.entry(lefts[li].norm.as_str()).or_insert(0) += 1;
            }
        }
        for (rk, &ri) in right_unmatched.iter().enumerate() {
            if !right_consumed[rk] && !rights[ri].norm.is_empty() {
                *right_norm_count.entry(rights[ri].norm.as_str()).or_insert(0) += 1;
            }
        }
        for (lk, &li) in left_unmatched.iter().enumerate() {
            if left_consumed[lk] || lefts[li].norm.is_empty() {
                continue;
            }
            let norm = lefts[li].norm.as_str();
            if left_norm_count.get(norm) != Some(&1) || right_norm_count.get(norm) != Some(&1) {
                continue; // guard 1 + 2: unique exact title on both sides
            }
            let Some((rk, &ri)) = right_unmatched
                .iter()
                .enumerate()
                .find(|&(rk, &ri)| !right_consumed[rk] && rights[ri].norm == lefts[li].norm)
            else {
                continue;
            };
            let far = match (lefts[li].day, rights[ri].day) {
                (Some(a), Some(b)) => (a - b).abs() > FAR_DELTA,
                _ => true,
            };
            if !far {
                continue; // guard 3: near-date pairs belong to sub-pass 1 / the DP
            }
            let dice = dice_from_counts(
                &lefts[li].norm, &lefts[li].bigrams, lefts[li].bigram_total,
                &rights[ri].norm, &rights[ri].bigrams, rights[ri].bigram_total,
            );
            let score = W_TITLE * dice;
            right_consumed[rk] = true;
            left_consumed[lk] = true;
            matched.push((li, ri));
            pairs.push(AlignPair {
                left_key: lefts[li].key.clone(),
                right_key: rights[ri].key.clone(),
                score,
                confidence: pair_confidence(score, W_TITLE),
            });
        }
    }

    // What is STILL unmatched after both residual passes, as per-index open flags
    // (a whole-length bool is cheaper to probe than scanning the unmatched vecs,
    // and the interior-fill below needs O(1) "is index k open?" lookups).
    let mut left_open = vec![false; n];
    for (lk, &li) in left_unmatched.iter().enumerate() {
        if !left_consumed[lk] {
            left_open[li] = true;
        }
    }
    let mut right_open = vec![false; m];
    for (rk, &ri) in right_unmatched.iter().enumerate() {
        if !right_consumed[rk] {
            right_open[ri] = true;
        }
    }

    // Sub-pass 3: INTERIOR-BRACKET-FILL. Some episodes remain gapped BETWEEN two
    // matched anchors. The Naruto date-shift block is pinned at its exactly-equal
    // titles by pair_score's strong-exact-far override, but the NEAR-exact ones in
    // between ("Byakugan vs. Shadow Clone" vs "...Shadow Clone Jutsu!") are neither
    // exact (sub-pass 2 skips them) nor same-date (sub-pass 1 skips them). Between
    // two correct anchors, if the two sides have the SAME number of leftover
    // episodes, their broadcast order is unambiguous, so pair them positionally.
    //
    // The equal-count guard is the whole safety story: a one-sided gap (the One
    // Piece crossover -- a TMDB episode the addon never lists) makes the counts
    // UNEQUAL and is left strictly alone, so this can never manufacture a partner
    // for a genuinely-absent episode. Confidence is scored on the TITLE axis, so a
    // genuinely-different interior filler reads low and the arc gate can still drop
    // its arc; a real but near-exact title reads high. Anchors = DP + both residual
    // passes, so a residual-recovered pair also brackets a fill.
    if left_unmatched.len() <= RESIDUAL_MAX && right_unmatched.len() <= RESIDUAL_MAX {
        matched.sort_unstable();
        for w in matched.windows(2) {
            let (lp, rp) = w[0];
            let (ln, rn) = w[1];
            let l_gap: Vec<usize> = (lp + 1..ln).filter(|&li| left_open[li]).collect();
            if l_gap.is_empty() {
                continue;
            }
            let r_gap: Vec<usize> = (rp + 1..rn).filter(|&ri| right_open[ri]).collect();
            if l_gap.len() != r_gap.len() {
                continue; // a one-sided gap: leave it, never invent a partner
            }
            for (li, ri) in l_gap.into_iter().zip(r_gap) {
                left_open[li] = false;
                right_open[ri] = false;
                let dice = dice_from_counts(
                    &lefts[li].norm, &lefts[li].bigrams, lefts[li].bigram_total,
                    &rights[ri].norm, &rights[ri].bigrams, rights[ri].bigram_total,
                );
                let score = W_TITLE * dice;
                pairs.push(AlignPair {
                    left_key: lefts[li].key.clone(),
                    right_key: rights[ri].key.clone(),
                    score,
                    confidence: pair_confidence(score, W_TITLE),
                });
            }
        }
    }

    let left_only: Vec<String> = (0..n)
        .filter(|&li| left_open[li])
        .map(|li| lefts[li].key.clone())
        .collect();
    let right_only: Vec<String> = (0..m)
        .filter(|&ri| right_open[ri])
        .map(|ri| rights[ri].key.clone())
        .collect();

    Alignment {
        pairs,
        left_only,
        right_only,
    }
}

/// Everything unmatched: the degenerate result for empty or oversized inputs.
fn unaligned(left: &[AlignEpisode], right: &[AlignEpisode]) -> Alignment {
    Alignment {
        pairs: Vec::new(),
        left_only: left.iter().map(|e| e.key.clone()).collect(),
        right_only: right.iter().map(|e| e.key.clone()).collect(),
    }
}

/// The maximum score this pair COULD have reached, given which signals both
/// sides actually carry. A pair with no date on one side can only ever earn the
/// title weight, so that is its ceiling.
fn attainable(a: &Prepped, b: &Prepped) -> f64 {
    let mut max = 0.0;
    if a.day.is_some() && b.day.is_some() {
        max += W_DATE;
    }
    if !a.norm.is_empty() && !b.norm.is_empty() {
        max += W_TITLE;
    }
    max
}

/// Renormalise a raw score against the evidence that was available. Returns 0.0
/// when there was NO evidence on either axis: an episode with neither a date nor
/// a title tells us nothing, and "no evidence" must not read as "high
/// confidence".
fn pair_confidence(score: f64, attainable: f64) -> f64 {
    if attainable <= 0.0 {
        0.0
    } else {
        score / attainable
    }
}

fn pair_score(a: &Prepped, b: &Prepped) -> f64 {
    // Strong-exact-far override: an EXACT normalized-title match whose dates are FAR apart is the
    // AIOMetadata date-shift case (see STRONG_EXACT_FAR_SCORE). Trust the title and pin it in place
    // with a score above a date-perfect mismatch, so the DP cannot slide the block onto the diagonal
    // its wrong dates happen to line up with. Gated on EXACT equality so formulaic "Part 1"/"Part 2"
    // titles (0.95 dice, distinct) are never crossed; they fall through to the normal score, are
    // gapped by the far-date floor, and recovered order-independently by the strong-title residual.
    if !a.norm.is_empty()
        && a.norm == b.norm
        && matches!((a.day, b.day), (Some(x), Some(y)) if (x - y).abs() > FAR_DELTA)
    {
        return STRONG_EXACT_FAR_SCORE;
    }
    let date = date_proximity(a.day, b.day);
    let title = dice_from_counts(
        &a.norm,
        &a.bigrams,
        a.bigram_total,
        &b.norm,
        &b.bigrams,
        b.bigram_total,
    );
    W_DATE * date + W_TITLE * title
}

/// Bucketed closeness of two air dates. A missing date on either side contributes 0.0: neutral,
/// never a penalty, because plenty of legitimate matches have no date on one side.
fn date_proximity(a: Option<i64>, b: Option<i64>) -> f64 {
    let (a, b) = match (a, b) {
        (Some(a), Some(b)) => (a, b),
        _ => return 0.0,
    };
    let delta = (a - b).abs();
    if delta <= 1 {
        1.0
    } else if delta <= 3 {
        0.9
    } else if delta <= 7 {
        0.75
    } else if delta <= 14 {
        0.4
    } else if delta <= 35 {
        0.1
        // A month-plus apart is almost never the same episode, and this must lose
        // to a gap no matter what the title does, so the monotone DP always GAPS a
        // far-date pair rather than forcing it. It has to lose even to gapping
        // BOTH sides (2 * GAP = -0.70): a far-date pair with a PERFECT title
        // (W_TITLE = 0.45) must still land below that, or the DP would quietly
        // match a wrong-dated-but-identical-title episode in place and the
        // strong-title residual (which only recovers GAPPED episodes) could never
        // reach it. W_DATE * -2.5 = -1.375, so even +0.45 for a perfect title
        // lands at -0.925, under -0.70. A genuinely mis-dated real match is then
        // left for the residual (recovered by exact title if unique) or dropped
        // from its arc: absent beats wrong. The ONE exception is an EXACTLY-equal
        // title, which pair_score's strong-exact-far override pins in place BEFORE
        // reaching this floor (a whole SHIFTED exact-title block otherwise produces
        // disjoint unmatched pools the residual cannot bridge; see that override).
    } else {
        -2.5
    }
}

/// Parse an ISO-ish date ("2013-04-07", or an RFC3339 timestamp whose first 10
/// chars are the date) into days-since-epoch. Returns None on anything else.
///
/// Deliberately does NOT pull in a date crate: this is Howard Hinnant's days-from-civil.
/// Note the validation is shallow by design (month 1..=12, day 1..=31), so an impossible date
/// such as "2013-02-31" parses and rolls forward rather than erroring. Air dates come from
/// metadata providers, not from user input.
pub fn parse_day(s: &str) -> Option<i64> {
    let t = s.trim();
    let b = t.as_bytes();
    if b.len() < 10 {
        return None;
    }
    // Anything longer must be an RFC3339-ish timestamp: date, separator, time.
    if b.len() > 10 && !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = parse_uint(&b[0..4])?;
    let month = parse_uint(&b[5..7])?;
    let day = parse_uint(&b[8..10])?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// Strict ASCII-digit parse. Rejects signs, spaces and anything else.
fn parse_uint(bytes: &[u8]) -> Option<i64> {
    if bytes.is_empty() {
        return None;
    }
    let mut n: i64 = 0;
    for &c in bytes {
        if !c.is_ascii_digit() {
            return None;
        }
        n = n * 10 + i64::from(c - b'0');
    }
    Some(n)
}

/// Howard Hinnant's days_from_civil: proleptic Gregorian calendar, day 0 == 1970-01-01.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    // March-based year: January and February belong to the previous year.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // [0, 11], March == 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Normalise a title for comparison: lowercase, keep only `[a-z0-9 ]`, collapse runs of
/// whitespace, trim. Punctuation is dropped in place (no space inserted), so "Minato's" becomes
/// "minatos". Non-ASCII letters are dropped entirely.
///
/// No attempt is made to strip TVDB's "Arc Name - " title prefixes: the aligner tolerates them,
/// because the date term carries a pair whose title similarity the prefix has diluted.
pub fn normalize_title(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.chars() {
        for c in ch.to_lowercase() {
            if c.is_whitespace() {
                // Never leads; only emitted when a kept char follows, so the result is trimmed
                // and internally single-spaced for free.
                if !out.is_empty() {
                    pending_space = true;
                }
            } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(c);
            }
        }
    }
    out
}

/// Sorensen-Dice coefficient over character bigrams of two ALREADY NORMALISED strings
/// (see [`normalize_title`]).
///
/// Returns 0.0 when either side has fewer than 2 chars, unless both are identical and non-empty,
/// in which case 1.0.
pub fn dice_bigram(a: &str, b: &str) -> f64 {
    let (ba, ta) = bigram_profile(a);
    let (bb, tb) = bigram_profile(b);
    dice_from_counts(a, &ba, ta, b, &bb, tb)
}

/// Bigram multiset plus the total bigram count (0 for strings shorter than 2 chars).
fn bigram_profile(s: &str) -> (BigramMap, u32) {
    let chars: Vec<char> = s.chars().collect();
    let mut map: BigramMap = HashMap::new();
    if chars.len() < 2 {
        return (map, 0);
    }
    for w in chars.windows(2) {
        *map.entry((w[0], w[1])).or_insert(0) += 1;
    }
    let total = chars.len() as u32 - 1;
    (map, total)
}

fn dice_from_counts(
    a_norm: &str,
    a: &BigramMap,
    a_total: u32,
    b_norm: &str,
    b: &BigramMap,
    b_total: u32,
) -> f64 {
    if a_total == 0 || b_total == 0 {
        // Too short to have bigrams. Only an exact, non-empty match counts.
        return if !a_norm.is_empty() && a_norm == b_norm {
            1.0
        } else {
            0.0
        };
    }
    // Iterate the smaller map; multiset intersection takes the min of the two counts.
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let mut shared: u32 = 0;
    for (bigram, count) in small {
        if let Some(other) = large.get(bigram) {
            shared += (*count).min(*other);
        }
    }
    2.0 * f64::from(shared) / f64::from(a_total + b_total)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unrelated words, so that titles built from them share few bigrams with their neighbours.
    // A shifted (mis-aligned) title pair therefore scores near zero, which is what lets these
    // tests distinguish a correct alignment from an off-by-one one.
    const WORDS: [&str; 40] = [
        "zebra", "quartz", "fjord", "glyph", "vex", "wharf", "junk", "sphinx", "blitz", "crux",
        "dwarf", "emblem", "frost", "gizmo", "hazel", "ivory", "jolt", "kiosk", "lumen", "mango",
        "nomad", "onyx", "pixel", "quiver", "rogue", "syrup", "tundra", "umbra", "vault", "wisp",
        "xenon", "yacht", "zenith", "amber", "bronze", "cobalt", "dusk", "ember", "flint", "gale",
    ];

    /// Deterministic, mutually dissimilar episode title for index i.
    fn title_of(i: usize) -> String {
        format!("{} {}", WORDS[i % 40], WORDS[(i * 7 + 3) % 40])
    }

    fn ep(key: &str, title: &str, day: Option<i64>) -> AlignEpisode {
        AlignEpisode {
            key: key.to_string(),
            title: title.to_string(),
            day,
        }
    }

    /// A weekly-broadcast run of `n` episodes starting on 2013-04-07, keys "<prefix>{i}".
    fn weekly_run(prefix: &str, n: usize) -> Vec<AlignEpisode> {
        let base = parse_day("2013-04-07").unwrap();
        (0..n)
            .map(|i| {
                ep(
                    &format!("{prefix}{i}"),
                    &title_of(i),
                    Some(base + 7 * i as i64),
                )
            })
            .collect()
    }

    /// Sort a list into broadcast (air-date) order, mirroring what arcs.rs does
    /// before it calls `align`. Undated episodes sort last.
    fn by_date(mut v: Vec<AlignEpisode>) -> Vec<AlignEpisode> {
        v.sort_by_key(|e| (e.day.unwrap_or(i64::MAX), e.key.clone()));
        v
    }

    // ---------------------------------------------------------------- parse_day

    #[test]
    fn parse_day_known_values() {
        assert_eq!(parse_day("1970-01-01"), Some(0));
        assert_eq!(parse_day("2013-04-07"), Some(15802));
        assert_eq!(parse_day("1969-12-31"), Some(-1));
        assert_eq!(parse_day("1999-12-31"), Some(10956));
        assert_eq!(parse_day("2000-02-29"), Some(11016));
        assert_eq!(parse_day("2024-01-01"), Some(19723));
    }

    #[test]
    fn parse_day_leap_year_arithmetic() {
        // 2013 is not a leap year: Feb 28 is followed by Mar 1.
        assert_eq!(
            parse_day("2013-02-28").unwrap() + 1,
            parse_day("2013-03-01").unwrap()
        );
        // 2016 is: Feb 28, Feb 29, Mar 1.
        assert_eq!(
            parse_day("2016-02-28").unwrap() + 1,
            parse_day("2016-02-29").unwrap()
        );
        assert_eq!(
            parse_day("2016-02-29").unwrap() + 1,
            parse_day("2016-03-01").unwrap()
        );
        assert_eq!(parse_day("2016-02-29"), Some(16860));
    }

    #[test]
    fn parse_day_rfc3339_prefix() {
        assert_eq!(parse_day("2013-04-07T00:00:00Z"), Some(15802));
        assert_eq!(parse_day("2013-04-07T09:30:00.123+09:00"), Some(15802));
        assert_eq!(parse_day("2013-04-07t09:30:00Z"), Some(15802));
        assert_eq!(parse_day("2013-04-07 09:30:00"), Some(15802));
        assert_eq!(parse_day("  2013-04-07  "), Some(15802));
    }

    #[test]
    fn parse_day_rejects_garbage() {
        assert_eq!(parse_day(""), None);
        assert_eq!(parse_day("garbage"), None);
        assert_eq!(parse_day("not a date at all"), None);
        assert_eq!(parse_day("2013-4-7"), None); // too short, and unpadded
        assert_eq!(parse_day("20130407"), None);
        assert_eq!(parse_day("2013/04/07"), None);
        assert_eq!(parse_day("2013-04-07extra"), None); // no RFC3339 separator
        assert_eq!(parse_day("abcd-ef-gh"), None);
        assert_eq!(parse_day("2013-13-01"), None); // month 13
        assert_eq!(parse_day("2013-00-01"), None); // month 0
        assert_eq!(parse_day("2013-04-00"), None); // day 0
        assert_eq!(parse_day("2013-04-32"), None); // day 32
        assert_eq!(parse_day("-013-04-07"), None); // non-digit in the year
    }

    // -------------------------------------------------------------- dice_bigram

    #[test]
    fn dice_identical_and_disjoint() {
        assert_eq!(dice_bigram("one piece", "one piece"), 1.0);
        assert_eq!(dice_bigram("abcd", "wxyz"), 0.0);
    }

    #[test]
    fn dice_night_nacht() {
        // ni ig gh ht  vs  na ac ch ht  ->  1 shared of 4 + 4  ->  2 * 1 / 8 = 0.25
        assert!((dice_bigram("night", "nacht") - 0.25).abs() < 1e-12);
    }

    #[test]
    fn dice_short_strings() {
        assert_eq!(dice_bigram("a", "a"), 1.0); // identical, non-empty, under 2 chars
        assert_eq!(dice_bigram("a", "b"), 0.0);
        assert_eq!(dice_bigram("", ""), 0.0); // identical but empty
        assert_eq!(dice_bigram("ab", ""), 0.0);
        assert_eq!(dice_bigram("ab", "a"), 0.0); // one side under 2 chars
    }

    #[test]
    fn dice_partial_overlap_is_between_zero_and_one() {
        let d = dice_bigram("the warlord trafalgar law", "shichibukai trafalgar law");
        assert!(d > 0.0 && d < 1.0, "expected partial overlap, got {d}");
    }

    #[test]
    fn dice_is_symmetric() {
        let a = normalize_title("Minato's Death");
        let b = normalize_title("Kakashi: Shadow of the ANBU Black Ops - Minato's Death");
        assert!((dice_bigram(&a, &b) - dice_bigram(&b, &a)).abs() < 1e-12);
    }

    // ---------------------------------------------------------- normalize_title

    #[test]
    fn normalize_strips_case_and_punctuation() {
        assert_eq!(
            normalize_title("The Warlord! Trafalgar Law"),
            "the warlord trafalgar law"
        );
        assert_eq!(normalize_title("Episode 42"), "episode 42");
        assert_eq!(normalize_title("!!!"), "");
        assert_eq!(normalize_title(""), "");
    }

    #[test]
    fn normalize_collapses_whitespace_and_trims() {
        assert_eq!(
            normalize_title("  Kakashi: Shadow of the ANBU  Black Ops - Minato's Death \n"),
            "kakashi shadow of the anbu black ops minatos death"
        );
        assert_eq!(normalize_title("\t a \t b \n"), "a b");
    }

    #[test]
    fn normalize_drops_non_ascii() {
        // Non-ASCII letters are dropped rather than transliterated: both sides of a comparison
        // get the same treatment, so the surviving ASCII still carries the similarity.
        assert_eq!(normalize_title("Ōkami"), "kami");
    }

    // ---------------------------------------------------------------- alignment

    /// THE test. TMDB promotes a crossover special into the main run; Aura's list does not have
    /// it. The insertion must be absorbed as ONE gap, and every episode after it must still map
    /// to its own counterpart, NOT to the neighbour one slot over. A naive index join gets every
    /// single episode after index 20 wrong, silently.
    #[test]
    fn one_piece_regression_insertion_is_absorbed_not_propagated() {
        const N: usize = 30;
        const INSERT_AT: usize = 20;

        let right = weekly_run("R", N); // Aura / Cinemeta: the clean main run
        let base = parse_day("2013-04-07").unwrap();

        // TMDB: the same run, plus a crossover special promoted into it at index 20. It aired a
        // few days after the previous episode, which is exactly what makes a date-only join
        // ambiguous.
        let mut left: Vec<AlignEpisode> = (0..N)
            .map(|i| {
                ep(
                    &format!("L{i}"),
                    &title_of(i),
                    Some(base + 7 * i as i64),
                )
            })
            .collect();
        left.insert(
            INSERT_AT,
            ep(
                "L-INS",
                "Toriko One Piece Dragon Ball Z Crossover Special",
                Some(base + 7 * (INSERT_AT as i64 - 1) + 3),
            ),
        );
        assert_eq!(left.len(), N + 1);

        let a = align(&left, &right);

        // Exactly one TMDB episode is unmatched, and it is the inserted one.
        assert_eq!(a.left_only, vec!["L-INS".to_string()]);
        assert!(a.right_only.is_empty(), "right_only: {:?}", a.right_only);
        assert_eq!(a.pairs.len(), N);

        // No +1 shift anywhere: L{i} maps to R{i} for EVERY i, on both sides of the insertion.
        for i in 0..N {
            assert_eq!(
                a.map(&format!("L{i}")),
                Some(format!("R{i}").as_str()),
                "episode {i} mis-mapped (the off-by-one is back)"
            );
        }
        assert!(a.score_of("L-INS").is_none());
        assert!(
            (a.min_score() - 1.0).abs() < 1e-9,
            "every real pair is an exact date+title match, min_score = {}",
            a.min_score()
        );
    }

    /// Same shape, but the extra episode is at the very start of the TMDB list, which is where a
    /// band-edge bug would show up.
    #[test]
    fn insertion_at_the_head_is_absorbed() {
        const N: usize = 12;
        let right = weekly_run("R", N);
        let base = parse_day("2013-04-07").unwrap();

        let mut left = weekly_run("L", N);
        left.insert(0, ep("L-INS", "Recap Special", Some(base - 3)));

        let a = align(&left, &right);
        assert_eq!(a.left_only, vec!["L-INS".to_string()]);
        assert!(a.right_only.is_empty());
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }

    /// The mirror case: Aura has an episode TMDB does not (a recap TMDB filed as a special).
    #[test]
    fn extra_aura_episode_lands_in_right_only() {
        const N: usize = 16;
        let left = weekly_run("L", N);
        let base = parse_day("2013-04-07").unwrap();

        let mut right = weekly_run("R", N);
        right.insert(9, ep("R-EXTRA", "Recap of the Voyage So Far", Some(base + 7 * 8 + 2)));

        let a = align(&left, &right);
        assert_eq!(a.right_only, vec!["R-EXTRA".to_string()]);
        assert!(a.left_only.is_empty());
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }

    /// Duplicate air dates (two episodes broadcast the same day, as Naruto Shippuden does 40
    /// times) with the TITLES SWAPPED in similarity: title alone would cross the pair over.
    /// Monotonicity forbids the crossing, so order wins.
    #[test]
    fn duplicate_air_dates_preserve_order() {
        let base = parse_day("2013-04-07").unwrap();
        let days = [0i64, 7, 14, 21, 21, 28]; // 3 and 4 share an air date

        let left: Vec<AlignEpisode> = (0..6)
            .map(|i| {
                let t = match i {
                    3 => "alpha".to_string(),
                    4 => "bravo".to_string(),
                    _ => title_of(i),
                };
                ep(&format!("L{i}"), &t, Some(base + days[i]))
            })
            .collect();

        let right: Vec<AlignEpisode> = (0..6)
            .map(|i| {
                // Swapped relative to the left side: L3's title matches R4 exactly, and vice versa.
                let t = match i {
                    3 => "bravo".to_string(),
                    4 => "alpha".to_string(),
                    _ => title_of(i),
                };
                ep(&format!("R{i}"), &t, Some(base + days[i]))
            })
            .collect();

        let a = align(&left, &right);

        assert_eq!(a.pairs.len(), 6);
        assert!(a.left_only.is_empty());
        assert!(a.right_only.is_empty());
        for i in 0..6 {
            assert_eq!(
                a.map(&format!("L{i}")),
                Some(format!("R{i}").as_str()),
                "pair {i} crossed over: order was not preserved"
            );
        }
    }

    /// Divergent translations: same broadcast dates, titles with essentially no bigram overlap
    /// ("Shichibukai! Trafalgar Law" vs "The Warlord! Trafalgar Law" taken to its extreme).
    /// The date term alone has to carry the alignment.
    #[test]
    fn divergent_translations_are_carried_by_the_date_term() {
        const N: usize = 14;
        let base = parse_day("2013-04-07").unwrap();

        let left: Vec<AlignEpisode> = (0..N)
            .map(|i| {
                ep(
                    &format!("L{i}"),
                    &title_of(i),
                    Some(base + 7 * i as i64),
                )
            })
            .collect();
        // Completely different words on the Aura side.
        let right: Vec<AlignEpisode> = (0..N)
            .map(|i| {
                ep(
                    &format!("R{i}"),
                    &title_of(i + 20),
                    Some(base + 7 * i as i64),
                )
            })
            .collect();

        // Sanity: the titles really are dissimilar, so nothing but the date can be doing the work.
        for i in 0..N {
            let d = dice_bigram(&normalize_title(&title_of(i)), &normalize_title(&title_of(i + 20)));
            assert!(d < 0.25, "titles too similar at {i}: dice = {d}");
        }

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), N);
        assert!(a.left_only.is_empty());
        assert!(a.right_only.is_empty());
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }

    /// The converse: identical titles, but the two providers disagree about the air dates by
    /// 7 to 28 days (a common provider skew). The title term has to carry it.
    #[test]
    fn date_disagreement_is_carried_by_the_title_term() {
        const N: usize = 15;
        let base = parse_day("2013-04-07").unwrap();
        let jitter = [10i64, -10, 17, -17, 21];

        let left: Vec<AlignEpisode> = (0..N)
            .map(|i| {
                ep(
                    &format!("L{i}"),
                    &title_of(i),
                    Some(base + 7 * i as i64 + jitter[i % jitter.len()]),
                )
            })
            .collect();
        let right: Vec<AlignEpisode> = (0..N)
            .map(|i| {
                ep(
                    &format!("R{i}"),
                    &title_of(i),
                    Some(base + 7 * i as i64),
                )
            })
            .collect();

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), N);
        assert!(a.left_only.is_empty());
        assert!(a.right_only.is_empty());
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }

    /// A dateless side must not poison the alignment: the date term goes neutral (0.0) rather
    /// than negative, and the titles finish the job.
    #[test]
    fn missing_dates_fall_back_to_titles() {
        const N: usize = 10;
        let left: Vec<AlignEpisode> = (0..N)
            .map(|i| ep(&format!("L{i}"), &title_of(i), None))
            .collect();
        let right = weekly_run("R", N);

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), N);
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
        // Title-only RAW score: W_TITLE * 1.0, with the date term contributing nothing.
        assert!((a.min_score() - W_TITLE).abs() < 1e-9, "{}", a.min_score());

        // ...but the CONFIDENCE is 1.0, because the title was the only evidence
        // available and it matched perfectly. This is the distinction that
        // matters in production: `arcs.rs` gates arcs on confidence >= 0.5, and
        // gating the raw score instead would reject this perfectly-aligned arc
        // outright (0.45 < 0.5) purely for having no air dates. An ongoing show
        // whose newest episodes lack a date on one side hits this constantly.
        assert!(
            (a.min_confidence() - 1.0).abs() < 1e-9,
            "dateless-but-title-perfect must survive the production gate, got {}",
            a.min_confidence(),
        );
        assert!(a.min_confidence() >= 0.5, "must clear arcs.rs MIN_PAIR_CONFIDENCE");
    }

    #[test]
    fn confidence_still_punishes_disagreement_it_only_forgives_absence() {
        // A pair whose date is CLOSE-ISH (in monotone range) but whose title
        // disagrees is kept, and its confidence must stay low so the arc gate can
        // drop its arc. (Guards against "fixing" the dateless case by making
        // confidence trivially 1.0.) Dates 20 days apart -> still matched
        // positionally; disjoint titles -> low confidence.
        let base = parse_day("2013-04-07").unwrap();
        let left = vec![ep("L0", "totally different words here", Some(base))];
        let right = vec![ep("R0", "nothing alike whatsoever", Some(base + 20))];
        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), 1);
        assert!(
            a.min_confidence() < 0.5,
            "a close-date but title-disagreeing pair must not clear the gate, got {}",
            a.min_confidence(),
        );

        // But a pair whose signals BOTH disagree hard (a month-plus apart AND no
        // shared title) is not the same episode: the monotone gaps it rather than
        // forcing a bad pair, and the near-exact-date residual leaves it alone.
        let left = vec![ep("L0", "totally different words here", Some(base))];
        let right = vec![ep("R0", "nothing alike whatsoever", Some(base + 400))];
        let a = align(&left, &right);
        assert!(a.pairs.is_empty(), "a hard-disagreeing pair must not be forced");
        assert_eq!(a.left_only, vec!["L0".to_string()]);
        assert_eq!(a.right_only, vec!["R0".to_string()]);
    }

    #[test]
    fn naruto_filler_run_stays_above_the_arc_gate() {
        // The reported regression: original Naruto's arc grouping collapsed to a
        // single surviving arc. Filler episodes are the stress case: TMDB and
        // Cinemeta often disagree on the exact air date by a few days AND give
        // the episode different English titles. This builds such a run (dates
        // offset by 5 days, deliberately dissimilar titles) and asserts every
        // pair still clears the 0.5 confidence gate that arcs.rs uses, so an arc
        // made of these episodes is KEPT rather than dropped.
        const N: usize = 20;
        let base = parse_day("2005-01-04").unwrap();
        let left: Vec<AlignEpisode> = (0..N)
            .map(|i| ep(&format!("L{i}"), &format!("{} mission", WORDS[i % 40]), Some(base + 7 * i as i64)))
            .collect();
        // Aura side: 5 days late, and a different title wording for the same ep.
        let right: Vec<AlignEpisode> = (0..N)
            .map(|i| ep(&format!("R{i}"), &format!("the {} quest", WORDS[i % 40]), Some(base + 7 * i as i64 + 5)))
            .collect();

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), N, "every episode must map");
        for i in 0..N {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()), "ep {i} maps 1:1");
        }
        assert!(
            a.min_confidence() >= 0.5,
            "a filler run (date off 5d, divergent titles) must clear the arc gate, got {}",
            a.min_confidence(),
        );
    }

    #[test]
    fn reordered_tail_block_is_recovered_by_the_residual_pass() {
        // The Naruto tail case: the first stretch aligns 1:1, then a block that
        // both sources contain but SHUFFLE far apart (identical air dates, but
        // scattered positions so the monotone DP gaps the whole block on both
        // sides). The residual pass must recover it by same-date matching. Dates
        // in the tail are spaced a YEAR apart so the shuffle is unambiguous (no
        // two are within the near-exact-date gate), which is the safe case the
        // residual is limited to.
        const HEAD: usize = 15;
        let base = parse_day("2006-09-13").unwrap();
        let tail_days: [i64; 6] = [
            parse_day("2010-01-01").unwrap(),
            parse_day("2011-01-01").unwrap(),
            parse_day("2012-01-01").unwrap(),
            parse_day("2013-01-01").unwrap(),
            parse_day("2014-01-01").unwrap(),
            parse_day("2015-01-01").unwrap(),
        ];
        let mut left: Vec<AlignEpisode> = Vec::new();
        let mut right: Vec<AlignEpisode> = Vec::new();
        for i in 0..HEAD {
            let day = Some(base + 7 * i as i64);
            left.push(ep(&format!("L{i}"), &title_of(i), day));
            right.push(ep(&format!("R{i}"), &title_of(i), day));
        }
        // Left tail in order, right tail shuffled (indices 3,0,5,1,4,2).
        for i in 0..6 {
            left.push(ep(&format!("LT{i}"), &format!("tail {}", WORDS[i % 40]), Some(tail_days[i])));
        }
        for &i in &[3usize, 0, 5, 1, 4, 2] {
            right.push(ep(&format!("RT{i}"), &format!("tail {}", WORDS[i % 40]), Some(tail_days[i])));
        }

        let a = align(&left, &right);
        assert!(a.left_only.is_empty(), "residual must map every tail ep, left_only={:?}", a.left_only);
        assert!(a.right_only.is_empty(), "right_only={:?}", a.right_only);
        for i in 0..6 {
            assert_eq!(a.map(&format!("LT{i}")), Some(format!("RT{i}").as_str()), "tail ep {i}");
        }
    }

    #[test]
    fn residual_will_not_pair_beyond_the_near_exact_date_gate() {
        // The residual only recovers a SAME-date shuffle. A gapped left and gapped
        // right that are 7 days apart (a weekly reorder, ambiguous by nature) must
        // be refused: a one-week residual match is the off-by-one this module
        // exists to prevent. Build an aligned head, then a scattered tail (years
        // apart, so the monotone gaps it) in which exactly one cross-side pair is
        // 7 days off; that pair must stay unmatched while the same-date ones
        // recover.
        let base = parse_day("2006-09-13").unwrap();
        let mut left: Vec<AlignEpisode> = Vec::new();
        let mut right: Vec<AlignEpisode> = Vec::new();
        for i in 0..12 {
            let day = Some(base + 7 * i as i64);
            left.push(ep(&format!("L{i}"), &title_of(i), day));
            right.push(ep(&format!("R{i}"), &title_of(i), day));
        }
        // Tail, years apart so the monotone gaps the whole block:
        let d_a = parse_day("2011-01-01").unwrap();
        let d_b = parse_day("2013-01-01").unwrap();
        // Left tail in order; right tail REVERSED so the monotone gaps the whole
        // block (positional partners are years apart) and hands it to the
        // residual. Right's B is 7 days off from left's B.
        left.push(ep("LA", "orphan alpha", Some(d_a)));
        left.push(ep("LB", "orphan bravo", Some(d_b)));
        right.push(ep("RB", "orphan bravo", Some(d_b + 7)));
        right.push(ep("RA", "orphan alpha", Some(d_a)));

        let a = align(&left, &right);
        // The exact-date pair recovers.
        assert_eq!(a.map("LA"), Some("RA"), "same-date tail ep must recover");
        // The 7-day pair must NOT: both stay unmatched.
        assert!(a.map("LB").is_none(), "a 7-day residual pair is forbidden");
        assert!(a.left_only.contains(&"LB".to_string()));
        assert!(a.right_only.contains(&"RB".to_string()));
    }

    #[test]
    fn residual_pass_leaves_a_one_sided_gap_alone() {
        // The One Piece crossover: one TMDB-only episode, nothing unmatched on the
        // Aura side. The residual pass has no counterpart to pair it with, so it
        // must stay a single left_only gap (never mis-paired).
        let mut left = weekly_run("L", 20);
        left.insert(10, ep("CROSS", "one off crossover special", Some(parse_day("2013-06-01").unwrap())));
        let right = weekly_run("R", 20);
        let a = align(&left, &right);
        assert_eq!(a.left_only, vec!["CROSS".to_string()]);
        assert!(a.right_only.is_empty());
    }

    #[test]
    fn strong_title_recovers_a_wrong_dated_but_identical_title_block() {
        // The Naruto case: an addon has the right titles but WRONG dates for a
        // block (Jiraiya Returns dated 4 months early). The block gaps on both
        // sides (dates far off), and strong-title recovery must pair it by exact
        // title. Distinctive titles, dates 126 days (18 weeks) apart.
        const HEAD: usize = 12;
        let base = parse_day("2003-01-01").unwrap();
        let mut left: Vec<AlignEpisode> = Vec::new();
        let mut right: Vec<AlignEpisode> = Vec::new();
        for i in 0..HEAD {
            let day = Some(base + 7 * i as i64);
            left.push(ep(&format!("L{i}"), &title_of(i), day));
            right.push(ep(&format!("R{i}"), &title_of(i), day));
        }
        // A block with distinctive, identical titles. Left dates are correct;
        // right (addon) dates are 126 days early, so the monotone gaps them.
        let block: [&str; 4] = [
            "long time no see jiraiya returns",
            "the summoning jutsu wisdom of the toad sage",
            "a feeling of yearning a flower full of hope",
            "hospital besieged the evil hand revealed",
        ];
        for (k, title) in block.iter().enumerate() {
            let real = base + 7 * (HEAD + k) as i64;
            left.push(ep(&format!("LB{k}"), title, Some(real)));
            right.push(ep(&format!("RB{k}"), title, Some(real - 126)));
        }

        let a = align(&left, &right);
        for k in 0..4 {
            assert_eq!(
                a.map(&format!("LB{k}")),
                Some(format!("RB{k}").as_str()),
                "block ep {k} must recover by exact title",
            );
        }
        // Recovered pairs are title-confident (1.0), so an arc built from them
        // clears the confidence gate.
        for k in 0..4 {
            assert!(
                a.confidence_of(&format!("LB{k}")).unwrap() >= 0.5,
                "recovered pair must be confident",
            );
        }
    }

    #[test]
    fn strong_title_will_not_cross_formulaic_part_titles() {
        // "The Chunin Exam, Part 1..4", wrong-dated and reversed so both sides gap
        // them. Exact-title equality (not dice) keeps Part N distinct, so none
        // cross-pair.
        let base = parse_day("2003-01-01").unwrap();
        let mut left = weekly_run("L", 10);
        let mut right = weekly_run("R", 10);
        let parts = ["the chunin exam part 1", "the chunin exam part 2", "the chunin exam part 3", "the chunin exam part 4"];
        for (k, t) in parts.iter().enumerate() {
            left.push(ep(&format!("LP{k}"), t, Some(base + 7 * (20 + k) as i64)));
        }
        // right block reversed AND far-dated
        for k in (0..4).rev() {
            right.push(ep(&format!("RP{k}"), parts[k], Some(base + 7 * (20 + k) as i64 - 200)));
        }
        let a = align(&left, &right);
        // Each Part N pairs only with its exact-title counterpart, never a neighbour.
        for k in 0..4 {
            if let Some(m) = a.map(&format!("LP{k}")) {
                assert_eq!(m, format!("RP{k}"), "Part {k} must not cross to another Part");
            }
        }
    }

    #[test]
    fn duplicated_title_pairs_only_in_monotonic_order() {
        // Two episodes both titled "assault", wrong-dated (300 days off). The
        // strong-exact-far override pins exact titles, so these DO pair now -- but
        // the DP's MONOTONICITY is what disambiguates a duplicated title: LA0
        // (before LA1) can only pair at or before LA1's partner, so the result is
        // LA0->RA0, LA1->RA1, in order, and it can NEVER cross. (An earlier build
        // gapped duplicated titles outright via a residual uniqueness guard;
        // pairing them in order is strictly better -- it keeps them in their arc --
        // and just as safe, because a monotone path cannot cross.)
        let base = parse_day("2003-01-01").unwrap();
        let mut left = weekly_run("L", 8);
        let mut right = weekly_run("R", 8);
        left.push(ep("LA0", "assault", Some(base + 7 * 20)));
        left.push(ep("LA1", "assault", Some(base + 7 * 21)));
        right.push(ep("RA0", "assault", Some(base + 7 * 20 - 300)));
        right.push(ep("RA1", "assault", Some(base + 7 * 21 - 300)));
        let a = align(&left, &right);
        // Paired in order, never crossed.
        assert_eq!(a.map("LA0"), Some("RA0"), "duplicated titles pair in order (no cross)");
        assert_eq!(a.map("LA1"), Some("RA1"));
    }

    #[test]
    fn far_date_shift_with_identical_titles_holds_the_diagonal() {
        // The AIOMetadata date-shift reproduction. Every episode carries its EXACT
        // TMDB title but a date shifted 8 weeks EARLIER, so the wrong dates line up
        // perfectly with the diagonal 8 positions over (right[i].date ==
        // left[i-8].date). A plain date+title DP takes that date-perfect diagonal
        // (0.55/pair) over the correct-but-far-dated one (-0.925/pair) and slides
        // the whole show over, stranding two disjoint tails. strong-exact-far pins
        // each exact-title pair at 0.70, so the correct diagonal wins outright.
        const N: usize = 25;
        const SHIFT: i64 = 7 * 8; // 56 days: comfortably past FAR_DELTA
        let base = parse_day("2003-01-01").unwrap();
        let left: Vec<AlignEpisode> = (0..N)
            .map(|i| ep(&format!("L{i}"), &title_of(i), Some(base + 7 * i as i64)))
            .collect();
        let right: Vec<AlignEpisode> = (0..N)
            .map(|i| ep(&format!("R{i}"), &title_of(i), Some(base + 7 * i as i64 - SHIFT)))
            .collect();
        let a = align(&left, &right);
        for i in 0..N {
            assert_eq!(
                a.map(&format!("L{i}")),
                Some(format!("R{i}").as_str()),
                "ep {i}: exact title must hold the diagonal against a far-date shift",
            );
        }
        assert!(a.left_only.is_empty() && a.right_only.is_empty());
    }

    #[test]
    fn interior_bracket_fill_recovers_a_near_exact_gap() {
        // A far-date block with EXACT titles is pinned by strong-exact-far, but one
        // interior episode has a NEAR-exact title ("... extended") that is neither
        // exact (so the strong-title residual skips it) nor same-date (so the
        // near-date residual skips it). Bracketed by the two exact-title anchors
        // around it with a balanced 1:1 leftover count, interior-fill pairs it
        // positionally. Without that pass it would be left_only/right_only.
        const N: usize = 15;
        const GAP_AT: usize = 7;
        let base = parse_day("2003-01-01").unwrap();
        let mut left: Vec<AlignEpisode> = Vec::new();
        let mut right: Vec<AlignEpisode> = Vec::new();
        for i in 0..N {
            let real = base + 7 * i as i64;
            left.push(ep(&format!("L{i}"), &title_of(i), Some(real)));
            let title = if i == GAP_AT { format!("{} extended", title_of(i)) } else { title_of(i) };
            right.push(ep(&format!("R{i}"), &title, Some(real - 7 * 8))); // all far-dated
        }
        let a = align(&left, &right);
        assert_eq!(
            a.map(&format!("L{GAP_AT}")),
            Some(format!("R{GAP_AT}").as_str()),
            "near-exact interior episode must be recovered by bracket-fill",
        );
        assert!(a.left_only.is_empty() && a.right_only.is_empty(), "every episode mapped");
    }

    #[test]
    fn interior_fill_leaves_a_one_sided_gap_alone() {
        // The One Piece crossover guard for interior-fill: a TMDB-only episode
        // between two anchors makes the leftover counts UNEQUAL (1 left, 0 right),
        // so interior-fill must not manufacture a partner for it.
        let mut left = weekly_run("L", 20);
        // One extra TMDB episode the addon does not have, mid-run.
        left.insert(10, ep("CROSS", "one off crossover special", Some(parse_day("2013-06-01").unwrap())));
        let right = weekly_run("R", 20);
        let a = align(&left, &right);
        assert_eq!(a.left_only, vec!["CROSS".to_string()], "the one-sided gap stays a gap");
        assert!(a.right_only.is_empty());
    }

    #[test]
    fn confidence_is_zero_when_there_is_no_evidence_at_all() {
        // No date, no title. We know nothing; that must not read as certainty.
        let left = vec![ep("L0", "", None)];
        let right = vec![ep("R0", "", None)];
        let a = align(&left, &right);
        if !a.pairs.is_empty() {
            assert_eq!(a.pairs[0].confidence, 0.0);
            assert!(a.min_confidence() < 0.5);
        }
    }

    // ------------------------------------------------------------- edge cases

    #[test]
    fn empty_inputs() {
        let empty: Vec<AlignEpisode> = Vec::new();
        let run = weekly_run("R", 3);

        let a = align(&empty, &empty);
        assert!(a.pairs.is_empty() && a.left_only.is_empty() && a.right_only.is_empty());
        assert_eq!(a.min_score(), 1.0); // no pairs
        assert!(a.map("nope").is_none());

        let a = align(&empty, &run);
        assert!(a.pairs.is_empty());
        assert!(a.left_only.is_empty());
        assert_eq!(a.right_only, vec!["R0", "R1", "R2"]);

        let a = align(&run, &empty);
        assert!(a.pairs.is_empty());
        assert_eq!(a.left_only, vec!["R0", "R1", "R2"]);
        assert!(a.right_only.is_empty());
    }

    #[test]
    fn single_element_inputs() {
        let base = parse_day("2013-04-07").unwrap();
        let left = vec![ep("L0", "Romance Dawn", Some(base))];
        let right = vec![ep("R0", "Romance Dawn", Some(base))];

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), 1);
        assert_eq!(a.map("L0"), Some("R0"));
        assert!((a.score_of("L0").unwrap() - 1.0).abs() < 1e-9);
        assert!(a.left_only.is_empty() && a.right_only.is_empty());

        // One on each side, nothing in common (a month-plus apart, disjoint
        // titles): NOT the same episode. Gapping both costs less than forcing the
        // match, so the aligner leaves them unmatched rather than reporting a
        // bogus pair.
        let left = vec![ep("L0", "zebra quartz", Some(base))];
        let right = vec![ep("R0", "wisp xenon", Some(base + 400))];
        let a = align(&left, &right);
        assert!(a.pairs.is_empty(), "a garbage pair must not be forced");
        assert_eq!(a.left_only, vec!["L0".to_string()]);
        assert_eq!(a.right_only, vec!["R0".to_string()]);
    }

    #[test]
    fn length_mismatch_wider_than_the_band_still_completes() {
        // 40 TMDB episodes vs 12 Aura episodes: |n - m| = 28, far outside the base band of 12.
        // The band has to widen or there would be no complete path at all.
        let left = weekly_run("L", 40);
        let right = weekly_run("R", 12);

        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), 12);
        assert_eq!(a.left_only.len(), 28);
        assert!(a.right_only.is_empty());
        for i in 0..12 {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }

    #[test]
    fn over_the_cap_returns_everything_unmatched() {
        let left: Vec<AlignEpisode> = (0..(MAX_EPISODES + 1))
            .map(|i| ep(&format!("L{i}"), "x", Some(i as i64)))
            .collect();
        let right: Vec<AlignEpisode> = (0..3)
            .map(|i| ep(&format!("R{i}"), "x", Some(i as i64)))
            .collect();

        let a = align(&left, &right);
        assert!(a.pairs.is_empty());
        assert_eq!(a.left_only.len(), MAX_EPISODES + 1);
        assert_eq!(a.right_only.len(), 3);

        let a = align(&right, &left);
        assert!(a.pairs.is_empty());
        assert_eq!(a.left_only.len(), 3);
        assert_eq!(a.right_only.len(), MAX_EPISODES + 1);
    }

    #[test]
    fn align_is_deterministic() {
        let left = weekly_run("L", 25);
        let right = weekly_run("R", 25);
        let first = align(&left, &right);
        for _ in 0..5 {
            let again = align(&left, &right);
            assert_eq!(first.pairs.len(), again.pairs.len());
            for (p, q) in first.pairs.iter().zip(again.pairs.iter()) {
                assert_eq!(p.left_key, q.left_key);
                assert_eq!(p.right_key, q.right_key);
                assert!((p.score - q.score).abs() < 1e-12);
            }
        }
    }

    /// A full-length run (One Piece scale) has to stay quick and bounded. The band keeps the DP
    /// at O(n * band), not O(n * m).
    #[test]
    fn long_run_with_a_mid_series_insertion() {
        const N: usize = 1168;
        const INSERT_AT: usize = 589; // where the Toriko crossover actually lands

        let right = weekly_run("R", N);
        let base = parse_day("2013-04-07").unwrap();

        let mut left = weekly_run("L", N);
        left.insert(
            INSERT_AT,
            ep(
                "L-INS",
                "Toriko One Piece Dragon Ball Z Crossover Special",
                Some(base + 7 * (INSERT_AT as i64 - 1) + 3),
            ),
        );

        let a = align(&left, &right);
        assert_eq!(a.left_only, vec!["L-INS".to_string()]);
        assert!(a.right_only.is_empty());
        assert_eq!(a.pairs.len(), N);
        // The episodes after the insertion are the ones a naive index join gets wrong.
        for i in [0usize, 588, 589, 590, 900, N - 1] {
            assert_eq!(a.map(&format!("L{i}")), Some(format!("R{i}").as_str()));
        }
    }
}
