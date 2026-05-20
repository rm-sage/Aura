# Hover Meta Panel — 4 Surfaces + Optional Mouse-Bind — Implementation Plan (Item 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing mini-meta hover panel to Library, Discover, Queue, and the Calendar day-overlay cards via one shared `useHoverCardActivation` hook (the existing `CatalogCard` migrates onto it too), and add an optional, frontend-only mouse-button bind (default disabled) that replaces hover-to-open with press-to-toggle everywhere.

**Architecture:** A new store action pair (`openHoverNow`/`toggleHoverNow`) gives an immediate, explicit open. A new `useHoverCardActivation(meta)` hook returns the activation event-handlers for a card root, reading two new `AuraSettings` fields and reacting to `aura:settings-changed`. Hover mode reproduces today's behaviour exactly; bind mode suppresses hover and toggles on the configured mouse button, with Esc / click-outside / scroll-out closing handled centrally in `CatalogHoverHost`. A new SettingsView "Hover Meta Panel" section exposes the toggle + a mouse-button capture control.

**Tech Stack:** React 19 + TypeScript, Tailwind, @dnd-kit (Queue). No Rust. No new Tauri command.

**Verification model (project-specific — overrides the skill's TDD template):** Repo has NO test framework/ESLint/Prettier (CLAUDE.md). Gate: `pnpm exec tsc --noEmit` (no Rust here, so no cargo). A repo hook (`verify.cjs`) auto-runs `tsc` after EVERY `Edit` — between coordinated edits within a task the hook's tsc may transiently fail (unused symbol / use-before-add); that is expected — only the explicit end-of-task `pnpm exec tsc --noEmit` must be clean. `Write` is blocked: create new files with PowerShell `Set-Content`, modify with `Edit`. Do NOT write tests. Manual GUI acceptance is the human's (subagents can't run the Win32/WebView2 GUI) — Task 9 lists the checklist.

**Preconditions:** Branch `feat/ui-polish-correctness-batch` (Items 4 & 2 shipped; HEAD `b5a8bc5`). Confirm: `git rev-parse --abbrev-ref HEAD`. Working tree clean.

**Dependency order:** T1 (store) and T2 (settings) before T3 (hook); T3 before T4–T7 (consumers); T8 independent (needs T2); T9 last (needs T2). Execute T1→T9 in order.

---

### Task 1: Store — `openHoverNow` + `toggleHoverNow`

**Files:** Modify `src/catalogHoverStore.ts` (after `closeHoverNow`, ~line 98)

- [ ] **Step 1: Add the two actions**

Edit `src/catalogHoverStore.ts`. Replace:

```ts
/** Hard close — card click, route change. */
export function closeHoverNow(): void {
  clearOpen();
  clearClose();
  if (active) {
    active = null;
    emit();
  }
}

// While the cursor is over the popup itself, the user is reading it:
```

with:

```ts
/** Hard close — card click, route change. */
export function closeHoverNow(): void {
  clearOpen();
  clearClose();
  if (active) {
    active = null;
    emit();
  }
}

/** Open the panel IMMEDIATELY (no hover-intent delay). Used by the
 *  optional mouse-button bind, where the open is an explicit user
 *  action rather than a hover so the 450 ms intent delay is wrong. */
export function openHoverNow(meta: MetaPreview, el: HTMLElement): void {
  clearOpen();
  clearClose();
  active = { meta, el, rect: el.getBoundingClientRect() };
  emit();
}

/** Bind pressed on a card: open it, or close if THAT card's panel is
 *  already open (press-again-to-dismiss). Identity is by element, so
 *  two cards sharing a meta id still toggle independently. */
export function toggleHoverNow(meta: MetaPreview, el: HTMLElement): void {
  if (active && active.el === el) {
    closeHoverNow();
  } else {
    openHoverNow(meta, el);
  }
}

// While the cursor is over the popup itself, the user is reading it:
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (`MetaPreview` is already imported at the top of this file; the new exported functions being unused for now does NOT error — `noUnusedLocals` ignores exports.)

- [ ] **Step 3: Commit**

```bash
git add src/catalogHoverStore.ts
git commit -m "feat(hover): openHoverNow + toggleHoverNow store actions"
```

---

### Task 2: AuraSettings — `metaPanelBindEnabled` + `metaPanelBindButton`

**Files:** Modify `src/auraSettings.ts` (interface ~L193; DEFAULT ~L216; coercion ~L303)

- [ ] **Step 1: Extend the interface**

Edit `src/auraSettings.ts`. Replace:

```ts
  releaseSearchEnabled: boolean;
}

export const DEFAULT_AURA_SETTINGS: AuraSettings = {
```

with:

```ts
  releaseSearchEnabled: boolean;
  /** When true, the mini-meta hover panel no longer opens on hover;
   *  instead it opens when the configured mouse button is pressed on a
   *  card (and the same press toggles it closed). Default false =
   *  classic hover behaviour on every surface. */
  metaPanelBindEnabled: boolean;
  /** Mouse button that opens the meta panel when `metaPanelBindEnabled`.
   *  DOM `MouseEvent.button`: 1 = middle (default), 3 = back, 4 =
   *  forward. 0 (left) and 2 (right) are intentionally not selectable —
   *  left is select/navigate, right is the card context menu. */
  metaPanelBindButton: number;
}

export const DEFAULT_AURA_SETTINGS: AuraSettings = {
```

- [ ] **Step 2: Extend the defaults**

Replace:

```ts
  releaseSearchEnabled: true,
};
```

with:

```ts
  releaseSearchEnabled: true,
  metaPanelBindEnabled: false,
  metaPanelBindButton: 1,
};
```

- [ ] **Step 3: Add defensive coercion**

Replace:

```ts
      releaseSearchEnabled: typeof parsed.releaseSearchEnabled === "boolean"
        ? parsed.releaseSearchEnabled
        : true,
```

with:

```ts
      releaseSearchEnabled: typeof parsed.releaseSearchEnabled === "boolean"
        ? parsed.releaseSearchEnabled
        : true,
      metaPanelBindEnabled: typeof parsed.metaPanelBindEnabled === "boolean"
        ? parsed.metaPanelBindEnabled
        : false,
      // Only the three non-conflicting buttons are valid; anything else
      // (legacy / garbage / left / right) falls back to middle.
      metaPanelBindButton:
        parsed.metaPanelBindButton === 3 || parsed.metaPanelBindButton === 4
          ? parsed.metaPanelBindButton
          : 1,
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/auraSettings.ts
git commit -m "feat(settings): metaPanelBind{Enabled,Button} AuraSettings fields"
```

---

### Task 3: New shared hook `src/useHoverCardActivation.ts`

**Files:** Create `src/useHoverCardActivation.ts`

- [ ] **Step 1: Create the hook**

Run this exact PowerShell command (the `Write` tool is blocked; this TS content has no line equal to the here-string terminator, so the single-quoted here-string is safe):

```powershell
$src = @'
// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useHoverCardActivation — the single source of truth for how a catalog
// card activates the mini-meta panel.
//
//   • Hover mode (default): reproduces the historical
//     onMouseEnter/onMouseLeave hover-intent behaviour exactly.
//   • Bind mode (AuraSettings.metaPanelBindEnabled): hover never opens;
//     the panel opens when the configured mouse button is pressed on a
//     card and a second press toggles it shut. In bind mode the panel
//     does NOT close on card mouse-leave (there is no hover intent to
//     bridge card→panel) — it closes via the bound-button toggle,
//     click-outside / Esc (CatalogHoverHost), or scroll-out (store
//     re-anchor). preventDefault on the bound button's pointerdown
//     suppresses middle-click autoscroll / back-forward navigation.
//
// Spread the returned handlers on the card's root element; the card
// keeps its own onClick / onContextMenu — this hook owns ONLY
// hover/bind activation. Reacts live to settings changes via the
// `aura:settings-changed` event (saveAuraSettings busts the settings
// cache before dispatching it, so the re-read is fresh).
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import type { MetaPreview } from "./types";
import { loadAuraSettings } from "./auraSettings";
import {
  scheduleHoverOpen,
  cancelHoverOpen,
  scheduleHoverClose,
  toggleHoverNow,
} from "./catalogHoverStore";

export interface HoverCardActivation {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onAuxClick?: (e: React.MouseEvent<HTMLElement>) => void;
}

function readBindSettings(): { enabled: boolean; button: number } {
  const a = loadAuraSettings();
  return { enabled: a.metaPanelBindEnabled, button: a.metaPanelBindButton };
}

export function useHoverCardActivation(meta: MetaPreview): HoverCardActivation {
  const [bind, setBind] = useState(readBindSettings);

  useEffect(() => {
    const sync = () => setBind(readBindSettings());
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  if (!bind.enabled) {
    return {
      onMouseEnter: (e) => scheduleHoverOpen(meta, e.currentTarget),
      onMouseLeave: () => { cancelHoverOpen(); scheduleHoverClose(); },
    };
  }

  return {
    onPointerDown: (e) => { if (e.button === bind.button) e.preventDefault(); },
    onAuxClick: (e) => {
      if (e.button !== bind.button) return;
      e.preventDefault();
      toggleHoverNow(meta, e.currentTarget);
    },
  };
}
'@
Set-Content -Path src/useHoverCardActivation.ts -Value $src -Encoding utf8
```

(`React.MouseEvent<HTMLElement>` handler props spread onto a `<button>`/`<div>` is the standard generic-handler pattern and type-checks — `MouseEvent<HTMLButtonElement>` is assignable to a handler accepting `MouseEvent<HTMLElement>`. `e.currentTarget` is `HTMLElement`, exactly what `scheduleHoverOpen`/`toggleHoverNow` take.)

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (Exported-but-unused module → fine.)

- [ ] **Step 3: Commit**

```bash
git add src/useHoverCardActivation.ts
git commit -m "feat(hover): useHoverCardActivation shared hook"
```

---

### Task 4: Migrate `CatalogCard` (CinemaRows) onto the hook

**Files:** Modify `src/CinemaRows.tsx` (import block L14-19; CatalogCard L685-790)

Behaviour in hover mode is byte-equivalent to today. After this edit `scheduleHoverOpen`/`cancelHoverOpen`/`scheduleHoverClose` are no longer used in this file (only `closeHoverNow` remains, in CatalogCard's onClick/onContextMenu), so they must leave the import or `tsc` fails on unused imports.

- [ ] **Step 1: Swap the store imports + add the hook import**

Edit `src/CinemaRows.tsx`. Replace:

```ts
import {
  scheduleHoverOpen,
  cancelHoverOpen,
  scheduleHoverClose,
  closeHoverNow,
} from "./catalogHoverStore";
```

with:

```ts
import { closeHoverNow } from "./catalogHoverStore";
import { useHoverCardActivation } from "./useHoverCardActivation";
```

- [ ] **Step 2: Use the hook in CatalogCard**

Replace:

```tsx
export const CatalogCard = memo(function CatalogCard({ meta, onSelect }: CatalogCardProps) {
  // Pull progress from the library context — drives the bottom progress
  // bar (partial) and the corner check (watched). Both are rendered as
  // unobtrusive overlays so they don't compete with the poster art.
  const progress = useLibraryProgress(meta.id);

  return (
    <button
      type="button"
      onClick={() => { closeHoverNow(); onSelect?.(meta); }}
      onContextMenu={(e) => {
        e.preventDefault();
        closeHoverNow();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      // Kai-style mini-meta panel — hover-intent open (delayed in the
      // store) keyed off this card's viewport rect; close is delayed
      // (leeway) so travelling the cursor onto the panel doesn't dismiss
      // it. The central CatalogHoverHost owns the actual popup.
      onMouseEnter={(e) =>
        scheduleHoverOpen(meta, e.currentTarget as HTMLElement)
      }
      onMouseLeave={() => { cancelHoverOpen(); scheduleHoverClose(); }}
      className="card-grow group flex flex-col gap-2 cursor-pointer card-contain text-left
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

with:

```tsx
export const CatalogCard = memo(function CatalogCard({ meta, onSelect }: CatalogCardProps) {
  // Pull progress from the library context — drives the bottom progress
  // bar (partial) and the corner check (watched). Both are rendered as
  // unobtrusive overlays so they don't compete with the poster art.
  const progress = useLibraryProgress(meta.id);

  // Hover-vs-bind activation for the central mini-meta panel. Hover
  // mode is byte-equivalent to the previous inline handlers; bind mode
  // is opt-in via Settings. The card keeps its own click/context menu.
  const hover = useHoverCardActivation(meta);

  return (
    <button
      type="button"
      onClick={() => { closeHoverNow(); onSelect?.(meta); }}
      onContextMenu={(e) => {
        e.preventDefault();
        closeHoverNow();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      {...hover}
      className="card-grow group flex flex-col gap-2 cursor-pointer card-contain text-left
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (If "scheduleHoverOpen is declared but never used" or similar → Step 1 import swap was not applied.)

- [ ] **Step 4: Commit**

```bash
git add src/CinemaRows.tsx
git commit -m "refactor(hover): CatalogCard uses useHoverCardActivation"
```

---

### Task 5: Add the hook to `LibraryCard` and `DiscoverPosterCard`

**Files:** Modify `src/views/LibraryView.tsx` (import; LibraryCard ~L361-379) and `src/views/DiscoverView.tsx` (import; DiscoverPosterCard ~L389-416)

- [ ] **Step 1: LibraryView import**

Edit `src/views/LibraryView.tsx`. Replace:

```ts
import { isAnimeMeta, typeLabel } from "../aiometadata";
import WatchedBadge from "../WatchedBadge";
```

with:

```ts
import { isAnimeMeta, typeLabel } from "../aiometadata";
import WatchedBadge from "../WatchedBadge";
import { useHoverCardActivation } from "../useHoverCardActivation";
```

- [ ] **Step 2: LibraryCard — call the hook, spread on the button**

Replace:

```tsx
  const meta = libraryItemToMeta(item);

  return (
    <div
      className="group relative flex flex-col gap-2 card-contain aura-lib-card"
      data-meta-card={`${item.media_type}:${item.id}`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(meta)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY },
          }));
        }}
        className="flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      >
```

with:

```tsx
  const meta = libraryItemToMeta(item);
  const hover = useHoverCardActivation(meta);

  return (
    <div
      className="group relative flex flex-col gap-2 card-contain aura-lib-card"
      data-meta-card={`${item.media_type}:${item.id}`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(meta)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY },
          }));
        }}
        {...hover}
        className="flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      >
```

- [ ] **Step 3: DiscoverView import**

Edit `src/views/DiscoverView.tsx`. Replace:

```ts
import WatchedBadge from "../WatchedBadge";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
```

with:

```ts
import WatchedBadge from "../WatchedBadge";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
import { useHoverCardActivation } from "../useHoverCardActivation";
```

- [ ] **Step 4: DiscoverPosterCard — call the hook, spread on the button**

Replace:

```tsx
  const handleClick = useCallback(() => onSelect?.(meta), [meta, onSelect]);

  return (
    <button
      type="button"
      onClick={handleClick}
      // Same right-click → context-menu plumbing every other catalog
      // surface uses (Home / Library / Calendar / Search / Catalog
      // page). The `data-meta-card` attribute is used by the global
      // capture-phase contextmenu listener installed in main.tsx for
      // diagnostic logging; the dispatch is what actually opens the
      // menu via App.tsx's card-context handler.
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      data-meta-card={`${meta.media_type}:${meta.id}`}
      className="aura-poster-card group relative block w-full text-left rounded-xl
                 transition-transform"
    >
```

with:

```tsx
  const handleClick = useCallback(() => onSelect?.(meta), [meta, onSelect]);
  const hover = useHoverCardActivation(meta);

  return (
    <button
      type="button"
      onClick={handleClick}
      // Same right-click → context-menu plumbing every other catalog
      // surface uses (Home / Library / Calendar / Search / Catalog
      // page). The `data-meta-card` attribute is used by the global
      // capture-phase contextmenu listener installed in main.tsx for
      // diagnostic logging; the dispatch is what actually opens the
      // menu via App.tsx's card-context handler.
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      {...hover}
      data-meta-card={`${meta.media_type}:${meta.id}`}
      className="aura-poster-card group relative block w-full text-left rounded-xl
                 transition-transform"
    >
```

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/views/LibraryView.tsx src/views/DiscoverView.tsx
git commit -m "feat(hover): meta panel on Library + Discover cards"
```

---

### Task 6: Queue — hook on the sortable wrapper + close on drag start

**Files:** Modify `src/views/QueueView.tsx` (imports L24-36; DndContext ~L210-213; QueueCard wrapper ~L291-296)

The hook is spread on the OUTER sortable `<div ref={setNodeRef}>`, NOT the inner `<button>` (which carries dnd-kit `{...listeners}`) — this avoids any handler collision with the drag sensor. A middle-button `pointerdown` bubbles to the wrapper so `preventDefault` still suppresses autoscroll; dnd-kit's primary-button drag is unaffected. `onDragStart` on the parent `DndContext` hard-closes any open panel so a drag never fights it.

- [ ] **Step 1: Add imports**

Edit `src/views/QueueView.tsx`. Replace:

```ts
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
```

with:

```ts
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
import { closeHoverNow } from "../catalogHoverStore";
import { useHoverCardActivation } from "../useHoverCardActivation";
```

- [ ] **Step 2: Close the panel when a drag starts**

Replace:

```tsx
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetectionStrategy}
              onDragEnd={handleDragEnd}
            >
```

with:

```tsx
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetectionStrategy}
              onDragStart={() => closeHoverNow()}
              onDragEnd={handleDragEnd}
            >
```

- [ ] **Step 3: QueueCard — call the hook, spread on the sortable wrapper**

Replace:

```tsx
  const sortable = useSortable({ id });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const style: React.CSSProperties = {
```

with:

```tsx
  const sortable = useSortable({ id });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  const hover = useHoverCardActivation(meta);

  const style: React.CSSProperties = {
```

Then replace:

```tsx
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

with:

```tsx
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...hover}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

Note: `meta` is declared (the `const meta: MetaPreview = item ? {…} : {…}` block) AFTER `const sortable = …`. The `const hover = useHoverCardActivation(meta);` line in Step 3 is inserted right after the `sortable` destructure — which is BEFORE `meta` is defined, so this would be a use-before-declaration. **Correction:** place the hook call AFTER the `meta` block instead. Concretely, do NOT add the hook line in the `sortable` replacement above; instead replace:

```tsx
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

with:

```tsx
  const hover = useHoverCardActivation(meta);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...hover}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
```

…and leave the `const sortable = …` block unchanged (skip the second replacement in this step; only the `sortable` import/destructure stays as-is). The `meta` constant is in scope here because it is declared above the `return`.

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/views/QueueView.tsx
git commit -m "feat(hover): meta panel on Queue cards; close on drag start"
```

---

### Task 7: Calendar day-overlay card

**Files:** Modify `src/views/CalendarView.tsx` (import L10; DayOverlay CalendarCard usage ~L661-693; CalendarCard ~L723-789)

`CalendarCard` is only rendered inside `DayOverlay` (the month grid uses its own inline poster `<div>`s — out of scope, unchanged). `CalendarCard` currently has no `meta`; add a required `meta: MetaPreview` prop fed from `libraryItemToMeta(item, detail)` (already imported/defined in this file at L106; already called in the DayOverlay map for onClick/onContextMenu).

- [ ] **Step 1: Add the hook import**

Edit `src/views/CalendarView.tsx`. Replace:

```ts
import { formatEpLabel } from "../episodeLabel";
```

with:

```ts
import { formatEpLabel } from "../episodeLabel";
import { useHoverCardActivation } from "../useHoverCardActivation";
```

- [ ] **Step 2: Pass `meta` into the CalendarCard in DayOverlay**

Replace:

```tsx
              <CalendarCard
                key={`${item.id}:${video?.id ?? idx}`}
                name={detail?.name ?? item.name}
                poster={detail?.poster ?? item.poster}
                mediaType={detail?.media_type ?? item.media_type}
```

with:

```tsx
              <CalendarCard
                key={`${item.id}:${video?.id ?? idx}`}
                meta={libraryItemToMeta(item, detail)}
                name={detail?.name ?? item.name}
                poster={detail?.poster ?? item.poster}
                mediaType={detail?.media_type ?? item.media_type}
```

- [ ] **Step 3: CalendarCard — accept `meta`, call the hook, spread + data attr**

Replace:

```tsx
function CalendarCard({
  name, poster, mediaType, episodeTag, episodeTitle, released, onClick, onContextMenu,
}: {
  name: string;
  poster: string | null;
  mediaType: string;
  /** "S01E05"-style label when the card is for a series episode. */
  episodeTag: string | null;
  /** Episode-specific title; rendered under the series name. */
  episodeTitle: string | null;
  released: Date;
  /** Right-click handler — fires the `aura:card-context` event the
   *  shared App-level listener uses to render context menus on cards
   *  app-wide. Optional so non-interactive use sites stay clean. */
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  const dateLabel = released.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
  return (
    <Tag
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`glass-panel rounded-xl p-2.5 flex flex-col gap-2 text-left w-full
                  ${onClick ? "hover:bg-white/8 transition-colors cursor-pointer" : ""}`}
    >
```

with:

```tsx
function CalendarCard({
  meta, name, poster, mediaType, episodeTag, episodeTitle, released, onClick, onContextMenu,
}: {
  /** Catalog meta for the shared mini-meta hover/bind panel. */
  meta: MetaPreview;
  name: string;
  poster: string | null;
  mediaType: string;
  /** "S01E05"-style label when the card is for a series episode. */
  episodeTag: string | null;
  /** Episode-specific title; rendered under the series name. */
  episodeTitle: string | null;
  released: Date;
  /** Right-click handler — fires the `aura:card-context` event the
   *  shared App-level listener uses to render context menus on cards
   *  app-wide. Optional so non-interactive use sites stay clean. */
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  const hover = useHoverCardActivation(meta);
  const dateLabel = released.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
  return (
    <Tag
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...hover}
      data-meta-card={`${mediaType}:${meta.id}`}
      className={`glass-panel rounded-xl p-2.5 flex flex-col gap-2 text-left w-full
                  ${onClick ? "hover:bg-white/8 transition-colors cursor-pointer" : ""}`}
    >
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (`MetaPreview` is already imported in this file's type import at L5.)

- [ ] **Step 5: Commit**

```bash
git add src/views/CalendarView.tsx
git commit -m "feat(hover): meta panel on Calendar day-overlay cards"
```

---

### Task 8: Bind-mode close paths (Esc / click-outside) + panel marker

**Files:** Modify `src/CatalogHoverCard.tsx` (HoverPanel root ~L272-281; imports ~L17/32; CatalogHoverHost ~L401-429)

In hover mode, leave/scroll already close the panel — unchanged. In bind mode there is no mouse-leave close, so add Esc and click-outside closers, gated on `metaPanelBindEnabled` so the shipped hover surfaces are untouched. The panel root gets a stable `data-hover-panel` marker so the click-outside test can tell "inside the panel" from "outside".

- [ ] **Step 1: Mark the panel root**

Edit `src/CatalogHoverCard.tsx`. Replace:

```tsx
    <div
      ref={ref}
      role="dialog"
      aria-label={`${meta.name} details`}
      onMouseEnter={() => { notePanelPointer(true); cancelHoverClose(); }}
```

with:

```tsx
    <div
      ref={ref}
      role="dialog"
      aria-label={`${meta.name} details`}
      data-hover-panel="true"
      onMouseEnter={() => { notePanelPointer(true); cancelHoverClose(); }}
```

- [ ] **Step 2: Import `loadAuraSettings`**

Replace:

```tsx
import {
  useHoverTarget,
  cancelHoverClose,
  scheduleHoverClose,
  closeHoverNow,
  refreshHoverAnchor,
  notePanelPointer,
  type HoverTarget,
} from "./catalogHoverStore";
```

with:

```tsx
import {
  useHoverTarget,
  cancelHoverClose,
  scheduleHoverClose,
  closeHoverNow,
  refreshHoverAnchor,
  notePanelPointer,
  type HoverTarget,
} from "./catalogHoverStore";
import { loadAuraSettings } from "./auraSettings";
```

- [ ] **Step 3: Add bind-mode Esc + click-outside closers in CatalogHoverHost**

Replace:

```tsx
export function CatalogHoverHost({
  addons, onSelectMeta,
}: {
  addons: AddonEntry[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const target = useHoverTarget();

  // Scroll / resize used to hard-close the popup (the rect went stale).
  // Now we RE-ANCHOR to the card's live box instead, so the panel stays
  // open while the cursor is still on the card (it only closes when the
  // pointer leaves the card/panel, or the card scrolls off-screen).
  // Capture phase so an inner scroll container counts too.
  useEffect(() => {
    if (!target) return;
    const reanchor = () => refreshHoverAnchor();
    window.addEventListener("scroll", reanchor, true);
    window.addEventListener("resize", reanchor);
    return () => {
      window.removeEventListener("scroll", reanchor, true);
      window.removeEventListener("resize", reanchor);
    };
  }, [target]);

  if (!target) return null;
  return <HoverPanel target={target} addons={addons} onSelectMeta={onSelectMeta} />;
}
```

with:

```tsx
export function CatalogHoverHost({
  addons, onSelectMeta,
}: {
  addons: AddonEntry[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const target = useHoverTarget();
  const [bindEnabled, setBindEnabled] = useState(
    () => loadAuraSettings().metaPanelBindEnabled,
  );

  useEffect(() => {
    const sync = () => setBindEnabled(loadAuraSettings().metaPanelBindEnabled);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  // Scroll / resize used to hard-close the popup (the rect went stale).
  // Now we RE-ANCHOR to the card's live box instead, so the panel stays
  // open while the cursor is still on the card (it only closes when the
  // pointer leaves the card/panel, or the card scrolls off-screen).
  // Capture phase so an inner scroll container counts too.
  useEffect(() => {
    if (!target) return;
    const reanchor = () => refreshHoverAnchor();
    window.addEventListener("scroll", reanchor, true);
    window.addEventListener("resize", reanchor);
    return () => {
      window.removeEventListener("scroll", reanchor, true);
      window.removeEventListener("resize", reanchor);
    };
  }, [target]);

  // Bind mode only: there is no mouse-leave close, so Esc and a click
  // outside the panel + its anchoring card dismiss it. Hover mode is
  // intentionally NOT given these (its leave/scroll behaviour is
  // unchanged and shipped). target.el is the active card element.
  useEffect(() => {
    if (!target || !bindEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHoverNow();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest("[data-hover-panel]")) return;       // click inside panel
      if (target.el.contains(t)) return;                 // click on the card
      closeHoverNow();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target, bindEnabled]);

  if (!target) return null;
  return <HoverPanel target={target} addons={addons} onSelectMeta={onSelectMeta} />;
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (`useState`/`useEffect` already imported at L17 of this file.)

- [ ] **Step 5: Commit**

```bash
git add src/CatalogHoverCard.tsx
git commit -m "feat(hover): bind-mode Esc + click-outside close"
```

---

### Task 9: SettingsView — "Hover Meta Panel" section + mouse-button capture

**Files:** Modify `src/views/SettingsView.tsx` (TOC group ~L2633-2634; new `MouseBindRow` after `KeybindRow` ~L2938; new Section between Detail Page & Notifications ~L3961-3963)

- [ ] **Step 1: Add the TOC entry (Browsing group, after Detail Page)**

Edit `src/views/SettingsView.tsx`. Replace:

```ts
      { id: "sec-detail-page", label: "Detail Page" },
      { id: "sec-notifications", label: "Notifications" },
```

with:

```ts
      { id: "sec-detail-page", label: "Detail Page" },
      { id: "sec-hover-panel", label: "Hover Meta Panel" },
      { id: "sec-notifications", label: "Notifications" },
```

- [ ] **Step 2: Add the `MouseBindRow` component (mirrors KeybindRow, captures a mouse button)**

Replace:

```tsx
  return (
    <button
      ref={ref}
      onClick={() => setCapturing(true)}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg
                  text-left transition-colors
                  ${capturing
                    ? "bg-ln-accent/15 border border-ln-accent/40"
                    : "hover:bg-white/5 border border-white/8"
                  }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[64px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing ? "Press a key…" : code ? prettyBinding(code) : "Unbound"}
      </kbd>
    </button>
  );
}
```

with:

```tsx
  return (
    <button
      ref={ref}
      onClick={() => setCapturing(true)}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg
                  text-left transition-colors
                  ${capturing
                    ? "bg-ln-accent/15 border border-ln-accent/40"
                    : "hover:bg-white/5 border border-white/8"
                  }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[64px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing ? "Press a key…" : code ? prettyBinding(code) : "Unbound"}
      </kbd>
    </button>
  );
}

const MOUSE_BTN_LABELS: Record<number, string> = {
  1: "Middle click",
  3: "Back button",
  4: "Forward button",
};

/** Captures one of the three non-conflicting mouse buttons (middle /
 *  back / forward) on the next press. Left (0) and right (2) are
 *  rejected — left selects/navigates, right is the card context menu.
 *  Esc cancels capture. Mirrors KeybindRow's capture UX. */
function MouseBindRow({
  label, description, button, onChange,
}: {
  label: string;
  description: string;
  button: number;
  onChange: (next: number) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 1 || e.button === 3 || e.button === 4) {
        onChange(e.button);
        setCapturing(false);
      }
      // Left (0) / right (2): ignore — keep waiting for a valid button.
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setCapturing(false); }
    };
    // Capture phase + contextmenu suppression so a right-click during
    // capture doesn't pop the OS/app menu while we're listening.
    const onCtx = (e: Event) => { e.preventDefault(); };
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("contextmenu", onCtx, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true } as any);
      window.removeEventListener("keydown", onKey, { capture: true } as any);
      window.removeEventListener("contextmenu", onCtx, { capture: true } as any);
    };
  }, [capturing, onChange]);

  return (
    <button
      onClick={() => setCapturing(true)}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg
                  text-left transition-colors
                  ${capturing
                    ? "bg-ln-accent/15 border border-ln-accent/40"
                    : "hover:bg-white/5 border border-white/8"
                  }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[96px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing ? "Press a button…" : (MOUSE_BTN_LABELS[button] ?? "Middle click")}
      </kbd>
    </button>
  );
}
```

- [ ] **Step 3: Add the "Hover Meta Panel" Section (between Detail Page and Notifications)**

Replace:

```tsx
          {/* ── Notifications ─────────────────────────────────────────────
              The bell's "new episode aired" notifications are scheduled
              by NotificationsScanner against your library's series/anime
              entries. By default the scanner notifies the moment an
              addon publishes a recently-released episode; this toggle
              additionally gates on stream availability for users whose
              addon mix occasionally publishes episodes hours or days
              before any source becomes scrapable. */}
          <Section id="sec-notifications" title="Notifications">
```

with:

```tsx
          {/* ── Hover Meta Panel ──────────────────────────────────────────
              The mini-meta panel that pops beside a catalog card
              (poster, ratings, plot, cast). Default: opens on hover.
              The toggle switches every surface (Home / Search / Library
              / Discover / Queue / Calendar day view) to open it on a
              mouse-button press instead — useful if hover-open feels
              twitchy or for click-only navigation. */}
          <Section id="sec-hover-panel" title="Hover Meta Panel">
            <SettingToggle
              label="Open with a mouse button instead of hover"
              description="When on, the meta panel no longer opens on hover. Press the bound mouse button on any poster to open it; press again to dismiss. Esc or a click elsewhere also closes it."
              value={aura.metaPanelBindEnabled}
              onChange={(v) => setLocal({ metaPanelBindEnabled: v })}
            />
            {aura.metaPanelBindEnabled && (
              <>
                <div className="h-px bg-white/6" />
                <MouseBindRow
                  label="Meta panel button"
                  description="Mouse button that opens / dismisses the panel. Middle, Back, or Forward only — left stays select/navigate and right stays the context menu. Click the chip, then press the button. Esc cancels."
                  button={aura.metaPanelBindButton}
                  onChange={(b) => setLocal({ metaPanelBindButton: b })}
                />
              </>
            )}
          </Section>

          {/* ── Notifications ─────────────────────────────────────────────
              The bell's "new episode aired" notifications are scheduled
              by NotificationsScanner against your library's series/anime
              entries. By default the scanner notifies the moment an
              addon publishes a recently-released episode; this toggle
              additionally gates on stream availability for users whose
              addon mix occasionally publishes episodes hours or days
              before any source becomes scrapable. */}
          <Section id="sec-notifications" title="Notifications">
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (`useState`/`useEffect`, `SettingToggle`, `Section`, `aura`, `setLocal` all already exist in this file.)

- [ ] **Step 5: Manual acceptance (human runs the Win32/WebView2 GUI; subagent confirms code only)**

Static self-check (subagent): the new Section sits between `sec-detail-page` and `sec-notifications` both in `TOC_GROUPS` and in render order; `MouseBindRow` only renders when the toggle is on; `setLocal` patches `metaPanelBindEnabled`/`metaPanelBindButton`.

Human GUI checklist (note in the task report that this is pending human verification):
1. Default (toggle off): hovering a poster on Home / Search / **Library / Discover / Queue / Calendar day-overlay** opens the panel exactly as before; leaving closes it.
2. Toggle on: hovering opens nothing anywhere; middle-click a poster opens the panel; middle-click the same poster again closes it; Esc closes; click elsewhere closes; scrolling the card off-screen closes; moving onto the panel and back does not close (pointer latch intact).
3. Change the bound button to Back/Forward via the capture chip (click chip → press button; Esc cancels; left/right are ignored); the new button works, middle no longer does.
4. Queue: dragging a card to reorder still works and never leaves a panel stuck open.
5. Setting persists across relaunch and (if signed in) syncs.

- [ ] **Step 6: Commit**

```bash
git add src/views/SettingsView.tsx
git commit -m "feat(settings): Hover Meta Panel section + mouse-button bind capture"
```

---

## Self-Review

**Spec coverage (Item 1 of `docs/superpowers/specs/2026-05-18-aura-ui-polish-batch-design.md`):**
- Shared `useHoverCardActivation` hook; existing CatalogCard migrated onto it → T3 + T4.
- Panel added to LibraryCard, DiscoverPosterCard, QueueCard (w/ `closeHoverNow` on dnd drag start), Calendar `CalendarCard` in DayOverlay ONLY (month grid untouched) → T5, T6, T7. `data-meta-card` parity: already present on Library/Discover/Queue roots; added to CalendarCard in T7.
- New store fn `openHoverNow` (immediate, bypasses 450 ms) + same-card toggle → T1.
- Frontend `AuraSettings` `metaPanelBindEnabled` (default false) / `metaPanelBindButton` (default 1=middle) with defensive coercion (only 1/3/4) → T2.
- Bind mode: hover suppressed everywhere; does NOT close on card mouse-leave; closes only via bound-button toggle / click-elsewhere / Esc / scroll-out; panel-pointer latch + scroll re-anchor unchanged → hook returns no mouse-enter/leave in bind mode (T3); Esc + click-outside in CatalogHoverHost gated on bind (T8); scroll re-anchor/pointer-latch code untouched.
- SettingsView "Hover meta panel" block: `SettingToggle` + mouse-button capture (middle/back/forward; left & right rejected; Esc cancels) → T9 (+ TOC entry).
- preventDefault on the bound button's pointerdown (autoscroll/nav suppression) → T3 hook `onPointerDown`.
- Gate `pnpm exec tsc --noEmit` after every task; manual GUI checklist in T9.

**Placeholder scan:** none. Task 6 Step 3 contains an explicit *correction* (hook call must follow the `meta` declaration, not the `sortable` destructure) with the final exact edit spelled out — this is complete guidance, not a placeholder.

**Type consistency:** `openHoverNow(meta: MetaPreview, el: HTMLElement)` / `toggleHoverNow(meta: MetaPreview, el: HTMLElement)` defined in T1, imported by the hook in T3 (`toggleHoverNow`) and used with `e.currentTarget` (`HTMLElement`). `useHoverCardActivation(meta: MetaPreview): HoverCardActivation` defined in T3; every call site (T4 CatalogCard, T5 LibraryCard/DiscoverPosterCard, T6 QueueCard, T7 CalendarCard) passes a `MetaPreview` already in scope and spreads `{...hover}`. `AuraSettings.metaPanelBindEnabled: boolean` / `metaPanelBindButton: number` (T2) read by the hook + CatalogHoverHost (T8) + SettingsView `aura`/`setLocal` (T9). `MouseBindRow` prop `button: number`, `onChange: (next: number) => void` matches `setLocal({ metaPanelBindButton })`. TOC id `sec-hover-panel` matches the `<Section id="sec-hover-panel">`. No name drift across tasks.
