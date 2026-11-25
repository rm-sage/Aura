---
paths:
  - "src-tauri/src/win32.rs"
  - "src-tauri/src/window_logic.rs"
  - "src-tauri/src/tray.rs"
  - "src-tauri/src/oauth_callback.rs"
  - "src-tauri/src/win_probe.rs"
  - "src/TitleBar.tsx"
---

# Fullscreen, minimize and tray restore

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/win32.rs, window_logic.rs, tray.rs, lib.rs window setup, src/TitleBar.tsx.

## Win32 fullscreen reality check

`win32::enter_native_fullscreen` is the canonical fullscreen path: Tauri's `setFullscreen` lands at
the work-area rect (taskbar showing through), not the full monitor. The Win32 path resolves the
monitor via `MonitorFromWindow`, `SetWindowPos` to its full `rcMonitor` (covers the taskbar area),
`SWP_FRAMECHANGED` + bring-to-front. Companion helpers in `win32.rs`:

- `resize_mpv_child_to_parent` dynamically loads user32, enumerates children, skips WebView2 hosts by
  class name (`Chrome_WidgetWin_*`, `Microsoft.UI.Content.*`, `Intermediate D3D Window`, `tauri_*`,
  `wry_*`), and resizes the remaining (mpv VO) child to the parent client area minus the title-bar
  inset.
- Windowed mode applies an MPO "poison" clip to the mpv child so it is disqualified from a hardware
  overlay plane and DWM-composites instead, which restores true black on OLED in windowed playback.
- `parent_display_refresh_hz` reads the monitor's real refresh from `DEVMODEW.dmDisplayFrequency`;
  `set_motion_interpolation` uses it to pin mpv's `display-fps-override` (an embedded `--wid` mpv
  cannot estimate refresh on its own).
- `apply_playback_perf_opts` (and `pin_process_scheduling`) clear Win11 EcoQoS execution-speed
  throttling + raise the process priority class. They NO LONGER pin `timeBeginPeriod(1)` for the
  process lifetime: 1 ms timer resolution is now demand-scoped to active playback via
  `win32::set_high_timer_resolution(bool)`, which the engine pump asserts while a file is loaded and
  releases when idle (so a menu-bound / tray Aura returns to the OS-default ~15 ms timer and idles
  deeper). It is ref-count-safe (one outstanding claim); do NOT re-pin `timeBeginPeriod(1)` at startup.

Note: the historical "off-focus frame drops" (worse with motion interpolation on) were NOT a DWM or
render-path limitation. They were root-caused to the NVIDIA Control Panel "Background Application Max
Frame Rate" setting misclassifying `aura.exe` as a background app and capping its frame rate when it
loses foreground. The fix is a per-app NVIDIA profile (or turning that global setting off); it is a
per-machine driver config, not an Aura bug, and needs no render rewrite. The opt-outs above and the
`display-fps-override` pin are sound but were never the fix for those drops.

The taskbar bleed-through on an "always show taskbar" setting is a Windows compositor heuristic limit:
auto-hide only triggers for users with "Automatically hide the taskbar" enabled. The `Shell_TrayWnd`
`SW_HIDE` workaround was tried and reverted (broke secondary-monitor tray icons). True DXGI exclusive
fullscreen would require a render rewrite and is deferred.

## Restore from minimize / tray: the animation runs, the content is just late

**Update, found later: the "tiny box flies to the corner" restore WAS an Aura bug, in three parts,
all fixed and runtime-confirmed (taskbar and tray both animate the real window now).**
1. The page shrank while minimized. The `unstable` Tauri feature (needed for `add_child`) builds the
   main webview as a CHILD webview, so wry attaches no parent resize handler and Tauri's auto-resize
   is the only thing sizing the page; it ran on the minimize `Resized` too, and a minimized
   borderless window reports its iconic 160x28 rect as client area (measured: `WRY_WEBVIEW`
   3440x1392 -> 160x28 inside the `SIZE_MINIMIZED` `WM_SIZE`). Setup turns auto-resize off and
   `window_logic::fit_main_webview` sizes the page on every resize EXCEPT a minimize.
2. A minimized window had a 160x28 CLIENT area, because tao's borderless `WM_NCCALCSIZE` also
   answers while iconic. `win32::install_iconic_frame_guard` hands `WM_NCCALCSIZE` to
   `DefWindowProc` while `IsIconic`, so a minimized Aura has no client area like any window.
3. THE ONE THAT MADE THE ANIMATION WORK: the restore stalled on the mpv engine thread. Its host
   window is a child of the main window owned by that thread, and a restore/show SENDS the child
   synchronous messages. The pump slept in `park_timeout` (150 ms `HIDDEN_TICK`), which does not
   wake for messages, so each send waited up to a tick; the OS animation then started with no
   restored frame and flew the minimized caption, and a tray restore took about a second. The pump
   now waits in `MsgWaitForMultipleObjects(QS_ALLINPUT)` and `wake_and_resync` posts `WM_NULL`.
   Cross-process `SW_RESTORE` dropped to 13-25 ms at both 1 s and 20 s dwell (was 60-125 ms).
   NEVER make a thread that owns a child of the main window sleep without a message wait.
The engine pump also holds its geometry while the parent `IsIconic`. The findings below were
measured with all three bugs present; the latency and "no hotspot" conclusions are superseded.

**Tray webview parking: every path that shows the main window must call
`window_logic::unpark_main_webview` BEFORE `show()` / `unminimize()`.** Hiding the window to the
tray hides only the native window, and WebView2 does not infer visibility from its host, so the
page kept producing frames for every running animation at the display refresh: measured in the
tray on Home, 48.5% of one core (renderer 45%); after parking, 0.2%. The close-to-tray branch sets
the controller's `IsVisible = false` through `with_webview` (NOT wry's `set_visible`, which also
`SW_HIDE`s the WRY_WEBVIEW container and would disturb the window tree the restore animation
relies on). It parks only when nothing in the page needs live timers (a hidden page's timers are
clamped): no file loaded (`set_media_loaded`, from `load_video` / `stop_video`), not in a
watch-together room (`set_party_keep_alive`'s `in_room`), not casting, no History scrobble run.
The restore sites today: `tray::show_main_window`, the single-instance handler in `lib.rs`, and
the OAuth landing in `oauth_callback.rs`. A new one that skips the unpark restores a window with a
page Chromium still thinks is hidden. Every park, unpark and re-park runs on the MAIN thread (the
OAuth landing is a tokio handler, so it does its whole unpark-show sequence in one
`run_on_main_thread` closure; otherwise a close-to-tray could park between its unpark and its
show and leave a blank window with no tray icon). A blocker that clears while the window is in
the tray (`stop_video`, leaving a room, the bulk scrobble run ending) calls
`repark_if_tray_hidden`, which parks then; `TRAY_HIDDEN` is cleared by the unpark, so a restore
always wins. Runtime-checked: each of those three re-parks drops the tray to 0.0-0.2% of a core.

The tray icon itself exists only while the window is hidden to the tray: `tray::set_tray_visible`
builds it on hide and queues its removal on restore (guarded by `TRAY_WANTED`). Never go back to
one long-lived icon toggled with `set_visible`: tray-icon's hide and its Drop are both `NIM_DELETE`,
so every exit from a visible window printed "Error removing system tray icon". The tray MENU
handler is registered once in `tray::install` through `app.on_menu_event`; a builder's
`on_menu_event` is appended to Tauri's app-wide listener list on every build and never removed.

Symptom, and it is real: restoring from the taskbar button or the tray icon looks sudden and
jarring, with no visible zoom. It is NOT a missing animation. Frame capture through a real restore:
`SW_RESTORE` at 121 ms, nothing on screen at 193 and 222 ms, an empty near-black full-screen
rectangle at 258 and 296 ms, the OS animation ends around 330 ms, and the complete UI appears in one
step at 357 ms. The user sees the terminal pop.

Three deliberate choices compound, and not one of them is a bug. (1) The top-level window owns ZERO
opaque pixels: transparency is what lets the mpv child show through (blur-behind per-pixel alpha,
NULL class brush, and the mpv host wndproc does BeginPaint/EndPaint with no GDI work), so DWM has a
live surface to scale but nothing in it until WebView2 paints. (2) WebView2's first post-restore
frame is late. (3) Every theme's `--ln-bg` is `transparent`, a 45%-alpha near-black, or a near-black
/ `#000000` (`src/App.css`; max channel across the whole palette is `0x14`) against a dark desktop,
so even the fallback fill is invisible. Firefox is the control that isolates it: Firefox shows a
visible mid-grey rectangle at 213 ms with no page content, i.e. the SAME late content, just opaque
and high-contrast enough that a human reads it as an animation.

Refuted by controlled A/B, not by argument. DO NOT re-run these: transparency does not disable the
animation (a transparent window WITH content animates identically); DWM animates the live surface,
not a stale pre-minimize snapshot; Mica is not a lever; supplying an iconic bitmap
(`DWMWA_HAS_ICONIC_BITMAP` + `DWMWA_FORCE_ICONIC_REPRESENTATION`) does nothing because DWM already
holds a pixel-perfect representation and never sent the messages (the tray-hidden taskbar thumbnail
shows Aura's full live UI, which is the same fact from the UI side); and a black GDI `PrintWindow`
at flags=0 proves nothing, since every Chromium / Electron app on the machine prints black too and
still animates. The environment is stock: `MinAnimate=1`, `DWMWA_TRANSITIONS_FORCEDISABLED=0`,
`GetWindowRgn` 0, `GWL_STYLE=0x15CF0000` (WS_CAPTION present, no WS_POPUP - tao keeps WS_CAPTION on
undecorated top-level windows and goes borderless via `WM_NCCALCSIZE`, so this is not the Electron
frameless case), `GWL_EXSTYLE=0x00040110` (no LAYERED, no NOREDIRECTIONBITMAP).

Restore LATENCY is a separate finding, and DWELL is its dominant variable. A cross-process
`ShowWindow(SW_RESTORE)` is an inter-thread send, so its block time measures how late the window is.
How long the window sat minimized dominates that: interleaved 1 s vs 45 s dwells inside one run give
Aura **60.8 -> 125.0 ms (+64)**, Firefox 38.5 -> 47.7 (+9), opaque native (Telegram) 5.3 -> 19.1 (+14).
Every app degrades after a long minimize (OS working-set trimming, DWM releasing resources for a
long-hidden window); what is Aura-specific is the SIZE. This is most likely what "it looks jarring"
actually is: a recently-used Aura restores in ~60 ms and looks fine, one that sat in the tray for
minutes takes ~125 ms and lands its content after the animation ended. MEASURE WITHIN ONE RUN ONLY -
absolute figures on this machine drift badly between runs (Firefox measured 61.6 ms in one session
and 38.5 ms an hour later, unchanged), so cross-run comparisons are worthless and an earlier one here
was withdrawn.

`src-tauri/src/win_probe.rs` (dev-only wndproc subclass, armed with `AURA_WIN_PROBE=1 pnpm tauri dev`,
logs under the `wintiming` label; the Tauri-side split lives in the `Resized` arm of
`window_logic.rs`) shows where the time goes: Aura's own window-event callback costs **0.0-0.8 ms**,
the whole wndproc chain is busy 38-41 ms over ~14 messages (dominated by the top-level `WM_PAINT` at
25.7-28.7 ms), and the remaining ~60 ms is gaps between messages in win32k / DWM with no Aura frame on
the stack. There is NO hotspot to delete. Two specific dead ends: the `save_window_state` synchronous
disk write in the `Resized` arm fired on one restore in six and cost 0.8 ms, and pinning the WebView2
runtime back to 151.0.4129.107 (from 152.0.4191.53) with `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` changed
nothing (86.6 / 131.5 ms against 88.9 / 131.5 at the two dwells).

Two changes shipped alongside this investigation and NEITHER fixes the animation, so do not describe
them that way. `tray.rs::show_main_window` minimizes before hiding to tray and restores with `show()`
THEN `unminimize()` - the order is load-bearing, because tao applies its whole window-flag diff in one
pass ending in an unconditional `SW_HIDE` when the new flags lack VISIBLE, so `unminimize()` first
would `SW_RESTORE` and then immediately re-hide. And `mpv::engine::wake_and_resync` unparks the
geometry pump on restore, because the pump is otherwise asleep on a 150 ms `HIDDEN_TICK` and its
geometry pass is edge-triggered on a CHANGED rect, so a same-size restore issued no `SetWindowPos` at
all.

Full write-up, including the remedies that were considered and rejected:
`docs/research/2026-09-03-restore-animation.md`.
