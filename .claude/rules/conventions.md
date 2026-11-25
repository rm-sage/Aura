---
paths:
  - "src/views/SettingsView.tsx"
  - "src/settingsControls.tsx"
  - "src/backendSettings.ts"
  - "src/views/OnboardingView.tsx"
  - "src/onboarding.ts"
  - "src/auraSettings.ts"
  - "src/settingsTransfer.ts"
  - "src/useKeybindings.ts"
  - "src/wheelSmooth.ts"
  - "src/scrollPause.ts"
  - "src/searchHotkey.ts"
  - "src/PerfMonitor.tsx"
  - "src/playerMenu.tsx"
  - "src/seasonScroll.ts"
  - "src/libraryActions.ts"
  - "src/ThemeEngine.tsx"
  - "src/sync.ts"
  - "src-tauri/src/perf_monitor.rs"
  - "src-tauri/src/settings.rs"
---

# Conventions (full)

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: keybindings, Esc layering, title-bar panels, wheel scrolling, Settings rows and sync, library loads, auto-remove, Performance Monitor, episode-list landing.

## Conventions

- Ctrl+F focuses the search box on screen and the native find bar is off (`src/searchHotkey.ts`,
  popups through `POPUP_NO_FIND_SCRIPT`). A new search box only needs `data-aura-search` on its
  `<input>`. Do not use WebView2's `AreBrowserAcceleratorKeysEnabled`: it also kills F5.
- Where an episode list lands (`src/seasonScroll.ts`, both episode panels and `ArcGrid`): on a season pick, on opening
  an arc and on leaving Arcs for Seasons, the latest watched episode, else the top (nothing watched, or everything).
  A SKIPPED episode does not count (a skip is stored as a watched mark: "Skip the filler" at Naruto E110 marks filler
  through E220).
  The grid lands on the arc holding that episode, read in BROADCAST order (Naruto's "Various Filler" is the last tile and
  scattered, so walking the tiles lands past every arc the user has not reached). Each landing runs once per opening: a
  library refresh must not move a list being read. A resume target, a notification's ringed row and, in the player
  drawer, the playing episode (the arc grid too, through `pinnedEpisodeId`) outrank it. `useStoryArcs`' `loading` is derived from the request, true from the first
  commit that has it, because one commit of the season list in a remembered Arcs mode spends the resume target. Anything
  that opens an arc once waits out `arcResultIsInterim`: arc ids are per grouping, so one opened from the result the
  default grouping is about to replace vanishes.
- The hover meta panel opens on a side that covers no other card when one fits, else behind the
  cursor's travel (`src/hoverPlacement.ts`, once per card, never flipped live). In hover mode it
  ALWAYS lets the pointer through, over free space too (user's call: the first and last cards of a
  short search row took the pointer while the rest did not); holding Alt freezes it and lets it
  take the pointer.
- Alt+~ (the `perf-monitor` keybinding, Shift tolerated since ~ is Shift+`) opens the Performance
  Monitor (`src/PerfMonitor.tsx`, `src/perfSeries.ts`, `src-tauri/src/perf_monitor.rs`). Closed, it
  costs nothing: the panel unmounts and Rust holds no thread, timer or PDH query; pdh.dll and dxgi.dll
  load by hand on the first sample. Figures cover the process TREE (aura.exe holds mpv, WebView2 and
  ffmpeg are children). Video figures come ONLY from the engine's gated cache poll
  (`publish_video`), never a `get_property` from the sampler (landmine 3). I/O is files AND pipes, and
  Network is the stream plus downloads: Windows has no per-process disk or network figure without
  elevation, so do not relabel either as if it did. It sits above every z-index but cannot cover a
  native child webview (the source popup). A floating surface that hit-tests the page should look
  through `[data-perf-monitor]`, as `searchHotkey.ts` and `CatalogHoverCard.tsx` do; a capture-phase dismiss
  listener must exempt it, because the monitor's React stopPropagation only shields bubble listeners. The Video
  figure is the video's own frame rate (`estimated-vf-fps`), not a presentation rate (`display-fps` is pinned
  through `display-fps-override`, so it measures nothing); the dropped-frame counts are the health signal and run
  since the last seek or load. The Buffer bar fills against the engine's live `cache-secs`, not the setting. The
  Frame line plots main-thread stalls through a `longtask` observer. A sample more than 5 s after the last one is a
  new baseline. The Shift tolerance yields when another action holds the Shift chord, and a plain or Shift-only
  binding stands aside inside text boxes. The crash reporter counts as Core.
- The player keybindings are enabled only while a player is active. Off the player every bound key belongs to the
  page, and `isChordBound` is false, so Ctrl+F always reaches the search box there.
- Esc layering: a layer above a page or the player takes Escape in a window CAPTURE listener with stopPropagation,
  because a bubble stop does not stop App's sibling listener on window. Capture listeners on window are siblings too
  and run in registration order, so a panel hosting a nested layer yields to it explicitly (the Downloads and Service
  status panels check `[data-aura-context-menu]`). Every docked player menu that owns its open state calls
  `useMenuEscape` (`src/playerMenu.tsx`), except the hover-opened VolumeControl. The onboarding wizard in addons-only
  mode ("Suggested addons") takes Escape as Done through a capture listener that yields to a context menu, the open
  paste field (`data-onboarding-paste`) and any `aria-modal` dialog; first-run and rerun modes do not bind Escape.
- A title-bar panel keeps Space / Enter on its controls and Up / Down from the player keybindings through
  `keepPanelKeysFromPlayer` (`downloadsPanel.ts`), stopping at the document because dnd-kit's keyboard drag listens
  there. Both title-bar panels hold "closing" for at least a macrotask (`anyMenuOpen` must stay true through a
  dismissing mousedown). `Tooltip` blurs the active element only after a mouse click (click detail above 0).
- Mouse wheel scrolling. Do not judge it by rAF: compositor scrolling draws an even 4.2 ms while rAF reads 90 fps
  (measure `Display::DrawAndSwap` gaps in a trace). What read as jitter was the motion: Chromium plays each notch as
  a separate curve back to rest, and no flag changes that (`ImpulseScrollAnimations` was removed upstream). So
  `src/wheelSmooth.ts` takes whole notches (`wheelDeltaY` a multiple of 120, setting `smoothWheelScroll`, never with
  reduced motion) and drives `scrollTop` from a critically damped spring on the main thread; touchpads and free-spin
  wheels stay native. It keeps its own wheel latch, stops at a fixed ancestor (the native chain follows the containing
  block, and modals render inside page scrollers) and leaves a non-overflowing `overscroll-behavior` element to the
  browser. Because it runs on the main thread, `src/scrollPause.ts` sets `data-aura-scrolling` on `<html>` during a
  scroll the user is driving, which pauses every decorative loop (Library rAF 55 to 227 fps; no single loop accounts
  for it) and freezes `.card-grow` hover for cards the scroll carries under the pointer; the card already hovered
  when the scroll starts is marked `data-hover-held` and keeps its look (dropping it to 0.94 snapped its edges 11 px
  on every notch and regrew it 160 ms after the stop: reported as the page jiggling). A hover panel's open timer waits for it. The rule in App.css is a LIST of
  loops, never `*`: a universal selector recalculates the whole document each flip, an 8-12 ms stall the spring shows
  as a skip. A new loop that repaints belongs in that list. A run ends on a constant-deceleration brake (`nextStep`):
  once the spring's own deceleration reaches what stopping on the target needs (from rest at omega t = sqrt(2), speed
  and deceleration both matching), it brakes at that rate to zero speed on the target. Whole-pixel offsets make the
  spring's own tail lone 1 px steps up to 46 ms apart; the steady 240 px/s close that replaced it stopped dead
  (57600 px/s^2 in one frame against about 3300 in the body), which read as the page jiggling after one notch. Never
  end a run at speed. A page's main scroller takes `.aura-page-scroller` (`will-change: scroll-position`):
  below 150% scale Chromium otherwise re-rasters a non-opaque scroller as it moves (3.2 raster tasks per frame, 0.12
  with it; text rendering unchanged). Small card controls take no `backdrop-blur`, with ONE exception the user picked in round 9: the Home card
  frost on poster marks and tracks (`.aura-frost`, `styles/glass-cards.css`), a 12 px backdrop pass each, bounded by
  the row virtualization; faux frost (no backdrop) with hardware acceleration off and, since round 12, on every
  Continue Watching card (measured: wheel scrolling 178 to 214 fps on Home at 2575 x 1038 with Cursor glow on,
  frontend-ui.md "The Home cards"). Measure before adding frost anywhere else. Row stride is unrounded
  (`parseFloat` of the computed height, never the rect, which includes a hover scale).
- Settings sync. `aura:backend-settings-changed`, detail `{ keys?, fromCloud? }`, fires AFTER a backend write lands
  (`applyBackendPatch` in SettingsView, `ThemeEngine.setTheme`, onboarding, the trailer quality write, a reset with no
  keys, `writeSettingsBlob` with fromCloud), and `keys` lists only keys whose value really changed, so an empty list
  is a no-op. Sync stamps and pushes on it (not fromCloud, not machine-local keys), App's settings effect reloads on
  it through a key list beside the loader, ThemeEngine re-reads for `theme`. ANY new `update_settings` or `set_theme`
  caller must dispatch it. Sync no longer listens to `aura:keybindings-changed`. The last-writer-wins stamp is per sync
  scope (`aura:settings-updated-at:<scope>`, `setSettingsStampScope`); a guest never stamps; the old global key is
  adopted once, only when the scope entered still has persisted etags. `aura:sync:settings-unpushed:<scope>` marks an
  edit the cloud has not taken and arms a push only in a pull's 304 or 404 branch, never at the end of a pull, because
  a push with no etag sends a null If-Match, which overwrites unconditionally. So a push with no etag is held unless
  the last pull answered 404 (`settingsCloudAbsent`), and a 200 received with no etag held means this device never
  merged this account's copy: the cloud wins outright, whatever the stamps say. `clearSyncEtags` must be followed in
  the same tick by `setSyncActiveScope`; stored etags, stamp and marker drop only when that call changes scope (a
  StrictMode re-apply keeps them). Known gaps: signing out inside the 5 s debounce or offline discards an unpublished
  edit (accepted: the mechanism that used to save it was the guest-edit bug), and a scope with no settings file still
  inherits the previous cache in `settings.rs::load`, so after a first pull answering 404 the next edit publishes
  those values. `settingsCloudSettled` (read by the one-time audio-order repair, which runs once per ACCOUNT: its synced backend flag `audio_priority_repaired` only ever goes false to true, `writeSettingsBlob` ORs the incoming value with the local one) is true for a guest, else only once
  THIS session's pull answered for settings for the current account (a 200 merged, a 304, a 404) or a settings push
  landed (`settingsPulledThisSession`, reset with the session in `resetSyncSession`). Never on the persisted etag
  alone: it is loaded at scope entry and survives a failed or offline pull.
- Settings import: `providers.occurrences` is optional and additive (repeated manifest ids resolve by occurrence, a
  fallback is reported as ambiguous). A stream or search list where nothing resolves is left out of the patch, so it
  cannot empty the override and turn off every installed addon. A rejected backend patch retries field by field.
- Library loads are latest-request-wins (`libraryLoadGenRef`, bumped through `invalidateLibraryLoads` BEFORE anything
  swaps the manual-watched scope). The warm cache paints only when this account's list is not on screen; a failed
  refetch never repaints. A failed write rolls itself back in its own handler. Views read `libraryKnown`
  (`libraryLoaded || (authChecked && !session)`); App's raw flag stays false for a guest on purpose, for the Queue
  prune. Queue renders planned ids with no library record as stubs from the meta cache.
- FilterState's default year range is unbounded (-Infinity / Infinity), clamped only for display: never JSON-serialize
  it as is.
- Auto-remove: a series is tombstoned only through `seriesFinishCheck` (`libraryActions.ts`). Every elected meta addon
  is asked; at least one answer must have videos, none may date a future episode, and the cloud signal must agree. A
  provider that claims the id and gives no list keeps the show; a catch-all's silence does not. Most-videos
  (`getRichestMetaDetail`) must not decide "nothing is coming", because it can elect an aired-only list. The walk is
  `everyMetaAnswer` (`libraryActions.ts`) and it fails closed: any elected addon that is not a catch-all and returns no
  videos (an error, a 404, an empty or thin answer) marks the check failed, with no error-string matching.
- F12 opens the in-app DevConsole (ring buffer, level filters, search). Rust logs arrive via the
  `crate::devlog!` macro, which mirrors to stderr AND emits a `dev-log` Tauri event.
- Rust log labels to grep in the DevConsole or `aura-mpv.log`: `[bridge]`, `[player]`, `[streams]`,
  `[meta]`, `[catalog]`, `[search]`, `[subtitles]`, `[ratings]`, `[rpc]`, `[win32]`, `[smtc]`,
  `[scrobble]`, `[publicmetadb]`, `[mpv]` (the playback engine), `[cast]`, `[iptv]`, `[sync]`,
  `[aniskip]`, `[introdb]`, `[skipdetect]` (the layered OP/ED detector), `[arcs]`, `[release-dates]` (movie digital / theatrical dates), `[subsync]`, `[downloads]`, `[history]` (the watch-history store), `[status]` (the service status probes),
  `[backup]` (the user-data snapshot ledger), `[perf]` (the Performance Monitor's GPU counters), `[tenrai]` (the MyAnimeList client), `[manga]` (manga chapters: MangaUpdates + Fandom), `[airing-check]` (frontend, the stream check for an
  airing show's next episode), `[extras]` (frontend,
  the anime metadata tabs on the detail page), `[next-up]` (frontend, the Next-Up card's timing
  inputs: the elected ending with its source and level, trusted end, preview, media end).
- libmpv writes its own verbose log to `%USERPROFILE%\aura-mpv.log` (truncated each MPV init, rotated
  to `.old` past 50 MB). The last few lines usually pinpoint a STATUS_ACCESS_VIOLATION.
- Discord RPC uses application ID `1499651271357890610` (`window_logic.rs`). Browse states are gated
  on the `discord_rpc_browse_states` setting; playback states honor `discord_rpc_show_titles` + the
  per-title blocklist.
- Themes are driven by `data-theme` on `<html>` (round-tripped through the Rust `set_theme` command).
  The valid set lives in `ThemeEngine.tsx`; do not hardcode it elsewhere. The user can override any
  theme's accent (`AuraSettings.themeAccents`, Settings > Theme > Accent colour, portable and synced);
  see `.claude/rules/frontend-ui.md` "Custom accent colour".
- No em-dashes (or en-dashes) anywhere: code comments, commit messages, UI copy, release notes,
  prose. Use a hyphen, colon, parentheses, or a sentence break.
- Any Settings-page change must be evaluated for export/import (`PORTABLE_AURA_FIELDS` /
  `PORTABLE_BACKEND_FIELDS` in `settingsTransfer.ts`) and cloud-sync sharability, to stop the drift
  that left prefs unsharable.
- A new Settings row is visible by default. A provider override or power-user knob goes behind
  "Show advanced settings" (`AuraSettings.showAdvancedSettings`) instead: wrap it, with the divider
  that separates it from its neighbour, in `<AdvancedOnly>`, or mark its `TOC_GROUPS` leaf
  `advanced: true` when EVERY row of the section is advanced (the section, its TOC entry and, when
  a group empties, the page group header then hide together). Every searchable row must keep
  `data-settings-row` / `data-settings-label` / `data-settings-description` on its outermost
  element: settings search finds hidden advanced rows by walking those attributes (units are
  mounted `hidden` while a query is active), and a row without them can never be revealed. A
  search or an `aura:open-settings` deep link reveals rows temporarily and never writes the
  switch. A unit that has been on screen stays mounted (`hidden`) for the rest of the visit
  rather than unmounting, so in-flight state (a component download) survives the query
  clearing. Copy elsewhere that names a hidden control must say to turn the switch on.
  Design and as-built notes: section 7 of
  `docs/superpowers/specs/2026-09-11-addon-election-and-advanced-settings-design.md`.
  A row that must stay searchable while it does not apply (the Cursor glow tune rows) is DISABLED (a disabled
  fieldset, dimmed), never unmounted. The shared controls name themselves: `SettingToggle` passes its label as
  `ariaLabel` plus `aria-describedby` to the description, `SettingDropdown` / `SettingText` take `aria-label` plus
  `aria-describedby` (aria-label, not labelledby, so the Advanced tag is not read). A language dropdown builds its
  options through `subtitleLanguageOptions(stored)` (`languages.ts`), which keeps a stored code the list lacks.
- A pasted addon manifest url goes through `normalizeManifestInput` (`src/manifestUrl.ts`: trims, `stremio://` to
  `https://`) before `add_addon` / `cloud_add_addon` (AddonsView and the onboarding wizard). Never log it.
