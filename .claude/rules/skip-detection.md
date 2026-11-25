---
paths:
  - "src-tauri/src/skipdetect/**"
  - "src-tauri/src/aniskip.rs"
  - "src-tauri/src/introdb.rs"
  - "src-tauri/src/publicmetadb.rs"
  - "src/skipWindows.ts"
  - "src/nextUpGate.ts"
  - "src/skipSource.ts"
  - "src/skipMatchProgress.ts"
  - "src/skipActions.ts"
  - "src/skipCour.ts"
  - "src/skipMarks.ts"
  - "src/nextPrescan.ts"
  - "src/NextUpCta.tsx"
  - "src/AniSkipMenu.tsx"
  - "src/SkipConfidenceBadge.tsx"
  - "src/introdb.ts"
---

# Skip detection

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/skipdetect/*, src/skipWindows.ts, src/nextUpGate.ts, src/skipSource.ts, src/skipMatchProgress.ts, src/nextPrescan.ts, src/NextUpCta.tsx, the skip chain in src/App.tsx (mergeChapterSkipWindows, composeSkipWindows callers), src/introdb.ts, src-tauri/src/aniskip.rs, introdb.rs, publicmetadb.rs.

### Skip detection: layered, and an ED end is never EOF

`src-tauri/src/skipdetect/` (Rust, one tagged command `skip_detect` with `detect` / `cancel` /
`status` / `prefetch` / `prescan` / `prescan_cancel`, events `skipdetect-update`) plus the pure frontend half in `src/skipWindows.ts` (chapter
titles, ranking, modes, media-end clamp) and `src/nextUpGate.ts` (when the Next-Up card may appear,
and the detected media end the end-of-stream detectors use). Both TS modules are import-free so a
node check can load them. Devlog label `[skipdetect]`. It was designed against a 31-episode corpus
with frame-verified truth. It REPLACED the old ffmpeg silencedetect OP scan and outro tail scan
(`detect_silence_intervals`, `detect_outro_boundary`, both gone from all three registration sites),
which scored OP 10 correct / 7 wrong / 2 false positives and ED 0 correct, skipping the
after-credits scene on 10 of the 11 episodes that have one.

- **Layer 1 (high trust): AnimeThemes reference match.** The cour's themes (MAL id from AIOMetadata's
  per-video `_malId`, else the AniList pair, else the AniSkip resolution) are fingerprinted and
  located in the episode's audio. Accept gates: 30 s run, BER <= 0.35, margin >= 0.15 (do not raise
  it: it is the gate that rejects TV-edited themes), soft42 coverage >= 0.85. Mapping A (chained
  runs, theme file start to theme file end, `matcher::layer1_window`) is the research port and the
  corpus parity tests hold it; the PUBLISHED window is that refined by the edge rule
  (`matcher::refine_layer1_window`, `job::EDGE_RULE` 1): START = the theme's AUDIBLE start (the
  file's lead silence put Steins;Gate 24's opening 2.3 s into story); END decided by the EPISODE's
  0.4 s RMS levels inside the theme file's trailing fade, once the region has finished: a window at
  or above -40 dB there is new content (a preview) and the end becomes onset - 1 s (both kinds);
  otherwise an OP keeps mapping A's end, and an ED ends at audible end + 0.5 s when the fade is at or
  above -60 dB (talked over) or reference end - 0.5 s when it is quiet (a held card). Never past
  mapping A, always clamped to the MEDIA end. Measured on the 89-episode e2e set
  (`edge_mapping.md`, variant REC): every Layer 1 preview / after-credits overrun gone, no verdict
  worse; the thresholds rest on 6 OP and 6 ED onsets, so re-validate before moving one. A stored
  result from an older edge rule answers no kind. No silence snapping (every snap variant pushed ED
  ends into after-credits scenes). Corpus: OP 26/2/0 wrong, ED 23/5/0 wrong, 0 false positives
  (mapping A; `skipdetect_layer1_edge_rule_corpus` pins the edge rule's windows: one ED correct ->
  near, TYBW 1:1). It runs on EVERY anime episode with a MAL id while `autoSkipDetect` is on,
  because its 3 s conflict drop is what removes a wrong crowd window. Themes existed but none matched
  = an informative abstain: Layer 3 is NOT run for that kind. Informative ONLY when every candidate
  loaded and one of the cour's own themes was really compared: a failed theme load (download, HTTP,
  timeout, decode) or a cour whose themes are all shorter than the 30 s run gate (short-form anime)
  leaves the kind `Unavailable` (undecided: the crowd keeps its trust). Failed loads count toward the
  8-per-kind download cap, and two consecutive failures end the kind's search at once (an audio
  outage used to walk every candidate and sibling cour at up to 46 s each, holding both kinds
  pending). A theme the main loader is still fetching when HEAD completes is settled before the OP
  decision forks, so it is never downloaded twice.
  Theme flags are judged PER AUDIO (`animethemes.rs`): an ED whose audio only "Over" videos use is
  not a candidate (TYBW 1:13's insert song); a PARTIALLY Over audio (Pop Team Epic ED3 / ED4 ship an
  NCBD "None" and a TV "Over" video of one audio) is a candidate, sorted last, prompt-only
  (`animethemes-over`). A Transition-only ED (every video of its audio starts over the episode) is
  prompt-only too, under `animethemes-transition`: its matched START is the song's, which can sit
  minutes inside the story (Cowboy Bebop 13's 402 s "Space Lion" passed every gate and would have
  auto-skipped 280 s of story). Its END is trusted. Theme lists cached before `over_partial` existed
  read the old entry-wide flag, which only errs toward excluding.
- **Layer 3 (low trust): loudness continuity** between silences. Only when the cour's OWN AnimeThemes
  list has no theme of the kind ("Over" themes count; a sibling cour's themes that did not match do
  not), or there is no MAL id. Prompt-only, never auto, never a Next-Up trigger, and dropped at stamp
  time for any kind AniSkip, IntroDB, PublicMetaDB or a chapter already supplied. Live action and
  MAL-less anime run the detector only for a kind NOTHING else supplied. A continuity ED that
  overlaps the published opening is withdrawn (with the opening too when that is continuity as
  well): on a file shorter than 480 s TAIL re-reads HEAD's audio, and Kaiju No. 8's 224 s Narumi
  special got one in-story block as both kinds.
- **TAIL never waits for the OP decision.** When HEAD ran to its end, the OP's theme search, sibling
  lookup and Layer 3 run beside the TAIL pass on a forked `Decider` (job.rs) and publish the moment
  they resolve; still one detector ffmpeg at a time.
- **Early provisional opening (`animethemes-early`, HEAD only).** The full gate needs ~75-77 s of
  the theme decoded (30 s run + soft42 coverage), so a 0:00 OP used to prompt 10-34 s into the
  song. `matcher::EarlyTracker` publishes a PROMPT once >= 12 s of a run that starts within 5 s of
  the theme's audible lead clears BER 0.35 and margin 0.15 on the global best placement. Corpus
  (`skipdetect_early_rule_corpus`): every OP fires 12.3-14.1 s into the song (0:00 ones at 13.0 s),
  windows within 0.05 s of the final Layer 1 window, 0 false fires over all 6,696 theme x region
  pairings with no horizon. Do NOT go below 12 s (8 s let the Bleach "Over" insert through, 10 s had
  a thin margin), and never offer it an "Over" theme (the one corpus fire left is exactly that).
  Its own source: prompt-only, NOT Layer 1 (no 3 s conflict drop, so withdrawing it loses nothing),
  ranked 4.5 (below every auto-capable source, above every guess), never cached, never in the final
  snapshot. Replaced by the full match (the tracker stops), withdrawn when the best placement moves,
  the margin drops, the run stops short of 30 s, the whole theme decoded without a full accept, or
  HEAD ends without one. It fires only while HEAD has decoded < 300 s (`EARLY_HORIZON_S`); the curve
  is folded incrementally (same total work as ONE full match) and run detection is skipped while
  the margin is under the floor. An auto window entered past its midpoint (a late full match, a
  resume) now becomes a prompt in `SkipController` instead of nothing.
- **Start latency.** The frontend starts `skip_detect` the moment the MAL id and the duration are
  both known (`watchLoadDuration`: the playback-update events, never a poll), not after AniSkip /
  PublicMetaDB / IntroDB; those ride a promise that the chapter poll awaits only after reading the
  chapters, so the first stamp waits for the slower of the two. Nothing is stamped before the chapter
  poll settles (the Hell's Paradise rule stands). The probe stays: it is the DURATION-tag source of
  the probe-only path. The `prefetch` action warms the AnimeThemes list and the top-ranked theme
  fingerprint per kind for the episode Next-Up pre-resolved (its own MAL pair, else the playing cour
  when it is the next episode of the same season); never episode audio, never with detection off or
  without ffmpeg, one at a time.
- **Next-episode pre-scan (`prescan`, `src/nextPrescan.ts` decisions, the App.tsx effect drives
  them; setting `prescanNextEpisode`, advanced).** The SAME detect job runs on the stream Next-Up
  pre-resolved (the canon episode when the end screen will skip filler / recap), so that episode's
  load is a result-cache hit. It never publishes a snapshot or progress event and shows NOTHING on
  the player (DevConsole `[skipdetect]` only); its probe and region ffmpeg run at BELOW_NORMAL
  priority. It starts only after THIS file's live detect settled, the playing stream has been
  continuously healthy for 15 s (fresh cache readings, no seek, readahead >= 30 s or demuxer at
  EOF), not while casting, anime with a MAL id, ffmpeg already installed, and the Next-Up card on
  (lead time > 0: its pre-resolve is the only stream source). For such an episode (a MAL cour, both
  switches on, a kind wanted, not casting) that pre-resolve runs as soon as this file's live detect
  settled instead of at 50 % (`prescanWantsEarlyResolve`; one early try per episode, a failed one
  waits for 50 %), so the pre-scan starts minutes into the episode. It is cancelled when the playing
  stream buffers, breaks, is truncated, drops under 10 s of readahead, its cache readings stop while
  it plays (a cloaked window), a cast starts, the setting is switched off or the next episode
  changes; a cancelled run starts over (at most 3 starts per key). It has its own slot in Rust:
  every live Detect preempts it, a cancel that arrives before it reached the slot is not lost
  (`PRESCAN_CANCEL_EPOCH`), and `PRESCANNED` is a session record (cap 64, 1 h) of what was already
  pre-scanned.
- **The other kind's song in a kind's place (`animethemes-swap`).** Secrets of the Silent Witch E01
  has no ending: its OPENING song plays over the credits, and E02 on uses it as the opening. Only
  after an INFORMATIVE abstain for a kind (every own theme compared, none in the file),
  `Decider::swapped_theme` compares the cour's OWN themes of the other kind (at most 3, audio not
  already compared) against the same decoded region: the opening song against TAIL, the ending
  song against HEAD. Never a download (a loaded theme, one already in flight on that loader, or the
  fingerprint cache), never another decode; each compare is one full-region match (E01: 0.17 s on
  TAIL, 0.74 s on HEAD), and an episode whose own theme matched never reaches it. Same accept
  gates, THIS kind's edge rule, and the window must sit in its own half of the file (an ending
  starts in the second half, an opening ends in the first; that
  alone does not stop a short file's TAIL, which re-reads HEAD, from finding the opening again:
  `swap_clash` in `no_ed_inside_the_opening` withdraws a swap that shares audio with the other kind's
  window). Results stored before the swap (`Snapshot::swap_rule` below `SWAP_RULE`) do not answer a
  kind they hold as an informative abstain with no window, so only those are detected again. ALWAYS PROMPT-ONLY (user's call, 2026-11-16):
  nothing in the audio tells credits under the opening song from a final episode's epilogue under
  it. The kind's `L1State` stays `Informative` (none of ITS themes is there), the frontend gives it
  no conflict drop (not `isLayer1Source`) and basis "theme-swapped" = RISKY (2026-11-22, user's
  call): near a finale the opening song can play as an insert over the epilogue, and as Likely the
  match raised the ending prompt on its own, put the Next-Up card at the song start and counted
  "m:ss more after the credits" from the song end. As Risky it behaves like every other Risky ending:
  the prompt, the card and the tail pill show only with the player controls (`edRisky`,
  `withControls`), and a Likely or Verified ending (a crowd row, a chapter) is elected over it for
  the card. Its end is NEVER a trusted ending end (`trustedEndingEnd` leaves `animethemes-swap` out,
  published or as the detector's ending with an agreeing published end), so the card's fallback and
  the after-the-credits note never key off it. A swapped opening is Risky too (its prompt shows as
  any Risky opening's does). Its label ("Theme match (song from the other end)") and the song name
  (named only when the cour lists exactly ONE theme of that kind, `stampThemeSongs`) are unchanged.
  An ending chapter that runs to the end of the file ranks just
  below it (`rankPrio`); a bounded ending chapter still outranks it. The swap's false-match rate is UNMEASURED: the corpus audio was
  gone when it was built; it was checked on E01 only (OP1 at 1346.00-1435.13, run 89.5 s, BER
  0.164, margin 0.284, soft42 1.0). Before making it auto-capable, measure it against frame truth.
  When the other kind was requested and its TOP-ranked theme was not available to compare (in flight
  on the other decider: the main loader vs the OP fork) and no swap matched, the result is NOT cached
  (`cacheable = false`), so the next play compares it. With the other kind Off, or only lower-ranked
  themes missing, the abstain stays cacheable. A swapped opening NEVER corroborates a crowd recap
  (`crowdRowAgreed` and `applyCrossSourceHolds` rule 4 exclude `animethemes-swap` explicitly): it is
  prompt-only with an unmeasured false-match rate, so it must not lift another window to auto.
- **Layer 2 (blind pairing) is not shipped**; the `pairing` source and its priority slot are reserved.
- **Layer 1's verdict holds the crowd (`op_l1` / `ed_l1`).** Every snapshot carries a STRUCTURED
  per-kind state (`L1State`: pending, matched, informative, no_themes, unavailable, not_requested;
  never parse a note string). The frontend starts a kind "pending" when the detector will decide it
  (MAL id, detection on, a stream, kind gathered: an ending on Off still is while the Next-Up card
  is on) and `composeSkipWindows` (`src/skipWindows.ts`, the
  ONE stamp function App.tsx and the e2e harness share) applies holds that ride the window as
  `hold`, so the re-stamp cannot re-arm them: pending = crowd rows (AniSkip, IntroDB, PublicMetaDB)
  of that kind only PROMPT ("l1-pending"), unless the provisional opening already starts within 3 s
  of the row; matched = the conflict drop decides as before; informative = auto-capable crowd rows
  prompt ("l1-abstain") and the kind's guesses plus prompt-only crowd rows (introdb-single, AniSkip
  ED) are DROPPED; no_themes / unavailable / a detect that ends or never runs = trusted as before.
  Strongly titled chapters are exempt (a weak-title one is dropped, see Chapters). Both HOLDS apply only to rows overlapping the audio Layer 1 actually
  SEARCHED for the kind by at least 30 s (its minimum accepted run; all of a shorter row): the
  snapshot's `op_region` (0 to the end HEAD decoded) and `ed_region` (TAIL origin to the final media
  end), defaulting to 0-600 s and the last 480 s before the media end. A row outside it (an opening
  at 640 s, past HEAD) was never looked for, so it is not held. The informative DROP of guesses and
  prompt-only crowd rows still applies outside it (judgement call, measured: Spy x Family E2's
  single-submission IntroDB "ending" at 905-995 s of an episode with no ending came back as a wrong
  prompt when the drop was scoped to the region too). Why: before the theme match lands, a crowd opening at 0-90 s
  auto-skipped 89 s of JJK S2E10's cold open (the Hell's Paradise rule again, reopened by the
  mid-play re-stamp); after an informative abstain, Solo Leveling E1, Re:Zero S3E1 and Gintama's OAD
  each auto-skipped ~90 s of story on AniSkip's word. Cost: a correct crowd 0:00 opening is skipped
  once the provisional opening confirms it (~13 s into the song) instead of instantly. Result-cache
  entries written before the states existed answer no request (detected once more).
- **Crowd rows are checked against THIS file** (`fitCrowdToDuration`, once the duration is known,
  before anything counts as "supplied"): a row that starts past the end is dropped for every crowd
  source (House of the Dragon S2E1's two endings started past the end and kept the detector from
  ever looking); IntroDB keeps its stricter end rule; an AniSkip row whose `episode_length` (now
  carried from Rust) differs from the file by more than 15 s is held prompt-only ("other-cut"):
  10 / 15 / 20 s all catch the same 20 of 36 wrong rows over both corpora, including every one that
  auto-skipped story, and the 6 correct rows they demote are each replaced by a theme match or a
  chapter. Without a MAL id (live action) a crowd OPENING auto-skips only when a second independent
  source agrees within 3 s at both edges (IntroDB vs PublicMetaDB, or a strongly titled chapter),
  else it prompts ("uncorroborated"): 5 of the 9 lone live-action crowd openings cut into story.
  Endings keep their trust. A crowd RECAP (anime or not) needs the same second source; identical
  rows (to 0.05 s) are one submitter, not two (JJK S1E3's AniSkip and IntroDB "recap" 0.5-41.6 are
  the same numbers, and frames show 30 s of it is the episode's own dorm scene). The opening Layer 1
  (or the provisional opening) located in the file also corroborates a recap whose END is within 3 s
  of that opening's start: evidence from the file itself (never a swapped opening, `animethemes-swap`:
  `crowdRowAgreed` and `applyCrossSourceHolds` rule 4 exclude it, since it is prompt-only with an
  unmeasured false-match rate and must not lift another window to auto). Trade-off, measured: without it the rule
  rescued one episode (JJK S1E3) and held every correct automatic recap in the corpora (Black Clover
  2:1 recap end 178.0 vs theme 176.05, DBZ Kai 26 40.13 vs 39.01); with it all three come out right
  and Bleach 266 / One Piece 8 stay held by other-cut. Cost: the theme match lands some 10-17 s into
  a load, so such a recap at 0 s turns auto only then; the SkipController skips the rest of it
  while that is before its midpoint and offers it as a prompt after. The PublicMetaDB
  anime fallback for an id with no season of its own (`kitsu:N:E`) maps the cour's local episode to
  TMDB's through its Fribb row (`season.tmdb` + `episode_offset.tmdb`) and is not asked at all for an
  OVA / special / movie or an entry Fribb does not map: their TMDB id is the parent show's (the Mob
  Psycho 100 OVA was stamped with TV episode 1's opening). It reads a MAL-keyed index of EVERY Fribb
  row (`anime_id_map.rs` `MAL_TMDB`), not the imdb-keyed one: Fribb lists many TV cours without an
  imdb_id, and the imdb index silently skipped every one of them.
- **Merge (`dedupeSkipWindows`)**: animethemes 8 > chapter 7 > animethemes-swap 6.5 > aniskip =
  introdb 6 > pairing = publicmetadb 5 > animethemes-transition 4.75 > animethemes-early 4.5 > introdb-single 4 >
  aniskip-neighbour 3 > chapter-heuristic 2 > continuity 1. `base` reaches the stamp UNDEDUPED (the
  chapter merge and the IntroDB join no longer dedupe), so a corroborating second source is still
  there to be read. A Transition-only ending keeps another ending only when that ending's END agrees
  within 3 s AND it starts no earlier than the song (a real ending cannot start before its song; a
  crowd ending fitted to the file's end that starts in story before it was outranking the match), and
  such an ending then outranks it; one whose START a strongly titled chapter confirms within 3 s
  becomes plain `animethemes` (Bebop 26, Bocchi 12). A crowd row no longer promotes one: a single
  AniSkip row marking where a Bebop-13-style song begins would have made a 280 s story cut a
  Verified, automatic skip. The Transition match itself stays
  prompt-only even when it is right (Solo Leveling E1 loses an automatic ED skip): the accepted cost
  of the Bebop 13 rule, since its start can sit minutes inside the story. A weak-title chapter
  ("weak-title" hold) ranks below every unheld window of its kind, so it never wins the one-opening
  election over a crowd opening it disagrees with; with nothing else of its kind it still prompts. An ending never overlaps the opening: the
  better-ranked one stays, a tie or two continuity windows both go. When
  a Layer 1 window exists for a kind, every other window of that kind whose start OR end is more than
  3 s away is DROPPED (TYBW 3:9-3:11 AniSkip ED rows were 32-38 s early with a matching
  episodeLength). AniSkip ED rows are prompt-only even with the ED mode on auto; IntroDB keeps its
  own tiers. The AniSkip rows a Layer 1 window replaced ride the `set_skip_windows` payload's
  `superseded` list (`dedupeSkipWindowsDetailed`): the AuraSkip menu lists them for their vote arrows,
  and nothing that seeks or prompts reads it (mpv's property gets `windows` only).
  A crowd recap lying inside a Layer 1 opening is dropped (a recap never plays under the theme).
- **Chapters**: "epilogue" is NOT an ending. Preview / next episode / next time / coming up chapters
  are their own `preview` kind (so is a combined "ED + Preview" title, and the localized adelanto /
  avance / avant-premiere / prochain episode / vorschau / anteprima / proximo episodio / yokoku);
  only one in the outro region counts (Steins;Gate 24's FIRST chapter, its cold open, is titled
  "Preview"). No ED is derived from an untitled LAST chapter that runs to EOF (it can hold the
  ending, an after-credits scene and a preview). "Intro" / "Introduction" / "Outro" are WEAK titles
  (9 of 11 such chapters in both corpora were cold opens, previews or story: Re:Zero S4E5's pair
  alone is 372 s of story): dropped when the file also has a strongly titled chapter of the kind,
  otherwise prompt-only ("weak-title") unless a fitting crowd row agrees within 3 s at both edges,
  and DROPPED while Layer 1 is pending for its kind or after an informative abstain (Re:Zero S4E5's
  "Intro" prompt was on screen at 0.6 s; over all 89 corpus episodes this changes that episode
  only).
  Prologue / avant / cold open / teaser / pre-title chapters are STORY and never feed the
  untitled-chapter heuristics (TYBW 1:1's "Prologue" became an 80 s opening on an episode with
  none).
- **`preview` kind**: no Settings row; hard-coded in `skipModeForKind` (used by BOTH the chain's
  `modeFor` and the re-stamp's `modeForKind`): prompt, never auto, off when the ED mode is off.
- **THE RULE: an ED window end is NEVER the file / container duration.** It ends where the matched
  theme ends (Layer 1) or at a trailing silence (Layer 3), and every window is clamped to the MEDIA
  end (TAIL origin + decoded samples at TAIL EOF), which can be ~29 s shorter than the container
  duration (Spy x Family E2, Demon Slayer S1E2, TYBW 3:14). Never stamp `[ed_start, duration]`,
  never borrow an ED from neighbour episodes (that borrow put a phantom ED inside TYBW 3:10's
  after-credits scene and is retired; the OP borrow remains), and never gate an ED's existence on a
  "last N seconds" band (TYBW 3:14's ED starts 418 s before EOF, 3:1's 290 s).
- **Next-Up**: the card (`NextUpCta.tsx`) has NO countdown. Unattended advance happens only
  at end of stream, through the EOS Spotlight, so after-credits scenes and previews always play
  unless the user presses Play. The card appears as the ending STARTS when `nextUpEnding`
  (`skipWindows.ts`) elects an ending (any source and level; Verified, then Likely, then Risky,
  then the LATEST) and that ending starts in the second half of the file and more than 5 s before
  its end.
  It reads the stamp BEFORE skip
  modes, so a mid-play mode change does not move the card. Endings set to Off are still GATHERED while
  the card is on (lead time > 0): `gatherFor` in the chain maps an Off ending / preview to prompt
  for every fetch, chapter derivation, the Layer 1 pending state and the detector's `detect_ed`,
  while publishing stays on `modeFor`. The PAYLOAD is a second `composeSkipWindows` over the
  mode-filtered base AND detected windows, never `full` filtered afterwards: a Layer 1 ending
  outranks an opening in the cross-kind rule and would drop the user's opening. The card-only ending
  read never downloads ffmpeg (no toast), is not requested on a file under 1140 s (600 + 480 + 60:
  below that TAIL can reach HEAD's audio, and Rust's `no_ed_inside_the_opening` withdraws a
  continuity opening together with a continuity ED overlapping it, at ANY length), and is not
  requested without a MAL id (it could only be Layer 3, Risky). Only an Off ending / preview while
  the card is on is left out of the payload compose up front; an opening or recap turned Off
  mid-episode is composed and dropped by `applySkipModes` as before, since it is still the file's
  evidence (a matched opening corroborates a recap). Every kind Off with the card
  off is still the probe-only path. A Risky ending raises the card too, with its prompt (user's
  call, 2026-10-20): a Transition-only start can sit 280 s into the story (Cowboy Bebop 13) and 8
  of 13 lone AniSkip endings were wrong, but a card with no countdown only sits there, while
  waiting for the trusted END put the card up in the last 7 s of To Be Hero X E07, whose
  Transition-only ending runs to the end of the file. Under a Risky ending the prompt, the card
  and the tail pill show ONLY with the player controls, never popping up on their own (user's
  call, 2026-10-20; `edRisky` on the timing, `nextUpFollowsControls`, the prompt's
  `withControls`, which keeps its stack slot while hidden so the card does not slide); the Skip
  Segment and Play Next Episode keys work while they are hidden. v2.2.2 waited for
  the ED END instead, which put the card up a fraction of a second before the end screen on every
  episode whose ending runs to the end of the file; the countdown, not the start, was what lost
  after-credits scenes. Without a credible start: `max(trusted ED end, end - lead)` (at the ED end
  when nothing follows it), else `end - lead`; only a Layer 1 ED END is trusted (a Transition-only
  match's end counts, so does a partially Over match's, prompt-only but located by the same
  evidence: Pop Team Epic 1:5, and so does the end of the published ending that replaced a match
  when the two ends agree within 3 s: Solo Leveling E1, Cowboy Bebop 13; never a swap match's,
  `animethemes-swap`, see above). Because the card is up
  during the credits, a banner on it says what Play would skip (`nextUpTailNote`): "Preview after
  the credits" when a preview chapter FILLS the tail (starts within 5 s of the ED end, ends within
  5 s of the end), else "m:ss more after the credits", from a TRUSTED ED end to a MEASURED media
  end (TAIL EOF, else the probe's DURATION tag; never a crowd / chapter end, never the container
  duration the early estimate can be), and nothing otherwise. The banner goes once the ending is
  over (the user is watching what follows), so a card first raised after it has none. It never calls an unlabelled tail a scene or a preview: Aura cannot tell them apart.
  With no card to carry it (`nextUpInfo` null: no next episode, or the lookup failed), the same
  note shows alone in the card's place (`NextUpTailPill`), under the card's own gate (lead time
  above 0, not dismissed, not truncated); it takes no clicks and never fades, since it only ever
  shows during the ending. Card and pill sit TOP LEFT, under the skip prompt: the prompt
  publishes its bottom edge as a CSS variable on `<html>` while it is visible and the card's `top`
  reads it (`src/playerStack.ts`), sliding up into the prompt's place when it fades or goes. All
  three share the prompt's surface (`.aura-stack-surface`, App.css) and entry; card and pill fade
  OUT through `StackPresence` (`NextUpCta.tsx`), which keeps the last element mounted, marked
  `exiting` (key unbound, no clicks), for 200 ms. The
  Play Next Episode keybinding (default Shift+X, handled inside `NextUpCta` because it needs keyup)
  presses the card while it is up: Play, or with a skip to canon on offer Skip, held 2 s with the
  canon preview showing unless `nextUpHoldToSkip` is off. The Skip Segment keybinding (default X,
  `SkipController`) skips any window playing now, handled or not; the old always-on Shift+X force
  skip is gone (it existed only because X answered visible prompts alone).
  Only a card that went up while the PLAYHEAD was before the ED end (`nextUpRaisedTimeRef`, an
  auto-skipped ending included) fades with the player controls past it (`nextUpFadeFrom`, stays
  while hovered): one first raised by the fallback, a resume or a seek into the tail would be born
  invisible. While the trigger is a fallback, the hide rule measures a seek-back from the EARLIEST
  trigger the card was raised at (`nextUpShownAtRef`), so a stamp that withdraws the ending cannot
  take the card down mid-credits; a credible start is measured from itself, so a stamp that
  replaced a wrong early ending takes down a card that went up over story. "end" is the detector's
  media end when known. The keep-open, stale-heartbeat and eof EOS detectors test against
  `eosEnd(duration)` (the FINAL media end, else the probe's mapped-track DURATION tag, never the
  container duration), so a container longer than its media still reaches the end card instead of a
  false "stream lost". A series load that detects no kind (everything supplied, detection switched
  off, ED off without a MAL id or with the Next-Up card off) still runs a PROBE-ONLY detect for that tag when ffmpeg is present, and so does every
  MOVIE load. The detected media end belongs to the FILE: it is cleared with the load token and on
  exit, never in `notifyNewLoad`, because EOS Replay, the VOD auto-retry and the recovery Reload
  re-run loadfile on the same url without re-running the skip chain.
- **ffmpeg passes**: probe, then ONE sequential HEAD pass (0-600 s, output-side `-to 600`, no `-ss`,
  no `-copyts`, no `-t`), then TAIL (`-ss S -copyts` to EOF, no `-t` / `-to`, `S = min(container,
  mapped track DURATION tag) - 480`). At most one detector ffmpeg at a time, all CPU work on the
  blocking pool, nothing on the engine thread. Region origin = the FIRST DECODED PTS, never the `-ss`
  value. The resampler is `aresample=11025:async=1`: a DTS track with timestamp gaps (JJK S1E3)
  otherwise shifts every window about 2 s early.
- **Cancellation**: a module-level generation counter in Rust; the frontend cancels on every load, on
  exit playback and before each Detect, and applies only `skipdetect-update` events of its own
  generation. A main-page reload (F5, the stream-lost Reload) cancels too, in Rust
  (`skipdetect::cancel_all` from `on_page_load`), since the page that would cancel is gone. A
  mid-play skip-mode change re-stamps through the running chain's serialised `stamp`
  (`liveSkipStampRef`), never with a read-modify-write beside it. The SkipController matches handled
  windows by kind with both edges within 3 s (`handledIn`), so a refinement of a skipped opening is
  not re-prompted or re-skipped. The Detect (and Prefetch) action's kind switches travel as `detect_op` / `detect_ed`,
  because the action enum is tagged `op`. A Prefetch is not cancelled by a Detect. A pre-scan IS
  preempted by every Detect, is NOT stopped by Cancel (exit playback: the next episode may be
  watched later), and is stopped by `prescan_cancel` (every load, the health abort), `cancel_all`
  (page reload), the Storage clear and a newer pre-scan.
- **Theme-match readout.** `stream_region` reports how far HEAD / TAIL has decoded (per whole
  percent, held under 100 until the region ends) as its OWN event, `skipdetect-progress`
  (`job::Progress`, same generation filter), never a Snapshot field: every snapshot re-stamps the
  skip windows. `src/skipMatchProgress.ts` turns it plus the snapshots' `op_l1` / `ed_l1` into one
  row per kind that is really being theme matched (the catalogue has a candidate of the kind, Layer
  1 pending, mode not Off; never a card-only ending, a probe-only run or a cache hit), and the
  verdicts linger 4 s. Shown inside the skip prompt under a divider, else in the prompt's slot
  (`SkipMatchStatus`, only with the player controls, so it never sits over a cold open).
- **Confidence levels (Verified / Likely / Risky)** on the skip prompt, the scrubber's hover card,
  the AuraSkip menu rows, the auto-skip toast and a Settings legend. `composeSkipWindows` stamps a
  `basis` on every window it publishes (`SkipBasis`, `skipBasisFor`: what the POSITION rests on,
  judged against everything the stamp weighed, before the media-end clamp); `skipConfidence` maps
  basis + kind + length to the level and `skipConfidenceInfo` (`src/skipSource.ts`) words it.
  `basis` rides the Rust payload (`PreparedWindow::basis`) so the mid-play re-stamp keeps it.
  The table is MEASURED, not guessed (every window of every stamp of the 89-episode corpus against
  frame truth, scratchpad `confidence/evidence.md` of session 20dd39a5): Verified = a theme match
  whose edges are refined (`WindowOut::refined`, set when the region's levels gated the edges, and
  on a result-cache hit) and at most 150 s long, a titled opening chapter of 20-100 s, a titled
  preview chapter of at most 40 s; measured worst case 1.6 s of story. Likely = an unrefined theme
  match ("theme-settling": the pre-levels windows are where every 1.8 s overrun was), the early
  opening, a theme that plays over story in some versions, other titled chapters, a crowd row
  alone or with an independent second source. Risky = the other kind's song in a kind's place
  ("theme-swapped": located precisely, but it may play over story), an AniSkip ending, a crowd row shown while
  the theme match is still checking (7 of 13 cut story, JJK S2E10's 90 s cold open), an ending
  chapter that runs to the end of the file ("chapter-tail": Blue Box 2:1's "Credits" chapter held a
  106 s scene after the ending), a Transition-only theme, weak titles, guesses, other cuts, single
  submissions, lone sources, rows the file contradicts. RISKY IS ALWAYS PROMPT-ONLY (`isPromptOnly`),
  so a Risky label never sits on an automatic skip. A weak-title chapter is never an independent
  witness (`weak_title`), and a window with no basis (a payload from before bases) shows no level.
  Before moving a window into Verified, re-measure: the user's bar is that a Verified skip never
  cuts story.

### AnimeThemes API (moved from the root constraints table)

| Area | Constraint |
|------|------------|
| AnimeThemes API | GraphQL at `https://rs.animethemes.moe/graphql` via `skipdetect/animethemes.rs` (the skip detector's theme list and theme audio). The old JSON:API (`api.animethemes.moe`) was deprecated in July 2026 and answers every path with an nginx 503 since the Rust server went live (2026-11-08); do not go back to it. Exactly ONE endpoint const, rustls client with `https_only(true)`. The theme list is ONE POST of a fixed read-only query (`filterAnimeByExternalSite(site: MAL)`, the MAL id the only variable); audio is GET. GraphQL failures arrive as HTTP 200 with `errors` / `data: null` and must read as Unavailable, never a cached miss. Video `overlap` is the enum `NONE` / `TRANS` / `OVER` (the JSON:API spelled it `None` / `Transition` / `Over`; both parse), and an unknown value fails the whole list, because read as clean it would turn Over and Transition-only themes into automatic skips. Request starts paced at least 1 s apart (the API allows 90/min). Theme audio is accepted only over https from animethemes.moe or a subdomain (no userinfo, no port); it is decoded through ffmpeg stdin to a fingerprint and DISCARDED. Only fingerprints are cached. |
