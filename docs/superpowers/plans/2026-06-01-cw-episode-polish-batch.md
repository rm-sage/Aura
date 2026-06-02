# CW & Episode-Detail Polish Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four frontend polish fixes — one-line episode-drawer countdown, correct catalog-card year, notification→details deep-link with episode highlight, and CW airing-aware markers/tooltips/"episodes behind".

**Architecture:** Pure air-date logic (`airingInfo`) lives in `releaseCountdown.ts`; watched-aware "episodes behind" is a `useEpisodesBehind` hook in `LibraryContext.tsx` (where the watched infra already lives). The CW segmented bar gains a tint split + a floating accent dot; the next-episode pill is lifted to avoid the dot. Notification deep-link reuses DetailView's existing `openOnEpisodeId` season+scroll machinery, adding a separate `highlightEpisodeId` prop for the selection ring (so post-playback landings don't get the ring).

**Tech Stack:** React 19 + TypeScript, Tailwind. No Rust. No test framework — verification is `pnpm exec tsc --noEmit` (+ `cargo check` only if Rust is touched, which it isn't) plus on-hardware eyeball for the visual parts.

> **Verification per task:** `pnpm exec tsc --noEmit` (expected: exit 0, no errors). Visual tasks (4a marker/zoning, 4b tooltips, 3 ring) additionally need an on-hardware eyeball via `pnpm tauri dev` — flagged where they occur; a green tsc is necessary but not sufficient.

---

## Build order
1 (Part 1) → 2 (Part 2) → 3 (Part 4 shared helpers) → 4 (Part 4a marker) → 5 (Part 4b tooltips) → 6 (Part 4c behind count) → 7 (Part 3 deep-link). Tasks 4–6 depend on Task 3's helpers.

---

## Task 1: Part 1 — compact episode-drawer countdown

**Files:**
- Modify: `src/releaseCountdown.ts` — `formatCountdown` (L150-165)
- Modify: `src/EpisodeAirChip.tsx` — L24-37

- [ ] **Step 1: Add an opt-in `compactDays` arg to `formatCountdown`**

Replace `src/releaseCountdown.ts` L150-165 (the whole `formatCountdown` function) with:

```ts
export function formatCountdown(
  targetMs: number,
  nowMs: number = Date.now(),
  opts?: { compactDays?: boolean },
): string {
  let delta = targetMs - nowMs;
  if (delta <= 0) return "Released";
  const days = Math.floor(delta / DAY_MS);
  delta -= days * DAY_MS;
  const hours = Math.floor(delta / HOUR_MS);
  delta -= hours * HOUR_MS;
  const mins = Math.floor(delta / MIN_MS);
  delta -= mins * MIN_MS;
  const secs = Math.floor(delta / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Compact mode (opt-in, used by the narrow episode-drawer chip): at
  // day-scale the seconds are noise AND push the string past the 120px
  // cell, so drop them — "13d 12h 13m" instead of "13d 12h 13m 19s".
  if (days > 0 && opts?.compactDays) return `${days}d ${pad(hours)}h ${pad(mins)}m`;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
  if (hours > 0) return `${hours}h ${pad(mins)}m ${pad(secs)}s`;
  if (mins > 0) return `${mins}m ${pad(secs)}s`;
  return `${secs}s`;
}
```

- [ ] **Step 2: Use compact mode + nowrap in the drawer chip**

In `src/EpisodeAirChip.tsx`, add `whitespace-nowrap` to the pill `<span>` className (L26-28) and pass `compactDays`:

Change the `<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full` line to start `... gap-1 whitespace-nowrap px-2 py-0.5 ...`, and change L36 `{formatCountdown(targetMs, now)}` to:

```tsx
        {formatCountdown(targetMs, now, { compactDays: true })}
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` (exit 0).

- [ ] **Step 4: Commit**
```bash
git add src/releaseCountdown.ts src/EpisodeAirChip.tsx
git commit -m "fix(player): episode-drawer countdown fits one line (compact at day-scale)"
```

---

## Task 2: Part 2 — catalog card year matches details (canonical, reactive)

**Files:**
- Modify: `src/metaCache.ts` — add version store + `canonicalReleaseYear`
- Modify: `src/CinemaRows.tsx` — the catalog card year line (~L851)

- [ ] **Step 1: Add an external version store + canonical-year helper to metaCache**

In `src/metaCache.ts`: (a) add the version store near the top (after `const cache = new Map...`, ~L62); (b) bump it inside `getMetaDetail` after `cache.set` (L137); (c) export the helper + hook. Add this block after the `peekCachedDetailById` function (after L193):

```ts
// ── Reactive version store ────────────────────────────────────────────
// peekCachedDetailById is synchronous; a card that prefers the cached
// canonical year needs to re-render when a later meta fetch lands. We
// expose a useSyncExternalStore version that bumps on every cache write.
let metaCacheVersion = 0;
const metaCacheSubs = new Set<() => void>();
function bumpMetaCacheVersion() {
  metaCacheVersion += 1;
  for (const cb of metaCacheSubs) cb();
}
export function subscribeMetaCache(cb: () => void): () => void {
  metaCacheSubs.add(cb);
  return () => { metaCacheSubs.delete(cb); };
}
export function getMetaCacheVersion(): number { return metaCacheVersion; }

/** Canonical release year for a meta id from the cached MetaDetail, mirroring
 *  exactly what the hover panel / DetailView show (prefer release_info, else
 *  the year of `released`). Returns null when no detail is cached yet. */
export function canonicalReleaseYear(id: string): string | null {
  const d = peekCachedDetailById(id);
  if (!d) return null;
  return d.release_info || (d.released ? d.released.slice(0, 4) : null);
}
```

Add the React import + hook. At the top of `metaCache.ts`, the file currently imports only non-React things; add at the top:

```ts
import { useSyncExternalStore } from "react";
```

and add the hook next to the exports above:

```ts
/** Subscribe a component to meta-cache writes so synchronous peeks
 *  (canonicalReleaseYear, peekCachedDetailById) re-read when meta lands. */
export function useMetaCacheVersion(): number {
  return useSyncExternalStore(subscribeMetaCache, getMetaCacheVersion, getMetaCacheVersion);
}
```

Then bump on write: in `getMetaDetail`, change L137-138 from:
```ts
  cache.set(key, { detail, ts: Date.now() });
  schedulePersist();
```
to:
```ts
  cache.set(key, { detail, ts: Date.now() });
  bumpMetaCacheVersion();
  schedulePersist();
```

- [ ] **Step 2: Catalog card prefers the canonical year (reactive)**

In `src/CinemaRows.tsx`, the catalog card renders the year at ~L851 as
`{meta.release_info && (<p ...>{meta.release_info}</p>)}`. Read the exact current
lines first (`grep -n "meta.release_info" src/CinemaRows.tsx`). Add
`useMetaCacheVersion` to the catalog-card component body (call it near the top of
that component so it subscribes), import it, and compute the displayed year:

Import (extend the existing metaCache import in CinemaRows, or add):
```ts
import { canonicalReleaseYear, useMetaCacheVersion } from "./metaCache";
```
In the catalog card component body add:
```ts
  useMetaCacheVersion(); // re-render when a meta fetch corrects the year
  const displayYear = canonicalReleaseYear(meta.id) ?? meta.release_info;
```
Replace the year `<p>` render to use `displayYear`:
```tsx
        {displayYear && (
          <p className="text-white/55 text-[15.5px] mt-0.5 text-center font-mono">{displayYear}</p>
        )}
```
(Match the exact existing className when editing.)

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` (exit 0).

- [ ] **Step 4: Commit**
```bash
git add src/metaCache.ts src/CinemaRows.tsx
git commit -m "fix(catalog): card year prefers canonical cached meta year (reactive)"
```

---

## Task 3: Part 4 shared — `airingInfo` (pure) + `useEpisodesBehind` (hook)

**Files:**
- Modify: `src/releaseCountdown.ts` — add `airingInfo`
- Modify: `src/LibraryContext.tsx` — add `useEpisodesBehind`

- [ ] **Step 1: Add `airingInfo` to releaseCountdown.ts**

Add after `nextAiringEpisode` (after L138) in `src/releaseCountdown.ts`. Needs
`isVideoAired` from types — extend the existing `import type { MetaDetail, VideoEntry } from "./types";`
to a value import for `isVideoAired`:
```ts
import type { MetaDetail, VideoEntry } from "./types";
import { isVideoAired } from "./types";
```
```ts
/** Airing snapshot for a series' episode list. Single source of truth for the
 *  CW latest-aired marker (4a) and the "episodes behind" count (4c).
 *  - isAiring: at least one aired episode AND at least one not-yet-aired
 *    episode (has content out, not finished).
 *  - latestAiredId / latestAiredEpisode: the highest-released episode with
 *    released <= now.
 *  - airedCount: episodes whose air date is in the past. */
export function airingInfo(
  videos: VideoEntry[] | undefined,
  nowMs: number = Date.now(),
): { isAiring: boolean; latestAiredId: string | null; latestAiredEpisode: number | null; airedCount: number } {
  let airedCount = 0;
  let anyFuture = false;
  let latestAiredId: string | null = null;
  let latestAiredEpisode: number | null = null;
  let latestAiredMs = -Infinity;
  for (const v of videos ?? []) {
    const t = parseMs(v.released);
    if (t == null) continue;
    if (t <= nowMs) {
      airedCount += 1;
      if (t > latestAiredMs) {
        latestAiredMs = t;
        latestAiredId = v.id;
        latestAiredEpisode = v.episode ?? null;
      }
    } else {
      anyFuture = true;
    }
  }
  return { isAiring: airedCount > 0 && anyFuture, latestAiredId, latestAiredEpisode, airedCount };
}
```

- [ ] **Step 2: Add `useEpisodesBehind` to LibraryContext.tsx**

`episodeIsBeforeResume` (L107) is already in this module. Add the hook at the end
of `src/LibraryContext.tsx` (after `useResumeVideoId`, L213). Confirm/add imports
at the top of the file:
```ts
import { airingInfo } from "./releaseCountdown";
import { isVideoAired, type VideoEntry } from "./types";
import { getManualWatchedState, useManualWatchedVersion } from "./manualWatched";
```
```ts
/** "Episodes behind the latest aired" for an AIRING series (else null).
 *  N = airedCount − fully-watched aired episodes. A fully-watched aired
 *  episode is one manually marked watched OR inferred-before-resume; the
 *  in-progress resume episode is NOT counted (matches AniMouto: 2 behind /
 *  7 watched). Returns null when not airing or when behind <= 0. Red-text
 *  "N episodes behind" surfaces on DetailView meta + the hover panel. */
export function useEpisodesBehind(
  videos: VideoEntry[] | undefined,
  seriesId: string | null | undefined,
): number | null {
  void useManualWatchedVersion();
  const resumeId = useResumeVideoId(seriesId);
  if (!videos || videos.length === 0) return null;
  const info = airingInfo(videos);
  if (!info.isAiring) return null;
  let watchedAired = 0;
  for (const v of videos) {
    if (!isVideoAired(v)) continue;
    const manual = getManualWatchedState(v.id);
    if (manual === "watched") { watchedAired += 1; continue; }
    if (resumeId && v.id !== resumeId && episodeIsBeforeResume(v.id, resumeId)) watchedAired += 1;
  }
  const behind = Math.max(0, info.airedCount - watchedAired);
  return behind > 0 ? behind : null;
}
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` (exit 0). (Watch for an import cycle warning between LibraryContext ↔ releaseCountdown; both are leaf-ish — releaseCountdown imports only `./types`, so no cycle.)

- [ ] **Step 4: Commit**
```bash
git add src/releaseCountdown.ts src/LibraryContext.tsx
git commit -m "feat(cw): shared airingInfo + useEpisodesBehind for airing-aware UI"
```

---

## Task 4: Part 4a — CW segmented bar tint + latest-aired dot (+ dot↔countdown zoning)

**Files:**
- Modify: `src/CinemaRows.tsx` — `SegmentedSeasonBar` (L181-200), `ContinuousProgressBar` (L290-294), `CWReleaseCountdown` (L546)

- [ ] **Step 1: Tint aired-unwatched + render the dot in `SegmentedSeasonBar`**

Import `airingInfo` (extend the existing releaseCountdown import in CinemaRows). In
`SegmentedSeasonBar`, before the `return`, compute airing + latest-aired index:
```ts
  const air = airingInfo(episodes);
  const latestAiredIdx = air.isAiring && air.latestAiredId
    ? episodes.findIndex((v) => v.id === air.latestAiredId)
    : -1;
```
Replace the segment map (L183-198) so the faint branch splits aired-unwatched vs
not-yet-aired and the latest-aired segment carries the dot:
```tsx
      {episodes.map((ep, i) => {
        const manual = getManualWatchedState(ep.id);
        let cls: string;
        if (manual === "watched") {
          cls = "bg-emerald-400";
        } else if ((manual === "in-progress" || i === currentIdx) && i >= lastWatchedIdx) {
          cls = "bg-amber-400";
        } else if (i < impliedThroughIdx) {
          cls = "bg-emerald-400/85"; // implied-watched
        } else if (isVideoAired(ep)) {
          cls = "bg-white/35"; // aired but unwatched — available to watch now
        } else {
          cls = "bg-white/15"; // not yet aired
        }
        return (
          <div key={ep.id} className={`relative flex-1 h-full ${cls}`}>
            {i === latestAiredIdx && (
              <span
                aria-hidden
                className="absolute -top-[7px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full z-20"
                style={{
                  background: "#5BA4FF",
                  boxShadow: "0 0 6px 2px rgba(91,164,255,0.5), 0 0 0 1px rgba(0,0,0,0.55)",
                }}
              />
            )}
          </div>
        );
      })}
```
(`isVideoAired` is already imported in CinemaRows — confirmed L8.)

- [ ] **Step 2: Frontier line on the continuous (long-runner) bar**

In `ContinuousProgressBar`, after computing `fillStyle` (before the `return` at
L290), add airing + position:
```ts
  const air = airingInfo(episodes);
  const latestAiredIdx = air.isAiring && air.latestAiredId
    ? episodes.findIndex((v) => v.id === air.latestAiredId)
    : -1;
  const frontierPct = latestAiredIdx >= 0 ? ((latestAiredIdx + 1) / total) * 100 : null;
```
Add the line inside the bar container (the `return` at L290-293), after the fill div:
```tsx
      {frontierPct != null && (
        <div
          aria-hidden
          className="absolute -top-[3px] -bottom-[3px] w-[2px] rounded-[2px] z-20"
          style={{ left: `${frontierPct}%`, background: "#5BA4FF", boxShadow: "0 0 6px 1px rgba(91,164,255,0.5)" }}
        />
      )}
```
(The container has `overflow-hidden`; change it to allow the line/dot to extend
slightly above — set the wrapper to `overflow-visible` OR keep `overflow-hidden`
on the fill and lift the marker to a sibling. SIMPLER: the continuous bar's outer
div uses `overflow-hidden` to clip the fill; wrap the fill in its own
`overflow-hidden` inner and put the frontier line as a sibling of that inner div
so it isn't clipped. Implement by changing the outer to `overflow-visible` and
adding `overflow-hidden rounded-full` to the fill wrapper.)

- [ ] **Step 3: Lift the countdown pill above the dot band (non-conflict)**

In `CWReleaseCountdown` (L546), change the outer div's `bottom-2.5` so the pill
clears the dot (dot top ≈ 16px, reaches ~25px with glow). Use `bottom-[28px]`:
```tsx
    <div className="absolute inset-x-0 bottom-[28px] flex justify-center pointer-events-none z-10">
```
This vertically zones the pill (upper) above the dot (lower) regardless of which
segment is latest-aired.

- [ ] **Step 4: Verify (build)** — `pnpm exec tsc --noEmit` (exit 0).

- [ ] **Step 5: Verify (on hardware)** — `pnpm tauri dev`; on an airing series CW
  card confirm: the available-but-unaired episodes read as a brighter grey, a blue
  dot sits above the latest-aired segment, and the next-episode pill sits clearly
  ABOVE the dot with no overlap (test a card where the latest-aired segment is near
  centre). Confirm a COMPLETED series shows no dot/tint change. Tune `bottom-[28px]`
  if the pill looks too high/low.

- [ ] **Step 6: Commit**
```bash
git add src/CinemaRows.tsx
git commit -m "feat(cw): latest-aired marker (G-dot) + aired-unwatched tint on segmented bar"
```

---

## Task 5: Part 4b — per-segment + countdown tooltips

**Files:**
- Modify: `src/CinemaRows.tsx` — `SegmentedSeasonBar` (single mousemove tooltip), `CWReleaseCountdown` (chip title)

- [ ] **Step 1: Single mousemove-driven tooltip on the segmented bar**

Wrap `SegmentedSeasonBar`'s bar `<div>` so it can host a tooltip. Add local state
and a handler at the top of the component:
```ts
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);
```
Add a helper to label a segment's state (place above the `return`):
```ts
  const segLabel = (ep: VideoEntry, i: number): string => {
    const sxe = ep.season != null && ep.episode != null
      ? `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`
      : (ep.episode != null ? `E${ep.episode}` : "Episode");
    const manual = getManualWatchedState(ep.id);
    let state: string;
    if (manual === "watched" || (i < impliedThroughIdx)) state = "Watched";
    else if ((manual === "in-progress" || i === currentIdx) && i >= lastWatchedIdx) state = "In progress";
    else if (isVideoAired(ep)) state = "Available now";
    else state = "Not yet aired";
    return i === latestAiredIdx ? `${sxe} · ${state} · Latest aired` : `${sxe} · ${state}`;
  };
```
Change the bar wrapper to relative + add mouse handlers + the tooltip element.
Replace the bar `<div className="absolute left-2 right-2 bottom-1 ...">` opening
to add `onMouseMove`/`onMouseLeave` that compute the hovered index from cursor x:
```tsx
    <div
      className="absolute left-2 right-2 bottom-1 h-[5px] flex gap-[1.5px] rounded-full"
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
        const idx = Math.min(episodes.length - 1, Math.floor(frac * episodes.length));
        setTip({ x: e.clientX - r.left, text: segLabel(episodes[idx], idx) });
      }}
      onMouseLeave={() => setTip(null)}
    >
```
(Note: removed `overflow-hidden` from the wrapper so the dot/tooltip can sit above
it; the dot already self-clips via z-index. Keep `rounded-full`.) After the
`episodes.map(...)`, add the tooltip child (inside the bar div):
```tsx
      {tip && (
        <div
          className="pointer-events-none absolute -top-7 z-30 px-2 py-0.5 rounded-md
                     bg-black/85 backdrop-blur-sm border border-white/15
                     text-white text-[11px] font-medium whitespace-nowrap -translate-x-1/2"
          style={{ left: tip.x }}
        >
          {tip.text}
        </div>
      )}
```

- [ ] **Step 2: Tooltip on the next-episode countdown chip**

In `CWReleaseCountdown`, give the pill `<span>` a `title` explaining it (it's the
fastest reliable tooltip and the pill is `pointer-events-none` on the wrapper, so
move pointer events onto the span). Change the wrapper to allow hover and add the
title. Replace L546-552 region: set the wrapper to keep `pointer-events-none` but
add `title` to the span and make the span `pointer-events-auto`:
```tsx
    <div className="absolute inset-x-0 bottom-[28px] flex justify-center pointer-events-none z-10">
      <span
        title={`Next episode airs ${formatTargetDate(targetMs)}`}
        className="pointer-events-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full
                   bg-black/72 backdrop-blur-sm border border-white/15
                   text-white text-[11px] font-semibold tabular-nums"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}
      >
```
Import `formatTargetDate` (extend the releaseCountdown import in CinemaRows).

- [ ] **Step 3: Verify (build)** — `pnpm exec tsc --noEmit` (exit 0).

- [ ] **Step 4: Verify (on hardware)** — hover bar segments: tooltip shows
  `SxxEyy · {Watched|In progress|Available now|Not yet aired}` (+ `· Latest aired`
  on the frontier); hover the countdown pill: shows the air date. Confirm hover
  tracking is smooth across segments.

- [ ] **Step 5: Commit**
```bash
git add src/CinemaRows.tsx
git commit -m "feat(cw): per-segment + countdown tooltips on the segmented bar"
```

---

## Task 6: Part 4c — "N episodes behind" (red) on DetailView + hover panel

**Files:**
- Modify: `src/views/DetailView.tsx` — meta strip (read L1050-1145 for exact anchor)
- Modify: `src/CatalogHoverCard.tsx` — after metaBits render (L365-369)

- [ ] **Step 1: DetailView meta strip**

In `src/views/DetailView.tsx`, import the hook:
```ts
import { useEpisodeProgress, useResumeVideoId, useEpisodesBehind } from "../LibraryContext";
```
In `DetailViewBody`, compute (near the other detail-derived values):
```ts
  const episodesBehind = useEpisodesBehind(detail?.videos, meta.id);
```
Read the meta-strip JSX (`grep -n "Runtime" src/views/DetailView.tsx` ~L1066-1142)
and insert, after the runtime `<Stat>`, a red indicator:
```tsx
        {episodesBehind != null && (
          <span className="text-red-400 text-[13px] font-semibold">
            {episodesBehind} episode{episodesBehind === 1 ? "" : "s"} behind
          </span>
        )}
```
(Match the surrounding flex/gap container so it sits inline with the other stats.)

- [ ] **Step 2: Hover panel**

In `src/CatalogHoverCard.tsx`, import + compute:
```ts
import { useEpisodesBehind } from "./LibraryContext";
```
Near the other derived values (after `metaBits`, ~L297):
```ts
  const episodesBehind = useEpisodesBehind(detail?.videos, meta.id);
```
Render a red line right after the metaBits `<p>` (after L369):
```tsx
      {episodesBehind != null && (
        <p className="text-red-400 text-[12px] font-semibold mt-1">
          {episodesBehind} episode{episodesBehind === 1 ? "" : "s"} behind
        </p>
      )}
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit` (exit 0). On hardware: an
  airing series you're behind on shows red "N episodes behind" on both the details
  meta row and the hover panel; a caught-up or completed series shows nothing.

- [ ] **Step 4: Commit**
```bash
git add src/views/DetailView.tsx src/CatalogHoverCard.tsx
git commit -m "feat(detail): red 'N episodes behind' for airing series (meta + hover)"
```

---

## Task 7: Part 3 — notification → details (season + episode selected + ring)

**Files:**
- Modify: `src/App.tsx` — `onOpenMeta` (L5072), prop type (L5688), `aura:open-meta` handler (L5811-5827), new deep-link state, DetailView props (L5569-5571)
- Modify: `src/views/DetailView.tsx` — new `highlightEpisodeId` prop → EpisodesPanel → EpisodeRow ring
- Read-only confirm: `src/NotificationsPanel.tsx` already dispatches `videoId`

- [ ] **Step 1: App — thread videoId into the deep-link + a ring hint**

Add deep-link ring state near `lastPlayedEpisodeId` (L4498-4499):
```ts
  const [deepLinkEpisodeId, setDeepLinkEpisodeId] = useState<string | null>(null);
  const consumeDeepLinkEpisode = useCallback(() => setDeepLinkEpisodeId(null), []);
```
Extend `onOpenMeta` (L5072) signature + body — accept `videoId` and set BOTH the
season+scroll hint (`lastPlayedEpisodeId`) and the ring hint (`deepLinkEpisodeId`):
```tsx
      onOpenMeta={(metaId, mediaType, videoId) => {
```
and just before `openDetail(stub);` (L5113):
```tsx
        if (videoId) {
          setLastPlayedEpisodeId(videoId); // season select + scroll-to-row
          setDeepLinkEpisodeId(videoId);   // selection ring (notif only)
        }
        openDetail(stub);
```
Extend the prop type (L5688):
```ts
  onOpenMeta: (metaId: string, mediaType?: string, videoId?: string) => void;
```
Extend the `aura:open-meta` handler (L5811-5827) to read + forward `videoId`:
```tsx
    const detail = (e as CustomEvent).detail as {
      metaId?: string;
      mediaType?: string;
      videoId?: string;
    } | undefined;
    if (!detail?.metaId) return;
    onOpenMeta(detail.metaId, detail.mediaType, detail.videoId);
```
Pass the ring hint to DetailView (L5569-5571 area):
```tsx
          openOnEpisodeId={lastPlayedEpisodeId}
          onConsumeOpenHint={consumeLastPlayedEpisode}
          highlightEpisodeId={deepLinkEpisodeId}
          onConsumeHighlight={consumeDeepLinkEpisode}
```

- [ ] **Step 2: DetailView — accept the ring hint, thread to EpisodesPanel**

Add props to the `Props` interface (near `openOnEpisodeId`, L159-163):
```ts
  /** When set, the episode row matching this id gets a persistent selection
   *  ring (notification deep-link). Distinct from openOnEpisodeId (which only
   *  selects season + scrolls). */
  highlightEpisodeId?: string | null;
  onConsumeHighlight?: () => void;
```
Destructure them in `DetailViewBody` (L279). Add a stable local copy + consume the
parent hint on mount (mirror `scrollOnceTo`, L422-424):
```ts
  const [ringEpisodeId] = useState<string | null>(highlightEpisodeId ?? null);
  useEffect(() => { if (highlightEpisodeId) onConsumeHighlight?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
```
Thread it to the EpisodesPanel render (the `<EpisodesPanel .../>` at ~L1408, where
`scrollToVideoId={scrollOnceTo}` is passed) — add:
```tsx
            highlightVideoId={ringEpisodeId}
```
And through the intermediate panel wrapper if there is one (the L2167 EpisodesPanel
signature and the L2203-2206 pass-through) — add `highlightVideoId` to both prop
types and forward it.

- [ ] **Step 3: EpisodesPanel — resolve + pass `isDeepLinked` to the row**

In the inner EpisodesPanel (signature L2606), add `highlightVideoId?: string | null`
to params + type. Resolve it to the current videos shape (mirror `resolvedScrollTarget`):
```ts
  const highlightId = useMemo(
    () => resolveResumeEpisode(highlightVideoId, videos)?.id ?? highlightVideoId ?? null,
    [videos, highlightVideoId],
  );
```
At the episode list render (L2867-2875), pass to `EpisodeRow`:
```tsx
                  <EpisodeRow
                    ...
                    isDeepLinked={v.id === highlightId}
```

- [ ] **Step 4: EpisodeRow — render the selection ring**

In `EpisodeRow` (signature L2243-2258), add `isDeepLinked?: boolean` to params +
type. Apply a ring to the row's outer element (read the row's root className first,
~L2270+). Add, conditionally, `ring-1 ring-ln-accent/70 ring-offset-1 ring-offset-black/40`
(or the project's accent ring pattern) when `isDeepLinked`. Concretely, append to
the root className template:
```tsx
${isDeepLinked ? " ring-2 ring-ln-accent/80 rounded-lg" : ""}
```
(Confirm the row root is a single element that can take a ring; if it's already
`rounded`, omit the duplicate radius.)

- [ ] **Step 5: Verify (build)** — `pnpm exec tsc --noEmit` (exit 0).

- [ ] **Step 6: Verify (on hardware)** — click an episode-release notification:
  details opens, the correct season is selected, the released episode is scrolled
  into view AND shows the accent ring. Confirm a normal post-playback return does
  NOT show the ring (only the notification path sets `deepLinkEpisodeId`).

- [ ] **Step 7: Commit**
```bash
git add src/App.tsx src/views/DetailView.tsx
git commit -m "feat(notif): clicking an episode notification opens details at that season+episode, selected"
```

---

## Self-review notes
- **Spec coverage:** Task 1 = Part 1; Task 2 = Part 2; Task 3 = Part 4 shared helpers; Task 4 = Part 4a (marker + tint + dot↔countdown zoning); Task 5 = Part 4b (tooltips); Task 6 = Part 4c (behind count); Task 7 = Part 3 (deep-link + ring). All spec sections mapped.
- **Type/name consistency:** `airingInfo` returns `{isAiring, latestAiredId, latestAiredEpisode, airedCount}` — consumers use `isAiring`/`latestAiredId`/`airedCount`. `useEpisodesBehind(videos, seriesId)` used identically in Tasks 6's two sites. `canonicalReleaseYear`/`useMetaCacheVersion` consistent across Task 2. `highlightEpisodeId`→`highlightVideoId`→`isDeepLinked` chain consistent across Task 7.
- **Anchors to re-read at edit time (line numbers may drift; match on code strings):** CinemaRows catalog-card year line; DetailView meta strip (around "Runtime"); DetailView EpisodesPanel pass-through + EpisodeRow root className; CatalogHoverCard metaBits render.
- **Landmines:** none — frontend-only, no mpv/Rust, no observed-property changes.
