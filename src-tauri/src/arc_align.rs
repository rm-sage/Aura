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
//!                                    <=14 -> 0.4, <=35 -> 0.1, else -0.5
//!                                    (either side dateless -> 0.0, neutral, never negative)
//!   gap penalty: -0.35 per unmatched episode, on either side
//!   band: only cells with |i - j| <= 12 are considered (O(n * band), forbids absurd reorderings)
//! ```
//!
//! Two soft terms, each of which is individually unreliable, plus a hard monotonic constraint.
//! Measured 100 percent correct on One Piece (1168/1168) and Naruto Shippuden (500/500).
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
/// Base half-width of the alignment band. Widened when the two lists differ in length by more
/// than this, so that a complete path from (0, 0) to (n, m) always exists.
const BAND: i64 = 12;
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
    /// The pair score, roughly -0.5 ..= 1.0.
    pub score: f64,
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
    /// Map a TMDB key to an Aura key. None when unmatched.
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

    /// Confidence of a specific pair, by TMDB key.
    pub fn score_of(&self, left_key: &str) -> Option<f64> {
        self.pairs
            .iter()
            .find(|p| p.left_key == left_key)
            .map(|p| p.score)
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

    // Traceback from (n, m). The band guarantees that cell is reachable.
    let mut pairs: Vec<AlignPair> = Vec::new();
    let mut left_only: Vec<String> = Vec::new();
    let mut right_only: Vec<String> = Vec::new();

    let mut i = n;
    let mut j = m;
    while i > 0 || j > 0 {
        match back[at(i, j)] {
            DIR_DIAG if i > 0 && j > 0 => {
                let a = &lefts[i - 1];
                let b = &rights[j - 1];
                pairs.push(AlignPair {
                    left_key: a.key.clone(),
                    right_key: b.key.clone(),
                    score: pair_score(a, b),
                });
                i -= 1;
                j -= 1;
            }
            DIR_UP if i > 0 => {
                left_only.push(lefts[i - 1].key.clone());
                i -= 1;
            }
            DIR_LEFT if j > 0 => {
                right_only.push(rights[j - 1].key.clone());
                j -= 1;
            }
            _ => {
                // Unreachable with a well formed band. Fail loudly in the result rather than
                // silently truncating: everything still unconsumed becomes unmatched.
                for e in lefts[..i].iter() {
                    left_only.push(e.key.clone());
                }
                for e in rights[..j].iter() {
                    right_only.push(e.key.clone());
                }
                break;
            }
        }
    }

    pairs.reverse();
    left_only.reverse();
    right_only.reverse();

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

fn pair_score(a: &Prepped, b: &Prepped) -> f64 {
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
    } else {
        -0.5
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
        // Title-only confidence: 0.45 * 1.0, with the date term contributing nothing.
        assert!((a.min_score() - W_TITLE).abs() < 1e-9, "{}", a.min_score());
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

        // One on each side, but nothing in common: still a match (a single gap pair costs more
        // than the worst possible match), and min_score is what tells the caller not to trust it.
        let left = vec![ep("L0", "zebra quartz", Some(base))];
        let right = vec![ep("R0", "wisp xenon", Some(base + 400))];
        let a = align(&left, &right);
        assert_eq!(a.pairs.len(), 1);
        assert!(
            a.min_score() < 0.0,
            "a garbage pair must report a bad score, got {}",
            a.min_score()
        );
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
