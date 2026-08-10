# Anime theme songs, the Tenrai migration, and the Spoilers section

Date: 2026-08-09
Status: approved, ready to implement

One combined spec covering six pieces of work that share a data source and a settings
section. They are specified together because five of the six depend on the same MAL
payload and the same MAL id resolution, and splitting them would mean plumbing the same
data three times.

## Why this is one spec

Everything below hangs off a single fact: `ratings.rs:259` already issues
`GET /anime/{mal}/full` on every anime detail open and every catalog hover, and
`JikanFullData` (`ratings.rs:242-251`) deserialises five fields and discards the rest.
The `theme` object carrying openings and endings is in that response today. So the
theme-song feature is a struct field plus a parser, not a new integration.

The second shared fact: at playback time `App.tsx` already resolves a cour-correct MAL id
(`resolve_mal_for_aniskip`, App.tsx:2903-2922) and a MAL-local episode number
(App.tsx:2994 and below), because AniSkip cannot work without both. MAL theme episode
ranges are expressed in exactly that numbering. The join that would otherwise be the
riskiest part of this work is therefore a lookup against a key the app already has to get
right, and is not the class of problem `arc_align.rs` exists to solve.

## Item 0: Jikan to Tenrai migration (required)

Jikan is shutting down permanently within roughly two months, so this is not an optional
retarget. Aura has exactly two call sites:

- `ratings.rs:45`, `const JIKAN_API: &str = "https://api.jikan.moe/v4"`
- `aniskip.rs:971`, an inline literal `"https://api.jikan.moe/v4/anime"`

Verified live against `https://api.tenrai.org/v1/anime/21/full`: Tenrai returns the
identical Jikan v4 envelope (`{data: {...}}`) with the same field names, including
`score`, `rank`, `popularity` and `theme`. The base path is `/v1`, not `/v4`.

Rate limits are strictly better than Jikan's 3/s and 60/min:

| Tier | Limits |
|------|--------|
| Public (no key) | 4 req/s, 120/min, 40k/day |
| `X-Server-Key` (Patreon) | 5 req/s, 300/min, unlimited daily |

The server key is deliberately out of scope. Public limits are comfortable for Aura's
usage and `api_keyring::SUPPORTED_KEYS` is its natural home if that ever changes.

### Design

New module `src-tauri/src/tenrai.rs`, owning:

- `const TENRAI_API: &str = "https://api.tenrai.org/v1"`, the single source of truth,
  which also removes the inline literal in `aniskip.rs`.
- A bounded cache of the parsed `/anime/{id}/full` payload.

A module rather than a const swap because `/full` is currently fetched, mostly discarded,
and re-fetched per surface. One cached call now serves ratings and themes. Cache follows
the existing `aniskip.rs` shape: capped entries, positives long-lived, negatives short.

### Risk

The title-search resolver moves hosts at the same time. If Tenrai's `/anime?q=` ranking
differs from Jikan's, resolver behaviour changes. This lands in the same change as the
resolver hardening in item 4 so there is one behaviour delta to reason about rather than
two overlapping ones.

## Item 1: Theme songs

### The parser

New `src-tauri/src/theme_parse.rs`, with `#[cfg(test)]` tests in the manner of
`arc_align.rs`.

Real strings from the live API, which is where every rule below comes from:

```
1: "We Are! (ウィーアー!)" by Hiroshi Kitadani (きただにひろし) (eps 1-47,1000)
1: "memories" by Maki Otsuki (大槻真希) (eps 1-30,808,968)
2: "Believe" by Folder5 (eps 48-115)
```

Output shape:

```rust
struct AnimeTheme {
    index:    Option<u32>,
    title:    Option<String>,
    artist:   Option<String>,
    episodes: Vec<EpisodeSpan>,  // EMPTY means unknown, never "all"
    raw:      String,            // always retained
}
struct EpisodeSpan { start: u32, end: u32 }  // singleton has start == end
```

Rules:

1. Anchor the episode range on the literal `(eps ` at end of string. Never on "the last
   parenthetical": both the title (`"We Are! (ウィーアー!)"`) and the artist
   (`Hiroshi Kitadani (きただにひろし)`) contain parentheses.
2. Ranges are comma-separated disjoint lists. `1-47,1000` is two spans, not one. A naive
   start-to-end read would claim One Piece OP1 covers episodes 1 through 1000 and
   mislabel roughly 950 episodes, which is exactly the failure mode the project's
   "a wrong value is worse than an empty field" rule targets.
3. Any malformed token discards the entire span list rather than partially trusting it.
4. A missing `(eps ...)` suffix is legitimate and common, and yields empty spans.
5. `raw` is always retained so the UI can render something truthful when structure fails.

### 1a: Skip prompt

`aniskip::PreparedWindow` (aniskip.rs:1065-1079) gains two `Option<String>` fields with
`skip_serializing_if = "Option::is_none"`, following the existing `skip_id` precedent.
This also keeps the mpv payload clean, since `skip-windows.lua:118-132` copies known
fields only and ignores unknown keys.

Stamping happens inside `App.tsx`'s existing single `set_skip_windows` pass, using the
cour-correct MAL id and MAL-local episode it already computes for AniSkip.

**Fail-visible rule.** Song text is attached only when all of the following hold: the
theme's spans are non-empty, the current episode falls inside one of them, and exactly one
theme of that kind matches. Empty spans, zero matches, or multiple matches all fall back
to the existing generic label. Naming the wrong song is worse than naming none.

Copy keeps `Skip Opening` as the first line, since that is the affordance users scan for,
with the song rendered smaller and dimmer beneath it.

Two landmines:

- `SkipPromptToast` (PlayerOverlay.tsx:4456-4484) is fixed-position with no width cap, and
  named `max-w-*` tokens emit no CSS in this project because `tailwind.config.ts` replaces
  the `maxWidth` scale. It needs an arbitrary value plus truncation.
- `aura-toast-pop` (App.css:1412-1415) applies a `translate(-50%)` intended for the centre
  toast to a left-anchored element, so the prompt snaps sideways for 220ms. Widening it
  makes that visible. Fix with a dedicated keyframe rather than pinning the width.

### 1b: Scrubber hover

The band hover card (PlayerOverlay.tsx:3289-3310) reads the same field already present on
the window object, so there is no new plumbing. That popover has no viewport clamping
(only `left:${pct}%` plus `translateX(-50%)`), so a long song title overflows at the track
ends and needs a clamp.

### 1c: Detail list

Lives in the overlay (item 3), grouped by cour. Episode ranges blur behind
`blurThemeEpisodeRanges`; title and artist never blur. The song name is not the spoiler,
"this one only runs to episode 14" is.

## Item 2: Spoilers settings section

The section currently titled "Detail Page" (`SettingsView.tsx:4931`) already contains only
spoiler toggles (`hideCastSpoilers`, `blurUnwatchedThumbnails`, `blurEpisodeSynopsis`), and
the Next Up thumbnail blur from `ac17268` reuses `blurUnwatchedThumbnails` rather than
adding a key. The rename is a pure correction of a misnomer with nothing to absorb.

Rename `sec-detail-page` to `sec-spoilers` together with its `TOC_GROUPS` entry
(SettingsView.tsx:3306).

Two new keys, both defaulting to `false`, matching the opt-in convention of the three
existing toggles:

| Key | Meaning when on |
|-----|-----------------|
| `blurThemeEpisodeRanges` | Episode ranges in the theme list blur until clicked |
| `arcAwareArt` | CW tiles and the detail hero use arc key art matching your progress |

Note the polarity difference: the three existing toggles add protection when on, while
`arcAwareArt` adds spoiler exposure when on. The section still coheres read as "settings
that govern spoiler exposure" in both directions, and the description carries the warning.

Each key needs an explicit `typeof parsed.x === "boolean"` clause in `readFromStorage`
(auraSettings.ts:299-408), because the `...parsed` spread at the top otherwise lets a
corrupt localStorage value through untyped. Each also needs an entry in
`PORTABLE_AURA_FIELDS` (settingsTransfer.ts:112-135) or it silently vanishes from both
export and import. Cloud sync is automatic, since `readSettingsBlob` pushes the whole
object.

A fourth predicate joins `episodeSpoilers.ts` so every spoiler surface shares one rule.

## Item 3: The More info overlay

New `src/AnimeExtrasOverlay.tsx`, triggered from the hero action bar
(DetailView.tsx:1351-1372), which has exactly two children and an empty middle slot.

**Structural constraint.** DetailView's `z-[60]` root carries a transform, so every
`position: fixed` descendant positions against the root rather than the viewport. The
existing `CatalogPopup` and `DayOverlay` are `z-[55]` and would render underneath. The
overlay therefore uses the `SubtitlePicker.tsx:168-195` absolute-inside-a-positioned-
ancestor pattern, which is proven in-repo and avoids a portal and z-index arms race.

Tabs:

| Tab | Source | Notes |
|-----|--------|-------|
| Songs | `/anime/{id}/full` `theme` | Cour-grouped union, ranges spoiler-gated |
| Ratings | `/anime/{id}/statistics` | 10-bucket histogram plus status counts |
| Staff | `/anime/{id}/staff` | Filtered to Director, Series Composition, Music, Character Design. 491 raw rows for FMA:B is unusable, and anime `director`/`writers` render empty today |
| Related | `/anime/{id}/recommendations` | Vote-weighted, capped, routed into existing catalog navigation |
| Trailers | `/anime/{id}/videos` `promo` | Cour-grouped, deduped by `youtube_id`, plays through the existing yt-dlp path |

`music_videos` was investigated and rejected: it is empty on both One Piece (21) and
Frieren (52991), so a feature built on it would render nothing on the two most obvious
test cases.

Promo entries genuinely duplicate `youtube_id` across differently-titled rows
("Main Trailer" and "PV 5" share an id on Frieren), so dedup is required rather than
defensive.

**Fetching.** Each tab fetches on first open *of that tab*, not on overlay open, so
opening for the histogram never costs a staff request.

**Storage.** One `persistentCache` instance, 7-day TTL (this data is near-static), capped,
with a row in `StorageReport.tsx` so it is visible and clearable.

Explicitly **not** on `MetaDetail`. `metaCache` holds up to 800 entries at roughly 1.5 MB
and is read by catalog hover, Calendar, Continue Watching and the 30-minute notification
scanner. Anything added there is multiplied by 800 and paid on surfaces that never render
it, which is the single most expensive place in the app to add data.

### Cour scope

`detail.mal_id` is the series root, so on its own it would silently show only cour 1's
songs for a split-cour show. On overlay open, resolve a MAL id per season via the existing
`resolve_mal_for_aniskip`, dedup by resolved id (One Piece's many Cinemeta seasons collapse
to one MAL entry), fetch each unique entry, and render grouped with a cour heading.

### Registration

`capabilities/default.json` lists permission identifiers rather than command names, so
adding new commands to an existing group in `permissions/player.toml` makes this a two-file
change rather than three.

## Item 4: Hover vs detail ratings mismatch

### Root cause

`CatalogHoverCard.tsx:242-244` early-returns on a session cache keyed only on `meta.id`.
The first ratings fire happens while `detail` is still `null` (the meta fetch at :194-230
is async), but `isAnime` is already true from the surface id or `media_type` alone
(:246-249). So the request carries `mal_id`, `kitsu_id` and `anidb_id` all null, and
`ratings.rs:429-434` falls through to the last-resort title search. That resolver
(`aniskip.rs:1027-1044`) requires an exact title match, then tie-breaks toward the year
hint and toward low MAL ids, which deterministically elects the franchise-root entry. The
wrong answer is cached, and the effect that re-fires once real ids land (deps :281-282)
never refetches.

DetailView has the identical race but always refetches and overwrites (:948-951, :968), so
it converges on the correct entry.

The reported symptom fingerprints this exactly: MDB 7.7 and 80% match on both surfaces
because they derive from `imdb_id`, while all four MAL and AniList chips differ because
they all derive from one mis-resolved MAL id (`ratings.rs:438`). That the MDB values match
also rules out a wholesale bleed from a previously hovered card.

Not yet runtime-confirmed. F12 settles it: hover logs
`resolve_mal_id_by_title ... -> Some(N1)`, opening logs `resolve_mal_id kitsu=... -> Some(N2)`.

### Fix

Frontend, `CatalogHoverCard.tsx`:

- Gate the ratings effect until the meta-detail effect has settled for this `meta.id`. This
  removes the wrong request rather than correcting it afterwards, and saves a search
  request per hover.
- Key the session cache on the ids the answer was computed from, not on `meta.id` alone,
  and drop the unconditional early return.
- Stop caching empty arrays. `[]` is truthy, so an empty first result currently pins
  "no ratings" for the whole session.
- Reset `aggRatings` before the early return at :261, so a card cannot display the
  previous card's chips.
- Put id material into the `dedupedInvoke` key (:262-265), which carries none today.
- Align the metadata-addon election with DetailView. Hover puts the user's pinned default
  first (:199-211) while DetailView puts AIOMetadata first (DetailView.tsx:738-745), and
  hover flips `media_type` (:216-219) while DetailView does not. That is an independent,
  deterministic second route to divergence for anyone not pinned to AIOMetadata.

Backend, `aniskip.rs`:

- Drop the `(50_000 - mal_id) / 5_000` low-id tiebreak, which is what elects franchise
  roots.
- Require the year hint to agree when one is supplied, rather than merely bonusing it.
- Include the year in `MAL_RESOLVE_CACHE`'s key (:947 omits it, so one title caches one
  answer across all years).
- Log the election so the DevConsole shows what was picked and why.

The title fallback is retained rather than suppressed. Suppressing it is the stricter
reading of the project's own rule, but it would silently remove MAL and AniList ratings
from every user whose metadata addon does not stamp `_malId`, which is a visible
regression for Cinemeta-pinned setups.

## Item 5: Arc-aware art

Engages only when `image_source === "fandom"`. Outside the curated table, `arc.image` is a
TMDB episode still or an addon thumbnail, and using a random frame would replace good
landscape art with something worse.

- **CW tiles.** `CinemaRows.tsx` `ContinueWatchingCard` (696-934). `useCwDetail` (429-464)
  already fetches a `MetaDetail` with videos and `tmdb_id` per card, which is exactly
  `fetchStoryArcs`' input. Resume pointer goes through `arcPositionOf` to an arc to
  `arc.image`. The caller must re-apply the `isAnimeMeta` and `storyArcsAvailable` gates
  that `useStoryArcs` applies but `fetchStoryArcs` does not.
- **Detail hero.** Warm-seed from the cached `aura:story-arcs` blob inside `seedHeroArt`,
  so the write-once latch invariant holds with no added delay for the large majority of
  shows that have no arcs. First open shows normal art; arc art appears from the second
  visit. This is deliberate: the alternative gates the hero reveal on a TMDB round-trip for
  every anime.
- **`shrinkPoster` is mandatory.** Fandom lead images are 1920x1080 masters. CW's 16:9
  loader (826-838) is not shrunk today, so fixing that is a free RAM win regardless.

This reverses the story-arcs spec's explicit CW non-goal
(`2026-07-12-story-arcs-and-live-subtitle-sync-design.md:181-184`).

### Attribution

`ArcGrid.tsx:366-369` renders "Arc artwork from Fandom, licensed CC BY-SA.", gated at :332
on Fandom art actually being used. Moving that art to a CW tile or a hero backdrop puts it
on surfaces with no footer. Resolution: one app-wide attribution line in Settings' About
area alongside the existing TMDB notice, with `ArcGrid` keeping its contextual line.

### WIKI_BY_TMDB expansion

The table is a routing table, not a curation of taste: TMDB episode groups carry no
images, Fandom is the only source of real arc key art, and no reliable id-to-wiki mapping
exists. Its 31 entries are already approximately the set of anime that has arcs at all,
since arcs are a property of long-running manga rather than of anime generally, and that
same set is what TMDB has type-5 groups for.

Expansion is therefore a verification pass, not authorship. Each candidate must clear four
gates:

1. TMDB tv id resolved via TMDB search, never from memory.
2. TMDB actually has a type-5 episode group clearing the coverage bar. Without this, arcs
   never render and the art is moot.
3. The Fandom host resolves.
4. One of `CATEGORY_CANDIDATES` yields members on that host.

Only survivors get a line. Candidates: Vinland Saga, Tokyo Ghoul, Seven Deadly Sins, Fire
Force, The Promised Neverland, Made in Abyss, Yu Yu Hakusho, Inuyasha, Rurouni Kenshin,
Soul Eater, Magi, Katekyo Hitman Reborn!, Shaman King, Food Wars, Assassination Classroom,
Kingdom, Golden Kamuy, Mushoku Tensei, Solo Leveling, Tokyo Revengers, Oshi no Ko,
Overlord, D.Gray-man, Claymore, Monster, Berserk, Beastars, Parasyte, Toriko, Ranking of
Kings, Sakamoto Days, Wind Breaker, Dandadan, Hell's Paradise. Plus one gap in the current
table: Fullmetal Alchemist (2003) is absent while Brotherhood is present, and
`fma.fandom.com` covers both.

Expect a meaningful fraction to fail gate 2.

## Project rules that apply

- Bounded caches. Every new cache needs a cap and a TTL or eviction; every localStorage
  blob needs a `StorageReport` row.
- `metaCache` bloat, as above. Nothing from this spec goes onto `MetaDetail` except the
  theme payload, and only if it proves necessary.
- Settings portability. New keys need `PORTABLE_AURA_FIELDS` entries and explicit
  validation clauses.
- Tailwind: the `maxWidth` scale is replaced, so named `max-w-*` tokens emit nothing. The
  `opacity` scale is extended, so off-5-step modifiers emit nothing unless registered.
- No polling during mpv state transitions. Song metadata rides the existing
  `aura:skip-windows` event, never a poll, never a new observed property.
- Never block the engine thread. No network lookup for theme metadata may run there.
- Serde direction: `rename(deserialize = "...")` only, never a bidirectional rename.
- Three TS mirrors of the skip window must change together: App.tsx:219-225,
  PlayerOverlay.tsx:4341-4351, AniSkipMenu.tsx:36-43. The last is deliberately duplicated
  to avoid a circular import and must not be "fixed".
- No em-dashes or en-dashes anywhere, including code comments and UI copy.
- The working tree carries roughly 344 uncommitted lines implementing the hero-art
  write-once latch across `App.css`, `ImageLoader.tsx` and `DetailView.tsx`. Plan against
  the working tree, not HEAD, and do not violate the latch invariant.

## Verification

```
cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit
```

Plus `cargo test` for `theme_parse`. There are no runtime tests; runtime confirmation of
the ratings fix is the DevConsole check described in item 4.

## Sequencing

1. Tenrai migration and the shared `/full` cache (everything else reads through it, and
   the shutdown clock makes it urgent).
2. `theme_parse.rs` and its tests.
3. Ratings fix (independent, shippable on its own, shares the resolver touched in 1).
4. Spoilers rename and the two toggles (prerequisite for 5 and 7).
5. The overlay and its tabs.
6. Skip prompt and scrubber hover.
7. Arc-aware art, then the `WIKI_BY_TMDB` verification pass.
