# Playback polish batch (2026-05-30) — status, findings & answers

Context: off-focus drops are fixed (framedrop=vo, confirmed on hardware) and
Phase 7 is conditionally approved once the 8 observations below are handled.
"DONE" items are staged (uncommitted); tsc green. The rest are answered or
have a precise proposed approach — they were NOT shipped blind because they
need on-hardware validation, are behaviour changes, or touch fragile code,
and you were away.

---

## ✅ DONE (staged, tsc green)

### 1. Remove 5× playback speed
`PlayerOverlay.tsx` — `SPEED_OPTIONS` now tops out at **4×** (was `…,4,5`).
Logs confirmed 5× on a 4K HEVC stream drops hundreds of frames/sec + A/V
desync; 4× is smooth. Comment added explaining why.

### 7b. Gate the "Detect" skip button to series/anime
`PlayerOverlay.tsx::SkipWindowButton` now takes `mediaType` and only offers
the silencedetect "Detect" affordance when `mediaType` is `series`/`anime`
(movies have no intro to skip). The auto "Skip OP/ED" jump already only
appeared when AniSkip windows exist, which movies never have — so no change
needed there.

### 8a. EOS Spotlight — remove the down-chevron by "Episodes"
`EosSpotlight.tsx` — dropped the `▼` SVG from the "Episodes" button in both
the NEXT-UP and END-CARD states (the panel slides in from the right, so a
down-arrow was misleading).

### 8b. In-playback episode-drawer handle now fades with the UI
`PlayerOverlay.tsx::EpisodeEdgeTrigger` — the right-edge handle was
"always-present"; it now fades opacity + drops pointer-events in lockstep
with `controlsVisible` (the control-bar auto-hide). Any pointer move wakes
the chrome and the handle together, so the drawer is still one gesture away.

---

## 💡 ANSWERS (no code needed)

### 4. GLSL shaders show no difference on non-anime
**This is expected — they're upscalers, and you tested on 4K content that's
being *downscaled* to your 3440×1440 panel.** FSRCNNX / FSR / ravu /
SSimSuperRes / KrigBilateral only do visible work when the source is
*smaller* than the target (luma/chroma upscaling). Interstellar is 3840×2160
→ downscaled to 1440p, so there's nothing to upscale and they're effectively
no-ops. Anime4K "works great" because anime is typically 1080p → *upscaled*
to your panel. To actually see these: play sub-native content (e.g. a 1080p
or 720p stream) on the ultrawide. They are being applied correctly (logs show
`glsl-shaders set …` with no error) — they just have no effect when
downscaling. *Optional polish:* the shader menu could label upscalers and
grey them out / show "no effect — source ≥ display" when the source resolution
≥ the display resolution (we have `video-params/w,h` available).

### 6. How to definitively verify HDR tone-map vs passthrough
Two parts — a how-to, and a likely-bug:

**How to check on the AW3425DW:**
- Turn **Windows 11 → Settings → System → Display → Use HDR = ON** (required
  for passthrough; without it the OS never accepts an HDR signal).
- Play a known-HDR title and toggle Aura's HDR mode between "Tone-map → SDR"
  and "Passthrough". In **Passthrough** the monitor should switch into its
  HDR mode — the AW3425DW's **OSD/Display-Info shows the HDR state** (and SDR
  desktop content visibly dims when the OS flips to HDR). In **SDR** mode the
  panel stays SDR. If the picture is identical between the two modes, HDR
  isn't reaching the display.
- The source side is already visible in logs (`csp: bt2020nc` = the file is
  HDR/BT.2020). What matters is the *output*.

**Likely bug / important finding:** the mpv2 engine presents through **WGL**,
which has **no HDR (PQ / scRGB float) swapchain path to the OS**. So under
mpv2, "Passthrough" very likely can't actually hand the display an HDR signal
— mpv is probably tone-mapping to SDR regardless of the setting. That would
explain "I can't tell when HDR is actually enabled" — because on the mpv2
engine it may always be SDR. Proper HDR passthrough needs the **D3D11 render
path** (already noted as the real HDR fix in the render-api memory). Action:
confirm with the toggle-test above; if the monitor never enters HDR mode on
mpv2 even with Windows HDR on, treat HDR passthrough as a **known mpv2/WGL
limitation** to fix via D3D11 after Phase 7. (Legacy `--wid` could pass HDR
because libmpv owned a D3D swapchain — worth A/B-ing with `AURA_MPV2=0`.)

---

## 🔍 NEEDS YOUR CALL / VALIDATION (analysis + proposed approach)

### 2. Hover-thumbnail: long initial load + same frame repeated
Code: native `extract_thumbnail` (Rust thumb libmpv instance — `player.rs`,
log line `thumb libmpv instance initialised`) + the scrubber resolver in
`PlayerOverlay.tsx` (~L2358-2450; already has the per-integer-second bucket +
`thumbUrlSec` stale-gate + cache). Likely causes:
- **Long initial load:** the thumb instance is cold and the first seek into a
  4K HEVC remux must demux + decode a keyframe — expensive. The engine
  "self-warms via retry" (per branch notes — do NOT remove that).
- **Same frame repeated:** keyframe-only seeking on a long-GOP 4K source
  returns the *same* keyframe for a range of nearby seconds, so consecutive
  hover positions resolve to one image.
Proposed (needs HW validation): decode thumbs at reduced resolution on the
thumb instance (e.g. a `scale` vf / smaller surface) to cut decode time; keep
the integer-second cache; accept keyframe granularity (or bucket the cache by
keyframe instead of second so it's honest about resolution). Worth profiling
`extract_thumbnail` timing first. Fragile area — recommend doing this with you
available to eyeball it.

### 3. Subtitle selection — ordering + inconsistent highlight
- **Ordering** ("installed-addon order, opensubtitles first if API key set"):
  the fan-out is `stremio::fetch_external_subtitles`. Proposed: sort the
  returned list by the position of each sub's source addon in the installed
  `addons` array; then, if the OpenSubtitles API-key setting is non-empty,
  float OpenSubtitles-sourced entries to the top. (Confirm where the key
  lives in settings.)
- **Highlight inconsistency:** the sub-track menu's "selected" indicator
  doesn't reliably match mpv's real `sid` after a switch. Likely the menu
  holds a local selected-id that drifts from mpv; it should reflect the
  authoritative `sid` (re-read on the `aura:tracks-refresh` event the
  track-mutating commands already fire). Needs a read of the sub-track menu
  in `PlayerOverlay.tsx` + `set_subtitle_track` to confirm the state source.
Both are doable but I'd rather verify the highlight fix live (selection state
bugs are easy to "fix" wrong).

### 5. Loudnorm volume spikes on seek (seen on legacy, not yet on mpv2)
The mpv2 filter is `@loudnorm:loudnorm=I=-23:LRA=7:TP=-2` (lib.rs ~574/599) —
the non-standard `dynamic=true` the legacy path used is **already dropped**.
But single-pass `loudnorm` is inherently adaptive (no measured I/LRA/TP), so
its gain re-converges after a seek and *can* still momentarily over-amplify.
You haven't reproduced it on mpv2 yet — please try (enable loudnorm, seek
around). If it recurs: mitigation options are (a) briefly ramp/duck volume
across a seek, (b) `af` remove+re-add to reset the filter cleanly on seek, or
(c) accept the ~2-3s self-heal. It's a known ffmpeg single-pass-loudnorm
limitation, not an Aura bug per se.

### 7a. Motion interpolation — gate to anime only?
**Answer:** it's a taste call, not clear-cut. Frame interpolation is the
"soap-opera effect" — on 24fps live-action most people dislike it, though
some want it for sports/smoothness; for anime it's the main use case (and
even there purists debate it on 2s/3s). Your logs also show interp ON for a
4K movie adding extra VO drops. **Recommendation: yes, gate it to anime** —
it's the defensible default and avoids the 4K perf cost. *Proposed:* gate the
in-player toggle (`PlayerOverlay.tsx` ~L3274) + the Settings toggle so they're
only enabled when the active target is anime (reuse `isAnimeMeta` on the
active target), and no-op the apply path otherwise. I held off because it's a
real feature-removal for non-anime and I couldn't validate the
anime-at-playtime detection without running it — say the word and I'll wire
it.

---

## Suggested order when you're back
Quick wins to finish: **3 (subtitle order + highlight)**, **7a (gate motion
interp)**. Then validate **5 (loudnorm seek)** and **2 (hover-thumb)** on
hardware. **6 (HDR/WGL)** is the one with real architectural weight — likely a
D3D11 follow-up. Once these are settled, Phase 7 is clear to land.
