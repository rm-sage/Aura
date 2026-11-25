# Codebase map (full)

> Moved verbatim out of the root CLAUDE.md (2026-11-17) to keep it under the size limit; the root keeps a short summary and links here. Read this before changing: anything: this is the per-module detail behind CLAUDE.md's short map.

### Rust (`src-tauri/src/`)

- **Engine + window**: `mpv/engine.rs` (FFI engine), `mpv/ffi.rs` (raw bindings), `mpv/thumb.rs`
  (on-demand thumbnail extractor), `mpv/glass.rs` + `mpv/aura_glass.glsl` ("Real glass over video",
  SHELVED 2026-11-18 behind `REAL_GLASS_AVAILABLE` in `src/realGlass.ts`: dark spots, brightness and
  banding / striping over real video after four tuning rounds; code kept, never invoked while shelved:
  the opt-in OUTPUT-stage shader that blurs the video under the player bar and menus, its projection,
  state machine and the one `player_glass` command; driven by the engine, rules in `.claude/rules/mpv.md`;
  `mpv/glass_shader_tests.rs` is its ignored runtime test), `win32.rs` (native fullscreen, mpv-child resize, display-refresh
  query, power-throttling opt-out, windowed MPO poison, `get_display_hdr_info`: Windows HDR supported / on for the window's monitor via DisplayConfig, loaded at runtime), `window_logic.rs` (window events, native
  fullscreen toggle, Discord RPC presence), `player.rs` (HDR mode resolution, audio passthrough,
  subtitle styling defaults), `cinema.rs` (GLSL shader profiles).
- **Stremio + streaming**: `stremio.rs` (catalog / search / library / meta / stream aggregation /
  external subs; the biggest module), `streaming.rs` (axum bridge), `auth.rs` (Stremio login /
  session), `addon_rate.rs` (per-host pacing to an addon's published rate limit), `sync.rs` (cloud library sync + release-signal polling), `addons.rs`,
  `oauth_callback.rs` (RFC 8252 §7.3 loopback landing pad for system-browser OAuth, served as
  `GET /oauth/callback` on the same bridge listener; nonce-guarded, re-emits the existing
  `deep-link` event so `App.tsx` persists tokens through one code path. Proxy-side contract in
  `docs/oauth-loopback-contract.md`. Also serves `GET /oauth/callback/simkl`, Simkl's own PKCE
  redirect target with no proxy involved: the `state` is a nonce carrying the PKCE verifier, the
  code is exchanged there, and the result leaves through the same `deep-link` re-emit).
- **Metadata + ratings**: `ratings.rs` (MDBList + MAL + AniList aggregator, anime-aware weights),
  `tenrai.rs` (the MyAnimeList client: base URL, a bounded `/anime/{id}/full` cache shared by
  ratings and theme songs, plus the five on-demand extras commands), `theme_parse.rs` (MAL theme
  display-string parser, has `#[cfg(test)]` tests),
  `publicmetadb.rs` (OP/ED skip source + TMDB id resolution), `anime_id_map.rs`, `silencedetect.rs`
  (now only the shared ffmpeg resolver; its old detectors are retired), `trailer.rs` (YouTube
  trailer resolve).
- **Skip / scrobble**: `skipdetect/` (the layered OP/ED detector, see `.claude/rules/skip-detection.md`:
  `fingerprint`, `matcher` (Layer 1 gates), `themes`, `continuity` (Layer 3), `probe` (argv +
  stderr parsers), `audio` (ffmpeg processes), `animethemes`, `cache`, `job`; ignored corpus and
  runtime parity tests), `aniskip.rs` (OP/ED timing, vote/submit, id resolution), `introdb.rs` +
  `src/introdb.ts` (IntroDB: IMDb-keyed intro / recap / outro segments for ANY series with a `tt`
  root, not gated to anime; one `introdb` command with a tagged `fetch` / `submit` / `status`
  action. Rows are keyed by the SUBMITTER's numbering, so the frontend asks the addon's own pair
  first, then the id-string pair, then absolute-under-S1, and uses only the first answer with a
  usable segment; it never invents an offset. Trust split in Rust: `introdb` (>= 2 submissions
  at >= 0.9 confidence) ranks with AniSkip in `dedupeSkipWindows`, `introdb-single` sits between
  publicmetadb and `aniskip-neighbour` and is prompt-only. Submission is user-initiated from the
  AuraSkip menu, needs the user's own key (`api_keyring` name `introdb`), maps op/ed/recap to
  intro/outro/recap, and treats 429 as "already submitted recently". Movies are not queried:
  Aura has no movie ED slot), `scrobble.rs` +
  `scrobble_auth.rs` + `scrobble_anilist.rs` (AniList + Simkl OAuth, completion pushes). Trakt
  support was REMOVED (2026-11-15, user's call: Simkl and AniList cover it); do not bring it back.
  `scrobble_auth::RETIRED_SERVICES` deletes a leftover `trakt-<scope>` keyring token the first time a
  scope's status is read, and `scrobbledStore.ts` / the bell drop old Trakt records on load.
  `scrobble.rs` also exposes the manual `scrobble_history_anilist` command (the per-row buttons on
  the History tab in `src/views/HistoryView.tsx`), which backdates the mark to the original watch
  time (AniList is day-precision via `completedAt`).
  `scrobble_simkl.rs` is the second provider: OAuth 2.0 authorization code + PKCE as a public client
  (no proxy, no secret; lands on `/oauth/callback/simkl`), COMPLETION-ONLY
  (`POST /sync/history`, never `/scrobble/*`: one POST per finished item, plus one fallback POST
  with show-level ids when an anime episode's cour-level ids come back not_found), and it
  supplements AniList (an anime episode goes to both). Every Simkl POST is paced at least 1.1 s
  apart (Simkl's budget is 1 POST/s: overage answers `429 {"error":"rate_limit"}` and starts a
  throttling block, reported as `412 client_id_failed` while active, that repeated overage extends;
  `400 RATE_LIMIT`, spelled `rate_limit` in the sync guide, is the 20 s per-user write lock, not a
  rate limit), and `scrobble_history_simkl` takes the History rows as ONE batch (chunks of 100) and
  returns a result per row. All of it is inert while
  `SIMKL_CLIENT_ID` (in `scrobble_auth.rs`) is empty;
  `scrobble_services_available` is how the frontend tells "not in this build" from "not connected".
  Frontend: `src/scrobbleConn.ts` owns the provider list, its per-provider Records and the cached
  availability ask (an unavailable Simkl is muted in Settings and never offered in History),
  `src/scrobbleSimkl.ts` the batch call plus the id-eligibility mirror of Rust's `targets`, and
  `src/scrobbleRun.ts` sends a bulk run's Simkl rows as ONE call after the per-row loop, mapping
  the per-row results back by index.
- **Subtitles + media**: `subtitles.rs` (OpenSubtitles v1: search incl. moviehash, download,
  add-to-mpv), `subsync.rs` (Live Sync cue lists: SRT / WebVTT / ASS parsing for external tracks,
  WINDOWED ffmpeg extraction for embedded ones), `media_controls.rs` (SMTC via souvlaki),
  `per_title.rs` (per-id volume / shader / track memory).
- **Story arcs**: `arcs.rs` (TMDB episode groups -> arcs, grouping selection, the command),
  `arc_align.rs` (the join, never by episode number; see `.claude/rules/story-arcs.md`), `arc_art.rs` (Fandom arc key art, curated
  TMDB-id -> wiki table). Devlog label `[arcs]`. The wiki table is a struct per show: `art` gates
  the key art (Bleach is listed `chapters_only`), `episodes` names the episode-infobox fields the
  manga-chapter feature reads (verified per wiki; `None` where unverified or unusable).
- **Manga chapters**: `manga_chapters.rs`, one tagged command `manga_chapters` (`series` / `arcs` /
  `episodes`). Series line from MangaUpdates' public API (`anime.start` / `anime.end`, parsed
  strictly: an unreadable string shows nothing, never the raw text), matched through MAL's
  "Adaptation" relation (tenrai) and an EXACT normalized title, earliest year, type Manga / Manhwa /
  Manhua. Arc ranges from the RENDERED infobox of the arc's Fandom page (`action=parse&section=0`),
  the arc reaching its page through `arc_art::resolve_arc_pages` (by page, never by episode
  number); a part ("Wano Country Part 2"), a combined name ("Water 7 & Enies Lobby Arc") or a
  one-chapter infobox never takes a range. Per-episode chapters from episode pages fetched 50 per
  request (`rvsection=0`), joined to Aura's episodes by AIR DATE with a title tie-break
  (`join_by_air_date`), never by number: wikis number episodes officially, Aura's addon may not
  (the One Piece 590 landmine again, `.claude/rules/story-arcs.md`). One Piece's episode pages carry no Japanese air date, so it
  gets arc ranges only, and an episode's hover shows its ARC's range, never an interpolated guess.
  Devlog label `[manga]`. Frontend: `src/mangaChapters.ts` (bounded in-memory store + hooks +
  formatting), shown as the "Manga" row of the detail page's Details list (under
  Source; "Checking" / "Not available" with the reason on hover rather than no row, for a manga-type
  source), on arc tiles and the open arc's breadcrumb, beside
  the season picker (only where per-episode data covers the season), in episode rows' HOVER text
  only, and next to the episode title in the player (read from the store, never fetched there).
- **Casting + live TV**: `cast/mod.rs` + `cast/castv2.rs` + `cast/dlna.rs` + `cast/hls.rs` +
  `cast/media_server.rs` (Chromecast via hand-rolled CASTV2 + DLNA + on-the-fly HLS transcode),
  `iptv.rs` (EPG fetch + Xtream password keyring).
- **Downloads**: `downloads/` (`manager.rs` registry + pump, `http.rs` direct
  transport, `hls.rs` the two HLS modes, `store.rs` `downloads.json`,
  `taskbar.rs` ITaskbarList3, `commands.rs` the five commands),
  `download_path.rs` (Windows path safety, standalone + tested). Devlog label
  `[downloads]`.
- **Settings + infra**: `settings.rs` (per-scope AppSettings + theme + HDR resolver; machine-local
  `gpu_acceleration` and the HDR trio live in `render.json`, read back over every scope), `api_keyring.rs`
  (user API keys in keyring), `backup.rs` (user-data export), `storage.rs`, `stats.rs`,
  `crash_reporting.rs` (Sentry + minidump self-spawn), `runtime_deps.rs` (on-demand binary fetch),
  `tray.rs`, `popup_nav.rs` (in-app browser webview nav), `devlog.rs`, `log_export.rs`.
- **Watch history**: `history_store.rs` (one compact gzip file per scope under
  `app_data_dir()/history`, no entry cap, coalesced atomic writes, the cloud `history` blob's
  encode / decode; one tagged command `history_store`). A failed background write is retried with
  backoff. `sync.ts` keeps an `aura:sync:history-unpushed:<scope>` marker from a local edit until a
  push lands, and every completed pull republishes while it is set: only a local edit pushes
  history, so a push lost at exit or on the network had no other retry. Devlog label `[history]`.
- **Service status**: `service_status.rs`, one tagged command `service_status` (action `check`),
  behind the title-bar chip. It probes Aura's server (`/healthz`, the ONE host const), every
  installed addon's `/manifest.json`, the Watch Together relay's `/health`, and the debrid
  providers the user chose to monitor (`monitoredProviders`, a portable Aura setting) from a FIXED
  table of status endpoints in Rust, never URLs from the frontend. Provider answers are cached 60 s
  (a failed fetch 5 s); the frontend polls every 5 min. Two clients: the Aura / provider one is
  rustls `https_only(true)`; the ADDON one is deliberately not, because installed addons and the
  dev relay can be `http://` (a LAN or loopback addon, Stremio's "Local Files" on 127.0.0.1:11470,
  `ws://` relays), which matches every other addon fetch in `stremio.rs`. Addon URLs carry config
  tokens: they are logged only through `redact_sensitive_url` and never echoed back (the reply is
  index-aligned). An addon the list gains after a check read it gets one addons-only probe
  (`probeNewAddons`) that moves neither the 5 min poll nor any other addon. A full round that reads offline (Aura and
  every non-loopback addon and relay probe failed with no HTTP answer; `Probe.loopback` marks a probe to this machine)
  gets one retry 30-60 s later by rewinding the poll clock, and the retry earns no further one.
  WRAPPED addons: an addon whose LIVE manifest declares `behaviorHints.addonStatus` (read through
  `addonHints.ts` `useAddonHintsFor`, for every checkable addon, not only meta ones) is listed in the
  check's `nested` indexes, and beside its manifest probe Rust reads `<base>/api/status/addons.json`
  (12 s, 128 KiB, at most 40 rows, names and verdicts only, every URL-shaped word replaced). The rows
  render indented under the wrapper; a wrapped addon that is down only DEGRADES the chip (amber: the
  wrapper skips it and serves the rest), and a wrapped addon's failed real request in the last 30 min
  reads as degraded even when its manifest answers. Its `error` categories are worded in
  `src/nestedAddonStatus.ts` (import-free; `invalid response` gets a hover sentence), and a category Aura
  does not know is shown as it came, clamped to 40 characters, never dropped. Every age in those rows
  is read on the WRAPPER's clock (`nestedAge`: its `checkedAt` minus the timestamp, plus the time since
  the report arrived, Rust's `fetched_at`), never this machine's clock against the server's. A hint that lands after the addon's last probe
  makes it count as new once (`probeNewAddons`). Devlog label `[status]`.

### Frontend (`src/`)

- **Shell + router**: `App.tsx` (~7k LOC orchestrator: router, `usePlayback`, library load/normalize,
  auth, fullscreen, notifications, watch-together room state, scrobble + auto-advance, chapter-skip
  merge, session-route restore), `main.tsx` (entry; installs the capture-phase contextmenu
  suppressor BEFORE React mounts), `TitleBar.tsx`, `NavSidebar.tsx` (the left rail: one glass surface
  holding, top to bottom, `NotificationsBell.tsx` (its side sheet and arrival bubble sit flush with
  the rail's top and grow downward: `NotificationsPanel.tsx` `railPopupTop` / `railOrigin`),
  `AccountButton.tsx` (User Panel + ProfilePopover), `PartyButton.tsx` and the nav, under ONE hover
  droplet for the whole rail (`useRailDroplet`); rows `RailRow.tsx`, geometry and popup anchors
  `railLayout.ts`, styles `styles/glass-rail.css`), `ThemeEngine.tsx`,
  `ErrorBoundary.tsx`, `pageLayout.ts` (shared `PAGE_CONTENT_MAX_W`), `popPresence.ts` (shared
  mount / enter / exit hook for transition-driven panels: ProfilePopover, WatchTogetherPanel).
- **Player**: `PlayerOverlay.tsx` (~4.3k LOC in-player UI), `SourceSwitcher.tsx`, `SubtitlePicker.tsx`,
  `AniSkipMenu.tsx`, `EosSpotlight.tsx` (end-of-stream next-up / end-card), `NextUpCta.tsx`,
  `ResumePrompt.tsx`, `PlaybackEngineGate.tsx`, `realGlass.ts` (measures the bar and open docked
  menus for the "Real glass over video" shader and marks the surfaces it draws under; SHELVED behind
  its `REAL_GLASS_AVAILABLE` flag, which hides the Settings row and keeps every `player_glass` call off).
- **Views (`src/views/`)**: Home, Library, Queue, Discover, Live, Calendar, History, Detail, Search,
  Addons, Settings, Onboarding, CatalogPage. Live subviews in `src/views/live/`
  (Guide, MultiView, PlaylistForm). `DetailView.tsx` takes a `closing` prop (set by App's
  `closeDetail` while the instance stays mounted, inert, fading over the page beneath) and exports
  `DETAIL_EXIT_MS` (220 ms, the fade length App waits before unmounting it).
- **Onboarding**: `views/OnboardingView.tsx` (the setup wizard: welcome + import, look, playback,
  addons, tracking; modes "first-run", "addons-only" from Addons > Suggested addons, "rerun" from
  Settings > Backup & Restore > Run setup again) and `onboarding.ts` (completion flag
  `aura:onboarding-completed-v1`, never renamed; progress `aura:onboarding-progress-v2`). Every
  choice is applied live through the same helpers Settings uses. The wizard shipped until 2.3.2 saved
  its audio pick as a one-entry `audio_priority`, dropping "original"; `audioPriorityRepair.ts`
  (called from App's `applySettingsScope`) fixes that shape ONCE PER ACCOUNT after the scope's first
  pull (`settingsCloudSettled` in sync.ts): the synced backend flag `audio_priority_repaired` (written
  in the same patch as the list, never turned off by a pull in `writeSettingsBlob`, kept by
  `reset_settings`, not in export / import) says it ran; the old per-device marker
  `aura:audio-priority-repair-v1:<scope>` still stops that device from repairing. A real change parks
  a device-local "Audio order updated" bell notice (`aura:audio-order-notice:v1`, raised by
  `useAudioOrderNotice.ts`) whose Undo (`undoAudioOrderRepair`, NotificationsPanel) restores the old
  list through `patchBackendSettings`, only for the same account and only while the list is still
  the repaired one. The shape test and the notice copy are the import-free `legacyAudioPriority.ts`.
- **Glass light and Home cards**: `glassGlint.ts` + `public/aura-glass-rim.js` (the cursor light: a
  glint on the rim point nearest the pointer, visible surfaces only, paced, held during a user scroll;
  tune `glassGlowTune` defaults 125% / 25% / 300 px with a `rev: 2` migration in `auraSettings.ts`),
  `CinemaRows.tsx` (CatalogCard, ContinueWatchingCard: CW bar tinted like the detail page's progress
  bar, no latest-aired marker, faux frost and only the bezel lit on CW cards, poster track above the
  rating-chip band), `WatchedBadge.tsx` (one 26 px frost watch mark / one 22 px solid badge for every
  state), `cardGlow.ts`; the card menu's "Reset Progress" lives in App.tsx (`aura:cw-clear`).
- **Settings shared pieces** (used by Settings and the wizard): `settingsControls.tsx` (ToggleSwitch,
  SettingDropdown, SettingToggle, SettingText, AttachedSettings, SegmentedControl (the one glass
  segmented control: rim-lit track, thumb sprung on `--lg-springy`, a radiogroup), ChoiceList (radio
  rows that can carry a chip), the Advanced tag), `backendSettings.ts` (`patchBackendSettings`: the
  one backend write path and its events), `HdrModeSetting.tsx` (the HDR mode row: Convert / Send HDR
  as radio rows, the Recommended chip and the Windows display-check chips in the upscaler's
  `PlayerMenuChip` look), `hdrMode.ts` (`setHdrMode` / `setHdrPeakNits`: the one HDR write path,
  backend patch plus `apply_hdr_settings` plus `aura:hdr-mode-changed`; the device-local first-run
  default, the Off-to-Convert migration and the offer flags), `useHdrPassthroughOffer.ts` (the
  one-time "Send HDR?" bell offer, mounted in App's NotificationsBridge; its id never syncs),
  `GlassStyleSetting.tsx` (the Material style / Cursor glow rows; the options are shown as Matte, stored "frosted", and Clear, stored "liquid"), `useMaterialNotice.ts` (the
  one-time "New look options" bell notice for installs from before the material choice, owed by
  `auraSettings.ts` `decideGlassDefaults`, mounted beside the HDR offer; device-local, as are its
  keys `aura:glass-defaults:v1` and `aura:material-notice:v1`),
  `languages.ts` (`LANGUAGE_OPTIONS`; `SUBTITLE_LANGUAGE_OPTIONS` adds Off), `ScrobbleAuthRow.tsx` (AniList / Simkl sign-in row; the
  sign-in start itself is `scrobbleSignIn.ts`, shared with the notification Reconnect),
  `applySettingsImport` in `settingsTransfer.ts`, `THEME_SWATCHES` in `ThemeEngine.tsx`.
- **Detail hero backdrop**: `heroBackdrop.ts` (the per-title override store and the synchronous,
  network-free candidate list) and `HeroBackdropPicker.tsx` (the portalled picker panel), raised by
  right-clicking bare hero area on the detail page. The override is read at every hero latch site
  (see "Hero art latch" in `DetailView.tsx`).
- **Service status**: `ServiceStatusChip.tsx` (the title-bar chip and its panel, which replaced
  `SyncStatusChip.tsx`), `serviceStatusStore.ts` (App publishes the addon list there instead of
  threading a prop through `TitleBar`).
- **Subsystem modules**: live TV in `src/iptv/*` (M3U / Xtream / XMLTV parse, EPG store + worker),
  watch-together in `src/watchTogether/*` (WebSocket to the `watch-relay/` Cloudflare Workers + DO
  relay), casting via `cast.ts` + `useCastSession.ts`, notifications in `Notifications*.tsx`
  (ring buffer + background scanner), updater in `updater*.ts` + `UpdatePopup.tsx` + `Changelog.tsx`.
- **Downloads**: `downloadsStore.ts` (projection of the Rust list),
  `downloadsPanel.ts` (open/closing/closed), `DownloadsButton.tsx`,
  `DownloadsPanelHost.tsx` (portalled to body), `DownloadRow.tsx`,
  `downloadsMenu.tsx` (the shared stream-row menu builder),
  `DownloadsClosePrompt.tsx`, `DownloadsRelinkBridge.tsx`.
- **Data / caching**: `metaCache.ts`, `persistentCache.ts`, `libraryNormalize.ts`, `auraSettings.ts`,
  `settingsTransfer.ts`, `sessionRoute.ts`, `catalogHoverStore.ts`, `releaseSignalStore.ts`,
  `historyStore.ts` (mirror of the Rust `history_store.rs` file), `streamMeta.ts`, `aiometadata.ts`, `mangaChapters.ts`. See "Caching boundaries".
- **Addon election**: `addonElection.ts` owns "which addons can answer this, in what order":
  Stremio's resource / type / id-prefix gates (failing open on empty cached fields) in plain
  addon order, except meta, which is tiered (declared prefix match, then the pinned or
  first-declared provider for ids nobody declares, then prefix-less catch-alls, then stale
  entries). Also the fail-closed search election, the Settings overrides (`applyOverride`,
  which `streamQueryAddons` wraps) and the provider-picker predicates.
