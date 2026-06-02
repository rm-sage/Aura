# CW & Detail Polish v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nine frontend polish fixes — CW countdown/tint, portal'd tooltip, ratings grouping, missing-art retry, notif synopsis, unaired episode art, and two streams-notice fixes.

**Architecture:** Mostly localized edits in `CinemaRows.tsx` and `DetailView.tsx`, plus one new `libraryArtRetry.ts` hook and one shared `groupRatingsByBrand` helper. No Rust.

**Tech Stack:** React 19 + TypeScript, Tailwind. No test framework — verification is `pnpm exec tsc --noEmit`; visual/timing items (#1,#2,#6,#8) also need an on-hardware eyeball (flagged).

> **Verify per task:** `pnpm exec tsc --noEmit` (exit 0). Line numbers below are approximate (the files have drifted) — match on the quoted code strings, not line numbers.

---

## Task 1: CW countdown size M + brighter 'available' tint (Parts 1, 2)

**Files:** Modify `src/CinemaRows.tsx`.

- [ ] **Step 1: Countdown pill → size M.** In `CWReleaseCountdown`, change the pill `<span>` class `... gap-1 px-2 py-0.5 ... text-white text-[11px] ...` to:
```
pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-black/72 backdrop-blur-sm border border-white/15 text-white text-[12.5px] font-semibold tabular-nums
```
and the clock `<svg width="11" height="11"` → `width="12" height="12"`.

- [ ] **Step 2: 'Available now' tint → bright white.** In `SegmentedSeasonBar`, change `cls = "bg-white/35"; // aired but unwatched` to `cls = "bg-white/70"; // aired but unwatched — available to watch now`.

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit` (exit 0). On hardware: countdown reads a touch larger; available-segment tint clearly brighter than not-aired.

- [ ] **Step 4: Commit**
```bash
git add src/CinemaRows.tsx
git commit -m "feat(cw): larger next-ep countdown + brighter 'available now' tint"
```

---

## Task 2: Portal the CW segment tooltip (Part 4)

**Files:** Modify `src/CinemaRows.tsx`.

- [ ] **Step 1: Track viewport coords + portal the tooltip.** In `SegmentedSeasonBar`: change the tip state to viewport coords, the mousemove handler to store `clientX/clientY`, and render via `createPortal`. Confirm `createPortal` is imported (`import { createPortal } from "react-dom";` at top — add if missing).

Change the tip state:
```tsx
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
```
Change the bar's `onMouseMove` to store viewport coords (keep the index math):
```tsx
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const frac = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / r.width));
        const idx = Math.min(episodes.length - 1, Math.floor(frac * episodes.length));
        setTip({ x: e.clientX, y: r.top, text: segLabel(episodes[idx], idx) });
      }}
```
Replace the inline tooltip `<div>` (the `{tip && (<div className="pointer-events-none absolute -top-7 …">…</div>)}` block) with a portal render. Remove it from inside the bar `<div>` and instead render after it (still inside the component return, as a sibling) :
```tsx
      {tip && createPortal(
        <div
          className="pointer-events-none fixed z-[300] px-2 py-0.5 rounded-md
                     bg-black/85 backdrop-blur-sm border border-white/15
                     text-white text-[11px] font-medium whitespace-nowrap -translate-x-1/2 -translate-y-full"
          style={{
            left: Math.max(60, Math.min(window.innerWidth - 60, tip.x)),
            top: tip.y - 6,
          }}
        >
          {tip.text}
        </div>,
        document.body,
      )}
```
(The `-translate-y-full` + `top: tip.y - 6` places it just above the bar; the `left` clamp keeps it on-screen. It's `fixed` in `document.body` so the card's `overflow-hidden` no longer clips it.)

- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit`. On hardware: hover a CW bar near the row's left/right edge — the tooltip is no longer clipped.

- [ ] **Step 3: Commit**
```bash
git add src/CinemaRows.tsx
git commit -m "fix(cw): portal the segment tooltip so it isn't clipped at card edges"
```

---

## Task 3: Group rating tiles by brand (Part 7)

**Files:** Modify `src/logodev.tsx` (add helper), `src/views/DetailView.tsx`, `src/CatalogHoverCard.tsx`.

- [ ] **Step 1: Add `groupRatingsByBrand` next to `ratingDomain` in `src/logodev.tsx`.**
```tsx
/** Stable regroup so same-brand rating rows sit together (e.g. all MAL tiles:
 *  score + rank + popularity, which carry different `source` strings). Preserves
 *  the input order WITHIN and BETWEEN brands — so callers sort by weight first,
 *  then this clusters by brand with each brand positioned at its highest-weight
 *  (= first-seen) member. Unknown sources (ratingDomain null) group on the
 *  lowercased source string. */
export function groupRatingsByBrand<T extends { source: string }>(rows: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = ratingDomain(r.source) ?? r.source.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(r);
  }
  return order.flatMap((k) => groups.get(k)!);
}
```

- [ ] **Step 2: Apply in DetailView.** In `src/views/DetailView.tsx`, the `mergedRatings` useMemo ends with `return [...map.values()].sort((a, b) => { … });`. Wrap the sorted result: change the final `return [...map.values()].sort(…);` to assign and group. Add `groupRatingsByBrand` to the logodev import, then:
```tsx
    const sorted = [...map.values()].sort((a, b) => {
      if (isAnime) {
        const ai = ANIME_FIRST.indexOf(a.source.toLowerCase());
        const bi = ANIME_FIRST.indexOf(b.source.toLowerCase());
        if (ai !== bi) {
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        }
      }
      return (b.weight ?? 50) - (a.weight ?? 50);
    });
    return groupRatingsByBrand(sorted);
```
(The render already does `.slice(0, 6)` — leave it.)

- [ ] **Step 3: Apply in CatalogHoverCard.** In `src/CatalogHoverCard.tsx`, the `ratings` IIFE ends with `return [...map.values()].sort((a, b) => (b.weight ?? 50) - (a.weight ?? 50)).slice(0, 6);`. Change to group before slicing:
```tsx
    return groupRatingsByBrand(
      [...map.values()].sort((a, b) => (b.weight ?? 50) - (a.weight ?? 50)),
    ).slice(0, 6);
```
Add `groupRatingsByBrand` to the logodev import in CatalogHoverCard (it already imports `BrandLogo, ratingDomain, ratingKindNote` from `./logodev`).

- [ ] **Step 4: Verify** `pnpm exec tsc --noEmit`. On hardware: the MAL score/rank/popularity tiles sit adjacent on both the detail meta strip and the hover panel.

- [ ] **Step 5: Commit**
```bash
git add src/logodev.tsx src/views/DetailView.tsx src/CatalogHoverCard.tsx
git commit -m "fix(ratings): group rating tiles by brand (all MAL tiles adjacent)"
```

---

## Task 4: Hourly retry for Library items missing a poster (Part 5)

**Files:** Create `src/libraryArtRetry.ts`; modify `src/App.tsx`.

- [ ] **Step 1: Create `src/libraryArtRetry.ts`.**
```tsx
// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, LibraryItem, MetaDetail } from "./types";

// Per-id throttle persisted to localStorage so we don't hammer addons for
// genuinely art-less (often unreleased) items. Retry ~hourly, indefinitely:
// unreleased titles gain a poster as they approach release.
const KEY = "aura:art-retry:v1";
const HOUR_MS = 60 * 60 * 1000;
const CONCURRENCY = 4;

function loadAttempts(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>; }
  catch { return {}; }
}
function saveAttempts(a: Record<string, number>) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* quota — ignore */ }
}

/** Fire-and-forget hourly retry: for Library items with a null poster whose last
 *  attempt was >= 1h ago, query meta-capable addons directly (bypassing the
 *  metaCache TTL) until one returns a poster; call applyPoster(id, poster) on
 *  success. In-memory only — never mutates the Stremio cloud record. */
export function useLibraryArtRetry(
  library: LibraryItem[],
  addons: AddonEntry[] | undefined,
  applyPoster: (id: string, poster: string) => void,
) {
  const running = useRef(false);
  const libRef = useRef(library);
  libRef.current = library;
  const addonsRef = useRef(addons);
  addonsRef.current = addons;

  useEffect(() => {
    const run = async () => {
      if (running.current) return;
      const items = libRef.current;
      const adds = addonsRef.current;
      if (!adds || adds.length === 0 || items.length === 0) return;
      const metaAddons = adds.filter((a) =>
        Array.isArray(a.resources) && a.resources.some((r) => r.toLowerCase() === "meta"));
      if (metaAddons.length === 0) return;

      const now = Date.now();
      const attempts = loadAttempts();
      const due = items.filter((it) =>
        !it.poster && !it.removed && (now - (attempts[it.id] ?? 0) >= HOUR_MS));
      if (due.length === 0) return;

      running.current = true;
      try {
        for (let i = 0; i < due.length; i += CONCURRENCY) {
          const batch = due.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (it) => {
            attempts[it.id] = Date.now();
            for (const a of metaAddons) {
              try {
                const d = await invoke<MetaDetail | null>("fetch_meta_detail", {
                  addonUrl: a.url, mediaType: it.media_type, id: it.id,
                }).catch(() => null);
                if (d?.poster) { applyPoster(it.id, d.poster); return; }
              } catch { /* try next addon */ }
            }
          }));
        }
      } finally {
        saveAttempts(attempts);
        running.current = false;
      }
    };
    // Initial run shortly after mount, then hourly.
    const t = setTimeout(run, 4000);
    const id = setInterval(run, HOUR_MS);
    return () => { clearTimeout(t); clearInterval(id); };
  }, []); // refs keep library/addons fresh without resetting the timer
}
```

- [ ] **Step 2: Wire into App.tsx.** Near the existing background poster-warm in `src/App.tsx`, import and call the hook with an `applyPoster` that updates library state:
```tsx
import { useLibraryArtRetry } from "./libraryArtRetry";
```
In the App component body (where `library`/`setLibrary`/`addons` are in scope):
```tsx
  useLibraryArtRetry(library, addons, (id, poster) => {
    setLibrary((prev) => prev.map((it) => (it.id === id && !it.poster ? { ...it, poster } : it)));
  });
```
(Confirm the exact `addons` variable name in App — it may be `addons` or from a context; match it.)

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit`. On hardware (optional): an art-less Library item gets a poster within the hour if an addon has one.

- [ ] **Step 4: Commit**
```bash
git add src/libraryArtRetry.ts src/App.tsx
git commit -m "feat(library): hourly retry to backfill missing posters (in-memory)"
```

---

## Task 5: Notification click shows the episode synopsis (Part 3)

**Files:** Modify `src/views/DetailView.tsx`.

- [ ] **Step 1: Set activeVideo from the deep-link hint (stay on the list).** In `DetailViewBody`, near the resume effect that sets `activeVideo` from `resumeVideoId` (the `useEffect` that does `const v = resolveResumeEpisode(resumeVideoId, detail?.videos); if (v) setActiveVideo(v);`), add a parallel effect keyed on the ring hint (`ringEpisodeId`, the stable local copy of `highlightEpisodeId`):
```tsx
  // Notification deep-link: populate the episode synopsis by selecting the
  // ringed episode — WITHOUT switching to streams mode (stay on the list so the
  // user sees the ring + scroll + synopsis together). Guarded so it never
  // fights a real episode click (which routes to streams).
  useEffect(() => {
    if (!ringEpisodeId) return;
    if (activeVideo) return;
    if (panelMode === "streams") return;
    if (!isEpisodic) return;
    const v = resolveResumeEpisode(ringEpisodeId, detail?.videos);
    if (v) setActiveVideo(v);
  }, [ringEpisodeId, detail?.videos, panelMode, isEpisodic, activeVideo]);
```

- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit`. On hardware: click an episode-release notification → land on the episode list with that episode ringed AND its synopsis shown below.

- [ ] **Step 3: Commit**
```bash
git add src/views/DetailView.tsx
git commit -m "feat(notif): deep-linked episode populates its synopsis on the list"
```

---

## Task 6: Unaired episodes show series poster (Part 6)

**Files:** Modify `src/views/DetailView.tsx`.

- [ ] **Step 1: Thread series art down to EpisodeRow.** Compute the series art in `DetailViewBody` (where `detail`/`meta` are in scope): `const episodeFallbackArt = detail?.poster ?? detail?.background ?? meta.poster ?? null;`. Pass it to `<UnifiedPanel … seriesArt={episodeFallbackArt} />`, add `seriesArt?: string | null` to `PanelProps` + destructure, forward to `<EpisodesPanel … seriesArt={seriesArt} />`, add to EpisodesPanel's params/type, and forward to `<EpisodeRow … seriesArt={seriesArt} />` in the list map. Add `seriesArt?: string | null` to EpisodeRow's params + inline type. (Mirror the existing `highlightVideoId` threading from the prior batch.)

- [ ] **Step 2: Render series art for unaired rows.** In `EpisodeRow`, the thumbnail block renders `video.thumbnail` with `${shouldBlur ? "blur-md scale-110" : ""}`. Change so an `unaired` episode shows `seriesArt` (no blur) instead:
```tsx
        {unaired && seriesArt ? (
          <ImageLoader
            src={seriesArt}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
          />
        ) : video.thumbnail ? (
          <ImageLoader
            src={video.thumbnail}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName={`w-full h-full object-cover transition-[filter] duration-300
                           ${shouldBlur ? "blur-md scale-110" : ""}`}
          />
        ) : null}
```
The existing unaired veil (`{unaired && <div … bg-black/45 />}`) stays — it dims the series art so the row text + EpisodeAirChip read cleanly on both light and dark posters. The anti-spoiler blur veil (`{shouldBlur && video.thumbnail && …}`) is unchanged (it only applies to the real-thumbnail branch).

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit`. On hardware: unaired episodes of an airing show show the series poster (not a blurred frame), and the air-countdown chip stays legible.

- [ ] **Step 4: Commit**
```bash
git add src/views/DetailView.tsx
git commit -m "feat(detail): unaired episodes show series poster instead of a blurred thumb"
```

---

## Task 7: Fix AIOStreams notice cluster mis-position on stream re-entry (Part 8)

**Files:** Modify `src/views/DetailView.tsx`.

- [ ] **Step 1: Re-measure on a cascade after `entered` flips.** In `StreamMetaBadges`, the `useLayoutEffect` gated on `entered` calls `reposition()` once then adds listeners. After `entered` is true, also schedule delayed re-measures so a transform that settles AFTER the 480ms `entered` fallback timeout doesn't leave the cluster frozen on the centre-scaled rect. Replace the body of that effect's post-gate section:
```tsx
  useLayoutEffect(() => {
    if (!entered) return;
    reposition();
    // The entrance transform can still be settling when `entered` flips via the
    // 480ms fallback timeout (no transitionend fired) — the aside's rect is then
    // the centre-scaled one and nothing re-measures (a ResizeObserver doesn't
    // fire on an ancestor transform). Re-measure on a short cascade so the final
    // position lands post-settle and the cluster can't freeze mid-screen.
    const raf = requestAnimationFrame(reposition);
    const t1 = setTimeout(reposition, 220);
    const t2 = setTimeout(reposition, 520);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const el = anchorRef.current;
    const ro = el ? new ResizeObserver(reposition) : null;
    if (ro && el) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      ro?.disconnect();
    };
  }, [entered, reposition, anchorRef]);
```

- [ ] **Step 2: Verify** `pnpm exec tsc --noEmit`. **On hardware (required):** open a title with addon notices, play a stream, exit back to the detail/streams view, and confirm the notice cluster anchors to the streams panel's bottom-left (not frozen mid-screen). Repeat a few times.

- [ ] **Step 3: Commit**
```bash
git add src/views/DetailView.tsx
git commit -m "fix(streams): notice cluster re-measures post-entrance so it can't freeze mid-screen"
```

---

## Task 8: Suppress other notices when a Digital Release Filter notice is present (Part 9)

**Files:** Modify `src/views/DetailView.tsx`.

- [ ] **Step 1: Add a `suppressNoisyNotices` helper** (near `StreamMetaBadges` / the `StreamMetadata` usage):
```tsx
/** When AIOStreams returns a "Digital Release Filter" notice (no digital
 *  release available yet), the other notices (errors/stats/etc.) are just
 *  noise — keep ONLY the Digital-Release-Filter message(s). */
function suppressNoisyNotices(metadata: StreamMetadata): StreamMetadata {
  const isDrf = (m: StreamMessage) =>
    /digital release filter/i.test(m.title ?? "") || /digital release filter/i.test(m.description ?? "");
  const all = [...metadata.errors, ...metadata.warnings, ...metadata.info, ...metadata.stats];
  if (!all.some(isDrf)) return metadata;
  const keep = (rows: StreamMessage[]) => rows.filter(isDrf);
  return {
    ...metadata,
    errors:   keep(metadata.errors),
    warnings: keep(metadata.warnings),
    info:     keep(metadata.info),
    stats:    keep(metadata.stats),
  };
}
```
(Confirm `StreamMetadata`'s field names — `errors`/`warnings`/`info`/`stats` per the bucket array — and that `description` may be empty string, not null; the regex on `?? ""` covers both.)

- [ ] **Step 2: Apply at the two call sites.** In `StreamMetaBadges`, change `const allBuckets = [ … metadata.errors … ]` to read from a suppressed copy: at the top of the component (after the hooks), `const md = suppressNoisyNotices(metadata);` and build `allBuckets` from `md.errors/md.warnings/md.info/md.stats`. Do the same in `StreamMessagesEmptyState` (the empty-state notice render) — wrap its `metadata` use with `suppressNoisyNotices`.

- [ ] **Step 3: Verify** `pnpm exec tsc --noEmit`. On hardware: a title where AIOStreams returns the Digital Release Filter notice shows ONLY that notice (no error/stats clutter).

- [ ] **Step 4: Commit**
```bash
git add src/views/DetailView.tsx
git commit -m "feat(streams): a Digital Release Filter notice suppresses the other notices"
```

---

## Self-review notes
- **Spec coverage:** Task 1 = Parts 1+2; Task 2 = Part 4; Task 3 = Part 7; Task 4 = Part 5; Task 5 = Part 3; Task 6 = Part 6; Task 7 = Part 8; Task 8 = Part 9. All nine mapped.
- **Type/name consistency:** `groupRatingsByBrand` used identically in Tasks 3's two sites; `useLibraryArtRetry(library, addons, applyPoster)` signature consistent; `seriesArt` threaded App-of-DetailView → UnifiedPanel → EpisodesPanel → EpisodeRow (mirrors the existing `highlightVideoId` chain); `suppressNoisyNotices`/`StreamMetadata`/`StreamMessage` consistent.
- **Anchors to re-confirm at edit time (lines drift):** CinemaRows `CWReleaseCountdown` span + `bg-white/35`; DetailView `mergedRatings` sort tail, the resume `setActiveVideo` effect, EpisodeRow thumbnail block + params, `StreamMetaBadges` effect, `allBuckets`, `StreamMessagesEmptyState`; CatalogHoverCard `ratings` IIFE; App `addons`/`setLibrary` names.
- **Order:** Tasks 5–8 all touch DetailView in different regions (ratings ~690, synopsis effect ~835, EpisodeRow ~2500, StreamMetaBadges ~3030/3085) — sequential, no overlap.
