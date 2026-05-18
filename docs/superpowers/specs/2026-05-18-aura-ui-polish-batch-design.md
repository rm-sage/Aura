# Aura UI Polish + Correctness Batch — Design Spec

- Date: 2026-05-18
- Status: Approved (brainstorming) — pending spec review
- Branch: `feat/ui-polish-correctness-batch`
- Release target: v0.7.x point release

## Context

A cohesive batch of UI-polish and correctness work on the existing Aura
desktop app (Tauri 2 + React 19 + libmpv). Five independent work items,
one spec/plan: no shared-architecture risk, and item 5 is staged so a
diagnostic gates its riskier self-heal step. Related prior change this
session: `libraryItemSeriesId` in `src/libraryNormalize.ts` was corrected
to an all-letters prefix predicate (series-root id concept underpins
item 5).

Non-goals: no torrent/magnet work; no MPV/render changes; no Stremio
account *mutation* from the client (API exposes read-only account info
only); no refactors beyond the hook extraction in item 1.

Correctness gates (CLAUDE.md, run after meaningful edits):
`cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`.
New Rust `#[tauri::command]`s must be registered in THREE places:
`src-tauri/src/lib.rs` generate_handler!, `src-tauri/permissions/player.toml`,
`src-tauri/capabilities/default.json` (skipping any ⇒ silent 401).
Rust→React structs use `#[serde(rename(deserialize = "..."))]` only.
Tailwind opacity must come from the scale or `tailwind.config.ts`
`theme.extend.opacity` (off-scale values silently emit no CSS).

---

## Item 1 — Hover meta panel on 4 surfaces + optional mouse-button bind

### Problem
The mini-meta hover panel (`src/CatalogHoverCard.tsx` — `CatalogHoverHost`
L403-429, `HoverPanel` L142-399; store `src/catalogHoverStore.ts`) is
wired only on `CatalogCard` (`src/CinemaRows.tsx` L685-790, hover L706-709)
used by Home/Search. Library, Discover, Queue, and the Calendar day popup
have no panel. Separately: an optional way to open the panel via a mouse
button instead of hover, with an enable/disable toggle.

### Design

Shared hook (new): `useHoverCardActivation(meta)` returns props to spread
on a card root. Single home for the hover-vs-bind branch; removes the
duplicated `onMouseEnter/onMouseLeave` pattern.

- Hover mode (default): `onMouseEnter → scheduleHoverOpen(meta, el)`,
  `onMouseLeave → cancelHoverOpen(); scheduleHoverClose()` — unchanged
  behavior.
- Bind mode: hover handlers no-op. The bound aux button calls a NEW
  store fn `openHoverNow(meta, el)` (immediate open, bypasses the 450 ms
  intent delay); pressing the bound button again on the same card
  toggles it closed. In bind mode a panel does NOT close on card
  mouse-leave (there is no hover intent to bridge card→panel); it closes
  only via the bound-button toggle, click-elsewhere, Esc, or scroll-out.
  The existing panel-pointer latch and scroll re-anchor are unchanged.

Store additions (`src/catalogHoverStore.ts`): `openHoverNow(meta, el)`
(immediate) and a same-card toggle helper. No change to existing
schedule/close/ re-anchor logic.

Surfaces (migrate existing, add new):
- `src/CinemaRows.tsx` `CatalogCard` — migrate onto the hook (no behavior
  change in hover mode).
- `src/views/LibraryView.tsx` `LibraryCard` (L354-454) — add.
- `src/views/DiscoverView.tsx` `DiscoverPosterCard` (L389-441) — add.
- `src/views/QueueView.tsx` `QueueCard` (L248-379) — add; call
  `closeHoverNow()` on dnd-kit drag start so a drag never fights an open
  panel.
- `src/views/CalendarView.tsx` `CalendarCard` (L705-772) — add, but only
  where it is rendered inside `DayOverlay` (L660-694). The month grid is
  explicitly out of scope (it has its own hidden-poster popout).
- Each card carries `data-meta-card={`${type}:${id}`}` for parity.

Settings (frontend `AuraSettings`, `src/auraSettings.ts`; localStorage
key `aura:settings:v1`; flows through existing settings cloud-sync; the
Rust keyboard keybind system is NOT touched — it is keyboard-only):
- `metaPanelBindEnabled: boolean` — default `false` (hover stays default).
- `metaPanelBindButton: number` — default `1` (middle).
- Add to `DEFAULT_AURA_SETTINGS` (L196) + the `AuraSettings` interface
  (L56) with defensive load coercion consistent with existing fields.

Settings UI (`src/views/SettingsView.tsx`): a new "Hover meta panel"
block reusing `SettingToggle` (L207-234) + a mouse-button capture control
(captures the next aux `pointerdown`/`auxclick` `e.button`; allowed:
middle(1) / back(3) / forward(4); LEFT(0) and RIGHT(2) rejected — right
is the context menu; Esc cancels capture). The capture control is shown
only when the toggle is enabled. Follow the existing
`label + description` row layout.

Middle-click autoscroll: on the bound button, `preventDefault()` on
`pointerdown`/`auxclick` on cards (no existing aux handling in codebase;
must be added in the hook).

### Files
- New: hook (e.g. `src/useHoverCardActivation.ts`).
- Edit: `src/catalogHoverStore.ts`, `src/auraSettings.ts`,
  `src/views/SettingsView.tsx`, `src/CinemaRows.tsx`,
  `src/views/LibraryView.tsx`, `src/views/DiscoverView.tsx`,
  `src/views/QueueView.tsx`, `src/views/CalendarView.tsx`.

### Acceptance
Hover mode behaves exactly as today on all 5 surfaces. With the toggle
on: no panel on hover anywhere; bound button opens immediately and
toggles closed; middle-click never autoscrolls; setting persists and
syncs. Queue drag never opens a panel.

---

## Item 2 — Addon copy + configure buttons

### Problem
`AddonRow` (`src/views/AddonsView.tsx` L223-376) shows Refresh (L335-352)
and Remove (L354-372) icon buttons. Copy-manifest and Configure exist
only in the right-click context menu (L279-307). No `behaviorHints`/
`configurable` is parsed or stored, so configurability cannot be
determined (Cinemeta vs configurable addons indistinguishable).

### Design
Two new icon buttons beside Refresh/Remove, reusing the exact `w-10 h-10`
glass button style + `<Tooltip pos="bottom">` (`src/Tooltip.tsx`).
Buttons supplement, not replace, the context menu.

- Copy manifest (always shown): copies normalized `…/manifest.json`
  (reuse the existing computation at L282-284). Robust clipboard pattern
  (`@tauri-apps/plugin-clipboard-manager` → `navigator.clipboard`
  fallback, as `PlayerOverlay.tsx` L55-71). Transient "Copied ✓"
  affordance (tooltip text swap / icon check), neutral hover tint.
- Configure (conditional): opens `…/configure` via
  `@tauri-apps/plugin-opener` `openUrl` (already imported in AddonsView
  L6). Rendered only when the addon is configurable; hidden otherwise
  (Cinemeta ⇒ nothing).

Configurability signal (new, persisted like `stream_types`/`id_prefixes`):
- Rust: add `behavior_hints.configurable` parsing to `WireManifest`
  (`src-tauri/src/stremio.rs` L165-186). Add `configurable: bool` to
  `AddonEntry` (`src-tauri/src/addons.rs` L13-53) with `#[serde(default)]`.
  Populate at install/refresh/cloud-sync alongside the existing
  `collect_*` calls (~L1016-1024).
- TS: add `configurable?: boolean` to `AddonEntry`
  (`src/types.ts` L4-24).
- Legacy/absent ⇒ treated as not configurable. The button appears for
  an already-installed configurable addon after its manifest is next
  refreshed/synced; the launch-time addon sync covers most. No forced
  migration.
- If a new Tauri command is introduced for any of this, register it in
  all three places (lib.rs / player.toml / default.json). If existing
  install/refresh/sync commands already round-trip the full `AddonEntry`,
  prefer extending them over adding a command.

### Files
- Edit: `src-tauri/src/stremio.rs`, `src-tauri/src/addons.rs`,
  `src/types.ts`, `src/views/AddonsView.tsx`. Possibly
  `src-tauri/src/lib.rs` + permission/capability files if a command is
  added.

### Acceptance
Copy button copies the correct manifest URL with visible confirmation.
Configure button opens the configure page in the default browser and is
absent for Cinemeta, present for a known configurable addon (after
refresh). Both visually match Refresh/Remove. `cargo check` + `tsc`
clean.

---

## Item 3 — Email-pending-sync bug + read-only Account panel

### Problem
`src/NavSidebar.tsx` `ProfilePopover` (L478-585) renders
`hasEmail ? email : "Email pending sync"` (L532-541). Email is empty
because `src-tauri/src/auth.rs` `/login` parsing does `…unwrap_or("")`
(L247-252) — persisting an empty string when `/login` lacks email at the
probed paths — and the `/getUser` backfill (L333-372) only reliably
populated `user_id`. "Account settings" merely does
`setActiveView("settings")` (`src/App.tsx` ~L4255).

### Design
- New cached Tauri command `fetch_stremio_account` (Rust, in `auth.rs`
  area): calls Stremio `/getUser` with the stored auth key; parses
  `email`, `_id`, `dateRegistered`, and — defensively — any premium /
  premium-expiry field if present (probe a couple of plausible keys).
  Returns a typed struct (Rust→React: `#[serde(rename(deserialize=…))]`
  only). On success, backfill `session.email` into the keyring so the
  existing popover email line self-heals on next render. Register the
  command in all three places.
- Cache ~24 h in memory; refresh on login. Popover open does not trigger
  a network call on a warm cache.
- "Account settings" opens a NEW dedicated read-only panel (component
  near `NavSidebar`/`AccountButton`) rendering ONLY confidently-parsed
  fields: email, "Member since <Mon YYYY>" (only if `dateRegistered`
  parsed), truncated Account id, and Aura's own sync state (reuse the
  existing logged-in/synced signal). NO Premium line unless `/getUser`
  actually returns a parseable premium-expiry value (never a fabricated
  "not active").
- A button "Manage on Stremio" opens `https://www.stremio.com/acc-settings`
  externally (`@tauri-apps/plugin-opener`).
- Aura's own app Settings view is unchanged and still reachable as it is
  elsewhere today.

### Files
- Edit: `src-tauri/src/auth.rs`, `src-tauri/src/lib.rs`,
  `src-tauri/permissions/player.toml`,
  `src-tauri/capabilities/default.json`, `src/NavSidebar.tsx`,
  `src/AccountButton.tsx`, `src/App.tsx`, `src/LoginView.tsx`
  (UserSession type if extended). New: account-panel component.

### Acceptance
Real email shows in the popover for a logged-in account (self-healing
without re-login once `fetch_stremio_account` runs). "Account settings"
opens the read-only panel with only verifiable fields; no fake Premium.
"Manage on Stremio" opens `https://www.stremio.com/acc-settings`.
Logged-out state unchanged. Gates clean.

---

## Item 4 — SxxEyy badge on calendar grid images

### Problem
The DayOverlay `CalendarCard` shows an SxxEyy badge (top-left,
`src/views/CalendarView.tsx` L750-759, deliberately left to avoid
addon-baked HDR/DV/language badges in poster top-right). The month-grid
day-cell posters (L458-494) carry the same `video` season/episode data
(`CalendarEntry`, L89-96) but render no badge.

### Design (decision: top-left in BOTH; no day-view change)
Add a compact SxxEyy chip to each grid day-cell poster (around the
poster `div` at L467-490), positioned **top-left** to match the existing
DayOverlay badge's actual position. Compact styling for the tiny grid
posters: `text-[9px]`, `bg-black/85`, `border border-white/15`, single
line, truncating, `absolute top-1 left-1`. Rendered only when
`video.season != null && video.episode != null` (movies → none). Reuse a
single shared SxxEyy formatter (lift/`formatEpLabel`-style; one helper,
no duplicated inline padStart). The DayOverlay badge is unchanged.

`bg-black/85` and `border-white/15` are on the Tailwind scale — OK.

### Files
- Edit: `src/views/CalendarView.tsx` (and the shared formatter location;
  align with `NotificationsScanner.tsx` `formatEpLabel` L228-235).

### Acceptance
Series episodes on the month grid show a small top-left SxxEyy chip
matching the day-view badge corner; movies show none; no overlap
regression; `tsc` clean.

---

## Item 5 — Notification miss (Wistoria S02E06): staged diagnose + fix + self-heal

### Confirmed root cause
Cloud is correct (proven server-side): Wistoria's healthy series id is
`tt31889371` (has S02E06, `aired_at=2026-05-17T11:00:00Z`); `tt15401392`
is an unrelated junk IMDb id the cloud has no data for. Client side:
`src/releaseSignalStore.ts` (L118-125) sends `item.id` VERBATIM (only
non-`tt` filtered, L121); there is NO client anime→IMDb mapping;
`normalizeLibrary` only strips episode suffix. So the wrong `tt15401392`
is BAKED INTO the Stremio library record (written by `handleLibraryToggle`
`src/App.tsx` L2346-2406 storing `meta.id` from a mis-mapping addon's
catalog). `NotificationsScanner.tsx` keys everything off `item.id` too.
There is NO watched/in-progress gate: `isScannable` (L213-221) only
requires in-library + not removed/temp + `tt` + series-ish type.
`librarySaysSeen` (L257-279) only suppresses an episode already played
at/past — never a genuinely new one — and is intentionally kept.

### Design (staged; 5.0 gates 5.3)

5.0 Diagnostic (do first): confirm Wistoria's EXACT stored id and shape
in the live library and the add-to-library path that wrote it (targeted
`devlog!`/inspection, no mutation). Findings may adjust 5.1-5.3.

5.1 Canonical-id resolver: for each scannable `tt` series, lazily fetch
meta (cached; reuse the `getMetaDetailFallback` pattern used by
Calendar/`CatalogHoverCard` L160-176) from the default metadata addon.
A stored id is "suspect" iff its meta is empty/404 OR its title does not
match the library record's name (normalized comparison). For suspect ids
only, re-resolve via a catalog SEARCH on the metadata addon by
`name` + year + media_type, accepting only a strict normalized-title
exact match of the same media_type. Persist `{badId → goodId}` in
localStorage (one-time per show; never re-resolves a clean id).

5.2 Use the canonical id for the release-signal request key
(`releaseSignalStore.ts`) AND scanner keying (`NotificationsScanner.tsx`).
If resolution fails or is absent, fall back to the stored id — never
block the request.

5.3 Self-heal the library record (chosen scope): once an id is
confidently resolved (old id meta empty/404 OR title-mismatched AND a
strict title+media_type(+year when present) match on the new id),
rewrite the Stremio library record — write the entry under the correct
id carrying over `state`/progress/`ctime`, mark the wrong-id record
removed — reusing existing `src/libraryActions.ts` write/remove patterns
(same shape as `libraryRemoveAll`). Gated behind the existing
`releaseSearchEnabled` setting. Acts ONLY on clearly-junk stored ids,
never on cleanly-resolving ones.

Risk + mitigation (explicit): name-based re-resolution can mis-match.
Mitigations: trigger only when the old id's meta is empty/404 OR
title-mismatched (not merely "different"); require strict normalized-
title + media_type (+year when present) on the candidate; cache the
decision; 5.0's diagnostic validates the approach against real data
before 5.3 is implemented. Self-heal mutates the Stremio cloud library —
treat write/remove with the same care as existing `libraryActions`.

### Files
- Edit: `src/releaseSignalStore.ts`, `src/NotificationsScanner.tsx`,
  `src/releaseSearch.ts` (if keying lives there), `src/libraryActions.ts`
  (self-heal write/remove), possibly `src/App.tsx` (load-time hook for
  resolver/self-heal), a small id-resolver module (new).
- No server changes (cloud is correct).

### Acceptance
5.0 produces a written confirmation of Wistoria's exact stored id +
entry path. After 5.1-5.2, release signals for a suspect-id series are
requested under the resolved correct id; Wistoria S02E06 notification
fires once data is available. After 5.3, the library record is rewritten
to the correct id (state/progress preserved, wrong record removed),
guarded so clean records are untouched. `librarySaysSeen` and first-scan
seeding unchanged. Gates clean.

---

## Decisions log
- Account UI: dedicated read-only panel (Option A); no fake Premium line;
  external link → `https://www.stremio.com/acc-settings`.
- Notification scope: diagnose + fix + self-heal the library record.
- Calendar badge corner: top-left in BOTH views (no day-view change;
  avoids HDR/DV/language baked-badge overlap).
- Hover bind: frontend-only `AuraSettings` mouse-button bind + toggle via
  a shared `useHoverCardActivation` hook; default disabled; right button
  excluded (context menu); Rust keybind system untouched.
- One spec/plan for all five (cohesive v0.7.x; item 5 staged).

## Verification
Run after each meaningful edit:
`cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`.
No automated tests exist; manual verification per each item's Acceptance.
