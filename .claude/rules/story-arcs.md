---
paths:
  - "src-tauri/src/arcs.rs"
  - "src-tauri/src/arc_align.rs"
  - "src-tauri/src/arc_art.rs"
  - "src-tauri/src/manga_chapters.rs"
  - "src/storyArcs.ts"
  - "src/mangaChapters.ts"
---

# Story arcs

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/arcs.rs, arc_align.rs, arc_art.rs, src/storyArcs.ts, the Arcs UI in src/views/DetailView.tsx.

### Story arcs: NEVER join TMDB arcs to episodes by number

Arcs come from TMDB episode groups (`type == 5`), which define an arc as a set of TMDB
`(season, episode)` pairs. Aura's episode ids come from Stremio meta addons (Cinemeta / TVDB
numbering). **The two numbering systems disagree, and not by a constant.** Do not "fix" this with a
season join, an absolute-episode join, or a hardcoded offset. All three are wrong:

- TMDB's season boundaries are not Cinemeta's (One Piece: TMDB S1 = 61 episodes, Cinemeta S1 = 8).
- TMDB promotes a Toriko crossover special into One Piece's MAIN RUN at absolute 590; Cinemeta files
  it as special S0E39. So TMDB abs N == Cinemeta abs N up to 589 and N-1 from 591 on. A naive
  absolute-index join misplaces **579 of 1168 episodes (49.6%)**: every arc from Punk Hazard onward
  starts and ends one episode late, and it *looks correct*. That offset is one TMDB editorial
  decision, not a constant, and it grows over time.
- Air date alone is not a key (weekly anime repeat dates: 40 of Naruto Shippuden's air dates carry
  two episodes). Title alone is not a key (TVDB and TMDB use different English translations of the
  same episode; some true pairs score 0.00 on bigram similarity).

`arc_align.rs` is the answer: a banded Needleman-Wunsch alignment over air date + title with
broadcast order as a hard constraint, which absorbs a promotion/demotion as a single gap. Measured
100% correct on One Piece (1168/1168) and Naruto Shippuden (500/500). It has real `#[cfg(test)]`
tests, including a regression test for exactly the off-by-one above; keep them. Any arc containing a
sub-0.5-confidence pair is DROPPED and logged rather than rendered. Fail visible, never fail
off-by-one. Season 0 is excluded on both sides (the two databases' specials do not correspond).

**Related: never trust TMDB's arc NAME for filler status either.** TMDB bakes a
marker into the title string ("The Past (Filler)"), and it is wrong in both
directions on Bleach: "The Past" is titled filler and is fully CANON, while
"Gotei 13 Invading Army" is titled filler and is filler except for its last
episode. Aura has per-episode filler data from AIOMetadata plus the cloud
release signal, so `arcKindSummary` (`src/storyArcs.ts`) derives the label from
that, using the SAME predicate as `countFillerRecap` and `mergedKindFlags` so a
tile can never disagree with the episode rows it opens. The parenthetical is
stripped from the displayed name only when the show HAS kind data; for a show
with none, TMDB's marker is the only signal and is kept. That check is made at
SHOW level, because a fully-canon arc inside a show that does have data carries
no flags at all and an arc-level check would misread that as "no data".
