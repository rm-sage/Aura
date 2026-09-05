# Restoring from minimize / tray has no visible animation

**Date:** 2026-09-03
**Question:** Restoring Aura from the taskbar button or the tray icon looks sudden and jarring, with no clean animation. Can it be fixed?
**Status:** RESOLVED, and the answer is "not by fixing the animation". The OS animation runs correctly and Aura's window is in it. What is missing is CONTENT: Aura's first painted frame lands after the animation has already ended, so the user sees a terminal pop instead of a zoom. Four confident hypotheses (two of them mine) were killed by controlled A/B along the way and are recorded below so nobody re-runs them.

---

## The measurement

A frame-capture harness recorded the screen through a real restore of `aura.exe`:

| time | on screen |
|---|---|
| 121 ms | `SW_RESTORE` issued |
| 193, 222 ms | nothing |
| 258, 296 ms | an empty near-black full-screen rectangle, no UI |
| ~330 ms | the OS restore animation completes |
| 357 ms | the complete UI appears, in one step |

Firefox is the control that isolates the mechanism. Firefox shows a **visible mid-grey rectangle at 213 ms**, at partial size, with no page content in it. Firefox has exactly the same late-content behaviour Aura does. Its blank body is simply opaque and high-contrast, so a human reads the scaling rectangle as an animation. Aura's equivalent frame is a near-black rectangle scaling across a dark desktop, which is invisible.

The user's own independent description, chosen blind from four options in a control test against Explorer, was: *"Both animate, Aura's is just rougher."* That matches the capture exactly.

## Why Aura's animating frames are empty

Three deliberate design choices compound. None is a bug, and none should be "fixed" in isolation.

1. **The top-level window owns zero opaque pixels.** `transparent: true` in `tauri.conf.json` is what lets the mpv child show through. Concretely: blur-behind with per-pixel alpha, a NULL class brush, and the mpv host wndproc doing `BeginPaint` / `EndPaint` with no GDI work. DWM has a live surface to scale, but until WebView2 paints there is nothing in it.
2. **WebView2's first post-restore frame is late**, and the whole restore burst takes Aura's UI thread ~100 ms to clear (see the latency section below).
3. **Every theme's `--ln-bg` is invisible against a dark desktop.** Verified in `src/App.css`: `transparent` (line 42, deliberately, "lets Mica show through"), `rgba(10, 12, 18, 0.45)` (77), `#000000` (109, "pure black for OLED"), then `#100c08`, `#0a1310`, `#110a0e`, `#0c0a14`, `#08101a`, `#120e08`, `#140809`, and `#000000` again (307, 330). Max channel value across the whole palette is `0x14`. Even the fallback fill would be a near-black rectangle.

`.aura-app-shell` is additionally forced `background: transparent !important`, including under `.playing-video`.

## Refuted by A/B, not by argument. Do not re-run these.

- **Transparency does not disable the animation.** A transparent window *with content* animates identically to an opaque one. Transparency is why the animating frames are empty, not why the animation is missing (it is not missing).
- **DWM is not animating a stale pre-minimize snapshot.** It animates the live surface.
- **Mica is not a lever here.**
- **Supplying an iconic bitmap does nothing.** With both `DWMWA_HAS_ICONIC_BITMAP` and `DWMWA_FORCE_ICONIC_REPRESENTATION` set, DWM never even sent the corresponding messages, because it already holds a pixel-perfect 3440x1392 representation of the window. This is visible from the UI side too: while Aura sits in the tray, hovering the taskbar button shows Aura's full live UI.
- **A GDI `PrintWindow` returning black proves nothing.** `PrintWindow(hwnd, dc, 0)` on Aura returns a 1-colour bitmap and `PW_RENDERFULLCONTENT` returns 763 colours, which looks like a smoking gun and is not: every Chromium and Electron app on the machine prints black at flags=0 and still animates and still shows live taskbar thumbnails. This one nearly shipped as the root cause.
- **The environment is stock and correct.** `MinAnimate=1`, `VisualFXSetting` unset, DWM composition on, Aero Peek on, `UserPreferencesMask` stock apart from cursor shadow, `DWMWA_TRANSITIONS_FORCEDISABLED=0`, `GetWindowRgn=0`. Live styles are `GWL_STYLE=0x15CF0000` (WS_CAPTION, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_SYSMENU, WS_THICKFRAME, **no** WS_POPUP) and `GWL_EXSTYLE=0x00040110` (**no** WS_EX_LAYERED, **no** WS_EX_NOREDIRECTIONBITMAP).

On that last point: tao keeps `WS_CAPTION` for undecorated top-level windows on purpose. The decoration strip in `to_window_styles()` only runs inside the `CHILD` branch; borderless is achieved through `WM_NCCALCSIZE` (`event_loop.rs:2124`). This is **not** the classic Electron frameless-`WS_POPUP` case, and Aura's window is **not** missing a redirection bitmap: Tauri never calls `with_no_redirection_bitmap`, so `attributes.transparent` takes the `DwmEnableBlurBehindWindow` path (`window.rs:1284`) and the redirection bitmap is retained.

## Remedies considered and rejected

- **Paint an opaque iconic fill.** Forces a choice between an invisible near-black rectangle (no better than today) and a grey flash that fights the OLED-first design the whole palette exists to serve.
- **A CSS content-level fade.** Does literally nothing during playback, because the shell is forced transparent there.
- **`WS_EX_NOREDIRECTIONBITMAP`.** Not available in the pinned Tauri, and it risks the transparent-swapchain failure mode that would land exactly on the mpv child.

## The restore-latency finding, and the dwell effect that explains the perception

A cross-process `ShowWindow(SW_RESTORE)` is an inter-thread send: it returns only once the target thread has drained the resulting message burst. So the caller's block time is a direct measure of how late the window is.

**Read the within-run numbers only.** Absolute figures on this machine drift substantially between runs (Firefox measured 61.6 ms avg in one session and 38.5 ms in another an hour later, unchanged). Every conclusion below therefore comes from an interleaved A/B inside a single run, never from comparing one run against another. An earlier draft of this document compared Aura at 98.0 ms against Firefox at 61.6 ms across two separate runs and called Aura a 1.6x outlier; that comparison was not sound and is withdrawn.

### Dwell is the dominant variable, and it is Aura-specific in magnitude

How long the window sits minimized changes how fast it restores. Interleaved 1 s and 45 s dwells, alternating within one run so machine drift cannot masquerade as the effect:

| window | 1 s dwell | 45 s dwell | delta |
|---|---|---|---|
| Aura | 60.8 ms | 125.0 ms | **+64 ms** |
| Firefox | 38.5 ms | 47.7 ms | +9 ms |
| Telegram (opaque native) | 5.3 ms | 19.1 ms | +14 ms |

Every app degrades after a long minimize, so the mechanism is at least partly the OS (working-set trimming, DWM releasing resources for a long-hidden window). What is Aura-specific is the SIZE: +64 ms against +9 ms for the nearest comparable. The 45 s numbers were also tight (122.5, 129.0, 123.5), which says a deterministic state change rather than load noise.

The effect reproduced in three independent runs. Discarding each run's first measurement as an app-startup artifact, the 1 s / 45 s pairs were 60.8 / 125.0, then 86.6 / 131.5, then 88.9 / 131.5.

**This is very likely what the user was actually reporting.** A recently-used Aura restores in ~60 ms and looks fine; one that has been sitting in the tray for minutes takes ~125 ms and lands its content after the animation has ended. That accounts for "it looked bad when I first noticed it" and "it looks passable now" without needing anything to have changed on the machine at all.

### Where the time goes

`src-tauri/src/win_probe.rs` (a `SetWindowSubclass` on the main wndproc, dev-only, armed with `AURA_WIN_PROBE=1`) measures it from the inside:

- **Aura's Tauri window-event callback: 0.0 - 0.8 ms.** The leading hypothesis was that `LAST_MAXIMIZED.swap(maxi) != maxi` fires `save_window_state`, a synchronous disk write, during the restore. It fired on **one restore out of six** and cost **0.8 ms**. That hypothesis is dead.
- **The whole wndproc chain is busy 38 - 41 ms** across ~14 messages, dominated by the top-level `WM_PAINT` at **25.7 - 28.7 ms**, with `WM_SIZE` and `WM_WINDOWPOSCHANGED` around 5 ms each.
- **The remaining ~60 ms is gaps between messages** - win32k and DWM, with no Aura frame on the stack.

So there is no hotspot in Aura to delete. The residue is the cost of a transparent WebView2 top-level: the same architecture that makes the animation invisible in the first place.

### The WebView2 runtime update: tested, no effect

The evergreen WebView2 runtime went **151.0.4129.107 -> 152.0.4191.53 on 2026-09-02 07:59**, between the original report and the follow-up observation that production now looks fine. Given the measured mechanism is "WebView2's first post-restore frame is late", that was a strong candidate.

It was testable without touching the machine's install: both versions were still on disk, and `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` pins the runtime per-process. Same Aura binary (release v2.0.1), same dwell protocol, first round of each discarded as startup:

| runtime | 1 s dwell | 45 s dwell |
|---|---|---|
| 151.0.4129.107 | 86.6 ms | 131.5 ms |
| 152.0.4191.53 | 88.9 ms | 131.5 ms |

**No difference.** The runtime update does not explain the change in restore latency. It remains possible that 152 paints its first frame sooner without changing the wndproc block time, which would be perceptible while being invisible to this metric, but that is unmeasured and should not be asserted. The NVIDIA driver on the machine is 32.0.16.1656 dated 2026-08-19, which predates the original report, so it cannot account for a change that happened after it.
## What shipped alongside this investigation

Two changes, and **neither one fixes the animation**. Do not describe them that way in a commit message or release note.

- `tray.rs::show_main_window` now minimizes before hiding to tray, and restores with `show()` **then** `unminimize()`. The order is load-bearing: tao's `WindowFlags::apply_diff` applies the whole flag diff in one pass and ends with an *unconditional* `SW_HIDE` when the new flags lack `VISIBLE`, so `unminimize()` first would `SW_RESTORE` and then immediately re-hide. Justification is consistency and correctness: the old order left the tray path structurally unable to animate at all, unlike the taskbar path.
- `mpv::engine::wake_and_resync` unparks the geometry pump and forces one visibility re-detect plus one geometry pass on restore. Justification is that the pump is otherwise asleep on a 150 ms `HIDDEN_TICK` and its geometry pass is **edge-triggered on a changed rect**, so a same-size restore issued no `SetWindowPos` at all. Measured working: `parent visibility -> foreground` at 10:42:15.610, `forced geometry resync after restore (3440x1356)` at 10:42:15.614.

One earlier claim about the second change was **overstated and is withdrawn**: that it fixes a latent loss of the windowed MPO-poison region on a same-size restore. The forced pass does re-run `resize_mpv_child_to_parent`, which does re-apply the region, but a child window's region normally survives a minimize and it was never established that the region was being lost. The pump-wake latency argument stands on its own; the MPO one does not.

## Conclusion

There is no misconfiguration to correct, no upstream bug to file, and no tao / Tauri / wry issue for this symptom. The restore animation is working; Aura is simply an empty dark rectangle for the duration of it, because it is a transparent window over a near-black palette whose content arrives ~27 ms after the animation ends. Accepting that is the right call.
