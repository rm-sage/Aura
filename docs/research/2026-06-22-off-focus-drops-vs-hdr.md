# Off-focus frame drops vs. HDR/Dolby-Vision passthrough — feasibility research

**Date:** 2026-06-22
**Question:** Can Aura's off-focus frame drops be **completely eliminated** *without* sacrificing HDR / Dolby Vision / advanced video playback?
**Status:** Research complete. Verdict below. No code changes made.

---

## CORRECTION (2026-06-22, later same day) — supersedes the mechanism and verdict below

The user measured the live present mode with PresentMon: Aura reads **"Hardware Composed: Independent Flip"** (Present Runtime DXGI) **100% of the time, whether focused or not.** That empirically refutes this report's central premise. A re-investigation (adversarially verified) concluded:

**1. The "permanently Composed: Flip / DWM-throttled" mechanism is FALSE on this hardware.** "Hardware Composed: Independent Flip" is Multiplane Overlay (MPO): the mpv D3D11 swapchain is on its own dedicated hardware overlay plane, scanned out by the display controller, and is NOT being composited frame-by-frame by DWM. The original analysis quoted the Microsoft DirectFlip doc but omitted its third clause: when other content (the translucent WebView2) sits on top, DWM can "transition back to composed mode, reverse-compose, OR **leverage MPO to maintain the independent flip mode**." With 2+ overlay planes (standard on modern discrete GPUs), the video holds one hardware plane and the UI is alpha-blended on another at scanout. So Section 1a below is wrong for the single-primary-monitor MPO case, and the fixes that targeted DWM composition (the DWMfix keep-alive, the DirectComposition rearchitecture, "Optimizations for windowed games") are pointless here: there is no composed-surface clock in the video's path to keep alive.

**2. This is HDR-safe by construction.** MPO / Independent Flip is the same own-the-swapchain regime that makes `target-colorspace-hint` (HDR/DV passthrough) work. Nothing about staying on this path threatens HDR.

**3. Strongest remaining cause (HDR-safe, app-fixable): mpv's own off-focus retiming, upstream of Present.** Aura pins `display-fps-override` to a static Hz and forces `video-sync=display-resample` when motion interpolation is on. mpv's D3D11 vsync feedback (`IDXGISwapChain::GetFrameStatistics`) returns `DXGI_ERROR_FRAME_STATISTICS_DISJOINT` (or stale zeros) on mode/plane/focus transitions and is documented unreliable in multi-monitor setups. display-resample then retimes against a clock that disagrees with the real present cadence and drops/dupes frames. This is produced INSIDE mpv (so it is invisible to PresentMode, fully consistent with a steady "Independent Flip" reading) and it explains the asymmetry this report itself recorded: interpolation/display-resample ON drops 20 to 60 fps, while `video-sync=audio` drops only 6 to 8 fps. A GPU power downclock cannot produce that mode-selective asymmetry (it would degrade audio-sync playback too), so it is at most a secondary contributor. mpv issues #11122 and #15891 (+2 delayed frames per focus switch, NVIDIA, d3d11-specific) are precedents.

**4. Candidate fix (no HDR risk, no architecture change):** when the window is backgrounded, stop pinning a static `display-fps-override` and fall back to `video-sync=audio` (drop interpolation), gated on the existing presence/visibility telemetry, then restore `display-resample` on refocus. This plausibly removes the heavy off-focus burst entirely while leaving `--wid` + `vo=gpu-next` + `d3d11` + `target-colorspace-hint` untouched.

**5. Revised verdict: MORE OPTIMISTIC.** The pessimistic "needs exclusive fullscreen, HDR-risky, PARTIAL" conclusion was a consequence of the wrong premise. Full elimination of the SEVERE off-focus drops with HDR intact is now plausible and app-controllable. The honest caveat: a residual few-fps jitter from background CPU/GPU scheduling and transient MPO re-evaluation may remain and is not fully app-controllable, and the clean result depends on monitor config (primary-monitor MPO, no driver background-FPS cap).

**6. Two real downgrade triggers to keep in mind** (distinct from plain unfocus): full **occlusion** of Aura's pixels by an opaque window revokes the overlay plane (re-enters DWM compose for those intervals), and on some Win11 24H2 + multi-monitor + driver combos MPO is **primary-monitor-only**, so Aura on a secondary display can fall to Composed: Flip. If the user's drops happen specifically when occluded or on a secondary monitor, the old mechanism partially re-applies for those cases.

**7. Decisive next measurement (before committing a fix):** capture a per-frame PresentMon CSV of `aura.exe` during a reproduced drop (columns: ProcessID, SwapChainAddress, PresentMode, Runtime, msBetweenPresents, msBetweenDisplayChange, Dropped, AllowsTearing, SyncInterval) AND mpv's own stats (frames-dropped, vo-delayed-frame-count, estimated-display-fps, any "DISJOINT"/"Assuming N fps" log lines) AND GPU core clock. Three outcomes disambiguate: (a) PresentMode flips to Composed: Flip correlated with drops -> transient MPO demotion (keep-MPO-eligible / OverlayMinFPS); (b) PresentMode stays Independent Flip, mpv also reports the drops -> mpv retiming (the fix in #4); (c) msBetweenPresents steps to a round cap (16.6/33.3/50 ms) and GPU clock drops -> driver background-FPS cap / P-state (ship an aura.exe driver profile).

Everything from "Executive summary" onward is the SUPERSEDED original analysis, kept for the record.

---

## Executive summary

**Short answer: PARTIAL — and "completely eliminated for the windowed/backgrounded case while keeping HDR" is NOT cleanly achievable with any shippable technique today.** The drops can be *mitigated substantially and cheaply* while preserving HDR/DV, and can be *completely* eliminated only in true exclusive fullscreen (which is incompatible with the overlay UI and risks the HDR path). There is **no Windows API that tells DWM to keep compositing an occluded/background composed window at full rate** — DWM owns that policy for composed surfaces, and Aura's surface is *permanently composed* because a translucent WebView2 sits on top of the video plane. That is a structural property of the architecture, not a tunable.

**The single best path** is a **layered mitigation stack** (all HDR-safe, low risk), tried in order:

1. Disable WebView2/Chromium occlusion throttling (`--disable-features=CalculateNativeWinOcclusion`) — removes the UI/JS-stall half and a known blank-overlay hazard. Cheap, safe, ship-now.
2. Confirm the mechanism with **PresentMon** (prove it's "Composed: Flip" being down-clocked when backgrounded), then test whether the Win11 "Optimizations for windowed games" registry toggle ever promotes the video plane to MPO/Independent Flip under the overlay on real hardware.
3. A **DWMfix-style composition keep-alive** (an imperceptible always-animating surface that prevents DWM from entering its low-rate/low-power idle composition state) — the only generally-applicable mitigation that targets the DWM composition throttle directly without exclusive FS. Heuristic, not guaranteed, small power cost.
4. mpv buffering/pacing tuning (`--video-sync=display-resample`, deeper `--swapchain-depth`) to ride out transient composition dips.

**The "nuclear" complete fix** — an exclusive-fullscreen-only-when-fullscreen hybrid — is the *only categorical cure* but is high-risk: it requires reparenting the mpv child to a top-level swapchain (the exact move CLAUDE.md landmine #10 says made video disappear), fights the focus-loss-auto-minimize semantics that *define* the problem, and its HDR survival through that reparent is unverified.

**On the critical re-examination of the "render API can't do HDR" belief:** The belief was **correct when made and remains correct for shippable mpv today**, but it is being overturned upstream *right now*. As of June 2026, mpv PR **#17764** adds `MPV_RENDER_API_TYPE_D3D11` — a render-into-host-texture backend where **the caller owns and presents the swapchain** (which would let Aura put the video in its own Independent-Flip/DComp swapchain and thereby escape the throttle). It is **unmerged**, rough, and — decisively — **mpv maintainer kasper93 explicitly states "for d3d11 on Windows, window embedding may be better solution. Render api is limited."** Worse for the HDR question: `target-colorspace-hint` (the magic that makes HDR/DV "just work" today) **only functions when mpv owns the swapchain**; in a host-texture model, Aura would have to manually own `IDXGISwapChain3::SetColorSpace1` + `IDXGISwapChain4::SetHDRMetadata` and do per-title SDR/HDR switching itself, with **no Dolby Vision passthrough**. So the original revert was right, and adopting the render API to fix the throttle would *trade away the automatic HDR pipeline*, not preserve it.

---

## 1. Validated mechanism of the drops

There are **two independent throttle vectors**. Separating them matters because the fixes differ.

### 1a. The dominant one: DWM "Composed: Flip" composition-rate throttling

- Aura's mpv child is a DWM-**composed** surface, never on an Independent-Flip / hardware-overlay (MPO) path, **because a transparent WebView2 is alpha-blended on top of it**. Microsoft's flip-model guidance is explicit that *anything composited on top* forces DWM back to composed mode: *"If other desktop contents come on top, the DWM can either seamlessly transition back to composed mode, efficiently 'reverse compose' the contents on top of the application before flipping it, or leverage MPO to maintain the independent flip mode."* The transparent webview is, by construction, permanent "desktop content on top."
- When the process is **not the foreground/active composition target**, DWM down-clocks the composition cadence of that composed surface (the "30 FPS"/`OverlayMinFPS` throttle and the secondary-monitor power throttle). mpv keeps decoding and presenting at full rate, but DWM **samples the swapchain to screen less often**, so frames are dropped *at the compositor*, not at the app. This is the canonical "DWM falls back to 30 FPS, drop-every-other-frame" behavior documented in Mozilla bug 1065233 and worked around by DWMfix ("prevents the OS from putting the rendering layer into a low-power, low-refresh state").
- **This is a composition-scheduling throttle, not a `Present`-blocking one** — which is *exactly why the existing CPU mitigations (EcoQoS opt-out, ABOVE_NORMAL priority, `timeBeginPeriod(1)`) do nothing*. They make mpv produce frames faster/steadier; the loss is downstream in DWM.

**Occlusion detection vs. foreground loss — what actually triggers it:**

- **Minimized:** not composed at all.
- **Fully occluded (covered by an opaque window):** DWM "can detect when a particular window is fully occluded and avoid wasting CPU and GPU resources composing for the window." Strongest skip.
- **Visible-but-not-foreground (second monitor, or backgrounded with pixels still visible):** the nasty middle case Aura mostly hits. This is **not** occlusion detection (pixels are visible) — it is **DWM's power/scheduling heuristic for non-active composition targets and per-output composition rate** (precisely what DWMfix targets). The trigger is **foreground/active-composition loss and per-output power state, not occlusion**, and it **does** apply to a visible window on a second monitor.

**Important DXGI detail that confirms the diagnosis:** with a **flip-model** swapchain (mpv's default, `--d3d11-flip=yes`), `Present` does **not** return `DXGI_STATUS_OCCLUDED` for a merely-covered window (only effectively when minimized). So there is no app-level occlusion signal to respond to and no `Present`-return-code handling that could fix it — corroborating that the loss is the composition-cadence throttle, not present rejection.

### 1b. The secondary one: Chromium/WebView2 native-window occlusion throttling

- WebView2 *is* Chromium. Chromium's Windows `CalculateNativeWinOcclusion` path decides a covered window is occluded and treats the page like a background tab — *"rendering stops, and js is throttled."* This does **not** drop mpv video frames (separate child HWND) but can stall the **React UI and any JS-driven playback bookkeeping** when backgrounded, and on some Chromium versions has produced blank/white content. It is independently disableable (see §3, mitigation 1).

### Corroboration from the codebase (ground truth)

Aura's own engine comments already encode this understanding and the failed prior attempts:

- `src-tauri/src/mpv/engine.rs` (~L1185): *"mpv's own DXGI swapchain opts out of the promotion (`SetFullscreenState(FALSE)`)… this host window carries no swapchain of its own, only mpv's child does."* The render-engine era's "1px FSO break" hack (to *avoid* MPO promotion dropping the WebView2 overlay) was removed on purpose — confirming overlay-vs-MPO is a known interaction.
- `engine.rs` (~L1398): `d3d11-output-mode=composition` *"was tried here… It is INCOMPATIBLE with `--wid`: composition mode calls CreateSwapChainForComposition with window=NULL and needs the embedder to create/size a DirectComposition visual… Do NOT re-add it without owning the DComp visual."* — This is the key constraint for the DComp option below.
- `engine.rs` (~L1040): the three-state visibility classifier (`Foreground` / `VisibleBackground` / occluded) is retained "as telemetry only" precisely to correlate off-focus drops with window state.

---

## 2. Ranked candidate solutions

| # | Approach | Eliminates drops? | Preserves HDR/DV? | Cost / risk | Key unknowns |
|---|----------|-------------------|-------------------|-------------|--------------|
| 1 | **Disable WebView2 occlusion** (`--disable-features=CalculateNativeWinOcclusion`) | Partial — fixes UI/JS stall + blank-overlay; **not** video drops | Yes (no video-path change) | Very low / very low | None significant |
| 2 | **DWMfix-style composition keep-alive** (in-process imperceptible animating surface while playing+backgrounded) | Possibly — directly targets the DWM idle/low-rate state | Yes (no video-path change) | Low / low-med (heuristic, power cost) | Whether it raises the *mpv child's* delivery rate vs only DWM's own clock — must verify with PresentMon |
| 3 | **mpv pacing/buffer tuning** (`--video-sync=display-resample`, `--swapchain-depth=3-4`) | No (smooths, doesn't stop throttle) | Yes | Low / low | Latency tradeoff; respects no-poll-during-transition landmines |
| 4 | **Win11 "Optimizations for windowed games" / MPO promotion under overlay** | Only if the video plane reaches MPO/Independent Flip — overlay usually disqualifies it | Yes when promoted | Low to try (registry/toggle) / low | Whether MPO ever keeps the video plane independent under a translucent overlay on mainstream GPUs — hardware/driver dependent, not forceable |
| 5 | **DirectComposition rearchitecture** (mpv `display-swapchain` → host `IDCompositionVisual`, video visual below WebView2 visual) | Likely for per-child-window throttle; **maybe not** for whole-top-level-window throttle | Yes (composition flip swapchain is first-class HDR) | **High** / high — replaces `--wid` model; needs WebView2 **visual hosting** (wry uses *windowed* hosting — fork/patch required) | Does a DComp visual escape the *whole-window* background throttle? No primary source guarantees it. **Must prototype.** |
| 6 | **libmpv render API, host owns swapchain** (`MPV_RENDER_API_TYPE_D3D11`, PR #17764) | Yes in principle (host can use Independent-Flip/DComp swapchain) | **Degraded** — no `target-colorspace-hint`; host must own `SetColorSpace1`+`SetHDRMetadata` + manual per-title SDR/HDR switch; **no DV passthrough** | **Very high** / very high — unmerged upstream PR; maintainer says "window embedding may be better; render api is limited" | Merge timeline; whether HDR survives the host-texture split in practice |
| 7 | **Exclusive-fullscreen hybrid** (true `SetFullscreenState(TRUE)` only when fullscreen + overlay hidden) | **Yes** — DWM disabled for that output (only categorical cure) | Theoretically yes; **unverified** through mpv's render path | **Very high** / very high — reparent = CLAUDE.md landmine #10 ("video disappeared"); auto-minimize on focus loss happens *exactly when* the fix is needed; black-flash mode switches on every overlay interaction | Does mpv's gpu-next HDR survive an exclusive reparented swapchain at all? |

---

## 3. Recommended path

**Adopt the layered mitigation stack (items 1-4), in this order, gated on `playing && !foreground`. Do NOT start with the rearchitectures (5-7).** This preserves HDR/DV completely (none of 1-4 touch mpv's `--wid` + gpu-next + `target-colorspace-hint` pipeline) and is reversible.

### Mitigation 1 — Disable WebView2 occlusion throttling (ship now)
- Pass `--disable-features=CalculateNativeWinOcclusion` to WebView2 additional browser args.
- In a Tauri/wry app this is the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var set **before** the webview is created, or wry's `additional_browser_args` builder option. Set it during `lib.rs` setup before the window is built.
- Effect: stops Chromium from throttling the React UI / JS playback logic and bookkeeping when Aura is backgrounded, and removes the known blank-overlay-on-occlusion hazard. **Does not** by itself stop video drops, but removes a confound and a real UX bug. HDR-safe, near-zero risk.

### Mitigation 2 — Measure with PresentMon (do this before 3-7)
- Run Intel **PresentMon** against the mpv child while Aura is backgrounded / on a second monitor.
- Confirm the present mode reads **"Composed: Flip"** and that the *composed/displayed* rate drops on alt-tab while mpv's produced rate stays high (this proves §1a). Optionally set `HKLM\Software\Microsoft\Windows\Dwm\OverlayMinFPS = 0` as a one-off diagnostic — if drops vanish, the DWM composition throttle is definitively confirmed (not shippable, diagnostic only).
- While here, test the Win11 windowed-game-optimization toggle / registry (`HKCU\Software\Microsoft\DirectX\UserGpuPreferences\DirectXUserGlobalSettings = SwapEffectUpgradeEnable=1`) and watch whether the mpv child ever promotes to "Hardware Composed: Independent Flip" under the overlay. If it does on common hardware, that's a near-free structural win (item 4). If not, drop item 4.

### Mitigation 3 — Composition keep-alive (the real anti-throttle lever)
- Replicate the DWMfix heuristic *in-process*: a tiny, imperceptible, continuously-animating surface (e.g. a minimal continuous DComp animation, or a 1px layered window doing a sub-visible-threshold animation) that keeps DWM's composition clock out of its low-power/low-refresh idle state while Aura is playing and backgrounded.
- **Gate it strictly** to `playing && !foreground` to avoid the power cost when idle/foregrounded.
- **Verify with PresentMon** that it actually lifts the *mpv child's* delivery rate — it is possible it only keeps DWM's own clock hot without raising a specific composed surface's sample rate. This is the load-bearing unknown for this mitigation.

### Mitigation 4 — mpv pacing/buffer cushion
- Consider `--video-sync=display-resample` (smoother cadence under jitter than the default `audio`) and a deeper `--swapchain-depth` (3-4) so transient composition dips don't immediately starve playback — mirroring madVR's "present queue" mitigation.
- Respect existing buffer discipline and the no-`get_property`-polling-during-state-transitions landmines. These smooth, they do not cure.

### Belt-and-suspenders
- `DwmEnableMMCSS(TRUE)` for defense-in-depth scheduling jitter reduction (won't fix the throttle; HDR-safe; trivial).

**If and only if 1-4 are insufficient and the team accepts an mpv render-path rewrite**, revisit item 7 (exclusive-FS hybrid) for the *fullscreen* case only — but treat HDR-survival-through-reparent as a hard prerequisite to prove first, against landmine #10.

---

## 4. Explicit dead-ends (and why)

- **DWM/DXGI/MMCSS "stay hot while occluded" API — does not exist.** `DwmEnableMMCSS` (CPU thread priority for the DWM process, not composition rate), `DwmGetCompositionTimingInfo` (pure query, no side effect), `SetMaximumFrameLatency`/waitable swapchains (latency/queue depth, "graceful fallback when composed"), `MakeWindowAssociation`/`DXGI_MWA_*` (Alt+Enter handling only), `DXGI_PRESENT_DO_NOT_WAIT`/`_TEST`/`_RESTART` (queue management) — **none** change DWM's composition cadence for a composed occluded surface. Most are also mpv-internal (Aura doesn't own the swapchain). This is the central negative finding: DWM owns composed-surface cadence and exposes no override.
- **Independent Flip / MPO as a *reliable* fix — no.** A translucent window permanently on top forces composed mode; MPO *can* sometimes keep the video on its own plane, but promotion is a per-frame DWM/driver heuristic, hardware/driver dependent, widely user-disabled (the MPO-flicker bug), and **not programmatically forceable**. `DXGI_PRESENT_ALLOW_TEARING` affects latency, not the background composition throttle, and only matters if the plane is independently scanned out (which the overlay prevents).
- **`d3d11-output-mode=composition` with the current `--wid` model — incompatible.** It calls `CreateSwapChainForComposition` with `window=NULL` and requires the embedder to own a DComp visual; under `--wid` mpv's d3d11 ctx fails ("Failed to get height and width!") and falls back to an 8-bit SDR Vulkan path — **HDR breaks entirely**. (Aura already discovered and documented this in `engine.rs`.) It is only viable as part of the full DComp rearchitecture (item 5).
- **libmpv render API to "reach gpu-next/HDR" — re-examined, still the wrong trade.** Shipping mpv's render API exposes only `OPENGL` and `SW` types (`render.h`); the SW path's own header warns *"HDR may not work properly."* The D3D11 render backend (`MPV_RENDER_API_TYPE_D3D11`, PR #17764) and a gpu-next render backend (PR #16818) are **unmerged drafts as of June 2026**. Even when merged, `target-colorspace-hint` *does nothing* without mpv owning the swapchain (the new `mpv_d3d11_fbo` struct has no colorspace field; the hint's entire job is `SetColorSpace1` on the swapchain). The host would have to own all HDR metadata + per-title SDR/HDR switching, and **Dolby Vision passthrough is not achievable** this way. mpv maintainer kasper93: *"for d3d11 on Windows, window embedding may be better solution. Render api is limited."* The original revert to `--wid` + gpu-next was correct and remains correct.
- **Reparenting the mpv child to a top-level window (`SetParent(NULL)` + `WS_POPUP`) — known failure.** CLAUDE.md landmine #10: libmpv's render context didn't survive the reparent, video disappeared. Any exclusive-FS hybrid must solve this first.

---

## 5. Open questions needing a prototype to settle

1. **(Load-bearing) Does the keep-alive surface actually raise the mpv *child's* composed delivery rate, or only DWM's own clock?** Must be measured with PresentMon. If only the latter, mitigation 3 fails.
2. **Does a DComp visual escape the *whole-top-level-window* background throttle?** No primary source confirms it. If a backgrounded top-level window's entire visual tree (UI + video visual) is throttled, the DComp rearchitecture (item 5) won't save the video. Prototype must specifically test the *visible-but-not-foreground / second-monitor* case, which the docs do not cover.
3. **Does MPO ever keep the video plane independent under a translucent WebView2 on mainstream GPUs (NVIDIA/AMD/Intel)?** Hardware-dependent; PresentMon will answer per-GPU. Determines whether item 4 is a free win or a dead-end.
4. **Does mpv's gpu-next HDR survive an exclusive/reparented top-level swapchain at all?** Gates the entire exclusive-FS hybrid (item 7). Must be proven before any engineering investment, given landmine #10.
5. **wry windowed→visual hosting:** wry creates WebView2 via `CreateCoreWebView2Controller` (windowed hosting), not `CreateCoreWebView2CompositionController` (visual hosting). The DComp rearchitecture (item 5) — where the mpv swapchain visual sits *under* the WebView2 visual in one DComp tree — requires WebView2 visual hosting, i.e. a wry fork/patch. Cost of that fork is unscoped.

---

## Sources

### Aura codebase (ground truth)
- `src-tauri/src/mpv/engine.rs` — `--wid` embedding, `d3d11-output-mode=composition` incompatibility note (~L1398), MPO/FSO history (~L1185), visibility telemetry (~L1040), HDR init / `target-colorspace-hint` reasoning.
- `src-tauri/src/win32.rs` — EcoQoS opt-out, `SetPriorityClass`, `timeBeginPeriod(1)`.

### DWM / DXGI / composition mechanism
- For best performance, use DXGI flip model (DirectFlip/Independent Flip/MPO conditions, "DWM goes to sleep", reverse-compose, HDR not clamped): https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/for-best-performance--use-dxgi-flip-model
- DXGI flip model dev blog: https://devblogs.microsoft.com/directx/dxgi-flip-model/
- Composition swapchain programming guide (occlusion detection, compose vs scanout): https://learn.microsoft.com/en-us/windows/win32/comp_swapchain/comp-swapchain
- IDXGISwapChain::Present (DXGI_STATUS_OCCLUDED, DXGI_PRESENT_TEST): https://learn.microsoft.com/en-us/windows/win32/api/dxgi/nf-dxgi-idxgiswapchain-present
- DXGI_STATUS values: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/dxgi-status
- DXGI occlusion statuses: broken and a pain (flip vs bitblt occlusion reality, 2026): https://blog.yuo.be/2026/01/25/dxgi-occlusion-statuses-broken-and-a-pain/
- Proton: return DXGI_STATUS_OCCLUDED for minimised windows: https://github.com/Joshua-Ashton/proton-wine/commit/726b4edee8c1d0bbe5c0fc47133302972ee6f9a6
- DXGI Best Practices ("DWM is disabled" in fullscreen; MakeWindowAssociation): https://learn.microsoft.com/en-us/windows/win32/direct3darticles/dxgi-best-practices
- DwmEnableMMCSS: https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmenablemmcss
- DWM frame timing / DwmGetCompositionTimingInfo: https://learn.microsoft.com/en-us/windows/win32/dwm/frametiming-ovw
- DXGI_SWAP_CHAIN_FLAG (waitable object, fullscreen caveat): https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ne-dxgi-dxgi_swap_chain_flag
- Reduce latency with DXGI 1.3 swap chains: https://learn.microsoft.com/en-us/windows/uwp/gaming/reduce-latency-with-dxgi-1-3-swap-chains
- Mozilla bug 1065233 (DWM 30 FPS throttle, drop-every-other-frame): https://bugzilla.mozilla.org/show_bug.cgi?id=1065233
- DWMfix (composition keep-alive against low-power/low-refresh state): https://github.com/Arccalc/Dwmfix
- ForceComposedFlip (transparent topmost window forces composed flip): https://github.com/fernandoenzo/ForceComposedFlip
- PresentMon (verify present mode / composition path): https://github.com/GameTechDev/PresentMon
- Blur Busters: DWM throttles on alt-tab; MPO shows as Independent Flip in PresentMon: https://forums.blurbusters.com/viewtopic.php?f=10&t=14549

### HDR / Advanced Color
- Use DirectX with Advanced Color / HDR (CreateSwapChainFor[Hwnd|Composition|CoreWindow] = HDR-eligible; windowed FP16 composition; no clamp; SetColorSpace1 G2084): https://learn.microsoft.com/en-us/windows/win32/direct3darticles/high-dynamic-range
- IDXGISwapChain3::SetColorSpace1: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/nf-dxgi1_4-idxgiswapchain3-setcolorspace1
- IDXGIFactory2::CreateSwapChainForComposition (bind to IDCompositionVisual::SetContent): https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgifactory2-createswapchainforcomposition

### Windows 11 windowed optimizations
- Optimizations for windowed games (Microsoft Support): https://support.microsoft.com/en-us/windows/optimizations-for-windowed-games-in-windows-11-3f006843-2c7e-4ed0-9a5e-f9389e535952
- Toggle + registry (DirectXUserGlobalSettings / SwapEffectUpgradeEnable / SwapEffectUpgradeCache): https://www.elevenforum.com/t/turn-on-or-off-optimizations-for-windowed-games-in-windows-11.4943/

### mpv options & render API (the HDR re-examination)
- mpv manual / options.rst (d3d11-flip, d3d11-sync-interval, d3d11-output-format, d3d11-output-csp, swapchain-depth, video-sync, vo-mmcss-profile, target-colorspace-hint[-strict]): https://github.com/mpv-player/mpv/blob/master/DOCS/man/options.rst
- mpv render API header (only OPENGL + SW; SW "HDR may not work properly"): https://github.com/mpv-player/mpv/blob/master/include/mpv/render.h
- **PR #17764 — "libmpv: add D3D11 render API backend" (kasper93, OPEN, 2026-04; caller owns swapchain; "render api is limited, window embedding may be better"):** https://github.com/mpv-player/mpv/pull/17764
- `render_d3d11.h` (mpv_d3d11_fbo has only tex/w/h — no colorspace field): https://github.com/kasper93/mpv/blob/render_d3d11/include/mpv/render_d3d11.h
- PR #16818 — "vo_libmpv: introduce 'gpu-next' render backend" (DRAFT, 2025-09): https://github.com/mpv-player/mpv/pull/16818
- Issue #5979 — "d3d11 backend for the Render API" (design history): https://github.com/mpv-player/mpv/issues/5979
- Issue #15268 — target-colorspace-hint = swapchain colorspace negotiation; "Windows compositor does the tone-mapping": https://github.com/mpv-player/mpv/issues/15268

### mpv background / focus / MPO frame-drop reports
- #8475 Extreme frame drops when window is focused (NVIDIA G-Sync driver root cause): https://github.com/mpv-player/mpv/issues/8475
- #10626 MPO causing stutter in fullscreen: https://github.com/mpv-player/mpv/issues/10626
- #15891 Vulkan drops frames when switching the focused window: https://github.com/mpv-player/mpv/issues/15891
- #13765 Lots of frames dropping since 2024-03-22: https://github.com/mpv-player/mpv/issues/13765
- #11579 gpu-next overlay frame drops: https://github.com/mpv-player/mpv/issues/11579
- #8240 Dropped frames when entering fullscreen first time: https://github.com/mpv-player/mpv/issues/8240

### WebView2 / Chromium occlusion & hosting
- Windowed vs. Visual hosting of WebView2: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting
- ICoreWebView2CompositionController (visual/DComp hosting): https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2compositioncontroller
- wry uses CreateCoreWebView2Controller (windowed hosting), not composition controller: https://github.com/tauri-apps/wry/blob/dev/src/webview2/mod.rs
- Chromium Windows native window occlusion tracking ("rendering stops, js throttled"): https://github.com/chromium/chromium/blob/main/docs/windows_native_window_occlusion_tracking.md
- Disabling Chromium occlusion for embedders: https://groups.google.com/a/chromium.org/g/embedder-dev/c/ZF3uHHyWLKw
- Electron CalculateNativeWinOcclusion rendering fix: https://markaicode.com/electron-v28-rendering-issues-fixed/

### Other media players
- JRiver madVR Expert Guide (present queue / windowed overlay): https://wiki.jriver.com/index.php/MadVR_Expert_Guide
- madshi bug tracker (present queue not filling): http://bugs.madshi.net/view.php?id=443
- jellyfin-media-player #675 (Win11 fullscreen / Auto-HDR; Electron+mpv pattern): https://github.com/jellyfin/jellyfin-media-player/issues/675

---

## Confidence & caveats

- **HIGH:** No DWM/DXGI/MMCSS API forces full-rate composition of an occluded composed window; the throttle is real, power/foreground-driven, and is why CPU mitigations don't help.
- **HIGH:** `target-colorspace-hint` configures the *swapchain* and is unavailable when mpv doesn't own it; the libmpv render API (incl. the new D3D11 backend) is unmerged as of June 2026 and the maintainer recommends window embedding for D3D11 HDR. The original `--wid` + gpu-next revert was and is correct.
- **HIGH:** WebView2 occlusion throttling is real and cheaply disableable; this is the safest immediate win.
- **MEDIUM:** Whether a DComp keep-alive / DComp-hosted video visual actually defeats the *whole-top-level-window* background throttle in the visible-but-not-foreground case — **no primary source confirms it; prototype required.**
- **MEDIUM:** MPO promotion under a translucent overlay is hardware/driver dependent; must be measured per-GPU.
- Aura's exact topology (mpv child below a transparent WebView2, throttled on focus loss) is not documented in any single external issue — the mechanism is inferred from how Independent Flip + composed-mode throttling + Chromium occlusion provably work, cross-checked across Microsoft, mpv, Mozilla, and player-tracker sources.
