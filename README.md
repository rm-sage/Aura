# Aura

A cinematic desktop media player for Windows, built on
Tauri 2 + React 19 + libmpv. Consumes the Stremio addon ecosystem.

## Features

**Playback & playlist**

- libmpv embedded as a child window — full hardware decode, custom GLSL
  shaders, per-track audio / subtitle / video selection, loudness
  normalization (`loudnorm` filter), AI-detected silence trim.
- mpv-native motion interpolation — GPU `video-sync=display-resample` +
  `interpolation` with a selectable `tscale` kernel; smooths cadence
  judder without an external frame-doubler.
- Hover-seek thumbnail preview — scrubbing the timeline renders a frame
  thumbnail from a dedicated headless libmpv instance; highlighted
  OP/ED skip bands surface segment details on hover.
- Native Win32 fullscreen (`WS_POPUP` + monitor rect) — proper exclusive
  appearance, not the work-area rect Tauri's `setFullscreen` produces.
- Continue Watching with segmented per-season progress bars (long-runners
  flip to a gradient bar past 50 episodes), AIOMetadata-aware specials
  hiding, and series-rooted library writes that match the Stremio cloud
  schema.

**Stremio account & sync**

- Stremio login (email/password + in-app OAuth popup) with credentials
  stored in the OS keyring (Windows Credential Manager via DPAPI).
- Library, Continue Watching, Calendar all read from a single normalized
  Stremio mirror — per-episode legacy entries collapsed at the loadLibrary
  boundary, so all three surfaces see consistent state.
- **Aura Cloud Sync** (Aura Proxy v2) — per-account state mirrored across
  installs: API keys, settings, notification history, and the Phase 9
  release-search signal feed. ETag-conditional batch fetches keep traffic
  minimal.

**Ratings & discovery**

- Multi-source ratings aggregator — MDBList (IMDb, Rotten Tomatoes,
  Metacritic, TMDB, Trakt, Letterboxd) plus Jikan (MyAnimeList) and
  AniList for anime, merged with addon-supplied scores and rendered with
  Logo.dev brand logos + per-source tooltips on the detail page. The
  MDBList key is baked at build time, so the IMDb / RT / Metacritic tier
  needs no user-supplied key.
- Stremio-Kai-style mini-meta hover panel — hovering a catalog poster
  surfaces synopsis, ratings and metadata after a short intent delay,
  reusing the shared meta cache (and skipping non-`meta` addons) so
  rapid hovers don't refetch or fan out wastefully.

**Notifications**

- Cloud-driven release signals: scanner walks `recent_aired` arrays for
  stacked notifications, cross-checks library `state.video_id` so completed
  shows don't re-notify, and persists across reboots.
- Optional "only notify when a stream is available" gate with a deferred
  re-check timer.
- Manual library refresh button next to the bell, with a 2-second cooldown
  and per-id nudge to the release poller.

**Scrobble**

- Trakt and AniList scrobble pipelines, both OAuth-authenticated through
  the in-app popup.
- Cour-aware: anime aggregated by AIOMetadata as multi-season shows
  scrobble to the correct cour-specific MAL entry, with an absolute-S1
  fallback for shows Trakt indexes under one season.
- Dedup and history-pause aware.

**Anime tooling**

- AniSkip integration — auto-skip / prompt / off modes, scrub-bar OP/ED
  band visualisation, in-app submission and 3-second-cooldown voting
  forms, cour-specific MAL resolution via Fribb → yuna.moe → AniList GraphQL
  fallback chain.
- AIOMetadata `filler` / `recap` flags surface as detail-page banners and
  optional auto-skip in Next-Up.
- OP/ED skip extends beyond AniSkip to **any series** — chapter-title
  heuristics classify intro / credits chapters, with a bounded Hybrid
  Mode `blackdetect` + `silencedetect` tail-scan for live-action or
  unchaptered content and an auto silence-detect OP fallback. ffmpeg is
  bundled with the installer, so these detectors need nothing on PATH.

**Subtitles**

- OpenSubtitles file-hash matching (the same 16-byte block hash Stremio
  Web uses).
- External subtitles fan-out from addons, with one-click attach to the
  running mpv instance.

**OS integration**

- Discord Rich Presence (browse + playback) with per-title blocklist.
- Windows SMTC (System Media Transport Controls) — play/pause/seek from
  the volume flyout, lock screen, and headset buttons.
- Auto-updater (signed via minisign) with `latest.json` manifest hosted on
  GitHub Releases.

**Developer / power-user**

- F12 DevConsole — ring-buffer log viewer with level filters, search,
  copy / download to file, and a typed command prompt (`notifytest`,
  `clear`, `pause`, etc.).
- Opt-in crash reporting (Sentry) — JS render errors + native
  STATUS_ACCESS_VIOLATION minidumps. Dev builds are gated out, only
  release builds with explicit consent ship anything.
- First-run onboarding wizard (Stremio import, suggested addons, settings).

## Status

Actively developed. The core surface (playback, library, notifications,
sync, scrobble, AniSkip, OpenSubtitles, onboarding) has been stable
since 0.6.7; 0.7.0 adds the multi-source ratings aggregator, the
mini-meta hover panel, hover-seek thumbnails, mpv-native motion
interpolation, and any-series OP/ED skip with Hybrid Mode. Ongoing work
is polish, regression fixes, and the items in `ROADMAP.md`. See
`HANDOFF.md` for running design / forensic notes.

## Building from source

Prerequisites:

- Rust (stable, edition 2021)
- Node.js + pnpm
- Windows 10/11 (primary target — macOS / Linux paths exist for the
  non-Windows-specific code but aren't part of the regular CI lane)

The libmpv DLLs are NOT in the repo (they're > 100 MB). Drop the two
DLLs into `src-tauri/lib/`:

- `libmpv-2.dll` — from <https://github.com/zhongfly/mpv-winbuild>
- `libmpv-wrapper.dll` — from <https://github.com/nini22P/libmpv-wrapper>

The skip detectors (Hybrid Mode, silence / black detection) shell out
to ffmpeg. A static `ffmpeg.exe` dropped into `src-tauri/lib/` is
bundled by the installer via the `lib/**/*` resources glob, so end
users need nothing on PATH; if it's absent the app falls back to a
system `ffmpeg` with no regression. The git-ignored binary is the
gyan.dev `ffmpeg-release-essentials` build (see `src-tauri/lib/.gitignore`).

Then:

```
pnpm install
pnpm tauri dev
```

### Streaming bridge (built in)

Aura runs a tiny loopback proxy on `127.0.0.1:11471` that forwards
plain-HTTP stream byte ranges. It's **in-process** — part of the main
executable, nothing to install or run separately. HTTPS streams and HLS
manifests bypass it entirely and go straight to the player. If the port
is already in use, the proxy is disabled gracefully (a warning is logged
to the F12 DevConsole) and everything else keeps working.

## License

This project uses split licensing.

- **Code** is licensed under the **GNU Affero General Public License,
  version 3 or any later version (AGPL-3.0-or-later)** — see
  [`LICENSE`](LICENSE) for the full text. In short: you may
  redistribute and modify the code, but any network-deployed
  modification (or distributed binary) must publish its source under
  the same license.

- **Branding** — the Aura name, the Aura "A" logo (`src/AuraLogoA.tsx`,
  `src-tauri/icons/*`), and any associated wordmark / logotype — is
  licensed separately under **Creative Commons Attribution-
  NonCommercial 4.0 International (CC-BY-NC-4.0)** — see
  [`LICENSE-ASSETS`](LICENSE-ASSETS) for the full text and the exact
  list of paths covered. Forks intending to ship a commercial product
  MUST replace these branding assets with their own.

## Contact

For licensing questions, security reports, or anything else relating
to this project:

- **Electronic mail:** [contact@animasec.dev](mailto:contact@animasec.dev)
- **Postal mail:** *intentionally omitted*
