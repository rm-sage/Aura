# Airing Page Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an "Airing" library sub-page listing currently-airing library series/anime as Continue-Watching-style tiles, plus an "Airing only" filter for Library/Queue and a Series-pill-excludes-anime change.

**Architecture:** One shared `isAiring` predicate (`src/airing.ts`) backs both the page and the filter. A new `AiringView` reuses `ContinueWatchingCard` and the Calendar's progressive/prioritized meta loader, but pre-filters to the airing subset via already-loaded release signals. Nav adds a second Library sub-row (mirroring Queue).

**Tech Stack:** React 19 + TypeScript, Tauri 2. Frontend-only; no Rust.

## Global Constraints

- No test framework: each task's gate is `pnpm exec tsc --noEmit` passing (run `./node_modules/.bin/tsc --noEmit`), plus reasoning. No `cargo check` needed (no Rust).
- No em-dashes/en-dashes anywhere (code, comments, UI copy, commit messages).
- Tailwind gotchas: `max-w-*` named tokens emit nothing; use `PAGE_CONTENT_MAX_W` inline for the page cap. Off-scale opacity (`/8` etc.) must be registered or use arbitrary `/[0.07]`.
- Any Settings field must be evaluated for `PORTABLE_AURA_FIELDS`/cloud-sync (airing view prefs are device-local -> not synced).
- Reuse `ContinueWatchingCard`; must NOT change Continue Watching behavior.

---

### Task 1: Shared airing predicate (`src/airing.ts`)

**Files:**
- Create: `src/airing.ts`

**Interfaces:**
- Produces:
  - `isAiringSeriesLike(item: LibraryItem): boolean` — true for series/anime media types (not movie).
  - `isAiring(item: LibraryItem, detail?: MetaDetail | null): boolean` — airing = `detail?.videos` gives `airingInfo(videos).isAiring` OR `getReleaseSignal(seriesRoot)?.next_aired != null`.
  - `airingNextMs(item: LibraryItem, detail?: MetaDetail | null): number | null` — `nextAiringEpisode(detail.videos)?.targetMs` else `Date.parse(getReleaseSignal(root)?.next_aired?.aired_at)` else null.
  - `airingLastAiredMs(item, detail?): number | null` — latest past-dated episode ms (from videos) else `last_aired.aired_at`.
  - `airWindow(ms: number | null, now: number): "today" | "week" | "later" | "none"`.

- [ ] **Step 1: Implement.** Uses `airingInfo`, `nextAiringEpisode` from `./releaseCountdown`; `getReleaseSignal` from `./releaseSignalStore`; `libraryItemSeriesId` from `./libraryNormalize`. `isAiringSeriesLike`: media_type in {series, anime} (lowercased). Series root = `libraryItemSeriesId(item.id)` (fallback item.id). Guard movies -> false everywhere.
- [ ] **Step 2:** `./node_modules/.bin/tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(airing): shared isAiring predicate + air-window helpers`.

---

### Task 2: Export `ContinueWatchingCard` (`src/CinemaRows.tsx`)

**Files:**
- Modify: `src/CinemaRows.tsx` (add `export` to `ContinueWatchingCard`; export any prop type it needs).

**Interfaces:**
- Produces: `ContinueWatchingCard` importable by AiringView with its existing props (item + the props CW passes). Confirm the prop shape by reading the CW row's call site; if it depends on CW-row-only context, note it for Task 4's wrapper fallback.

- [ ] **Step 1:** Read `ContinueWatchingCard` (CinemaRows.tsx:706+) and its call site; add `export`. Do not change its logic.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `refactor(cinema-rows): export ContinueWatchingCard for reuse`.

---

### Task 3: Airing view prefs (`src/auraSettings.ts`)

**Files:**
- Modify: `src/auraSettings.ts` (add `airingGroupBy: "type"|"airwindow"|"none"` default `"type"`; `airingSort: "recent"|"soonest"|"behind"|"alpha"` default `"recent"`).

**Interfaces:**
- Produces: the two fields on `AuraSettings` + defaults; read via `loadAuraSettings()`, written via `saveAuraSettings`.

- [ ] **Step 1:** Add fields + defaults following the existing AuraSettings pattern. Do NOT add to `PORTABLE_AURA_FIELDS`/backend portable (device-local view prefs); add a code comment noting the deliberate exclusion.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(settings): airing-page group-by + sort prefs (device-local)`.

---

### Task 4: The Airing page (`src/views/AiringView.tsx`)

**Files:**
- Create: `src/views/AiringView.tsx`

**Interfaces:**
- Consumes: `isAiring`, `isAiringSeriesLike`, `airingNextMs`, `airingLastAiredMs`, `airWindow` (Task 1); `ContinueWatchingCard` (Task 2); `airingGroupBy`/`airingSort` (Task 3); `getMetaDetail` (metaCache); `getReleaseSignal` (releaseSignalStore); `useEpisodesBehind` (LibraryContext); `isAnimeMeta` (aiometadata); `PAGE_CONTENT_MAX_W` (pageLayout).
- Produces: `export default function AiringView({ library, addons, onSelectMeta })`.

Design points (from spec):
- Candidate pre-filter (no network): item is `isAiringSeriesLike` AND (`getReleaseSignal(root)?.next_aired != null` OR cached `getMetaDetail` hit with `airingInfo.isAiring`). If NO signals at all present in the store (release-search off), fall back to candidates = all `isAiringSeriesLike` items.
- Progressive prioritized fetch of candidate meta (reuse the Calendar loader shape: throttled batched `setDetails`, concurrency 8, airing-soon first). After fetch, keep only items where `isAiring(item, detail)`.
- Header: Group-by segmented (`type`/`airwindow`/`none`) + Sort dropdown; both persist to auraSettings and re-read on `aura:settings-changed`.
- Grid: `auto-fill, minmax(LANDSCAPE_CARD_WIDTH...)`, each cell = `ContinueWatchingCard` + a "N behind" badge overlay (from `useEpisodesBehind(detail.videos, root)` when > 0). Reuse the red-badge styling used in DetailView/hover (copy the class, no new counting).
- Grouping: `type` -> Series / Anime headers (anime via `isAnimeMeta`); `airwindow` -> Today/This week/Later/(No date); `none` -> flat. Sort within group.
- Empty states: "Nothing airing right now"; distinct hint when signals unavailable + cache cold.

- [ ] **Step 1:** Implement AiringView per the above.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(airing): AiringView page (tiles, group-by, sort, behind badge)`.

---

### Task 5: Nav sub-rows (`src/NavSidebar.tsx`)

**Files:**
- Modify: `src/NavSidebar.tsx` (generalize the single Queue sub-row into an ordered `[queue, airing]` list; index-based pill offset + active highlight for both).

**Interfaces:**
- Consumes: existing `active` tab id, `onSelect`. Produces: nav renders Queue then Airing indented under Library; both highlight/restore; Library pill lit for both.

- [ ] **Step 1:** Read the Queue sub-row block; add an `airing` sub-row below it and make the offset/highlight math index-based over `[queue, airing]`.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(nav): Airing sub-row under Library, below Queue`.

---

### Task 6: Routing (`src/App.tsx`)

**Files:**
- Modify: `src/App.tsx` (render `<AiringView>` on tab `airing`; treat `airing` as Library-family for pill; sessionRoute already generic).

**Interfaces:**
- Consumes: AiringView (Task 4). Produces: `airing` route rendered with `library`, `addons`, `onSelectMeta` (match Calendar/Library call sites).

- [ ] **Step 1:** Add the `airing` render arm; wire props exactly as CalendarView is wired.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(airing): route + render AiringView`.

---

### Task 7: Airing filter in FilterBar (`src/FilterBar.tsx`)

**Files:**
- Modify: `src/FilterBar.tsx` (`airingOnly?: boolean` in `FilterState` + `DEFAULT_FILTERS`; a toggle in `FilterMenu`).

**Interfaces:**
- Produces: `FilterState.airingOnly`; `FilterMenu` renders the toggle. `applyFilters` UNCHANGED (predicate is applied by views, not on MetaPreview).

- [ ] **Step 1:** Add field + default + a "Airing only" toggle row in the menu (match existing toggle styling).
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(filter): Airing-only toggle in the shared filter menu`.

---

### Task 8: Library filter changes (`src/views/LibraryView.tsx`)

**Files:**
- Modify: `src/views/LibraryView.tsx` (series bucket excludes anime; apply `airingOnly`).

**Interfaces:**
- Consumes: `isAiring` (Task 1), `FilterState.airingOnly` (Task 7).

- [ ] **Step 1:** In `buckets` useMemo push to `series` only when `mt === "series" && !isAnimeMeta(...)`; mirror in `itemMatchesTypeFilter`. After the existing filter passes, if `extraFilters.airingOnly`, keep only items where `isAiring(item, details?.get(id))` using the cheap path (no new fetch; use cached meta via a `getMetaDetail`-cache peek or signal only). Confirm counts follow.
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(library): Series pill excludes anime; apply Airing-only filter`.

---

### Task 9: Queue filter change (`src/views/QueueView.tsx`)

**Files:**
- Modify: `src/views/QueueView.tsx` (apply `airingOnly`).

**Interfaces:**
- Consumes: `isAiring` (Task 1), `FilterState.airingOnly` (Task 7).

- [ ] **Step 1:** After `applyFilters`, when `filters.airingOnly`, narrow `filteredOrderedIds` to ids whose library item `isAiring` (cheap path).
- [ ] **Step 2:** `tsc --noEmit` -> PASS.
- [ ] **Step 3: Commit** `feat(queue): apply Airing-only filter`.

---

### Task 10: Regression audit

- [ ] Run the multi-agent regression audit (Workflow) over the diff: nav (both sub-rows), airing predicate correctness, filter changes (series-excludes-anime, airingOnly in both views), AiringView data loading + edge cases, CW-card reuse not regressing Continue Watching. Fix confirmed findings. Final `tsc --noEmit` -> PASS.

## Self-Review

- **Spec coverage:** nav sub-row (T5,T6), page + tiles + group-by + sort + behind badge (T4), isAiring shared predicate (T1), fast progressive load (T4), airing filter both views (T7,T8,T9), series=live-action (T8), prefs persist (T3), CW reuse (T2), edge cases + audit (T10). All spec sections covered.
- **Placeholders:** none — each task names exact files, interfaces, and the concrete change; code is described precisely enough to implement directly (representative snippets, real symbol names).
- **Type consistency:** `isAiring(item, detail?)`, `airingNextMs`, `airWindow`, `FilterState.airingOnly`, `airingGroupBy`/`airingSort` used consistently across tasks.
