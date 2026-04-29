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
- [ ] `/magnet/*` torrent streaming — stub returns 501; requires torrent engine integration
  - Candidate: `librqbit` crate (see `streaming.rs` TODO comment)

### 2.5 OS Deep Linking — 🟡 Partial
- [x] `tauri-plugin-deep-link` registered; `aura://` and `stremio://` protocol schemes configured
- [x] Incoming URL forwarded to frontend as `deep-link` Tauri event
- [ ] Frontend route handler for `aura://search?q=...` and `stremio://detail/...`
- [ ] Auto-updater (`tauri-plugin-updater`) — requires GitHub release endpoint setup

### 2.6 Cinema Suite & Performance Overlay — ✅ Complete
- [x] 6-profile GLSL shader system (FSRCNNX, RAVU, Anime4K, Sinc-Lanczos built-in, Bilateral, FSR)
- [x] Shader picker UI (`CinemaSuite.tsx`) — glass modal with profile list
- [x] Backtick (`` ` ``) key toggles Performance OSD
- [x] OSD shows: Active Profile, Resolution, Display FPS, Frame Drops (live from MPV events)
- [x] `vo=gpu-next`, `target-colorspace-hint=yes`, `hdr-compute-peak=yes`, `tone-mapping=auto`
- [x] Dolby Atmos / DTS-X audio passthrough (`audio-spdif`, `audio-exclusive=yes`)
- [x] Subtitle defaults (pos 95, size 45, border 3, shadow 2)
- [ ] Shader files: place in `src-tauri/shaders/` (see `shaders/README.txt` for download links)

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

### 3.5 Detail View & Playback Pipeline (Next)
- [ ] Meta detail view — streams list from multiple addons, poster/backdrop art
- [ ] `load_stream` pipeline — calls `resolve_stream`, then `apply_lang_defaults(is_anime)`, then `load_video`
- [ ] Set `activeTarget` (scrobble + RPC) at the moment a meta starts playing
- [ ] Playback history & resume position (writes back via `library_put`)
- [ ] Subtitle track selection UI
- [ ] Audio track selection UI
- [ ] Playlist / queue support

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
