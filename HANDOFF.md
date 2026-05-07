# Aura — Project Handoff & State Overview

> Snapshot date: 2026-04-30. Use this document to brief a fresh session
> (e.g. Sonnet 4.6) on what's built, what's broken, and what the master
> plan still has open.

---

## 1. What Aura is

A native Windows / Mac / Linux desktop media player built on **Tauri 2 +
React 19 + libmpv** that consumes the **Stremio addon ecosystem**.
Architecturally it's:

- **Rust backend** (`src-tauri/`) — Tauri host, libmpv embedding via
  `tauri-plugin-libmpv`, axum streaming bridge on port 11471, Stremio
  account API, addon fan-out, OS integrations (SMTC, Discord RPC,
  keyring-encrypted credentials).
- **React frontend** (`src/`) — view router, custom title bar, NavSidebar,
  cinematic Detail page, full-screen player overlay, DevConsole.
- **Embedding model** — MPV is rendered via `--wid=<HWND>` so it sits as
  a sibling child of the WebView2 surface. The webview must be
  transparent for the OS compositor to show the MPV layer behind it.

Tech constraints worth knowing:

| Constraint | Detail |
|------------|--------|
| HTTP client | `reqwest 0.12` + `rustls-tls`; auth/account clients enforce `https_only(true)`. |
| Session storage | Platform-native keyring (`keyring 3`). No plaintext credential files. |
| Credential safety | Passwords wrapped in `Zeroizing<String>`. |
| Video output | MPV `vo=gpu-next`, `hwdec=auto`, `volume=50` initial. |
| Streaming bridge | axum 0.7 on `127.0.0.1:11471`; `/proxy/*url` forwards byte-range. HTTPS streams BYPASS the bridge (direct to MPV). Magnet streams hit `/magnet/*` which currently 501s. |
| Permissions | Tauri capability system; every Rust command declared in `src-tauri/permissions/player.toml` and listed in `src-tauri/capabilities/default.json`. |
| File I/O | Scoped to `app_data_dir()`. |
| Search safety | All poster URLs validated; text fields capped before returning to frontend. |

---

## 2. Codebase map

### Rust modules (`src-tauri/src/*.rs`)

| Module | Role |
|--------|------|
| `lib.rs` | Tauri builder + setup; declares MPV-control commands (`load_video`, `stop_video`, `toggle_pause`, `seek_relative`, `seek_absolute`, `set_volume`, `set_speed`, `set_audio_track`, `set_subtitle_track`, `set_subtitle_visibility`, `get_tracks`, `get_property`, `refresh_video`, `apply_lang_defaults`); `mpv-event-main` observer that maintains `PlaybackState` + `OsdState` and emits `playback-update` / `osd-update`. |
| `player.rs` | DLL pre-flight checks (`libmpv-wrapper.dll`, `libmpv-2.dll`); `init_mpv` config (vo, hwdec, HDR, sub defaults, `volume=50`, observed properties). |
| `addons.rs` | Local `addons.json` persistence (guest mode); file-locked read/modify/write; `AddonEntry { url, name, has_search, types, resources }`. |
| `auth.rs` | Stremio login/logout/get_session, `get_synced_addons`; uses keyring + a debug-only fallback file at `app_data_dir/dev-session.json`. |
| `stremio.rs` | Catalog fetching (`fetch_catalog`, `get_addon_manifest`, `fetch_meta_detail`), search (`global_search`, `global_search_grouped`), library (`library_get`, `library_put`), stream aggregation (`fetch_streams`), external subs (`fetch_external_subtitles`). All addon URLs go through `normalise_addon_base()` to strip `/manifest.json` + trailing slash. AIOMetadata addon detection drives the `[AIOMetadata]` log label. |
| `streaming.rs` | axum bridge on `:11471`. `resolve_stream` routes: `magnet:` → bridge magnet endpoint (501 stub), `http://` → bridge proxy, `https://` → DIRECT (bypasses bridge), other → passthrough. |
| `cinema.rs` | 6 GLSL shader profiles. `set_shader_profile` uses `change-list glsl-shaders set "<path>"` (the `set_property` path was rejected by libmpv as "invalid parameter"). Strips `\\?\` UNC prefix from paths and converts `\` → `/` for libmpv's option-list parser. |
| `subtitles.rs` | OpenSubtitles REST v1 client (`search_subtitles`, `download_subtitle`); also `add_subtitle_to_mpv(path, flag?)` taking optional `select` / `auto` / `cached` flag. |
| `scrobble.rs` | AIOMetadata-style scrobble Start/Heartbeat/End POSTed to the configured addon URL. |
| `media_controls.rs` | Windows SMTC integration via `souvlaki 0.7`. Media-key events re-emitted as `smtc-event`. |
| `window_logic.rs` | Window-event handler (`pause_on_minimize` / `pause_on_lost_focus` / `close_on_exit`); `shutdown_mpv_sync()` runs **synchronously** on close to release WASAPI before exit. Discord RPC client + privacy-aware presence. |
| `settings.rs` | `AppSettings` persisted to `app_data_dir/settings.json` with in-memory cache. Fields: `theme`, language defaults (global+anime audio/subs), Discord RPC + privacy, window behaviours, `scrobble_addon_url`, `opensubtitles_api_key` (legacy), `omdb_api_key`, `keybindings`. |
| `omdb.rs` | OMDb (omdbapi.com) bridge; `fetch_omdb_ratings(imdb_id)` returns Rotten Tomatoes Tomatometer + Metacritic Metascore + IMDb. |
| `devlog.rs` | App-wide `devlog!()` macro that mirrors to stderr AND emits a `dev-log` Tauri event for the React DevConsole. |
| `win32.rs` (Windows-only) | Force-resize the embedded MPV child HWND to the parent's client area via `EnumChildWindows` + `SetWindowPos`. Uses thread-local stash for the function pointer (lifetime-encoded version was unsound). |

### Frontend layout (`src/`)

| File | Role |
|------|------|
| `App.tsx` (893 LOC) | Top-level router. Owns `usePlayback`, auth state, library, addons, active stream, fullscreen state. Wires DetailView, PlayerOverlay, ContextMenuHost, DevConsole, AmbientAura. Listens for `aura:card-context` events to build per-card right-click menus. |
| `PlayerOverlay.tsx` (1467 LOC) | Full-screen z-9999 player UI. Owns: scrubber (animated spectral fill), control bar (rewind / play-pause / forward), volume popover, speed menu, audio + subtitle track menus (with embedded-vs-external merge + preferred-language sort), shader picker, "more" gear menu (copy/download/external/restart), fullscreen toggle, exit-playback button, buffering overlay, transient toast. Polls `get_tracks` + `sub-visibility` every 500 ms ONLY after `duration > 0`. |
| `views/DetailView.tsx` (947 LOC) | The cinematic detail page. 35/65 horizontal split: LEFT = logo + meta strip + synopsis (`max-w-prose` + outer cap) + credits + genres; RIGHT = unified Episodes ↔ Streams panel. Stream rows have right-anchored "quality column" (resolution, rip type, ★ stars, Direct/Magnet badge). OMDb ratings merged into the meta strip. |
| `NavSidebar.tsx` | Compact sidebar — AuraLogoA brand + status dot at top, separated nav groups (Home/Library/Calendar then Addons/Settings), single GPU-translateY pill per group. ProfilePopover on click. |
| `AuraLogoA.tsx` | Reusable glass "A" mark with spectral gradient clipped to glyph + animated. |
| `LandingView.tsx` | Big AuraLogoA + spectral-gradient "Welcome to Aura" + Sign-in / Guest buttons. |
| `TitleBar.tsx` | Custom 36 px frameless title bar with explicit `onPointerDown → startDragging()` (the `data-tauri-drag-region` attribute version stuck on click), centered AURA wordmark, glass min/max/close. `opaque` prop thickens the bar to `rgba(0,0,0,0.96)` during playback so MPV doesn't bleed through. Hidden in true OS fullscreen. |
| `views/HomeView.tsx` | 10-column CSS-grid Discovery rows (9 items + 1 "View All"); Hero carousel; Continue Watching (16:9 only); centered SearchBar. Submit-on-Enter switches to SearchView. |
| `views/SearchView.tsx` | Per-(addon, catalog) `<DiscoveryRow>` sections in installed-addon order. |
| `views/CatalogPageView.tsx` | Deep view for "View All" — full 100-item grid + filter bar. |
| `views/LibraryView.tsx` | Full grid with sort + filter pills; defensive shell wrapped in `<ErrorBoundary scope="Library">`. |
| `views/AddonsView.tsx` | Manage addons + auth state; coloured tag pills per addon's types/resources; right-click row context menu. |
| `views/CalendarView.tsx` | 7×6 month grid, per-day heatmap, click-to-open detail. |
| `views/SettingsView.tsx` | All app prefs. **OpenSubtitles API key removed**; **OMDb API key field auto-fills `8bc2040`** on first mount when empty. Includes drag-and-drop home-source ordering via `@dnd-kit/sortable`. |
| `CinemaRows.tsx` | DiscoveryRow + ContinueWatchingRow + CatalogCard. 10-col grid, View All cell. |
| `HeroCarousel.tsx` | 21:9 hero with bare typography + heavy `text-shadow` (no glass card), low-res-detection dual-layer fallback. |
| `SearchBar.tsx` | Centred pill + recent-searches dropdown + live suggestions, Aura progress bar while loading. Enter commits + closes; clear empties parent's active query. |
| `ContextMenu.tsx` | Singleton `<ContextMenuHost />` driven by `aura:context-menu-open` events; viewport-clamped. |
| `DevConsole.tsx` | F12 terminal-style overlay; ring buffer 1000 entries; level filters (TRACE/DEBUG/INFO/WARN/ERROR); search; pause; clear. Hooks `console.*` AND listens for `dev-log` Rust events AND `aura:dev-log` ErrorBoundary events. |
| `ImageLoader.tsx` | Shimmer skeleton until `onLoad`, then 300 ms opacity fade. Used by every poster/backdrop/thumb. |
| `AmbientAura.tsx` | App-wide spectral sweep fixed inset-0 z-[-50]. Returns null while a stream is active. |
| `streamMeta.ts` | Regex-driven parser of stream titles → `{ resolution, ripType, codec, hdr, audio, size, seeders, language, releaseGroup, qualityStars }`. |
| `aiometadata.ts` | `typeLabel`, `withTypeSuffix`, `isAnimeMeta`, `findAIOMetadataAddon`. |
| `auraSettings.ts` | localStorage prefs: `defaultHomeAddonUrl`, `defaultMetadataAddonUrl`, `additionalHomeAddonUrls`. Dispatches `aura:settings-changed`. |
| `libraryActions.ts` | `libraryToggle()` and `libraryWriteProgress()` (Stremio `libraryItem` change records). |
| `useScrobble.ts` | Active-target + playback hook → scrobble Start/Heartbeat (60 s)/End, auto-end at 90 %. `ActiveScrobbleTarget` includes `episode`, `episode_title`, `logo`. |
| `useKeybindings.ts` | Single global keydown listener using KeyboardEvent.code. Suppressed inside form controls. |
| `ErrorBoundary.tsx` | Catches render errors below it; pushes them to DevConsole via `aura:dev-log`. |
| `ThemeEngine.tsx` | Provides `data-theme` on `<html>`; round-trips through Rust settings. Three profiles: Mica / Glass / Midnight. |

---

## 3. Phases shipped (✅ complete)

These match the existing `ROADMAP.md` content:

- **Phase 1** Core Engine & Spatial Shell
- **Phase 2.1 – 2.3, 2.6** Catalog browsing, auth, search, cloud sync, Cinema Suite (shaders + OSD)
- **Phase 3** all subsections — Navigation refactor, Home overhaul + Library sync + Theme engine, Entry flow + Scrobbling + Window architecture, Optimization & UI refinement
- **Phase 4** External metadata, filtering, SMTC, keybindings, visual polish (tooltips, hero dual-layer)
- **Phase 5** AIOMetadata design language + Cinematic Detail View
- **Phase 5.5** Native interactions, fixed viewports, stabilization (right-click menus, ImageLoader, deep search overlay, addon tags + external subs, Library + Calendar wiring)
- **Phase 5.6** Critical fixes, episodic routing, MPV state, DevConsole/ErrorBoundary, library writeback
- **Phase 5.7** MPV transparency + proxy bypass, Detail View tech-noir overhaul, 10-col Home grid, Sidebar + profile popover, anti-highlight + native context-menu suppression
- **Phase 5.8** PlayerOverlay isolation, AmbientAura, dnd-kit, SearchView per-addon-catalog, AIOMetadata logging labels

## 4. Phases shipped but NOT yet in `ROADMAP.md`

The roadmap stops at **5.8**. Everything since (≈ a dozen iteration passes) lives in commit messages and these notes only. Items completed:

### Phase 5.9 – 6.0.5 (informal)

#### Player control bar + state sync
- Switched every Rust writer from `mpv.command("set_property", [name, value])` to `mpv.set_property(name, &value)` because the former silently no-ops on this libmpv build (the real cause of "volume slider snaps back to 100 %"). Affected commands: `set_volume`, `set_speed`, `set_audio_track`, `set_subtitle_track`, `apply_lang_defaults`, scale/cscale in `cinema.rs`, `refresh_video`'s `video-zoom` toggle.
- Added `set_subtitle_visibility(visible)` because some libmpv builds reject `sid="no"` after a `sub-add`. Drives the dropdown's true Off state.
- Default volume 50 % via `initial_options.volume = 50`.
- Volume mousewheel scroll, with ancestor walk to defer to scroll-capable children (track-menu lists etc.).
- Track menus: 340 px wide, no horizontal scroll, mousewheel-over-menu scrolls the menu (captured + stopPropagation), preferred-language sorting for external subs, embedded ↔ external merge with synthetic negative IDs, audio-track button always rendered (with empty-state hint).
- Toast feedback via `fireToast(msg)` event + a single subscriber in PlayerOverlay. Wired for sub change, audio change, speed change, shader change, volume scroll.

#### Window geometry
- TitleBar visible during windowed playback (with `opaque` prop thickening to 96 % black + drop-shadow); hidden only in true OS fullscreen.
- PlayerOverlay's top action bar offset 36 px down in windowed mode so it doesn't overlap the title bar.
- Win32 `resize_mpv_child_to_parent()` via dynamic user32.dll loading + thread-local stash for SetWindowPos pointer. Triggered by `refresh_video`, fired on every resize while playing + after fullscreen toggle (at +80 ms and +240 ms to cover WebView2 layout-recalc delay).

#### Stream-row redesign
- Two-column layout in StreamRow: LEFT primary release name + inline coloured-text secondary row (codec · HDR · audio · size · seeders · lang · group); RIGHT vertical "quality column" with large bold resolution, rip type (`WEB-DL`, `BluRay`, …), 5-star quality bar, Direct/Magnet badge. `streamMeta.ts` extended with `RIP_RX` and a `qualityStars` heuristic.

#### Sidebar + landing
- Compact sidebar redesign — `<AuraLogoA />` + status dot + "Aura" label as a 44 px row at top; separator; two pill tracks (top group / bottom group), each 44 px rows with 6 px gap, GPU-translateY pill that aligns precisely.
- New `AuraLogoA` component — glass-morphism A using the title-bar spectral gradient via `background-clip: text`. Sized via prop.
- Landing page Welcome treatment — big AuraLogoA + `aura-hero-title` (42 px / weight-200 / spectral gradient).

#### Description wrap
- DetailView's left content container capped at `min(720px, 100%)` so on ultrawide it wraps instead of stretching.

#### OMDb integration
- New `omdb.rs` module + `fetch_omdb_ratings(imdb_id)` Tauri command. Free tier; surfaces Rotten Tomatoes Tomatometer + Metacritic Metascore + IMDb. **Note: OMDb does NOT provide audience scores** — only critic.
- New `omdb_api_key` field in `AppSettings` (defaults empty).
- Settings UI: removed OpenSubtitles API key section, added OMDb section with autofill of `8bc2040` on first mount when empty.
- DetailView merges OMDb results with the addon-supplied `detail.ratings` and renders the top 4 (stable order: IMDb → Rotten Tomatoes → Metacritic → others).

#### Stability fixes
- Removed the `usePlayback` polling fallback that caused `STATUS_ACCESS_VIOLATION` during `load_video` (six concurrent `get_property` reads of pre-load properties raced libmpv's loadfile critical section).
- PlayerOverlay's `get_tracks` polling now gated on `duration > 0`.
- Removed `audio-exclusive=yes` and `audio-spdif=…` from MPV init — they grabbed WASAPI exclusive mode and made Stremio's bundled MPV / mpv.net unable to open the same audio device while Aura ran (or after a crash). They'll come back as Settings opt-ins.
- `shutdown_mpv_sync()` synchronously mutes → stops → destroys MPV in the `CloseRequested` path so libmpv flushes WASAPI before the process exits.
- `apply_mica` removed from the per-pause path (was making DWM backdrop fight MPV's compositor).
- Trimmed observed-properties to `pause / time-pos / duration / volume / speed` + OSD ones; the larger set with `track-list (node)`, `aid (string)`, `sid (string)`, `paused-for-cache`, `core-idle`, `eof-reached` broke the entire observation channel on this libmpv build (no events would fire at all). Track lists are now polled.
- TitleBar drag uses explicit `onPointerDown → getCurrentWindow().startDragging()` instead of `data-tauri-drag-region` (the CSS attribute version stuck on click).
- `ErrorBoundary` + LibraryView defensive shell to keep the tree visible if any render throws.

---

## 5. Open work / known issues

These are the items the user has either mentioned or that the roadmap explicitly lists as TODO.

### From the master plan

| ID | What | Status |
|----|------|--------|
| **2.4** | Magnet/torrent streaming via `librqbit` (the `/magnet/*encoded` axum route currently returns 501) | 🔴 Not started. `streaming.rs:141` has the TODO. Big lift — needs torrent engine, piece selection, byte-range serve, cache to `BridgeConfig.cache_root`. |
| **2.5** | Frontend route handler for `aura://search?q=…` and `stremio://detail/…` deep links (Rust side already emits the `deep-link` Tauri event) | 🔴 Not started. App.tsx has no listener for `deep-link`. |
| **2.5** | Auto-updater (`tauri-plugin-updater`) | 🔴 Not started. Needs GitHub release endpoint + plugin install. |
| **2.6** | Shader files placement (manual user task — drop `Anime4K.glsl` etc. into `src-tauri/shaders/`) | 🟡 User-side; once dropped, the bundled resources include them. |
| **5.7** | Resume position writeback to `library_put` while playing | ✅ Done in 5.6.5 (`libraryWriteProgress` + debounced flush on pause / target change / beforeunload). Roadmap entry is stale. |
| **5.7** | Subtitle/audio track *selector* dropdowns in the control bar | ✅ Done in 5.7+ (PlayerOverlay's TrackMenu). |
| **5.7** | Playlist / queue + SMTC Next/Previous wiring | 🔴 Not started. SMTC's next/previous events are received and mapped to no-op currently; would need an actual queue model. |
| **window_logic.rs:23** | `DISCORD_CLIENT_ID = "0000000000000000000"` placeholder | 🟡 Needs a real registered Discord application client ID for RPC to actually appear in user profiles. |

### Outstanding from the user's most recent feedback

| What | Status |
|------|--------|
| **Audience scores** for Rotten Tomatoes / Metacritic (separate from the critic scores OMDb gives us) | 🔴 Not implementable via OMDb. Would need either Fandango Audience Insights API (paid, requires approval) or a Metacritic / RT scraper. Currently we surface CRITIC scores only. The user is aware. |
| **MPV embedding stability** — every prior session has at some point reported "MPV renders behind UI", "MPV doesn't fill window in fullscreen", "MPV gap at bottom", "MPV black screen". The current state is stable in our local test but the embedding is fragile across libmpv builds + Windows compositor states. | 🟡 Watch closely. The thread-local Win32 resize helper + MPV property writers via `set_property` are the latest patches. If new symptoms appear, consider: re-checking the `tauri-plugin-libmpv` plugin version (currently 0.3.2), checking if MPV's child-window classname changed, or considering migrating to `mpv_render_context` (compose into webview canvas) instead of `--wid` embedding. |
| **Profile letter not updating in sidebar** (user's stated workaround was to use the AuraLogoA mark instead) | 🟡 The sidebar now shows `<AuraLogoA />` everywhere. The "letter from email/nickname" fallback path is dead code; can be removed if the brand-mark approach is permanent. Also: the user mentioned wanting a real Windows app icon — currently uses Tauri's default icons in `src-tauri/icons/`. |

### Likely friction worth a follow-up pass

- The DevConsole accumulates `console.*` from React PLUS Rust events PLUS ErrorBoundary; on long sessions this can be noisy. Consider a default-off setting or a max-rows cap < 1000.
- `tauri-plugin-libmpv` 0.3.2 is pinned; check periodically for upstream fixes — several of our workarounds (UNC path stripping for shaders, observed-property trimming, win32 child resize) exist because of plugin/wrapper limitations.
- The `opensubtitles_api_key` field is still in `AppSettings` for forward-compat. The OpenSubtitles search picker (`SubtitlePicker.tsx`) is still importable and used by PlayerOverlay's "Search OpenSubtitles…" entry in the subtitle dropdown. The user said it isn't needed — if confirmed, the picker, the Rust `subtitles.rs`, the menu entry, and the field can all be deleted.
- `placeholder` Discord client ID. Needs a real one.
- Calendar view fetches `fetch_meta_detail` for every library item with concurrency 4. For very large libraries this is O(n) HTTP at first open. Could be cached per item with mtime invalidation.

---

## 6. Recent stability landmines (read these before changing player code)

These are mistakes I made in earlier passes that have very specific symptoms — listed so a fresh session doesn't re-introduce them.

1. **NEVER** call `mpv.command("set_property", [name, value])`. Use `mpv.set_property(name, &value)`. The first form silently no-ops on this libmpv build → user sees "slider snaps back to default."
2. **NEVER** add `audio-exclusive=yes` or `audio-spdif=…` to MPV initial_options. WASAPI exclusive mode locks the audio device; other MPV instances (Stremio, mpv.net) can't play. If Aura crashes without releasing, the device stays locked.
3. **NEVER** poll multiple MPV `get_property` calls concurrently before MPV has a duration > 0. The wrapper races its own loadfile critical section and STATUS_ACCESS_VIOLATIONs (0xc0000005).
4. **NEVER** add new properties to `observed_properties` without testing. On this libmpv build, `track-list (node)` / `core-idle (flag)` / `paused-for-cache (flag)` / `aid (string)` / `sid (string)` were all rejected and broke the ENTIRE event channel (no property events fire at all). Trimmed back; everything beyond `pause / time-pos / duration / volume / speed` is polled instead.
5. **NEVER** reapply Mica on every pause (we used to). The DWM backdrop ends up on top of MPV's child surface — looks like "MPV renders behind everything."
6. **NEVER** unmount the React TitleBar in WINDOWED playback. The title bar is supposed to stay visible there. Only unmount in true OS fullscreen.
7. **NEVER** use `data-tauri-drag-region` for the title bar drag region. Use explicit `onPointerDown → startDragging()`. The CSS-attribute path leaves cursor "stuck" on simple clicks.
8. **NEVER** set `glsl-shaders` via `set_property`. Use `change-list glsl-shaders set "<forward-slash-path>"` and strip Windows `\\?\` UNC prefixes from the path string first.
9. **DO** use `mpv.destroy("main")` synchronously in `CloseRequested`. `tauri::async_runtime::spawn_blocking` returns immediately; the process can exit before WASAPI is released.
10. The HTTPS proxy bypass in `resolve_stream` is intentional — VPS hosts (e.g. `stremthru.animasec.dev`) have TLS certs signed for the direct domain, not `127.0.0.1`. Don't undo it.

---

## 7. Where to look first, by symptom

- "Volume slider snaps back" / "speed doesn't change" / "subtitle picker shows wrong selected" → `lib.rs` `set_*` commands; verify they call `mpv.set_property(...)` not `mpv.command("set_property", ...)`. Also check the polling loop in `usePlayback` doesn't re-overwrite local state.
- "MPV renders behind UI" / "black bar at top" → `App.tsx` TitleBar `opaque` prop, body `hidden` class while playing, `.aura-app-shell` background must be transparent always.
- "MPV doesn't fill window after fullscreen" → `refresh_video` in `lib.rs` + `win32::resize_mpv_child_to_parent` in `win32.rs`. Also check `App.tsx` `toggleFullscreen` is firing the `+80 ms / +240 ms` `refresh_video` calls.
- "App crashes on play" → STATUS_ACCESS_VIOLATION = MPV property race, almost certainly polling or observed-property format mismatch.
- "Native browser context menu appears" → `main.tsx` capture-phase `contextmenu` listener; should be installed BEFORE React mounts.
- "Streams from addon X don't appear" → `[X]` filter in DevConsole. The `fetch_streams` instrumentation logs manifest probe + declared types vs request type + GET URL + raw vs kept count.
- "OMDb ratings missing" → only fires when meta id starts with `tt`. Anime / Kitsu / TMDB ids are skipped (OMDb only knows IMDb). Settings field must have a key set; auto-fills `8bc2040` on first SettingsView mount.
- "Library page blank" → `<ErrorBoundary scope="Library">` will surface the error. Without that, blank usually means an ungated `library.map(...)` while `library` is undefined.

---

## 8. Suggested next-session priorities

If you're picking this up cold, the user's stated priorities (most recent first) are:

1. **Get audience scores** for Rotten Tomatoes / Metacritic (or accept the OMDb critic-only limitation and label them clearly).
2. **Real Windows app icon + brand assets** — Tauri's icons are still placeholders.
3. **Magnet streaming** (librqbit) — the biggest open scope item.
4. **Deep-link routing** for `aura://search?q=…` etc. — small, well-scoped.
5. **Auto-updater** + a real Discord application client ID.
6. **Playlist / queue** + SMTC Next/Previous.

A minimal validation script when you start:

```sh
cd src-tauri && cargo check
cd .. && npx tsc --noEmit
npx vite build
```

All three should succeed in under 30 s. If `cargo check` warns about new unused symbols, audit before suppressing — past warnings have surfaced real dead code from refactor passes.

When testing playback, use a known-working Stremio HTTPS stream (the user has been testing with `stremthru.animasec.dev` URLs). Open the DevConsole (F12) before clicking Play — the Rust side logs through `[bridge]`, `[player]`, `[streams]`, `[meta]`, `[catalog]`, `[search]`, `[subtitles]`, `[omdb]` which makes triage trivial.

## 9. Network tuning notes for power users

These are **host-level** tunables that Aura cannot ship from inside the app (they require admin and/or affect the whole system). Most users do not need to touch any of this — Aura's defaults work on a stock Windows install with stock router. Try them only if you have a high-BDP (≥100 Mbps × ≥30 ms RTT) link AND see chronic mid-playback rebuffering on debrid hosts despite the demuxer-cache settings being maxed.

### Windows 10 / 11

Run `cmd.exe` (or PowerShell) as Administrator, then check current state with:
```cmd
netsh int tcp show global
```

The settings worth trying, in order of marginal-utility-per-risk:

1. **TCP receive autotuning level** — controls how aggressively Windows scales the TCP receive window. Default `normal` is already pretty aggressive; `experimental` (RFC 1323+RFC 7323 stack) raises the ceiling for very-high-BDP links. Cost: rare interop bugs with old middleboxes.
   ```cmd
   netsh int tcp set global autotuninglevel=experimental
   ```

2. **Congestion provider** — Windows 10/11 ships BBR2 alongside CUBIC since 22H2. BBR usually helps on lossy-but-fast links (cellular, transatlantic CDN paths). CUBIC is the safe default; BBR shines when packet loss is from buffer bloat rather than congestion.
   ```cmd
   netsh int tcp set supplemental Internet congestionprovider=bbr2
   ```
   (Replace `Internet` with `Datacenter` for LAN profiles. Revert: `congestionprovider=cubic`.)

3. **RSS / RSC** — Receive-Side Scaling and Receive Segment Coalescing are usually ON by default on modern NICs. Confirm both are enabled if you see one CPU core saturated during 4K playback:
   ```cmd
   netsh int tcp show global
   ```
   Look for `Receive-Side Scaling State: enabled`. If disabled, the NIC vendor's driver settings panel re-enables it.

4. **ECN capability** — useful on links to Cloudflare-fronted origins which honour ECN. Off by default on Windows; turn on with:
   ```cmd
   netsh int tcp set global ecncapability=enabled
   ```

### Linux

If you run Aura under Wine or a Linux build (not officially supported but functional), the equivalent kernel sysctls are in `/etc/sysctl.conf`:

```
# Use BBR (Linux-native CUBIC alternative — large effect on high-BDP debrid links)
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr

# Allow large TCP windows on high-BDP links (default is 4 MB / 6 MB on most distros)
net.core.rmem_max=16777216
net.core.wmem_max=16777216
net.ipv4.tcp_rmem=4096 87380 16777216
net.ipv4.tcp_wmem=4096 65536 16777216
```

Apply with `sudo sysctl -p`.

### Router-side (cross-platform)

- **Smart Queue Management (SQM)** — `cake` or `fq_codel` on the router eliminates buffer bloat that turns 4K streaming into stalls when ANY other device on the network bursts (cloud-sync uploads, etc.). OpenWrt + cake is the gold standard. Eero/Plume etc. ship a comparable default; consumer routers usually don't.
- **DNS** — Cloudflare 1.1.1.1 or NextDNS resolve debrid CDN hostnames faster than ISP defaults; the per-stream DNS lookup is often the slow part of the cold-start path. Aura's preheat fetch (`Range: bytes=0-65535`, fired in `App.handlePlayStream`) warms the TLS session for the actual playback fetch but cannot help DNS unless the OS resolver is fast.

### What NOT to do

- Don't disable `https_only` on Aura's reqwest clients — every plaintext-HTTP fallback we've removed was the result of a real wire-capture incident.
- Don't lower `network-timeout` below 60 s — debrid hosts occasionally take 30+ seconds to mux a fresh chunk on first request.
- Don't enable Windows' "metered connection" while watching — it disables TCP autotuning entirely.

## 10. Log files & sensitive data

`%USERPROFILE%\aura-mpv.log` (verbose libmpv log) and `%USERPROFILE%\aura-panic.log` (Rust panic backtraces) are **append-mode** files Aura writes during playback / on crash. Two practical security notes:

- The **mpv log records every loaded URL verbatim**, including any `?token=…` / `auth=…` query parameters (debrid streams, signed CDN URLs). Treat the file as you would your debrid auth — don't paste it into public bug reports without redacting the URLs first. The DevConsole F12 → "Export logs" button is safer for sharing because it captures only Aura's own labelled log lines, not libmpv's verbose internals.
- **File ACLs**: Both logs inherit the `%USERPROFILE%` DACL, which on a default Windows install grants only the owning user (plus Administrators / SYSTEM at the OS level). Other standard accounts on the same machine cannot read them. Aura does **not** programmatically tighten the DACL beyond inheritance — admin-level threats can't be defended against from user space (admins can take ownership), and the inherited ACL already blocks the realistic non-admin attacker. If you have an unusual `%USERPROFILE%` ACL configuration (e.g. a corporate device with broad read grants), redirect Aura's data dir via the `LOCALAPPDATA` env var or apply `icacls "%USERPROFILE%\aura-*.log" /inheritance:r /grant:r "%USERNAME%:F"` after first launch.
- **Panic log**: smaller surface — captures backtraces and the panic message string, no URL leakage in normal operation. Still subject to the same ACL story.

## 11. Settings.json secrets — keyring migration plan (deferred)

`AppSettings` (per-scope `settings.json`) currently stores three fields that some users will treat as secret:

| Field | Current store | Sensitivity | Notes |
|---|---|---|---|
| Stremio session (`auth_key` + email) | **Keyring** (`auth.rs`) | High | Already migrated. Plaintext in dev only via `--cfg dev_keyring_fallback`. |
| `omdb_api_key` | settings.json | Low | Public 1k-req/day key, easily rotated, no privilege. |
| `scrobble_addon_url` | settings.json | Medium | Stremio-style addon URL — a self-hosted Trakt-bridge URL CAN encode auth in `?token=`. |
| `opensubtitles_api_key` | settings.json | Medium | Legacy field; not currently used (the OS provider migrated to OAuth flow). |

Migrating omdb / scrobble / opensubtitles into keyring is the right thing to do for shared-PC scenarios but **non-trivial** because of how they interact with two other features:

1. **Multi-scope** (`set_active_scope`). settings.json is per-Stremio-account; a keyring entry would have to carry the scope id or live under `KEYRING_SERVICE/{scope}/{field}`.
2. **Backup & Restore export blob**. `BackupRestoreSection` round-trips portable settings — migrating these fields out of settings.json means deciding whether the export still carries them. Two options:
   - **Include in export** — preserves portability across installs (the user expects "I exported my settings" to actually carry their OMDb key). Negates the keyring's local-storage value but matches user expectation.
   - **Exclude from export** — strict separation, but every restore-on-fresh-install requires re-pasting the OMDb key + scrobble URL.
3. **Frontend round-trip**. Settings UI currently reads `omdb_api_key` and `scrobble_addon_url` straight from the `get_settings` payload and writes via `update_settings`. Both paths would need to learn that those two fields are stored separately while the rest of `AppSettings` continues round-tripping through settings.json.

**Migration plan when priority warrants**:

1. Add `secrets.rs` with `read_secret(scope, name)` / `write_secret(scope, name, value)` keyring wrappers (scope-prefixed service names).
2. Modify `settings::load` to: (a) deserialize `AppSettings` from JSON; (b) for each secret field, if the keyring has a value, override JSON; (c) if JSON has a value but keyring doesn't, MIGRATE — copy to keyring, blank in struct, mark dirty for save.
3. Modify `settings::save` to: write the struct to JSON, but blank each secret field on the JSON-bound copy first; secrets are written separately via `write_secret`.
4. Modify `update_settings` patching: detect secret-typed keys in the patch, route to `write_secret` independently of the JSON serialize.
5. Decide export semantics — recommended: **include in export** behind an explicit "Include API keys" checkbox in the export UI, defaulting OFF.
6. Add a settings.json doc-comment listing the migrated keys so future Backup/Restore code knows to skip them on import unless the export blob explicitly carries them.

This is ~150–200 lines of careful code with migration tests, and the threat model documents it as non-blocking. Defer until either (a) a shared-PC scenario becomes a real deployment target, or (b) a new secret field needs adding (where doing it right the first time is much cheaper than retrofitting two existing fields).
