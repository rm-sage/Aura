# CW & episode-detail polish batch — design (2026-06-01)

Four independent UI/UX fixes, one spec → one plan with independent tasks.
Verification gate per task: `cd src-tauri && cargo check --message-format=short`
(only if Rust touched) + `pnpm exec tsc --noEmit`. This batch is **frontend-only**
(no Rust changes expected).

Design decisions were locked through a visual-companion brainstorm (marker style
chosen as **G-dot** from a mockup). Accent colour is `--ln-accent = #5BA4FF`.

---

## Part 1 — Episode-drawer countdown fits one line (compact)

**Problem.** In the in-player episode drawer, the air countdown `13d 12h 13m 19s`
(15 chars) wraps inside the fixed `w-[120px]` thumbnail cell (`EpisodeAirChip.tsx`).

**Decision.** Compact: drop the seconds at day-scale. Applied to the drawer chip
ONLY (no ripple to the other 4 `formatCountdown` call sites).

**Approach.**
- `src/releaseCountdown.ts::formatCountdown(targetMs, nowMs)` gains an optional
  third arg `opts?: { compactDays?: boolean }` (default `false` → existing
  behaviour unchanged). When `compactDays` is true AND `days > 0`, return
  `${days}d ${pad(hours)}h ${pad(mins)}m` (no seconds). All other branches
  (hours-only, mins-only, secs-only) unchanged — they already fit 120px.
- `src/EpisodeAirChip.tsx` calls `formatCountdown(targetMs, now, { compactDays: true })`
  and adds `whitespace-nowrap` to the pill `<span>` as a belt-and-suspenders guard.

**Files:** `src/releaseCountdown.ts`, `src/EpisodeAirChip.tsx`.

---

## Part 2 — Home/catalog card year matches details (canonical, reactive)

**Problem.** The home catalog card shows the **catalog addon's** `release_info`
verbatim (`CinemaRows.tsx` ~L851), which is wrong for some titles (Cinderella II:
"2020"); the hover/details show the **meta addon's** year ("2002"). Two addons
disagree.

**Decision.** Catalog cards prefer the canonical cached meta-detail year, reactive
so they correct once meta is warmed (hover/visit already warms it). No eager
per-card meta fetches.

**Approach.**
- `src/metaCache.ts`: add a tiny external store — a module version counter bumped
  on every `cache.set(...)`, plus `subscribeMetaCache(cb)` and a
  `useMetaCacheVersion()` hook (`useSyncExternalStore`). Export a helper
  `canonicalReleaseYear(id: string): string | null` = from `peekCachedDetailById(id)`,
  prefer `detail.release_info`, else `detail.released?.slice(0, 4)`, else null.
- The catalog card component in `src/CinemaRows.tsx` calls `useMetaCacheVersion()`
  (subscribe) and renders `canonicalReleaseYear(meta.id) ?? meta.release_info` for
  the year line. Cold paint = current behaviour; after meta warms = corrected.

**Files:** `src/metaCache.ts`, `src/CinemaRows.tsx`.

---

## Part 3 — Notification → details with season selected + episode scrolled & selected

**Problem.** Episode-release notifications carry `data.videoId` (e.g. `tt…:2:5`),
but App.tsx's `aura:open-meta` handler drops it, so the details page opens without
selecting the season/episode.

**Decision.** Thread `videoId` into the existing `openOnEpisodeId` deep-link
machinery (which already selects the season containing the episode and scrolls its
row to the top), and add a persistent "selected" highlight on that row.

**Approach.**
- `src/App.tsx`: the `aura:open-meta` event handler reads `detail.videoId`; extend
  `onOpenMeta` to `(metaId, mediaType, videoId?)` and route `videoId` into the
  same App state that feeds DetailView's `openOnEpisodeId` (the post-playback
  landing already uses this hint). Confirm via `NotificationsPanel.tsx` that the
  dispatch already includes `videoId` (it does).
- `src/views/DetailView.tsx`: the episode row matching the consumed
  `openOnEpisodeId` gets a persistent accent ring (`ring-1 ring-ln-accent/70` +
  subtle glow), distinct from the now-playing/next highlight. The highlight clears
  when the user changes season or navigates away (tie it to the active hint, not a
  timer). **Decision: persistent until season-change/navigation**, not a timed fade.

**Files:** `src/App.tsx`, `src/views/DetailView.tsx` (+ read-only confirm
`src/NotificationsPanel.tsx`).

---

## Part 4 — CW segmented bar: latest-aired marker, tooltips, "episodes behind"

Shared util first, then three surfaces.

### Shared: airing info helper
Add `airingInfo(videos, nowMs)` to `src/releaseCountdown.ts` returning:
- `isAiring: boolean` — at least one aired episode AND at least one not-yet-aired
  episode (series has aired content but isn't finished).
- `latestAiredId: string | null`, `latestAiredEpisode: number | null` — the
  highest-`released`-that-is-≤-now episode.
- `airedCount: number` — episodes with `released ≤ now`.
Reused by 4a (marker condition) and 4c (behind count). Uses existing `isVideoAired`.

### 4a — Latest-aired marker (G-dot) + tint
`src/CinemaRows.tsx`:
- `SegmentedSeasonBar`: split the faint "empty" branch into **aired-but-unwatched**
  (`bg-white/35` tint — "available to watch now") vs **not-yet-aired**
  (`bg-white/15`), using `isVideoAired(ep)`. Render a glowing accent dot
  (`absolute -top-[7px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full`,
  `background:#5BA4FF`, accent glow shadow) above the latest-aired segment. Marker
  shows **only when** the season's episode list has both an aired ep and a later
  not-yet-aired ep (airing). Completed seasons render exactly as today.
- `ContinuousProgressBar` (>50 aired eps): add the **frontier line** (thin accent
  vertical line) at the latest-aired position (`left: (latestAiredIdx+1)/total *
  100%`), when airing. No per-segment tint here (single fill).

**Dot ↔ countdown non-conflict (required).** On CW cards the `CWReleaseCountdown`
pill is centered at `bottom-2.5` (10px), directly in the band the dot floats into
(the dot sits ~16-25px above the card bottom). If the latest-aired segment is near
centre, the dot lands behind the pill. Fix by **vertical zoning**: lift
`CWReleaseCountdown` into a band ABOVE the dot (raise its `bottom` offset so the
pill's lower edge clears the dot's top with a small gap — ~`bottom-7`/28px,
tuned on hardware), and give the dot `z-20` + a subtle dark ring (`outline` or a
1px dark halo) so it stays legible even at the boundary. This is deterministic —
no overlap regardless of which segment is latest-aired. The dot stays exactly as
chosen (G-dot); only the countdown pill moves. (Cards with a countdown but no dot
— e.g. a returning show whose current season is fully aired — just show the pill
slightly higher, which is fine.) **Flagged for on-hardware eyeball** since the
exact offset is visual.

### 4b — Tooltips
`src/CinemaRows.tsx`: one **mousemove-driven** tooltip per bar (single element, no
50-wrapper perf hit). On hover, compute the segment index from cursor-x and show a
small styled tooltip: `S{season}E{ep} · {state}` where state ∈ `Watched`,
`In progress`, `Available now` (aired-unwatched), `Not yet aired`; append
`· Latest aired` on the frontier segment. Add a tooltip on the next-episode
countdown chip (`CWReleaseCountdown`) explaining it ("Next episode airs {date}").
Tooltip styling: small dark glass pill, `text-[11px]`, positioned above the bar at
the cursor x, `pointer-events-none`.

### 4c — "N episodes behind" (airing shows only, red)
Shared helper `episodesBehind(videos, resumeVideoId, nowMs): number | null`:
- `airing = airingInfo(...).isAiring`; if not airing → null.
- `airedCount = airingInfo(...).airedCount`.
- `watchedAired` = count of aired episodes that are fully watched: `manualState ==
  'watched'` OR `episodeIsBeforeResume(ep.id, resumeId)` (implied). The in-progress
  resume episode itself is NOT counted (matches AniMouto "2 behind / 7 watched").
- `behind = max(0, airedCount − watchedAired)`; return `behind > 0 ? behind : null`.

Render (red, `text-red-400`), **airing && behind > 0 only**:
- `src/views/DetailView.tsx` meta strip (~L1066-1142): a red bit
  `{behind} episode{behind===1?'':'s'} behind` after the runtime / season-air stat.
- `src/CatalogHoverCard.tsx` hover panel (~L365-377): a red bit appended near the
  meta line / countdowns.

**Decision:** just `N episodes behind` (no `Progress X/Y` fraction). Not shown on
the CW card itself — DetailView + hover panel only.

**Files (Part 4):** `src/releaseCountdown.ts`, `src/CinemaRows.tsx`,
`src/views/DetailView.tsx`, `src/CatalogHoverCard.tsx`.

---

## Confirmed defaults
1. Part 3 highlight is **persistent** until season-change/navigation (not a timed fade).
2. Part 4c counts the in-progress episode as **not yet watched** (so "behind"
   includes the episode you're mid-way through).
3. "Behind" text is **`N episodes behind`** only (no progress fraction); DetailView
   meta + hover panel only (not the CW card).

## Shared-helper reuse (DRY)
`airingInfo` and `episodesBehind` live in `src/releaseCountdown.ts` and are the
single source of truth for "is this airing / latest aired / how far behind",
reused by the CW marker (4a), the behind count (4c on both DetailView and hover),
avoiding three divergent reimplementations.

## Out of scope
- No Rust changes. No change to the 4 other `formatCountdown` call sites.
- The CW card does not get the red "behind" count (image #3 was a style reference).
- Anime without addon-supplied `videos[].released` air dates simply won't show a
  marker / behind count (no data) — graceful, same as today's countdown behaviour.
