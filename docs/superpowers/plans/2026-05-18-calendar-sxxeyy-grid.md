# Calendar SxxEyy Grid Badge — Implementation Plan (Item 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a compact `SxxEyy` chip on the month-grid day-cell posters (top-left), and remove the duplicated badge-formatting logic by introducing one shared `formatEpLabel` helper.

**Architecture:** Extract the existing `formatEpLabel` (currently private in `NotificationsScanner.tsx`) into a zero-dependency module `src/episodeLabel.ts`. `NotificationsScanner` imports it (no behavior change). `CalendarView` imports it for the new grid badge and to DRY the existing DayOverlay `episodeTag` expression (output kept byte-identical).

**Tech Stack:** React 19 + TypeScript, Tailwind. No bundler/config changes.

**Verification model (project-specific — overrides the skill's TDD template):** This repo has **no test framework, ESLint, or Prettier** (CLAUDE.md). The only correctness gate is `pnpm exec tsc --noEmit` (and `cargo check` when Rust changes — not needed here). Each task ends with a tsc check plus a concrete manual acceptance check instead of unit tests. A repo Edit hook (`verify.cjs`) auto-runs tsc after every `Edit`; the explicit tsc step is still listed for determinism. New files are created with `Set-Content` (the `Write` tool is blocked in this repo); existing files are changed with `Edit`.

**Preconditions:** On branch `feat/ui-polish-correctness-batch`. Confirm: `git rev-parse --abbrev-ref HEAD` → expect `feat/ui-polish-correctness-batch`.

---

### Task 1: Create the shared `formatEpLabel` module

**Files:**
- Create: `src/episodeLabel.ts`

- [ ] **Step 1: Create the module**

Run this exact PowerShell command (the `Write` tool is blocked in this repo; the TS content below contains no line equal to the here-string terminator, so the single-quoted here-string is safe):

```powershell
$src = @'
// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Format an SxxEyy / Eyy label.
 *
 *  Single source of truth for the season/episode badge string shared by
 *  the notifications scanner and the calendar (month grid + day
 *  overlay). Returns `S02E06` when both numbers are known, `E6` when
 *  only the episode is known, and `null` otherwise (e.g. movies). */
export function formatEpLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  if (typeof episode === "number") return `E${episode}`;
  return null;
}
'@
Set-Content -Path src/episodeLabel.ts -Value $src -Encoding utf8
```

The logic is byte-identical to the current private `formatEpLabel` in `src/NotificationsScanner.tsx` — only exported and documented. The `©` glyph matches the existing header convention (see `src/views/CalendarView.tsx` line 1).

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit code 0. (An exported-but-unused function does not error; `noUnusedLocals` only flags locals.)

- [ ] **Step 3: Commit**

```bash
git add src/episodeLabel.ts
git commit -m "refactor: add shared formatEpLabel module"
```

---

### Task 2: Point NotificationsScanner at the shared module (no behavior change)

**Files:**
- Modify: `src/NotificationsScanner.tsx` (import block ~line 14; remove private def ~lines 228-235)

- [ ] **Step 1: Add the import**

Edit `src/NotificationsScanner.tsx`. Replace:

```ts
import type { ReleaseAired } from "./releaseSearch";
```

with:

```ts
import type { ReleaseAired } from "./releaseSearch";
import { formatEpLabel } from "./episodeLabel";
```

- [ ] **Step 2: Delete the now-duplicated private function**

In the same file, delete exactly these 8 lines (the JSDoc + function, currently ~lines 228-235):

```ts
/** Format an SxxEyy / Eyy label. */
function formatEpLabel(season: number | null | undefined, episode: number | null | undefined): string | null {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  if (typeof episode === "number") return `E${episode}`;
  return null;
}
```

Replace with an empty string (remove the block entirely). A resulting extra blank line is cosmetic and acceptable. The two call sites (`formatEpLabel(ep.season, ep.episode)` ~line 457 and `formatEpLabel(pending.season, pending.episode)` ~line 588) are unchanged and now resolve to the imported function with identical behavior.

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit code 0. (If it errors "Cannot find name 'formatEpLabel'", the Step 1 import was not added.)

- [ ] **Step 4: Commit**

```bash
git add src/NotificationsScanner.tsx
git commit -m "refactor(notifications): use shared formatEpLabel"
```

---

### Task 3: Add the grid badge + DRY the DayOverlay tag

**Files:**
- Modify: `src/views/CalendarView.tsx` (import ~line 9; grid map ~lines 464-465 and ~lines 484-490; DayOverlay episodeTag ~lines 667-669)

- [ ] **Step 1: Add the import**

Edit `src/views/CalendarView.tsx`. Replace:

```ts
import ImageLoader from "../ImageLoader";
```

with:

```ts
import ImageLoader from "../ImageLoader";
import { formatEpLabel } from "../episodeLabel";
```

- [ ] **Step 2: Destructure `video` and compute the label in the grid map**

Replace:

```tsx
                    {visiblePosters.map(({ item, detail }) => {
                      const src = detail?.poster ?? item.poster;
```

with:

```tsx
                    {visiblePosters.map(({ item, detail, video }) => {
                      const src = detail?.poster ?? item.poster;
                      const epLabel =
                        video && video.season != null && video.episode != null
                          ? formatEpLabel(video.season, video.episode)
                          : null;
```

`visiblePosters` is `CalendarEntry[]`; every entry already carries `video: VideoEntry | null` (see `CalendarEntry` at `src/views/CalendarView.tsx:89-96`; `VideoEntry.season`/`.episode` are `number | null` at `src/types.ts:199-200`). Movies have `video: null` ⇒ `epLabel` is `null` ⇒ no chip.

- [ ] **Step 3: Render the chip inside the poster container**

In the same grid map, replace this block (the no-art placeholder plus the two closing tags of the poster `div`):

```tsx
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center
                                            text-white/20 text-[10px]">
                              ?
                            </div>
                          )}
                        </div>
```

with:

```tsx
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center
                                            text-white/20 text-[10px]">
                              ?
                            </div>
                          )}
                          {epLabel && (
                            // Top-LEFT to match the DayOverlay badge and to
                            // stay clear of addon-baked HDR/DV/language badges
                            // that sit in the poster's top-right art.
                            <span
                              className="absolute top-1 left-1 text-[9px] leading-none
                                         font-mono font-semibold text-white/95
                                         px-1 py-0.5 rounded bg-black/85
                                         border border-white/15 max-w-[90%] truncate"
                            >
                              {epLabel}
                            </span>
                          )}
                        </div>
```

Tailwind note (CLAUDE.md opacity-scale gotcha): `bg-black/85` and `border-white/15` use opacity steps 85 and 15, both on the default scale — they emit CSS. `text-[9px]` / `max-w-[90%]` are arbitrary bracket values, unaffected by the gotcha.

- [ ] **Step 4: DRY the DayOverlay episodeTag (output unchanged)**

In the same file, replace:

```tsx
                episodeTag={video && video.season != null && video.episode != null
                  ? `S${String(video.season).padStart(2,"0")}E${String(video.episode).padStart(2,"0")}`
                  : null}
```

with:

```tsx
                episodeTag={video && video.season != null && video.episode != null
                  ? formatEpLabel(video.season, video.episode)
                  : null}
```

The guard already requires both `season` and `episode` non-null; `VideoEntry` types them `number | null`, so when the guard passes both are numbers and `formatEpLabel` returns the identical `S0xE0y` string. No visual change to the DayOverlay badge.

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 6: Manual acceptance check**

Run: `pnpm tauri dev` (or `pnpm dev` if the Tauri shell is already running). In the app:
1. Open the Release Calendar with a library that has tracked series episodes in the visible month.
2. Confirm each series poster in a day cell shows a small `SxxEyy` chip in the **top-left**, single-line, dark pill.
3. Confirm a **movie** release in a day cell shows **no** chip.
4. Click a day to open the day overlay; confirm its larger `SxxEyy` badge is unchanged (still top-left, same text).
Expected: all four hold; no overlap with any top-right HDR/DV/language art badges.

- [ ] **Step 7: Commit**

```bash
git add src/views/CalendarView.tsx
git commit -m "feat(calendar): SxxEyy chip on month-grid posters; DRY day-overlay tag"
```

---

## Self-Review

**Spec coverage (Item 4 of `docs/superpowers/specs/2026-05-18-aura-ui-polish-batch-design.md`):**
- "compact SxxEyy chip on each grid day-cell poster, top-left" → Task 3 Steps 2-3.
- "only when video.season != null && video.episode != null (movies → none)" → Task 3 Step 2 (`epLabel` guard).
- "Reuse a single shared SxxEyy formatter; one helper, no duplicated inline padStart" → Tasks 1-2 + Task 3 Step 4 (removes the only inline padStart, in DayOverlay).
- "The DayOverlay badge is unchanged" → Task 3 Step 4 keeps the guard; identical output string; styling untouched.
- "bg-black/85 and border-white/15 are on the Tailwind scale" → Task 3 Step 3 note.
- tsc gate → every task ends with `pnpm exec tsc --noEmit`.

**Placeholder scan:** none. No TBD/TODO; every code step shows complete code and exact commands.

**Type consistency:** `formatEpLabel(season: number|null|undefined, episode: number|null|undefined): string|null` is defined once (Task 1) and every caller passes `VideoEntry.season|.episode` (`number|null`, `src/types.ts:199-200`) or the pre-existing `ReleaseAired`/pending `season|episode` call sites (unchanged) — all assignable. The symbol is `formatEpLabel` at the definition and at every import/call site.
