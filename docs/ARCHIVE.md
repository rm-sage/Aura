# Design archive (historical)

Consolidated record of the design specs and implementation plans that were
written during Aura's build-out and have since shipped (or were superseded).
The full text of every entry below remains in git history; this file is the
index so the `docs/` tree stays lean.

For the CURRENT state of the code, read `CLAUDE.md`. For the live (still-binding)
contracts, see `docs/release-search-spec.md` and `docs/AURA_PROXY_V2_SPEC.md`.
Forensic deep-dives live in `docs/research/`.

The originals lived under `docs/superpowers/specs/` and `docs/superpowers/plans/`
and were removed in the 2026-06 docs consolidation; recover any with
`git log --diff-filter=D --name-only` + `git show <commit>:<path>`.

## Engine, rendering, HDR

The big arc: an attempt to move mpv onto a caller-owned render context (for true
exclusive-fullscreen / off-focus control) was designed, partially built, then
ABANDONED because the render API on this libmpv build is pinned to `gl_video` and
cannot reach `vo=gpu-next`, so it could not do HDR/Dolby-Vision passthrough. The
project consolidated onto a single direct-FFI `--wid` engine instead, where
`vo=gpu-next` + d3d11 + `target-colorspace-hint` gives real HDR passthrough. See
`CLAUDE.md` (MPV engine) and `src-tauri/src/mpv/` for the result.

| Doc (date) | Subject | Status |
|---|---|---|
| 2026-05-20 render-api-rewrite-design | render-context WGL rewrite (7 phases) | SUPERSEDED |
| 2026-05-29 render-api-phase6-regression-checklist | mpv2 render-engine acceptance gate | SUPERSEDED |
| 2026-05-29 render-api-phase7-plan | retire tauri-plugin-libmpv path | SUPERSEDED |
| 2026-05-30 playback-polish-findings | playback bug status notes | SHIPPED |
| 2026-06-02 d3d11-hdr-passthrough-deferred | d3d11 HDR render path | SUPERSEDED |
| 2026-06-03 mpv2-hdr-dxgi-interop-design | HDR via DXGI flip + WGL interop | SUPERSEDED |
| 2026-06-09 hybrid-player-engine | HTML5 hybrid backend study | SUPERSEDED |
| 2026-06-10 engine-consolidation | single direct-FFI `--wid` engine | SHIPPED |

Note: the engine-consolidation doc recorded "off-focus DWM throttling accepted
as a known cost." That premise is now obsolete: the off-focus frame drops were
later root-caused to the NVIDIA "Background Application Max Frame Rate" driver
setting, not DWM throttling (see `docs/research/2026-06-22-off-focus-drops-vs-hdr.md`).

## Features

| Doc (date) | Subject | Status |
|---|---|---|
| 2026-05-19 aura-eos-spotlight-design | end-of-stream next-up / end-card overlay | SHIPPED |
| 2026-05-21 publicmetadb-skip-and-env-secrets (+plan) | PublicMetaDB OP/ED skips + `.env.local` build secrets | SHIPPED |
| 2026-06-09 casting | Chromecast (CASTV2) + DLNA | SHIPPED |
| 2026-06-09 hover-scrub-thumbnails | never-stale hover thumbnails | SHIPPED |
| 2026-06-09 live-tv | Live TV (M3U / Xtream / XMLTV EPG) | SHIPPED (v1.0.4) |
| 2026-06-09 ram-optimization | RAM audit, 17 wins applied | SHIPPED |
| 2026-06-09 source-switcher | in-player source switcher | SHIPPED |
| 2026-06-09 watch-together / 2026-06-12 (v1-v4) / 2026-06-13 watch-party-polish | synced playback rooms (CF Workers + DO relay) | SHIPPED (v1.0.1) |

## UI / Continue-Watching / playback polish batches

| Doc (date) | Subject | Status |
|---|---|---|
| 2026-05-18 aura-ui-polish-batch-design | UI polish across four surfaces | SHIPPED |
| 2026-05-18 account-panel-email-fix (plan) | account panel + email self-heal | SHIPPED |
| 2026-05-18 addon-copy-configure (plan) | addon copy / configure buttons | SHIPPED |
| 2026-05-18 calendar-sxxeyy-grid (plan) | calendar SxxEyy badges | SHIPPED |
| 2026-05-18 hover-panel-bind (plan) | hover-panel activation modes | SHIPPED |
| 2026-05-18 notif-id-selfheal (plan) | release-notification id self-heal | SHIPPED |
| 2026-06-01 cw-episode-polish-batch (+plan) | CW + episode-detail polish | SHIPPED |
| 2026-06-01 playback-polish-pass (+plan) | playback polish (hover, subs, interpolation) | SHIPPED |
| 2026-06-02 cw-detail-polish-v2 (+plan) | nine CW / detail polish fixes | SHIPPED |

## Deferred / feasibility

- **2026-06-02 linux-port-feasibility** (FEASIBILITY, not started). Concluded an
  X11 MVP is the lowest-risk first step (Wayland later); the main blocker is the
  EGL render-context path for the embedded mpv child plus Mesa limitations. Aura
  ships Windows-only today. Full study in git history if a Linux port is revived.

## Original specification

The repo's original `SPEC.md` (an aspirational pre-build sketch) was removed in
the same pass: it described `tauri-plugin-mpv`, `stremio-core`, and `redb`, none
of which were adopted (the app uses a direct libmpv FFI engine, a hand-rolled
`stremio.rs`, and settings.json + localStorage + keyring). `CLAUDE.md` and
`README.md` are the accurate descriptions of what was actually built.
