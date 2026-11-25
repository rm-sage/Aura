# Where to look first by symptom

> Moved verbatim out of the root CLAUDE.md (2026-11-17) to keep it under the size limit; the root keeps a short summary and links here. Read this before changing: debugging any reported symptom.

## Where to look first by symptom

- "Volume slider snaps back" / "speed does not change" -> the `set_*` Tauri commands in `lib.rs`;
  verify they submit a typed `SetProperty`, not `Command(vec!["set_property", ...])`.
- "MPV renders behind UI" / black bar at top -> `App.tsx` TitleBar `opaque` prop, body `hidden` class
  while playing, and `.aura-app-shell` background must be transparent always.
- "MPV does not fill window after fullscreen toggle" -> the engine's geometry pump in `mpv/engine.rs`
  (polls parent rect + fullscreen state every ~5 ms and resizes host + child via
  `win32::resize_mpv_child_to_parent`). `refresh_video` only does the video-zoom nudge now.
- "App crashes on play" (STATUS_ACCESS_VIOLATION) -> MPV property race; check polling and
  observed-property formats. The tail of `%USERPROFILE%\aura-mpv.log` usually pinpoints it.
- "Native browser context menu appears" -> `main.tsx` capture-phase `contextmenu` listener; must
  install BEFORE React mounts.
- "Streams from addon X do not appear" -> DevConsole filter for `[X]`; `fetch_streams` logs the
  manifest gate decisions.
- "Stream chips missing / wrong" (no audio-channel or seeder chips, size chip showing the FOLDER
  size, raw glyph text under the title) -> `src/streamMeta.ts`. See "Stream chip parsing" in `.claude/rules/streams.md`.
- "Anime ratings differ between the hover card and the detail page" -> `CatalogHoverCard.tsx`'s
  ratings effect. Both surfaces must elect the same metadata addon AND must not fetch before the
  meta detail resolves; a detail-less fetch sends null anime ids and falls through to the title
  search, which can elect the wrong MAL entry. The session cache is keyed on the ids the answer was
  computed from for exactly this reason. DevConsole `[aniskip]` logs the elected id and score.
- "A movie's digital / theatrical date is wrong or shows Reported" -> DevConsole `[release-dates]` prints the
  region asked, which source and country each date came from, and the TMDB outcome (`N rows`, `no match`, `find
  failed`, `deadline failed`, `no key`). Reported means TMDB had no row of that kind for any country. Story Arcs and
  this share the TMDB key (`arcs::tmdb_key`, keyring override).
- "A leaked / early film still shows a Digital countdown" -> `src/movieEarly.ts`. The check runs only on the detail
  page (open it once); DevConsole `[release-dates]` logs "early-release check says <kind>". No "Out early" without
  AIOStreams' signal or a home-release label on a row: check that PROVIDE_STREAM_DATA is on and that the AIOStreams
  build sends `code: "earlyRelease"`. The copies only count on the film's OWN id (a same-name knockoff whose date
  has passed never shows it).
- "Ratings missing/sparse" -> `ratings.rs`: the MDBList branch needs a `tt`-prefixed IMDb id and a
  non-empty `AURA_MDBLIST_KEY` (baked from `.env.local`); the MAL/AniList branch needs a resolvable
  anime id. Non-tt non-anime ids get only addon-supplied `detail.ratings`. OMDb is fully removed.
- "Detected OP/ED missing or wrong" -> DevConsole `[skipdetect]`: the cour MAL id and its source,
  the mapped audio track, S and the read origin, the media end, and every theme tried (run, BER,
  margin, soft42, verdict). An abstain is usually a gate doing its job; do not loosen a gate to make
  one episode match (the margin and soft42 thresholds are measured, see `.claude/rules/skip-detection.md`).
- "Next-Up card appears / auto-advances too early" -> `src/nextUpGate.ts`. The card appearing at
  the ED start is intended; an advance before EOS means a countdown was put back into
  `NextUpCta.tsx`. A card raised well before the credits means `nextUpEnding` elected a wrong
  ending: the `[next-up] timing` line prints the elected ending's source and `[basis: level]`
  (the `[auraskip]` stamp line shows only the payload, so it never has an ending gathered while
  Endings is Off).
- "A skip only PROMPTS although its kind is on Auto" -> the `[auraskip]` stamp line prints each
  window's `hold`, its `[basis: level]` (every Risky window only prompts) and the theme match's
  per-kind state; `skipPromptOnlyReason` (`src/skipSource.ts`)
  words it in the AuraSkip menu and the prompt. Read "Layer 1's verdict holds the crowd" and "Crowd
  rows are checked against THIS file" before loosening any of them: each was measured against both
  corpora.
- "Skip windows missing" -> `aniskip.rs` / `publicmetadb.rs` / `introdb.rs`; `AURA_PUBLICMETADB_KEY`
  must be baked. IntroDB needs an IMDb (`tt`) root and a season/episode >= 1; DevConsole `[introdb]`
  logs which numbering matched (or every numbering that missed), a window dropped for not fitting
  the file's duration, and a lookup that missed the 5 s wait (`INTRODB_WAIT_MS`).
- "Skip markers off by tens of seconds on a later season of an anime" -> the AniSkip MAL id paired
  with the wrong episode. AniSkip timings belong to ONE MAL entry and its LOCAL episode, and a
  multi-season show's series-level ids (`detail.mal_id`, kitsu/anidb/anilist, the title search) all
  name the FIRST cour: Bleach TYBW S3E7 was stamped with part 1 ep 7's opening. The pipeline
  (`App.tsx`, "Step 0") now prefers the playing video's own pair from the addon (`mal_id` +
  `mal_episode` from AIOMetadata's `_malId` / `_malEpisode`, else `anilist_id` + `anilist_episode`),
  used only whole; for a tt-keyed season > 1 it NEVER falls back to series-level ids
  (`laterSeasonTt`), and the Fribb resolver uses the strict `lookup_mal_for_season`. Keep two
  numbers: MAL-local `episodeNum` for AniSkip, addon-season `seasonEpisodeNum` for PublicMetaDB
  (TMDB-keyed). Each AniSkip window carries `skip_ref` ("mal:episode"); the AuraSkip menu adopts
  it and shows vote arrows only on a matching window, because a vote goes to AniSkip by `skip_id`
  alone. DevConsole `[aniskip]` logs which step resolved the id.
- "No Seasons/Arcs toggle on an anime" -> `arcs.rs`. In order: `AURA_TMDB_KEY` baked (or a user key in
  the keyring), a resolvable TMDB id (`MetaDetail.tmdb_id`, else the `/find` by IMDb id), and a TMDB
  episode group of `type == 5` that clears the coverage bar. Most shows have no arcs at all: arcs are
  a property of long-running manga, so the toggle is *supposed* to be absent nearly everywhere.
  DevConsole `[arcs]` logs the grouping choice and the alignment score.
- "An arc says Filler but its episodes are not" (or vice versa) -> that label
  comes from TMDB's arc NAME and is unreliable; `arcKindSummary` derives it from
  Aura's own episode data instead. Check whether the show has any filler data at
  all first, since with none Aura deliberately falls back to TMDB's marker.
- "Arc shows the wrong episodes" / "arc is off by one" -> read `.claude/rules/story-arcs.md`. This is
  the failure the aligner exists to prevent; check the `[arcs]` min-score log before touching
  anything else.
- "Manga chapters missing" -> `manga_chapters.rs`, DevConsole `[manga]`. By grain: the detail line
  needs an anime series, a MangaUpdates series matched EXACTLY (MAL's "Adaptation" title first) and
  an `anime` field that parses; it is withheld on purpose when a part has started without an end
  (Bleach: TYBW part 4 at 661), and nothing is shown for a light-novel or original source. Arc
  ranges need the show in `arc_art.rs`'s wiki table, the arc resolved to its own page (`[arcs]`
  logs "pages for N"), and a closed range in that page's infobox (an ongoing arc has none). Episode
  hover chapters need an `episodes` entry for that wiki AND air dates on both sides: `[manga]` logs
  pages fetched, joined by air date, and with chapter data. A low join count means the addon's
  dates are off by more than a day; do NOT "fix" that with a number join.
- "Live Sync cue list is empty / will not scroll" -> `subsync.rs` for the cue source (bitmap PGS /
  VobSub tracks can never yield text and are a deliberate disabled state), and the non-passive wheel
  handler in the panel: the overlay's volume-wheel handler steals wheel events without it.
- "Subtitle download fails / path rejected" -> `subtitles.rs`; downloads must land in
  `app_data_dir()/subtitles` and `add_subtitle_to_mpv` enforces containment.
- "A Tailwind class has no effect" -> check the theme-scale gotchas (root CLAUDE.md); confirm against
  `dist/assets/index-*.css`.
- "Restore from minimize / tray has no animation" / "a tiny box flies to the corner" -> read the
  Update at the top of the restore section in `.claude/rules/windowing.md`: in order, a thread that owns a child window sleeping
  without a message wait, the main webview following the minimize resize, tao's iconic
  `WM_NCCALCSIZE`. Otherwise read that section BEFORE investigating, and note that the nearby restore-latency cost is
  not in Aura's code either. Instrument with `AURA_WIN_PROBE=1 pnpm tauri dev` (`wintiming` label).
- "Next Up / auto-advance plays a different source than the top of the switcher list" -> read the two
  stream-list invariants in `.claude/rules/streams.md`. In order: `sanitize_stream` emitting an unplayable entry,
  `fetch_streams` returning completion order, and `pickFirstStreamForEpisode` scoping its query
  differently from the switcher. All three are fixed; a recurrence means one was undone.
- "Library page blank" -> `<ErrorBoundary scope="Library">` surfaces the render error.
- "A Settings row or section is missing" (provider pickers, buffers, API keys, Storage, the whole
  System group) -> it is behind "Show advanced settings", under the Settings search box; searching
  for it reveals it without the switch. The Conventions entry on advanced rows has the rules.
- "A no-providers warning opens the wrong page" -> `emptyElectionCause` (`src/addonElection.ts`).
  It routes to Settings only when that job's override is in force and leaves out an installed addon
  that could do the job; otherwise to the Addons page (`aura:open-addons`), since Settings cannot
  fix a missing addon.
- "A download fails instantly at 0 bytes" -> the container refinement in
  `downloads/mod.rs::refine_extension`. It renames the partial, so the worker
  must use the paths it RETURNS, not its own clone of the job.
- "A download will not pause" / "the window will not close" -> a single-pass HLS
  job (`JobKind::HlsPassthrough`) cannot be paused. Everything that must reach
  `active_count() == 0` cancels those instead, and the quit prompt says so.
- "The downloaded file is corrupt in the middle" -> the resume validator in
  `downloads/http.rs`. A host with no `ETag` needs the tail-hash compare; a 206
  alone proves nothing about WHICH file answered.
- "A download sits Queued with nothing running" -> `manager::pump`. A collapsed
  pump request must be DEFERRED via `PUMP_AGAIN`, never dropped.
