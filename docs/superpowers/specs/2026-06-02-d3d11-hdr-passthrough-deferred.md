# DEFERRED — D3D11 render path for true HDR passthrough + tone-mapping

> **⚠ SUPERSEDED 2026-06-03 by
> `docs/superpowers/specs/2026-06-03-mpv2-hdr-dxgi-interop-design.md`.**
> This doc's central premise — "switch the engine to `MPV_RENDER_API_TYPE_D3D11`"
> — is **factually wrong**: the libmpv render API has NO Direct3D backend (only
> `opengl` + `sw`; see `src-tauri/src/mpv2/ffi.rs:251-259`). The correct approach
> is a host-owned **DXGI flip swapchain** with mpv's OpenGL output bridged in via
> **`WGL_NV_DX_interop2`**. Also corrected: `target-colorspace-hint` does NOT work
> under `vo_libmpv`; HDR needs an FP16 FBO + `gpu-next`. Read the new spec; this
> one is kept only for history. Also note the dependency chain below is stale —
> Phase 7 is no longer a hard prerequisite (the thumb extractor that coupled HDR
> to Phase 7 was ported to a headless `mpv2` FFI instance on 2026-06-03).

Status: **SUPERSEDED** (was DEFERRED, filed 2026-06-02). Branch: future work on the render-API line.

**Dependency chain (must land in order):**
1. **Phase 7** — retire `tauri-plugin-libmpv` + legacy `--wid` path (currently
   PAUSED on a thumb-instance decision — see `2026-05-29-render-api-phase7-plan.md`).
2. **THIS** — switch the mpv2 engine's presentation from WGL to a **D3D11 / DXGI**
   render path so HDR can actually reach the display.

This task hinges on Phase 7 completing first: it rewrites the engine's GL/WGL
surface, which is cleanest once the engine is the sole, plugin-free playback path.

---

## Goal
True **HDR passthrough** and correct **HDR tone-mapping** on the AW3425DW (and any
HDR display), driven by Aura's settings — not the current "can't tell if HDR is
even on" state.

## Why (the problem)
The mpv2 engine presents through **WGL**, which has **no HDR swapchain path to the
OS** (no PQ / scRGB-float surface). So under mpv2, "Passthrough" almost certainly
can't hand the display an HDR signal — mpv is effectively tone-mapping to SDR
regardless of the setting. This is the documented finding from the playback-polish
batch (`2026-05-30-playback-polish-findings.md`, item 6) and the render-api memory.
Legacy `--wid` could pass HDR because libmpv owned its own DirectX swapchain — which
is exactly what Phase 7 removes, making this D3D11 work the replacement.

(Secondary win noted in `2026-05-28` FSO finding: a real DXGI swapchain also gives
a proper `SetFullscreenState(FALSE)` opt-out, which would let us drop the 1px
`FSO_HEIGHT_INSET` hack used to keep DWM from promoting the WGL surface to an
independent-flip overlay.)

## Scope / approach (to be designed when picked up)
- Switch the engine from `MPV_RENDER_API_TYPE_OPENGL` (WGL) to
  **`MPV_RENDER_API_TYPE_D3D11`** (render.h supports a D3D11 device param), or stand
  up an Aura-owned **DXGI swapchain** the engine renders into.
- Create the swapchain with an **HDR-capable format** (`R10G10B10A2_UNORM` for HDR10
  / PQ, or `R16G16B16A16_FLOAT` for scRGB) and set DXGI HDR metadata
  (`IDXGISwapChain4::SetHDRMetaData` + `SetColorSpace1` to
  `RGB_FULL_G2084_NONE_P2020` for PQ / `RGB_FULL_G10_NONE_P709` for scRGB).
- Wire Aura's HDR mode setting to mpv's `target-colorspace-hint` / `target-peak` /
  tone-mapping props so "Passthrough" vs "Tone-map → SDR" actually differ.
- Keep the engine's existing child-HWND-under-WebView2 architecture; only the
  swapchain/present layer changes.

## Validation (HW — required)
- Windows 11 → Display → **Use HDR = ON**.
- Play a known-HDR title; toggle Aura HDR mode. In Passthrough the monitor's OSD
  should report HDR (and SDR desktop visibly dims as the OS flips to HDR); in SDR
  it stays SDR. If the picture is identical, HDR still isn't reaching the panel.
- A/B against the (now-removed) legacy path is no longer possible post-Phase-7, so
  the DXGI HDR signal must be confirmed directly via the monitor OSD.

## Risk
- Multi-day render rewrite touching the most fragile part of the engine. The WGL
  path is currently HW-verified working (off-focus, FSO, playback). D3D11 must
  re-clear all of that. Do it on its own branch/phase with the full Phase-6-style
  regression checklist, not as a drive-by.
