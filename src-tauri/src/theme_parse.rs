// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! MyAnimeList theme-song string parser.
//!
//! MAL does not publish opening and ending songs as structured data. It
//! publishes DISPLAY STRINGS, and every rule in this module was earned from
//! real ones:
//!
//! ```text
//! 1: "We Are! (ウィーアー!)" by Hiroshi Kitadani (きただにひろし) (eps 1-47,1000)
//! 1: "memories" by Maki Otsuki (大槻真希) (eps 1-30,808,968)
//! 2: "Believe" by Folder5 (eps 48-115)
//! 1: "again" by YUI
//! ```
//!
//! Three traps, in descending order of how badly they bite:
//!
//! 1. **Episode ranges are disjoint LISTS, not a start-end pair.** One Piece's
//!    OP1 covers episodes 1-47 AND episode 1000 (a one-off anniversary
//!    callback). Reading that as a span from 1 to 1000 would mislabel roughly
//!    950 episodes with a song that is not playing, and it would look correct.
//! 2. **The episode range is not "the last parenthetical".** Artists carry
//!    parenthesised Japanese names, so the range must be anchored on the
//!    literal `(eps ` or `Hiroshi Kitadani (きただにひろし)` parses as one.
//! 3. **Titles contain parentheses and quotes-adjacent punctuation.** The
//!    quote pair is the only reliable title delimiter, and the CLOSING quote
//!    is the last one before ` by `, not the second one in the string.
//!
//! The contract that matters downstream: an EMPTY `episodes` vec means
//! UNKNOWN, never "all episodes". `covers` returns false for it. The player
//! uses that to fall back to generic prompt text, because naming the wrong
//! song is worse than naming none. Same rule as `streamMeta.ts`: a fallback
//! that fills a field with the wrong value is worse than an empty field.

use serde::{Deserialize, Serialize};

/// An inclusive episode span. A singleton has `start == end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct EpisodeSpan {
    pub start: u32,
    pub end: u32,
}

/// One parsed theme. Every structured field is optional because every one of
/// them can legitimately be absent from the source string, and a guess is
/// worse than a gap.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct AnimeTheme {
    /// The leading ordinal ("1:" -> 1). Absent when the string is unnumbered.
    pub index: Option<u32>,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// EMPTY MEANS UNKNOWN, never "all episodes". See the module note.
    pub episodes: Vec<EpisodeSpan>,
    /// The input, verbatim. Always retained so the UI can render something
    /// truthful even when every structured field failed to parse.
    pub raw: String,
}

/// The anchor for the episode suffix. Anchoring on this literal rather than on
/// "the last parenthetical" is what stops a parenthesised artist name being
/// read as an episode range.
const EPS_ANCHOR: &str = "(eps ";
const BY_SEP: &str = " by ";

/// Parse one MAL theme display string. Never fails: an unparseable input
/// yields a struct whose only populated field is `raw`.
pub fn parse_theme(raw: &str) -> AnimeTheme {
    let mut out = AnimeTheme { raw: raw.to_string(), ..Default::default() };
    let s = raw.trim();
    if s.is_empty() {
        return out;
    }

    // ── index: leading digits before the first ':' ──
    // Bounded to the head of the string so a colon inside a title cannot be
    // mistaken for the ordinal separator.
    let mut body = s;
    if let Some(colon) = s.find(':') {
        let head = &s[..colon];
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
            out.index = head.parse::<u32>().ok();
            body = s[colon + 1..].trim_start();
        }
    }

    // ── episode suffix ──
    // Required shape: ends with ')' and contains the `(eps ` anchor. Uses the
    // LAST anchor occurrence so a title containing the literal text cannot
    // shadow the real suffix.
    let mut head = body;
    if body.ends_with(')') {
        if let Some(at) = body.rfind(EPS_ANCHOR) {
            let inner = &body[at + EPS_ANCHOR.len()..body.len() - 1];
            out.episodes = parse_spans(inner);
            head = body[..at].trim_end();
        }
    }

    // ── title: between the first quote and the last quote preceding ` by ` ──
    // The closing quote is located relative to the ` by ` separator rather
    // than by taking the second quote, because titles contain quotes of their
    // own more often than the separator appears inside one.
    let by_at = head.rfind(BY_SEP);
    if let Some(open) = head.find('"') {
        let search_end = by_at.unwrap_or(head.len());
        if search_end > open + 1 {
            if let Some(rel) = head[open + 1..search_end].rfind('"') {
                let close = open + 1 + rel;
                let t = head[open + 1..close].trim();
                if !t.is_empty() {
                    out.title = Some(t.to_string());
                }
            }
        }
    }

    // ── artist: everything after ` by ` in the head ──
    if let Some(at) = by_at {
        let a = head[at + BY_SEP.len()..].trim();
        if !a.is_empty() {
            out.artist = Some(a.to_string());
        }
    }

    out
}

/// Parse the inside of an `(eps ...)` suffix into spans.
///
/// ALL-OR-NOTHING BY DESIGN: a single unparseable token discards the entire
/// list. A partially-parsed range list is exactly the shape that produces a
/// confident wrong answer, which is the failure this module exists to avoid.
fn parse_spans(inner: &str) -> Vec<EpisodeSpan> {
    let mut out = Vec::new();
    for token in inner.split(',') {
        let token = token.trim();
        if token.is_empty() {
            return Vec::new();
        }
        let span = match token.split_once('-') {
            Some((a, b)) => {
                let (a, b) = (a.trim(), b.trim());
                match (a.parse::<u32>(), b.parse::<u32>()) {
                    (Ok(start), Ok(end)) if start <= end => EpisodeSpan { start, end },
                    _ => return Vec::new(),
                }
            }
            None => match token.parse::<u32>() {
                Ok(n) => EpisodeSpan { start: n, end: n },
                Err(_) => return Vec::new(),
            },
        };
        out.push(span);
    }
    out
}

/// Does this theme cover the given episode?
///
/// Returns FALSE for an empty span list. That is the whole contract: unknown
/// coverage must never read as universal coverage.
pub fn covers(theme: &AnimeTheme, episode: u32) -> bool {
    theme.episodes.iter().any(|s| episode >= s.start && episode <= s.end)
}

/// Parse a whole array of display strings.
pub fn parse_all(raw: &[String]) -> Vec<AnimeTheme> {
    raw.iter().map(|s| parse_theme(s)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_disjoint_ranges() {
        let t = parse_theme(
            "1: \"We Are! (ウィーアー!)\" by Hiroshi Kitadani (きただにひろし) (eps 1-47,1000)",
        );
        assert_eq!(t.index, Some(1));
        assert_eq!(t.title.as_deref(), Some("We Are! (ウィーアー!)"));
        assert_eq!(t.artist.as_deref(), Some("Hiroshi Kitadani (きただにひろし)"));
        assert_eq!(
            t.episodes,
            vec![
                EpisodeSpan { start: 1, end: 47 },
                EpisodeSpan { start: 1000, end: 1000 },
            ]
        );
        // The regression this module exists to prevent: a naive start-to-end
        // read would claim episode 500 is covered.
        assert!(covers(&t, 1));
        assert!(covers(&t, 47));
        assert!(covers(&t, 1000));
        assert!(!covers(&t, 48));
        assert!(!covers(&t, 500));
        assert!(!covers(&t, 999));
    }

    #[test]
    fn parses_multiple_singletons() {
        let t = parse_theme("1: \"memories\" by Maki Otsuki (大槻真希) (eps 1-30,808,968)");
        assert_eq!(t.episodes.len(), 3);
        assert!(covers(&t, 30));
        assert!(covers(&t, 808));
        assert!(covers(&t, 968));
        assert!(!covers(&t, 31));
        assert!(!covers(&t, 809));
    }

    #[test]
    fn parses_simple_range() {
        let t = parse_theme("2: \"Believe\" by Folder5 (eps 48-115)");
        assert_eq!(t.index, Some(2));
        assert_eq!(t.title.as_deref(), Some("Believe"));
        assert_eq!(t.artist.as_deref(), Some("Folder5"));
        assert_eq!(t.episodes, vec![EpisodeSpan { start: 48, end: 115 }]);
    }

    #[test]
    fn missing_eps_suffix_yields_no_spans_but_keeps_title() {
        let t = parse_theme("1: \"again\" by YUI");
        assert_eq!(t.title.as_deref(), Some("again"));
        assert_eq!(t.artist.as_deref(), Some("YUI"));
        assert!(t.episodes.is_empty());
        // Empty means UNKNOWN, never "all".
        assert!(!covers(&t, 1));
    }

    #[test]
    fn malformed_range_discards_the_whole_span_list() {
        let t = parse_theme("3: \"X\" by Y (eps 1-5,abc)");
        assert_eq!(t.title.as_deref(), Some("X"));
        assert!(t.episodes.is_empty());
        assert!(!covers(&t, 3));
    }

    #[test]
    fn reversed_range_is_rejected_wholesale() {
        let t = parse_theme("4: \"Z\" by W (eps 20-5)");
        assert!(t.episodes.is_empty());
    }

    #[test]
    fn artist_parens_are_not_mistaken_for_an_episode_range() {
        // No `(eps ` anchor at all, so the trailing parenthetical is part of
        // the artist and must NOT be consumed as a range.
        let t = parse_theme("5: \"Song\" by Artist (アーティスト)");
        assert_eq!(t.artist.as_deref(), Some("Artist (アーティスト)"));
        assert!(t.episodes.is_empty());
    }

    #[test]
    fn title_containing_by_does_not_split_early() {
        let t = parse_theme("6: \"Stand by Me\" by The Band (eps 1-12)");
        assert_eq!(t.title.as_deref(), Some("Stand by Me"));
        assert_eq!(t.artist.as_deref(), Some("The Band"));
        assert_eq!(t.episodes, vec![EpisodeSpan { start: 1, end: 12 }]);
    }

    #[test]
    fn raw_is_always_retained() {
        let s = "total garbage with no structure";
        let t = parse_theme(s);
        assert_eq!(t.raw, s);
        assert!(t.title.is_none());
        assert!(t.episodes.is_empty());
    }

    #[test]
    fn empty_input_is_safe() {
        let t = parse_theme("");
        assert!(t.title.is_none());
        assert!(t.artist.is_none());
        assert!(t.episodes.is_empty());
        assert!(!covers(&t, 1));
    }

    #[test]
    fn unnumbered_string_still_parses_title_and_artist() {
        let t = parse_theme("\"Solo\" by Someone (eps 3-4)");
        assert_eq!(t.index, None);
        assert_eq!(t.title.as_deref(), Some("Solo"));
        assert_eq!(t.artist.as_deref(), Some("Someone"));
        assert_eq!(t.episodes, vec![EpisodeSpan { start: 3, end: 4 }]);
    }
}
