# Aura — Development Roadmap

## Phase 1: Core Engine & Spatial Shell — ✅ Complete

| Task | Description | Status |
|------|-------------|--------|
| 1.1 | Tauri 2.0 scaffold with transparency & Mica vibrancy | ✅ |
| 1.2 | MPV engine init via `tauri-plugin-libmpv` | ✅ |
| 1.3 | IPC bridge — `toggle_pause`, `seek_relative`, `set_volume`, `playback-update` events | ✅ |
| 1.4 | Spatial UI shell — glass pill control bar, `useAutoHide`, `usePlayback` | ✅ |

---

## Phase 2: Stremio Compatibility & Account Sync

### 2.1 Catalog Browsing — ✅ Complete
`fetch_catalog` Rust command, `CatalogGrid` component, 10 s timeout, addon manifest parsing.

### 2.2 Stremio Account Auth & Sync — ✅ Complete
Platform keyring, `Zeroizing<String>` password scrubbing, `https_only` auth client,
`SESSION_EXPIRED` sentinel, `LoginView`, sidebar sync status, startup session restore.

### 2.3 Global Search & Cloud Addon Sync — ✅ Complete
- [x] `global_search` — concurrent `JoinSet` across all `has_search` addons
- [x] 300 ms frontend debounce (rate-limit protection)
- [x] `cloud_add_addon` / `cloud_remove_addon` — `addonCollectionGet → modify → addonCollectionSet`
- [x] `AddonSidebar` Add form active for logged-in users (cloud write) and guests (local write)
- [x] Remove button always visible; routes to cloud or local based on session state
- [x] Metadata sanitization: poster URLs validated (http/https ≤ 2 KB); text fields capped
- [x] URL validation before any cloud write (prevents manifest injection)
- [x] `SearchResultsGrid` component with unified results view
- [x] Control bar hidden when no video is loaded (`duration === 0`)

> **Architecture note:** When a session is active, Stremio account API is the source of truth for
> addon persistence. Local `addons.json` is read/written only in guest mode.

### 2.4 Local Streaming Bridge — 🟡 Partial
- [x] `axum` HTTP proxy server on port 11471
- [x] `/proxy/*url` — byte-range forwarding for HTTP/HTTPS streams (MPV seek support)
- [x] `/health` readiness probe
- [x] `resolve_stream` Tauri command — converts raw stream URLs to bridge proxy URLs
- [x] Config struct (`BridgeConfig`): cache root, cache size, max connections
- [x] **HTTPS direct passthrough** — bypass proxy for `https://` URLs since MPV speaks HTTPS natively (and many addon hosts have certs that don't match `127.0.0.1`)
- [~] `/magnet/*` direct torrent streaming — **WON'T IMPLEMENT.** Aura is built specifically for the Stremio addon ecosystem with Debrid services in front; native magnet handling is out of scope to keep the legal posture clear. The bridge stub remains for forward-compat but no torrent engine will be integrated.

### 2.5 OS Deep Linking — ✅ Complete (route table) / 🟡 Partial (signing)
- [x] `tauri-plugin-deep-link` registered; `aura://` and `stremio://` protocol schemes configured
- [x] Incoming URL forwarded to frontend as `deep-link` Tauri event
- [x] **`aura://search?q=...`** — handled in App.tsx; navigates to Home, queues query, fires search
- [x] **`stremio://detail/{type}/{id}`** (and `aura://detail/<type>/<id>` alias) — routes to DetailView with a stub MetaPreview, full meta detail filled in by DetailView's own fetch
- [x] **Auto-updater wired** — `tauri-plugin-updater` registered with `endpoints` pointing at `github.com/rm-sage/Aura/releases/latest/download/latest.json`; `updater.ts` + `updaterPlugin.ts` perform the version check
  - [ ] **Update signing keypair** — `pubkey` in `tauri.conf.json` is still the placeholder. Per `PRODUCTION.md`, generating a real keypair is blocked on Authenticode code signing (Tauri's updater rejects unsigned payloads)

### 2.6 Cinema Suite & Performance Overlay — ✅ Complete
- [x] **12-profile shader system** — None (0), legacy Anime4K (1, hidden), FSR (2), FSRCNNX (3), KrigBilateral (4), RAVU (5), SSimSuperRes (6), plus Anime4K v4 chains: Mode A (7), Mode B (8), Mode A+A (9), Mode B+B (10), Mode C (11), Mode C+C (12)
- [x] **Anime4K modes hover submenu** in PlayerOverlay's ShaderPicker — A/B/C/A+A/B+B/C+C grouped under a non-clickable "Anime4K" parent; each mode shows its chord binding next to its name
- [x] **Anime4K chord defaults** — Ctrl+1..6 → A/B/C/A+A/B+B/C+C, Ctrl+0 → disable. Fully rebindable via Settings → Keybindings (chord support landed when useKeybindings learned modifier syntax)
- [x] Shader picker UI (`PlayerOverlay.tsx ShaderPicker`) — glass dropdown with profile list + Anime4K hover submenu
- [x] Backtick (`` ` ``) key toggles Performance OSD
- [x] OSD shows: render group (profile, decoder, resolution, FPS, frame drops, A/V sync), Network (cache, buffer fill %, paused-for-cache, network bps), HDR/Dolby Vision section when active video params expose it (signal kind, tone-mapping mode, source pixel format)
- [x] `vo=gpu-next`, `target-colorspace-hint=yes`, `hdr-compute-peak=yes`, `tone-mapping=auto`
- [x] Dolby Atmos / DTS-X audio passthrough (`audio-spdif`, `audio-exclusive=yes`) — opt-in via Settings (off by default to avoid WASAPI device lock)
- [x] Subtitle defaults (pos 95, size 45, border 3, shadow 2)
- [ ] Shader files: place in `src-tauri/shaders/` (see `shaders/README.txt` for download links + per-mode required filenames)

---

## Phase 3: Navigation, Views & Playback Pipeline

### 3.1 Navigation Refactor & Cinema UI — ✅ Complete
- [x] `NavSidebar` — slim 60 px glass panel with Home / Library / Addons / Calendar / Settings icons
- [x] `HomeView` — source selector pills, per-addon catalog picker, search bar, results grid
- [x] `AddonsView` — full addon management (add/remove, cloud sync routing, inline login)
- [x] `SettingsView` — Default Home Catalog + Default Metadata Provider dropdowns (localStorage)
- [x] `LibraryView` / `CalendarView` — placeholder screens
- [x] `App.tsx` rewritten with view-router, auth state lifted, AddonSidebar removed
- [x] Shader picker moved into video control bar (pill button, shown only during playback)
- [x] `CinemaSuite` stripped to OSD-only (backtick toggle; no floating ✦ button)
- [x] IMDb score overlay removed from all poster cards
- [x] Settings persisted to `localStorage` key `"aura:settings:v1"`

### 3.2 Home Overhaul, Library Sync & Theme Engine — ✅ Complete
- [x] `library_get` / `library_put` — Stremio `datastoreGet/Put` for `libraryItem` collection
- [x] `fetch_meta_detail` — full `/meta/{type}/{id}.json` fetch with sanitization (released, runtime, background)
- [x] `MetaPreview` extended with `background` and `logo` URLs
- [x] **HeroCarousel** — full-width 21:9 backdrop, deep blur + vignette, glass overlay (title/year/synopsis), hover arrows + dot pagination, 8 s auto-advance pausing on hover
- [x] **Cinema Flow rows** — `ContinueWatchingRow` (16:9 backdrops with progress bar), `DiscoveryRow` (portrait posters); independent horizontal scroll with hover arrows; loading skeletons
- [x] HomeView rewritten — top tab/category header removed; renders Hero → Continue Watching → all catalog rows fetched in parallel from the default home addon
- [x] **CalendarView** — fetches full meta detail for every library item (concurrency 4) and groups by `released` (or `release_info` / year) into the current Mon–Sun bucket
- [x] **Settings module (Rust)** — `settings.json` in app_data_dir; `get_settings`, `set_theme` commands with validation
- [x] **ThemeEngine** — React provider that owns `data-theme` on `<html>` and round-trips to backend; CSS tokens scoped per theme
- [x] Three theme profiles: **Mica** (Win 11 native vibrancy), **Glass** (custom high-blur), **Midnight** (pure black, OLED, blur=0)
- [x] Theme dropdown added to Settings; switching cross-fades the entire UI in 280 ms
- [x] `AddonSidebar.tsx` deleted (was already unused after Phase 3.1)

### 3.3 Entry Flow, Scrobbling & Window Architecture — ✅ Complete
- [x] **Custom title bar** (`TitleBar.tsx`) — `data-tauri-drag-region`, glass min/max/close buttons (pointer-events safe), double-click maximize, Maximize ↔ Restore icon flip via `onResized`
- [x] **Aura Spectral Sweep** — GPU-accelerated CSS animation (`translate3d`, `will-change: transform`, `mix-blend-mode: screen`); 20 s linear loop at 0.10 – 0.18 opacity, no CPU cost
- [x] Tauri capabilities extended: `core:window:allow-{minimize, toggle-maximize, is-maximized, close, start-dragging}`
- [x] **LandingView** — full-screen Sign In / Continue as Guest with subtle 60 s Aura sweep backdrop
- [x] Token caching: keyring 3 already provides DPAPI / Keychain / Secret Service encryption — landing is bypassed when a session is restored
- [x] NavSidebar **profile button** — initial-letter avatar when signed in, opens login when guest
- [x] **HeroCarousel** — prefers `background`; falls back to 20 px-blur poster with 1.08 scale to hide blurred edges
- [x] **AIOMetadata helpers** (`aiometadata.ts`) — `typeLabel`, `withTypeSuffix` ("Trending Movies", "Top Anime"), `isAnimeMeta` (`media_type === "anime"` ∨ id prefix in `kitsu:`/`anilist:`/`mal:`/`anidb:`)
- [x] HomeView applies suffix mapping to every Discovery row
- [x] **Scrobble pipeline** (`scrobble.rs` + `useScrobble.ts`) — `scrobble_start` / `scrobble_heartbeat` (60 s) / `scrobble_end` POSTed to the user's AIOMetadata addon URL; auto-end at 90% progress; best-effort, never blocks playback
- [x] **Settings split** — Playback section is now two cards: "Global Defaults" (default audio + subs language) and "Anime Defaults" (e.g. Japanese audio + English subs); `apply_lang_defaults` Tauri command applies them to MPV's `alang` / `slang` with comma-separated fallbacks
- [x] **Discord Rich Presence** (`window_logic.rs`) — `discord-rich-presence 0.2` IPC client, lazy connect with retry on next call, `discord_set_presence` / `discord_clear_presence`; **Privacy Mode**: enable toggle, show-titles toggle, per-title blocklist
- [x] **Window lifecycle** — `pause_on_minimize` (Resized → 0,0), `pause_on_lost_focus` (`Focused(false)`), `close_on_exit` (CloseRequested → MPV stop + RPC clear)
- [x] Backend settings consolidated in `settings.rs` with in-memory cache for high-traffic readers (window callbacks); `update_settings` round-trips a JSON patch and revalidates theme

### 3.4 Optimization & UI Refinement — ✅ Complete

**Performance:**
- [x] `RowShell` and `HeroCarousel` promoted to dedicated GPU compositor layers (`will-change: transform; transform: translateZ(0); backface-visibility: hidden`) so scrolling Row 5 doesn't repaint Rows 1–4
- [x] `content-visibility: auto` (with `contain-intrinsic-size`) on rows + hero — browser skips layout & paint for off-screen content
- [x] `React.memo` wrap on `DiscoveryRow`, `ContinueWatchingRow`, `HeroCarousel`, `CatalogCard`, `ContinueWatchingCard`, and both `PosterCard`s (catalog grid + search results)

**Aura Sweep (seamless infinite loop):**
- [x] Replaced `translate3d` keyframe with mirrored gradient (A→B→C→B→A), `background-size: 200% 100%`, animating `background-position: 0% → 100%` over 20 s linear; same loop period drives the title-bar text fill so glyph and bar share one moving spectrum

**Title bar:**
- [x] Centered "AURA" wordmark with glass-textured letters (`background-clip: text` over the same spectral gradient, plus a translucent text-stroke and dual drop-shadow for volume) — the moving sweep appears to flow through the letters
- [x] Wordmark "A" tile removed; bar layout is min/max/close on the right, AURA optically centered, drag region everywhere else

**Ultrawide & Dropdown styling:**
- [x] `SettingsView` content centred in a `max-w-6xl mx-auto` column on top of the full-width glass background
- [x] New theme-scoped tokens `--glass-bg`, `--glass-bg-soft`, `--text-primary`, `--text-muted` mapped per theme (Mica/Glass/Midnight)
- [x] Global `select` and `option` rules use those tokens to kill Chromium's "blinding white" default

**Monthly Visual Calendar:**
- [x] 7-column `grid-cols-7` month grid with 6 rows; Mon-anchored; previous/next month dimmed
- [x] Per-day heatmap dot (single → glow → glow + larger as count grows)
- [x] Click any cell → vertical detail list of releases below the grid
- [x] **Today** cell glows with the Aura spectrum via `.cal-today` (multi-stop box-shadow: blue rim → purple mid → teal outer)
- [x] Prev / Next / Today navigation; current month label and total-in-library count

**Hero metadata cascade:**
- [x] Priority `background → fanart → backdrop → poster` (poster path uses 20 px blur + 1.08 scale to hide bleed)
- [x] `WireMeta` and `MetaPreview` extended (Rust + TS) with `fanart` and `backdrop` fields, sanitized through the same URL pipeline as `poster` / `background`

**Scrobble lock:**
- [x] `findAIOMetadataAddon` helper in `aiometadata.ts` (matches "aio[ -]?metadata" in name OR url, case-insensitive)
- [x] When AIOMetadata is installed, `SettingsView` auto-patches the backend `scrobble_addon_url` to its URL, disables the input, and renders a "Managed by AIOMetadata" badge

**Multi-addon home catalogs (user request):**
- [x] New shared `auraSettings.ts` module — adds `additionalHomeAddonUrls: string[]` and dispatches `aura:settings-changed` events on save
- [x] `AddonMultiPicker` control in Settings → "Additional Home Sources" (primary entry shown but disabled to prevent dup)
- [x] HomeView fans out across `[primary, ...additional]` addons in parallel; rows labelled with source name when more than one source is active

---

## Phase 4: External Metadata, Filtering & System Integration — ✅ Complete

### 4.1 Subtitle Powerhouse (OpenSubtitles)
- [x] `subtitles.rs` — api.opensubtitles.com REST v1 bridge with `https_only` client
- [x] `search_subtitles` (query / year / imdb_id / languages), `download_subtitle` (single-use download URL → app_data_dir/subtitles), `add_subtitle_to_mpv` (mpv `sub-add … select`)
- [x] API key stored in `settings.opensubtitles_api_key`; configurable via Settings → Subtitles
- [x] Filename sanitization on the server-supplied download name
- [x] `SubtitlePicker` glass overlay — query box, language preset, results list with download counts and CC flag; auto-injects + auto-closes on success
- [x] Toggle button in the player control bar; keybinding `toggle-subtitles`

### 4.2 Advanced Filtering (Client-Side)
- [x] `genres` field added to `WireMeta`, `MetaPreview`, `MetaDetail` (Rust + TS) with cap-and-truncate sanitization
- [x] `FilterBar` component — year range slider (clamped to actual data), min-rating slider, genre multi-select chips, sort by rating/year/name
- [x] `applyFilters` is pure JS over an in-memory list; instantaneous on 50+ items
- [x] Wired into HomeView (right side of Discovery rows; multi-source labels preserved) and SearchResultsGrid (right of grid; result count shows "x of y")

### 4.3 SMTC (System Media Transport Controls)
- [x] `souvlaki 0.7` integration in `media_controls.rs`; HWND captured from Tauri's main window
- [x] Dedicated thread owns `MediaControls` (it's `!Send` on Windows); commands marshalled via `mpsc::Sender<Cmd>`
- [x] `smtc_set_metadata` / `smtc_set_playback` / `smtc_clear` Tauri commands
- [x] OS media-key events (Play/Pause/Toggle/Stop/Next/Previous) re-emitted as `smtc-event`; App.tsx forwards to MPV via `togglePause`
- [x] App.tsx pushes title + episode + duration on `activeTarget` change; updates state on every pause/seek

### 4.4 Custom Keybindings Engine
- [x] `keybindings: HashMap<String, String>` added to `AppSettings` with `default_keybindings()` (KeyboardEvent.code → action)
- [x] `useKeybindings.ts` hook — single global keydown listener, locale-independent codes, suppressed inside form controls
- [x] Settings → Keybindings: action list with capture-on-press; press any key to bind, Escape to cancel
- [x] Wired actions: toggle-pause, seek-back / forward, volume-up / down, toggle-osd, cycle-shader, toggle-subtitles, fullscreen
- [x] CinemaSuite OSD now toggles via `aura:toggle-osd` event (no more direct keydown), ShaderPicker cycles via `aura:cycle-shader`

### 4.5 Visual Polish
- [x] Hero dual-layer composition — when backdrop natural width < 900 px (or only a portrait poster exists) the carousel renders heavily-blurred + scaled background **plus** a sharp poster card on the left; title card slides right to make room
- [x] `Tooltip.tsx` — global glass-styled tooltip (CSS-only animation, `glass-panel-elevated` styling, configurable position + optional shortcut hint)
- [x] Tooltips applied to NavSidebar buttons, profile avatar, TitleBar window controls, all player control-bar buttons

---

## Phase 5: AIOMetadata Design Language & Detail View — ✅ Complete

### 5.1 Evo Sidebar
- [x] NavSidebar transformed into a 200 px floating glass island (`glass-panel-elevated rounded-2xl`); no border-r
- [x] App body wraps in `flex gap-3 p-3` so the panel sits on its own with breathing room
- [x] Items now show icon + text label; profile button shows avatar + email line
- [x] **Animated Aura glow** — single positioned span tracks the active item via `useLayoutEffect`-measured `offsetTop`/`offsetHeight`; transitions in 300 ms with a blue→violet linear gradient + accent inset border + glow shadow

### 5.2 Search Bar Centering + Filter Popover
- [x] Search bar centred in the page, capped at `max-w-2xl mx-auto`, switched to `rounded-full` pill styling
- [x] Inline filter trigger inside the input (right edge); accent dot when filters are dirty
- [x] FilterBar now opens as a glass popover anchored below the search field; `fixed inset-0` backdrop closes on click-out
- [x] Right-rail FilterBar removed from HomeView and SearchResultsGrid

### 5.3 AIOMetadata Deep Mapping
- [x] `WireMeta` already exposed `logo` / `background` / `fanart` / `backdrop`; `MetaDetail` extended with `cast`, `director`, `writer`, `country`, and a structured `ratings: Vec<{source, value}>`
- [x] Sanitization caps: 12 cast, 4 director / writer, 8 ratings; per-string char limits applied
- [x] Multi-source ratings collected from both the structured `ratings[]` array and scalar `imdbRating`/`kpRating`/`malScore` fields
- [x] HeroCarousel renders **stylized logo art** (drop-shadowed) when `meta.logo` is present; falls back to text title otherwise
- [x] Continue Watching uses `background` (16:9) — already correct
- [x] Discovery uses `poster` (2:3) — already correct
- [x] **Search-only catalogs excluded** from Home: backend now flags `is_search_only` on `CatalogInfo` (true when `extra` includes `{ name: "search", isRequired: true }`); HomeView filters them out

### 5.4 Catalog Ordering
- [x] Settings → "Additional Home Sources" became a drag-and-drop reorderable list (HTML5 native DnD, no extra deps)
- [x] Selected items shown with a drag handle (`⋮⋮`) at top; available addons shown below; primary marked separately
- [x] Order persists in `auraSettings.additionalHomeAddonUrls` and feeds `resolveHomeAddons` → display order on Home

### 5.5 Cinematic Detail View
- [x] New `DetailView.tsx` — full-screen overlay (z-60), opens with shared-element transform from the originating card's `getBoundingClientRect()`
- [x] **Hero header** — full-width backdrop, deep bottom vignette, **stylized logo overlay** (max-h 32, drop-shadow), meta strip (type pill, year, runtime, top-3 ratings, Anime badge when applicable)
- [x] **Metadata grid** — Synopsis + genre chips on the left, Director / Writers / Cast / Country glass cards on the right
- [x] **Streams** — `fetch_streams` Tauri command fans out across every addon with a stream resource (concurrent via `JoinSet`); deduped by url/info_hash; grouped by provider in the UI
- [x] **Spectral Pulse** loader — three orbiting blurred discs (indigo/teal/violet); orbit period and disc opacity scale with discovery progress
- [x] Click any stream → `resolve_stream` (bridge-proxies HTTP, magnet stub) → `load_video`; sets `activeTarget` so scrobble + RPC + SMTC all light up; closes the detail view
- [x] Click outside / Esc / Back button all dismiss

### 5.6 Interaction Upgrades
- [x] **Volume scroll** — global wheel listener active while a video is loaded; ±5% per tick. Skips the event when the wheel is over a scrollable element (catalogs, sidebar list, etc.) so vertical scrolling still works
- [x] **Shared-element open** — clicking a poster captures its `DOMRect`; the DetailView starts at that rect's transform and animates to fullscreen via `transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1)`
- [x] All catalog cards (CinemaRows.CatalogCard, SearchResultsGrid.PosterCard, HeroCarousel hero card) tagged with `data-meta-card="{type}:{id}"` for the rect lookup

### 5.7 Next — ✅ Mostly shipped
- [x] **Resume position writeback** to `library_put` while playing — `libraryWriteProgress` flushes `state.timeOffset` + `state.duration` on pause / target change / `beforeunload` with an 800 ms debounce + dedupe guard
- [x] **Subtitle / audio track selector dropdowns** in the control bar — `PlayerOverlay` exposes both via `set_audio_track` / `set_subtitle_track` IPC; merges embedded MPV tracks with addon-supplied external subtitles
- [x] **Playlist / queue** — `<QueueView />` renders manually-marked "planned" items with reorderable order persisted in `aura:manual-state:`. Episode auto-advance for series after a watched milestone is wired via `advanceWatchedAfter`
- [ ] **SMTC Next / Previous wiring** — media-key events `next` / `previous` arrive at App.tsx but aren't routed into the queue / next-episode advance yet (see comment in `smtc-event` handler)

---

## Phase 5.5: Native Interactions, Fixed Viewports & Stabilization — ✅ Complete

### 5.5.1 Critical Playback & Routing
- [x] **`resolve_stream` parameter alignment** — Rust command now takes `raw_url: String` so the JS-side `{ rawUrl }` snake-case mapping resolves cleanly; `handlePlayStream` reliably runs `resolve_stream → load_video → setActiveTarget → closeDetail`
- [x] **Continue Watching → DetailView** — `ContinueWatchingCard` is now a button with `onClick`/`onContextMenu`/`data-meta-card` so the shared-element open and right-click menus work the same as discovery rows
- [x] **DnD reorder polish** — Settings → Additional Home Sources gains visible drop indicators (top/bottom accent rails), `dataTransfer.setData("text/plain", …)` for engines that require it, and `dragenter` highlighting

### 5.5.2 Cinematic, Viewport-Locked Detail View
- [x] `fixed inset-0 flex` outer — no page scroll, fits in the viewport regardless of content height
- [x] **Left (flex-1)**: hero with raw `object-cover` + `object-position: center top`, deep vignette, stylized logo, meta strip, **`max-w-prose` synopsis** at 17 px / leading-1.55 / weight-light, genre chips
- [x] **Right (520 px)**: top scrollable Cast/Director/Writers/Country/Ratings cards; bottom internally-scrollable Streams column grouped by addon
- [x] **No forced blur/zoom** on sharp landscape art (HeroCarousel + DetailView) — only the portrait/low-res fallback path keeps the dual-layer soft-focus composition

### 5.5.3 Native Right-Click Context Menus
- [x] Custom React `<ContextMenuHost />` mounted at the app root; `openContextMenu(x, y, items)` is a singleton trigger fired by an `aura:context-menu-open` event so any tree depth can open menus without prop-threading
- [x] Viewport-edge clamping; closes on outside click, Escape, or item activation
- [x] **Stream items**: Copy Stream Link, Copy Video URL, Copy Magnet Link (when applicable), Play Externally (via `tauri-plugin-opener`)
- [x] **Catalog cards**: Open in IMDB / TMDB / Kitsu (id-prefix routing), Add to Library / Remove from Library
- [x] **Addon rows**: Configure addon, Open manifest URL, Copy manifest URL, Remove

### 5.5.4 Global Image Pipeline
- [x] `<ImageLoader />` — shimmer skeleton until `onLoad`, then `opacity 0 → 1` over 300 ms; preserves the wrapper's box geometry so DOM stops shifting while images stream in
- [x] Adopted across `CatalogCard`, `ContinueWatchingCard`, `PosterCard`, `HeroBackdrop` (with `naturalWidth` measurement for the low-res detection callback), Hero portrait overlay, Calendar row poster, Search suggestion thumbs

### 5.5.5 Deep Search & Sidebar Polish
- [x] **Backdrop overlay** — `bg-black/70 backdrop-blur-md` dims the app behind the focused search input; click-out dismisses
- [x] **Live suggestions dropdown** — top 8 hits from `global_search` (200 ms debounce) with poster thumbs; clicking opens the DetailView
- [x] **Recent searches** — persisted to `localStorage["aura:recent-searches"]` (cap 8); per-row remove + Clear All
- [x] **Aura progress bar** — indeterminate spectral gradient slides under the input while a query is in flight (`.aura-progress-track` + `.aura-progress-bar`)
- [x] **Sidebar grouping** — `flex-grow` spacer pushes Addons + Settings to the bottom of the panel (Home / Library / Calendar at top)
- [x] **`.nav-tap` micro-interaction** — `scale: 1.05` on hover, `scale: 0.95` on click for every sidebar button + the profile pill; transform-only, GPU-composited
- [x] **Catalog row titles** — `aura-row-title` glass-textured spectral gradient at `text-2xl` (matches the title-bar wordmark fill)

### 5.5.6 Addon Tags & Subtitle Integration
- [x] `AddonEntry` extended with `types: Vec<String>` and `resources: Vec<String>` (default-empty for forward-compat); populated by `add_addon`, `cloud_add_addon`, and `get_synced_addons`
- [x] AddonsView renders distinct-colored `<TagPill />` per type / resource (Movies = blue, Series = purple, Anime = pink, Channels = amber, Streams = emerald, Subtitles = yellow, Meta = cyan, Catalog = sky)
- [x] **`fetch_external_subtitles`** — new Tauri command; fans out across every `subtitles`-resource addon via `JoinSet`, returns deduped `[{url, lang, addon_name, label}]`
- [x] **Auto-injection** — after `load_video` succeeds, `App.handlePlayStream` fetches external subtitles and pipes each URL into `add_subtitle_to_mpv` (MPV's `sub-add` accepts URLs directly)

### 5.5.7 Library & Calendar
- [x] **LibraryView** — full grid of saved Stremio items with sorting (Recently Added, Recently Watched, A→Z, Z→A) and filter pills (All / Movies / Series / Anime, with counts); right-click menus inherit from the catalog card pipeline
- [x] **`libraryToggle()` helper** — builds the Stremio `libraryItem` change record (`_id`, `_ctime`, `_mtime`, `removed`, …), POSTs through `library_put`, and dispatches `aura:library-changed` so the App re-fetches and dependent views (Continue Watching, Calendar) refresh
- [x] **CalendarView** — entries are now clickable; `onSelectMeta` opens DetailView for a release; header uses the gradient row title

---

## Phase 5.6: Critical Fixes, Episodic Routing, MPV State & DevTools — ✅ Complete

### 5.6.1 Critical React & Playback Bug Fixes
- [x] **`<ErrorBoundary />`** — small class component that catches render errors below it and renders a glass diagnostic instead of a blank tree. Errors also push to the DevConsole via `aura:dev-log`.
- [x] **LibraryView defensive shell** — header / sort / filter pills always render; the data region picks one of `<SkeletonGrid />` (library undefined → still loading), "Sign in" card, "Library is empty" card, "No matches" card, or the actual grid. Shell wrapped in `<ErrorBoundary scope="Library">`.
- [x] **`libraryLoaded`** flag in App.tsx — drives the skeleton state precisely so we don't flash an empty-state card during the initial `library_get`.
- [x] **MPV transparent passthrough** — `<html data-playing="true">` toggles via React effect on `duration > 0`. New `.aura-app-shell` class + CSS rules force `body` / `#root` / wrapper backgrounds to `transparent !important` during playback (including a midnight-theme override). UI overlays (sidebar, title bar, control bar) keep their own glass surfaces so they remain legible on top of MPV.
- [x] **Verbatim id passthrough** — `fetch_streams` and `extract_videos` cap IDs at 256 chars but never strip colons, slashes, or other addon-specific tokens. Episode IDs like `kitsu:12345:1` and `tt0903747:1:5` round-trip cleanly to the addon URL.

### 5.6.2 Detail View Tech-Noir Overhaul
- [x] **Full-bleed background** — `<ImageLoader>` at `absolute inset-0`, `object-fit: cover`, `objectPosition: center top`. NO scaling, NO blur on the raw frame. Three layered gradients (radial vignette + right-edge fade + bottom-up fade) carry all legibility weight.
- [x] **35 / 65 horizontal split** — left column (logo, dense mono meta strip, `max-w-prose` synopsis, hairline accent rule, genre pills); right column (frosted glass interactive panes).
- [x] **Frosted glass panes** — `bg-black/60 backdrop-blur-xl border border-white/10` rounded-lg containers with a `1×3 px` accent rule + `font-mono tracking-[0.22em] uppercase` headings.

### 5.6.3 Series & Anime Episodic Routing
- [x] **Backend** — `MetaDetail.videos: Vec<VideoEntry>` with `id`, `title`, `season`, `episode`, `released`, `thumbnail`, `overview`. `extract_videos()` parses up to 2000 entries; IDs preserved verbatim (no slugification).
- [x] **Frontend** — `EpisodePane` shows a season `<select>` (defaults to the smallest season > 0; "Specials" labelled when season 0 exists) and a vertically-scrollable list of `<ImageLoader>` thumbnail rows with S/E codes, air dates, titles, and episode overviews.
- [x] **Stream gating** — for `series` / `anime`, the `StreamPane` is HIDDEN until an episode is explicitly clicked. Clicking sets `activeVideo`, which triggers `fetch_streams({ id: video.id, … })`. Movies skip the picker — streams fetch immediately.
- [x] **Active target carries `episode`** — App.tsx threads `target.episode` (e.g. `S01E05`) into `setActiveTarget` so scrobbling, RPC, and SMTC reflect the right entry.

### 5.6.4 DevConsole (F12)
- [x] **Rust devlog** — new `devlog.rs` module + `devlog!()` macro. Captures the `AppHandle` once during `setup`; every call mirrors to stderr AND emits a `dev-log` Tauri event with `{level, source, message, ts}`.
- [x] **Lifecycle logging** — `setup begin`, MPV pre-flight failures, MPV ready, streaming bridge spawn, every `load_video` invocation.
- [x] **`<DevConsole />`** mounted at App root, `z-[9999]`. F12 toggle. Terminal-style monospace UI, level-color chips, ring buffer of 1000 entries, level filter pills (TRACE / DEBUG / INFO / WARN / ERROR), search filter, pause / clear, auto-scroll-to-tail.
- [x] **Console hooks** — overrides `console.log/info/warn/error/debug` in React to push entries alongside Rust logs (uniquely tagged `react:` / `rust:<source>`).
- [x] **ErrorBoundary integration** — uncaught render errors fire `aura:dev-log` with stack + componentStack so the console shows them without the user opening the OS inspector.

### 5.6.5 Stream Details (No Truncation) & Library Writeback
- [x] **`streamMeta.parseStream()`** — regex-driven parser pulls Resolution / Codec / HDR / Audio / Size / Seeders / Language / Release Group out of multi-line addon titles. Cap raised to 1024 chars (title + description) so addon-supplied detail isn't lost.
- [x] **Chips, no ellipses** — every stream row renders the parsed values as colour-coded `font-mono` chips (palette aligned with the AddonsView tag pills); the original primary line wraps freely (`break-words`); any extra lines from the addon render below in muted mono.
- [x] **Compact, pinned column** — the streams pane uses `max-w-lg ml-auto` so it stays right-anchored and never stretches across an ultrawide viewport. Internal `overflow-y-auto` keeps the list scrollable while the page itself is fixed.
- [x] **`libraryWriteProgress()`** — extends the Stremio `libraryItem` change record with `state.timeOffset` and `state.duration`. Auto-tracked items get `temp: true`; existing items preserve their `_ctime` and unknown `state` keys.
- [x] **Writeback triggers** — App.tsx flushes (debounced 800 ms) when `paused` flips to true, on every `activeTarget` change (cleanup writes the prior target's progress), and on `beforeunload`. A `lastWrittenTime` guard suppresses duplicate writes.

---

## Phase 5.7: Playback Resolution, Layout Re-Architecture & UX Fidelity — ✅ Complete

### 5.7.1 MPV Transparency & Proxy Bypass
- [x] **`<html>/<body>/#root` `.playing-video` class** — toggled by React effect on `duration > 0`. CSS forces all three transparent under that class (with a midnight-theme override) so the native MPV layer is visible behind the webview.
- [x] **HTTPS direct passthrough** — `resolve_stream` now bypasses the local axum proxy for `https://` URLs. MPV speaks HTTPS natively (byte-range supported), and the bridge would only break VPS hosts whose TLS cert is signed for the direct domain (e.g. `stremthru.animasec.dev`). Plaintext `http://` still routes through the bridge for header-injection / byte-range fixups; magnet still routes to the bridge magnet endpoint.

### 5.7.2 Detail View Re-Architecture (Tech-Noir Command Center)
- [x] **All metadata moved LEFT** — logo, dense mono meta strip (Year / Runtime / 3 Ratings / Anime badge), accent rule, synopsis (`max-w-prose`), genre chips, AND every credit row (Director / Writers / Cast / Country) now live on the left.
- [x] **+30% typography on the left** — logo `max-h-44`, fallback title `text-[64px] font-light`, meta `text-[14px]`, synopsis `text-[18px]` regular weight, genre chips `text-[12px]`, credit lines `text-[14.5px]`. The page reads like a Command Center brief.
- [x] **Compact RIGHT column** — `max-w-md` fixed-width single panel pinned to the right. Frosted glass shell (`bg-black/65 backdrop-blur-2xl border border-white/12`).
- [x] **Unified Episodes ↔ Streams panel** — single panel that swaps mode in place. Movies start in Streams; series/anime start in Episodes; clicking an episode flips to Streams with a `← Episodes` back button in the header. Episode rows + season dropdown + stream chips all sized ~30% larger than 5.6.

### 5.7.3 Home Page & Catalog Logic
- [x] **10-column CSS Grid** — `grid-template-columns: repeat(10, minmax(0, 1fr))`. Exactly 10 cells per row at any viewport width (1080p → 3440×1440p). The horizontal-scroll/arrow code is gone for Discovery rows; cards stretch to fill columns.
- [x] **Slice + View All** — Home displays `9 catalog items + 1 "View All" cell` per row. The View All card is accent-coloured and routes to a dedicated `<CatalogPageView />` that fetches the FULL 100-item catalog and renders an `auto-fill minmax(180px, 1fr)` grid. `<App>` tracks `activeCatalog` state; sidebar nav clears it.
- [x] **Native order, no addon prefix** — rows render in strict manifest order (`is_search_only` excluded, primary-first). The previous "ADDON NAME" prefix labels on multi-source setups are removed; catalog name + type suffix is enough.
- [x] **Hero text-shadow** — `<HeroCarousel />` no longer wraps title/synopsis in a glass card. Title uses `text-shadow: 0 2px 14px rgba(0,0,0,0.95), 0 0 28px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.8)`; logo uses `drop-shadow`. Cleaner over the backdrop.
- [x] **Continue Watching: 16:9 only** — strictly uses `item.background`. Items without one are filtered out instead of falling back to a portrait poster — keeps the row visually consistent.

### 5.7.4 Sidebar Evo & Profile Dropdown
- [x] **Beefier weight** — sidebar widened to `224 px`, padding bumped to `px-3 py-4`, item rows to `px-3.5 py-3`, label text to `text-[14px]`, profile avatar to `36×36`. Icons jumped from `20×20` to `22×22`.
- [x] **Springy `.aura-glow`** — active-item pill now transitions `top` / `height` with `cubic-bezier(0.34, 1.56, 0.64, 1)` (overshoot-on-arrive) over `400 ms`, plus a slow 14 s `aura-glow-pulse` that drifts the gradient so the pill never feels static.
- [x] **Profile popover** — clicking the profile pill opens an `absolute left-full ml-3 w-[300px]` glass popover anchored to the right of the sidebar. Shows avatar + nickname/email, sync status pill (green dot for "Synced", neutral for "Local only"), and action buttons: **Account settings** (jumps to Settings), **Log out** (signed-in) or **Sign in to Stremio** (guest). Closes on outside click / Esc.
- [x] **Auth-state reactivity** — the popover is fully driven by props (`userEmail`, `userNickname`); App.tsx now wires `onLoginRequest` and `onLogout` directly so the avatar reflects sign-in immediately without round-tripping through `setActiveView`.

### 5.7.5 Global UX & Native Context
- [x] **Anti-highlight** — `body { user-select: none }` everywhere; opt-in `user-select: text` for `input` / `textarea` / `select` / `[contenteditable]`, the new `.selectable` class (used by synopsis, credits, stream rows), and the entire DevConsole.
- [x] **Native context-menu suppression** — `main.tsx` installs a capture-phase `contextmenu` listener BEFORE React mounts and unconditionally `preventDefault()`s. Any element that wants its own menu still works (the custom `openContextMenu()` is independent), but the native browser menu is 100% gone.

---

## Phase 5.8: Critical MPV Rendering, Ambient Aura & Search Overhaul — ✅ Complete

### 5.8.1 MPV Black Screen & Z-Index Isolation (Priority Zero)
- [x] **MPV hwdec=auto** — switched from `auto-safe` per spec. Added `alpha=yes` and `force-window=no` so the embedded GL context truly stays transparent outside the active video and doesn't fight the webview's transparency.
- [x] **`<PlayerOverlay />`** — dedicated `fixed inset-0 z-[9999]` container that mounts ONLY when `duration > 0`. Background is *strictly* `transparent`; that is what reveals the native MPV window behind the webview. The control bar, subtitle picker, ShaderPicker, CinemaSuite OSD, and exit button all live inside it.
- [x] **`stop_video` Tauri command + `handleExitPlayback`** — `mpv.command("stop", …)` cleans up the file. `handleExitPlayback` flushes library progress first, then stops MPV, then clears `activeTarget`. Bound to a glass "Exit playback" pill anchored top-left of the overlay.
- [x] **App body hidden during playback** — App.tsx wraps the whole sidebar + view + nav block in a div that gets `className="… hidden"` when `duration > 0`. DetailView is also strictly unmounted (`selectedMeta && duration <= 0`). Result: no opaque webview content paints over MPV; React stops layouting the body entirely.

### 5.8.2 Global Ambient Aura & Animation Fixes
- [x] **`<AmbientAura />`** — single `position: fixed; inset: 0; z-index: -50; pointer-events: none` element mounted at the app root. Renders the same mirrored A→B→C→B→A spectral gradient as the title bar, but with `background-size: 200% 100%`, `background-position: 100% 50% → 0% 50%` over **36 s**, and only 6–10 % stop opacities so the deep blacks of the glass panes stay deep.
- [x] **No-snap loop** — both the title-bar `.aura-sweep` and the new `.aura-ambient` use the corrected mirrored gradient (stops at 0 % and 100 % carry identical colours), so the keyframe wrap is a visual no-op. The previous title-bar snap is fixed.
- [x] **Sidebar pill — pure GPU `translateY`** — the `useLayoutEffect` DOM measurement code is gone. `<NavGroup>` renders a single absolute pill at `top: 0; height: 48px; transform: translateY(idx * 52px)` with a springy `cubic-bezier(0.34, 1.56, 0.64, 1)` 380 ms transition. No reflow, no stutter. Two groups (top + bottom) each own their own pill so the indicator never has to leap across the flex-grow spacer.
- [x] **Profile button redesigned** — chevron-tail with a status indicator dot (green/glowing for signed-in, neutral for guest) bolted onto the avatar. Pressing it opens the existing `<ProfilePopover />` to the right of the sidebar with auth-state-aware account/sync/logout actions.
- [x] **Profile popover anchoring** — closes on outside click via `[data-profile-popover]` / `[data-profile-trigger]` data attributes (cleaner than node-contains tree-walking) and reliably reflects auth state because everything is driven from props.

### 5.8.3 DnD Eradication & Search Catalogs
- [x] **`@dnd-kit/sortable`** — added `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`. The HTML5 DnD code in Settings → Additional Home Sources is gone. New `<SortableAddonRow>` uses `useSortable` with a `PointerSensor` (6 px activation distance — clicks on Remove no longer accidentally start a drag) and a `KeyboardSensor` for accessibility.
- [x] **`global_search_grouped` Tauri command** — fans out across every search-enabled addon, then iterates each addon's catalogs in manifest order, returning `Vec<SearchGroup { addon_name, addon_url, catalog_id, catalog_name, media_type, items }>`. Spawn-order preservation guarantees groups are returned in installed-addon order.
- [x] **`<SearchView />`** — the new search results UI. Renders one `<DiscoveryRow>` per (addon, catalog) — same 10-column CSS Grid as Home, same Stremio-style "Trending Movies / Action Series / Anime …" feel.
- [x] **SearchBar Enter behaviour** — Enter now COMMITS the query: closes the dropdown, unmounts suggestions, calls `onSubmit(query)`. The auto-debounced "live" main-view search is removed; Home only switches to `<SearchView />` once the user explicitly hits Enter (or picks a recent search). Clearing the input fires `onClear()` which exits search view.

### 5.8.4 AIOMetadata Logging Labels
- [x] **`log_label(name, url)`** — picks `"AIOMetadata"` for any addon whose name or URL matches `aio[\s-]?metadata`; otherwise uses the display name; falls back to the URL. Used as the prefix on every addon-related devlog line so the DevConsole filter input can isolate one addon's traffic instantly.
- [x] **Per-endpoint instrumentation** — `[label]` prefix added to:
  - `get_addon_manifest` — catalog count + has_search
  - `fetch_catalog` — `GET <url>`, HTTP status / parse failure, `<type>/<id> → N item(s)`
  - `fetch_meta_detail` — `GET <url>`, plus a structured "mapped" line that surfaces what came back (`name`, `type`, `poster=`, `bg=`, `logo=`, `videos=`, `cast=`, `ratings=`)
  - `fetch_streams` — manifest probe, declared types vs request type, request URL, HTTP / parse errors, raw vs kept stream counts
  - `fetch_external_subtitles` — request URL, HTTP / parse errors, kept count
  - `global_search_grouped` — per-addon, per-catalog request URLs and item counts

---

## Phase 6: Production Polish — ✅ Shipped (rolling)

A grab-bag of post-5.8 work that isn't gated to a single rendering / IPC milestone.
Add new entries here as features land; promote into a numbered phase when a
cohesive arc emerges.

### 6.0.x Detail page, ratings & filtering
- [x] **OMDb integration** — `fetch_omdb_ratings` (Rotten Tomatoes Tomatometer + Metacritic Metascore + IMDb backfill) deduped against addon-supplied ratings; merged in `mergedRatings`. Persistent 7-day cache (`aura:omdb-cache:v1`) skips the round-trip on re-opens
- [x] **OMDb key as a user-supplied setting** — `AppSettings::omdb_api_key` (no shipped default; users register a free 1,000-req/day key at omdbapi.com, paste into Settings → API Keys). Without a key OMDb is silently disabled; addon-supplied ratings + the MAL aggregator still render. Round-tripped via the export blob
- [x] **AIOStreams notice icons** — `partition_aio_pseudo_streams` separates `type === "statistic" | "error"` pseudo-streams into `errors / warnings / info / stats` buckets; `<StreamMetaBadges />` floats the icons in the gutter outside the streams panel via portal-rendered fixed positioning, popover anchors LEFT with viewport collision flip + mousewheel-priority scroll
- [x] **Anti-spoiler toggles** — Hide cast episode counts, Show AIOStreams notices, Blur unwatched thumbnails

### 6.0.5 Robustness & MPV stability
- [x] **MPV property landmines documented** — see `CLAUDE.md` for the full list; `mpv.set_property("name", &v)` (NOT `mpv.command("set_property", [...])`) is canonical, observed-property set is trimmed to `pause / time-pos / duration / volume / speed`, polling-only beyond
- [x] **Win32 fullscreen path** — `win32::enter_native_fullscreen` resizes the parent window to `rcMonitor` with `WS_POPUP` + `HWND_TOPMOST` + `SWP_FRAMECHANGED` (Tauri's setFullscreen lands at the work-area rect with the taskbar showing through)
- [x] **MPV log rotation** — `aura-mpv.log` rotates to `.old` at 50 MB so a previous run's final lines aren't truncated by the next launch
- [x] **Rust panic hook** — captures every panic to `%USERPROFILE%\aura-panic.log` with thread, location, message, and forced backtrace
- [x] **JS error capture** — `error` and `unhandledrejection` handlers installed in `main.tsx` BEFORE React mounts; forwards to DevConsole and dispatches `aura:fatal-error` for future Sentry / crash-receiver integration
- [x] **Library normalization at the loadLibrary boundary** — `libraryNormalize.ts` collapses per-episode entries into series-rooted records (`state.video_id` carries the episode); single fix-up shared by Library, Calendar, Continue Watching

### 6.0.x Theme expansion
- [x] **Six new themes** beyond the original Mica/Glass/Midnight: **Ember** (warm amber), **Forest** (emerald slate), **Rose** (plum-grey), **Amethyst** (violet indigo), **Ocean** (teal midnight), **Solar** (sunburst dark). Theme dropdown in Settings now enumerates `THEME_LABELS` so all 9 themes are pickable

### 6.0.x Settings UX
- [x] **Settings search** — pill-style input top-right of the Settings page; forgiving subsequence-fuzzy filter (`fuzzySubseq`) — type "subfsz" → "Subtitle Font Size" matches without verbatim. Cmd/Ctrl-K focuses; Esc clears. Match-count pill + animated section enter
- [x] **Storage management UI** — Settings → Storage panel inspects + clears disk files (`aura-mpv.log`, `aura-panic.log`, rotations) and localStorage caches with destructive-vs-safe warnings. Backed by `get_storage_report` / `clear_storage_item` Tauri commands
- [x] **Backup & Restore** — JSON / base64 export of portable backend + aura-side settings (theme, audio/sub priorities, keybindings, RPC config, skip modes, OMDb key, etc.); whitelist-filtered import drops anything outside `PORTABLE_BACKEND_FIELDS` so a malicious blob can't smuggle in addon URL overrides

### 6.0.x Performance & caching
- [x] **Persistent meta cache** — `metaCache.ts` hydrates from `aura:meta-cache:v1` on import, debounces writes (500 ms), evicts oldest 25 % at 1500 entries. Survives app restarts so re-opening Aura doesn't replay yesterday's MetaDetail round-trips
- [x] **Persistent OMDb cache** — 7-day TTL via `PersistentCache<OmdbRating[]>` keyed by IMDb id
- [x] **Persistent AniSkip cache** — 30-day TTL via `PersistentCache<AniSkipResult>` keyed by `mal:ep:treatMixed`. Skip windows for an aired episode are effectively immutable
- [x] **`<PersistentCache />`** generic helper — unifies hydrate / debounced-persist / TTL-eviction / soft-size-cap so future caches plug in with one constructor call
- [x] **Hero metadata fetch dedupe** — routes through `metaCache.getMetaDetail` (24 h module cache + `dedupedInvoke`); fixed an 8× duplicate-fire bug where `heroLogoCache` in the effect deps re-ran the effect for every cache update
- [x] **Hero logo cache survives HomeView remounts** — `HERO_LOGO_MEMO` module-level Map seeds the React-state mirror so navigating Library → Home renders logos on first paint instead of flashing the bare h2
- [x] **`loadAuraSettings()` memoization** — module-level snapshot busted on save / `aura:settings-changed` / cross-tab `storage` events; collapses 6+ DetailView reads-per-render to a single object pointer
- [x] **Episode sort consolidation** — `episodeSort.ts::getSortedEpisodes(detail)` memoized via WeakMap; replaces three duplicated inline `[...detail.videos].sort()` callsites in autoAdvance, nextUp, and DetailView
- [x] **Library partition single-pass** — LibraryView now classifies items into bucket arrays + counts in one iteration (was 7 passes); critical for 1000+ item libraries
- [x] **`useManualWatchedVersion` hook** — useSyncExternalStore-based subscription replaces the SegmentedSeasonBar `useState+useEffect+tick` pattern. Cleaner subscribe/unsubscribe lifecycle for the dozens of CW-row instances
- [x] **`will-change` pruned** — removed permanent `will-change: transform` from `.card-grow` (every catalog card) and `.nav-tap` (every nav button). Kept on legitimately-animating elements (sweep, pulse, bell, popup)
- [x] **Library scroll perf** — `content-visibility: auto` with `contain-intrinsic-size`, removed per-card hover scale transitions, scroll-debounced suppress-transitions class
- [x] **Vite production build** — `target: "esnext"`, `sourcemap: false`, manual React vendor chunk, esbuild `drop: ["debugger"]`. Bundle-analyzer script (`pnpm build:analyze`) reports per-file sizes against a 600 KB threshold

### 6.0.x UX polish
- [x] **Subtitle dynamic lift** — `set_subtitle_position_runtime` IPC nudges `sub-pos` up by 12 percentage points when the player control bar is visible; restores the user's persisted baseline when the bar hides. `aura:settings-changed` keeps the effect in sync if the user moves the slider mid-playback via SubtitleStyleMenu
- [x] **Tooltip portal + viewport-edge collision** — `<Tooltip />` rebuilt to portal-render into `document.body` with `position: fixed` + `getBoundingClientRect`-driven placement that flips to the opposite side when the preferred edge would clip. Replaces the CSS-only `right-full mr-2` positioning that silently clipped at viewport / overflow boundaries
- [x] **Theme cross-fade** — switching themes cross-fades the entire UI in 280 ms

### 6.0.x — Open
- [~] **Magnet streaming** — **WON'T IMPLEMENT.** Out of scope for an addon-only player paired with Debrid services; see 2.4 above.
- [ ] **SMTC Next / Previous → queue advance** — media-key events arrive but aren't routed; needs decision on queue semantics first (next planned vs next episode in current series)
- [ ] **Update payload signing** — `pubkey` in `tauri.conf.json` is still the placeholder; blocked on Authenticode code signing (per `PRODUCTION.md`, user opted out of EV/OV cert acquisition for now)
- [x] **Crash reporting receiver** — Sentry SDK wired in (Rust panic hook + JS error capture), gated on a first-run consent dialog (`CrashReportingConsent.tsx`). User pastes their own DSN in Settings → Integrations → Crash Reporting (or builds with `SENTRY_DSN` / `VITE_SENTRY_DSN` baked in). Defaults to off until consent is given.
- [ ] **Settings encryption / OS keyring migration** — Stremio auth tokens + OMDb key currently live in plaintext `settings.json`; threat model is "single-user desktop, OS-level filesystem trust" so non-blocking, but the migration is the right move for shared-PC scenarios

### 6.0.x Networking, security & resilience (post-handoff)
- [x] **CDN preheat** — `App.handlePlayStream` fires a small `Range: bytes=0-65535` GET against the resolved URL right before `load_video`. Warms TLS / connection pool, cuts 100–500 ms from cold-start latency on debrid CDNs
- [x] **libavformat reconnect resilience** — `demuxer-lavf-o` now sets `reconnect=1`, `reconnect_streamed=1`, `reconnect_on_network_error=1`, `reconnect_delay_max=4`. Addresses "long-anime EOF on idle keep-alive drop" without a parallel-range cache rewrite
- [x] **TCP keep-alive on reqwest pools** — `tcp_nodelay(true)` + `tcp_keepalive(60s)` on aniskip / auth / omdb / ratings / scrobble / stremio / subtitles clients. Survives firewall idle-timeouts; first-request latency drops from full handshake (~200 ms) to single round-trip on warm pools
- [x] **HTTPS enforcement on all reqwest pools** — every long-lived client builds with `https_only(true)`; misconfigured `http://` URLs surface as a connection error rather than leaking the user/title/progress payload over plaintext
- [x] **Sanitized scrobble error logs** — error category only (timeout / connect / status / send), never the full reqwest error string (which can include the request URL with embedded auth)
- [x] **Addon URL hardening** — `validate_url` now also rejects empty / >2048-char inputs, embedded credentials (`user:pass@`), and path traversal (`/../`). Loopback intentionally allowed for self-hosted AIOMetadata / AIOStreams
- [x] **Power-user network tuning notes** — `HANDOFF.md §9` documents Windows `netsh int tcp` autotuning + BBR2 + RSS, Linux sysctl bbr + rmem/wmem, and router-side SQM/cake recommendations for high-BDP debrid links

---

## Technical Constraints

| Constraint | Detail |
|------------|--------|
| HTTP client | `reqwest 0.12` with `rustls-tls`. Auth & account clients enforce `https_only(true)`. |
| Session storage | Platform-native keyring (`keyring 3`). No plaintext credential files. |
| Credential safety | Passwords wrapped in `Zeroizing<String>`; zeroed on drop. |
| Video output | MPV via `tauri-plugin-libmpv`, `gpu-next` renderer, `hwdec=auto-safe`. |
| Streaming bridge | axum 0.7 on port 11471; byte-range proxy for HTTP streams. |
| Permissions | Tauri capability system — all IPC commands declared in `permissions/player.toml`. |
| File I/O | Scoped to `app_data_dir()` — no arbitrary filesystem access. |
| Search safety | All poster URLs validated; text fields capped before returning to frontend. |
