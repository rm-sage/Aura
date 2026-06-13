# mpv2 HDR Passthrough — DXGI swapchain + WGL_NV_DX_interop2 (design)

Status: **DESIGN — ready for implementation, HW-gated.** Filed 2026-06-03.
Branch context: `feat/mpv2-thumb-hdr` (this spec) → future HDR implementation branch.

> **Supersedes** `docs/superpowers/specs/2026-06-02-d3d11-hdr-passthrough-deferred.md`,
> whose central premise — "switch the engine to `MPV_RENDER_API_TYPE_D3D11`" — is
> **factually wrong**: the libmpv render API has no Direct3D backend (see §1).
> This document is the corrected, implementation-ready source of truth.

## Where this sits in the dependency chain

- **Phase-7 (retire `tauri-plugin-libmpv`)** is **no longer a hard prerequisite.**
  The one thing that coupled HDR work to Phase 7 was the thumbnail extractor's
  use of the plugin; that is now ported to a headless `mpv2` FFI instance
  (`mpv2::thumb`, 2026-06-03). The HDR present path can be built as an additive,
  env-gated alternative present mode in the engine **without** removing the
  legacy `--wid` fallback first. (Phase 7 is still worth doing for hygiene, but
  it doesn't block this.)
- The current engine (`src-tauri/src/mpv2/engine.rs`) presents through **WGL**:
  `mpv_render_context_render` into FBO 0, then `SwapBuffers`. The WGL default
  framebuffer is 8-bit `GL_RGBA8` sRGB — structurally incapable of carrying HDR.
  This effort replaces the *present* layer (8-bit WGL → DXGI HDR swapchain)
  while keeping mpv's OpenGL render backend.
- A small, already-shipped consistency fix (2026-06-03) applies the persisted
  HDR mode at engine init (`engine.rs`, just before `mpv_initialize`). That is
  correct for `sdr`/`off` (the tone-map options are `vo_gpu`-compatible) and a
  documented no-op for `passthrough` until this DXGI work lands.

---

## 1. Corrected facts (read first — the old spec got these wrong)

**There is no `MPV_RENDER_API_TYPE_D3D11`.** The libmpv render API has exactly
two backends, selected via `MPV_RENDER_PARAM_API_TYPE`:

- `MPV_RENDER_API_TYPE_OPENGL` = `b"opengl\0"`
- `MPV_RENDER_API_TYPE_SW`     = `b"sw\0"`

Verified against `include/mpv/render.h` (mpv master) and Aura's own transcription
at `src-tauri/src/mpv2/ffi.rs:251-259`, which define only those two.

**Why the confusion existed:** mpv's *internal* `gpu`/`gpu-next` VOs have a D3D11
GPU context (`--gpu-api=d3d11`, `--gpu-context=d3d11`) where `--d3d11-output-csp`,
`--target-colorspace-hint`, etc. live. That is **mpv owning its own DXGI
swapchain in a window mpv controls** — unreachable when the *host* owns the
window and feeds mpv an FBO via `vo_libmpv`.

Consequences (all corrected myths):

1. **The bridge must be GL → DXGI via `WGL_NV_DX_interop2`.** libmpv cannot write
   into a DXGI swapchain directly. The host creates a D3D11 device + DXGI flip
   swapchain, shares a D3D texture into GL via NV_DX_interop2, wraps it in a GL
   FBO, and hands that FBO to `mpv_render_context_render`.
2. **`target-colorspace-hint` is NOT usable here.** The manual restricts it to
   the Wayland / D3D11 / winvk contexts. `vo_libmpv` has no swapchain to attach
   colorspace metadata to. **Do not set it / do not rely on auto display
   detection.** The host sets `target-prim` / `target-trc` / `target-peak`
   explicitly to tell mpv what to *encode*, then matches its own swapchain
   colorspace to that. (This is why the engine-init HDR block treats
   `passthrough` as a no-op.)
3. **mpv does pixel encoding only, no display signalling.** Manual: *"mpv will
   encode to the specified curve but will not set any HDMI flags or other
   signalling… The user should independently guarantee this."* The host owns
   100% of DXGI colorspace + HDR-metadata signalling (`SetColorSpace1` /
   `SetHDRMetaData`).
4. **An 8-bit FBO cannot carry HDR.** The FBO's backing texture must be
   `GL_RGBA16F` (FP16) or `GL_RGB10_A2` (10-bit). This is the root limitation.
5. **The render API uses `gl_video` (gpu), NOT `gpu-next` — RESOLVED, see Risk #0.**
   `target-trc=scrgb`, `target-contrast`, `target-gamut`, `hdr-reference-white`
   and the libplacebo tone-curves are `gpu-next`-only and therefore **unreachable**
   here (the render API hardcodes `gl_video`; no knob). `gl_video` still supports
   **PQ/HLG/BT.2020 HDR output + basic tone-mapping** — so HDR works, but the plan
   pivots to the **PQ path, not scRGB**, and gpu-next-grade quality is only
   available via the legacy `--wid`+`vo=gpu-next`+`gpu-context=d3d11` path. The
   basic SDR options (`target-prim=bt.709`, `target-trc=bt.1886`, `target-peak`,
   `tone-mapping=mobius`) work on `gl_video`, which is why the shipped SDR/off path
   already works under mpv2.
6. **The render API cannot un-HDR the display on idle** (it owns no swapchain).
   The host owns this lifecycle — tear down / reconfigure the HDR swapchain when
   playback stops, or the desktop stays stuck in HDR (cf. mpv #10196).

---

## 2. Present pipeline (end-to-end)

The host owns everything from the D3D11 device to `Present()`. mpv only renders
pixels into a GL FBO backed by a D3D texture.

```
┌─ Init (once) ────────────────────────────────────────────────────────────┐
│ 1. D3D11CreateDevice(HARDWARE, BGRA_SUPPORT) → ID3D11Device + context     │
│ 2. CreateDXGIFactory2 → IDXGIFactory2                                      │
│ 3. CreateSwapChainForHwnd(device, hwnd, &desc1, None, None)               │
│      desc1.Format       = R16G16B16A16_FLOAT   (scRGB FP16, primary path) │
│      desc1.SwapEffect   = FLIP_DISCARD          (HDR REQUIRES flip model) │
│      desc1.BufferCount  = 2                                                │
│      desc1.BufferUsage  = RENDER_TARGET_OUTPUT                            │
│      desc1.AlphaMode    = IGNORE                                           │
│    → IDXGISwapChain1 → .cast::<IDXGISwapChain4>()                         │
│ 4. sc4.SetColorSpace1(RGB_FULL_G10_NONE_P709)   (scRGB; harmless explicit)│
│ 5. (optional) sc4.SetHDRMetaData(HDR10, &bytes) — best-effort only        │
│ 6. wglDXOpenDeviceNV(device) → gl_handleD3D                               │
│ 7. Create the INTEROP TARGET (offscreen RT — see §5, not the backbuffer): │
│      offscreenTex: ID3D11Texture2D                                         │
│        Format=R16G16B16A16_FLOAT, Usage=DEFAULT, Bind=RENDER_TARGET       │
│      glGenRenderbuffers(1,&rbo)                                            │
│      objHandle = wglDXRegisterObjectNV(gl_handleD3D, offscreenTex,        │
│                    rbo, GL_RENDERBUFFER, WGL_ACCESS_WRITE_DISCARD_NV)     │
│      glGenFramebuffers / glFramebufferRenderbuffer(COLOR_ATTACHMENT0,rbo) │
│      assert glCheckFramebufferStatus == GL_FRAMEBUFFER_COMPLETE           │
└───────────────────────────────────────────────────────────────────────────┘

┌─ Per frame ───────────────────────────────────────────────────────────────┐
│ A. wglDXLockObjectsNV(gl_handleD3D, 1, &objHandle)   // BEFORE any GL      │
│ B. mpv_render_context_render(ctx, params):                                 │
│      OPENGL_FBO → mpv_opengl_fbo { fbo, w, h, internal_format: GL_RGBA16F }│
│      FLIP_Y     → &1   // GL bottom-left vs DXGI top-left                  │
│ C. wglDXUnlockObjectsNV(gl_handleD3D, 1, &objHandle) // BEFORE D3D touches │
│ D. back = sc4.GetBuffer(0); context.CopyResource(back, offscreenTex)      │
│ E. sc4.Present(1, DXGI_PRESENT(0)).ok()?                                   │
└───────────────────────────────────────────────────────────────────────────┘
```

- **FBO `internal_format`:** `GL_RGBA16F` (`0x881A`) for FP16; `GL_RGB10_A2`
  (`0x8059`) for PQ. Tells mpv the target precision (libplacebo dithering); it
  does **not** select transfer/primaries — that's the `target-*` options.
- **FLIP_Y:** set `MPV_RENDER_PARAM_FLIP_Y → 1`; confirm visually on first run.
- **Offscreen RT + `CopyResource`, not direct-backbuffer interop:** HDR requires
  a flip-model swapchain, and NV_DX_interop2 against rotating flip backbuffers is
  historically broken (renders against buffer 0 only). Register one persistent
  offscreen texture, render mpv into it, `CopyResource` into the current flip
  backbuffer. (Direct-backbuffer registration *may* now work on the 4090 — test
  in Phase 0; the offscreen path is the safe default and costs one GPU copy.)

---

## 3. Colorspace / metadata choice

### Primary path — scRGB FP16 (recommended)

- **Why for Aura:** Microsoft recommends FP16/scRGB as *"the only option that
  works for all Advanced Color displays, content, and rendering APIs."* It
  **degrades gracefully** (an FP16/G10 swapchain works whether or not HDR is on
  — DWM numerically clips to SDR when off), and it composes in the same space as
  the DWM, which matters for Aura's **transparent-WebView2-overlay** architecture
  (PQ/R10A2 carries a Microsoft "no alpha/transparency" constraint that conflicts
  with the overlay UI).
- **DXGI:** `DXGI_FORMAT_R16G16B16A16_FLOAT` (10) +
  `DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709` (1). FBO `internal_format=GL_RGBA16F`.
- **mpv options:** `target-trc=scrgb` (gpu-next only), `target-prim=bt.2020`
  (or auto), `target-peak=auto`. **Do not** set `target-colorspace-hint`.
- **scRGB encoding:** `(1,1,1)` = D65 white @ 80 nits; 1000 nits = `(12.5,…)`;
  values may exceed `[0,1]` / go negative (wide gamut). Brighten the SDR React
  overlay to match by multiplying its linear color by `SdrWhiteLevelInNits/80`
  (read via `DISPLAYCONFIG_SDR_WHITE_LEVEL` + `QueryDisplayConfig`).
- ⚠️ **scRGB caveat (Risk #1):** mpv #17076 reports current scRGB clips negative
  and `>1.0` values → *"basically unusable."* If the shipped libplacebo exhibits
  this, fall back to PQ.

### Fallback path — HDR10 / PQ (R10G10B10A2)

- **DXGI:** `DXGI_FORMAT_R10G10B10A2_UNORM` (24) +
  `DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020` (12). `SetColorSpace1` is
  **mandatory** (format defaults to sRGB otherwise). FBO `GL_RGB10_A2`.
- **mpv:** `target-trc=pq`, `target-prim=bt.2020`, `target-peak=<display nits>`.
- mpv writes PQ-encoded BT.2020 normalized `0–1` into the FBO; the swapchain
  interprets it directly. Only correct on an actual HDR display + no overlay
  transparency on the video plane.

### `SetHDRMetaData` (best-effort)

Microsoft now discourages it (*"Windows does not guarantee swap chain metadata
is sent to the monitor"*); `SetColorSpace1` is load-bearing. If set, source from
mpv `video-params/{primaries,gamma,sig-peak}` (HDR metadata since mpv 0.40);
`sig-peak` is relative to `MP_REF_WHITE` ≈ 203 nits (BT.2408) — convert to
absolute nits. (Confirm 0.41 sub-property names against the shipped DLL.)

---

## 4. Exact code building blocks (paste-ready)

### 4.1 `windows` crate 0.61 — add these features

Current (`Cargo.toml`): `Win32_Foundation`, `Win32_System_Com`,
`Win32_System_LibraryLoader`, `Win32_UI_Shell`, `Win32_UI_WindowsAndMessaging`,
`Win32_Graphics_Gdi`, `Win32_Graphics_OpenGL`, `Win32_Graphics_Dwm`. **Add:**

```toml
"Win32_Graphics_Direct3D11",
"Win32_Graphics_Direct3D",
"Win32_Graphics_Dxgi",
"Win32_Graphics_Dxgi_Common",   # MUST include — DXGI_SWAP_CHAIN_DESC1 Format/
                                 # SampleDesc/AlphaMode live here; omitting it
                                 # makes CreateSwapChainForHwnd "method not found"
```

`DXGI_FORMAT`, `DXGI_COLOR_SPACE_TYPE`, `DXGI_SAMPLE_DESC`, `DXGI_ALPHA_MODE_*`
live in `windows::Win32::Graphics::Dxgi::Common`; the swapchain interfaces,
descs, `DXGI_HDR_METADATA_*` in the parent `…::Dxgi`.

### 4.2 WGL_NV_DX_interop2 (not in the windows crate — resolve via `wglGetProcAddress`)

Resolve AFTER a GL context is current; check `"WGL_NV_DX_interop2"` is in
`wglGetExtensionsStringARB/EXT` first. Mirror `engine.rs::resolve_swap_interval`
(reject the `1/2/3/-1` ICD sentinels).

```rust
// C prototypes (interop2 widens dxDevice/dxObject to accept D3D11 + DXGI):
//   HANDLE wglDXOpenDeviceNV(void *dxDevice);                 // = ID3D11Device*
//   BOOL   wglDXCloseDeviceNV(HANDLE hDevice);
//   HANDLE wglDXRegisterObjectNV(HANDLE hDevice, void *dxObject,
//              GLuint name, GLenum type, GLenum access);      // NULL on fail
//   BOOL   wglDXUnregisterObjectNV(HANDLE hDevice, HANDLE hObject);
//   BOOL   wglDXLockObjectsNV(HANDLE hDevice, GLint count, HANDLE *hObjects);
//   BOOL   wglDXUnlockObjectsNV(HANDLE hDevice, GLint count, HANDLE *hObjects);
type PfnWglDXOpenDeviceNV       = unsafe extern "system" fn(*mut c_void) -> *mut c_void;
type PfnWglDXCloseDeviceNV      = unsafe extern "system" fn(*mut c_void) -> i32;
type PfnWglDXRegisterObjectNV   = unsafe extern "system" fn(*mut c_void, *mut c_void, u32, u32, u32) -> *mut c_void;
type PfnWglDXUnregisterObjectNV = unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32;
type PfnWglDXLockObjectsNV      = unsafe extern "system" fn(*mut c_void, i32, *mut *mut c_void) -> i32;
type PfnWglDXUnlockObjectsNV    = unsafe extern "system" fn(*mut c_void, i32, *mut *mut c_void) -> i32;

const WGL_ACCESS_READ_ONLY_NV:     u32 = 0x0000;
const WGL_ACCESS_READ_WRITE_NV:    u32 = 0x0001;  // safe default
const WGL_ACCESS_WRITE_DISCARD_NV: u32 = 0x0002;  // correct for a fully-overwritten RT
const GL_TEXTURE_2D:   u32 = 0x0DE1;
const GL_RENDERBUFFER: u32 = 0x8D41;
const GL_FRAMEBUFFER:          u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0:    u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_RGBA16F:  i32 = 0x881A;  // FP16  → DXGI_FORMAT_R16G16B16A16_FLOAT
const GL_RGB10_A2: i32 = 0x8059;  // 10-bit→ DXGI_FORMAT_R10G10B10A2_UNORM
const GL_RGBA8:    i32 = 0x8058;  // 8-bit SDR (cannot carry HDR)
```

### 4.3 DXGI / D3D11 enum values (windows 0.61.3)

```rust
DXGI_FORMAT_R16G16B16A16_FLOAT  = DXGI_FORMAT(10)
DXGI_FORMAT_R10G10B10A2_UNORM   = DXGI_FORMAT(24)
DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709    = DXGI_COLOR_SPACE_TYPE(0)   // sRGB/SDR
DXGI_COLOR_SPACE_RGB_FULL_G10_NONE_P709    = DXGI_COLOR_SPACE_TYPE(1)   // scRGB FP16
DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020 = DXGI_COLOR_SPACE_TYPE(12)  // HDR10/PQ
DXGI_SWAP_EFFECT_FLIP_DISCARD    = DXGI_SWAP_EFFECT(4)
DXGI_SCALING_NONE                = DXGI_SCALING(1)
DXGI_USAGE_RENDER_TARGET_OUTPUT  = DXGI_USAGE(32)
DXGI_ALPHA_MODE_IGNORE           = DXGI_ALPHA_MODE(3)
DXGI_HDR_METADATA_TYPE_HDR10     = DXGI_HDR_METADATA_TYPE(1)
D3D11_SDK_VERSION                = 7u32
D3D11_CREATE_DEVICE_BGRA_SUPPORT = D3D11_CREATE_DEVICE_FLAG(32)
D3D_DRIVER_TYPE_HARDWARE         = D3D_DRIVER_TYPE(1)
D3D_FEATURE_LEVEL_11_1           = D3D_FEATURE_LEVEL(45312)
D3D_FEATURE_LEVEL_11_0           = D3D_FEATURE_LEVEL(45056)
```

### 4.4 Key method signatures (windows 0.61.3 — all `unsafe`, `windows_core::Result`)

```rust
// Device
D3D11CreateDevice(padapter: P0 /* =None */, drivertype, software: HMODULE,
    flags, pfeaturelevels: Option<&[D3D_FEATURE_LEVEL]>, sdkversion: u32,
    ppdevice: Option<*mut Option<ID3D11Device>>,
    pfeaturelevel: Option<*mut D3D_FEATURE_LEVEL>,
    ppimmediatecontext: Option<*mut Option<ID3D11DeviceContext>>) -> Result<()>;
// Swapchain (IDXGIFactory2; needs Win32_Graphics_Dxgi_Common)
CreateSwapChainForHwnd(&self, pdevice: P0, hwnd: HWND,
    pdesc: *const DXGI_SWAP_CHAIN_DESC1,                 // raw *const, NOT Option/ref
    pfullscreendesc: Option<*const DXGI_SWAP_CHAIN_FULLSCREEN_DESC> /* None */,
    prestricttooutput: P4 /* None */) -> Result<IDXGISwapChain1>;
// Colorspace / metadata
CheckColorSpaceSupport(&self, DXGI_COLOR_SPACE_TYPE) -> Result<u32>;  // IDXGISwapChain3
SetColorSpace1(&self, DXGI_COLOR_SPACE_TYPE) -> Result<()>;           // IDXGISwapChain3
SetHDRMetaData(&self, DXGI_HDR_METADATA_TYPE, Option<&[u8]>) -> Result<()>; // IDXGISwapChain4
//   ^^ 0.61 QUIRK: byte SLICE, not (ptr,size). Serialize the struct to &[u8].
GetBuffer<T: Interface>(&self, buffer: u32 /* 0 */) -> Result<T>;
Present(&self, syncinterval: u32, presentflags: DXGI_PRESENT) -> HRESULT; // BARE HRESULT → .ok()
// cast: let sc4: IDXGISwapChain4 = sc1.cast()?;  (1/2/3 reachable on 4)
```

`DXGI_HDR_METADATA_HDR10` units: `RedPrimary/GreenPrimary/BluePrimary/WhitePoint:
[u16;2]` = CIE1931 xy `* 50000` (idx0=x, idx1=y); `MaxMasteringLuminance: u32`
whole nits; `MinMasteringLuminance: u32` in 0.0001-nit units;
`MaxContentLightLevel / MaxFrameAverageLightLevel: u16` whole nits.

---

## 5. Resize + FSO

### `ResizeBuffers` — strict ordering (the interop handle is texture-bound)

```
1. wglDXUnregisterObjectNV(gl_handleD3D, objHandle)      // FIRST
2. Release all GetBuffer() ID3D11Texture2D references
3. swapChain.ResizeBuffers(0, newW, newH, DXGI_FORMAT_UNKNOWN, flags)
4. Recreate the offscreen interop texture at the new size
5. wglDXRegisterObjectNV(...) again → new objHandle
6. Recreate the GL FBO attachment
// Do NOT wglDXCloseDeviceNV on resize — device association survives; only
// per-object registrations recycle.
```

The engine already owns its resize (Phase 5, render-thread `SetWindowPos` on
parent-rect change); hook this re-registration into that path instead of the
`SwapBuffers` present.

### FSO — **DXGI eliminates the `FSO_HEIGHT_INSET` hack**

A windowed flip-model swapchain reaches exclusive-fullscreen efficiency
(DirectFlip / Independent Flip / MPO) **without `SetFullscreenState(TRUE)`**. So
with a real DXGI flip swapchain Aura needs **no exclusive fullscreen, no
`Shell_TrayWnd` workaround, and no 1px `FSO_HEIGHT_INSET`** (`engine.rs:1208`).
The flip-model "no two APIs in one HWND" rule does **not** bite Aura: WebView2 is
a sibling child HWND the DWM composites separately, so the video swapchain HWND
and the WebView2 HWND stay distinct — transparency still shows the video through.
(Whether Independent Flip is *achieved* with the overlay on top is DWM/driver
dependent — perf, not correctness; confirm with PresentMon.)

---

## 6. Aura integration specifics

- **Where:** a new env-gated module, `mpv2::hdr_present` (or fold into `engine.rs`
  behind a flag), default OFF — exactly how `AURA_MPV2` gated the engine and
  `AURA_MPV2_HELLO` gated the Phase-1 hello-world. Keep the 8-bit WGL
  `SwapBuffers` path as the always-available fallback until HW-proven.
- **Engine coupling:** the present mode (`PresentMode` foreground/background/
  hidden in `engine.rs`) and the swap-interval/report_swap pacing must be
  reworked for DXGI `Present(syncinterval, …)`. The off-focus framedrop work
  (HW-verified, render-api-rewrite memory) must be re-validated on the DXGI path
  — it is currently a WGL `swap-interval`/`report_swap` property of the path.
- **HDR mode setting:** reuse the existing `apply_hdr_settings` command +
  `resolve_hdr_mode`/`apply_hdr_options`, but the option *set* changes for the
  DXGI path (drop `target-colorspace-hint`; add `target-trc=scrgb|pq`,
  `target-prim`, `target-peak`; gate on gpu-next per Risk #0).
- **Idle teardown:** on playback stop / EOS, reconfigure to an SDR
  (`B8G8R8A8_UNORM` + `G22_P709`) swapchain or tear the HDR swapchain down, or
  the desktop stays in HDR (Risk #10). Wire into the engine's load/stop
  lifecycle from day one.
- **DLL probe:** unaffected — still `libmpv-2.dll`. The D3D11/DXGI come from the
  `windows` crate; only `WGL_NV_DX_interop2` is runtime-resolved.

---

## 7. Open risks / must-verify-on-HW (ranked)

0. **`gpu-next` under the render API — ✅ RESOLVED 2026-06-08 (probed): it is NOT
   reachable. The render API hardcodes the legacy `gl_video` ("gpu") renderer.**
   Confirmed two ways against the shipped build (mpv `v0.41.0-524-g5921fe50b`,
   libplacebo 7.362): (a) the source — `video/out/gpu/libmpv_gpu.c`'s
   `render_backend_gpu` calls `gl_video_init` / `gl_video_render_frame` and stores
   a `struct gl_video *`, with zero libplacebo/`pl_renderer` usage; there is no
   selection knob. (b) a headless option-surface probe of `libmpv-2.dll` — the
   build *knows* `vo=gpu-next` and the parser *accepts* every HDR value incl.
   `target-trc=scrgb` and the gpu-next-only options (`target-contrast`,
   `corner-rounding`), but option acceptance is global and does NOT mean the
   render-API renderer honors them.
   **CONSEQUENCES (design pivots):**
   - gpu-next quality (libplacebo tone-mapping: `spline`/`st2094-40` dynamic
     metadata, `target-contrast`, scRGB, placebo dithering/peak-detect) is
     **unreachable** via the render API. It is only available by letting mpv own
     its own swapchain — i.e. the **legacy `--wid` + `vo=gpu-next` +
     `--gpu-context=d3d11`** path, which is exactly why HDR worked pre-rewrite.
   - `gl_video` IS mpv's original HDR renderer and supports **PQ/HLG/BT.2020
     output + tone-mapping** (clip/mobius/reinhard/hable/bt.2390). So **HDR is NOT
     blocked** — but **plan the PQ/R10A2 path as PRIMARY, not scRGB.** Under
     `gl_video`, `scrgb` output is likely a no-op/unsupported (it's a
     libplacebo/gpu-next output mode); confirm empirically in Phase 1, but do not
     design around it.
   - This makes the transparent-overlay-vs-PQ-no-alpha tension (§3) the central
     design problem, since the overlay-friendly scRGB path is out.
   - **Strategic note:** mpv2 HDR is inherently a notch below the legacy
     gpu-next+d3d11 HDR (older renderer, PQ-only, more manual signalling). The
     render-API rewrite traded gpu-next+mpv-owned-d3d11-HDR away for off-focus-drop
     control + an Aura-owned swapchain. HDR is the one axis where legacy was
     genuinely better — weigh that before committing to the multi-day DXGI build.
1. **scRGB usability in the shipped libplacebo (HIGH).** mpv #17076 — scRGB clips
   negatives/`>1.0`. If present, default to PQ. Single biggest "plan A might fail."
2. **Does `internal_format` drive libplacebo output depth in `vo_libmpv`? (HIGH).**
   `render_gl.h` is terse on this. Render into `GL_RGBA16F` with `target-trc=pq`
   and inspect mpv stats/verbose for output bit depth.
3. **NV_DX_interop2 + flip backbuffer on the RTX driver (HIGH).** "Broken on flip
   model" reports are 2016–2018. Try direct-backbuffer first; fall back to
   offscreen + `CopyResource` if it flickers/blacks.
4. **Sharing an FP16/R10A2 D3D texture through NV_DX_interop2 (MEDIUM).** Canonical
   samples only exercise 8-bit RGBA. HW-test the FP16 register on NVIDIA (and
   AMD/Intel if ever in scope).
5. **`d3d11va` HW decode through WGL+interop (MEDIUM).** Aura uses `hwdec=auto`
   (d3d11va). Whether zero-copy decode→render survives a WGL/interop *render* path
   (vs mpv's own d3d11 context) is unestablished — may need plumbing or a copy.
6. **`FLIP_Y` correctness (LOW).** Confirm visually; re-confirm the param
   discriminant against the vendored `render_gl.h`.
7. **Runtime `target-*` changes on a live render context (LOW-MED).** Whether
   SDR↔HDR mid-session needs a context rebuild under `vo_libmpv`.
8. **mpv 0.41 `video-params` HDR sub-property names + `MP_REF_WHITE` (LOW).** Pin
   the exact strings before nit conversions; `SetHDRMetaData` is best-effort anyway.
9. **Independent Flip with the overlay (LOW — perf).** PresentMon.
10. **HDR teardown on idle (DESIGN).** Build it in from day one (see §6).

---

## 8. Recommended phasing (hello-world-first, mirrors `mpv2::hello`)

Each phase env-gated + throwaway, promoted only once HW-proven. Gate each on a
concrete observable.

- **Phase 0 — `mpv2::hdr_probe` (no mpv, no HDR): GL↔DX interop hello-world.**
  D3D11 device + `B8G8R8A8` flip swapchain, `wglDXOpenDeviceNV`, register one
  offscreen RT, lock → `glClear` a solid color → unlock → `CopyResource` →
  `Present`. **Success = solid color on screen, no flicker on resize.** Also try
  direct-backbuffer registration here (settles Risk #3).
- **Phase 1 — FP16 + HDR signalling (still no mpv).** Swapchain →
  `R16G16B16A16_FLOAT`, `SetColorSpace1(G10_P709)`, `glClear((4,4,4))` ≈ 320
  nits. **Success = on HDR-on the region is visibly brighter than SDR white; on
  SDR it clamps.** Add a PQ/R10A2 sub-flag to settle scRGB-vs-PQ (Risk #1).
- **Phase 2 — route mpv into the interop FBO (SDR first).** `internal_format=
  GL_RGBA8`, no `target-*`. **Success = normal SDR video plays correctly through
  the new path** (validates FLIP_Y #6 + that `d3d11va` decode survives #5). The
  riskiest integration point — isolate it.
- **Phase 3 — HDR encode in mpv + match swapchain.** `internal_format=GL_RGBA16F`,
  `target-trc=scrgb|pq`, `target-prim`, `target-peak`, on gpu-next (Risk #0).
  **Success = a known HDR10 clip displays correct brightness, no clipping, on a
  real HDR panel.** Inspect mpv stats for output depth (#2).
- **Phase 4 — lifecycle + promotion.** HDR-display detection
  (`IDXGIOutput6::GetDesc1.ColorSpace`), `IDXGIFactory::IsCurrent` HDR-toggle
  polling, idle teardown (#10), resize re-registration (§5). Promote behind a
  setting (default off), keep the WGL fallback. PresentMon for Independent Flip
  (#9). Only after a full HW pass does HDR become default.

**Throughout:** keep the 8-bit WGL present path intact and env-revertible. HDR is
additive; never the only path until HW-proven.

---

## 9. HW validation checklist (per phase, on the HDR display)

- Windows Settings → Display → **Use HDR = ON**; SDR desktop visibly dims as the
  OS engages HDR when a correct swapchain is active.
- Phase 1: `glClear((4,4,4))` region reads brighter than the SDR UI.
- Phase 3: a known HDR10 title shows specular highlights without clip; toggling
  Aura's HDR mode visibly differs (passthrough vs SDR tone-map). Monitor OSD
  reports HDR. (Legacy A/B is impossible post-Phase-7; rely on the OSD + dim.)
- Off-focus drops: re-run the render-api-rewrite drop test on the DXGI path
  (Settings → Debug Stuff) — confirm parity with the WGL path.
- Fullscreen: confirm the `FSO_HEIGHT_INSET` hack can be removed (no black strip,
  no MPO desktop-bleed, UI composites over video).
