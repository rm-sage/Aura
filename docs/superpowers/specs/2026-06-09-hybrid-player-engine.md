# Port: the reference implementation's Hybrid Player Engine (mpv + HTML5 auto-select) into Aura

> **Effort:** Recommended core (A+B, optional C) = M; full HDR-aware auto-swap (A-D) = L (runtime legacy<->render engine teardown/standup is the cost); HTML5 backend (Phase X) = XL and not recommended on Windows-only Aura.  
> **Quick-win:** YES — Phase A plus the same-URL-reload slice of Phase B. Classify END_FILE reasons into decode/network/source on the EXISTING mpv2 `drain_mpv_events` + legacy `mpv-event-main` channels (no new command, no 3-place registration), surface `errorCode` in App.tsx usePlayback, and on an early error re-issue `load_video` once before failing. Pure hardening, no UI, no engine changes, no user input required. Honors landmine #3 by reusing the snapshot stream instead of adding get_property polling.  
> **Decisions needed (see end):** 5

# Porting Spec — the reference implementation Hybrid Player Engine → Aura

## TL;DR recommendation (read first)

the reference implementation ships **two playback backends** (native libmpv via `--wid` child window, and an in-WebView2 HTML5 `<video>` element) plus an **Auto** mode that picks one per stream, with a multi-tier auto-retry/fallback chain (same-URL reload → debrid failover → stremio-server HLS transcode → next candidate). On **Windows specifically**, the reference implementation's mpv backend is *the same `--wid` child-window architecture Aura's legacy `AURA_MPV2=0` path uses* — the HTML5 path exists mainly as (a) a fallback when the libmpv DLL probe fails, (b) the only option on platforms where mpv embedding is weak (their Linux story, and web builds), and (c) a decode-error escape hatch.

**For Aura, the full hybrid is mostly NOT worth porting.** Aura is Windows-only, mpv-centric, has no stremio-server sidecar, no `<video>` element, no hls.js. The genuine, high-value piece to extract is **the auto-retry / auto-fallback state machine** (detect black screen, frozen position, decode error, stuck-on-load → reload then advance to next candidate stream), which is engine-agnostic and would harden Aura today. The HTML5 backend itself is a large build with thin marginal benefit on Aura's platform.

**On the HDR/DV question (user's MUST-keep `--wid`):** Aura already has exactly the right primitive — the `AURA_MPV2` gate selecting mpv2-render-engine (default) vs legacy `--wid` (`AURA_MPV2=0`). Per Aura's own render-api-rewrite findings, **legacy `--wid` + `vo=gpu-next` + `gpu-context=d3d11` is the only path that does proper HDR/Dolby Vision passthrough today** (mpv2's render API is hardcoded to `gl_video`, gpu-next/scRGB unreachable, and the DXGI-interop HDR path is deferred + HW-gated). So the correct "hybrid" for Aura is **not** mpv-vs-HTML5 — it is **mpv2-render-engine vs legacy-`--wid`-mpv**, auto-selected per stream by HDR/DV heuristics. That reuses Aura's existing dual-engine machinery instead of introducing a whole new HTML5 stack. See Section 5 / decisions.

---

## 1. What the reference implementation does (architecture + key files)

### 1.1 The bridge abstraction
the reference implementation defines a single `PlayerBridge` TypeScript interface (`src/lib/player/bridge.ts`) — `attach/detach/load/play/pause/seek/setVolume/setAudioTrack/setSubtitleTrack/addSubtitle/screenshot/requestPiP/capabilities/subscribe/destroy`, plus a normalized `PlayerSnapshot` (status, position, duration, buffered, tracks, chapters, subText, videoWidth/Height, `errorCode: "decode"|"codec"|"network"|"source"|"unknown"`). Two concrete implementations satisfy it:

- **`src/lib/player/mpv.ts`** — `createMpvBridge()`. Talks to Rust via `invoke("mpv_start" | "mpv_command" | "mpv_set_property" | "mpv_sub_add" | "mpv_set_geometry" | "mpv_set_clip_rects" | "mpv_save_screenshot" | "mpv_stop")`, listens to `mpv://event` / `mpv://log`. `capabilities()` returns `{engine:"mpv", hdrPassthrough:true, hardwareDecode:true, chromecast:true, pictureInPicture:true}`. When embedded, it runs a 250 ms geometry tick that pushes the video-mount client rect (DPR-scaled) to `mpv_set_geometry`, plus resize/move kick handlers — Aura's equivalent of the `refresh_video` storm.
- **`src/lib/player/html5/bridge.ts`** — `createHtml5Bridge()`. Creates a real `<video>` element in the host div. Uses **hls.js** for `.m3u8` sources (`Hls.isSupported()`), native `src` otherwise. Implements its own subtitle engine (fetch + parse SRT/VTT/ASS via `@/lib/subtitles/parser`, rAF cue ticker), HLS audio-track switching, Document Picture-in-Picture (`src/lib/player/html5/pip.ts`), MediaSession, canvas screenshot. `capabilities()` returns `{engine:"html5", hdrPassthrough:false, chromecast:false}`.

### 1.2 The auto-selector (the heart of the feature)
**`src/views/player/player-utils.ts` → `pickBridge(want, notWebReady, mpvOpts)`** is the decision function. Exact logic:

```
if isLinuxDesktop()        -> html5                       (mpv embed weak on Linux)
if want === "html5"        -> html5
if want === "mpv"          -> probeMpv(); mpv if available else html5 (warn: high memory)
// want === "auto":
isDesktop = "__TAURI_INTERNALS__" in window
if (isDesktop || notWebReady) -> probeMpv(); mpv if available
otherwise                  -> html5   (web build, web-ready stream)
```

So the **heuristics are deliberately coarse**: on desktop, Auto almost always picks mpv (mpv decodes everything; no reason to use the in-webview decoder). `notWebReady` (from Stremio `behaviorHints.notWebReady`, set on torrent/file sources in `src/lib/streams/resolve.ts`) forces mpv even on web. HLS/DRM/codec are **not** branched on at selection time — they are handled *reactively* by the retry chain instead. `probeMpv()` (`mpv_probe` Rust command) is the availability gate; if the libmpv DLL is missing, the reference implementation silently degrades to the HTML5 decoder.

**`src/views/player/hooks/use-player-bridge.ts`** owns bridge lifecycle: builds a `bridgeKey` from `settings.playerEngine | anime4k | hdrToSdr | shaders`, calls `pickBridge`, attaches to the `videoMountRef` div, subscribes snapshots (with a clock-ignoring diff to avoid re-render storms), and exposes `{snap, engine, bridgeReady}`. It also contains the **auto-fallback escalation**: if the active engine is html5, setting is `auto`, and a `decode`/`codec` error fires, it probes mpv and flips `autoFallbackTried=true`, which rebuilds the bridge as mpv (the `bridgeKey` includes that flag).

### 1.3 The resilience chain
**`src/views/player/hooks/use-auto-retry.ts`** (the most reusable asset). On `snap.errorCode != null` (before 5 s of playback), in order:
1. **Debrid failover** — if the stream has an `infoHash` and debrids configured, re-resolve via another debrid and `bridge.load()` the new URL.
2. **Same-URL reload** — one retry of the identical URL (transient network).
3. **stremio-server transcode** — if enabled and error is `decode`, probe the bundled stremio-server sidecar and rebuild with `buildTranscodedUrl()` → `http://127.0.0.1:11470/hlsv2/{id}/master.m3u8` (`src/lib/stremio-server.ts`). This is also where the HTML5 engine's "fallback to HLS transcode on decode error" comes from.
4. **Next candidate** — `triggerAutoRetry()` re-opens the stream picker on candidate #N+1 (clears picker cache after attempt 2), up to `MAX_AUTORETRY_ATTEMPTS=5`.

Plus independent watchdogs: black-screen detector (audio but `videoWidth/Height==0` past a grace window), frozen-position detector (position not advancing for 18 s / never-started 75 s), stuck-on-load (`duration==0 && pos==0` for `STUCK_AUTORETRY_MS=18s`), live-IPTV reconnect, and P2P-engine peer/progress watchdogs.

### 1.4 Rust side
**`src-tauri/src/mpv.rs`** — `mpv_start` builds a `libmpv2` instance via direct FFI (`Mpv::with_initializer`). `apply_pre_init`: on **Windows it sets `wid` = main HWND** (same `--wid` child embedding as Aura legacy), `vo=gpu-next`, `hwdec=auto`, `force-window=immediate`; HDR is **passthrough by default** — it only sets `tone-mapping=bt.2446a` when `hdr_to_sdr` is explicitly requested. `mpv_set_geometry` → `position_embedded_mpv_child` (Win32 child resize, same as Aura's `win32.rs`). `mpv_set_clip_rects` is a **no-op on Windows** (only used by the macOS render path). macOS uses a separate render-context path (`src-tauri/src/mpv_render_mac.rs`, `vo=libmpv` + `MPV_RENDER_API_TYPE_OPENGL` into the NSWindow) — the analog of Aura's mpv2 engine, but Mac-only.

**`src-tauri/src/transcode.rs`** — NOT the player's transcode fallback. It is the **cast server's** ffmpeg re-encoder (H264+AAC+MPEGTS for DLNA/Chromecast) plus an ffprobe codec probe. The player's transcode fallback is the stremio-server sidecar (frontend `buildTranscodedUrl`), not this file. **Out of scope for Aura** (no casting, no ffmpeg sidecar guaranteed).

### 1.5 Net: what "hybrid" actually buys the reference implementation
- **Cross-platform reach** (web build + weak-mpv Linux) — irrelevant to Windows-only Aura.
- **Graceful degradation** when libmpv DLL is absent — minor for Aura (DLLs are a documented pre-flight requirement).
- **HLS-native playback** via hls.js — but mpv plays HLS fine; this matters mainly for the web build and for the casting/transcode path.
- **Document PiP** in a separate OS window — genuinely nice, only the HTML5 engine can do it.
- **The resilience chain** — engine-agnostic, the real prize.

---

## 2. Aura mapping (exact files, conventions)

### 2.1 Current Aura playback architecture (counterpart inventory)
- **Engine selection already exists**: `src-tauri/src/mpv2/engine.rs::enabled()` reads `AURA_MPV2` (default ON = render engine; `0/off/false/no` = legacy `--wid`). Every playback command in `lib.rs` is gated `if mpv2::engine::enabled() && mpv2::engine::is_running() { route to engine } else { legacy app.mpv() }`. **This is Aura's `pickBridge` equivalent — but it is a *process-global, env-var, boot-time* switch, not per-stream.**
- **No HTML5 backend, no `<video>`, no hls.js/mpegts.js** anywhere in `src/` (verified). `usePlayback` lives in `App.tsx`.
- **No stremio-server sidecar** — only Aura's own `aura-bridge` axum proxy on `:11471` (`externalBin: ["binaries/aura-bridge"]`). So the reference implementation's HLS-transcode tier #3 has **no infrastructure** in Aura.
- **MPV control commands** (`lib.rs`): `load_video`, `stop_video`, `toggle_pause`, `seek_relative/absolute`, `set_volume`, `set_speed`, `set_audio_track`, `set_subtitle_track`, `get_tracks`, `get_property`, `refresh_video`, `apply_lang_defaults`, HDR/shader setters. Player UI is `PlayerOverlay.tsx`; snapshot flows via `playback-update`/`osd-update` events.
- **HDR**: `settings.rs` has `hdr_mode` (tri-state `passthrough`/`sdr`/`off`) + legacy `hdr_enabled`. HDR applied at engine init (`engine.rs`) and via Settings toggle.

### 2.2 If we port the resilience chain (recommended core)
Create **`src/usePlaybackRetry.ts`** (new hook, Aura naming: camelCase `useX.ts` like `useScrobble.ts`, `useKeybindings.ts`). It consumes the existing `playback-update` snapshot (position, duration) + a new `errorCode` signal and a `playCandidate(attempt)` callback wired from `App.tsx`'s stream-picker flow. Mirrors the reference implementation's `use-auto-retry.ts` minus debrid-failover and stremio-transcode tiers (no infra), keeping: same-URL reload, black-screen detector, frozen-position detector, stuck-on-load detector. Tiers map to `load_video` re-invokes and an `App`-level "advance to next stream candidate" action.

To feed it an `errorCode`, extend the Rust event surface: `mpv2/engine.rs` already maps `END_FILE` reason → string in `drain_mpv_events` (Phase 3). Add an `errorCode` classification (`decode`/`network`/`source`) emitted on `playback-end`/`end-file` and surface it in the `usePlayback` state in `App.tsx`. This is the **only** Rust change the resilience port strictly needs.

### 2.3 If we port the per-stream engine selector (HDR-aware, recommended over HTML5)
The Aura-native "hybrid" = **auto-pick mpv2-render vs legacy-`--wid` per stream based on HDR/DV need**, instead of mpv-vs-HTML5. Files:
- **`src-tauri/src/settings.rs`** — add `player_engine: String` (`"auto" | "render" | "legacy"`, default `"auto"`) with `#[serde(default = "default_player_engine")]`. Note the CLAUDE.md serde gotcha: this flows Rust→React, so if any wire-name remap is needed use `rename(deserialize = ...)`; a plain snake_case field needs no rename.
- **`src-tauri/src/mpv2/engine.rs::enabled()`** — today reads only the env var. Make it consult a runtime-settable override (a `OnceLock<AtomicU8>` engine-mode slot) so the selection can be set **before each `load_video`** rather than only at boot. The env var stays as the hard override / dev escape hatch.
- **`src/App.tsx` (`handlePlayStream`)** — before `load_video`, compute the desired engine from stream metadata (`streamMeta.ts` already parses `hdr`/DV/codec) + `settings.player_engine`, and call a new `set_player_engine` command. The catch (Section 3): switching legacy↔render at runtime is **not** free — it requires tearing down one engine and standing up the other (z-order, init_mpv skip). This is the hard part and the main reason this is L-effort.
- **`streamMeta.ts`** — already yields `hdr` (HDR10/HDR10+/DV/HLG). Add a `prefersLegacyEngine(meta)` helper: true when `hdr` indicates Dolby Vision or HDR10+ (where gpu-next d3d11 passthrough matters most).

### 2.4 If the user truly wants the HTML5 backend (NOT recommended — full inventory)
Would require, all new: `src/player/bridge.ts` (interface), `src/player/html5Bridge.ts` (port of the reference implementation's, ~670 lines), a subtitle parser (`src/subtitles/parser.ts` — Aura currently relies on mpv for sub rendering), add `hls.js` to `package.json`, a `videoMountRef` div in `PlayerOverlay`, and crucially **a way to hide the mpv child window when HTML5 is active** (the mpv child would otherwise paint over the `<video>`). On Aura that means stopping/destroying the mpv2 engine or the legacy child and ensuring the webview background stays transparent-but-now-shows-`<video>`. This fights Aura's entire transparent-webview/MPV-child model (CLAUDE.md landmines #5, #6). High risk, low payoff on Windows.

---

## 3. Ports 1:1 vs needs-adaptation

| the reference implementation piece | Verdict | Notes |
|---|---|---|
| `PlayerBridge` TS interface | **Skip** | Aura has no second backend to abstract over; `invoke("load_video"...)` directly is fine. Only introduce if HTML5 backend is approved. |
| `pickBridge` mpv-vs-html5 heuristic | **Re-purpose, not 1:1** | Becomes mpv2-vs-legacy selection (Section 2.3). The `notWebReady`/Linux/web branches are irrelevant to Aura. |
| `createMpvBridge` (mpv.ts) | **Already have it** | Aura's `lib.rs` + `mpv2/engine.rs` + legacy plugin path are the equivalent. No port. |
| `createHtml5Bridge` (html5/bridge.ts) | **Needs-adaptation, recommend skip** | Full new stack; fights transparent-webview model; thin benefit on Windows. |
| `use-auto-retry.ts` resilience chain | **Port (adapted)** | Drop debrid-failover + stremio-transcode tiers (no infra). Keep reload + watchdogs. **The recommended core deliverable.** |
| `mpv_set_clip_rects` | **Skip** | No-op on Windows even in the reference implementation. |
| stremio-server HLS transcode fallback | **Skip** | Aura has no stremio-server sidecar. |
| `transcode.rs` (ffmpeg re-encode) | **Skip** | Cast-server only; Aura has no casting. |
| Document PiP (html5/pip.ts) | **Skip (HTML5-only)** | Cannot be done from mpv child; only the `<video>` engine supports it. Out of scope unless HTML5 lands. |
| `mpv_probe` availability gate | **Partial** | Aura's `player.rs::check_mpv_dll` already pre-flights the DLLs; reuse it if a selection fallback is wanted. |

---

## 4. Phased build plan

> Default scope = the two recommended pieces (resilience chain + HDR-aware mpv2/legacy selector). HTML5 backend is an optional Phase X, gated on a user decision.

### Phase A — Error classification on the Rust event channel (prereq, S)
- `src-tauri/src/mpv2/engine.rs` — in `drain_mpv_events`, when `END_FILE` fires with a non-eof/non-stop reason, classify into `decode`/`network`/`source` and include `errorCode` in the emitted payload. Mirror for the legacy path in `lib.rs` `mpv-event-main` observer.
- `src/App.tsx` `usePlayback` — add `errorCode` to playback state from the event.
- **3-place registration: none** (no new command; reuses `playback-update`/`playback-end` events).
- Gate: `cargo check --message-format=short` + `pnpm exec tsc --noEmit`.

### Phase B — Resilience hook (core deliverable, M)
- New **`src/usePlaybackRetry.ts`** — adapted from `use-auto-retry.ts`: same-URL reload (one shot), black-screen watchdog (audio playing, `videoWidth/Height` 0 past grace — Aura gets `dwidth/dheight` via `get_tracks`/property), frozen-position watchdog (18 s / 75 s never-started), stuck-on-load watchdog. Honor CLAUDE.md landmine #3: **do not add polling that reads properties during state transitions**; gate every watchdog on `duration > 0` / `playbackReady`, reuse the existing snapshot stream rather than new `get_property` loops.
- `src/App.tsx` — wire a `playNextCandidate(attempt)` callback into the existing stream-picker/`handlePlayStream` flow (re-fetch streams already exists for the picker); pass `errorCode` + snapshot into the hook.
- **3-place registration: none** unless a new command is added (it isn't — reuses `load_video`).
- Gate: cargo check + tsc; HW smoke (force a bad stream, confirm advance).

### Phase C — Settings field + runtime engine override (M)
- `src-tauri/src/settings.rs` — add `player_engine: String` + `default_player_engine() -> "auto"`. Default struct + serde default.
- `src-tauri/src/mpv2/engine.rs` — add a process-global `ENGINE_MODE: OnceLock<AtomicU8>` (auto/render/legacy) and make `enabled()` honor it (env var still hard-overrides). Add `set_engine_mode(mode)`.
- New Tauri command **`set_player_engine(mode: String)`** in `lib.rs`.
  - **3-place registration (REQUIRED):** (1) `lib.rs` `tauri::generate_handler![...]`; (2) `src-tauri/permissions/player.toml` `commands.allow`; (3) `src-tauri/capabilities/default.json`.
- `src/views/SettingsView.tsx` — add a Player Engine selector (Auto / HDR-quality (legacy `--wid`) / Render-engine). Round-trips through existing `get_settings`/`update_settings`.
- Gate: cargo check + tsc.

### Phase D — Per-stream auto-selection + runtime engine swap (the hard part, L)
- `src/streamMeta.ts` — add `prefersLegacyEngine(streamMeta)` (true for Dolby Vision / HDR10+; configurable).
- `src/App.tsx` `handlePlayStream` — when `settings.player_engine === "auto"`, call `set_player_engine("legacy")` for DV/HDR streams else `"render"`, **before** `load_video`.
- `src-tauri/src/lib.rs` / `mpv2/engine.rs` — implement the **runtime teardown/standup**: if the requested engine differs from the running one, tear down the current (engine `shutdown_if_running` or legacy `shutdown_mpv_sync`), stand up the other (legacy needs `init_mpv`; render needs engine spawn + the `init_mpv`-skip + z-order `HWND_BOTTOM`), then `load_video`. This is where the risk lives — it exercises both shutdown paths repeatedly within one session, which today only run at boot/close. Honor landmine #9 (synchronous WASAPI release) and #10 (don't reparent).
- Gate: cargo check + tsc; extensive HW smoke (switch SDR↔DV streams back-to-back, watch for black screen / WASAPI lock / z-order inversion). **Provide `AURA_MPV2=0`/`=1` as the always-available manual override** so a broken auto-swap is never a dead end.

### Phase X (optional, gated on decision) — HTML5 backend (XL, not recommended)
Only if the user explicitly wants in-webview decode / Document PiP. Full inventory in Section 2.4. Must solve "hide the mpv child while `<video>` is active" without breaking the transparent-webview model.

---

## 5. Decisions the user must make

1. **HTML5 backend: build it or not?** On Windows-only Aura the marginal benefit is thin (mpv plays everything; no web build; no casting source today). The one unique win is Document Picture-in-Picture. Recommend **not** building it; keep Aura mpv-centric. (Mirrored in decisionsNeeded.)
2. **"Hybrid" = mpv-vs-HTML5 (the reference implementation's) or mpv2-render-vs-legacy-`--wid` (Aura-native)?** Recommend the latter — it reuses Aura's existing `AURA_MPV2` dual-engine machinery and directly serves the HDR/DV requirement, instead of introducing a new decoder stack.
3. **Auto-select trigger for HDR/DV → legacy `--wid`:** auto by stream metadata (DV/HDR10+ → legacy), a manual per-play toggle, or just a global setting? Auto is the the reference implementation spirit but Phase D (runtime engine swap) is the risk-heavy part.
4. **Resilience chain scope:** keep all watchdogs (black screen, frozen, stuck) or only error-driven reload + next-candidate? Debrid-failover and stremio-transcode tiers are **dropped regardless** (no infra in Aura).
5. **Default engine for HDR/DV per Aura's own finding:** confirm that legacy `--wid` (`AURA_MPV2=0`) remains the *required* path for true HDR/DV passthrough until the DXGI-interop work lands. The render engine cannot do gpu-next/scRGB HDR today (it's hardcoded to `gl_video`). This is the crux of the user's MUST-keep-`--wid` requirement and the spec assumes it.

---

## 6. Effort + risks

**Effort:** Phase A = S, Phase B = M, Phase C = M, Phase D = L, Phase X (HTML5) = XL. Recommended path (A+B, optionally +C) is **M overall**; full HDR-aware auto-swap (A–D) is **L**; HTML5 backend pushes it to **XL**.

**Risks:**
- **Runtime engine swap (Phase D)** is the dominant risk: tearing down/standing up legacy `--wid` vs mpv2 mid-session exercises shutdown paths that today only run at boot/close. Failure modes: black screen (z-order inversion / init_mpv-skip wrong), WASAPI device lock if shutdown isn't synchronous (landmine #9), MPV-behind-UI if Mica reapplied (landmine #5). Mitigation: keep `AURA_MPV2` env override as the unbreakable escape hatch; default `player_engine` to a single static engine and treat auto-swap as opt-in.
- **HTML5 backend vs transparent-webview model**: a `<video>` element competes with the mpv child surface; hiding mpv while keeping the shell transparent is exactly the fragile area CLAUDE.md warns about (landmines #5/#6). High.
- **Resilience watchdog re-introducing property-poll races** (landmine #3): the port must consume the existing snapshot stream, not add `get_property` loops. Medium; well-understood.
- **No stremio-server / ffmpeg in Aura** means the reference implementation's most powerful recovery tiers (HLS transcode, debrid failover) can't be ported — Aura's chain is strictly weaker than the reference implementation's. Acceptable, documented.
- **serde rename gotcha** on the new `player_engine` field flowing Rust→React (CLAUDE.md) — use plain snake_case or `rename(deserialize=...)`. Low.

## 7. Genuine quick win
**Phase A + the same-URL-reload slice of Phase B** is a real, self-contained quick win: classify `decode`/`network`/`source` on the existing event channel and, on an early error, re-issue `load_video` once before giving up. No new Tauri command, no 3-place registration, no engine changes, no UI — pure hardening that reduces "stream just fails silently" today. Implementable now with zero user input.

---

## Decisions needed from the user

1. HTML5 <video> backend: build it or not? Recommend NOT — Windows-only Aura gets thin benefit (mpv decodes everything, no web build, no casting); only unique win is Document Picture-in-Picture. Keep Aura mpv-centric.
2. Define 'hybrid' for Aura: reference-style mpv-vs-HTML5, OR Aura-native mpv2-render-engine vs legacy-`--wid`-mpv? Recommend the latter — reuses Aura's existing AURA_MPV2 dual-engine machinery and directly serves the HDR/DV requirement.
3. If auto-selecting engine by HDR/DV: trigger via stream metadata (DV/HDR10+ -> legacy --wid), a manual per-play toggle, or a global setting only? Auto is the reference implementation's spirit but the runtime engine-swap (Phase D) is the risk-heavy part.
4. Resilience chain scope: keep all watchdogs (black-screen, frozen-position, stuck-on-load) or only error-driven reload + next-candidate? Note: the reference implementation's debrid-failover and stremio-server HLS-transcode tiers are dropped regardless (Aura has no stremio-server sidecar / ffmpeg player path).
5. Confirm legacy `--wid` (AURA_MPV2=0) must remain the required path for true HDR/Dolby Vision passthrough until the deferred DXGI-interop work lands — the mpv2 render engine is hardcoded to gl_video and cannot do gpu-next/scRGB HDR today. The spec assumes this.

## Risks

- Phase D runtime engine swap (legacy --wid <-> mpv2) exercises shutdown/standup paths that today only run at boot/close: risks black screen (z-order/init_mpv-skip), WASAPI lock if not synchronous (landmine #9), MPV-behind-UI (landmine #5). Keep AURA_MPV2 env var as unbreakable escape hatch; make auto-swap opt-in.
- HTML5 <video> backend competes with the mpv child surface; hiding mpv while keeping the shell transparent fights Aura's transparent-webview/MPV-child model (landmines #5/#6). High risk, low payoff on Windows.
- Resilience watchdog port must consume the existing playback-update snapshot, NOT add get_property polling, or it re-introduces the STATUS_ACCESS_VIOLATION property-race (landmine #3).
- Aura has no stremio-server sidecar and no ffmpeg player path, so the reference implementation's strongest recovery tiers (HLS transcode, debrid failover) cannot be ported — Aura's resilience chain is strictly weaker. Acceptable but worth stating.
- New player_engine setting flows Rust->React; apply CLAUDE.md serde rename(deserialize) gotcha (use plain snake_case field or deserialize-only rename) so Tauri's outgoing JSON matches the TS interface.
