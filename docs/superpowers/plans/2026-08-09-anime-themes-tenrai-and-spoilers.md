# Anime Themes, Tenrai Migration, and Spoilers Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Aura off the shutting-down Jikan API to Tenrai, surface MAL theme-song metadata in the skip prompt, scrubber and a new anime extras overlay, rename the detail-page settings section to Spoilers with two new toggles, fix the hover-vs-detail ratings mismatch, and make Continue Watching and detail hero art arc-aware.

**Architecture:** A new `tenrai.rs` module owns the API base and a bounded cache of `/anime/{id}/full`, so the payload Aura already fetches for ratings also serves theme songs at zero extra cost. A new `theme_parse.rs` turns MAL's display strings into structured spans with strict fail-visible semantics. Theme text rides the existing `aura:skip-windows` event onto the player using the cour-correct MAL id and MAL-local episode number App.tsx already computes for AniSkip. Everything else lives behind an on-demand overlay so nothing inflates `metaCache`.

**Tech Stack:** Rust (reqwest 0.12 rustls, serde, tokio), React 19 + TypeScript, Tailwind, Tauri 2.

## Global Constraints

- **No em-dashes or en-dashes anywhere.** Code comments, UI copy, commit messages, prose. Use a hyphen, colon, parentheses, or a sentence break.
- **Verification gate:** `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`. There is no ESLint, no Prettier, and no TS test runner. Rust tests run with `cargo test`.
- **A `.claude` hook (`verify.cjs`) runs `tsc` after every Edit.** Expect it to fire.
- **Bounded caches.** Every new cache needs a cap plus a TTL or eviction. Every new localStorage key needs a row in `src/StorageReport.tsx` (66-132).
- **Nothing new goes on `MetaDetail`** except the theme payload. `metaCache` holds up to 800 entries read by catalog hover, Calendar, CW and the notification scanner.
- **Serde direction:** use `#[serde(rename(deserialize = "..."))]` only. A bidirectional `rename` also renames outgoing Tauri JSON and leaves React reading `undefined`.
- **Tailwind:** the `maxWidth` scale is REPLACED, so `max-w-md` / `max-w-6xl` and every other named token emit no CSS. Use arbitrary values like `max-w-[420px]`. The `opacity` scale is EXTENDED with `2 3 4 6 8 12 14 16 18 72 82 92 93 96 97 98`; any other off-5-step modifier emits nothing.
- **Three TS mirrors of the skip window must change together:** `src/App.tsx:219-225`, `src/PlayerOverlay.tsx:4341-4351`, `src/AniSkipMenu.tsx:36-43`. The last is deliberately duplicated to avoid a circular import. Do not "fix" it by importing.
- **New Tauri commands** need `src-tauri/src/lib.rs` `generate_handler!`, plus `src-tauri/permissions/player.toml` `commands.allow`. `capabilities/default.json` lists permission identifiers, not command names, so adding to an existing group makes this a two-file change.
- **Never block the mpv engine thread.** No network call for theme metadata may run there.
- **No new mpv observed properties and no `get_property` polling.** Song metadata rides the existing `aura:skip-windows` event.
- **The working tree is dirty on purpose.** `src/App.css`, `src/ImageLoader.tsx` and `src/views/DetailView.tsx` carry the uncommitted hero-art write-once latch. Plan against the working tree, not HEAD, and do not violate the latch's write-once invariant.
- **https_only(true)** is mandatory for any new host. No plaintext-HTTP fallback.

---

## File Structure

**Create:**
- `src-tauri/src/tenrai.rs` - API base const, bounded `/anime/{id}/full` cache, extras endpoints (statistics, staff, recommendations, videos), and the Tauri commands the overlay calls.
- `src-tauri/src/theme_parse.rs` - MAL theme display-string parser plus unit tests. Pure, no I/O, no network.
- `src/AnimeExtrasOverlay.tsx` - the five-tab overlay.
- `src/animeExtras.ts` - frontend types, the per-tab cache, and the invoke wrappers.

**Modify:**
- `src-tauri/src/ratings.rs` - drop `JIKAN_API`, read through `tenrai::anime_full`.
- `src-tauri/src/aniskip.rs` - Tenrai base, resolver hardening, `PreparedWindow` song fields.
- `src-tauri/src/lib.rs` - module declarations and command registration.
- `src-tauri/permissions/player.toml` - new commands.
- `src-tauri/src/arc_art.rs` - `WIKI_BY_TMDB` expansion.
- `src/types.ts` - `AnimeTheme` and the `MetaDetail` mirror.
- `src/App.tsx` - `PreparedWindow` mirror plus the theme stamp in the `set_skip_windows` pass.
- `src/PlayerOverlay.tsx` - window mirror, prompt copy, scrubber hover card.
- `src/AniSkipMenu.tsx` - local window mirror.
- `src/App.css` - dedicated skip-toast keyframe.
- `src/auraSettings.ts`, `src/settingsTransfer.ts`, `src/views/SettingsView.tsx` - the two toggles, the section rename, the attribution line.
- `src/episodeSpoilers.ts` - fourth shared predicate.
- `src/CatalogHoverCard.tsx` - the ratings fix.
- `src/views/DetailView.tsx` - overlay trigger, hero arc warm seed.
- `src/CinemaRows.tsx` - CW tile arc art plus `shrinkPoster`.
- `src/StorageReport.tsx` - row for the extras cache.

---

## Task 1: Tenrai module and migration

**Files:**
- Create: `src-tauri/src/tenrai.rs`
- Modify: `src-tauri/src/ratings.rs:45` (const), `:242-315` (`jikan_for_mal_id`)
- Modify: `src-tauri/src/aniskip.rs:971` (inline literal)
- Modify: `src-tauri/src/lib.rs` (add `mod tenrai;`)

**Interfaces:**
- Produces: `tenrai::TENRAI_API: &str`, `tenrai::anime_full(mal_id: u32) -> Option<AnimeFull>`, `pub struct AnimeFull { score: Option<f64>, rank: Option<u32>, popularity: Option<u32>, members: Option<u64>, theme: Option<AnimeThemeRaw> }`, `pub struct AnimeThemeRaw { openings: Vec<String>, endings: Vec<String> }`.

- [ ] **Step 1: Create `tenrai.rs` with the base const and the cached `/full` fetch**

Model the cache on `aniskip.rs`: a `Mutex<HashMap>` behind a `OnceLock`, `CACHE_CAP` entries, positives long-lived, negatives short. Reuse the crate's existing `client()` pattern (rustls, `https_only(true)`).

```rust
pub const TENRAI_API: &str = "https://api.tenrai.org/v1";
```

Base path is `/v1`, NOT Jikan's `/v4`. Verified live: the envelope, field names and `theme` object are identical to Jikan v4.

- [ ] **Step 2: Point `ratings.rs` at the cached fetch**

Delete `const JIKAN_API`. `jikan_for_mal_id` keeps its exact output (`AggregateRating` rows with weights MAL 110, rank 60, popularity 55) but reads from `tenrai::anime_full` instead of issuing its own request. Keep the `[ratings]` devlog label so existing troubleshooting docs stay accurate.

- [ ] **Step 3: Point the `aniskip.rs` title search at `TENRAI_API`**

Replace the inline literal at `:971` with `format!("{}/anime", crate::tenrai::TENRAI_API)`. Do not leave a second hardcoded host in the tree.

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo check --message-format=short`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tenrai.rs src-tauri/src/ratings.rs src-tauri/src/aniskip.rs src-tauri/src/lib.rs
git commit -m "feat(api): migrate MAL calls from Jikan to Tenrai behind a shared cache"
```

---

## Task 2: theme_parse.rs

**Files:**
- Create: `src-tauri/src/theme_parse.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod theme_parse;`)

**Interfaces:**
- Produces: `pub struct EpisodeSpan { pub start: u32, pub end: u32 }`, `pub struct AnimeTheme { pub index: Option<u32>, pub title: Option<String>, pub artist: Option<String>, pub episodes: Vec<EpisodeSpan>, pub raw: String }`, `pub fn parse_theme(raw: &str) -> AnimeTheme`, `pub fn covers(theme: &AnimeTheme, episode: u32) -> bool`.

- [ ] **Step 1: Write the failing tests first**

These strings are copied verbatim from the live API and are the whole reason this module exists.

```rust
#[test]
fn parses_disjoint_ranges() {
    let t = parse_theme("1: \"We Are! (ウィーアー!)\" by Hiroshi Kitadani (きただにひろし) (eps 1-47,1000)");
    assert_eq!(t.index, Some(1));
    assert_eq!(t.title.as_deref(), Some("We Are! (ウィーアー!)"));
    assert_eq!(t.artist.as_deref(), Some("Hiroshi Kitadani (きただにひろし)"));
    assert_eq!(t.episodes, vec![EpisodeSpan { start: 1, end: 47 }, EpisodeSpan { start: 1000, end: 1000 }]);
    // The regression this module exists to prevent: episode 500 is NOT covered.
    assert!(covers(&t, 47));
    assert!(covers(&t, 1000));
    assert!(!covers(&t, 500));
}

#[test]
fn parses_multiple_singletons() {
    let t = parse_theme("1: \"memories\" by Maki Otsuki (大槻真希) (eps 1-30,808,968)");
    assert_eq!(t.episodes.len(), 3);
    assert!(covers(&t, 808));
    assert!(!covers(&t, 809));
}

#[test]
fn parses_simple_range() {
    let t = parse_theme("2: \"Believe\" by Folder5 (eps 48-115)");
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
    assert!(t.episodes.is_empty());
    assert!(!covers(&t, 3));
}

#[test]
fn raw_is_always_retained() {
    let s = "total garbage with no structure";
    assert_eq!(parse_theme(s).raw, s);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test theme_parse`
Expected: FAIL, module or functions not found.

- [ ] **Step 3: Implement the parser**

Rules, in order:

1. `index`: leading digits before the first `:`.
2. `title`: between the first `"` and the last `"` that precedes ` by `. Both title and artist contain parentheses, so quote position is the only reliable delimiter.
3. Find the episode suffix by searching for the LAST occurrence of the literal `(eps ` and requiring the string to end with `)`. Never treat "the last parenthetical" as the range: `Hiroshi Kitadani (きただにひろし)` would match.
4. `artist`: between ` by ` and the start of the `(eps ` suffix (or end of string when absent), trimmed.
5. Span body: split on `,`; each token splits on `-` into start and end, or is a singleton. Any token that fails to parse as `u32` clears the entire `episodes` vec.
6. `raw` is always the input, unmodified.

`covers` returns `false` for an empty span list. This is the fail-visible contract the player depends on.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test theme_parse`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/theme_parse.rs src-tauri/src/lib.rs
git commit -m "feat(anime): parse MAL theme strings into structured spans"
```

---

## Task 3: Ratings mismatch fix

**Files:**
- Modify: `src/CatalogHoverCard.tsx:56, 199-219, 239-282`
- Modify: `src-tauri/src/aniskip.rs:940-1056`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Gate the hover ratings effect on the meta detail having settled**

The bug: the effect fires on first render while `detail` is `null`, but `isAnime` is already true from `meta.media_type` or the id prefix (`:246-249`). So it sends all-null anime ids and the backend falls to the title search.

Add a settled flag set by the meta effect (`:194-230`) and bail out of the ratings effect while it is unset AND `isAnime` is true. Non-anime is unaffected, since it only needs `imdb_id`.

- [ ] **Step 2: Key the session cache on the ids the answer used**

Replace the `meta.id` key at `:240`, `:243` and `:272-276` with a composite of `meta.id` plus the mal, kitsu and anidb ids. Remove the unconditional `if (cached) { ...; return; }` at `:242-244` so a better-resolved later fire writes a new entry instead of being blocked.

- [ ] **Step 3: Stop caching empty results and stop leaking the previous card**

`[]` is truthy, so an empty first result currently pins "no ratings" for the session. Only write when the list is non-empty. Separately, reset `aggRatings` BEFORE the early return at `:261`, because `HoverPanel` (`:605`) has no React key and `catalogHoverStore` flips active card A to B without a null in between, so state survives the transition.

- [ ] **Step 4: Put id material in the dedupe key**

`dedupedInvoke`'s key at `:262-265` is `ratings:${meta.id}:${anime|std}` and carries no id material, so a corrected second call can receive the stale first promise. Include the same ids as the cache key.

- [ ] **Step 5: Align the metadata-addon election**

Hover puts the user's pinned default first (`:199-211`) while DetailView puts AIOMetadata first (`DetailView.tsx:738-745`), and hover flips `media_type` (`:216-219`) while DetailView does not. Match DetailView's order so the two surfaces cannot land on different `MetaDetail` objects for the same id.

- [ ] **Step 6: Harden the title resolver**

In `aniskip.rs:1027-1044`:

- Delete the `score += (50_000u32.saturating_sub(a.mal_id.min(50_000)) / 5_000) as i32` tiebreak. Preferring low MAL ids deterministically elects the franchise-root entry, which is what produced the reported MAL popularity #5.
- When a year hint is supplied, REQUIRE agreement (exact or off by one) rather than merely bonusing it. Reject candidates outside that.
- Add the year to the `MAL_RESOLVE_CACHE` key at `:947`, which currently omits it so one title caches one answer across all years.
- Log the elected id and score at the `[aniskip]` label.

- [ ] **Step 7: Verify**

Run: `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`
Expected: clean.

Runtime confirmation (needs a human): F12, hover an anime card then open it. Both surfaces should log the same MAL id. Before the fix, hover logs `resolve_mal_id_by_title ... -> Some(N1)` and the detail page logs `resolve_mal_id kitsu=... -> Some(N2)` with different ids.

- [ ] **Step 8: Commit**

```bash
git add src/CatalogHoverCard.tsx src-tauri/src/aniskip.rs
git commit -m "fix(ratings): stop the hover card pinning a title-resolved MAL entry"
```

---

## Task 4: Spoilers settings section

**Files:**
- Modify: `src/auraSettings.ts:56-248` (interface), `:250-281` (defaults), `:299-408` (validation)
- Modify: `src/settingsTransfer.ts:112-135`
- Modify: `src/views/SettingsView.tsx:3306` (TOC), `:4924-4952` (section)
- Modify: `src/episodeSpoilers.ts`

**Interfaces:**
- Produces: `AuraSettings.blurThemeEpisodeRanges: boolean`, `AuraSettings.arcAwareArt: boolean`, and a predicate in `episodeSpoilers.ts` for the range blur.

- [ ] **Step 1: Add both keys to the interface and defaults**

Both default `false`, matching the opt-in convention of the three existing toggles. Doc-comment each one, following the existing style in that file.

- [ ] **Step 2: Add explicit validation clauses in `readFromStorage`**

```ts
blurThemeEpisodeRanges: typeof parsed.blurThemeEpisodeRanges === "boolean"
  ? parsed.blurThemeEpisodeRanges
  : false,
```

Required because the `...parsed` spread at the top of that function otherwise lets a corrupt localStorage value through untyped.

- [ ] **Step 3: Add both keys to `PORTABLE_AURA_FIELDS`**

Without this they silently vanish from both export and import. Cloud sync is automatic because `readSettingsBlob` pushes the whole object, so no `sync.ts` change is needed.

- [ ] **Step 4: Rename the section and its TOC entry**

`<Section id="sec-detail-page" title="Detail Page">` becomes `<Section id="sec-spoilers" title="Spoilers">`, and `TOC_GROUPS` at `:3306` changes to match. Both must change together or the anchor breaks. Update the comment block above the section, which also names it.

- [ ] **Step 5: Add the two toggles to the renamed section**

Separate each with the existing `<div className="h-px bg-white/6" />`. The `arcAwareArt` description must carry the spoiler warning explicitly, because unlike its neighbours it ADDS exposure when switched on.

- [ ] **Step 6: Add the Fandom attribution line to Settings About**

One line beside the existing TMDB notice: arc artwork from Fandom, licensed CC BY-SA. `ArcGrid.tsx:366-369` keeps its contextual line.

- [ ] **Step 7: Add the shared predicate**

A fourth pure predicate in `episodeSpoilers.ts` so the overlay and any future surface share one rule rather than re-deriving it.

- [ ] **Step 8: Verify and commit**

Run: `pnpm exec tsc --noEmit`

```bash
git add src/auraSettings.ts src/settingsTransfer.ts src/views/SettingsView.tsx src/episodeSpoilers.ts
git commit -m "feat(settings): rename the Detail Page section to Spoilers and add two toggles"
```

---

## Task 5: Extras backend commands

**Files:**
- Modify: `src-tauri/src/tenrai.rs` (add endpoints and commands)
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)
- Modify: `src-tauri/permissions/player.toml`

**Interfaces:**
- Consumes: `tenrai::anime_full` from Task 1, `theme_parse::parse_theme` from Task 2.
- Produces: commands `fetch_anime_themes`, `fetch_anime_statistics`, `fetch_anime_staff`, `fetch_anime_recommendations`, `fetch_anime_trailers`, each taking `malId: u32` and returning `Option<T>`.

- [ ] **Step 1: Add the endpoint structs**

Live-verified shapes:
- `/anime/{id}/statistics` returns `watching, completed, on_hold, dropped, plan_to_watch, total` plus `scores: [{score, votes, percentage}]` with exactly 10 buckets.
- `/anime/{id}/videos` returns `promo: [{title, trailer: {youtube_id, url, images, ...}}]` and `music_videos` (frequently EMPTY, including on One Piece and Frieren, so treat absence as normal).
- `/anime/{id}/staff` returns a large array. Filter server-side to Director, Series Composition, Music and Character Design, since 491 raw rows for FMA:B is unusable.
- `/anime/{id}/recommendations` returns vote-weighted entries. Cap the returned list.

- [ ] **Step 2: Dedup trailers by `youtube_id`**

Promo entries genuinely repeat ids across differently-titled rows ("Main Trailer" and "PV 5" share an id on Frieren), so this is required, not defensive.

- [ ] **Step 3: Return themes through the parser**

`fetch_anime_themes` maps `AnimeFull.theme.openings` and `.endings` through `theme_parse::parse_theme` so the frontend never sees a raw string it has to parse.

- [ ] **Step 4: Register all five commands**

`src-tauri/src/lib.rs` `generate_handler!` and `src-tauri/permissions/player.toml` `commands.allow`. `capabilities/default.json` needs NO edit if the commands join an existing permission group, because it lists identifiers rather than command names. Missing the `player.toml` entry is the classic silent 401.

- [ ] **Step 5: Verify and commit**

Run: `cd src-tauri && cargo check --message-format=short`

```bash
git add src-tauri/src/tenrai.rs src-tauri/src/lib.rs src-tauri/permissions/player.toml
git commit -m "feat(anime): add Tenrai extras commands for themes, stats, staff, related and trailers"
```

---

## Task 6: AnimeExtrasOverlay

**Files:**
- Create: `src/animeExtras.ts`, `src/AnimeExtrasOverlay.tsx`
- Modify: `src/views/DetailView.tsx:1351-1372` (trigger), `src/StorageReport.tsx:66-132` (cache row)

**Interfaces:**
- Consumes: the five commands from Task 5, `blurThemeEpisodeRanges` from Task 4.
- Produces: `<AnimeExtrasOverlay malIds={...} open={...} onClose={...} />`.

- [ ] **Step 1: Write `animeExtras.ts`**

TS mirrors of the Rust structs (matching RUST field names, not wire names), the invoke wrappers, and one `PersistentCache` instance: 7-day TTL, capped, keyed `${malId}::${tab}`. Add its localStorage key to `StorageReport.tsx` so it is visible and clearable.

- [ ] **Step 2: Build the overlay shell**

Use the `SubtitlePicker.tsx:168-195` absolute-inside-a-positioned-ancestor pattern. Do NOT portal and do NOT copy `CatalogPopup` or `DayOverlay`: they are `z-[55]`, below DetailView's `z-[60]` root, so they would render underneath. DetailView's root also carries a transform, so `position: fixed` descendants position against the root rather than the viewport.

Five tabs: Songs, Ratings, Staff, Related, Trailers. Each fetches on first open OF THAT TAB, not on overlay open.

- [ ] **Step 3: Resolve the cour MAL id set**

On open, resolve a MAL id per season via the existing `resolve_mal_for_aniskip`, dedup by resolved id (One Piece's many Cinemeta seasons collapse to one MAL entry), and fetch each unique entry. `detail.mal_id` alone is the series root and would silently show only cour 1's songs.

- [ ] **Step 4: Render the Songs tab**

Grouped by cour with a heading. Each row shows index, title and artist. The episode range renders behind the blur when `blurThemeEpisodeRanges` is on, click to reveal, using the shared predicate. Title and artist NEVER blur. When `episodes` is empty, show no range at all rather than a guess, and fall back to `raw` if title and artist both failed to parse.

- [ ] **Step 5: Render the Ratings tab**

The 10-bucket histogram plus the status counts. This is the tab that most benefits from being visual: horizontal bars keyed on `percentage`, labelled with `score` and `votes`.

- [ ] **Step 6: Render Staff, Related and Trailers**

Staff is already filtered server-side. Related routes into the existing catalog navigation. Trailers are cour-grouped and play through the existing yt-dlp trailer path.

- [ ] **Step 7: Wire the trigger**

The hero action bar (`DetailView.tsx:1351-1372`) has exactly two children and an empty middle slot. The button must only render for anime with a resolvable MAL id, so it is absent rather than dead everywhere else.

Watch the wheel trap: a window-level non-passive wheel listener in PlayerOverlay changes VOLUME unless the event is over a real `overflow-y` ancestor. That listener is player-scoped so it does not apply here, but any scrollable list inside a player-side popover would need its own handler.

- [ ] **Step 8: Verify and commit**

Run: `pnpm exec tsc --noEmit`

```bash
git add src/animeExtras.ts src/AnimeExtrasOverlay.tsx src/views/DetailView.tsx src/StorageReport.tsx
git commit -m "feat(detail): add an anime extras overlay for songs, stats, staff, related and trailers"
```

---

## Task 7: Theme songs in the player

**Files:**
- Modify: `src-tauri/src/aniskip.rs:1065-1079` (`PreparedWindow`)
- Modify: `src/App.tsx:219-225` (mirror), the `set_skip_windows` pass
- Modify: `src/PlayerOverlay.tsx:4341-4351, 4426-4434, 4442-4485, 3289-3310`
- Modify: `src/AniSkipMenu.tsx:36-43`
- Modify: `src/App.css:1412-1415`

**Interfaces:**
- Consumes: `theme_parse::covers` from Task 2, `fetch_anime_themes` from Task 5.
- Produces: `PreparedWindow.song_title` and `.song_artist`, both optional.

- [ ] **Step 1: Add the fields to the Rust struct**

```rust
#[serde(skip_serializing_if = "Option::is_none", default)]
pub song_title: Option<String>,
#[serde(skip_serializing_if = "Option::is_none", default)]
pub song_artist: Option<String>,
```

`skip_id` at `:1072-1078` is the exact precedent. `skip_serializing_if` keeps the mpv payload clean; `skip-windows.lua:118-132` copies known fields only and ignores unknown keys, so the Lua script needs NO change.

- [ ] **Step 2: Update all three TS mirrors**

`App.tsx:219-225`, `PlayerOverlay.tsx:4341-4351`, `AniSkipMenu.tsx:36-43`. Missing one produces a silent type mismatch rather than an error.

- [ ] **Step 3: Stamp the song in the single `set_skip_windows` pass**

App.tsx already resolves the cour-correct MAL id (`resolve_mal_for_aniskip`, `:2903-2922`) and the MAL-local episode number (`:2994` and below) for AniSkip. Fetch themes for that MAL id, then attach.

**Fail-visible rule, enforced here:** attach a song only when the theme's spans are non-empty, the current episode falls inside one, AND exactly one theme of that kind matches. Empty spans, zero matches, or two or more matches all leave the fields unset so the UI falls back to the existing generic label. Naming the wrong song is worse than naming none.

`applySkipModes` (`:413-425`) spreads `{...w}` and `dedupeSkipWindows` (`:319-397`) filters whole objects, so the extra fields survive both. `restampSkipModes` (`:3337-3388`) must not drop them.

- [ ] **Step 4: Render in the prompt**

`SkipPromptToast` (`:4442-4485`). Keep `Skip Opening` as line one, since that is the affordance users scan for. Song goes beneath it, smaller and dimmer. Separate title and artist with a middle dot or the word "by", NEVER a dash.

The toast is fixed-position with NO width cap. Named `max-w-*` tokens emit nothing in this project, so use an arbitrary value plus truncation.

- [ ] **Step 5: Give the toast its own keyframe**

`aura-toast-pop` (`App.css:1412-1415`) applies `translate(-50%)` intended for the centre toast, but `SkipPromptToast` is left-anchored with no base transform, so it snaps sideways for the 220ms animation. Widening it makes that visible. Add a dedicated keyframe without the translate rather than pinning the width.

- [ ] **Step 6: Render in the scrubber hover card**

`:3289-3310`. Same field, already on the window object, so no new plumbing. That popover has no viewport clamping (only `left:${pct}%` plus `translateX(-50%)`), so clamp it or a long title overflows at the track ends.

- [ ] **Step 7: Verify and commit**

Run: `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`

```bash
git add src-tauri/src/aniskip.rs src/App.tsx src/PlayerOverlay.tsx src/AniSkipMenu.tsx src/App.css
git commit -m "feat(player): name the OP/ED song in the skip prompt and scrubber"
```

---

## Task 8: Arc-aware art

**Files:**
- Modify: `src/CinemaRows.tsx:696-934` (CW card), `:826-838` (the 16:9 loader)
- Modify: `src/views/DetailView.tsx` (`seedHeroArt`, roughly `:490-493`)

**Interfaces:**
- Consumes: `arcAwareArt` from Task 4, the existing `fetchStoryArcs` / `arcPositionOf` from `src/storyArcs.ts`.

- [ ] **Step 1: CW tile arc art**

`useCwDetail` (`:429-464`) already fetches a `MetaDetail` with videos and `tmdb_id` per card, which is exactly `fetchStoryArcs`' input. Take the resume pointer through `arcPositionOf` to an arc, and use `arc.image` ONLY when `image_source === "fandom"`.

The caller must re-apply the `isAnimeMeta` and `storyArcsAvailable` gates, because `useStoryArcs` applies them but `fetchStoryArcs` does not. `App.tsx:3646-3678` is the precedent for calling it outside the hook.

- [ ] **Step 2: Shrink the art**

Fandom lead images are 1920x1080 masters. Route through `shrinkPoster`. The CW 16:9 loader at `:826-838` is NOT shrunk today, so fixing that is a free RAM win independent of this feature.

- [ ] **Step 3: Hero warm seed**

Extend `seedHeroArt` to also peek the cached `aura:story-arcs` blob synchronously, exactly as it already peeks the meta cache via `peekRichestCachedDetailById`. A cached arc with Fandom art wins the latch; an uncached one falls back to normal art and takes effect on the next open.

**Do not** add a second write to `heroArtLatch`, and do not await the arcs fetch. The latch is write-once by design, and the uncommitted comment block above it documents the three swap sources that invariant closes. Gating the reveal on a TMDB round-trip for every anime is the failure this avoids.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec tsc --noEmit`

```bash
git add src/CinemaRows.tsx src/views/DetailView.tsx
git commit -m "feat(arcs): use arc key art for Continue Watching tiles and the detail hero"
```

---

## Task 9: WIKI_BY_TMDB verification pass

**Files:**
- Modify: `src-tauri/src/arc_art.rs:61-93`

- [ ] **Step 1: Run each candidate through four gates**

1. TMDB tv id resolved via TMDB search, NEVER from memory. A wrong id fails safe as a dead key, but a mismatched id routes one show to another show's wiki.
2. TMDB actually has an episode group of `type == 5` clearing the coverage bar. Without this arcs never render and the art is moot, so this gate eliminates the most candidates.
3. The Fandom host resolves.
4. One of `CATEGORY_CANDIDATES` yields members on that host.

Candidates: Vinland Saga, Tokyo Ghoul, Seven Deadly Sins, Fire Force, The Promised Neverland, Made in Abyss, Yu Yu Hakusho, Inuyasha, Rurouni Kenshin, Soul Eater, Magi, Katekyo Hitman Reborn!, Shaman King, Food Wars, Assassination Classroom, Kingdom, Golden Kamuy, Mushoku Tensei, Solo Leveling, Tokyo Revengers, Oshi no Ko, Overlord, D.Gray-man, Claymore, Monster, Berserk, Beastars, Parasyte, Toriko, Ranking of Kings, Sakamoto Days, Wind Breaker, Dandadan, Hell's Paradise. Plus the known gap: Fullmetal Alchemist (2003), absent while Brotherhood (31911) is present, and `fma.fandom.com` covers both.

- [ ] **Step 2: Add only the survivors, with a comment naming each show**

The existing table comments each entry with its show name. Match that.

- [ ] **Step 3: Verify and commit**

Run: `cd src-tauri && cargo check --message-format=short`

```bash
git add src-tauri/src/arc_art.rs
git commit -m "feat(arcs): expand the Fandom wiki routing table"
```

---

## Self-review notes

- Spec coverage: item 0 is Task 1, item 1 is Tasks 2 and 7, item 2 is Task 4, item 3 is Tasks 5 and 6, item 4 is Task 3, item 5 is Tasks 8 and 9. All six covered.
- Task 4 must land before Tasks 6 and 8, which read `blurThemeEpisodeRanges` and `arcAwareArt`.
- Task 2 must land before Tasks 5 and 7, which call `parse_theme` and `covers`.
- Task 1 must land before Task 5, which adds endpoints to the same module.
- Task 3 is independent of everything except that it touches `aniskip.rs`, which Task 7 also touches in a different region.
