# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
It is the root of the project context. Subsystem detail lives in the files listed under "Subsystem docs"
(the end of this file): READ THE MATCHING ONE BEFORE CHANGING THAT SUBSYSTEM. The `.claude/rules/` ones
are path-scoped (their `paths` frontmatter) and load automatically when a matching file is read or
edited; the `docs/agents/` ones never load on their own.

## What Aura is

Tauri 2 + React 19 + libmpv desktop media player on Windows that consumes the Stremio addon
ecosystem. Native Win32 chrome (no decorations), transparent WebView2, MPV embedded as a child
window beneath the webview. Aura is Stremio-addon-only (used with Debrid for streams): there is no
native torrent engine and none is planned. Playback, account sync, ratings, scrobbling, casting,
live TV, and synced "watch together" rooms are all built on top of that addon model.

## Commands

```bash
# Frontend
pnpm dev                          # Vite dev server (HMR)
pnpm build                        # tsc + vite production build (uploads source maps: not for checks)
pnpm exec tsc --noEmit            # type-check only (no emit)
pnpm exec vite build --mode verify   # bundle check; never a default `vite build` for verification

# Tauri
pnpm tauri dev                    # full app with hot reload (Rust restarts on .rs change)
pnpm tauri build                  # bundled installer

# Rust (run FROM src-tauri/)
cargo check --message-format=short    # fast Rust check
cargo test --lib                      # unit tests (corpus / runtime / e2e tests are #[ignore]d)
cargo build --release

# Verification cycle (run after every meaningful edit)
cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit
```

No ESLint, no Prettier, no frontend test runner. The gates are `cargo check`, `cargo test --lib` and
`tsc --noEmit`; for a TS-only change `tsc --noEmit` is enough. Pure TS modules that are import-free
(`src/skipWindows.ts`, `src/nextUpGate.ts`, `src/nestedAddonStatus.ts`, `src/streamMeta.ts`, ...) are
checked by running them under node with hand-written cases.

When inspecting bundle output for confirmed CSS rules (e.g. verifying a Tailwind class actually
emitted), `dist/assets/index-*.css` is the artifact. It is git-ignored, so build first.

## Tech constraints and invariants

| Area | Constraint |
|------|------------|
| MAL API | `api.tenrai.org/v1` via `tenrai.rs`, NOT Jikan (shut down permanently in 2026). Same response envelope and field names, but the version segment is `/v1`, not `/v4`. Public tier is 4 req/s, 120/min, 40k/day. There is exactly ONE base-URL const; do not inline a second host. |
| AnimeThemes API | GraphQL at `https://rs.animethemes.moe/graphql` (`skipdetect/animethemes.rs`). The old JSON:API (`api.animethemes.moe`) answers 503 since 2026-11-08: never go back to it. ONE endpoint const, rustls `https_only(true)`. GraphQL failures arrive as HTTP 200 and must read as Unavailable, never a cached miss. Full rules (query shape, `overlap` enum, pacing, audio host allowlist): `.claude/rules/skip-detection.md`. |
| HTTP client | `reqwest 0.12`, default-features off, `rustls-tls` backend. Auth / account clients enforce `https_only(true)`. Do not add a plaintext-HTTP fallback: every one removed was the result of a real wire-capture incident. |
| TLS exception | Casting (`cast/`) uses `native-tls` (SChannel) on purpose, to accept self-signed CASTV2 device certs on the LAN. This is the only deliberate divergence from the rustls posture. |
| Credentials | Platform-native keyring (`keyring 3`, `windows-native` / `apple-native` / `linux-native-sync-persistent`). Native backends are MANDATORY (an in-memory mock silently lost OpenSubtitles keys between launches). Passwords wrapped in `Zeroizing<String>` (`zeroize 1`). Retired scrobble tokens (Trakt) are swept once per launch: on Windows under EVERY scope through `CredEnumerateW("trakt-*")` (`scrobble_auth.rs`, since keyring cannot enumerate); on other platforms only the active scope is cleared. |
| Secrets at rest | Stremio session (`auth_key` + email), user-supplied API keys (OpenSubtitles, PublicMetaDB), and Xtream passwords all live in the OS keyring (`auth.rs`, `api_keyring.rs`, `iptv.rs`). Build-time default keys (`AURA_MDBLIST_KEY`, `AURA_PUBLICMETADB_KEY`) are baked by `build.rs` from a git-ignored `.env.local` (see "Build-time secrets"). |
| File I/O | Scoped to `app_data_dir()`. Downloaded subtitles must land inside `app_data_dir()/subtitles`; `add_subtitle_to_mpv` enforces path containment before handing a local path to mpv. |
| Search safety | All poster URLs validated; text fields capped before returning to the frontend. |
| HTTP servers | `axum 0.7` (the in-process streaming bridge). Pinned at 0.7: 0.8 changed wildcard route syntax. |
| Async | `tokio 1` multi-thread runtime, shared by the bridge, addon fan-out, and cast servers. |

## Architecture

### Two-process model with a transparent overlay

- **Rust host** owns: the MPV engine, an in-process axum streaming bridge on `127.0.0.1:11471`, the
  Stremio account + sync API, addon fan-out, ratings aggregation, scrobbling, casting, live-TV /
  EPG, and OS integrations (SMTC, Discord RPC, keyring, system tray, Win32 fullscreen).
- **WebView2 webview** is the React UI. Configured `decorations: false`, `transparent: true`,
  `shadow: false` in `tauri.conf.json`. The webview's transparency is what lets the MPV layer show
  through; NEVER paint a non-transparent background on the app shell (`.aura-app-shell` must stay
  transparent at all times).

### The MPV engine (`src-tauri/src/mpv/`)

One engine, one DLL (`libmpv-2.dll`), one event channel, driven by direct FFI (`mpv/ffi.rs`,
`mpv/engine.rs`). It is embedded with `--wid` into a black host child window of the main window at
`HWND_BOTTOM`, below the WebView2, and renders with `vo=gpu-next` on d3d11 (real HDR passthrough via a
per-file `target-colorspace-hint`). The engine thread owns the mpv handle, the `EngineCommand` channel
(every playback Tauri command submits one), the event drain and the geometry pump (36 px title-bar
inset windowed, 0 in fullscreen). Observed properties are ONLY `pause`, `time-pos`, `duration`,
`volume`, `speed`, `frame-drop-count`, `decoder-frame-drop-count`; everything else is polled.
`tauri-plugin-libmpv`, `libmpv-wrapper.dll` and the render-context path are gone for good (no
`gpu-next`, so no HDR); `lib.rs` deletes their orphaned DLLs. The hover-thumbnail extractor
(`mpv/thumb.rs`) is created on demand and torn down when idle: never a second resident libmpv. Init
options, buffer tuning and the pump's tick tiers: `.claude/rules/mpv.md`.

### MPV stability landmines (DO NOT re-introduce)

Each has a hard-to-diagnose symptom; the full story of each is in `.claude/rules/mpv.md`.

1. **Property writes use the typed set-property path** (`EngineCommand::SetProperty`), never
   `command("set_property", ...)`, which silently no-ops on this build ("volume slider snaps back").
2. **Never enable `audio-exclusive=yes` or `audio-spdif` by default**: it locks the WASAPI device
   system-wide until reboot if Aura crashes.
3. **No `get_property` during libmpv state transitions**: gate polling on `duration > 0`, never poll
   during a seek, read tracks once after `duration > 0` + 1.5 s and again only on `aura:tracks-refresh`;
   the `chapter-list` poll uses `string` format, never `node` (the same dispatch-table fault as
   `track-list/node`).
4. **Do not extend `observed_properties`**: `track-list (node)`, `aid`, `sid`, `core-idle`,
   `paused-for-cache` each kill the ENTIRE event channel.
5. **Do not reapply Mica on every pause** (the backdrop ends up over the mpv child).
6. **Do not unmount `<TitleBar>` during windowed playback** (`opaque` prop; only true OS fullscreen
   unmounts it; PlayerOverlay's top bar offsets 36 px windowed).
7. **Title bar drag: no `data-tauri-drag-region`, never start a drag on `pointerdown`.** Arm on down,
   drag on the first move past 4 px (keeps double-click-to-maximize); Win11 `startDragging()`, Win10 a
   custom coalesced pointer drag gated by `is_windows_10`. Do not collapse either path.
8. **Never set `glsl-shaders` (or any option list) via `set_property`**: `change-list glsl-shaders set
   "<forward-slash path>"` with the `\\?\` prefix stripped.
9. **Tear mpv down synchronously in `CloseRequested`** (not `spawn_blocking`), or WASAPI stays held.
10. **Never reparent the mpv child to a top-level window**: libmpv's context does not survive it.
11. **Never hand mpv a remote URL for `sub-add`, and never block the engine thread.** It is the sole
    producer of `playback-update` and `cache-state`; a block freezes the UI while video keeps playing
    and can falsely trip the stream-lost watchdog. Subtitles are downloaded to
    `app_data_dir()/subtitles` first; keep `submit_get_property`'s `recv_timeout`.

### Streaming bridge (`src-tauri/src/streaming.rs`) - the bypasses are intentional

An **in-process** axum server on `:11471`, started by `streaming::start_in_process()` in `lib.rs`
setup (no sidecar; the old `aura-bridge.exe` was internalised). `resolve_stream` routes by scheme:

- **`magnet:`** -> bridge `/magnet/*` endpoint -> **permanently `501 NOT_IMPLEMENTED`.** Aura is
  Stremio-addon-only with Debrid; there is no torrent engine and none is planned. Do not try to wire
  one.
- **HLS (`.m3u8` / `.m3u`, ANY scheme including plain HTTP)** -> **DIRECT to MPV.** A proxied
  manifest breaks mpv's relative segment-URI resolution (absolute-path segments like
  `/live/.../seg.ts` would resolve against `127.0.0.1` -> 404) and trips provider User-Agent gating.
- **`https://`** -> **DIRECT to MPV.** Many addon hosts (e.g. `stremthru.animasec.dev`) have TLS
  certs that do not match `127.0.0.1`; bypassing also avoids double-buffering through the local
  server.
- **`http://`** -> bridge `/proxy/*` (byte-range forwarding, preserves the client User-Agent so
  mpv's Lavf UA reaches the host), EXCEPT when a per-file `via_proxy` flag is set (live-TV playlists
  that mpv tunnels via its own `http-proxy` setting) in which case it goes direct.
- Anything else -> passthrough (mpv decides).

Do not undo either the HTTPS or the HLS bypass.

### Stream lists: what auto-advance depends on

Full rules and history: `.claude/rules/streams.md`.

1. **Every `StreamEntry` that reaches the frontend is playable**: `sanitize_stream` filters the url
   (scheme, length) BEFORE the "url or infoHash" gate, never after.
2. **`fetch_streams` returns ADDON order, deterministically** (tasks tagged by addon index and sorted;
   `JoinSet::join_next` yields completion order).
3. So `pickFirstStreamForEpisode` (`src/nextUp.ts`) takes `streams[0]`, full stop: no filtering or
   re-ranking (for AIOStreams users that order IS their sort), scoped through `streamQueryAddons`.
4. **Stale urls**: an addon url is re-read before it plays when older than `STREAM_URL_MAX_AGE_MS`
   (2 h, `src/streamFreshness.ts`; Rust stamps `resolved_at_ms`); while it is re-read the row that
   started it shows a pending pill and a repeat play of the same source is ignored. A load that piles up decode errors
   with no PLAYBACK_RESTART (`playback-undecodable`) is re-resolved at once, never re-sent.

Stream chips (`src/streamMeta.ts`): split each line into glyph SEGMENTS (`splitSegments`); never
dispatch on a line's first character. A fallback that fills a field with a WRONG value is worse than
an empty one. Keep parsing both old and new TamTaro shapes (pin glyphs by codepoint). AIOStreams'
structured `streamData` facts beat the lossy text. The stream row never wraps a chip line.

### AIOMetadata wrapped inside AIOStreams

Supported setup; full rules in `.claude/rules/aiostreams.md`, fork specs in
`docs/superpowers/specs/2026-11-14-aiostreams-wrapped-aiometadata.md` and
`docs/superpowers/specs/2026-11-15-aiostreams-nested-addon-status.md`.

- **Error pseudo-metas are not titles**: AIOStreams answers any wrapped failure (a not-found included)
  with HTTP 200 and an `aiostreamserror.<json>` item. `is_addon_error_item` (stremio.rs) turns it into
  an error in `fetch_meta_detail` and drops it from catalog arrays.
- **Hidden from Home**: `showInHome` when present, else a required extra whose ONLY option is `"None"`
  (`catalog_is_hidden_from_home`). Wrapped catalog ids carry a 7-hex instance prefix.
- **Capability hints come from the LIVE manifest** (`behaviorHints.wrappedAddons`, `landscapeArt`,
  `addonStatus`) through `get_addon_manifest` / `src/addonHints.ts`, never `AddonEntry` fields:
  stremio-core drops unknown hints when an official app re-saves the collection.
- **Rate limits are read, never hard-coded**: `addon_rate.rs` keeps a bucket per (route kind, host)
  from the live `RateLimit-*` headers. Over budget AIOStreams answers HTTP 200 with a "Rate Limit
  Exceeded" error item, not a 429. Meta waits and retries (3 attempts, 30 s); search asks at most 12
  catalogs at once (`SEARCH_CATALOG_CONCURRENCY`), paced by the "catalog" bucket, a refusal retried
  once; a catalog still refused (or not answering) is reported `failed`, never folded into "no results",
  and Search shows it as a one-line "did not answer" row whose Retry asks only that catalog
  (`search_addon_grouped`'s `only`). Board catalogs are not gated.
- AIOMetadata's manifest id is `aio-metadata` (`com.aio.metadata` unconfigured).

### Tauri command registration is three places, all required

Every new Rust `#[tauri::command]` must be:
1. Declared in `src-tauri/src/lib.rs` `tauri::generate_handler![...]`
2. Allowed in `src-tauri/permissions/player.toml` (`commands.allow = [...]`)
3. Listed in `src-tauri/capabilities/default.json`

Skip any of those and the command silently 401s at runtime. There are ~90 registered commands;
`lib.rs` is the canonical list.

Two details that cause the same silent 401 and are easy to get wrong:

- **In `capabilities/default.json`, Aura's own permission sets are BARE
  identifiers** (`"allow-load-video"`, `"allow-downloads"`), matching the
  `identifier = "allow-..."` lines in `player.toml`. The `plugin:` prefix
  (`"clipboard-manager:"`, `"core:"`, `"shell:"`, `"opener:"`) is for
  third-party plugins ONLY. Writing `"player:allow-downloads"` looks right and
  resolves to nothing.
- **Prefer one command taking a tagged action enum over N near-identical ones.**
  Each command costs three registration sites, so eight control verbs would be
  24 places to get wrong. `downloads_control` is the worked example.

Related: **there is no Tauri managed state anywhere in this crate.**
`grep -rn "\.manage(\|tauri::State" src-tauri/src/` returns nothing across 57
files; the house pattern is a module-level static (`settings.rs` `CACHE`,
`scrobble.rs` `SCROBBLE_RUN_ACTIVE`, `downloads/manager.rs` `STATE`), of which
there are ~69. Follow it rather than introducing `.manage()` for one subsystem.

### Frontend <-> Rust serialization quirk

`#[serde(rename = "...")]` applies to BOTH directions. Tauri sends struct fields back to the frontend
using the renamed key. For structs that flow Rust -> React, use
`#[serde(rename(deserialize = "..."))]` (deserialize-only) so wire-format names map into snake_case
Rust on read, but Tauri's outgoing JSON uses the Rust field names that match the TS interfaces.
`LibraryItem` was the canonical hit: bidirectional renames left React reading `undefined` for `id`
and `media_type`, breaking Library / Continue Watching / Calendar simultaneously.

### Library normalization at the loadLibrary boundary

Earlier Aura builds wrote per-episode library entries (e.g. `_id: "tt0903747:1:5"`). Stremio's
official client keys library records at the SERIES root with `state.video_id` storing the episode.
`src/libraryNormalize.ts` collapses every per-episode row into one canonical series-rooted entry at
`App.loadLibrary` so Library, Calendar, and Continue Watching all read clean data; none of them
repeat the dedup logic. New writes use `target.series_id` from `targetForPlay`; legacy data is fixed
up by the normalizer. Library state is shared through `LibraryContext`.

### Continue Watching shape

`ActiveScrobbleTarget` carries both `id` (stream-fetch target: episode id for series) and `series_id`
(library record key: series root for series, equal to `id` for movies). `libraryWriteProgress`
writes `_id = series_id ?? id` and stamps `state.video_id = id` when they differ.
`libraryClearProgress` is Stremio's "Rewind": only zeroes `state.timeOffset`, preserving `video_id`
and everything else. Two entry points, one path (`aura:cw-clear` in App.tsx): the CW card's X / "Remove
from Continue Watching", and "Reset Progress" in the card menu of any title with `timeOffset > 0`, which
asks first (`askConfirm`, Cancel focused) with copy that must match what `libraryClearProgress` keeps.
The write is built from a FRESH `library_get` of the title's raw records, never the (up to 5 min old)
snapshot; a title with no record left (removed on another device) is dropped locally and nothing is
written, and a failed or empty read writes nothing and rolls back like a failed write.

### Detail page exit fade

`closeDetail` (App.tsx) is the ONLY place `selectedMeta` goes null. It stashes the leaving meta in
`detailExit` and bumps `detailGenRef`, so the same DetailView instance stays mounted, inert and
`closing`, for `DETAIL_EXIT_MS` (220 ms, DetailView.tsx) while it fades over the page beneath.
DetailView is keyed `${media_type}:${id}:${gen}`: the gen keeps the key steady through the fade and
gives any reopen a fresh instance. Play still drops the overlay instantly through the
`!isPlayerActive` gate. Do not use the View Transitions API for this (its snapshot layer swallows
input and freezes Liquid lenses).

### Story arcs: NEVER join TMDB arcs to episodes by number

TMDB arcs are sets of TMDB `(season, episode)` pairs; Aura's episodes come from Stremio meta addons, and
the two numberings disagree by no constant (TMDB promotes a One Piece special into the main run at 590:
a naive absolute join misplaces 49.6% of episodes and LOOKS correct). No season join, no absolute join,
no offset, no air-date-only or title-only key. `arc_align.rs` (banded Needleman-Wunsch over air date +
title, broadcast order as a hard constraint) is the answer; keep its tests, including the off-by-one
regression. An arc with a sub-0.5-confidence pair is dropped and logged; season 0 is excluded. Never
trust TMDB's arc NAME for filler status either: `arcKindSummary` (`src/storyArcs.ts`) derives it from
Aura's per-episode data. Full write-up: `.claude/rules/story-arcs.md`.

### Skip detection: layered, and an ED end is never EOF

`src-tauri/src/skipdetect/` (one tagged command `skip_detect`) plus `src/skipWindows.ts` and
`src/nextUpGate.ts`. **Read `.claude/rules/skip-detection.md` before touching any of it, including
the frontend files**: every threshold there was measured against a frame-verified corpus. The rules
most often broken:

- Layer 1 (AnimeThemes theme match) is high trust; its gates (30 s run, BER <= 0.35, margin >= 0.15,
  soft42 >= 0.85) are measured: never loosen one to make an episode match. Layer 3 (loudness
  continuity) is prompt-only. Layer 2 is not shipped. The `animethemes-swap` source is rated
  Risky (prompt-only, shown only with the player controls), its end is never a trusted ending end
  for Next-Up, and its false-match rate is unmeasured.
- **An ED window end is NEVER the file / container duration**: it ends where the theme ends (Layer 1)
  or at a trailing silence (Layer 3), clamped to the MEDIA end. Never borrow an ED from neighbour
  episodes, never gate an ED on a "last N seconds" band.
- `composeSkipWindows` (`src/skipWindows.ts`) is the ONE stamp function (App.tsx and the e2e harness).
  Per-kind Layer 1 state is structured (`L1State`): never parse a note string.
- Risky is ALWAYS prompt-only, and a Verified skip must never cut story: re-measure before moving any
  window into Verified.
- The Next-Up card has NO countdown; unattended advance happens only at end of stream.
- ffmpeg: one detector ffmpeg at a time, CPU work on the blocking pool, nothing on the engine thread;
  with `-copyts` never bound with `-t` (see Native dependencies).

### Downloads: two landmines and one governing rule

`src-tauri/src/downloads/`, `src-tauri/src/download_path.rs`, `src/Downloads*.tsx`, `src/downloads*.ts`.
Full design and rules: `.claude/rules/downloads.md`.

- **No download-job ffmpeg invocation may pass `-ss`, `-copyts`, `-t` or `-to`.** `-ss` on an HLS
  segment boundary lands one segment early, silently duplicating it on every resume.
- **A body that ends early looks exactly like success**: completion requires the promised byte count;
  a resume without `ETag` / `Last-Modified` compares a 64 KiB tail hash; a 200 to a `Range` request is
  the whole resource.
- **`download_path.rs` emits only fixed points of Win32 path normalization** and never NFKC-normalizes
  (that manufactures `/` and `:`).
- Rust is authoritative (the store rehydrates from `downloads_list`); the queue is a pump, not a
  Semaphore; pause/stall selects are `biased`.

### Build-time secrets

`build.rs` parses `../.env.local` (git-ignored) or real environment variables and bakes three keys
via `cargo:rustc-env`: `AURA_MDBLIST_KEY` (used by `ratings.rs`), `AURA_PUBLICMETADB_KEY` (used by
`publicmetadb.rs`), and `AURA_TMDB_KEY` (used by `arcs.rs`). An empty/missing key makes that feature
cleanly no-op (no error, just empty ratings, no skip windows, or no Arcs toggle). A user-supplied key
in the OS keyring overrides the baked one where supported (`api_keyring::SUPPORTED_KEYS` is
`opensubtitles` + `tmdb` + `introdb`; `introdb` is the user's own IntroDB key, used only to SUBMIT a
segment, never to read). Per-account cloud sync scopes by a SHA-256 hash of the Stremio `auth_key`
(`sync.rs`); each account's blob is isolated.

## Codebase map

Rust ~27k LOC, frontend ~40k LOC. One line per area here; the per-module detail (commands, devlog
labels, caches, provider rules) is in `docs/agents/codebase-map.md`.

**Rust (`src-tauri/src/`)**
- Engine + window: `mpv/` (engine, ffi, thumb, glass: the "Real glass over video" shader, SHELVED behind `REAL_GLASS_AVAILABLE` in `src/realGlass.ts` for dark spots / brightness / striping; code kept, one flag to restore), `win32.rs`, `window_logic.rs`, `player.rs`, `cinema.rs`.
- Stremio + streaming: `stremio.rs` (catalog / search / meta / streams; the biggest module),
  `streaming.rs` (bridge), `auth.rs`, `addon_rate.rs`, `sync.rs`, `addons.rs`, `oauth_callback.rs`
  (RFC 8252 loopback landing on the bridge, incl. Simkl's PKCE redirect).
- Metadata + ratings: `ratings.rs`, `tenrai.rs` (MyAnimeList), `theme_parse.rs`, `publicmetadb.rs`,
  `anime_id_map.rs`, `silencedetect.rs` (only the ffmpeg resolver now), `trailer.rs`, `release_dates.rs`.
- Skip / scrobble: `skipdetect/`, `aniskip.rs`, `introdb.rs`, `scrobble.rs`, `scrobble_auth.rs`,
  `scrobble_anilist.rs`, `scrobble_simkl.rs`. **Trakt was REMOVED (2026-11-15, user's call): never
  bring it back.**
- Subtitles + media: `subtitles.rs`, `subsync.rs`, `media_controls.rs`, `per_title.rs`.
- Story arcs + manga: `arcs.rs`, `arc_align.rs`, `arc_art.rs`, `manga_chapters.rs` (joins by AIR DATE,
  never by number).
- Casting + live TV: `cast/` (CASTV2, DLNA, HLS transcode, media server), `iptv.rs`.
- Downloads: `downloads/`, `download_path.rs`.
- Settings + infra: `settings.rs`, `api_keyring.rs`, `backup.rs`, `storage.rs`, `stats.rs`,
  `crash_reporting.rs`, `runtime_deps.rs`, `tray.rs`, `popup_nav.rs`, `devlog.rs`, `log_export.rs`,
  `perf_monitor.rs`, `history_store.rs` (watch history, user data, uncapped),
  `service_status.rs` (title-bar status chip probes; fixed endpoint table, addon URLs never logged
  unredacted or echoed).

**Frontend (`src/`)**
- Shell: `App.tsx` (~7k LOC orchestrator), `main.tsx` (installs the contextmenu suppressor BEFORE React
  mounts), `TitleBar.tsx`, `NavSidebar.tsx` (the left rail: + `RailRow.tsx`, `railLayout.ts`, `styles/glass-rail.css`), `ThemeEngine.tsx` (+ `themeAccent.ts` / `accentColor.ts` /
  `AccentColorSetting.tsx`: the per-theme custom accent), `ErrorBoundary.tsx`, `pageLayout.ts`.
- Player: `PlayerOverlay.tsx`, `SourceSwitcher.tsx`, `SubtitlePicker.tsx`, `AniSkipMenu.tsx`,
  `EosSpotlight.tsx`, `NextUpCta.tsx`, `ResumePrompt.tsx`, `PlaybackEngineGate.tsx`, `playerMenu.tsx`.
- Views (`src/views/`): Home, Library, Queue, Discover, Live, Calendar, History, Detail, Search, Addons,
  Settings, Onboarding, CatalogPage.
- Subsystems: `iptv/`, `watchTogether/`, `cast.ts` + `useCastSession.ts`, `Notifications*.tsx`,
  `updater*.ts`, `Downloads*.tsx` + `downloads*.ts`, `ServiceStatusChip.tsx` +
  `serviceStatusStore.ts` + `nestedAddonStatus.ts`, `heroBackdrop.ts`, `heroAmbient.ts` + `HeroBleed.tsx` (the Home hero's
  dithered underglow and ambient bleed; art colours read back through the `/img` proxy's CORS),
  `cardGlow.ts` + `styles/glass-cards.css` (Home catalog / CW cards: cursor-lit bezel, real-frost poster
  badges and tracks, faux frost on CW cards since round 12 for frame rate, the hovered card's dithered underglow).
- Data: `metaCache.ts`, `persistentCache.ts`, `libraryNormalize.ts`, `auraSettings.ts`,
  `settingsTransfer.ts`, `sessionRoute.ts`, `historyStore.ts`, `streamMeta.ts`, `aiometadata.ts`,
  `mangaChapters.ts`, `addonElection.ts` (which addons answer what, in what order; the ONE place for
  that decision).

## Frontend rules

- **Floating surfaces use `.aura-float-glass`** (`src/App.css` GLASS SYSTEM): menus, popovers, panels,
  dialogs; `+ .aura-glass-control` for floating controls, `+ .aura-glass-tip` for tooltips / toasts;
  `.aura-glass-flat` / `.aura-glass-field` for in-page controls; `.aura-glass-player` (material only, no
  backdrop: the rail's A face at a denser 0.86 tint, `src/styles/glass-player.css`) for ANYTHING over
  the mpv video. Two materials, Frosted (shown as "Matte", formerly "Translucent"; kept by
  installs from before the choice) and Liquid (shown as "Clear", formerly "Glass"; default for new installs; never show "Frosted"), picked
  under Settings > Theme > "Material style" with a "Cursor glow" toggle (and, under it, Edge highlights / Surface glow / Glow size: `glassGlowTune`, portable and synced, default 125% / 25% / 300 px with a `rev` migration from the old 100% / 100%) (`<html data-glass>`,
  `src/glassStyle.ts`; refraction filters `src/liquidGlass.ts`, cursor light `src/glassGlint.ts` + the `aura-rim` paint worklet `public/aura-glass-rim.js` (a crisp cool glint on the rim point nearest the pointer; every ring one 1.5 px rrect stroke so corner arcs light): every VISIBLE surface within 300 px lights while the pointer is over the window (performance rules, round 12: never light what is out of sight, hold during a user scroll, a light frame skipped when under 4.5 ms after the last (every other frame at 240 Hz), sheets lit through an overlay layer, only the bezel lit on a Continue Watching card; frontend-ui.md "The cursor light"), rim-only surfaces opt in with `data-glass-light="rim"`, text with `data-glass-light="text"` (every page title; the Home row titles also take the hero bleed's colour through `src/bleedTint.ts`; no title shimmer since round 11), and one that sets its own `background` puts `var(--lg-rim-layer)` FIRST in it, or its ring is lost). Not `.glass-panel-elevated` (tinted per theme). Drop any `bg-*` / `border-*` /
  `shadow-*` / `ring-*` utility it replaces and set the `--lg-*` hooks instead; a dialog's dim + blur is
  a SIBLING of the card, never its wrapper. The player's top-left stack (skip prompt, Next-Up card)
  is `.aura-glass-player.aura-stack-surface` (the player face at a denser 0.9 tint); over the video
  every text clears 4.5:1 on a white frame, so new player text sits on a player surface, never on the
  bare scrim. The ONE exception (user's call, 2026-11-22) is the title / SxxEyy block beside the
  icon-only back button (the old "Exit playback" pill, still `.aura-glass-player`): plain text on the
  top scrim + corner shade with a dense tight shadow (`.aura-player-title`, glass-player.css; measured
  numbers in frontend-ui.md). Lists and rows on a page are content (`.aura-content-group` /
  `.aura-content-row`), never glass. Catalog cards are content too: a rim-only bezel, `.aura-frost`
  badges on the art, never a backdrop pass on the card itself. An in-page section or card ON a page
  (Settings sections and TOC, empty / error states, Calendar cells) is a SHEET, `sheet()` from
  `src/glassSheet.ts` (`styles/glass-pages.css`): the A face with NO backdrop pass; never `.glass-panel`.
  The Detail page's two panels are menu-tier `.aura-float-glass` sheets and its episode and stream
  lists are content rows under one sliding droplet (`styles/glass-detail.css`); a list holding a
  droplet is `relative`, so landing code measures rows from rects, never `offsetTop`. Text on glass
  is white 0.55 or brighter (sheets and the Detail panels floor `text-white/30` to `/50` in CSS).
  Page titles (`.aura-row-title`) are a static near-white fill (no shimmer) lit by the cursor
  (`data-glass-light="text"`); only Home's take the bleed colour. User-visible copy says
  "Watch Party", never "Watch Together" (code identifiers keep `watchTogether`).
  Every on/off switch is `ToggleSwitch` and every segmented control `SegmentedControl`
  (`src/settingsControls.tsx`), over the video too: never hand-roll `.aura-glass-toggle` or
  `.aura-glass-seg` markup: rim-lit tracks (`data-glass-light="rim"`), a raised thumb on
  `--lg-springy`, a radiogroup with arrow keys. A switch drawn inside a row or pill that carries
  `role="switch"` is `<ToggleSwitch decorative size="sm|xs" />` (aria-hidden; the owner's focus
  rings the switch).
  Navigation is ONE floating glass rail (`.aura-rail`, `NavSidebar.tsx`, Direction A): Notifications
  (the very top), User Panel, Watch Party and the nav are rows on it under ONE hover droplet that
  slides across every hairline (the old `SidePill` pills are gone); popups
  opened from its rows portal beside it through `RailPopup`, never inside it (its backdrop-filter
  would contain and blur them). Notifications are a side sheet and an arrival bubble that both grow
  out of the Notifications row (`styles/glass-notify.css`): the sheet is DOCKED to the rail's height,
  both sit flush with its top and grow downward, arrivals MERGE into one bubble (count + bump), and nothing on that
  row loops. Small accent marks on glass (dots, badges) use `--ln-accent-mark`, never the raw accent
  (a dark custom accent vanished).
  `ContextMenuHost` renders INLINE at `z-[200]` inside `.aura-app-shell`'s stacking context, so a new
  floating panel must be portalled to `document.body` and exempt `[data-aura-context-menu]` from its
  outside-click guard (see `DownloadsPanelHost.tsx`). Why: `.claude/rules/frontend-ui.md`.

## Tailwind theme-scale gotchas (silent no-op classes)

`tailwind.config.ts` REPLACES the `maxWidth` scale and EXTENDS `opacity`. Two classes of utility
silently emit NO CSS (the JIT skips unrecognized scale values without warning), and both have bitten
the UI:

1. **maxWidth**: only `none` / `full` / `screen` survive. Every NAMED token (`max-w-md`, `max-w-6xl`,
   `max-w-prose`, `max-w-screen-*`, fractions, ...) emits nothing, so the element gets no cap and
   stretches to its parent. Arbitrary values (`max-w-[42rem]`, `max-w-[65ch]`, `max-w-[1800px]`) DO
   emit. For the main scrollable pages use the shared inline cap:
   `style={{ maxWidth: PAGE_CONTENT_MAX_W }}` from `src/pageLayout.ts` (Library, Queue, Discover,
   Catalog, Search all route through it so the centered column can never drift again; Library's
   row-windowing column math reads the same constant). For one-offs (modals, prose) use an arbitrary
   value.
2. **opacity**: the default scale is 5-point steps (`/5 /10 /15 ... /95 /100`). Any off-scale bare
   modifier (`/8`, `/12`, `/6`, `/97`, ...) emits nothing: `bg-white/8` renders no fill and
   `border border-white/8` falls back to the preflight gray-200 hairline instead of subtle white.
   The fix is to register every off-scale value the app uses under `theme.extend.opacity`. The
   current registered extras are `2 3 4 6 8 12 14 16 18 72 82 92 93 96 97 98`. When you introduce a
   new off-scale opacity, ADD it there (or use an arbitrary `/[0.07]`), then rebuild and confirm it
   emitted by grepping `dist/assets/index-*.css`.

## Windowing: fullscreen, minimize, tray

Full measurements and the refuted experiments: `.claude/rules/windowing.md` (read it before
investigating anything about restore animation or latency; do not re-run the refuted A/B tests).

- Fullscreen goes through `win32::enter_native_fullscreen` (monitor `rcMonitor`, `WS_POPUP`); Tauri's
  `setFullscreen` stops at the work area. Windowed mode clips the mpv child to keep it off a hardware
  overlay plane (true black on OLED).
- 1 ms timer resolution is scoped to a loaded file (`win32::set_high_timer_resolution`); never re-pin
  `timeBeginPeriod(1)` at startup.
- Off-focus frame drops are the NVIDIA "Background Application Max Frame Rate" setting, not Aura.
- **Every path that shows the main window calls `window_logic::unpark_main_webview` BEFORE `show()` /
  `unminimize()`**, and every park / unpark / re-park runs on the main thread. A restore site on another
  thread (the OAuth landing in `oauth_callback.rs` is a tokio handler) does the whole unpark + `show()`
  + `unminimize()` sequence in ONE `run_on_main_thread` closure, or a close-to-tray can park in between
  and leave a blank window with no tray icon. Restore order is `show()` THEN `unminimize()`.
- Close-to-tray parks the webview (WebView2 `IsVisible = false`: 48.5% of a core in the tray unparked,
  0.2% parked) only when `window_logic::park_blocker()` returns None (a loaded file, a watch-together
  room, casting, a History scrobble run block it). A parked page's timers are clamped, so a new feature
  that must keep running while the window is in the tray adds itself to `park_blocker`, and any path
  that clears a blocker calls `window_logic::repark_if_tray_hidden`.
- **Every webview is built in Rust with `lib.rs::webview_browser_args()`**: every webview sharing the
  main user data folder needs the SAME WebView2 arguments (WebView2 refuses a second environment with
  different options, so the window silently fails to open while Hardware acceleration is off). Never use
  the JS `new Webview()` / `new WebviewWindow()` API; popups go through `open_oauth_popup_webview`. wry
  ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
- **A thread that owns a child of the main window never sleeps without a message wait**
  (`MsgWaitForMultipleObjects`); the mpv pump sleeping in `park_timeout` is what broke the restore
  animation. The main webview's auto-resize is off (`fit_main_webview` skips the minimize resize) and
  `install_iconic_frame_guard` handles `WM_NCCALCSIZE` while iconic.

## Caching and stored data

Every cache is bounded (size cap AND eviction or TTL). The full list of caches, keys, TTLs and caps,
and the long rules below, are in `.claude/rules/caching.md`: read it before touching any cache, sync.ts,
backups, history or the Stremio collection write. Rules that cause data loss when broken:

- **Watch history is user data, not a cache, and is uncapped.** Rust owns it (`history_store.rs`, one
  gzip file per scope); an unreadable file is NEVER an empty history; anything that treats the list as
  authoritative awaits `historyReady()`, and an empty pre-hydration list is never pushed.
- **Stremio collection writes** (add, remove, reorder, manifest refresh) hold `COLLECTION_WRITE_LOCK`,
  refuse partial reads, and the shown addon list is never shrunk by an unconfirmed read. One manifest
  stremio-core cannot parse locks the user's addon list in every official app.
- Cloud sync: a push with no etag sends a null If-Match (an unconditional overwrite), so it is held
  unless the last pull answered 404.
- Machine-local settings (`download_dir`, `screenshot_dir`, and `gpu_acceleration`, `hdr_mode`,
  `hdr_enabled`, `hdr_target_peak_nits`, whose home is `render.json`) never sync. Leaving a key out of `PORTABLE_*_FIELDS` is NOT enough (those gate file
  export / import only, and `update_settings` shallow-merges whatever the cloud sends): a new
  machine-local key is deleted from the outbound blob in `readSettingsBlob`, pinned to the LOCAL value in
  `writeSettingsBlob`'s patch, and listed in `MACHINE_LOCAL_BACKEND_KEYS` (all in `sync.ts`).
- Skip detection result cache: any path that deletes `skipdetect-v1.json` must call `forget_prescanned`.
- A failed TMDB release-date lookup is never cached long. "Is it aired" reads go through `releasedMs`,
  never a bare `Date.parse(v.released)`.
- A `removeItem` under a live `PersistentCache` is written back; clear it through `clearPersistentCache`.

## Performance and memory (build every feature memory-conscious)

RAM discipline is a standing requirement: Aura is a long-running WebView2 + libmpv app and memory
creep degrades the experience. When adding ANY feature:

- **Bound every cache.** A module-level `Map` / object cache needs a size cap AND eviction or TTL
  (mirror `metaCache.ts`). Never ship a "never cleared" Map. Persisted blobs (localStorage) need a
  cap too.
- **Images are the top consumer.** Pass server-resize width hints (like `landscapeArt`'s `w=640`)
  instead of pulling full-size masters into small tiles; keep offscreen images unmounted (the
  `ImageLoader` IntersectionObserver pattern); virtualize / cap visible card counts
  (`useRowWindow.ts`).
- **Tear down idle native resources.** Do not keep a second resident libmpv (the thumb extractor is
  on-demand create + idle teardown). Fetch runtime binaries on demand (`runtime_deps.rs`).
- **Always clean up.** `addEventListener` / `setInterval` in an effect must return a cleanup;
  `useSyncExternalStore` subscribers must unsubscribe. And never add `get_property` polling during
  MPV state transitions (landmines).
- **The playhead is not React state.** mpv's `time-pos` (~30 Hz) lives in `src/playbackClock.tsx`
  (`setPlaybackTime` is written only by `usePlayback`). A component that draws it calls
  `usePlaybackTime()` (PlayerOverlay) or wraps just that piece in `<PlaybackTimeView>`; per-tick logic
  in App is a `usePlaybackClock(fn, deps)` subscription, and a callback reads `getPlaybackTime()`.
  Never pass the position down from App as a prop or keep it in App state: that re-renders App and
  everything under it on every tick.
- **Tune buffers consciously.** The demuxer read-ahead and any in-memory stream buffer have deliberate
  caps (see the engine init options); surface the UX tradeoff when changing them.

## Conventions

The full list (keybindings, Esc layering, title-bar panels, wheel scrolling, the Performance Monitor,
Settings sync internals, library loads, auto-remove, episode-list landing) is in
`.claude/rules/conventions.md`. The ones that apply to most changes:

- **No em-dashes (or en-dashes) anywhere**: code comments, commit messages, UI copy, release notes,
  prose. Use a hyphen, colon, parentheses, or a sentence break.
- Any Settings-page change must be evaluated for export/import (`PORTABLE_AURA_FIELDS` /
  `PORTABLE_BACKEND_FIELDS` in `settingsTransfer.ts`) and cloud-sync sharability.
- A new Settings row is visible by default; a provider override or power-user knob goes in
  `<AdvancedOnly>`. Every searchable row keeps `data-settings-row` / `data-settings-label` /
  `data-settings-description` on its outermost element.
- Write backend settings through `patchBackendSettings` (`src/backendSettings.ts`, shared by Settings and
  onboarding): it diffs, fires the narrow side events and the changed-keys dispatch. Settings controls
  (`SettingToggle`, `SettingDropdown`, ...) live in `src/settingsControls.tsx`, the AniList / Simkl row in
  `src/ScrobbleAuthRow.tsx`, the language list in `src/languages.ts`, import in `applySettingsImport`.
- ANY new `update_settings` or `set_theme` caller must dispatch `aura:backend-settings-changed`
  (detail `{ keys?, fromCloud? }`) after the write lands, listing only keys that really changed.
- A new search box only needs `data-aura-search` on its `<input>` (Ctrl+F). Never use WebView2's
  `AreBrowserAcceleratorKeysEnabled` (it kills F5).
- A layer above a page or the player takes Escape in a window CAPTURE listener with stopPropagation.
- A new decorative animation loop that repaints belongs in the `data-aura-scrolling` pause list in
  App.css (a list, never `*`). A slow drift (a sweep over many seconds) runs at about 30 `steps()` a
  second, never per display frame: every damaged frame redraws every backdrop pass on the page
  (`.claude/rules/frontend-ui.md` "Home performance"). Keep a bound Liquid filter's images small: a
  backdrop filter's bitmaps are re-sent with every frame.
- Themes are `data-theme` on `<html>`; the valid set lives only in `ThemeEngine.tsx`. A theme's accent
  can be overridden per theme (`AuraSettings.themeAccents`, synced, drawn ONLY by `src/themeAccent.ts`
  as inline `--ln-accent*` on `<html>`, plus `data-accent-light` for a very light one, which edges
  the Matte switch knob): derive accent tokens from `--ln-accent-rgb`, never a colour
  literal, and put text on a solid accent fill in `text-ln-accent-ink`, never `text-black`
  (`.claude/rules/frontend-ui.md` "Custom accent colour").
- FilterState's default year range is unbounded (-Infinity / Infinity): never JSON-serialize it as is.
- F12 opens the DevConsole. Rust logs go through `crate::devlog!` with a `[label]`; grep the label (the
  full label list is in `.claude/rules/conventions.md`). Log a request by addon label plus `{type}/{id}`,
  never its URL.
- Debugging a reported symptom: `docs/agents/symptoms.md` maps symptoms to the code to read first.

### Native dependencies and runtime binaries

- `src-tauri/lib/` is git-ignored (>100 MB). `libmpv-2.dll` is REQUIRED there for dev (download from
  `github.com/zhongfly/mpv-winbuild`). `libmpv-wrapper.dll` is no longer used and is actively cleaned
  up as an orphan.
**ffmpeg landmine: with `-copyts`, NEVER bound the slice with `-t`.** `-t` is documented as a
duration, but under `-copyts` ffmpeg measures it against the COPIED (absolute) timestamps, so it
silently behaves like `-to`. `-ss 330 -copyts -t 300` therefore means "stop once the timestamp
reaches 300", which is already in the past at the seek point: ffmpeg writes ZERO bytes and the
feature fails silently. Use `-to (start + window)`. This was measured against the bundled
`ffmpeg.exe`, and it had silently broken TWO features: `subsync.rs` (Live Sync on embedded tracks was
dead for any playhead past ~7m30s) and the old `silencedetect.rs` detectors, since retired (every
chunk past the first decoded nothing, so only the head of a file was ever scanned, and the `-sseof`
outro scan decoded nothing at all on a real episode). `-sseof` already bounds a read to the tail, so
it needs no output limit; `skipdetect` does not use it at all (both `-sseof` forms count back from
the CONTAINER duration, and plain `-sseof` restarts timestamps at 0).

- `ffmpeg` (skip detection + subsync + cast HLS transcode), `ffprobe` (subsync + cast), and `yt-dlp`
  (trailers) are NOT bundled. They are fetched on demand from a GitHub `runtime-deps` prerelease, SHA-verified
  (`runtime_deps.rs`). Absent -> the dependent feature ships inert rather than crashing.

## Log files and sensitive data

- `%USERPROFILE%\aura-mpv.log` (verbose libmpv) records every loaded URL verbatim, including
  `?token=` / `auth=` query params (debrid, signed CDN). Treat it like your debrid auth; redact URLs
  before sharing. The DevConsole "Export logs" button is safer: it captures Aura's own labelled
  lines plus libmpv's info-level messages (forwarded under `[mpv]`), not libmpv's verbose log, and
  every URL in those lines goes through `redact_sensitive_url` (`stremio.rs`: opaque path segments,
  userinfo, secret-named query values, nested URLs) or `redact_urls_in_text` for libmpv's prose.
  Keep it that way: log a request by addon label plus `{type}/{id}`, a reqwest error through
  `reqwest_err_for_log` (its Display appends the URL), and never feed a log label into data. An error
  string RETURNED to the frontend never embeds a reqwest error's Display either (the catalog / meta /
  search errors are "Catalog fetch <kind>", "Meta HTTP error: <status>" and the like): pages show it.
- `%USERPROFILE%\aura-panic.log` (Rust panic backtraces) is smaller surface (no URL leakage in normal
  operation).
- Both inherit the `%USERPROFILE%` DACL, which on a default install grants only the owning user (plus
  Administrators / SYSTEM). Aura does not tighten the DACL beyond inheritance (admin-level threats
  cannot be defended from user space). On an unusual `%USERPROFILE%` ACL, redirect the data dir via
  `LOCALAPPDATA` or run
  `icacls "%USERPROFILE%\aura-*.log" /inheritance:r /grant:r "%USERNAME%:F"` after first launch.

## Versioning: default to a PATCH bump

Pick the version from what the release CONTAINS, never from the adjective in the request.
"Release a minor version" / "a small release" / "a quick one" are all colloquial and usually mean
"a modest release", which is a PATCH. If the wording and the content disagree, the content wins.

**Default is a patch bump (`x.y.Z`).** This project's bar for a minor is high, and the history is
the evidence: `1.0.7` shipped the entire Watch Trailer feature, `1.0.9` gave every theme its own
accent colour, and `1.5.4` replaced the whole scrobble sign-in with a browser OAuth flow.
All three were patches.

**Bump the minor (`x.Y.0`) only when the release's headline is a NEW named surface** the user did
not have before, i.e. the lead sentence of the notes can name something they could not do at all
previously:

- a new page or view (`1.4.0` Airing)
- a new subsystem (`1.5.0` Story Arcs, Live Subtitle Sync)
- a new capability with its own menu or settings block (`1.2.0` automatic skip detection,
  `1.3.0` Library filters and auto-remove)

**Never bump the minor for** a fix batch of any size (`1.5.1` was ~22 fixes and stayed a patch),
restoring behaviour an upstream change broke, reworking a flow that already existed, a
performance / RAM pass, UI polish, or new chips, badges and tooltips on an existing surface.

**Never pick a major (`X.0.0`) autonomously.** It marks a milestone the maintainer declares.

The one-line test: *does the notes' lead sentence name something the user could not do before?*
No means patch. If it is genuinely borderline, ask rather than guess, since the tag, the signed
artifacts and the updater feed all bake the number in and a published version cannot be recalled.

## Subsystem docs

Read the matching file before changing that area. A `.claude/rules/` file loads by itself only when a
file in its `paths` list is read or edited (`App.tsx` is in none of them, though it drives the skip
chain, playback and sync), so name it explicitly when a change crosses into its area. When a rule
grows a new file, add the file to its `paths`.

| File | Covers |
|------|--------|
| `.claude/rules/skip-detection.md` | Skip detection end to end: layers, gates, holds, merge ranks, confidence levels, Next-Up timing, ffmpeg passes, cancellation, pre-scan, AnimeThemes API rules |
| `.claude/rules/downloads.md` | Download manager: HLS modes, resume validation, path safety, machine-local settings |
| `.claude/rules/mpv.md` | mpv engine internals, init options, and the full landmine stories |
| `.claude/rules/streams.md` | Stream-list invariants, stale urls, stream chip parsing, AIOStreams stream facts |
| `.claude/rules/aiostreams.md` | AIOMetadata inside AIOStreams, rate limits, nested addon status |
| `.claude/rules/story-arcs.md` | TMDB arc alignment and filler labels |
| `.claude/rules/caching.md` | Every cache and store: history, sync, backups, manifest refresh, collection writes, release dates, early releases |
| `.claude/rules/conventions.md` | All UI / settings / input conventions and the devlog label list |
| `.claude/rules/windowing.md` | Fullscreen, minimize and tray restore investigation |
| `.claude/rules/frontend-ui.md` | The glass system: Frosted / Liquid, which class, hooks, Liquid filter registry, the A control tier, the cursor light (reach, rim worklet, idle rim), the Home hero bleed / underglow, the Home cards, the left rail, custom accent colours and their sync, player material-only rule |
| `docs/agents/codebase-map.md` | Per-module detail for every Rust and frontend file group |
| `docs/agents/symptoms.md` | Where to look first by symptom |
| `docs/agents/network-tuning.md` | Host-level network advice for power users |

Also: `ROADMAP.md` (stops around 5.8; trust the code over it), `src-tauri/permissions/player.toml` +
`src-tauri/capabilities/default.json` (the permission ledger), `docs/research/` (forensic deep-dives),
`docs/superpowers/specs/` (design specs).
