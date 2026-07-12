# Story Arcs + Live Subtitle Sync - Design

Date: 2026-07-12
Status: approved, ready to implement

Two independent features, specced together because they were requested together. They share
no code. Story Arcs is the larger and riskier of the two.

---

## Feature 1: Story Arcs (anime episode-list grouping)

### Goal

A `Seasons | Arcs` toggle on the Detail page for anime. Arcs mode lists every known story arc
for the show, in air order, as cards with arc art, an episode count, a year range, and watched
progress. Clicking an arc shows only that arc's episodes. The player gains arc context so it
never contradicts the view you were just browsing in.

### Prior art

Harbor v0.9.21 shipped this. Its data source is TMDB's **Episode Groups** API, filtering to
groups whose numeric `type == 5` ("Story Arc"). It requires a user-supplied TMDB key, is off by
default, renders arcs as text-only rows in the season dropdown, and joins arcs to episodes on
raw `(season, episode)` pairs.

Aura diverges on four points, each for a reason established during research:

1. Aura bakes a default TMDB key (so the feature works out of the box).
2. Aura renders real arc cards with artwork, not text rows.
3. Aura lets the user pick between multiple arc groupings when a show has more than one.
4. **Aura does not join on `(season, episode)`.** That join is wrong (see below).

### The data source, and its verified coverage

`GET /3/tv/{tmdb_id}/episode_groups` -> pick a group -> `GET /3/tv/episode_group/{group_id}`.

Coverage was measured, not assumed: **32 of 44 probed popular anime have at least one group
typed "Story Arc"**, including One Piece, Naruto, Naruto Shippuden, Bleach, Dragon Ball (all
three), Hunter x Hunter, Attack on Titan, Demon Slayer, Jujutsu Kaisen, My Hero Academia, Fairy
Tail, Black Clover, FMA:B, Death Note, Gintama, JoJo, Boruto, Detective Conan, SAO, Re:Zero, Mob
Psycho, Chainsaw Man, Spy x Family, Frieren, Haikyu, Blue Lock, Dr. Stone, One-Punch Man, and
Code Geass.

Every other candidate source was investigated and rejected. AniList (schema introspected: 55
Media fields, no arc concept), MAL/Jikan, Kitsu, AniDB, Trakt, Simkl, Shikimori, and
AnimeThemes have no arc model at all. **animefillerlist has no arcs either** - its episode table
is exactly four columns (#, Title, Type, Airdate) - so the existing filler/recap pipeline cannot
be extended to carry arcs. No maintained multi-show arc dataset exists on GitHub.

### The join (this is the load-bearing part)

TMDB's season boundaries are not Cinemeta/TVDB's. One Piece is TMDB S1=61 episodes vs Cinemeta
S1=8. A per-season join is dead on arrival, and so is the obvious fallback of "convert both
sides to absolute episode numbers and match by index":

> TMDB promotes a Toriko/One Piece/DBZ crossover special into the main run at absolute 590.
> Cinemeta files the same episode as special S0E39. So TMDB abs N == Cinemeta abs N for N <= 589,
> and TMDB abs N == Cinemeta abs N-1 for N >= 591. A naive index join misplaces **579 of
> Cinemeta's 1168 One Piece episodes (49.6%)**: every arc from Punk Hazard onward starts and ends
> one episode late. It looks correct and is not. That is a worse outcome than not shipping.

Air date alone is not a key either (weekly shows have duplicate air dates: 40 of Naruto
Shippuden's dates carry two episodes; exact-date join resolves only 84% of Shippuden uniquely).
Title alone is not a key either (TVDB and TMDB use different English translations of the same
episode: "Shichibukai! Trafalgar Law" vs "The Warlord! Trafalgar Law"; two real pairs score 0.00
on bigram similarity).

**The join is a banded Needleman-Wunsch sequence alignment** of the two absolute-ordered main-run
lists. Both lists are in broadcast order, which is a hard constraint that defeats both the index
shift and the duplicate-date ambiguity.

```
score(tmdbEp, auraEp) = 0.55 * dateProximity + 0.45 * diceBigram(normalizedTitle)
  dateProximity: 1.0 <=1d, 0.9 <=3d, 0.75 <=7d, 0.4 <=14d, 0.1 <=35d, -0.5 beyond
  gap penalty:   -0.35
  band:          |i - j| <= 12
```

Measured on real data: **One Piece 1168/1168 correct** (the crossover is correctly isolated as a
single TMDB-only gap), **Naruto Shippuden 500/500 correct**, zero pairs below the 0.5 confidence
threshold on either show.

Rules that fall out of this and are non-negotiable:

- Derive absolute numbers from cumulative season episode counts. Do **not** assume TMDB's
  `episode_number` is already absolute (it happens to be for One Piece and Shippuden; that is a
  property of those shows, not of TMDB).
- Ignore season 0 on both sides. Specials counts diverge wildly (One Piece: 63 vs 39) and are not
  joinable. If an arc references a season-0 episode, drop that member.
- Never hardcode the +1 shift. It is one TMDB editorial decision and it will change.
- Emit a per-pair confidence. If any member of an arc scores below 0.5, **drop the arc and log
  it** under `[arcs]`. Fail visible, never fail off-by-one.

### Grouping selection

Shows commonly have several Story-Arc-typed groups. One Piece has four ("Story Arc" = 55
fine-grained arcs, "Sagas" = 12 broad ones, "Arcs (Official)" = 21 but only 1116/1202 episodes,
and a combo). Naruto has "Story Arcs with Filler" (24) and "Manga Story Arcs" (5, canon-only).
Some groups are air-order splits that an uploader mis-typed as Story Arc (Naruto Shippuden has a
"TVDB Order" and a "Wikipedia Order" both typed Story Arc).

Selection is a score, not `max(group_count)`:

- Reject `group_count <= 1`.
- Require episode coverage >= 0.85 of the show's main run; prefer higher.
- Penalise names matching `/order|tvdb|wikipedia|air date|^seasons?$/i` (mis-typed air-order splits).
- Among survivors, prefer the higher `group_count` (finer arcs).

All viable candidates are returned, so the UI can offer a grouping switcher. The user's choice is
remembered per series.

### Arc artwork

TMDB episode groups carry no arc image. Art comes from Fandom, which is the only source with
genuine arc key art (verified 1920x1080 PNGs via the MediaWiki `imageinfo`/`pageimages` API).

- A curated static `imdb_id -> { wiki_host, arc_category }` table, ~30 entries. This is not a
  limitation in practice: ~30 shows is approximately the entire universe of anime that *has*
  arcs.
- `action=query&list=categorymembers` to enumerate arc pages, `prop=pageimages&piprop=original`
  for the lead image.
- Fuzzy-match the TMDB arc name to the Fandom page title (Fandom: "Arabasta Arc"; TMDB:
  "Alabasta"). Normalise (lowercase, strip "arc"/"saga", alnum-only), require bigram similarity
  >= 0.6.
- 30-day disk cache, bounded.
- **Fallback when there is no wiki or no name match**: the `thumbnail` of an episode inside the
  arc, which Aura already has in the meta. Costs nothing and always produces a card.
- Route every arc image through the existing `img_proxy` (`/img?url=&w=`) for resize + SSRF guard
  + disk cache, per the standing image-memory directive.
- Attribution: Fandom images are CC-BY-SA (credit line in the arcs view). TMDB requires its own
  attribution notice ("This product uses the TMDB API but is not endorsed or certified by TMDB")
  in About/Settings.

### Year range

Each arc card shows the release-year span of its member episodes, derived from the Aura-side
`VideoEntry.released` values after the join (never from TMDB's dates, so it always agrees with
what the episode rows show). Single year renders as `2001`; a span renders as `2001-2002`.
Episodes with no `released` are ignored; an arc with no dated episodes shows no year chip.

### Key management

`AURA_TMDB_KEY` baked by `build.rs` from `.env.local`, identical to `AURA_MDBLIST_KEY` /
`AURA_PUBLICMETADB_KEY`. Empty key -> the feature no-ops entirely (no toggle rendered, no
network). An optional user-supplied key in the existing `api_keyring` takes precedence.

### TMDB id resolution

`MetaDetail.tmdb_id` first; else `publicmetadb::resolve_anime_tmdb_id(source, id)` (already
exists, resolves kitsu/anidb/anilist -> TMDB via yuna.moe); else `/3/find/{imdb_id}
?external_source=imdb_id`. No id -> no arcs, silently.

### Frontend

- `src/storyArcs.ts` - types, the `useStoryArcs(detail, seriesId)` hook, a bounded
  `persistentCache` layer (24h TTL), and `arcForEpisode(arcs, episodeId)`.
- `src/views/DetailView.tsx` `EpisodesPanel` - a `EpisodeGrouping = "seasons" | "arcs"` axis
  orthogonal to the existing `PanelMode`. Segmented toggle in the panel header, mirroring
  `LiveView`'s `ViewModeToggle`. Rendered only when `isAnimeMeta(detail) && arcs.length > 0`.
- `src/ArcGrid.tsx` - the arc cards (16:9 art, name, `N episodes`, year range, watched-progress
  bar, filler/canon breakdown reusing `countEpisodeKinds`). Clicking swaps the panel to that
  arc's episodes, filtered by `arc.episode_ids`, with a back-to-arcs breadcrumb. `EpisodeRow` is
  reused unchanged.
- Grouping switcher rendered only when more than one viable grouping exists.
- Mode persisted per series in a bounded (cap 200, LRU) localStorage map `aura:arc-mode:v1`.

### Player integration

`nextUp.ts::findNextEpisode` is the single walker every player surface funnels through, so arc
context is cheap:

- When the current episode is the last of its arc, `NextUpCta` and `EosSpotlight` render an arc
  line ("Alabasta complete - next arc: Sky Island").
- Auto-advance behaviour is unchanged: the countdown still rolls into the next arc.
- Arc data at playback time is read from the same bounded cache. A cache miss is silent - arc
  context is decoration and must never block or delay playback.

### Explicit non-goals

- **Continue Watching tiles, the segmented season bar, and episodes-behind stay season-based.**
  Making them arc-aware means refactoring `CinemaRows::resolveCwProgress`, which is a *second*,
  independent next-up implementation that does not even honour the existing
  `nextUpSkipFillerRecap` setting. That refactor is worth doing and is its own project.
- Non-anime series. The toggle is gated on `isAnimeMeta`.
- Arc-boundary auto-advance stops.

---

## Feature 2: Live Subtitle Sync

### Goal

In-player panel: a searchable list of the subtitle lines around the current position. Click the
line you just heard; Aura computes and applies the subtitle delay. Plus a two-point mode that
also fixes framerate drift.

### Prior art

Stremio's supporter-tier feature (reverse-engineered from the shipped web bundle, since it is not
in the open-source repo). Their math is `delay_ms = videoTime_ms - cue.endTime_ms`, over a
+/-5-minute cue window recomputed on every time update, with 0.25s trim buttons and a
`${(ms/1000).toFixed(2)}s` readout.

**It only works on external/addon subtitles.** Embedded subs get a disabled delay stepper; the
complaint is open and unanswered. Architecturally they cannot fix it: they render external subs
as an HTML overlay in JS (so they have the cue list) and embedded subs via mpv (so they do not).

Aura renders everything through mpv, so one `sub-delay` write covers embedded, addon, and local
subs identically. We just need the cue list.

### Two things Aura deliberately does differently

1. **The anchor is frozen.** Stremio measures against the *live* playhead at click time, so the
   seconds you spend finding the line are baked into the correction as error. Aura pauses on open
   and anchors there: `delay = anchor - cue.end`. Take as long as you like.
2. **Two-point sync.** A constant offset cannot fix subtitles that are right at the start and
   wrong at the end (an open Stremio complaint). mpv has `sub-speed`. Sync one line early and one
   late, solve for both:
   ```
   speed = (t2 - t1) / (cue2.end - cue1.end)
   delay = t1 - speed * cue1.end
   ```

### Rust

- **`get_tracks` gains `external-filename`** (`track-list/N/external-filename`, `GetFormat::String`,
  the same code path as `title`/`lang`/`codec`). This is the missing piece that makes "which file
  or URL backs this track?" answerable. Today an OpenSubtitles-downloaded track's path is thrown
  away at `SubtitlePicker.tsx:157` and is unrecoverable.
- **`subsync.rs`**:
  - `parse_subtitle_cues(source)` - SRT + WebVTT + ASS/SSA. Source is a local path (containment-
    checked against `app_data_dir()/subtitles`, same guard as `add_subtitle_to_mpv`) or an https
    URL (reqwest, `https_only`, size-capped). There is no format normalisation anywhere in the
    existing pipeline - `subtitles.rs` writes whatever the server sent - so assuming `.srt` will
    break on real files.
  - `extract_embedded_cues(stream_url, track, around, window)` - windowed ffmpeg:
    `-protocol_whitelist http,https,tcp,tls,crypto -ss <t-150> -copyts -i <url> -t 300
    -map 0:s:<idx> -f srt -`, `creation_flags(CREATE_NO_WINDOW)`. Modelled directly on
    `silencedetect.rs`, including the protocol whitelist (a hardening that must not be reverted).
    ffmpeg is an on-demand runtime dep; absent -> embedded tier ships inert.
    **A full-file extraction on a remote 20GB mkv would take minutes. The window is mandatory,
    and it is also the correct UX** - the user needs +/-2 minutes of cues, not the episode.
  - ffprobe maps mpv's sub track id to ffmpeg's subtitle-relative stream index (they usually
    coincide; they are not guaranteed to).
- `set_subtitle_speed(speed)` -> typed `sub-speed` write, clamped.
- `set_subtitle_delay` clamp widened from +/-10s to +/-120s (real desyncs exceed 10s; Stremio's
  own screenshot shows -9.91s, right at our old limit).
- Registration: `lib.rs` `generate_handler!` + the existing `allow-player-controls` block in
  `permissions/player.toml`. `capabilities/default.json` needs no edit (it lists permission
  identifiers, not commands).

### Frontend

`src/SubtitleSyncPanel.tsx`, following PlayerOverlay's Pattern B (the `SubtitlePicker` shape):
mounted as a sibling inside the `MenuTrackerCtx` provider, `open`/`onClose` props, returns null
when closed. Opened from a "Live sync" button on the subtitle TrackMenu's existing delay row
(where a user already goes to fix timing) and from MoreMenu.

- On open: pause, capture `anchor = currentTime`.
- Resolve the active sub track from `tracks`. Bitmap codecs (`hdmv_pgs_subtitle`, `dvd_subtitle`)
  are a **first-class disabled state** with an explicit reason, not a silent failure - they are
  common on remuxes, which is exactly what Aura plays.
- Cue list: external -> `parse_subtitle_cues(external-filename)`. Embedded -> `extract_embedded_cues`.
- Render: delay readout + `-`/`+` 0.25s + Reset; search box (case-insensitive substring, Enter
  cycles matches); scrollable cue list windowed to +/-5 min around the anchor, auto-centred on the
  cue that was playing at the anchor.
- **The list must install the non-passive wheel handler from `TrackMenu` (PlayerOverlay.tsx:3440).**
  Without it the overlay's volume-wheel handler steals the scroll and the list cannot be scrolled.
  This is the single most likely bug in the feature.
- Click a line -> `setSubDelay(anchor - cue.end)` + `invoke("set_subtitle_delay")`. Because
  `subDelay` already lives in PlayerOverlay scope, the existing subtitle-dropdown delay row
  reflects the new value for free.
- Two-point: after an offset is applied, a "still drifting?" affordance captures a second anchor
  later in the episode and solves for `sub-speed` + `sub-delay`.

### Memory

Cue lists are bounded by construction (a +/-5-minute window, hard cap 2000 cues) and dropped on
panel close and on file change. `sub-delay` and `sub-speed` are both reset on `loadfile`.

### Persistence

**Session-only.** A subtitle delay is a property of the *release*, not the title. `per_title.rs`
is keyed `{media_type}:{id}` and auto-syncs to the cloud, so persisting there would re-apply a
wrong delay to a different release after a source switch and propagate it across devices. This
matches the existing, deliberate treatment of playback speed and the video EQ.

---

## Runtime verification required before these can be trusted

Neither `cargo check` nor `tsc` can catch these. They are spikes, not assumptions:

1. **TMDB episode-group payload shape** - does `/3/tv/episode_group/{id}` return per-episode
   `name` + `air_date`? If yes, the alignment needs one request instead of re-fetching every
   season. Requires a TMDB key. Code must handle both shapes.
2. **mpv `sub-speed` semantics** - the exact multiplication direction, and how it composes with
   `sub-delay`. The two-point math depends on it. Verify empirically against a known file before
   trusting the solved values.
3. **ffmpeg windowed subtitle extraction against a real debrid HTTPS stream** - that `-ss` +
   byte-range seeking behaves, and how long it takes.
4. **Arc coverage against Aura's real meta addon (AIOMetadata), not Cinemeta.** The alignment was
   validated against Cinemeta's episode lists. AIOMetadata's may differ.

## Blocking input

A free TMDB API key (themoviedb.org/settings/api) in `.env.local` as `AURA_TMDB_KEY=...`. Until
then the Arcs feature builds and ships inert.
