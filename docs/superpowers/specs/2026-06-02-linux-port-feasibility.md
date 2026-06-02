# DEFERRED — Linux port feasibility (design-only)

Status: **FEASIBILITY / DEFERRED** (filed 2026-06-02). No code. This is a scoping
study + phased plan to decide IF and HOW to port Aura to Linux, not an approval to
start.

## Verdict (one paragraph)
Bounded and feasible. **~80% of Aura ports with little-to-no change** — the React
frontend, the axum streaming bridge, all Stremio/addon/meta/ratings logic, and the
OS-integration layer (media controls, keyring, Discord RPC) are already
cross-platform-crate-based and partially `cfg`-gated. **The cost is concentrated in
one place:** the rendering/windowing core (~3,000 lines of WGL + Win32 with no
Linux equivalent) plus one architectural risk (transparent webview composited over
an mpv child window). **Recommended first target is X11 + mpv `--wid` embedding**,
which sidesteps porting the WGL render engine. Rough effort: a few weeks to a basic
X11 build; 2–4 months for production parity including Wayland.

---

## What ports for free (inventory)
Verified by `cfg(windows)` / `windows`-crate / dependency audit:
- **Frontend** (`src/**`, React 19) — platform-agnostic. WebView2 → WebKitGTK is
  Tauri's concern. Only cosmetic tweaks (e.g. the 36px windowed title-bar offset,
  any Windows-worded copy).
- **Networking / domain logic** — `streaming.rs` (axum bridge), Stremio account API,
  addon fan-out, meta/catalog/search, `ratings.rs`, `publicmetadb`, subtitles fetch.
  Pure portable Rust (`reqwest` + rustls).
- **OS integrations — already cross-platform:**
  - `media_controls.rs` uses **souvlaki** (SMTC on Windows → MPRIS on Linux), already
    with `cfg(target_os="windows")` / `cfg(not(...))` branches.
  - `keyring` v3 → Secret Service / libsecret on Linux.
  - Discord RPC, `ffmpeg` (`silencedetect`) — cross-platform.
- **`mpv2/ffi.rs` (1,016 lines)** — the raw libmpv C-API bindings are
  platform-agnostic and **reusable as-is**; only the DLL→.so loading names change.

## What needs real work (concentrated, by module)
| Module | Lines | Why it's Windows-bound | Linux approach |
|---|---|---|---|
| `mpv2/engine.rs` | 1,977 | **WGL + Win32 child HWND + wndproc + SetParent + DWM/FSO**. The mpv render-context API is portable; the GL-context + window-embedding + present loop are 100% Windows. | A Linux engine variant: **X11 `--wid`** (mpv owns GL — simplest) or an **EGL/GLX** render context. |
| `win32.rs` | 1,099 | Native chrome/fullscreen: `WS_POPUP`, `HWND_TOPMOST`, `Shell_TrayWnd`, drag regions. | X11/Wayland equivalents, or lean on Tauri's cross-platform window APIs (less precise — `win32.rs` exists *because* they weren't enough). |
| `window_logic.rs` | 523 | Win32 message-pump / shutdown sequencing tied to the engine + HWND. | Re-do the Linux lifecycle around the chosen embedding. |
| libmpv loading | — | `libmpv-2.dll` + `tauri-plugin-libmpv` (Windows wrapper). | `dlopen` `libmpv.so` via the existing `libloading` loader; drop the wrapper plugin. |
| `debug_panel.rs`, `log_export.rs` | small | minor `windows`-crate calls. | gate / replace; low effort. |
| `scripts/release.ps1`, NSIS/MSI | — | PowerShell + Windows installers. | Tauri `.deb`/`.rpm`/AppImage; rewrite the release wrapper. Low-moderate. |

## The one real architectural risk
Aura's foundation is a **transparent WebView2 layered over an mpv child window** —
the webview's transparency is what lets video show through. Replicating this with
**WebKitGTK transparency + X11 child-window compositing** is the part most likely to
need genuine experimentation. **Wayland is materially harder** (no `--wid`, subsurface
compositing, no arbitrary child windows); **X11 is much more forgiving.** This risk is
why the plan front-loads an X11 compositing proof-of-concept (Phase L1) before any
broader investment.

---

## Phased plan

### Phase L0 — Build scaffolding (days)
- Add a Linux build target; gate the `windows` crate + `tauri-plugin-libmpv` so the
  workspace compiles on Linux with the Win32 modules `#[cfg(windows)]`-excluded.
- libmpv `.so` loading in the `ffi.rs` loader (name/path table).
- Tauri Linux bundle config (AppImage first; `.deb`/`.rpm` later).
- **Gate:** `cargo build` on Linux succeeds with playback stubbed out.

### Phase L1 — X11 MVP: mpv `--wid` under a transparent WebKitGTK window (1–3 wks) ⟵ the de-risk
- Create an Aura-owned X11 child window; pass its window id to a libmpv instance
  (via `mpv2/ffi.rs`) as `wid` — mpv renders into it and owns the GL internally
  (no WGL/EGL code needed from us).
- Get the transparent WebKitGTK UI compositing **above** the mpv X11 window with
  input passing through correctly. **This is the make-or-break experiment.**
- Wire the existing command surface (load/seek/pause/volume/tracks) to this instance.
- **Gate:** play a stream on an X11 session with the React UI overlaid and clickable;
  basic seek/pause/track-switch work. If compositing can't be made to work cleanly,
  STOP and reconsider (the whole port hinges here).

### Phase L2 — Native chrome, fullscreen & polish on X11 (1–3 wks)
- Port the essential `win32.rs` behaviours (borderless, true fullscreen to the
  monitor rect, always-on-top during playback) to X11 (EWMH hints / `_NET_WM_STATE`),
  or accept Tauri defaults where parity isn't worth it.
- Media controls (souvlaki/MPRIS) end-to-end; keyring via libsecret; tray; updater
  (Tauri AppImage updater) — validate each.
- **Gate:** a usable, installable AppImage with feature parity on X11 minus Wayland.

### Phase L3 — Wayland support (2–6 wks)
- No `--wid` on Wayland → implement an **EGL render-context path** in a Linux engine
  variant (the real port of `mpv2/engine.rs`'s presentation layer), composited via a
  Wayland subsurface under the WebKitGTK surface.
- **Gate:** playback + UI on a Wayland session (GNOME/KDE), HiDPI correct.

### Phase L4 — (optional) full render-engine parity (weeks–months)
- Only if Wayland/perf demands it: a polished EGL engine matching the Windows engine's
  off-focus/fullscreen behaviour. Most users (X11) won't need this; revisit after L3.

---

## Effort summary
- **Basic usable X11 build:** ~1–1.5 months (dominated by the L1 compositing unknown).
- **Production parity incl. Wayland:** ~2–4 months for one developer.
- Not a "flip a flag" port, but **bounded** — platform code is already concentrated in
  named modules (`win32.rs`, `mpv2/engine.rs`, `window_logic.rs`) and the `windows`
  crate is already `[target.'cfg(target_os="windows")']`-gated.

## Cross-dependencies & notes
- **Phase 7 interaction:** Phase 7 (retire `tauri-plugin-libmpv`) removes the Windows
  `--wid` legacy path. Linux's L1 also wants a `--wid` embedding — but via libmpv
  directly (`mpv2/ffi.rs`), NOT the Windows wrapper plugin. So the two are compatible:
  Linux never uses the wrapper; it uses the FFI + X11 window id.
- **Independent of** the D3D11/HDR task (that's Windows-render work). HDR on Linux is a
  separate, later concern (mpv + a PQ-capable Wayland compositor).
- **Distribution reality:** test across X11 vs Wayland sessions, Mesa vs NVIDIA
  drivers, and libmpv version skew (distro-packaged vs bundled). Bundling libmpv.so is
  safest for consistency (mirrors the Windows DLL approach).

## Decisions to make before starting
1. X11-only first, or X11+Wayland from the start? (Recommend X11-first.)
2. Bundle libmpv.so, or depend on the distro package? (Recommend bundle.)
3. AppImage-only, or also `.deb`/`.rpm` + Flatpak? (Recommend AppImage MVP.)
4. Is the L1 compositing proof-of-concept worth a 1–3 week spike before committing to
   the full port? (Strongly recommend yes — it's the single highest-risk unknown.)
