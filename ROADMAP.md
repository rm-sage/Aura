# Aura Development Roadmap

A snapshot of completed work and what remains. Each numbered phase shipped a
coherent arc of features. Smaller tactical items live in the rolling Phase 6
sections. New arcs land as numbered phases (Phase 7 onward).

## Status Legend

- ✅ Shipped
- 🟡 Partially shipped or blocked on user input
- 🔴 Planned, not started
- ⛔ Won't implement

---

## Phase 1: Core Engine and Spatial Shell ✅

| Task | Description | Status |
|------|-------------|--------|
| 1.1 | Tauri 2.0 scaffold with transparency and Mica vibrancy | ✅ |
| 1.2 | MPV engine init via `tauri-plugin-libmpv` | ✅ |
| 1.3 | IPC bridge: `toggle_pause`, `seek_relative`, `set_volume`, `playback-update` events | ✅ |
| 1.4 | Spatial UI shell: glass pill control bar, `useAutoHide`, `usePlayback` | ✅ |

---

## Phase 2: Stremio Compatibility and Account Sync

### 2.1 Catalog Browsing ✅

`fetch_catalog` Rust command, `CatalogGrid` component, 10s timeout, addon manifest parsing.

### 2.2 Stremio Account Auth ✅

Platform keyring, `Zeroizing<String>` password scrubbing, `https_only` auth client, `SESSION_EXPIRED` sentinel, `LoginView`, sidebar sync status, startup session restore.

### 2.3 Global Search and Cloud Addon Sync ✅

- [x] `global_search`: concurrent `JoinSet` across all `has_search` addons
- [x] 300ms frontend debounce (rate-limit protection)
- [x] `cloud_add_addon` / `cloud_remove_addon`: `addonCollectionGet → modify → addonCollectionSet`
- [x] `AddonSidebar` Add form active for logged-in users (cloud write) and guests (local write)
- [x] Remove button always visible; routes to cloud or local based on session state
- [x] Metadata sanitization: poster URLs validated (http/https, ≤ 2KB); text fields capped
- [x] URL validation before any cloud write (prevents manifest injection)
- [x] `SearchResultsGrid` component with unified results view
- [x] Control bar hidden when no video is loaded (`duration === 0`)

> **Architecture note:** When a session is active, Stremio account API is the source of truth for addon persistence. Local `addons.json` is read and written only in guest mode.

### 2.4 OS Deep Linking ✅

- [x] `tauri-plugin-deep-link` registered; `aura://` and `stremio://` protocol schemes configured
- [x] Incoming URL forwarded to frontend as `deep-link` Tauri event
- [x] `aura://search?q=...`: handled in App.tsx; navigates to Home, queues query, fires search
- [x] `stremio://detail/{type}/{id}` (and `aura://detail/<type>/<id>` alias): routes to DetailView with a stub MetaPreview, full meta detail filled in by DetailView's own fetch
- [x] `aura://oauth/{trakt,anilist}?...`: OAuth callback handler (see Phase 6.x scrobble auth)
- [x] Auto-updater wired: `tauri-plugin-updater` registered with `endpoints` pointing at `github.com/rm-sage/Aura/releases/latest/download/latest.json`; `updater.ts` + `updaterPlugin.ts` perform the version check
- [x] Update signing keypair: real minisign keypair generated; `tauri.conf.json::plugins.updater.pubkey` carries the production public key (key id `B632D9CFF50F9FDD`); `bundle.createUpdaterArtifacts: true` ships a matching `.sig` next to every release installer; `scripts/release.ps1` runs `pnpm tauri signer sign` against the bundled output. Authenticode / EV code signing is intentionally not on the roadmap — installers ship unsigned and rely on the SmartScreen "Run anyway" path

### 2.5 Cinema Suite and Performance Overlay ✅

- [x] 12-profile shader system: None (0), legacy Anime4K (1, hidden), FSR (2), FSRCNNX (3), KrigBilateral (4), RAVU (5), SSimSuperRes (6), plus Anime4K v4 chains: Mode A (7), Mode B (8), Mode A+A (9), Mode B+B (10), Mode C (11), Mode C+C (12)
- [x] Anime4K modes hover submenu in PlayerOverlay's ShaderPicker: A/B/C/A+A/B+B/C+C grouped under a non-clickable "Anime4K" parent; each mode shows its chord binding next to its name
- [x] Anime4K chord defaults: Ctrl+1..6 → A/B/C/A+A/B+B/C+C, Ctrl+0 → disable. Fully rebindable via Settings → Keybindings (chord support landed when useKeybindings learned modifier syntax)
- [x] Shader picker UI (`PlayerOverlay.tsx ShaderPicker`): glass dropdown with profile list + Anime4K hover submenu
- [x] Backtick (`` ` ``) key toggles Performance OSD
- [x] OSD shows: render group (profile, decoder, resolution, FPS, frame drops, A/V sync), Network (cache, buffer fill %, paused-for-cache, network bps), HDR/Dolby Vision section when active video params expose it (signal kind, tone-mapping mode, source pixel format)
- [x] `vo=gpu-next`, `target-colorspace-hint=yes`, `hdr-compute-peak=yes`, `tone-mapping=auto`
- [x] Dolby Atmos / DTS-X audio passthrough (`audio-spdif`, `audio-exclusive=yes`): opt-in via Settings (off by default to avoid WASAPI device lock)
- [x] Subtitle defaults (pos 95, size 45, border 3, shadow 2)
- [x] Shader files committed under `src-tauri/shaders/` (all twelve Anime4K v4 chains plus FSR / FSRCNNX / KrigBilateral / RAVU / SSimSuperRes) and bundled via `tauri.conf.json::bundle.resources`

---

## Phase 3: Navigation, Views, Playback Pipeline

### 3.1 Navigation Refactor and Cinema UI ✅

- [x] `NavSidebar`: slim 60px glass panel with Home / Library / Addons / Calendar / Settings icons
- [x] `HomeView`: source selector pills, per-addon catalog picker, search bar, results grid
- [x] `AddonsView`: full addon management (add/remove, cloud sync routing, inline login)
- [x] `SettingsView`: Default Home Catalog + Default Metadata Provider dropdowns (localStorage)
- [x] `LibraryView` / `CalendarView`: placeholder screens, later filled in
- [x] `App.tsx` rewritten with view-router, auth state lifted, AddonSidebar removed
- [x] Shader picker moved into video control bar (pill button, shown only during playback)
- [x] `CinemaSuite` stripped to OSD-only (backtick toggle; no floating button)
- [x] IMDb score overlay removed from all poster cards
- [x] Settings persisted to `localStorage` key `"aura:settings:v1"`

### 3.2 Home Overhaul, Library Sync, Theme Engine ✅

- [x] `library_get` / `library_put`: Stremio `datastoreGet/Put` for `libraryItem` collection
- [x] `fetch_meta_detail`: full `/meta/{type}/{id}.json` fetch with sanitization (released, runtime, background)
- [x] `MetaPreview` extended with `background` and `logo` URLs
- [x] HeroCarousel: full-width 21:9 backdrop, deep blur + vignette, glass overlay (title/year/synopsis), hover arrows + dot pagination, 8s auto-advance pausing on hover
- [x] Cinema Flow rows: `ContinueWatchingRow` (16:9 backdrops with progress bar), `DiscoveryRow` (portrait posters); independent horizontal scroll with hover arrows; loading skeletons
- [x] HomeView rewritten: top tab/category header removed; renders Hero → Continue Watching → all catalog rows fetched in parallel from the default home addon
- [x] CalendarView: fetches full meta detail for every library item (concurrency 4) and groups by `released` (or `release_info` / year) into the current Mon-Sun bucket
- [x] Settings module (Rust): `settings.json` in app_data_dir; `get_settings`, `set_theme` commands with validation
- [x] ThemeEngine: React provider that owns `data-theme` on `<html>` and round-trips to backend; CSS tokens scoped per theme
- [x] Three theme profiles: **Mica** (Win 11 native vibrancy), **Glass** (custom high-blur), **Midnight** (pure black, OLED, blur=0)
- [x] Theme dropdown added to Settings; switching cross-fades the entire UI in 280ms
- [x] `AddonSidebar.tsx` deleted (was already unused after Phase 3.1)

### 3.3 Entry Flow, Scrobbling, Window Architecture ✅

- [x] Custom title bar (`TitleBar.tsx`): `data-tauri-drag-region`, glass min/max/close buttons (pointer-events safe), double-click maximize, Maximize ↔ Restore icon flip via `onResized`
- [x] Aura Spectral Sweep: GPU-accelerated CSS animation (`translate3d`, `will-change: transform`, `mix-blend-mode: screen`); 20s linear loop at 0.10–0.18 opacity, no CPU cost
- [x] Tauri capabilities extended: `core:window:allow-{minimize, toggle-maximize, is-maximized, close, start-dragging}`
- [x] LandingView: full-screen Sign In / Continue as Guest with subtle 60s Aura sweep backdrop
- [x] Token caching: keyring 3 already provides DPAPI / Keychain / Secret Service encryption; landing is bypassed when a session is restored
- [x] NavSidebar profile button: initial-letter avatar when signed in, opens login when guest
- [x] HeroCarousel: prefers `background`; falls back to 20px-blur poster with 1.08 scale to hide blurred edges
- [x] AIOMetadata helpers (`aiometadata.ts`): `typeLabel`, `withTypeSuffix` ("Trending Movies", "Top Anime"), `isAnimeMeta` (`media_type === "anime"` ∨ id prefix in `kitsu:`/`anilist:`/`mal:`/`anidb:` ∨ genre/language signals)
- [x] HomeView applies suffix mapping to every Discovery row
- [x] Scrobble pipeline (`scrobble.rs` + `useScrobble.ts`): completion-only; fires `/sync/history` to Trakt and `SaveMediaListEntry` to AniList. Best-effort, never blocks playback. Stricter than Stremio defaults: 80% progress AND ≥ 5 minutes elapsed playback in the current session
- [x] Settings split: Playback section is two cards: "Global Defaults" (default audio + subs language) and "Anime Defaults" (e.g. Japanese audio + English subs); `apply_lang_defaults` Tauri command applies them to MPV's `alang` / `slang` with comma-separated fallbacks
- [x] Discord Rich Presence (`window_logic.rs`): `discord-rich-presence 0.2` IPC client, lazy connect with retry on next call, `discord_set_presence` / `discord_clear_presence`; Privacy Mode: enable toggle, show-titles toggle, per-title blocklist
- [x] Window lifecycle: `pause_on_minimize` (Resized → 0,0), `pause_on_lost_focus` (`Focused(false)`), `close_on_exit` (CloseRequested → MPV stop + RPC clear)
- [x] Backend settings consolidated in `settings.rs` with in-memory cache for high-traffic readers (window callbacks); `update_settings` round-trips a JSON patch and revalidates theme

### 3.4 Optimization and UI Refinement ✅

**Performance:**

- [x] `RowShell` and `HeroCarousel` promoted to dedicated GPU compositor layers (`will-change: transform; transform: translateZ(0); backface-visibility: hidden`) so scrolling Row 5 doesn't repaint Rows 1–4
- [x] `content-visibility: auto` (with `contain-intrinsic-size`) on rows + hero: browser skips layout & paint for off-screen content
- [x] `React.memo` wrap on `DiscoveryRow`, `ContinueWatchingRow`, `HeroCarousel`, `CatalogCard`, `ContinueWatchingCard`, and both `PosterCard`s (catalog grid + search results)

**Aura Sweep (seamless infinite loop):**

- [x] Replaced `translate3d` keyframe with mirrored gradient (A→B→C→B→A), `background-size: 200% 100%`, animating `background-position: 0% → 100%` over 20s linear; same loop period drives the title-bar text fill so glyph and bar share one moving spectrum

**Title bar:**

- [x] Centered "AURA" wordmark with glass-textured letters (`background-clip: text` over the same spectral gradient, plus a translucent text-stroke and dual drop-shadow for volume): the moving sweep appears to flow through the letters
- [x] Wordmark "A" tile removed; bar layout is min/max/close on the right, AURA optically centered, drag region everywhere else

**Ultrawide and Dropdown styling:**

- [x] `SettingsView` content centred in a `max-w-6xl mx-auto` column on top of the full-width glass background
- [x] New theme-scoped tokens `--glass-bg`, `--glass-bg-soft`, `--text-primary`, `--text-muted` mapped per theme (Mica/Glass/Midnight)
- [x] Global `select` and `option` rules use those tokens to kill Chromium's "blinding white" default

**Monthly Visual Calendar:**

- [x] 7-column `grid-cols-7` month grid with 6 rows; Mon-anchored; previous/next month dimmed
- [x] Per-day heatmap dot (single → glow → glow + larger as count grows)
- [x] Click any cell → vertical detail list of releases below the grid
- [x] Today cell glows with the Aura spectrum via `.cal-today` (multi-stop box-shadow: blue rim → purple mid → teal outer)
- [x] Prev / Next / Today navigation; current month label and total-in-library count

**Hero metadata cascade:**

- [x] Priority `background → fanart → backdrop → poster` (poster path uses 20px blur + 1.08 scale to hide bleed)
- [x] `WireMeta` and `MetaPreview` extended (Rust + TS) with `fanart` and `backdrop` fields, sanitized through the same URL pipeline as `poster` / `background`

**Multi-addon home catalogs:**

- [x] New shared `auraSettings.ts` module: adds `additionalHomeAddonUrls: string[]` and dispatches `aura:settings-changed` events on save
- [x] `AddonMultiPicker` control in Settings → "Additional Home Sources" (primary entry shown but disabled to prevent dup)
- [x] HomeView fans out across `[primary, ...additional]` addons in parallel; rows labelled with source name when more than one source is active

---

## Phase 4: External Metadata, Filtering, System Integration ✅

### 4.1 Subtitle Powerhouse (OpenSubtitles) ✅

- [x] `subtitles.rs`: api.opensubtitles.com REST v1 bridge with `https_only` client
- [x] `search_subtitles` (query / year / imdb_id / languages), `download_subtitle` (single-use download URL → app_data_dir/subtitles), `add_subtitle_to_mpv` (mpv `sub-add … select`)
- [x] API key stored in `settings.opensubtitles_api_key`; configurable via Settings → Subtitles
- [x] Filename sanitization on the server-supplied download name
- [x] `SubtitlePicker` glass overlay: query box, language preset, results list with download counts and CC flag; auto-injects + auto-closes on success
- [x] Toggle button in the player control bar; keybinding `toggle-subtitles`

### 4.2 Advanced Filtering (Client-Side) ✅

- [x] `genres` field added to `WireMeta`, `MetaPreview`, `MetaDetail` (Rust + TS) with cap-and-truncate sanitization
- [x] `FilterBar` component: year range slider (clamped to actual data), min-rating slider, genre multi-select chips, sort by rating/year/name
- [x] `applyFilters` is pure JS over an in-memory list; instantaneous on 50+ items
- [x] Wired into HomeView (right side of Discovery rows; multi-source labels preserved) and SearchResultsGrid (right of grid; result count shows "x of y")

### 4.3 SMTC (System Media Transport Controls) ✅

- [x] `souvlaki 0.7` integration in `media_controls.rs`; HWND captured from Tauri's main window
- [x] Dedicated thread owns `MediaControls` (it's `!Send` on Windows); commands marshalled via `mpsc::Sender<Cmd>`
- [x] `smtc_set_metadata` / `smtc_set_playback` / `smtc_clear` Tauri commands
- [x] OS media-key events (Play/Pause/Toggle/Stop/Next/Previous) re-emitted as `smtc-event`; App.tsx forwards to MPV via `togglePause`
- [x] App.tsx pushes title + episode + duration on `activeTarget` change; updates state on every pause/seek

### 4.4 Custom Keybindings Engine ✅

- [x] `keybindings: HashMap<String, String>` added to `AppSettings` with `default_keybindings()` (KeyboardEvent.code → action)
- [x] `useKeybindings.ts` hook: single global keydown listener, locale-independent codes, suppressed inside form controls
- [x] Settings → Keybindings: action list with capture-on-press; press any key to bind, Escape to cancel
- [x] Wired actions: toggle-pause, seek-back / forward, volume-up / down, toggle-osd, cycle-shader, toggle-subtitles, fullscreen
- [x] CinemaSuite OSD now toggles via `aura:toggle-osd` event (no more direct keydown), ShaderPicker cycles via `aura:cycle-shader`

### 4.5 Visual Polish ✅

- [x] Hero dual-layer composition: when backdrop natural width < 900px (or only a portrait poster exists) the carousel renders heavily-blurred + scaled background plus a sharp poster card on the left; title card slides right to make room
- [x] `Tooltip.tsx`: global glass-styled tooltip (CSS-only animation, `glass-panel-elevated` styling, configurable position + optional shortcut hint)
- [x] Tooltips applied to NavSidebar buttons, profile avatar, TitleBar window controls, all player control-bar buttons

---

## Phase 5: AIOMetadata Design Language and Detail View ✅

### 5.1 Evo Sidebar ✅

- [x] NavSidebar transformed into a 200px floating glass island (`glass-panel-elevated rounded-2xl`); no border-r
- [x] App body wraps in `flex gap-3 p-3` so the panel sits on its own with breathing room
- [x] Items now show icon + text label; profile button shows avatar + email line
- [x] Animated Aura glow: single positioned span tracks the active item via `useLayoutEffect`-measured `offsetTop`/`offsetHeight`; transitions in 300ms with a blue→violet linear gradient + accent inset border + glow shadow

### 5.2 Search Bar Centering and Filter Popover ✅

- [x] Search bar centred in the page, capped at `max-w-2xl mx-auto`, switched to `rounded-full` pill styling
- [x] Inline filter trigger inside the input (right edge); accent dot when filters are dirty
- [x] FilterBar now opens as a glass popover anchored below the search field; `fixed inset-0` backdrop closes on click-out
- [x] Right-rail FilterBar removed from HomeView and SearchResultsGrid

### 5.3 AIOMetadata Deep Mapping ✅

- [x] `WireMeta` already exposed `logo` / `background` / `fanart` / `backdrop`; `MetaDetail` extended with `cast`, `director`, `writer`, `country`, and a structured `ratings: Vec<{source, value}>`
- [x] Sanitization caps: 12 cast, 4 director / writer, 8 ratings; per-string char limits applied
- [x] Multi-source ratings collected from both the structured `ratings[]` array and scalar `imdbRating`/`kpRating`/`malScore` fields
- [x] HeroCarousel renders stylized logo art (drop-shadowed) when `meta.logo` is present; falls back to text title otherwise
- [x] Continue Watching uses `background` (16:9): already correct
- [x] Discovery uses `poster` (2:3): already correct
- [x] Search-only catalogs excluded from Home: backend now flags `is_search_only` on `CatalogInfo` (true when `extra` includes `{ name: "search", isRequired: true }`); HomeView filters them out

### 5.4 Catalog Ordering ✅

- [x] Settings → "Additional Home Sources" became a drag-and-drop reorderable list (HTML5 native DnD, no extra deps)
- [x] Selected items shown with a drag handle (`⋮⋮`) at top; available addons shown below; primary marked separately
- [x] Order persists in `auraSettings.additionalHomeAddonUrls` and feeds `resolveHomeAddons` → display order on Home

### 5.5 Cinematic Detail View ✅

- [x] New `DetailView.tsx`: full-screen overlay (z-60), opens with shared-element transform from the originating card's `getBoundingClientRect()`
- [x] Hero header: full-width backdrop, deep bottom vignette, stylized logo overlay (max-h 32, drop-shadow), meta strip (type pill, year, runtime, top-3 ratings, Anime badge when applicable)
- [x] Metadata grid: Synopsis + genre chips on the left, Director / Writers / Cast / Country glass cards on the right
- [x] Streams: `fetch_streams` Tauri command fans out across every addon with a stream resource (concurrent via `JoinSet`); deduped by url/info_hash; grouped by provider in the UI
- [x] Spectral Pulse loader: three orbiting blurred discs (indigo/teal/violet); orbit period and disc opacity scale with discovery progress
- [x] Click any stream → `resolve_stream` (HTTPS direct, HTTP via local axum proxy) → `load_video`; sets `activeTarget` so scrobble + RPC + SMTC all light up; closes the detail view
- [x] Click outside / Esc / Back button all dismiss

### 5.6 Interaction Upgrades ✅

- [x] Volume scroll: global wheel listener active while a video is loaded; ±5% per tick. Skips the event when the wheel is over a scrollable element (catalogs, sidebar list, etc.) so vertical scrolling still works
- [x] Shared-element open: clicking a poster captures its `DOMRect`; the DetailView starts at that rect's transform and animates to fullscreen via `transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1)`
- [x] All catalog cards (CinemaRows.CatalogCard, SearchResultsGrid.PosterCard, HeroCarousel hero card) tagged with `data-meta-card="{type}:{id}"` for the rect lookup

### 5.7 Resume, Picker, Queue ✅

- [x] Resume position writeback to `library_put` while playing: `libraryWriteProgress` flushes `state.timeOffset` + `state.duration` on pause / target change / `beforeunload` with an 800ms debounce + dedupe guard
- [x] Subtitle / audio track selector dropdowns in the control bar: `PlayerOverlay` exposes both via `set_audio_track` / `set_subtitle_track` IPC; merges embedded MPV tracks with addon-supplied external subtitles
- [x] Playlist / queue: `<QueueView />` renders manually-marked "planned" items with reorderable order persisted in `aura:manual-state:`. Episode auto-advance for series after a watched milestone is wired via `advanceWatchedAfter`
- [ ] SMTC Next / Previous wiring: media-key events `next` / `previous` arrive at App.tsx but aren't routed into the queue / next-episode advance yet

---

## Phase 5.5: Native Interactions, Fixed Viewports, Stabilization ✅

### 5.5.1 Critical Playback and Routing

- [x] `resolve_stream` parameter alignment: Rust command now takes `raw_url: String` so the JS-side `{ rawUrl }` snake-case mapping resolves cleanly; `handlePlayStream` reliably runs `resolve_stream → load_video → setActiveTarget → closeDetail`
- [x] Continue Watching → DetailView: `ContinueWatchingCard` is now a button with `onClick`/`onContextMenu`/`data-meta-card` so the shared-element open and right-click menus work the same as discovery rows
- [x] DnD reorder polish: Settings → Additional Home Sources gains visible drop indicators (top/bottom accent rails), `dataTransfer.setData("text/plain", …)` for engines that require it, and `dragenter` highlighting

### 5.5.2 Cinematic, Viewport-Locked Detail View

- [x] `fixed inset-0 flex` outer: no page scroll, fits in the viewport regardless of content height
- [x] Left (flex-1): hero with raw `object-cover` + `object-position: center top`, deep vignette, stylized logo, meta strip, `max-w-prose` synopsis at 17px / leading-1.55 / weight-light, genre chips
- [x] Right (520px): top scrollable Cast/Director/Writers/Country/Ratings cards; bottom internally-scrollable Streams column grouped by addon
- [x] No forced blur/zoom on sharp landscape art (HeroCarousel + DetailView): only the portrait/low-res fallback path keeps the dual-layer soft-focus composition

### 5.5.3 Native Right-Click Context Menus

- [x] Custom React `<ContextMenuHost />` mounted at the app root; `openContextMenu(x, y, items)` is a singleton trigger fired by an `aura:context-menu-open` event so any tree depth can open menus without prop-threading
- [x] Viewport-edge clamping; closes on outside click, Escape, or item activation
- [x] Stream items: Copy Stream Link, Copy Video URL, Copy Magnet Link (when applicable), Play Externally (via `tauri-plugin-opener`)
- [x] Catalog cards: Open in IMDB / TMDB / Kitsu (id-prefix routing), Add to Library / Remove from Library
- [x] Addon rows: Configure addon, Open manifest URL, Copy manifest URL, Remove

### 5.5.4 Global Image Pipeline

- [x] `<ImageLoader />`: shimmer skeleton until `onLoad`, then `opacity 0 → 1` over 300ms; preserves the wrapper's box geometry so DOM stops shifting while images stream in
- [x] Adopted across `CatalogCard`, `ContinueWatchingCard`, `PosterCard`, `HeroBackdrop` (with `naturalWidth` measurement for the low-res detection callback), Hero portrait overlay, Calendar row poster, Search suggestion thumbs

### 5.5.5 Deep Search and Sidebar Polish

- [x] Backdrop overlay: `bg-black/70 backdrop-blur-md` dims the app behind the focused search input; click-out dismisses
- [x] Live suggestions dropdown: top 8 hits from `global_search` (200ms debounce) with poster thumbs; clicking opens the DetailView
- [x] Recent searches: persisted to `localStorage["aura:recent-searches"]` (cap 8); per-row remove + Clear All
- [x] Aura progress bar: indeterminate spectral gradient slides under the input while a query is in flight (`.aura-progress-track` + `.aura-progress-bar`)
- [x] Sidebar grouping: `flex-grow` spacer pushes Addons + Settings to the bottom of the panel (Home / Library / Calendar at top)
- [x] `.nav-tap` micro-interaction: `scale: 1.05` on hover, `scale: 0.95` on click for every sidebar button + the profile pill; transform-only, GPU-composited
- [x] Catalog row titles: `aura-row-title` glass-textured spectral gradient at `text-2xl` (matches the title-bar wordmark fill)

### 5.5.6 Addon Tags and Subtitle Integration

- [x] `AddonEntry` extended with `types: Vec<String>` and `resources: Vec<String>` (default-empty for forward-compat); populated by `add_addon`, `cloud_add_addon`, and `get_synced_addons`
- [x] AddonsView renders distinct-colored `<TagPill />` per type / resource (Movies = blue, Series = purple, Anime = pink, Channels = amber, Streams = emerald, Subtitles = yellow, Meta = cyan, Catalog = sky)
- [x] `fetch_external_subtitles`: new Tauri command; fans out across every `subtitles`-resource addon via `JoinSet`, returns deduped `[{url, lang, addon_name, label}]`
- [x] Auto-injection: after `load_video` succeeds, `App.handlePlayStream` fetches external subtitles and pipes each URL into `add_subtitle_to_mpv` (MPV's `sub-add` accepts URLs directly)

### 5.5.7 Library and Calendar

- [x] LibraryView: full grid of saved Stremio items with sorting (Recently Added, Recently Watched, A→Z, Z→A) and filter pills (All / Movies / Series / Anime, with counts); right-click menus inherit from the catalog card pipeline
- [x] `libraryToggle()` helper: builds the Stremio `libraryItem` change record (`_id`, `_ctime`, `_mtime`, `removed`, …), POSTs through `library_put`, and dispatches `aura:library-changed` so the App re-fetches and dependent views (Continue Watching, Calendar) refresh
- [x] CalendarView: entries are now clickable; `onSelectMeta` opens DetailView for a release; header uses the gradient row title

---

## Phase 5.6: Critical Fixes, Episodic Routing, MPV State, DevTools ✅

### 5.6.1 Critical React and Playback Bug Fixes

- [x] `<ErrorBoundary />`: small class component that catches render errors below it and renders a glass diagnostic instead of a blank tree. Errors also push to the DevConsole via `aura:dev-log`
- [x] LibraryView defensive shell: header / sort / filter pills always render; the data region picks one of `<SkeletonGrid />` (library undefined → still loading), "Sign in" card, "Library is empty" card, "No matches" card, or the actual grid. Shell wrapped in `<ErrorBoundary scope="Library">`
- [x] `libraryLoaded` flag in App.tsx: drives the skeleton state precisely so we don't flash an empty-state card during the initial `library_get`
- [x] MPV transparent passthrough: `<html data-playing="true">` toggles via React effect on `duration > 0`. New `.aura-app-shell` class + CSS rules force `body` / `#root` / wrapper backgrounds to `transparent !important` during playback (including a midnight-theme override). UI overlays (sidebar, title bar, control bar) keep their own glass surfaces so they remain legible on top of MPV
- [x] Verbatim id passthrough: `fetch_streams` and `extract_videos` cap IDs at 256 chars but never strip colons, slashes, or other addon-specific tokens. Episode IDs like `kitsu:12345:1` and `tt0903747:1:5` round-trip cleanly to the addon URL

### 5.6.2 Detail View Tech-Noir Overhaul

- [x] Full-bleed background: `<ImageLoader>` at `absolute inset-0`, `object-fit: cover`, `objectPosition: center top`. NO scaling, NO blur on the raw frame. Three layered gradients (radial vignette + right-edge fade + bottom-up fade) carry all legibility weight
- [x] 35 / 65 horizontal split: left column (logo, dense mono meta strip, `max-w-prose` synopsis, hairline accent rule, genre pills); right column (frosted glass interactive panes)
- [x] Frosted glass panes: `bg-black/60 backdrop-blur-xl border border-white/10` rounded-lg containers with a `1×3px` accent rule + `font-mono tracking-[0.22em] uppercase` headings

### 5.6.3 Series and Anime Episodic Routing

- [x] Backend: `MetaDetail.videos: Vec<VideoEntry>` with `id`, `title`, `season`, `episode`, `released`, `thumbnail`, `overview`. `extract_videos()` parses up to 2000 entries; IDs preserved verbatim (no slugification)
- [x] Frontend: `EpisodePane` shows a season `<select>` (defaults to the smallest season > 0; "Specials" labelled when season 0 exists) and a vertically-scrollable list of `<ImageLoader>` thumbnail rows with S/E codes, air dates, titles, and episode overviews
- [x] Stream gating: for `series` / `anime`, the `StreamPane` is HIDDEN until an episode is explicitly clicked. Clicking sets `activeVideo`, which triggers `fetch_streams({ id: video.id, … })`. Movies skip the picker; streams fetch immediately
- [x] Active target carries `episode`: App.tsx threads `target.episode` (e.g. `S01E05`) into `setActiveTarget` so scrobbling, RPC, and SMTC reflect the right entry

### 5.6.4 DevConsole (F12)

- [x] Rust devlog: new `devlog.rs` module + `devlog!()` macro. Captures the `AppHandle` once during `setup`; every call mirrors to stderr AND emits a `dev-log` Tauri event with `{level, source, message, ts}`
- [x] Lifecycle logging: `setup begin`, MPV pre-flight failures, MPV ready, every `load_video` invocation
- [x] `<DevConsole />` mounted at App root, `z-[9999]`. F12 toggle. Terminal-style monospace UI, level-color chips, ring buffer of 1000 entries, level filter pills (TRACE / DEBUG / INFO / WARN / ERROR), search filter, pause / clear, auto-scroll-to-tail
- [x] Console hooks: overrides `console.log/info/warn/error/debug` in React to push entries alongside Rust logs (uniquely tagged `react:` / `rust:<source>`)
- [x] ErrorBoundary integration: uncaught render errors fire `aura:dev-log` with stack + componentStack so the console shows them without the user opening the OS inspector

### 5.6.5 Stream Details and Library Writeback

- [x] `streamMeta.parseStream()`: regex-driven parser pulls Resolution / Codec / HDR / Audio / Size / Seeders / Language / Release Group out of multi-line addon titles. Cap raised to 1024 chars (title + description) so addon-supplied detail isn't lost
- [x] Chips, no ellipses: every stream row renders the parsed values as colour-coded `font-mono` chips (palette aligned with the AddonsView tag pills); the original primary line wraps freely (`break-words`); any extra lines from the addon render below in muted mono
- [x] Compact, pinned column: the streams pane uses `max-w-lg ml-auto` so it stays right-anchored and never stretches across an ultrawide viewport. Internal `overflow-y-auto` keeps the list scrollable while the page itself is fixed
- [x] `libraryWriteProgress()`: extends the Stremio `libraryItem` change record with `state.timeOffset` and `state.duration`. Auto-tracked items get `temp: true`; existing items preserve their `_ctime` and unknown `state` keys
- [x] Writeback triggers: App.tsx flushes (debounced 800ms) when `paused` flips to true, on every `activeTarget` change (cleanup writes the prior target's progress), and on `beforeunload`. A `lastWrittenTime` guard suppresses duplicate writes

---

## Phase 5.7: Playback Resolution, Layout Re-Architecture, UX Fidelity ✅

### 5.7.1 MPV Transparency

- [x] `<html>/<body>/#root` `.playing-video` class: toggled by React effect on `duration > 0`. CSS forces all three transparent under that class (with a midnight-theme override) so the native MPV layer is visible behind the webview

### 5.7.2 Detail View Re-Architecture (Tech-Noir Command Center)

- [x] All metadata moved LEFT: logo, dense mono meta strip (Year / Runtime / 3 Ratings / Anime badge), accent rule, synopsis (`max-w-prose`), genre chips, AND every credit row (Director / Writers / Cast / Country) now live on the left
- [x] +30% typography on the left: logo `max-h-44`, fallback title `text-[64px] font-light`, meta `text-[14px]`, synopsis `text-[18px]` regular weight, genre chips `text-[12px]`, credit lines `text-[14.5px]`. The page reads like a Command Center brief
- [x] Compact RIGHT column: `max-w-md` fixed-width single panel pinned to the right. Frosted glass shell (`bg-black/65 backdrop-blur-2xl border border-white/12`)
- [x] Unified Episodes ↔ Streams panel: single panel that swaps mode in place. Movies start in Streams; series/anime start in Episodes; clicking an episode flips to Streams with a `← Episodes` back button in the header. Episode rows + season dropdown + stream chips all sized ~30% larger than 5.6

### 5.7.3 Home Page and Catalog Logic

- [x] 10-column CSS Grid: `grid-template-columns: repeat(10, minmax(0, 1fr))`. Exactly 10 cells per row at any viewport width (1080p → 3440×1440p). The horizontal-scroll/arrow code is gone for Discovery rows; cards stretch to fill columns
- [x] Slice + View All: Home displays `9 catalog items + 1 "View All" cell` per row. The View All card is accent-coloured and routes to a dedicated `<CatalogPageView />` that fetches the FULL 100-item catalog and renders an `auto-fill minmax(180px, 1fr)` grid. `<App>` tracks `activeCatalog` state; sidebar nav clears it
- [x] Native order, no addon prefix: rows render in strict manifest order (`is_search_only` excluded, primary-first). The previous "ADDON NAME" prefix labels on multi-source setups are removed; catalog name + type suffix is enough
- [x] Hero text-shadow: `<HeroCarousel />` no longer wraps title/synopsis in a glass card. Title uses `text-shadow: 0 2px 14px rgba(0,0,0,0.95), 0 0 28px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.8)`; logo uses `drop-shadow`. Cleaner over the backdrop
- [x] Continue Watching: 16:9 only: strictly uses `item.background`. Items without one are filtered out instead of falling back to a portrait poster; keeps the row visually consistent

### 5.7.4 Sidebar Evo and Profile Dropdown

- [x] Beefier weight: sidebar widened to `224px`, padding bumped to `px-3 py-4`, item rows to `px-3.5 py-3`, label text to `text-[14px]`, profile avatar to `36×36`. Icons jumped from `20×20` to `22×22`
- [x] Springy `.aura-glow`: active-item pill now transitions `top` / `height` with `cubic-bezier(0.34, 1.56, 0.64, 1)` (overshoot-on-arrive) over `400ms`, plus a slow 14s `aura-glow-pulse` that drifts the gradient so the pill never feels static
- [x] Profile popover: clicking the profile pill opens an `absolute left-full ml-3 w-[300px]` glass popover anchored to the right of the sidebar. Shows avatar + nickname/email, sync status pill (green dot for "Synced", neutral for "Local only"), and action buttons: Account settings (jumps to Settings), Log out (signed-in) or Sign in to Stremio (guest). Closes on outside click / Esc
- [x] Auth-state reactivity: the popover is fully driven by props (`userEmail`, `userNickname`); App.tsx now wires `onLoginRequest` and `onLogout` directly so the avatar reflects sign-in immediately without round-tripping through `setActiveView`

### 5.7.5 Global UX and Native Context

- [x] Anti-highlight: `body { user-select: none }` everywhere; opt-in `user-select: text` for `input` / `textarea` / `select` / `[contenteditable]`, the new `.selectable` class (used by synopsis, credits, stream rows), and the entire DevConsole
- [x] Native context-menu suppression: `main.tsx` installs a capture-phase `contextmenu` listener BEFORE React mounts and unconditionally `preventDefault()`s. Any element that wants its own menu still works (the custom `openContextMenu()` is independent), but the native browser menu is 100% gone

---

## Phase 5.8: Critical MPV Rendering, Ambient Aura, Search Overhaul ✅

### 5.8.1 MPV Black Screen and Z-Index Isolation

- [x] MPV hwdec=auto: switched from `auto-safe` per spec. Added `alpha=yes` and `force-window=no` so the embedded GL context truly stays transparent outside the active video and doesn't fight the webview's transparency
- [x] `<PlayerOverlay />`: dedicated `fixed inset-0 z-[9999]` container that mounts ONLY when `duration > 0`. Background is strictly `transparent`; that is what reveals the native MPV window behind the webview. The control bar, subtitle picker, ShaderPicker, CinemaSuite OSD, and exit button all live inside it
- [x] `stop_video` Tauri command + `handleExitPlayback`: `mpv.command("stop", …)` cleans up the file. `handleExitPlayback` flushes library progress first, then stops MPV, then clears `activeTarget`. Bound to a glass "Exit playback" pill anchored top-left of the overlay
- [x] App body hidden during playback: App.tsx wraps the whole sidebar + view + nav block in a div that gets `className="… hidden"` when `duration > 0`. DetailView is also strictly unmounted (`selectedMeta && duration <= 0`). Result: no opaque webview content paints over MPV; React stops layouting the body entirely

### 5.8.2 Global Ambient Aura and Animation Fixes

- [x] `<AmbientAura />`: single `position: fixed; inset: 0; z-index: -50; pointer-events: none` element mounted at the app root. Renders the same mirrored A→B→C→B→A spectral gradient as the title bar, but with `background-size: 200% 100%`, `background-position: 100% 50% → 0% 50%` over 36s, and only 6–10% stop opacities so the deep blacks of the glass panes stay deep
- [x] No-snap loop: both the title-bar `.aura-sweep` and the new `.aura-ambient` use the corrected mirrored gradient (stops at 0% and 100% carry identical colours), so the keyframe wrap is a visual no-op. The previous title-bar snap is fixed
- [x] Sidebar pill: pure GPU `translateY`: the `useLayoutEffect` DOM measurement code is gone. `<NavGroup>` renders a single absolute pill at `top: 0; height: 48px; transform: translateY(idx * 52px)` with a springy `cubic-bezier(0.34, 1.56, 0.64, 1)` 380ms transition. No reflow, no stutter. Two groups (top + bottom) each own their own pill so the indicator never has to leap across the flex-grow spacer
- [x] Profile button redesigned: chevron-tail with a status indicator dot (green/glowing for signed-in, neutral for guest) bolted onto the avatar. Pressing it opens the existing `<ProfilePopover />` to the right of the sidebar with auth-state-aware account/sync/logout actions
- [x] Profile popover anchoring: closes on outside click via `[data-profile-popover]` / `[data-profile-trigger]` data attributes (cleaner than node-contains tree-walking) and reliably reflects auth state because everything is driven from props

### 5.8.3 DnD Eradication and Search Catalogs

- [x] `@dnd-kit/sortable`: added `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`. The HTML5 DnD code in Settings → Additional Home Sources is gone. New `<SortableAddonRow>` uses `useSortable` with a `PointerSensor` (6px activation distance; clicks on Remove no longer accidentally start a drag) and a `KeyboardSensor` for accessibility
- [x] `global_search_grouped` Tauri command: fans out across every search-enabled addon, then iterates each addon's catalogs in manifest order, returning `Vec<SearchGroup { addon_name, addon_url, catalog_id, catalog_name, media_type, items }>`. Spawn-order preservation guarantees groups are returned in installed-addon order
- [x] `<SearchView />`: the new search results UI. Renders one `<DiscoveryRow>` per (addon, catalog); same 10-column CSS Grid as Home, same Stremio-style "Trending Movies / Action Series / Anime …" feel
- [x] SearchBar Enter behaviour: Enter now COMMITS the query: closes the dropdown, unmounts suggestions, calls `onSubmit(query)`. The auto-debounced "live" main-view search is removed; Home only switches to `<SearchView />` once the user explicitly hits Enter (or picks a recent search). Clearing the input fires `onClear()` which exits search view

### 5.8.4 AIOMetadata Logging Labels

- [x] `log_label(name, url)`: picks `"AIOMetadata"` for any addon whose name or URL matches `aio[\s-]?metadata`; otherwise uses the display name; falls back to the URL. Used as the prefix on every addon-related devlog line so the DevConsole filter input can isolate one addon's traffic instantly
- [x] Per-endpoint instrumentation: `[label]` prefix added to:
  - `get_addon_manifest`: catalog count + has_search
  - `fetch_catalog`: `GET <url>`, HTTP status / parse failure, `<type>/<id> → N item(s)`
  - `fetch_meta_detail`: `GET <url>`, plus a structured "mapped" line surfacing what came back (`name`, `type`, `poster=`, `bg=`, `logo=`, `videos=`, `cast=`, `ratings=`)
  - `fetch_streams`: manifest probe, declared types vs request type, request URL, HTTP / parse errors, raw vs kept stream counts
  - `fetch_external_subtitles`: request URL, HTTP / parse errors, kept count
  - `global_search_grouped`: per-addon, per-catalog request URLs and item counts

---

## Phase 6: Production Polish (rolling)

A grab-bag of post-5.8 work that isn't gated to a single rendering / IPC milestone. Add new entries here as features land; promote into a numbered phase when a cohesive arc emerges.

### 6.0.x Detail page, ratings, filtering ✅

- [x] OMDb integration: `fetch_omdb_ratings` (Rotten Tomatoes Tomatometer + Metacritic Metascore + IMDb backfill) deduped against addon-supplied ratings; merged in `mergedRatings`. Persistent 7-day cache (`aura:omdb-cache:v1`) skips the round-trip on re-opens
- [x] OMDb key as a user-supplied setting: `AppSettings::omdb_api_key` (no shipped default; users register a free 1,000-req/day key at omdbapi.com, paste into Settings → API Keys). Without a key OMDb is silently disabled; addon-supplied ratings + the MAL aggregator still render. Round-tripped via the export blob
- [x] AIOStreams notice icons: `partition_aio_pseudo_streams` separates `type === "statistic" | "error"` pseudo-streams into `errors / warnings / info / stats` buckets; `<StreamMetaBadges />` floats the icons in the gutter outside the streams panel via portal-rendered fixed positioning, popover anchors LEFT with viewport collision flip + mousewheel-priority scroll
- [x] Anti-spoiler toggles: Hide cast episode counts, Show AIOStreams notices, Blur unwatched thumbnails

### 6.0.5 Robustness and MPV Stability ✅

- [x] MPV property landmines documented (see `CLAUDE.md` for the full list); `mpv.set_property("name", &v)` (NOT `mpv.command("set_property", [...])`) is canonical, observed-property set is trimmed to `pause / time-pos / duration / volume / speed`, polling-only beyond
- [x] Win32 fullscreen path: `win32::enter_native_fullscreen` resizes the parent window to `rcMonitor` with `WS_POPUP` + `HWND_TOPMOST` + `SWP_FRAMECHANGED` (Tauri's setFullscreen lands at the work-area rect with the taskbar showing through)
- [x] MPV log rotation: `aura-mpv.log` rotates to `.old` at 50 MB so a previous run's final lines aren't truncated by the next launch
- [x] Rust panic hook: captures every panic to `%USERPROFILE%\aura-panic.log` with thread, location, message, and forced backtrace
- [x] JS error capture: `error` and `unhandledrejection` handlers installed in `main.tsx` BEFORE React mounts; forwards to DevConsole and dispatches `aura:fatal-error` for future Sentry / crash-receiver integration
- [x] Library normalization at the loadLibrary boundary: `libraryNormalize.ts` collapses per-episode entries into series-rooted records (`state.video_id` carries the episode); single fix-up shared by Library, Calendar, Continue Watching

### 6.0.x Theme expansion ✅

- [x] Six new themes beyond the original Mica/Glass/Midnight: Ember (warm amber), Forest (emerald slate), Rose (plum-grey), Amethyst (violet indigo), Ocean (teal midnight), Solar (sunburst dark). Theme dropdown in Settings now enumerates `THEME_LABELS` so all 9 themes are pickable

### 6.0.x Settings UX ✅

- [x] Settings search: pill-style input top-right of the Settings page; forgiving subsequence-fuzzy filter (`fuzzySubseq`); type "subfsz" → "Subtitle Font Size" matches without verbatim. Cmd/Ctrl-K focuses; Esc clears. Match-count pill + animated section enter
- [x] Storage management UI: Settings → Storage panel inspects + clears disk files (`aura-mpv.log`, `aura-panic.log`, rotations) and localStorage caches with destructive-vs-safe warnings. Backed by `get_storage_report` / `clear_storage_item` Tauri commands
- [x] Backup and Restore: JSON / base64 export of portable backend + aura-side settings (theme, audio/sub priorities, keybindings, RPC config, skip modes, OMDb key, etc.); whitelist-filtered import drops anything outside `PORTABLE_BACKEND_FIELDS` so a malicious blob can't smuggle in addon URL overrides

### 6.0.x Performance and caching ✅

- [x] Persistent meta cache: `metaCache.ts` hydrates from `aura:meta-cache:v1` on import, debounces writes (500ms), evicts oldest 25% at 1500 entries. Survives app restarts so re-opening Aura doesn't replay yesterday's MetaDetail round-trips
- [x] Persistent OMDb cache: 7-day TTL via `PersistentCache<OmdbRating[]>` keyed by IMDb id
- [x] Persistent AniSkip cache: 30-day TTL via `PersistentCache<AniSkipResult>` keyed by `mal:ep:treatMixed`. Skip windows for an aired episode are effectively immutable
- [x] `<PersistentCache />` generic helper: unifies hydrate / debounced-persist / TTL-eviction / soft-size-cap so future caches plug in with one constructor call
- [x] Hero metadata fetch dedupe: routes through `metaCache.getMetaDetail` (24h module cache + `dedupedInvoke`); fixed an 8× duplicate-fire bug where `heroLogoCache` in the effect deps re-ran the effect for every cache update
- [x] Hero logo cache survives HomeView remounts: `HERO_LOGO_MEMO` module-level Map seeds the React-state mirror so navigating Library → Home renders logos on first paint instead of flashing the bare h2
- [x] `loadAuraSettings()` memoization: module-level snapshot busted on save / `aura:settings-changed` / cross-tab `storage` events; collapses 6+ DetailView reads-per-render to a single object pointer
- [x] Episode sort consolidation: `episodeSort.ts::getSortedEpisodes(detail)` memoized via WeakMap; replaces three duplicated inline `[...detail.videos].sort()` callsites in autoAdvance, nextUp, and DetailView
- [x] Library partition single-pass: LibraryView now classifies items into bucket arrays + counts in one iteration (was 7 passes); critical for 1000+ item libraries
- [x] `useManualWatchedVersion` hook: useSyncExternalStore-based subscription replaces the SegmentedSeasonBar `useState+useEffect+tick` pattern. Cleaner subscribe/unsubscribe lifecycle for the dozens of CW-row instances
- [x] `will-change` pruned: removed permanent `will-change: transform` from `.card-grow` (every catalog card) and `.nav-tap` (every nav button). Kept on legitimately-animating elements (sweep, pulse, bell, popup)
- [x] Library scroll perf: `content-visibility: auto` with `contain-intrinsic-size`, removed per-card hover scale transitions, scroll-debounced suppress-transitions class
- [x] Vite production build: `target: "esnext"`, `sourcemap: false`, manual React vendor chunk, esbuild `drop: ["debugger"]`. Bundle-analyzer script (`pnpm build:analyze`) reports per-file sizes against a 600KB threshold

### 6.0.x UX polish ✅

- [x] Subtitle dynamic lift: `set_subtitle_position_runtime` IPC nudges `sub-pos` up by 12 percentage points when the player control bar is visible; restores the user's persisted baseline when the bar hides. `aura:settings-changed` keeps the effect in sync if the user moves the slider mid-playback via SubtitleStyleMenu
- [x] Tooltip portal + viewport-edge collision: `<Tooltip />` rebuilt to portal-render into `document.body` with `position: fixed` + `getBoundingClientRect`-driven placement that flips to the opposite side when the preferred edge would clip. Replaces the CSS-only `right-full mr-2` positioning that silently clipped at viewport / overflow boundaries
- [x] Theme cross-fade: switching themes cross-fades the entire UI in 280ms

### 6.0.x Networking, security, resilience ✅

- [x] CDN preheat: `App.handlePlayStream` fires a small `Range: bytes=0-65535` GET against the resolved URL right before `load_video`. Warms TLS / connection pool, cuts 100–500ms from cold-start latency on debrid CDNs
- [x] libavformat reconnect resilience: `demuxer-lavf-o` now sets `reconnect=1`, `reconnect_streamed=1`, `reconnect_on_network_error=1`, `reconnect_delay_max=4`. Addresses "long-anime EOF on idle keep-alive drop" without a parallel-range cache rewrite
- [x] TCP keep-alive on reqwest pools: `tcp_nodelay(true)` + `tcp_keepalive(60s)` on aniskip / auth / omdb / ratings / scrobble / stremio / subtitles clients. Survives firewall idle-timeouts; first-request latency drops from full handshake (~200ms) to single round-trip on warm pools
- [x] HTTPS enforcement on all reqwest pools: every long-lived client builds with `https_only(true)`; misconfigured `http://` URLs surface as a connection error rather than leaking the user/title/progress payload over plaintext
- [x] Sanitized scrobble error logs: error category only (timeout / connect / status / send), never the full reqwest error string (which can include the request URL with embedded auth)
- [x] Addon URL hardening: `validate_url` now also rejects empty / >2048-char inputs, embedded credentials (`user:pass@`), and path traversal (`/../`). Loopback intentionally allowed for self-hosted AIOMetadata / AIOStreams
- [x] Power-user network tuning notes: `CLAUDE.md` (Network tuning notes) documents Windows `netsh int tcp` autotuning + BBR2 + RSS, Linux sysctl bbr + rmem/wmem, and router-side SQM/cake recommendations for high-BDP debrid links

### 6.0.x Scrobble OAuth ✅

- [x] OAuth proxy at `aura.animasec.dev/oauth/{trakt,anilist}` holds the client_secrets; Aura desktop only sees access tokens
- [x] Trakt: device flow via proxy `/device/code` + `/device/token`; no scheme handler, no deep-link
- [x] AniList: authorization-code flow with `aura://oauth/anilist?...` callback handled by an in-app Tauri Webview (`open_oauth_popup_webview`) that intercepts the redirect via `on_navigation`, re-emits as `deep-link`, and never round-trips through the user's default browser
- [x] In-app popup gates the intercept by referring origin (only honours `aura://oauth/*` when the prior page was the proxy host) and renders a live security chip showing the current host
- [x] Tokens persisted in OS keyring under `(service, scope)` where scope is the first 12 chars of the active Stremio auth_key (or `guest`)
- [x] Trakt scrobble switched from `/scrobble/stop` (stale-session quirks, 409 on duplicates) to `/sync/history`: canonical "add to watched history" path
- [x] AniList save_progress: title search → media id resolve → SaveMediaListEntry mutation; per-show id cache persisted to disk; only updates if our episode > existing progress
- [x] Token redaction in three log sites (single-instance argv, deep-link arrival, popup intercept) so `token=<redacted>` lands in `aura-mpv.log` instead of the live JWT

### 6.0.x AniSkip OP/ED/recap skip ✅

- [x] `aniskip.rs` + `src-tauri/scripts/skip-windows.lua`: OP / ED / mixed-op / recap window fetch (AniSkip API, 24h negative cache, 30d positive `PersistentCache` keyed `mal:ep:treatMixed`). JSON written to MPV's `user-data/aura/skip-windows` property and consumed by the Lua observer that performs the seek (auto) or surfaces a "Skip …" toast (manual)
- [x] Settings → Anime OP / ED Skip exposes `skip_op_mode`, `skip_ed_mode`, `skip_recap_mode`, and `skip_treat_mixed_op_as_op`. Each kind is off / manual / auto
- [x] `silencedetect.rs`: ffmpeg-fallback silence-boundary detector for streams without AniSkip data AND without chapter markers. Shells out to `ffmpeg -af silencedetect`, parses stderr `silence_start` / `silence_end`, returns intervals
- [x] Chapter-merge guardrail: `App.tsx::mergeChapterSkipWindows` reads MPV's `chapter-list` in `string` format only (CLAUDE.md landmine #3 — `node` format hits the dispatch-table fault on this libmpv build)

### 6.0.x Discover / History / Queue views ✅

- [x] `<DiscoverView />`: Addon → Catalog dual pill selector; surfaces every catalog including the "enabled but hidden from home" set (`catalog_is_hidden_from_home` detects them via required-without-default extras like AIOMetadata's calendar-videos / schedule). FilterBar sidebar reused
- [x] `<HistoryView />`: Trakt-style automatic-watches feed (entries created at exit-playback when ≥ 85 % progress OR ≥ 5 min elapsed; manual marks excluded by contract). Scope-keyed `aura:history:<scope>` with 1000-entry cap; day-grouped with cumulative runtime totals; per-entry hover-X remove + "Clear history" wipe
- [x] `<QueueView />`: ordered list of items marked "planned". `@dnd-kit` drag reorder (PointerSensor with 6 px activation distance so Remove clicks don't accidentally start a drag; KeyboardSensor for accessibility). Reorder persists via `setManualWatchedOrder` and rides Aura Cloud's `manual-state` namespace
- [x] Both views integrate `FilterBar` (year / rating / genre / sort) so the existing filtering muscle works on personal feeds, not just discovery

### 6.0.x Watched marks + auto-bumped + auto-advance + Next-Up CTA ✅

- [x] `manualWatched.ts`: four-state per-id mark (watched / in-progress / planned / null); persisted under `aura:manual-state:<scope>`; legacy binary schema migrated on load
- [x] `<WatchedBadge />` + `<WatchedCheck />`: glass overlay icons on every tile across the app (green check for watched, yellow dot for in-progress, blue bookmark for planned)
- [x] `watchedSync.ts`: only the "watched" state pushes to Stremio cloud (via `state.aura_watched` + a `timeOffset` bump for movies); series-root only, episodes stay local. PULL never clobbers explicit local marks
- [x] `autoBumped.ts`: when a series the user already finished gets new aired episodes, the id lands in `aura:auto-bumped-series:v1` (cross-scope set) and the first new episode auto-marks in-progress. Continue Watching filter suppresses the row until the user re-engages (plays an ep / changes the mark / manually marks the new one watched)
- [x] `autoAdvance.ts`: after a watched episode, mark the next aired one in-progress (cross-season aware; specials handled separately). Series-root "watched" gate requires every aired episode watched (upcoming episodes excluded so a currently-airing series never auto-flips to "watched" prematurely)
- [x] `nextUp.ts` + `<NextUpCta />`: resolves the next episode (cross-season rollover supported) and pre-fetches its highest-priority stream. Floating bottom-right card surfaces during the final stretch (lead-time configurable, or end-of-ED chapter, whichever first). Explicit click; no silent auto-advance yet (deferred)
- [x] `<ResumePrompt />`: pre-load modal when the library carries non-trivial `state.timeOffset`. Two choices: Resume (default) or Start over. Esc / Enter map to start-over / resume; no auto-confirm timer. ms-vs-s normalization in `libraryNormalize.ts` for legacy seconds-written records

### 6.0.x Notifications system ✅

- [x] `NotificationsContext` ring buffer (soft cap 200; absolute hard cap 1000); seven kinds (release / episode / update / notice / success / warning / error). Undismissed entries never evicted by the soft cap — only dismissed entries compete for slots
- [x] `<NotificationsBell />` (bottom-left chrome) pulses on unread; click toggles `<NotificationsPanel />` (glass card anchored above). Popup defer: when the bell isn't on a visible surface (mid-playback, modal open) the popup waits and surfaces when the bell next mounts
- [x] `<NotificationsScanner />`: global 30-min interval (runs in every view, not just Home — earlier gate was the user-visible bug). 30-day recent-release window for first-scan seeding; optional `notifyOnlyWithStreams` toggle gates on `fetch_streams` returning at least one playable result (12 h availability cache). Coalesces popups (150 ms window) so a fresh install never chases the user with N popups for a single show
- [x] Persistence + cloud round-trip: full list to `aura:notifications:v1`; cloud sync via the `notifications` namespace with `(kind, id)`-dedup, undismissed-first eviction, and a re-read-disk-and-union write guard so a scanner fire mid-pull can't be clobbered by the merged write
- [x] Update notifications are non-dismissable individually (they have to be acted on by clicking through to the release URL); "Dismiss all" excludes them

### 6.0.x Per-title state + Stats panel ✅

- [x] `per_title.rs::TITLE_STATE`: per-id cache (`{media_type}:{id}` → `{volume, shader_profile, audio_lang, sub_lang}`); persists to `<app_data>/per-title.json`; survives episode replays and applies to sibling episodes within the same series. Bulk `get_all_title_state` / `set_all_title_state` so Aura Cloud's `title-state` namespace can round-trip the whole map
- [x] `stats.rs`: lightweight local counters persisted to `<app_data>/stats.json` (`watched_movie_secs`, `watched_anime_secs`, `streams_played`, `home_view_secs`); written from `useScrobble` + view-mount effects; surfaced in Settings → About. Local-only — never pushed to Aura Cloud

### 6.0.x In-app OAuth popup + AniList scrobble ✅

(supplements the earlier 6.0.x Scrobble OAuth entry — these landed on top of the proxy device-flow scaffold)

- [x] AniList authorization flow runs inside an in-app Tauri `WebviewWindow` (`open_oauth_popup_webview`); intercepts `aura://oauth/anilist?...` via `on_navigation`, re-emits as a `deep-link` event, never round-trips through the user's default browser. Origin-gated to honour `aura://oauth/*` only when the prior page was the proxy host; live security chip shows the current host
- [x] `scrobble_anilist.rs`: title-search → AniList media id resolve → `SaveMediaListEntry` mutation. Per-show id cache persisted to `<app_data>/anilist-id-cache.json`. No-op when the saved AniList progress already exceeds ours (no clobbering for users who scrobble from multiple clients)
- [x] `useScrobbleAuthAlerts.ts`: per-scope token-expiry watcher (`get_scrobble_auth_status`); fires warning notifications on Trakt / AniList 401s; rechecks on `focus` + `deep-link` events for mid-session token death
- [x] Scrobble test command: `DevConsole > scrobble` (Rust `scrobble_test_fire`) — fires Trakt `/sync/history` + AniList `SaveMediaListEntry` against the live session WITHOUT consuming it, synthesizes 95 % progress, reports per-provider fired/skipped status with rationale (no token, not flagged anime, unsupported id, etc.)

### 6.0.x System tray + window state + boot splash + resize handles ✅

- [x] `tray.rs`: always-installed tray icon (Show / Quit menu, left-click brings the main window to focus). Optional `minimize_to_tray_on_close` setting routes the close button into hide-to-tray
- [x] `tauri-plugin-window-state`: position + size + maximize state restored on launch; the `restore_state` setup hook runs before BootSplash paints so the window opens at the previous bounds
- [x] `<BootSplash />`: full-window glass card during startup + Stremio session restore; carries the same ambient gradient layer so the theme stays continuous through to the post-boot UI. Title bar slot kept uncovered (top:36px) so the chrome stays interactive during boot
- [x] `<ResizeHandles />`: invisible hit-targets on each edge + corner routing pointer-down through `getCurrentWindow().startResizeDragging(...)` since the title bar uses custom chrome (no native Windows edge-resize)

### 6.0.x DevConsole REPL ✅

- [x] `:` command line at the bottom of the console; tab-completion against the verb table; commands: `help`, `clear`, `pause` / `resume`, `search <q>`, `unfilter`, `level <name> <on|off>`, `info|warn|error|debug <msg>`, `throw [msg]` (JS Sentry test), `panic [msg]` (Rust `dev_force_panic`), `eval <expr>`, `version`, `scrobble` (live-session test fire, see scrobble OAuth section)

### 6.0.x Crash reporting (production) ✅

- [x] `sentry 0.46` + `sentry-rust-minidump 0.14`: Crashpad-style native crash capture self-spawns the Aura binary in "reporter" mode (recognised by a private CLI flag the crate registers) so no external handler binary needs to be bundled. JS side uses `@sentry/react` — both bootstraps gated on consent
- [x] First-run consent dialog (`<CrashReportingConsent />`); decision persists in `<app_data>/crash-reporting.json` (scope-independent so opting in survives Stremio account switches)
- [x] Hardcoded production DSN ships with the bundle; `SENTRY_DSN` / `VITE_SENTRY_DSN` env vars override for fork builds. `before_send` strips IP / geo / request on both ends; pair with the project-level "Prevent Storing of IP Addresses" toggle
- [x] `pnpm release` wraps signed Tauri build + PDB symbol upload via `scripts/release.ps1`; `profile.release.debug = "limited"` keeps PDBs ~3–5 MB while still resolving line tables for symbolication

### 6.0.x Open

- [ ] SMTC Next / Previous → queue advance: media-key events arrive at App.tsx but aren't routed into the queue / next-episode advance yet. Needs a one-line decision on semantics first — probably "queue first, then `nextUp.findNextEpisode` as fallback when the queue is empty"
- [ ] Silent auto-advance toggle: `<NextUpCta />` currently requires an explicit click. A user-opt-in setting that auto-fires `playNext` N seconds after the ED chapter (or last-N-second mark) would close the muscle-memory gap for binge sessions
- [ ] AniList re-auth UX: AniList has no refresh tokens, so a 401 mid-session means the next scrobble silently no-ops until the user manually re-connects. `useScrobbleAuthAlerts` fires a warning notification on first detection, but a one-tap "Reconnect AniList" button inside that notification (instead of routing through Settings) would close the loop
- [ ] Cloud Sync settings panel (Phase 7.7): sync engine + all seven namespaces are live but Settings has no dedicated section yet. Needs per-namespace last-pull / last-push / server-size readout, a "Pull now" button, and a "Clear cloud sync data" destructive action (calls `sync_purge`)
- [ ] Secret-key migration to OS keyring: Stremio auth tokens already live in the OS keyring (DPAPI via `keyring 3`); OMDb / OpenSubtitles API keys still sit in plaintext `settings.json`. Threat model is "single-user desktop, OS-level filesystem trust" so non-blocking, but the migration is the right move for shared-PC scenarios
- [x] Crash reporting receiver: Sentry SDK wired in (Rust panic hook + JS error capture + native minidump capture), gated on a first-run consent dialog (`CrashReportingConsent.tsx`)

---

## Phase 7: Aura Cloud — Account-Scoped Sync ✅ (sync engine) / 🟡 (settings panel)

**Status:** the sync client (`src-tauri/src/sync.rs`) and orchestrator (`src/sync.ts`)
are live. All seven namespaces round-trip on the proxy (`aura.animasec.dev/sync/v1/`):
`settings`, `manual-state`, `auto-bumped`, `notifications`, `recent-searches`,
`title-state`, `anilist-id-map`. Pull-on-login + 5-min background pull + 5s push
debounce across every change event. ETag optimistic concurrency with per-namespace
merge strategies (last-writer-wins, union, dedup-cap). The remaining open item is
the user-facing Settings panel described in §7.7 — sync currently runs silently
without a status surface. The original spec below stands as the design contract.

Push and pull every per-account piece of Aura state through the existing
`aura.animasec.dev` proxy so signing in to Aura on a fresh machine restores
the user's settings, manual marks, queue, recent searches, per-title
preferences, and AniList ID mappings. Library-level state (watch progress
on individual videos) continues to ride on Stremio's own cloud, since
that is already the source of truth.

### 7.1 Goals and non-goals

**In scope:**

- Round-trip Aura's app settings (themes, language defaults, Discord RPC config, keybindings, AniSkip modes, OMDb key, scrobble warmup overrides, etc.)
- Round-trip frontend `auraSettings` (`additionalHomeAddonUrls`, anti-spoiler toggles, etc.)
- Round-trip `aura:manual-state:<scope>` (queue + manual watched/in-progress marks)
- Round-trip `aura:auto-bumped-series:v1` (CW suppression for auto-completed series)
- Round-trip `aura:notifications:v1` (last-7-days notification ring buffer)
- Round-trip `aura:recent-searches`
- Round-trip per-title state (`per_title.rs`: per-show volume, shader, audio language, subtitle language)
- Round-trip the persistent AniList ID map (`anilist-id-cache.json`) so a fresh device skips the title-search round-trip on first scrobble

**Out of scope (intentional):**

- Library / watch progress: Stremio's `datastoreGet/Put` already syncs these per Stremio account; duplicating on our side adds a conflict surface with no QOL gain
- Cached metadata (`aura:meta-cache`, `aura:omdb-cache`, `aura:aniskip-cache`, `aura:anime-id-cache`): cheap to re-fetch, would dominate the per-user storage budget
- OAuth tokens (Trakt / AniList): live in the OS keyring per machine; syncing them across devices defeats the per-machine credential isolation
- Window position / size / fullscreen state (`tauri-plugin-window-state`): inherently per-machine
- Crash-reporting consent / DSN: per-install, not per-account
- Local logs and panic dumps

### 7.2 Auth model

The proxy already validates Stremio auth keys for the OAuth callback (the user is signed in to Stremio when initiating an OAuth flow). For sync, Aura sends a derived identifier on every request:

```
Authorization: Aura-Sync <sha256_hex(auth_key)>
```

The proxy stores blobs under that hash and never sees the raw auth key. Properties:

- Same security posture as Stremio itself: anyone holding the auth_key already owns the Stremio account, so deriving a sync scope from it adds no new compromise vector
- Proxy doesn't need to validate against Stremio on every call (saves a round-trip and reduces Stremio API load); a one-time validation cached for 24h is sufficient to weed out random hashes
- Guest mode: no auth_key, no sync. Settings stay local until the user signs in
- Logout: Aura wipes its local cache of the derived hash; the blob remains on the proxy for next sign-in (no destructive action on logout)
- Per-account isolation: switching Stremio accounts switches the sync scope

### 7.3 Endpoints

All endpoints under `/sync/v1/`. Authentication via the `Authorization: Aura-Sync <hash>` header. Content type is `application/json`. Per-blob max size is 1 MB; per-account aggregate cap is 10 MB.

**`GET /sync/v1/`**

List every namespace this account owns plus its current ETag and updated-at timestamp. Response body:

```json
{
  "namespaces": [
    { "name": "settings",       "etag": "h7Q…", "updated_at": 1715300000, "size": 4132 },
    { "name": "manual-state",   "etag": "p3K…", "updated_at": 1715299876, "size": 2018 },
    { "name": "anilist-id-map", "etag": "z9R…", "updated_at": 1715210000, "size":  956 }
  ],
  "total_size": 7106,
  "quota": 10485760
}
```

**`GET /sync/v1/{namespace}`**

Return the stored blob plus its ETag. 404 when the namespace doesn't exist for this account.

```json
{
  "data": { ... },
  "etag": "h7Q…",
  "updated_at": 1715300000
}
```

**`PUT /sync/v1/{namespace}`**

Write a blob. Accepts an optional `If-Match: <etag>` header for optimistic concurrency: if present and the stored ETag differs, return `412 Precondition Failed` with the current server blob in the body. On success returns `200 OK` with the new ETag and updated-at:

```json
{ "etag": "h7Q…", "updated_at": 1715300000 }
```

**`DELETE /sync/v1/{namespace}`**

Drop the blob. Idempotent; returns `204 No Content` whether or not it existed.

**`POST /sync/v1/_purge`**

Delete every blob owned by this account. Used by Settings → Privacy → "Clear cloud sync data". Returns `204`.

### 7.4 Namespaces

| Name             | Source                                  | Size class | Notes                                                            |
|------------------|-----------------------------------------|------------|------------------------------------------------------------------|
| `settings`       | `settings.rs::AppSettings` + `auraSettings.ts` blob | small | Merged client-side: backend fields take precedence over UI fields when keys collide |
| `manual-state`   | `aura:manual-state:<scope>`             | medium     | Queue (planned items, ordered) + manual watched/in-progress marks per series |
| `auto-bumped`    | `aura:auto-bumped-series:v1`            | small      | Series IDs the user marked watched manually so they don't re-enter CW |
| `notifications`  | `aura:notifications:v1`                 | small      | Last 7 days; older entries trimmed before push                   |
| `recent-searches`| `aura:recent-searches`                  | tiny       | Cap of 8 entries (already enforced client-side)                  |
| `title-state`    | `per_title.rs::TITLE_STATE`             | medium     | Per-title volume / shader / audio / subtitle preferences         |
| `anilist-id-map` | `anilist-id-cache.json`                 | small      | IMDB show id → AniList media id mapping (skips title-search)     |

### 7.5 Conflict resolution

- **Pull-on-login** is server-wins: the local cache is replaced by whatever the proxy returns. Conservative because the user may have switched devices and the cloud copy is more recent
- **Push-on-change** uses ETag optimistic concurrency. On `412 Precondition Failed`, Aura fetches the server version, merges per-namespace using a deterministic strategy (see below), and retries the PUT with the new ETag
- **Per-namespace merge strategies:**
  - `settings`: last-writer-wins on individual keys (compare per-key `updated_at` written in the blob; if absent, the side with the newer top-level `updated_at` wins). Avoids the "I changed Theme to Forest on laptop, then changed Audio Language to ja on desktop, and the desktop push wiped Theme back to Mica"
  - `manual-state`: union of marks and queue items, with the most-recently-modified mark winning per (id, episode_id) tuple. Deletions are tracked via a tombstone `removed: true` so a delete on one device propagates to another instead of getting overwritten by the older "still planned" record
  - `auto-bumped`: union of IDs (a series the user finished is finished everywhere)
  - `notifications`: union with deduplication on (kind, id, ts); cap at 100 entries after merge
  - `recent-searches`: server-wins (cheap; not worth the merge complexity)
  - `title-state`: per-title last-writer-wins
  - `anilist-id-map`: union; on conflict for the same IMDB id, the entry whose AniList id has more episodes wins (closer to the canonical multi-season disambiguation)

### 7.6 Storage and rate limits

- 1 MB per blob, 10 MB total per account
- 60 requests per minute per `(scope, ip)` pair; returns `429 Too Many Requests` with `Retry-After`
- Blobs older than 365 days with no read/write activity get garbage-collected (the user has stopped using Aura with that account)

### 7.7 Aura-side wiring

**Rust module** (`src-tauri/src/sync.rs`):

- `sync_status() -> SyncStatus` - returns `{connected, last_pull, namespaces}` for the Settings panel
- `sync_pull(namespace) -> Option<SyncBlob>` - fetch one blob
- `sync_pull_all() -> Vec<SyncBlob>` - fetch every namespace (login flow)
- `sync_push(namespace, data, if_match) -> PushResult` - write with optional ETag
- `sync_delete(namespace) -> ()` - drop one
- `sync_purge() -> ()` - drop all (Privacy panel)

The Rust side reads `auth_key` directly from `auth::load_session`, computes `sha256_hex`, and never exposes either to the frontend. JS just names a namespace.

**Frontend orchestration:**

- On `aura:scrobble-auth-changed` (signed in / out), trigger pull-all and merge into the corresponding local stores
- On `aura:settings-changed`, debounce 5s then push the `settings` namespace
- On `aura:manual-state-changed`, debounce 5s then push `manual-state`
- On `aura:auto-bumped-changed`, debounce 5s then push `auto-bumped`
- Per-title writes from `per_title.rs::set_title_state` push the `title-state` namespace (also debounced)
- Background pull every 5 minutes when the window is focused, to catch up from changes made on other devices
- Pause sync entirely while playback is active to keep the per-frame work clear of network I/O

**Settings UI:**

- A new "Cloud Sync" panel in Settings shows the per-namespace sync status (last pulled, last pushed, server size), a "Pull now" button, and a "Clear cloud sync data" destructive action that calls `sync_purge`

### 7.8 Proxy implementation notes

The proxy maintainer needs:

- A storage backend. Recommended: SQLite with `(scope_hash, namespace)` as the primary key plus an `updated_at`, `etag`, and `data` BLOB column. Simpler than Postgres for the expected scale
- ETag derivation: `sha256_hex(data)[..16]` is fine; collision risk is irrelevant for optimistic concurrency
- HTTP layer: keep the existing `gin` / `chi` / whatever the OAuth handler uses. Add the `/sync/v1/` route group with the auth middleware
- Auth middleware: parse `Authorization: Aura-Sync <hex>`, reject if not 64 hex chars, set the scope on the request context
- Quota enforcement: before every PUT, sum the existing per-namespace sizes for the scope and reject if `existing_total - existing_namespace_size + new_size > 10MB`
- Rate limiter: token bucket per `(scope, remote_addr)`, 60 req/min, leaky-bucket replenishment
- GC sweep: nightly cron deletes scope rows whose `MAX(updated_at)` is older than 365 days

---

## Phase 8: Onboarding, Player QoL, Chrome Polish, Search Hardening 🔴

A grab-bag of user-facing initiatives captured in the 2026-05-11 audit
session. Most are independent and can ship one-by-one as time allows;
the onboarding wizard is the biggest single arc. Every item below has a
matching entry in the in-session task tracker — refer there for the
implementation-level notes and edge-case checklists.

**Cross-cutting requirement:** every item in this phase carries a
"thoroughly tested" gate. New features must have their edge cases
exercised before being marked complete — see the per-item notes for
specific scenarios to walk through. The onboarding wizard in particular
has a long edge-case list (resume-after-quit, partial install state,
update vs reinstall detection, etc.) that needs every branch hit
before it can ship.

### 8.1 First-run onboarding wizard 🔴

Guided post-login flow that runs ONLY on a true fresh install (not on
version updates). Three pages, each independently skippable with
forward + back navigation:

1. Import existing Aura settings string / file (reuses `settingsTransfer.ts`)
2. No-addon-dependent setup: language priorities, theme, OMDb / OpenSubtitles keys (optional with "where do I get this?" link), scrobble connect (Trakt + AniList), AniSkip modes, Discord RPC consent
3. Recommended addon set — AIOMetadata, AIOStreams, Cinemeta (fallback), OpenSubtitles v3 / PRO. No download / configure walkthrough (defer to each addon's configure page). Includes a notice that this page can be reopened anytime from Addons → ↻ "Reopen onboarding addons"

Resume-after-quit semantics: persist the cursor + per-step state to
`<app_data>/onboarding.json` on every navigation. On startup, if that
file exists, jump straight to the saved step. Delete on completion.
Includes per-step partial state (e.g. half-set language picker) so a
mid-page exit doesn't lose the user's in-progress choices.

### 8.2 Hero edge-blur graceful handling 🔴

`HeroCarousel.tsx:153-161`'s dual mask-gradients produce visible hard
rectangles on dark-natured backdrops (caves, night shots) and the
bottom-vertical fade collides with the title + synopsis text. Options
under evaluation: dominant-color sampling to skew the mask toward the
backdrop's tone; narrower mask edges; relocate text out of the
gradient region; backdrop-filter blur strip behind only the text
bounding box; conditional side-vignettes gated on text placement.

### 8.3 Player overlay quality of life 🔴

- A/V sync + subtitle delay sliders (`audio-delay`, `sub-delay`) with persistent `per_title.rs` calibration
- Audio loudness normalization (`af=loudnorm`) toggle — Settings → Video & Audio AND a new "More" / three-dots menu on the control bar
- Frame-step / frame-back-step bound to `,` and `.` by default, rebindable via Settings → Keybindings

The three-dots menu becomes the generic home for low-frequency advanced
controls (loudness, panscan, screenshot, etc.) as they land.

### 8.4 Search reliability + progressive results 🟡

- [x] Spurious AI home catalogs firing on idle setting saves: `aura:settings-changed` now carries `detail.keys` so HomeView only re-fetches when home-relevant fields actually change
- [ ] Replace one-shot `global_search_grouped` await with progressive per-group display: each row gets its own skeleton until that group resolves, instead of the whole grid waiting for the slowest addon

### 8.5 Chrome surface polish 🔴

- Notifications bell badge count (drives off `unreadCount` in `NotificationsContext`)
- Sync-status chip in the title bar — gray cloud (guest) / spinner (mid-pull) / green check / amber stale / rose error, with a tooltip showing last-sync timestamp; click opens the new Cloud Sync settings panel
- Honor `prefers-reduced-motion` across the Aura sweep, AmbientAura, sidebar pill, bell pulse, BootSplash gradient, and HeroCarousel auto-advance. Add a Settings → Appearance "Reduce motion" toggle for users on platforms where the OS pref is too broad

### 8.6 Addons view polish 🔴

- Per-addon Refresh manifest button (`↻` icon, calls `get_addon_manifest` with cache-bypass)
- Replace AddonsView's "Remove" text with a styled icon (themed + animated, matched to the new Refresh icon as a paired button pack)
- Reopen-onboarding button on the page (links to step 3 of the wizard only)

### 8.7 Scrobble auth UX 🔴

- Surface precise token expiry dates in Settings → Trakt & AniList ("Expires <date>" + relative qualifier, amber when ≤ 3 days, rose + Reconnect button when expired). Backend's `expires_at: Option<u64>` is already populated — frontend formatting only
- "Reconnect AniList" inline action inside the warning notification fired by `useScrobbleAuthAlerts` (already tracked separately in 6.0.x Open as the AniList re-auth UX item)

### 8.8 Watched-marks menu reorganization 🔴

Reshape the right-click watched menu from seven flat items into two
top-level clickable parents ("Mark as Watched", "Mark as In Progress")
with hover-submenus for the bulk variants (this & below, this & above,
all, unmark this & above, unmark all). Requires extending
`ContextMenu.tsx` with `submenu?: ContextMenuItem[]` and reusing the
existing edge-clamp logic so the submenu flips left at viewport edges.

### 8.9 OpenSubtitles file-hash matching 🔴

`subtitles.rs::search_subtitles` currently searches by query + year +
imdb_id. OpenSubtitles' most reliable mode is the 64-bit Sub-DownloadHash
(first 64 KB + last 64 KB summed as 8-byte little-endian words, mod
2^64) — hash-matched cue files are virtually always frame-accurate to
that exact release. New Tauri command `compute_opensubtitles_hash(url)`
does the Range GETs against the resolved URL (HTTPS direct, HTTP via
the local axum bridge). `<SubtitlePicker />` includes the hash +
`moviebytesize` in the search payload; hash-matched results bubble to
the top with a "Hash match" badge. Falls back to query-based search on
any Range / TLS failure.

### 8.10 SVP Tier 2 — DROPPED

True svpflow/RIFE-via-VapourSynth interpolation was scoped here but
**dropped at the user's request** — Tier 1 is mpv's built-in GPU
interpolation (`video-sync=display-resample` + `interpolation` +
`tscale`), which the user dials in directly; the heavy bundled-runtime
SVP path is not wanted. Left as a tombstone so the numbering stays
stable and the decision is on record.

### 8.11 Skip: Kai-style Hybrid Mode (blackdetect + silencedetect) 🟢 SHIPPED (bounded slice)

The pragmatic, low-risk slice is **done**:

- `silencedetect.rs::detect_outro_boundary` — ONE bounded ffmpeg pass
  over the stream's last few minutes (`-sseof`), downscaled
  `blackdetect` + `silencedetect`, heuristically picks the credits/ED
  start (earliest hard-black-cut, else long-silence, excluding the
  seek-in artefact and the EOF fade). It does NOT stamp a skip window
  (no reliable end without container duration) — it hands the Next-Up
  CTA an ED-start so the card fires on time for live-action / anything
  AniSkip + chapters miss.
- The auto OP silencedetect fallback (already shipped) is now armed for
  **every series path, anime AND live-action** (Hybrid opt-in), not
  just the MAL-resolved one. Both passes are ffmpeg-on-PATH best-effort
  (clean no-op without it), bounded + kill-on-drop, prompt-mode.

**Deliberately NOT done** (and recommended against): Kai's 90×-speed
full-scan with live `vf-metadata`/`af-metadata` observation. It
collides head-on with Aura's seek/property-race + `observed_properties`
landmines, needs native orchestration (Lua `load-script` unreliable),
and the bounded tail-scan above already covers the real-world need.
Reopen only if a concrete gap appears that the tail-scan can't reach.
The chaptered case remains covered by the §8 chapter-heuristic path.

### 8.12 Hover-seek thumbnails — real frame source/engine 🔴 ⏸ DEFERRED

The hover-thumbnail **UI** (preview box + loading animation + always-on
timestamp + Settings/player toggles + the `ThumbFrame` resolver prop)
is **shipped** (`feat(player): hover-seek thumbnail UI…`). What's
deferred is the frame *source*:

- Addon **BIF/WebVTT** was the original low-risk plan, but the Stremio
  `Stream` object spec has no scrub-thumbnail field — addons
  effectively never ship one, so that resolver would be ~always null.
- The functional engines are the risky ones: (a) a Rust-managed second
  headless libmpv instance doing `screenshot-raw` — untested
  multi-instance stability on Aura's `libmpv-wrapper` build, and a
  crash shares the process; (b) per-hover ffmpeg seek-extract via the
  bridge — ffmpeg not bundled, debrid/HTTPS-bypass latency + auth.

Revisit with a chosen engine, prototyped behind a flag with runtime
stress-testing against the MPV landmines. The UI already degrades
cleanly (timestamp-only) until an engine lands.

### 8.13 Skip reliability — timing + MAL prefetch 🔴 ⏸ DEFERRED

Shipped: AniSkip cache TTL curated 30 d → 3 d so community corrections
surface within days. Deferred (need runtime verification; touch the
MPV-timing / play-dispatch paths governed by the seek/loadfile
landmines — unsafe to change blind): (1) sub-second auto-skip seek
timing precision (currently bounded by `time-pos` event granularity);
(2) MAL-resolution prefetch at detail-open so windows are ready before
the OP instead of racing it from playback start.

---

## Technical Constraints

| Constraint | Detail |
|------------|--------|
| HTTP client | `reqwest 0.12` with `rustls-tls`. Auth and account clients enforce `https_only(true)` |
| Session storage | Platform-native keyring (`keyring 3`). No plaintext credential files |
| Credential safety | Passwords wrapped in `Zeroizing<String>`; zeroed on drop |
| Video output | MPV via `tauri-plugin-libmpv`, `gpu-next` renderer, `hwdec=auto-safe` |
| Permissions | Tauri capability system; all IPC commands declared in `permissions/player.toml` |
| File I/O | Scoped to `app_data_dir()`; no arbitrary filesystem access |
| Search safety | All poster URLs validated; text fields capped before returning to frontend |
| Capability scope | `default.json` declares both `windows: ["main"]` AND `webviews: ["main"]` so child popup webviews loading external HTTPS pages cannot inherit IPC access |
