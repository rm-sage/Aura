# Render-API Rewrite — Phase 6 Regression Checklist

Status: ACTIVE (2026-05-29). Branch `feat/render-api-rewrite`.

The mpv2 render-context engine is now the **DEFAULT** playback path (no env
var needed). This checklist is the acceptance gate before Phase 7 (deleting
`tauri-plugin-libmpv` + `libmpv-wrapper.dll`). Run it on real hardware — the
rewrite is verified-on-hardware at every phase and the engine has no
automated test coverage.

## How the gate works now

- **Default:** mpv2 engine drives playback. `init_mpv` (legacy `--wid`) is skipped.
- **Revert:** launch with `$env:AURA_MPV2=0` (also accepts `off`/`false`/`no`)
  to restore the legacy path for an A/B comparison or as an escape hatch.
- DevConsole (F12), `[mpv2]` + `[player]` sources, tells you which path booted:
  - mpv2 default → `[player] mpv2 render engine is the default — skipping legacy --wid MPV init` + `[mpv2] spawning long-lived render engine — default path`.
  - reverted → `[player] MPV engine ready` and **no** `[mpv2] spawning…` line.

## Known-acceptable (NOT regressions)

- **Off-focus frame drops** are NOT an acceptance criterion. The investigation
  was closed as unsolvable (DWM throttling; mpv.exe/VLC/Stremio don't solve it
  either). Acceptance is only that the engine is **no worse than v0.8.0/legacy**.
  Quantify with the Debug Panel drop test (below), comparing both paths.
- **1px black strip at the bottom in native fullscreen** — intentional. The
  `FSO_HEIGHT_INSET` geometry break is what stops Win11 promoting the WGL
  surface to Independent Flip / MPO (which would blank the UI). The strip
  reads as a thin letterbox line.

## Caveats to keep in mind while testing

- **No auto-fallback on async engine failure.** If the engine's WGL/GL bring-up
  fails on its render thread (bad driver, RDP session, headless GPU), there is
  currently NO automatic switch to legacy — you'll get audio-but-no-video or a
  dead player. Symptom in DevConsole: `[mpv2]` errors during bring-up, then
  playback commands no-op. Recovery: relaunch with `AURA_MPV2=0`. (Automatic
  WGL-failure fallback is a Phase 7 hardening item.) The boot path DOES fall
  back if the main window's HWND can't be resolved (synchronous failure).
- Watch the DevConsole for any `STATUS_ACCESS_VIOLATION` / crash around seeks,
  track switches, and AniSkip jumps (landmine #3 territory).

---

## Checklist

Run each on the **default** (mpv2) build. Where a row says "A/B", also run it
under `AURA_MPV2=0` and confirm parity.

### 1. Boot & engine bring-up
- [x] App launches and plays a stream with no env var set (mpv2 default).
- [x] DevConsole shows the mpv2 default boot lines + a real `GL_VERSION`/`GL_RENDERER`.
- [x] `AURA_MPV2=0` relaunch boots the legacy path (and still plays) — A/B baseline.

### 2. Core playback
- [x] Play a **movie** stream — video + audio, correct colours (no cyan flashes, no over-saturation).
- [x] Play a **series episode** stream.
- [x] Pause / resume via spacebar AND the on-screen control.
- [x] Stop / exit playback (Esc) returns cleanly to the browse UI.

### 3. Seek / time
- [x] Scrubber drag seeks correctly; time + duration read live.
- [x] Arrow-key relative seek (`seek_relative`).
- [x] Frame-step forward/back (`,` / `.`) — auto-pauses, steps one frame.
- [x] No crash during rapid seeking.

### 4. Volume / speed
- [x] Volume slider sticks (NO snap-back — landmine #1) and persists.
- [x] Playback speed change takes effect and persists.

### 5. Audio / subtitle tracks
- [ ] `get_tracks` populates the audio + subtitle menus for a multi-track file.
- [ ] Switch audio track (`set_audio_track`) — audio actually changes.
- [ ] Switch subtitle track (`set_subtitle_track`) — subs change / off works.
- [ ] Add an external subtitle file (`add_subtitle_to_mpv`) — appears + selectable.
- [ ] Subtitle styling (size/colour/position) applies.

### 6. Video property toggles
- [ ] HDR mode: Tone-map → SDR, Passthrough, Off (`apply_hdr_settings`) — on an HDR source.
- [ ] Loudness normalization on/off (`set_audio_loudnorm`).
- [ ] Motion interpolation on/off + tscale kernel change.
- [ ] Panscan toggle (zoom-to-fill).
- [ ] Video zoom.
- [ ] glsl-shaders / Anime4K profile apply (path handling — landmine #8).
- [ ] Per-stream settings batch applies on each load (no stale state between streams).

### 7. Window / fullscreen geometry
- [ ] Maximize / restore — video re-fills (`refresh_video`).
- [ ] Drag-resize — flicker is gone/acceptable (Phase 5 engine-owned resize).
- [ ] Enter native fullscreen (F): UI stays visible, colours stay correct, other
      monitors don't flash, no 2–3 s mode-switch latency (the four FSO symptoms).
- [ ] Exit fullscreen — returns to windowed cleanly; TitleBar/overlay offsets correct.
- [ ] The 1px bottom strip in fullscreen is the only artifact (expected).

### 8. End-of-stream / next-up
- [ ] Stream reaches end → EOS handling fires.
- [ ] Next-Up CTA + auto-advance (if enabled) plays the next episode.
- [ ] EOS Spotlight renders.

### 9. Continue Watching / progress
- [ ] Progress writes during playback; CW row updates.
- [ ] Resume-from-offset works on re-open.

### 10. Scrubber thumbnails
- [ ] Hover the scrubber → thumbnail preview appears (separate thumb instance — confirm it still warms + renders).

### 11. OS integration
- [ ] Keep-display-awake: monitor does NOT sleep during active unpaused playback; DOES when paused/stopped (DevConsole `display sleep inhibit → true/false`).
- [ ] Pause-on-blur / pause-on-minimize: alt-tab away pauses; restoring resumes per settings.
- [ ] SMTC (media keys / Windows volume flyout) reflects title + play state.
- [ ] Discord RPC reflects playback (if enabled).

### 12. Off-focus drop comparison (informational, not a gate)
- [ ] Settings → Debug Stuff → drop test, ~15 s, alt-tab away while it runs. Record `delta_vo` / `rate_vo` + initial/final mode.
- [ ] Repeat under `AURA_MPV2=0`. Record the same. Engine must be **≤ legacy** (≈parity is fine).

### 13. Stability / shutdown
- [ ] No `STATUS_ACCESS_VIOLATION` anywhere above (check `%USERPROFILE%\aura-mpv.log` tail if a crash occurs).
- [ ] AniSkip OP/ED auto-skip (if used) doesn't crash mid-seek.
- [ ] Close the app DURING playback: no hang, process exits promptly, audio device released (reopen Aura or another media app immediately — WASAPI not stuck; landmine #9).

---

## Result

- Pass everything (with off-focus ≈parity) → green-light Phase 7: delete
  `tauri-plugin-libmpv` + `libmpv-wrapper.dll`, simplify `player.rs::check_mpv_dll`
  to libmpv-2.dll only, update README pre-flight + HANDOFF.md + CLAUDE.md landmines.
- Any regression vs the `AURA_MPV2=0` baseline → file it against the specific
  command/area before Phase 7 (legacy is still present as the fallback).

drop-test numbers / notes:
```
(record here)
```
