# Airing page + airing filter + series/anime split — design

Status: approved 2026-07-09. Aura is a Tauri 2 + React 19 + libmpv Stremio-addon
media player. This feature is frontend-only (TypeScript/React); no Rust changes.

## Goal

A new "Airing" surface listing the user's library series/anime that are currently
airing, rendered with the Continue-Watching landscape tile format, plus:
- an "Airing only" filter in the Library and Queue filter menus, and
- the Library "Series" type pill restricted to live-action series (anime keeps its
  own "Anime" pill).

## Non-goals

- No new Rust commands or backend work.
- No change to Continue Watching, Calendar, or the notification scanner behavior.
- Click-to-play-next was declined; tiles open Detail (normal) as elsewhere.
- No virtualization on the Airing page (the airing set is small, tens of items).

## Definition of "airing" (shared predicate)

`isAiring(item, detail | undefined): boolean` — a library series/anime is airing when
EITHER:
1. its meta reports `airingInfo(detail.videos).isAiring` (>=1 aired episode AND >=1
   future-dated episode), OR
2. the release-signal cloud feed has `getReleaseSignal(seriesRootId)?.next_aired != null`
   (a scheduled next episode, covering between-cour/returning shows before local meta
   is dated).

Movies are never airing. Excludes ended shows (no future, no next_aired) and
not-yet-premiered shows (no aired episode) unless a cloud next_aired is present AND the
show has begun — i.e. condition 2 alone (cloud next_aired) is treated as airing since the
cloud feed only reports next_aired for shows with a real run. The predicate lives in a new
`src/airing.ts` so the page and the filter share ONE definition.

`isAiringSeriesLike(item)` gate: only `series`/`anime` media types are considered (via the
existing `isAnimeMeta` for the anime split); movies short-circuit to false.

## Nav placement (`NavSidebar.tsx`, `App.tsx`, `sessionRoute.ts`)

"Airing" is a second **sub-row under Library, directly below Queue** — the same nested
pattern Queue already uses (indent + L-connector, Library pill stays lit while a sub-row
is active). Implementation:
- Generalize NavSidebar's hardcoded single Queue sub-row into an ordered list of Library
  sub-rows `LIBRARY_SUBROWS = [{id:"queue",...},{id:"airing",...}]`, and drive the
  pill-offset / active-highlight math off that list so both sub-rows highlight and restore
  correctly (today the Queue offset is a single hardcoded slot; it becomes index-based).
- New route id `"airing"`. `App.tsx` renders `<AiringView library addons onSelectMeta />`
  when the active tab is `airing` (mirroring the Calendar/Library render arms), and treats
  `airing` like `queue` for "Library-family" pill lighting.
- Persist via existing `sessionRoute` so Ctrl+R/F5 restores the Airing tab; cold start
  still opens Home.

## The page (`src/views/AiringView.tsx`)

- Same centered, width-capped column as Library/Queue/Discover:
  `style={{ maxWidth: PAGE_CONTENT_MAX_W }}` from `pageLayout.ts`.
- Body = a responsive grid of `ContinueWatchingCard` (reused directly from `CinemaRows.tsx`;
  it already falls back `landscape -> background -> poster`, so items without 16:9 art still
  render). Grid uses `auto-fill, minmax(...)` sized to the landscape card width.
- **Group by** segmented control (single-select):
  - `type` (default): two sections with **Series** and **Anime** headers (anime via
    `isAnimeMeta`).
  - `air-window`: sections **Today** / **This week** / **Later**, bucketed by the next
    episode's air date (`nextAiringEpisode(detail.videos)?.targetMs`, falling back to
    `releaseSignal.next_aired.aired_at`); a "No date" bucket for cloud-returning shows with
    no concrete next date sorts last.
  - `none`: flat grid.
- **Sort** dropdown (applies within groups):
  - `recent` (default): most recently aired first (latest past-dated episode desc).
  - `soonest`: soonest next episode first.
  - `behind`: most `useEpisodesBehind` first.
  - `alpha`: A-Z by title.
- Each tile shows the red **"N behind"** badge from `useEpisodesBehind(detail.videos, seriesId)`
  when > 0 (reuse the existing hook/'component style; no new counting logic).
- Empty state: "Nothing airing right now" card when the airing set is empty (and a distinct
  "Sign in / release-search off" hint when signals are unavailable and no cached meta yields
  airing shows).
- Group-by / sort selections persist in `AuraSettings` (device-local UI prefs) so the page
  remembers them; evaluate against `PORTABLE_AURA_FIELDS` for share/sync per the standing
  Settings-sharability rule (these are per-device view prefs -> not synced, documented).

## Data loading (fast, progressive)

The airing set is a small subset, so avoid Calendar's fetch-everything:
1. **Cheap candidate pre-filter (no network):** for each library series/anime, include as a
   candidate if `getReleaseSignal(seriesRoot)?.next_aired != null` OR an already-cached
   `getMetaDetail`-cache hit reports `airingInfo.isAiring`.
2. **Fetch meta only for candidates**, progressively + prioritized, reusing the Calendar
   pattern (throttled batched `setDetails`, concurrency 8, airing-soon first). Tiles paint
   as candidates resolve.
3. **Fallback:** when release-search is off (guest/opted-out) so there are no signals AND the
   cache is cold, fall back to a full progressive scan of series/anime items (same batched
   loader) — correctness over speed for that minority path.
4. Confirm airing with the fetched meta via `isAiring(item, detail)`; drop candidates the
   meta disproves (e.g. cloud next_aired stale but meta shows the show ended).

## Filter-menu changes (`FilterBar.tsx`, `LibraryView.tsx`, `QueueView.tsx`)

- **"Airing only" toggle** added to the shared `FilterMenu` (a boolean in `FilterState`,
  default off). Because the predicate is meta/signal-aware (not a MetaPreview genre/year
  field), `applyFilters` cannot evaluate it from MetaPreview alone; instead each consuming
  view (Library, Queue) applies `isAiring(item)` to its library items when
  `filters.airingOnly` is set, in addition to `applyFilters`. The toggle renders in
  `FilterMenu` under a small "Status" affordance so both views expose it identically.
  - For the toggle, `isAiring` uses the cheap path (cloud next_aired OR cached-meta
    airingInfo); it does NOT trigger a full meta fetch from the filter (a library-wide fetch
    on a filter toggle would regress perf). Uncached items fall back to the cloud signal
    only. Acceptable: the dedicated Airing page is the exhaustive surface; the filter is a
    quick narrow.
- **Series = live-action only:** in `LibraryView` `buckets` useMemo, push to `series` only
  when `mt === "series" && !isAnimeMeta({media_type,id,genres})`; mirror in
  `itemMatchesTypeFilter`. Counts follow automatically. Anime pill unchanged. (Queue has no
  type pills, so this is Library-scoped.)

## New / changed files

New:
- `src/airing.ts` — `isAiring`, `isAiringSeriesLike`, next-air-date + air-window helpers.
- `src/views/AiringView.tsx` — the page.

Changed:
- `src/NavSidebar.tsx` — generalize Library sub-rows to `[queue, airing]`.
- `src/App.tsx` — route render arm + Library-family pill handling + sessionRoute.
- `src/FilterBar.tsx` — `airingOnly` field in `FilterState` + toggle UI.
- `src/views/LibraryView.tsx` — series-excludes-anime bucket; apply `airingOnly`.
- `src/views/QueueView.tsx` — apply `airingOnly`.
- `src/CinemaRows.tsx` — export `ContinueWatchingCard` (and any helper it needs) for reuse;
  minimal, must not change CW behavior.
- `src/auraSettings.ts` — airing page group-by / sort prefs.

`ContinueWatchingCard` reuse: it is currently a private `memo` in CinemaRows. Export it (and
keep its props stable). If it turns out too coupled to the CW row context to reuse cleanly, a
thin `AiringCard` wrapper composes the same sub-parts (art via `useLandscapeArt`, progress
bar, `CWReleaseCountdown`, `useEpisodesBehind` badge) — decided at implementation time, but
reuse is preferred and the CW path must not regress.

## Edge cases / audit checklist

- Airing show fully caught up: renders with no red "N behind" badge (behind = 0 -> null).
- Specials / season-0 must not inflate "behind" (useEpisodesBehind already excludes S0).
- Between-cour shows (Dr. Stone-style): grouped by the correct next-air date; not duplicated.
- Items lacking 16:9 art: card poster fallback, not dropped.
- Release-search off / guest: page falls back to full scan; filter falls back to cloud-less
  (cached-meta only); no crash, sensible empty state.
- Empty airing set: dedicated empty card.
- Movies never appear on the page nor match the airing filter.
- Nav: both Queue and Airing sub-rows highlight correctly, restore on refresh, and the
  Library pill stays lit for both; the pill-offset math is correct for two sub-rows.
- Series pill count + grid exclude anime; anime pill unchanged; "all" unaffected.
- Group-by/sort persistence survives navigation and restart.
- Perf: page load is candidate-subset-sized, not full-library; progressive paint; no
  per-item fetch on the filter toggle.

## Verification

- `pnpm exec tsc --noEmit` (frontend-only change; no `cargo check` needed).
- Runtime: open Airing tab, confirm airing shows appear with tiles/countdown/behind badges,
  group-by + sort work, empty state, and the Library "Series" pill excludes anime; the
  "Airing only" filter narrows both Library and Queue. Multi-agent regression audit after
  implementation per the user's request.
