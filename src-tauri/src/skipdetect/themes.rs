// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/themes.rs
//
// Which AnimeThemes theme to try next for a kind, and when to stop (spec
// "Candidate lists" and "Fetch and stop policy", decision 12). Pure: the
// caller supplies theme metadata and the gate verdicts it has computed.
//
//   * ED list: every theme with ANY video `overlap == "Over"` (an insert song
//     over story) is removed BEFORE ordering. It can match at full coverage, so
//     no other gate stops it.
//   * OP list: "Over" themes stay, sort after every non-Over theme, and are
//     never auto-eligible (prompt-only at most).
//   * Order by episode-range distance from the MAL episode number (0 inside a
//     listed range, else the distance to the nearest range edge; no range sorts
//     last; ties keep API order). ORDER only, never a gate: ranges were wrong
//     for two picked themes in the corpus.
//   * A kind stops at the first theme in order that passes every gate, EXCEPT
//     a "Transition" version while a full version of the same slug is still
//     queued: that one is evaluated too and preferred if it passes.
//   * At most 8 theme downloads per kind per detect.

/// OP or ED.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Op,
    Ed,
}

/// The theme facts the policy needs (one entry per distinct audio file).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeMeta {
    /// AnimeThemes slug ("OP1", "ED2"); versions of one theme share it.
    pub slug: String,
    pub kind: Kind,
    /// The entry's `episodes` string ("1-12", "2-6, 8-12", "13", "1-").
    pub episodes: Option<String>,
    /// ANY video of the entry has `overlap == "Over"`.
    pub over: bool,
    /// The video's `overlap == "Transition"`.
    pub transition: bool,
}

/// Distance used for themes without a usable range (sorts last).
pub const NO_RANGE: u64 = 1_000_000;
/// Theme downloads allowed per kind per detect (cached fingerprints are free).
pub const MAX_DOWNLOADS_PER_KIND: usize = 8;

/// Distance of MAL episode `ep` from an AnimeThemes `episodes` spec
/// (`pre_gates.py ep_distance`): 0 inside any listed range, else the distance
/// to the nearest edge; `NO_RANGE` when nothing parses. "N-" is open-ended.
pub fn episode_distance(spec: Option<&str>, ep: u32) -> u64 {
    let Some(spec) = spec else { return NO_RANGE };
    let ep = ep as u64;
    let mut best = NO_RANGE;
    for part in spec.split(',') {
        let part = part.trim();
        let (lo, hi) = if let Some((a, b)) = part.split_once('-') {
            let Ok(lo) = a.trim().parse::<u64>() else { continue };
            let b = b.trim();
            let hi = if b.is_empty() {
                NO_RANGE
            } else {
                match b.parse::<u64>() {
                    Ok(h) => h,
                    Err(_) => continue,
                }
            };
            (lo, hi)
        } else if let Ok(n) = part.parse::<u64>() {
            (n, n)
        } else {
            continue;
        };
        let d = if lo <= ep && ep <= hi { 0 } else { ep.abs_diff(lo).min(ep.abs_diff(hi)) };
        best = best.min(d);
    }
    best
}

/// Candidate indices (into `themes`) for `kind`, best first. `ep` = the MAL
/// episode number when known (without it, API order is kept).
pub fn candidate_order(themes: &[ThemeMeta], kind: Kind, ep: Option<u32>) -> Vec<usize> {
    let mut idx: Vec<usize> = themes
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == kind && !(kind == Kind::Ed && t.over))
        .map(|(i, _)| i)
        .collect();
    idx.sort_by_key(|&i| {
        let t = &themes[i];
        let dist = ep.map_or(0, |e| episode_distance(t.episodes.as_deref(), e));
        (t.over, dist, i)
    });
    idx
}

/// Whether an accepted theme may auto-skip. An "Over" OP is prompt-only; an
/// "Over" ED never gets this far (it is not a candidate).
pub fn auto_eligible(t: &ThemeMeta) -> bool {
    !t.over
}

/// The next thing to do for a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// Fetch (or load from the fingerprint cache) and evaluate this theme
    /// against the COMPLETE region.
    Evaluate(usize),
    /// This theme's window is the answer.
    Accept(usize),
    /// Every candidate failed: an informative abstain (Layer 3 must not run).
    Exhausted,
    /// The download cap stopped the search; later plays resume via the cache.
    CapReached,
}

/// Decide the next step. `passed[i]` is the gate verdict for theme `i` once it
/// has been evaluated (None = not yet). `downloads` counts theme files fetched
/// for this kind in this detect (cache hits do not count).
pub fn next_step(themes: &[ThemeMeta], order: &[usize], passed: &[Option<bool>], downloads: usize) -> Step {
    let verdict = |i: usize| passed.get(i).copied().flatten();
    let evaluate = |i: usize| {
        if downloads >= MAX_DOWNLOADS_PER_KIND {
            Step::CapReached
        } else {
            Step::Evaluate(i)
        }
    };
    for (pos, &i) in order.iter().enumerate() {
        match verdict(i) {
            None => return evaluate(i),
            Some(false) => continue,
            Some(true) => {
                if !themes[i].transition {
                    return Step::Accept(i);
                }
                // A Transition version passed: a full version of the same slug
                // still queued after it is evaluated first and preferred.
                let full = order[pos + 1..].iter().copied().filter(|&j| {
                    themes[j].slug == themes[i].slug && themes[j].kind == themes[i].kind && !themes[j].transition
                });
                for j in full {
                    match verdict(j) {
                        Some(true) => return Step::Accept(j),
                        None if downloads < MAX_DOWNLOADS_PER_KIND => return Step::Evaluate(j),
                        _ => continue,
                    }
                }
                return Step::Accept(i);
            }
        }
    }
    Step::Exhausted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(slug: &str, kind: Kind, eps: Option<&str>, over: bool, transition: bool) -> ThemeMeta {
        ThemeMeta { slug: slug.into(), kind, episodes: eps.map(Into::into), over, transition }
    }

    #[test]
    fn distance() {
        assert_eq!(episode_distance(Some("1-12"), 5), 0);
        assert_eq!(episode_distance(Some("2-6, 8-12"), 7), 1);
        assert_eq!(episode_distance(Some("2-6, 8-12"), 13), 1);
        assert_eq!(episode_distance(Some("1-2"), 3), 1);
        assert_eq!(episode_distance(Some("13"), 13), 0);
        assert_eq!(episode_distance(Some("1-"), 400), 0);
        assert_eq!(episode_distance(Some("17-27"), 2), 15);
        assert_eq!(episode_distance(None, 2), NO_RANGE);
        assert_eq!(episode_distance(Some("TV"), 2), NO_RANGE);
    }

    #[test]
    fn proximity_order_inside_edge_none_ties() {
        let th = vec![
            t("OP1", Kind::Op, Some("1-47"), false, false),
            t("OP2", Kind::Op, Some("48-115"), false, false),
            t("OP3", Kind::Op, None, false, false),
            t("OP4", Kind::Op, Some("116-168"), false, false),
            t("OP5", Kind::Op, Some("90-100"), false, false),
            t("ED1", Kind::Ed, Some("1-"), false, false),
        ];
        // ep 95: OP2 and OP5 inside (API order tie), OP4 at 21, OP1 at 48, OP3 none.
        assert_eq!(candidate_order(&th, Kind::Op, Some(95)), vec![1, 4, 3, 0, 2]);
        // Unknown episode: API order.
        assert_eq!(candidate_order(&th, Kind::Op, None), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn over_never_an_ed_and_removed_before_ordering() {
        // TYBW 1:13: ED3 is the "Over" theme listed for ep 13.
        let th = vec![
            t("OP1", Kind::Op, Some("2-13"), false, false),
            t("ED2", Kind::Ed, Some("2-6, 8-12"), false, false),
            t("ED1", Kind::Ed, Some("1"), false, false),
            t("ED3", Kind::Ed, Some("13"), true, false),
        ];
        let o = candidate_order(&th, Kind::Ed, Some(13));
        assert_eq!(o, vec![1, 2]);
        assert!(!o.contains(&3));
        // Even a verdict for it can never be accepted: it is not in the order.
        let passed = vec![None, Some(false), Some(false), Some(true)];
        assert_eq!(next_step(&th, &o, &passed, 2), Step::Exhausted);
    }

    #[test]
    fn over_op_sorts_last_and_is_prompt_only() {
        let th = vec![
            t("OP2", Kind::Op, Some("5"), true, false),
            t("OP1", Kind::Op, Some("20-30"), false, false),
        ];
        assert_eq!(candidate_order(&th, Kind::Op, Some(5)), vec![1, 0]);
        assert!(!auto_eligible(&th[0]));
        assert!(auto_eligible(&th[1]));
    }

    #[test]
    fn transition_does_not_stop_search_while_full_version_queued() {
        // Frieren-like: the Transition version is ranked first.
        let th = vec![
            t("ED1", Kind::Ed, Some("28"), false, true),
            t("ED1", Kind::Ed, Some("17-27"), false, false),
            t("ED2", Kind::Ed, Some("1-5"), false, false),
        ];
        let o = candidate_order(&th, Kind::Ed, Some(28));
        assert_eq!(o, vec![0, 1, 2]);
        assert_eq!(next_step(&th, &o, &[None, None, None], 0), Step::Evaluate(0));
        // Transition passed: evaluate the full version before stopping.
        assert_eq!(next_step(&th, &o, &[Some(true), None, None], 1), Step::Evaluate(1));
        // Full version passes: prefer it.
        assert_eq!(next_step(&th, &o, &[Some(true), Some(true), None], 2), Step::Accept(1));
        // Full version fails: the Transition version stands (ED2 is another slug).
        assert_eq!(next_step(&th, &o, &[Some(true), Some(false), None], 2), Step::Accept(0));
    }

    #[test]
    fn first_pass_stops_and_cap() {
        let th: Vec<ThemeMeta> = (0..10).map(|i| t(&format!("OP{i}"), Kind::Op, None, false, false)).collect();
        let o = candidate_order(&th, Kind::Op, Some(1));
        let mut passed = vec![None; 10];
        passed[0] = Some(false);
        passed[1] = Some(true);
        assert_eq!(next_step(&th, &o, &passed, 2), Step::Accept(1));
        let mut passed = vec![Some(false); 10];
        passed[8] = None;
        passed[9] = None;
        assert_eq!(next_step(&th, &o, &passed, 8), Step::CapReached);
        assert_eq!(next_step(&th, &o, &vec![Some(false); 10], 8), Step::Exhausted);
    }
}
