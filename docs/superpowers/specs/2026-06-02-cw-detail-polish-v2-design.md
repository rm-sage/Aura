# CW & detail polish v2 — design (2026-06-02)

Nine independent frontend fixes/features, one spec → one plan with independent
tasks. Frontend-only (no Rust). Verification per task: `pnpm exec tsc --noEmit`.
On-hardware eyeball flagged where visual/timing (#1, #2, #6, #8). Accent =
`--ln-accent #5BA4FF`.

Locked decisions (from brainstorm): countdown **size M**; tint **bright white
(`bg-white/70`)**; notification lands on the **episode list + synopsis**;
art-retry on **null poster only, hourly forever**; **only** the Digital-Release-
Filter notice when present; unaired-episode thumbs use the **series poster**.

---

## Part 1 — CW next-episode countdown larger (size M)

`src/CinemaRows.tsx::CWReleaseCountdown` pill (~L624-641). Bump the pill to size
M: `text-[11px] px-2 py-0.5` → `text-[12.5px] px-2.5 py-0.5`, icon `11`→`12`,
`gap-1`→`gap-1.5`. The pill grows upward from its `bottom-[28px]` anchor, away
from the dot — zoning unaffected.

**File:** `src/CinemaRows.tsx`.

---

## Part 2 — 'Available now' tint more obvious (bright white)

Same component family. In `SegmentedSeasonBar` the aired-but-unwatched class is
`bg-white/35` (~L228); change to **`bg-white/70`** (a standard Tailwind step —
72% isn't on the scale and would silently emit no CSS per the opacity-scale
landmine; 70% is the chosen look). Not-yet-aired stays `bg-white/15`.

**File:** `src/CinemaRows.tsx`.

---

## Part 3 — Notification click shows the episode synopsis

The deep-link currently sets `openOnEpisodeId` (season+scroll) + `highlightEpisodeId`
(ring) but never `activeVideo`, so `EpisodeSynopsisSection` (which renders when
`activeVideo` is set) stays blank. Decision: **stay on the episode list and show
the synopsis** (do NOT switch to streams mode).

**Approach.** Add an effect in `DetailViewBody` mirroring the existing resume
effect (~L831): when `highlightEpisodeId` (the notification ring hint) resolves
against `detail.videos`, `setActiveVideo(resolved)` — but only when not already
in/headed to streams mode (guard `panelMode !== "streams"` and `!activeVideo`),
so it populates the synopsis without leaving the list. `handlePickEpisode`
(real click → streams) is unchanged.

**File:** `src/views/DetailView.tsx`.

---

## Part 4 — CW segment tooltip no longer clipped at card edge

The single mousemove tooltip (`absolute -top-7 …` in `SegmentedSeasonBar`) is
clipped by the CW card's `overflow-hidden rounded-xl` container. Decision:
**portal the tooltip to `document.body`** with fixed positioning at the cursor.

**Approach.** Track the cursor's viewport coords (`clientX`/`clientY`) instead of
a bar-relative `x`. Render the tooltip via `createPortal(…, document.body)` as a
`fixed` element positioned just above the cursor (`top: clientY - offset; left:
clientX; -translate-x-1/2`), clamped horizontally to the viewport so it never
runs off-screen. Clears on `onMouseLeave`. (Reuses the `createPortal` pattern
already in the file/`Tooltip.tsx`.)

**File:** `src/CinemaRows.tsx`.

---

## Part 5 — Retry artwork for Library items missing a poster (hourly)

Decision: items with **`poster == null`**; retry **~hourly, indefinitely**.

**Approach.** New `src/libraryArtRetry.ts` exporting `useLibraryArtRetry(library,
addons, applyPoster)`:
- Per-id throttle in localStorage `aura:art-retry:v1` = `{ [id]: lastAttemptMs }`
  (debounced persist, mirroring metaCache).
- A run (on first mount after library/addons ready, then on a 1-hour
  `setInterval`) collects `library` items with `poster == null` whose last
  attempt was ≥ 1h ago (or never).
- For each (concurrency-capped at ~4), iterate **meta-capable addons** calling
  the Rust `fetch_meta_detail` **directly** (NOT `getMetaDetail` — bypass its
  4h/7d TTL so the hourly retry actually re-queries) until one returns a
  non-null `poster`. Stamp `lastAttempt = now` regardless.
- On a found poster, call `applyPoster(id, poster)` → App updates the in-memory
  library item (`setLibrary` map) so the card repaints; the cloud record is not
  mutated (same as the existing poster-warm).
- Wired in `App.tsx` next to the existing background poster-warm, with
  `applyPoster` doing the `setLibrary` update.

**Files:** `src/libraryArtRetry.ts` (new), `src/App.tsx`.

---

## Part 6 — Unaired episodes show series poster (not a blurred thumb)

Decision: use the **series poster** (`detail.poster ?? detail.background`),
cropped to fill the 16:9 thumb.

**Approach.** Thread `seriesArt: string | null` from `DetailViewBody` (where
`detail.poster`/`background` live) → `UnifiedPanel` → `EpisodesPanel` →
`EpisodeRow`. In `EpisodeRow`, when `unaired` is true, render `seriesArt`
(`object-cover`, NO blur, no `scale-110`) instead of the blurred
`video.thumbnail`. Keep the existing unaired veil (`bg-black/45`) so the row text
+ the air-countdown chip stay legible. The chip (`EpisodeAirChip`) is already a
dark pill + `border-white/15` + text-shadow → legible on light AND dark posters;
no change needed beyond confirming on hardware.

**File:** `src/views/DetailView.tsx` (+ `src/EpisodeAirChip.tsx` only if HW shows
a legibility gap).

---

## Part 7 — Group rating tiles by source/brand

Real cause: MAL **score / rank / popularity carry different `source` strings**
(`myanimelist` / `mal rank` / `mal popularity`), so the weight sort scatters
them. `logodev.tsx::ratingDomain` already maps all `*mal*` → `myanimelist.net`
(and imdb/rt/mc/anilist/etc. to their domains).

**Approach.** After the existing sort (weight desc / anime-first), apply a stable
**group-by-brand** pass using `brandKey = ratingDomain(source) ?? source.toLowerCase()`:
iterate the sorted list, bucket by `brandKey`, emit buckets in first-appearance
order (= each brand's highest-weight member, since input is weight-sorted), with
members kept in weight order within the brand. Then apply the existing `slice(0, 6)`.
Apply identically in **both** `src/views/DetailView.tsx` (`mergedRatings`) and
`src/CatalogHoverCard.tsx` (`ratings`). A tiny shared helper
`groupRatingsByBrand(rows)` avoids duplicating the logic.

**Files:** `src/views/DetailView.tsx`, `src/CatalogHoverCard.tsx` (+ a small
shared helper — colocated in `logodev.tsx` next to `ratingDomain`, or a new
`src/ratingValue.ts` export).

---

## Part 8 — AIOStreams notice cluster mis-positioned on stream re-entry (fix)

`StreamMetaBadges` (DetailView ~L3026) is a `position: fixed` portal positioned
off `asideRef.getBoundingClientRect()`. `entered` flips via a **480 ms fallback
timeout** (`DetailViewBody` L307-310) even when the entrance transform is still
animating, so `reposition()` measures the aside's **transformed (centre-scaled)**
rect; nothing re-measures after the transform settles (a ResizeObserver doesn't
fire on an ancestor transform), so the cluster freezes mid-screen. This is the
regression seen after exiting a stream (the detail view re-enters with the
entrance transform).

**Approach.** Keep the `entered` gate (it correctly skips the first mid-animation
measure), but after `entered` becomes true, **schedule a cascade of repositions**
at `requestAnimationFrame` + `~220 ms` + `~520 ms` (covering the entrance
transition + layout settle), in addition to the existing resize/scroll/RO
listeners. The final delayed measure lands post-settle, so the cluster can no
longer freeze on the transformed rect. Keep `opacity` gated on `pos.ready`. **Needs
on-hardware validation** (exit-a-stream repro).

**File:** `src/views/DetailView.tsx`.

---

## Part 9 — Suppress other notices when a Digital Release Filter notice is present

Decision: when a notice matches "Digital Release Filter", show **only** it.

**Approach.** In `StreamMetaBadges`, before building `allBuckets` (~L3085),
detect a Digital-Release-Filter notice across all buckets
(`m.title` or `m.description` matches `/digital release filter/i`). If present,
keep ONLY the matching message(s) (drop every other error/warning/info/stats
row). Apply the same suppression in the empty-state path
(`StreamMessagesEmptyState`, ~L3308) so it's consistent whether or not streams
were found. A small `suppressNoisyNotices(metadata)` helper keeps both call
sites in sync.

**File:** `src/views/DetailView.tsx`.

---

## Confirmed decisions
1. Notification → episode: **stay on the list + show synopsis** (set `activeVideo`,
   don't switch to streams).
2. Art retry: **null poster only**, **hourly forever**, bypassing the metaCache TTL
   (direct `fetch_meta_detail`), in-memory update only.
3. Digital Release Filter present → **only that notice** (ignore `forced`).
4. Unaired episode thumbnails: **series poster** (`detail.poster ?? detail.background`),
   cropped to 16:9.
5. Tint: **`bg-white/70`** (standard step; 72% would emit no CSS). Countdown: **size M**.

## Out of scope / notes
- No Rust changes. Ratings grouping keeps the existing 6-tile cap (a brand at the
  cap boundary may be truncated — acceptable).
- #8 is the only fragile item; its fix is conservative (additive re-measures) and
  must be eyeballed by exiting a stream.
- Episode-synopsis (#3) and notice-positioning (#8) both touch DetailView; tasks
  are sequenced to avoid edit collisions.
