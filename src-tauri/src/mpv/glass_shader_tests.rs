// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// mpv/glass_shader_tests.rs
//
// Ignored runtime feasibility test for `aura_glass.glsl` (the "real glass"
// player-controls shader). It changes nothing in the app: the embedded shader
// (`glass::SHADER_SRC`) is written to a temp folder under the app's file name.
//
// It drives libmpv DIRECTLY through `ffi::Libmpv`: its own mpv-created
// top-level window (no `--wid`), `vo=gpu-next`, `gpu-api=d3d11`, lavfi test
// sources (no network, no remote URL). It opens a window on the primary
// monitor for about a minute and a half.
//
//   cd src-tauri
//   cargo test --lib glass_shader_runtime -- --ignored --nocapture
//
//   AURA_GLASS_OUT   optional output folder (PNGs, mpv log, copies of the
//                    shader). Default: %TEMP%\aura-glass-test.
//
// What it measures (printed as a report; the hard checks are asserted at the
// end so one failing phase does not hide the others):
//   1. placement: window-mode screenshots with 2 rects; the changed-pixel
//      box per rect vs the requested rect;
//   2. update latency on SCREEN (GDI capture of the composited desktop) for a
//      glass_shader_opts change vs a video-eq `brightness` change, playing and
//      paused, plus the mpv log: shader parses, GLSL->SPIR-V compiles and
//      "Render options updated" resets per update;
//   3. letterbox / pillarbox / video-zoom: osd-dimensions margins and where
//      the glass lands;
//   4. GPU cost from `vo-passes` (string/JSON read, never node) at 1920x1080
//      windowed and at the monitor's fullscreen size, 0 / 2 / 4 rects;
//   5. interpolation (display-resample + mitchell): mistimed / delayed / drop
//      counters across idle, brightness changes and glass updates; on-screen
//      flicker of a static probe outside the glass;
//   6. HDR passthrough (target-colorspace-hint, PQ target) on a PQ-tagged
//      source: the linear darken ratio with glass_pq 1 vs 0, the white cap,
//      and the SDR luminance soft cap (glass_cap) on two flat grays;
//   7. an Anime4K chain (if the shader files are present locally) + glass
//      appended last, and what a `clr` (cinema.rs) does to it;
//   8. failure modes: a header parse error, a GLSL compile error, a missing
//      file;
//   9. screenshot modes: `window` bakes the glass in, `video` with the
//      `glass_ow` guard does not.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::ffi::{mpv_event_id, mpv_format, mpv_handle, Libmpv};

// The app's own shader and file basename (= option-key prefix), so this test
// always drives exactly what `glass.rs` writes and sends.
use super::glass::{GlassStyle, SHADER_NAME, SHADER_SRC};

/// One rounded rect in physical px relative to the visible video rect.
#[derive(Clone, Copy, Debug)]
struct GRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    r: f64,
    s: f64,
}

impl GRect {
    fn new(x: f64, y: f64, w: f64, h: f64, r: f64) -> Self {
        GRect { x, y, w, h, r, s: 1.0 }
    }
}

/// The full glass state. Serialised as ONE `change-list glsl-shader-opts add`
/// value with every key, because mpv resets each parameter to its default
/// before applying the list.
#[derive(Clone, Debug)]
struct Glass {
    rects: Vec<GRect>,
    ow: f64,
    dim: f64,
    blur: f64,
    refract: f64,
    rim: f64,
    alpha: f64,
    fade_from: f64,
    fade_t0: f64,
    fade_dur: f64,
    pq: i32,
    gamma: f64,
    white: f64,
    /// Luminance soft cap (linear, x SDR white); 1 = no cap on SDR.
    cap: f64,
    /// Saturation lift; 1 = unchanged.
    sat: f64,
    /// Additive white lift after the cap (linear, x SDR white); 0 = none.
    lift: f64,
}

impl Default for Glass {
    fn default() -> Self {
        Glass {
            rects: Vec::new(),
            ow: 0.0,
            dim: 0.8,
            blur: 1.0,
            refract: 14.0,
            rim: 22.0,
            alpha: 1.0,
            fade_from: 1.0,
            fade_t0: 0.0,
            fade_dur: 0.0,
            pq: 0,
            gamma: 2.4,
            white: 203.0,
            cap: 1.0,
            sat: 1.0,
            lift: 0.0,
        }
    }
}

impl Glass {
    fn with(rects: &[GRect]) -> Self {
        Glass { rects: rects.to_vec(), ..Default::default() }
    }

    fn opts(&self) -> String {
        let p = SHADER_NAME;
        let mut kv: Vec<String> = vec![
            format!("{p}/glass_n={}", self.rects.len().min(4)),
            format!("{p}/glass_ow={}", self.ow),
            format!("{p}/glass_dim={}", self.dim),
            format!("{p}/glass_blur={}", self.blur),
            format!("{p}/glass_refract={}", self.refract),
            format!("{p}/glass_rim={}", self.rim),
            format!("{p}/glass_alpha={}", self.alpha),
            format!("{p}/glass_fade_from={}", self.fade_from),
            format!("{p}/glass_fade_t0={}", self.fade_t0),
            format!("{p}/glass_fade_dur={}", self.fade_dur),
            format!("{p}/glass_pq={}", self.pq),
            format!("{p}/glass_gamma={}", self.gamma),
            format!("{p}/glass_white_nits={}", self.white),
            format!("{p}/glass_cap={}", self.cap),
            format!("{p}/glass_sat={}", self.sat),
            format!("{p}/glass_lift={}", self.lift),
        ];
        for i in 0..4 {
            let r = self.rects.get(i).copied().unwrap_or(GRect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
                r: 0.0,
                s: 1.0,
            });
            kv.push(format!("{p}/g{i}x={:.2}", r.x));
            kv.push(format!("{p}/g{i}y={:.2}", r.y));
            kv.push(format!("{p}/g{i}w={:.2}", r.w));
            kv.push(format!("{p}/g{i}h={:.2}", r.h));
            kv.push(format!("{p}/g{i}r={:.2}", r.r));
            kv.push(format!("{p}/g{i}s={:.3}", r.s));
        }
        kv.join(",")
    }
}

// ---------------------------------------------------------------------------
// A minimal libmpv instance
// ---------------------------------------------------------------------------

struct Mpv {
    lib: Libmpv,
    h: *mut mpv_handle,
}

impl Mpv {
    unsafe fn new(opts: &[(&str, String)]) -> Result<Mpv, String> {
        let dll = concat!(env!("CARGO_MANIFEST_DIR"), "/lib/libmpv-2.dll");
        let lib = if Path::new(dll).exists() { Libmpv::load_from(dll)? } else { Libmpv::load()? };
        let h = (lib.create)();
        if h.is_null() {
            return Err("mpv_create returned NULL".into());
        }
        let m = Mpv { lib, h };
        for (k, v) in opts {
            if let Err(e) = m.set_str(k, v) {
                println!("  [opt] {k}={v} rejected: {e}");
            }
        }
        let r = (m.lib.initialize)(m.h);
        if r < 0 {
            return Err(format!("mpv_initialize: {}", m.err(r)));
        }
        Ok(m)
    }

    fn err(&self, code: i32) -> String {
        unsafe {
            let s = (self.lib.error_string)(code);
            let msg = if s.is_null() { "?".into() } else { CStr::from_ptr(s).to_string_lossy().into_owned() };
            format!("{code} ({msg})")
        }
    }

    fn cmd(&self, args: &[&str]) -> Result<(), String> {
        let cs: Vec<CString> = args.iter().map(|a| CString::new(*a).unwrap()).collect();
        let mut ptrs: Vec<*const c_char> = cs.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let r = unsafe { (self.lib.command)(self.h, ptrs.as_mut_ptr()) };
        if r < 0 {
            Err(format!("{:?}: {}", args.first(), self.err(r)))
        } else {
            Ok(())
        }
    }

    /// Typed string write: scalar options only (never an option list).
    fn set_str(&self, name: &str, value: &str) -> Result<(), String> {
        let n = CString::new(name).unwrap();
        let v = CString::new(value).unwrap();
        let r = unsafe { (self.lib.set_property_string)(self.h, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            Err(self.err(r))
        } else {
            Ok(())
        }
    }

    fn get_str(&self, name: &str) -> Option<String> {
        let n = CString::new(name).unwrap();
        unsafe {
            let p = (self.lib.get_property_string)(self.h, n.as_ptr());
            if p.is_null() {
                return None;
            }
            let s = CStr::from_ptr(p).to_string_lossy().into_owned();
            (self.lib.free)(p as *mut c_void);
            Some(s)
        }
    }

    fn get_f64(&self, name: &str) -> Option<f64> {
        let n = CString::new(name).unwrap();
        let mut v = 0f64;
        let r = unsafe {
            (self.lib.get_property)(self.h, n.as_ptr(), mpv_format::DOUBLE, &mut v as *mut f64 as *mut c_void)
        };
        (r >= 0).then_some(v)
    }

    fn get_i64(&self, name: &str) -> Option<i64> {
        let n = CString::new(name).unwrap();
        let mut v = 0i64;
        let r = unsafe {
            (self.lib.get_property)(self.h, n.as_ptr(), mpv_format::INT64, &mut v as *mut i64 as *mut c_void)
        };
        (r >= 0).then_some(v)
    }

    /// Drain events for `ms`, returning whether `want` was seen.
    fn pump(&self, ms: u64, want: Option<mpv_event_id>) -> bool {
        let deadline = Instant::now() + Duration::from_millis(ms);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let ev = unsafe { (self.lib.wait_event)(self.h, left.as_secs_f64().min(0.05)) };
            if ev.is_null() {
                continue;
            }
            let id = unsafe { (*ev).event_id };
            if Some(id) == want {
                return true;
            }
        }
    }

    fn mark(&self, label: &str) {
        let _ = self.cmd(&["print-text", &format!("AURA-MARK {label}")]);
    }

    fn set_glass(&self, g: &Glass) -> Result<(), String> {
        self.cmd(&["change-list", "glsl-shader-opts", "add", &g.opts()])
    }

    fn load(&self, url: &str) -> bool {
        if let Err(e) = self.cmd(&["loadfile", url, "replace"]) {
            println!("  loadfile failed: {e}");
            return false;
        }
        let ok = self.pump(15000, Some(mpv_event_id::FILE_LOADED));
        let _ = self.pump(8000, Some(mpv_event_id::PLAYBACK_RESTART));
        self.pump(400, None);
        ok
    }

    fn shot(&self, path: &Path, mode: &str) -> Result<(), String> {
        let p = path.to_string_lossy().replace('\\', "/");
        self.cmd(&["screenshot-to-file", &p, mode])
    }

    fn osd(&self) -> (f64, f64, f64, f64, f64, f64) {
        let g = |k: &str| self.get_f64(&format!("osd-dimensions/{k}")).unwrap_or(f64::NAN);
        (g("w"), g("h"), g("ml"), g("mt"), g("mr"), g("mb"))
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        unsafe { (self.lib.terminate_destroy)(self.h) };
    }
}

// ---------------------------------------------------------------------------
// Image + screen helpers
// ---------------------------------------------------------------------------

struct Img {
    w: u32,
    h: u32,
    px: Vec<f32>, // RGB, 0..1
}

impl Img {
    fn open(p: &Path) -> Option<Img> {
        let im = image::open(p).ok()?.to_rgb32f();
        Some(Img { w: im.width(), h: im.height(), px: im.into_raw() })
    }

    fn at(&self, x: u32, y: u32) -> [f32; 3] {
        let i = ((y * self.w + x) * 3) as usize;
        [self.px[i], self.px[i + 1], self.px[i + 2]]
    }

    fn mean(&self, x0: i64, y0: i64, x1: i64, y1: i64) -> [f64; 3] {
        let (x0, y0) = (x0.max(0) as u32, y0.max(0) as u32);
        let (x1, y1) = ((x1 as u32).min(self.w), (y1 as u32).min(self.h));
        let mut s = [0f64; 3];
        let mut n = 0f64;
        for y in y0..y1 {
            for x in x0..x1 {
                let p = self.at(x, y);
                for c in 0..3 {
                    s[c] += p[c] as f64;
                }
                n += 1.0;
            }
        }
        if n > 0.0 {
            for v in &mut s {
                *v /= n;
            }
        }
        s
    }
}

/// Pixels whose max channel differs by more than `thr`.
fn diff_mask(a: &Img, b: &Img, thr: f32) -> Vec<bool> {
    a.px.chunks(3)
        .zip(b.px.chunks(3))
        .map(|(p, q)| (0..3).any(|c| (p[c] - q[c]).abs() > thr))
        .collect()
}

/// Bounding box of changed pixels inside a search window (x0,y0,x1,y1).
fn bbox_in(mask: &[bool], w: u32, h: u32, win: (i64, i64, i64, i64)) -> Option<(i64, i64, i64, i64)> {
    let (sx0, sy0) = (win.0.max(0), win.1.max(0));
    let (sx1, sy1) = (win.2.min(w as i64), win.3.min(h as i64));
    let mut bb: Option<(i64, i64, i64, i64)> = None;
    for y in sy0..sy1 {
        for x in sx0..sx1 {
            if mask[(y as u32 * w + x as u32) as usize] {
                bb = Some(match bb {
                    None => (x, y, x + 1, y + 1),
                    Some((a, b, c, d)) => (a.min(x), b.min(y), c.max(x + 1), d.max(y + 1)),
                });
            }
        }
    }
    bb
}

fn count_in(mask: &[bool], w: u32, h: u32, win: (i64, i64, i64, i64)) -> (usize, usize) {
    let (sx0, sy0) = (win.0.max(0), win.1.max(0));
    let (sx1, sy1) = (win.2.min(w as i64), win.3.min(h as i64));
    let (mut on, mut tot) = (0, 0);
    for y in sy0..sy1 {
        for x in sx0..sx1 {
            tot += 1;
            if mask[(y as u32 * w + x as u32) as usize] {
                on += 1;
            }
        }
    }
    (on, tot)
}

/// The shader's SDR path for a neutral gray: dim, then the luminance soft
/// cap (knee at 0.7 of the cap), then the white lift, back to the encoded
/// value.
fn sdr_capped(e: f64, dim: f64, cap: f64, lift: f64, gamma: f64) -> f64 {
    let y = e.max(0.0).powf(gamma) * dim;
    let k = 0.7 * cap;
    let y2 = if cap < 1.0 && y > k { k + (cap - k) * (1.0 - (-(y - k) / (cap - k)).exp()) } else { y };
    let y3 = y2 + lift * (1.0 - y2).max(0.0);
    y3.min(1.0).powf(1.0 / gamma)
}

fn pq_eotf(e: f64) -> f64 {
    let (m1, m2, c1, c2, c3) = (0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875);
    let p = e.clamp(0.0, 1.0).powf(1.0 / m2);
    ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1) * 10000.0
}

mod screen {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetClientRect};

    /// mpv's own top-level window (class "mpv"), when `window-id` is unavailable.
    pub fn find_mpv() -> isize {
        unsafe {
            FindWindowW(windows::core::w!("mpv"), windows::core::PCWSTR::null())
                .map(|h| h.0 as isize)
                .unwrap_or(0)
        }
    }

    /// Client rect of `hwnd` in screen coordinates (x, y, w, h).
    pub fn client_rect(hwnd: isize) -> Option<(i32, i32, i32, i32)> {
        unsafe {
            let h = HWND(hwnd as *mut core::ffi::c_void);
            let mut r = RECT::default();
            GetClientRect(h, &mut r).ok()?;
            let mut p = POINT { x: 0, y: 0 };
            if !ClientToScreen(h, &mut p).as_bool() {
                return None;
            }
            Some((p.x, p.y, r.right - r.left, r.bottom - r.top))
        }
    }

    /// Mean 0..255 luma of a w x h block of the COMPOSITED desktop at (x, y).
    pub fn luma(x: i32, y: i32, w: i32, h: i32) -> f64 {
        unsafe {
            let sdc = GetDC(None);
            let mdc = CreateCompatibleDC(Some(sdc));
            let bmp = CreateCompatibleBitmap(sdc, w, h);
            let old = SelectObject(mdc, bmp.into());
            let _ = BitBlt(mdc, 0, 0, w, h, Some(sdc), x, y, SRCCOPY);
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;
            let mut buf = vec![0u8; (w * h * 4) as usize];
            GetDIBits(mdc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
            SelectObject(mdc, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mdc);
            let _ = ReleaseDC(None, sdc);
            let mut s = 0f64;
            for px in buf.chunks(4) {
                s += 0.0722 * px[0] as f64 + 0.7152 * px[1] as f64 + 0.2126 * px[2] as f64;
            }
            s / (w * h) as f64
        }
    }
}

/// Per-monitor DPI awareness so GDI and mpv agree on physical pixels.
fn dpi_aware() {
    unsafe {
        if let Ok(u) = libloading::Library::new("user32.dll") {
            type F = unsafe extern "system" fn(isize) -> i32;
            if let Ok(f) = u.get::<F>(b"SetProcessDpiAwarenessContext\0") {
                let _ = f(-4); // PER_MONITOR_AWARE_V2
            }
        }
    }
}

// ---------------------------------------------------------------------------
// vo-passes
// ---------------------------------------------------------------------------

struct Passes {
    total_avg_us: f64,
    glass_avg_us: f64,
    list: Vec<(String, f64, f64)>, // desc, avg us, peak us
}

fn passes(m: &Mpv) -> Option<Passes> {
    let s = m.get_str("vo-passes")?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let fresh = v.get("fresh")?.as_array()?;
    let mut out = Passes { total_avg_us: 0.0, glass_avg_us: 0.0, list: Vec::new() };
    for p in fresh {
        let desc = p.get("desc").and_then(|d| d.as_str()).unwrap_or("?").to_string();
        let avg = p.get("avg").and_then(|d| d.as_f64()).unwrap_or(0.0) / 1000.0;
        let peak = p.get("peak").and_then(|d| d.as_f64()).unwrap_or(0.0) / 1000.0;
        if !desc.starts_with("upload frame") {
            out.total_avg_us += avg;
        }
        if desc.contains("aura glass") {
            out.glass_avg_us += avg;
        }
        out.list.push((desc, avg, peak));
    }
    Some(out)
}

fn print_passes(label: &str, p: &Option<Passes>, full: bool) {
    match p {
        None => println!("  {label}: vo-passes unavailable"),
        Some(p) => {
            println!(
                "  {label}: render total (excl. upload) {:.1} us/frame over {} passes, aura glass {:.1} us",
                p.total_avg_us,
                p.list.len(),
                p.glass_avg_us
            );
            for (d, a, pk) in &p.list {
                if full || d.contains("aura glass") {
                    println!("      {a:>8.1} us avg {pk:>8.1} us peak  {d}");
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------

fn log_between(log: &str, from: &str, to: &str) -> String {
    let a = log.find(&format!("AURA-MARK {from}")).unwrap_or(0);
    let b = log[a..].find(&format!("AURA-MARK {to}")).map(|i| a + i).unwrap_or(log.len());
    log[a..b].to_string()
}

fn log_counts(seg: &str) -> String {
    let c = |pat: &str| seg.lines().filter(|l| l.contains(pat)).count();
    format!(
        "parses(Registering named parameter 'glass_n')={} glsl->spirv compiles={} resets(Render options updated)={} hook-disabled={}",
        c("Registering named parameter 'glass_n'"),
        c("translating GLSL to SPIR-V"),
        c("Render options updated"),
        c("Failed executing hook"),
    )
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

const SRC_MOTION: &str = "av://lavfi:testsrc2=s=1920x1080:r=60";
const SRC_43: &str = "av://lavfi:testsrc2=s=1440x1080:r=60";
const SRC_SCOPE: &str = "av://lavfi:testsrc2=s=1920x804:r=60";
const SRC_SMALL: &str = "av://lavfi:testsrc2=s=960x540:r=30";
const SRC_GRAY: &str = "av://lavfi:color=c=0xB0B0B0:s=1920x1080:r=60";
// Two flat levels: left 0x80, right 0xD0 (luma only, so any matrix keeps it grey).
const SRC_TWO: &str =
    "av://lavfi:color=c=0x808080:s=1920x1080:r=60,drawbox=x=960:y=0:w=960:h=1080:color=0xD0D0D0:t=fill";
const SRC_TWO_PQ: &str = "av://lavfi:color=c=0x808080:s=1920x1080:r=60,drawbox=x=960:y=0:w=960:h=1080:color=0xD0D0D0:t=fill,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc";

#[test]
#[ignore]
fn glass_shader_runtime() {
    dpi_aware();
    let out: PathBuf = std::env::var_os("AURA_GLASS_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("aura-glass-test"));
    std::fs::create_dir_all(&out).unwrap();
    let fwd = |p: &Path| p.to_string_lossy().replace('\\', "/");

    // The shader, plus two deliberately broken copies.
    let good = out.join(format!("{SHADER_NAME}.glsl"));
    std::fs::write(&good, SHADER_SRC).unwrap();
    let parse_bad = out.join("aura_glass_parsebad.glsl");
    std::fs::write(&parse_bad, SHADER_SRC.replacen("//!TYPE int", "//!TYPE vec2", 1)).unwrap();
    let glsl_bad = out.join("aura_glass_glslbad.glsl");
    std::fs::write(
        &glsl_bad,
        SHADER_SRC.replacen("vec4 orig = HOOKED_tex(HOOKED_pos);", "vec4 orig = HOOKED_tex(HOOKED_pos) + no_such_symbol;", 1),
    )
    .unwrap();
    let log_path = out.join("mpv-glass.log");
    let _ = std::fs::remove_file(&log_path);

    let opts: Vec<(&str, String)> = vec![
        ("vo", "gpu-next".into()),
        ("gpu-api", "d3d11".into()),
        ("hwdec", "auto".into()),
        ("keepaspect", "yes".into()),
        ("background", "none".into()),
        ("d3d11-output-format", "rgb10_a2".into()),
        ("force-window", "yes".into()),
        ("idle", "yes".into()),
        ("keep-open", "yes".into()),
        ("audio", "no".into()),
        ("border", "no".into()),
        ("ontop", "yes".into()),
        ("geometry", "1920x1080+40+40".into()),
        ("osd-level", "0".into()),
        ("input-default-bindings", "no".into()),
        ("screenshot-format", "png".into()),
        ("screenshot-high-bit-depth", "yes".into()),
        ("gpu-shader-cache", "no".into()),
        // Aura's "sdr" HDR-mode set (player.rs apply_hdr_options): without it
        // mpv's default hint picks a PQ target on an HDR desktop even for SDR.
        ("target-colorspace-hint", "no".into()),
        ("target-colorspace-hint-strict", "yes".into()),
        ("target-contrast", "auto".into()),
        ("target-prim", "bt.709".into()),
        ("target-trc", "bt.1886".into()),
        ("target-peak", "203".into()),
        ("hdr-compute-peak", "yes".into()),
        ("tone-mapping", "mobius".into()),
        ("log-file", fwd(&log_path)),
        ("msg-level", "all=v,vo=debug".into()),
    ];
    let m = unsafe { Mpv::new(&opts) }.expect("libmpv instance");
    let mut fails: Vec<String> = Vec::new();

    println!("\n=== aura glass runtime test ===");
    println!("mpv: {:?}", m.get_str("mpv-version"));
    println!("output: {}", out.display());

    // ---- 1. placement --------------------------------------------------
    println!("\n[1] placement (window-mode screenshots, 1920x1080, paused)");
    assert!(m.load(SRC_MOTION), "lavfi source did not load");
    m.pump(800, None);
    println!("  current-vo={:?} osd={:?}", m.get_str("current-vo"), m.osd());
    m.cmd(&["change-list", "glsl-shaders", "append", &fwd(&good)]).unwrap();
    m.set_glass(&Glass::default()).unwrap();
    m.set_str("pause", "yes").unwrap();
    m.pump(600, None);
    let base = out.join("01-base.png");
    m.shot(&base, "window").unwrap();
    let bar = GRect::new(410.0, 880.0, 1100.0, 150.0, 24.0);
    let menu = GRect::new(1300.0, 380.0, 360.0, 440.0, 24.0);
    let g2 = Glass { ow: 1920.0, ..Glass::with(&[bar, menu]) };
    m.set_glass(&g2).unwrap();
    let glass = out.join("02-glass-bar-menu.png");
    m.shot(&glass, "window").unwrap();
    let check_place = |a: &Path, b: &Path, rects: &[GRect], off: (f64, f64), label: &str, fails: &mut Vec<String>| {
        let (Some(ia), Some(ib)) = (Img::open(a), Img::open(b)) else {
            fails.push(format!("{label}: screenshot unreadable"));
            return;
        };
        let mask = diff_mask(&ia, &ib, 2.0 / 255.0);
        let (all_on, all_tot) = count_in(&mask, ia.w, ia.h, (0, 0, ia.w as i64, ia.h as i64));
        println!("  {label}: {}x{}, changed {all_on}/{all_tot} px", ia.w, ia.h);
        let mut inside = 0usize;
        for (i, r) in rects.iter().enumerate() {
            let (x0, y0) = ((r.x + off.0).round() as i64, (r.y + off.1).round() as i64);
            let (x1, y1) = (x0 + r.w.round() as i64, y0 + r.h.round() as i64);
            let bb = bbox_in(&mask, ia.w, ia.h, (x0 - 40, y0 - 40, x1 + 40, y1 + 40));
            let (on, tot) = count_in(&mask, ia.w, ia.h, (x0 + 3, y0 + 3, x1 - 3, y1 - 3));
            inside += count_in(&mask, ia.w, ia.h, (x0 - 1, y0 - 1, x1 + 1, y1 + 1)).0;
            match bb {
                Some(bb) => {
                    let err = [(bb.0 - x0).abs(), (bb.1 - y0).abs(), (bb.2 - x1).abs(), (bb.3 - y1).abs()];
                    println!(
                        "    rect{i} want ({x0},{y0})-({x1},{y1}) got ({},{})-({},{}) edge err {:?} px, interior changed {on}/{tot}",
                        bb.0, bb.1, bb.2, bb.3, err
                    );
                    if err.iter().any(|e| *e > 2) {
                        fails.push(format!("{label} rect{i}: edge error {err:?}"));
                    }
                }
                None => {
                    println!("    rect{i} want ({x0},{y0})-({x1},{y1}): NO CHANGE");
                    fails.push(format!("{label} rect{i}: no glass"));
                }
            }
        }
        let stray = all_on.saturating_sub(inside);
        println!("    changed px outside the rects (+1 px): {stray}");
        if stray > 0 {
            fails.push(format!("{label}: {stray} px changed outside the rects"));
        }
    };
    check_place(&base, &glass, &[bar, menu], (0.0, 0.0), "bar+menu", &mut fails);
    // Move the bar to the top: the y axis is not flipped.
    let bar_top = GRect::new(410.0, 60.0, 1100.0, 150.0, 24.0);
    m.set_glass(&Glass { ow: 1920.0, ..Glass::with(&[bar_top]) }).unwrap();
    let moved = out.join("03-glass-moved-top.png");
    m.shot(&moved, "window").unwrap();
    check_place(&base, &moved, &[bar_top], (0.0, 0.0), "moved-top", &mut fails);
    // A strong setting, for eyeballing the look.
    m.set_glass(&Glass { ow: 1920.0, refract: 40.0, rim: 40.0, blur: 2.0, ..Glass::with(&[bar, menu]) })
        .unwrap();
    m.shot(&out.join("04-glass-strong.png"), "window").unwrap();
    // glass_n = 0 really is a no-op.
    m.set_glass(&Glass::default()).unwrap();
    let off_png = out.join("05-glass-n0.png");
    m.shot(&off_png, "window").unwrap();
    if let (Some(a), Some(b)) = (Img::open(&base), Img::open(&off_png)) {
        let n = diff_mask(&a, &b, 1.0 / 255.0).iter().filter(|x| **x).count();
        println!("  glass_n=0 vs no shader opts: {n} px differ");
        if n > 0 {
            fails.push(format!("glass_n=0 changed {n} px"));
        }
    }

    // A detailed source to see the lens bend lines at the rim.
    if m.load("av://lavfi:testsrc=s=1920x1080:r=30") {
        m.set_str("pause", "yes").unwrap();
        m.pump(300, None);
        m.set_glass(&Glass { ow: 1920.0, blur: 0.6, refract: 30.0, rim: 36.0, ..Glass::with(&[bar, menu]) })
            .unwrap();
        m.shot(&out.join("06-showcase-grid-light-frost.png"), "window").unwrap();
        // Negative refraction samples from beyond the edge instead.
        m.set_glass(&Glass { ow: 1920.0, blur: 0.6, refract: -30.0, rim: 36.0, ..Glass::with(&[bar, menu]) })
            .unwrap();
        m.shot(&out.join("08-showcase-grid-outward.png"), "window").unwrap();
        m.set_glass(&Glass { ow: 1920.0, ..Glass::with(&[bar, menu]) }).unwrap();
        m.shot(&out.join("07-showcase-grid-default.png"), "window").unwrap();
    }

    // ---- 9. screenshot modes ------------------------------------------
    println!("\n[9] screenshot modes");
    let small = GRect::new(100.0, 100.0, 400.0, 200.0, 24.0);
    m.set_glass(&Glass { ow: 1920.0, ..Glass::with(&[small, bar]) }).unwrap();
    let _ = m.load(SRC_SMALL);
    m.set_str("pause", "yes").unwrap();
    m.pump(500, None);
    let vbase = out.join("09-video-mode-guarded.png");
    m.shot(&vbase, "video").unwrap();
    m.set_glass(&Glass { ow: 0.0, ..Glass::with(&[small, bar]) }).unwrap();
    let vunguarded = out.join("09-video-mode-unguarded.png");
    m.shot(&vunguarded, "video").unwrap();
    if let (Some(a), Some(b)) = (Img::open(&vbase), Img::open(&vunguarded)) {
        let n = diff_mask(&a, &b, 2.0 / 255.0).iter().filter(|x| **x).count();
        println!(
            "  video-mode {}x{}: guarded (glass_ow=1920) vs unguarded differ in {n} px (unguarded, a window-space rect lands on the video-size image)",
            a.w, a.h
        );
    }
    m.set_glass(&Glass { ow: 1920.0, ..Glass::with(&[small, bar]) }).unwrap();
    m.shot(&out.join("09-window-mode.png"), "window").unwrap();
    println!("  window mode: glass baked in, see 09-window-mode.png");

    // ---- 2. latency + reload check ------------------------------------
    println!("\n[2] update latency on screen (GDI capture of the composited desktop)");
    let hwnd = m.get_i64("window-id").map(|v| v as isize).filter(|v| *v != 0).unwrap_or_else(screen::find_mpv);
    let cr = screen::client_rect(hwnd);
    println!("  window-id={hwnd:#x} client(screen)={cr:?} display-fps={:?}", m.get_f64("display-fps"));
    let refresh_ms = 1000.0 / m.get_f64("display-fps").filter(|v| *v > 1.0).unwrap_or(60.0);
    if let Some((cx, cy, _, _)) = cr {
        assert!(m.load(SRC_GRAY));
        m.set_str("pause", "no").unwrap();
        let a = GRect::new(200.0, 300.0, 400.0, 300.0, 24.0);
        let b = GRect::new(1300.0, 300.0, 400.0, 300.0, 24.0);
        let probe = |r: &GRect| screen::luma(cx + (r.x + r.w / 2.0) as i32 - 4, cy + (r.y + r.h / 2.0) as i32 - 4, 8, 8);
        let t = Instant::now();
        for _ in 0..20 {
            probe(&a);
        }
        println!("  one 8x8 GDI capture: {:.2} ms", t.elapsed().as_secs_f64() * 50.0);
        // Warm-up so the first-use compile is outside the measured span.
        m.set_glass(&Glass::with(&[a])).unwrap();
        m.pump(700, None);
        let lit = probe(&b);
        let dark = probe(&a);
        println!("  probe luma: no glass {lit:.1}, under glass {dark:.1}");
        let mid = (lit + dark) / 2.0;
        let run = |label: &str, paused: bool, m: &Mpv| {
            m.set_str("pause", if paused { "yes" } else { "no" }).unwrap();
            m.pump(300, None);
            m.mark(&format!("lat-{label}-start"));
            let mut glass_ms = Vec::new();
            let mut eq_ms = Vec::new();
            for i in 0..12 {
                let to = if i % 2 == 0 { b } else { a };
                let t0 = Instant::now();
                m.set_glass(&Glass::with(&[to])).unwrap();
                let sent = t0.elapsed().as_secs_f64() * 1000.0;
                let mut on = None;
                while t0.elapsed() < Duration::from_millis(1000) {
                    if on.is_none() && probe(&to) < mid {
                        on = Some(t0.elapsed().as_secs_f64() * 1000.0);
                        break;
                    }
                }
                if let Some(v) = on {
                    glass_ms.push(v);
                }
                if i == 0 {
                    println!("    ({label}) first glass update: command returned after {sent:.2} ms");
                }
                m.pump(120, None);
            }
            m.mark(&format!("lat-{label}-eq"));
            // Comparator: a video-eq change (no render-option reset).
            m.set_glass(&Glass::default()).unwrap();
            m.pump(300, None);
            for i in 0..12 {
                let target = if i % 2 == 0 { "-35" } else { "0" };
                let t0 = Instant::now();
                m.set_str("brightness", target).unwrap();
                let base_l = if i % 2 == 0 { lit } else { -1.0 };
                while t0.elapsed() < Duration::from_millis(1000) {
                    let l = probe(&b);
                    let hit = if base_l >= 0.0 { l < mid } else { l > mid };
                    if hit {
                        eq_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
                        break;
                    }
                }
                m.pump(120, None);
            }
            m.set_str("brightness", "0").unwrap();
            m.set_glass(&Glass::with(&[a])).unwrap();
            m.pump(300, None);
            m.mark(&format!("lat-{label}-end"));
            let n = glass_ms.len();
            let (gmin, gmax) = (
                glass_ms.iter().cloned().fold(f64::INFINITY, f64::min),
                glass_ms.iter().cloned().fold(0.0, f64::max),
            );
            let gmed = median(&mut glass_ms);
            let emed = median(&mut eq_ms);
            println!(
                "    ({label}) glass opts: {n}/12 seen, median {gmed:.1} ms ({:.1} refreshes) min {gmin:.1} max {gmax:.1}; brightness: {}/12 seen, median {emed:.1} ms ({:.1} refreshes)",
                gmed / refresh_ms,
                eq_ms.len(),
                emed / refresh_ms
            );
        };
        run("playing", false, &m);
        run("paused", true, &m);
        // In-shader fade on the PTS clock: ONE opts change, no further IPC.
        for paused in [false, true] {
            m.set_str("pause", if paused { "yes" } else { "no" }).unwrap();
            m.set_glass(&Glass::default()).unwrap();
            m.pump(300, None);
            let pts = m.get_f64("time-pos").unwrap_or(0.0);
            let t0 = Instant::now();
            m.set_glass(&Glass { fade_from: 0.0, alpha: 1.0, fade_t0: pts + 0.05, fade_dur: 0.5, ..Glass::with(&[b]) })
                .unwrap();
            let mut samples: Vec<(u128, f64)> = Vec::new();
            while t0.elapsed() < Duration::from_millis(900) {
                samples.push((t0.elapsed().as_millis(), probe(&b)));
            }
            let mut line = String::new();
            for target in (0..=800).step_by(100) {
                if let Some((t, l)) = samples.iter().find(|(t, _)| *t >= target) {
                    line.push_str(&format!(" {t}ms:{l:.0}"));
                }
            }
            println!(
                "    PTS fade 0->1 over 0.5 s ({}): probe luma{line}  (no glass {lit:.0}, full glass {dark:.0})",
                if paused { "paused" } else { "playing" }
            );
        }
        // A backward seek puts PTS long before the fade start; the shader
        // must then show the fade TARGET, not snap back to fade_from (that
        // would hide the glass under visible controls after a seek-back).
        // Emulated with a t0 5 s in the future.
        m.set_str("pause", "no").unwrap();
        let pts = m.get_f64("time-pos").unwrap_or(0.0);
        m.set_glass(&Glass { fade_from: 0.0, alpha: 1.0, fade_t0: pts + 5.0, fade_dur: 0.5, ..Glass::with(&[b]) })
            .unwrap();
        m.pump(300, None);
        let after_seek = probe(&b);
        println!("    PTS 5 s before the fade start (a seek-back): probe luma {after_seek:.0} (want ~{dark:.0}, the fade target)");
        if after_seek > mid {
            fails.push(format!("fade before t0: glass hidden (luma {after_seek:.0})"));
        }
        m.set_str("pause", "no").unwrap();
    } else {
        println!("  no window handle: skipped");
    }

    // ---- 3. letterbox / pillarbox / zoom -------------------------------
    println!("\n[3] letterbox, pillarbox, zoom");
    for (label, src) in [("pillarbox-4x3", SRC_43), ("letterbox-2.39", SRC_SCOPE)] {
        assert!(m.load(src));
        m.set_str("pause", "yes").unwrap();
        m.set_glass(&Glass::default()).unwrap();
        m.pump(500, None);
        let (w, h, ml, mt, mr, mb) = m.osd();
        println!("  {label}: osd {w}x{h} ml={ml} mt={mt} mr={mr} mb={mb}");
        let b0 = out.join(format!("10-{label}-base.png"));
        m.shot(&b0, "window").unwrap();
        // Window-space rects: one straddling the left/bottom bar, one inside the video.
        let win_rects = [GRect::new(100.0, 400.0, 600.0, 200.0, 24.0), GRect::new(410.0, 900.0, 1100.0, 150.0, 24.0)];
        let (ox, oy) = (ml.max(0.0), mt.max(0.0));
        let shader_rects: Vec<GRect> =
            win_rects.iter().map(|r| GRect { x: r.x - ox, y: r.y - oy, ..*r }).collect();
        m.set_glass(&Glass::with(&shader_rects)).unwrap();
        let g0 = out.join(format!("10-{label}-glass.png"));
        m.shot(&g0, "window").unwrap();
        if let (Some(ia), Some(ib)) = (Img::open(&b0), Img::open(&g0)) {
            let mask = diff_mask(&ia, &ib, 2.0 / 255.0);
            for (i, r) in win_rects.iter().enumerate() {
                let bb = bbox_in(
                    &mask,
                    ia.w,
                    ia.h,
                    (r.x as i64 - 40, r.y as i64 - 40, (r.x + r.w) as i64 + 40, (r.y + r.h) as i64 + 40),
                );
                println!(
                    "    window rect{i} ({},{})-({},{}) -> changed box {bb:?} (video area x {}..{}, y {}..{})",
                    r.x,
                    r.y,
                    r.x + r.w,
                    r.y + r.h,
                    ml.max(0.0),
                    w - mr.max(0.0),
                    mt.max(0.0),
                    h - mb.max(0.0)
                );
            }
            let bar_px = if ml > 0.0 {
                count_in(&mask, ia.w, ia.h, (0, 0, ml as i64, ia.h as i64)).0
            } else {
                count_in(&mask, ia.w, ia.h, (0, (h - mb) as i64, ia.w as i64, ia.h as i64)).0
            };
            println!("    changed px inside the bars: {bar_px}");
            if bar_px > 0 {
                fails.push(format!("{label}: glass drew into the bars"));
            }
        }
    }
    // Zoom: dst is larger than the window, osd margins go negative.
    assert!(m.load(SRC_MOTION));
    m.set_str("pause", "yes").unwrap();
    m.set_glass(&Glass::default()).unwrap();
    m.set_str("video-zoom", "0.5").unwrap();
    m.pump(500, None);
    let (w, h, ml, mt, mr, mb) = m.osd();
    println!("  zoom 0.5: osd {w}x{h} ml={ml} mt={mt} mr={mr} mb={mb}");
    let zb = out.join("11-zoom-base.png");
    m.shot(&zb, "window").unwrap();
    let zr = GRect::new(410.0, 880.0, 1100.0, 150.0, 24.0);
    m.set_glass(&Glass::with(&[GRect { x: zr.x - ml.max(0.0), y: zr.y - mt.max(0.0), ..zr }])).unwrap();
    let zg = out.join("11-zoom-glass.png");
    m.shot(&zg, "window").unwrap();
    check_place(&zb, &zg, &[zr], (0.0, 0.0), "zoom-0.5", &mut fails);
    m.set_str("video-zoom", "0").unwrap();

    // ---- 4. GPU cost ------------------------------------------------------
    println!("\n[4] GPU cost (vo-passes, fresh frames, avg over mpv's sample window)");
    m.set_str("pause", "no").unwrap();
    let rects4 = |w: f64, h: f64| -> Vec<GRect> {
        vec![
            GRect::new(w * 0.21, h * 0.815, w * 0.573, h * 0.139, 24.0),
            GRect::new(w * 0.677, h * 0.35, w * 0.19, h * 0.41, 24.0),
            GRect::new(w * 0.05, h * 0.05, w * 0.2, h * 0.1, 16.0),
            GRect::new(w * 0.4, h * 0.05, w * 0.2, h * 0.1, 16.0),
        ]
    };
    let cost = |label: &str, m: &Mpv| {
        let (w, h, ..) = m.osd();
        let r = rects4(w, h);
        m.cmd(&["change-list", "glsl-shaders", "clr", ""]).unwrap();
        m.pump(1500, None);
        print_passes(&format!("{label} {w}x{h} no shader"), &passes(m), true);
        m.cmd(&["change-list", "glsl-shaders", "append", &fwd(&good)]).unwrap();
        m.set_glass(&Glass::default()).unwrap();
        m.pump(1500, None);
        print_passes(&format!("{label} {w}x{h} shader loaded, glass_n=0"), &passes(m), true);
        m.set_glass(&Glass::with(&r[..2])).unwrap();
        m.pump(1500, None);
        print_passes(&format!("{label} {w}x{h} 2 rects"), &passes(m), false);
        m.set_glass(&Glass::with(&r)).unwrap();
        m.pump(1500, None);
        print_passes(&format!("{label} {w}x{h} 4 rects"), &passes(m), false);
        m.set_glass(&Glass { blur: 2.0, ..Glass::with(&r[..2]) }).unwrap();
        m.pump(1500, None);
        print_passes(&format!("{label} {w}x{h} 2 rects blur=2"), &passes(m), false);
        m.cmd(&["change-list", "glsl-shaders", "clr", ""]).unwrap();
        m.pump(2500, None);
        print_passes(&format!("{label} {w}x{h} no shader (again)"), &passes(m), false);
        m.cmd(&["change-list", "glsl-shaders", "append", &fwd(&good)]).unwrap();
    };
    assert!(m.load(SRC_MOTION));
    cost("windowed", &m);
    m.set_str("fullscreen", "yes").unwrap();
    m.pump(1500, None);
    cost("fullscreen", &m);
    m.set_str("fullscreen", "no").unwrap();
    m.pump(1000, None);
    // A 3840x2160 borderless window, if Windows lets it exceed the monitor.
    let _ = m.set_str("geometry", "3840x2160+0+0");
    m.pump(1500, None);
    let (w4, h4, ..) = m.osd();
    if w4 >= 3800.0 {
        cost("4k-window", &m);
    } else {
        println!("  3840x2160 window not granted (got {w4}x{h4}); 4K is extrapolated from the fullscreen run");
    }
    let _ = m.set_str("geometry", "1920x1080+40+40");
    m.pump(1200, None);

    // ---- 5. interpolation + flicker ---------------------------------------
    println!("\n[5] interpolation (display-resample + mitchell): counters and on-screen flicker");
    let counters = |m: &Mpv| {
        (
            m.get_i64("mistimed-frame-count").unwrap_or(-1),
            m.get_i64("vo-delayed-frame-count").unwrap_or(-1),
            m.get_i64("frame-drop-count").unwrap_or(-1),
        )
    };
    m.set_str("video-sync", "display-resample").unwrap();
    m.set_str("tscale", "mitchell").unwrap();
    m.set_str("interpolation", "yes").unwrap();
    let interp_phase = |label: &str, src: &str, m: &Mpv, probe_pt: Option<(i32, i32)>| {
        assert!(m.load(src));
        m.set_str("pause", "no").unwrap();
        m.set_glass(&Glass::with(&[GRect::new(200.0, 300.0, 400.0, 300.0, 24.0)])).unwrap();
        m.pump(2500, None);
        println!(
            "  {label}: display-sync-active={:?} interpolation={:?} video-sync={:?} target-gamma={:?}",
            m.get_str("display-sync-active"),
            m.get_str("interpolation"),
            m.get_str("video-sync"),
            m.get_str("video-target-params/gamma")
        );
        let sample = |dur_ms: u64, act: &dyn Fn(usize), m: &Mpv| -> ((i64, i64, i64), f64, f64) {
            let c0 = counters(m);
            let t0 = Instant::now();
            let mut i = 0usize;
            let mut next = Instant::now();
            let mut lum: Vec<f64> = Vec::new();
            while t0.elapsed() < Duration::from_millis(dur_ms) {
                if Instant::now() >= next {
                    act(i);
                    i += 1;
                    next = Instant::now() + Duration::from_millis(150);
                }
                if let Some((px, py)) = probe_pt {
                    lum.push(screen::luma(px, py, 8, 8));
                } else {
                    m.pump(5, None);
                }
            }
            let c1 = counters(m);
            let med = median(&mut lum.clone());
            let dev = lum.iter().map(|l| (l - med).abs()).fold(0.0, f64::max);
            ((c1.0 - c0.0, c1.1 - c0.1, c1.2 - c0.2), med, dev)
        };
        let gl = |i: usize| {
            let x = if i % 2 == 0 { 1300.0 } else { 200.0 };
            let _ = m.set_glass(&Glass::with(&[GRect::new(x, 300.0, 400.0, 300.0, 24.0)]));
        };
        let eq = |i: usize| {
            let _ = m.set_str("contrast", if i % 2 == 0 { "1" } else { "0" });
        };
        let idle = |_: usize| {};
        m.mark(&format!("interp-{label}-start"));
        let (ci, mi, di) = sample(3000, &idle, m);
        m.mark(&format!("interp-{label}-eq"));
        let (ce, me, de) = sample(3000, &eq, m);
        let _ = m.set_str("contrast", "0");
        m.mark(&format!("interp-{label}-glass"));
        let (cg, mg, dg) = sample(3000, &gl, m);
        m.mark(&format!("interp-{label}-end"));
        println!("    counters (mistimed, vo-delayed, drops) over 3 s, actions every 150 ms:");
        println!("      idle                 {ci:?}  probe median {mi:.1} max dev {di:.1}");
        println!("      contrast 0<->1 (eq)  {ce:?}  probe median {me:.1} max dev {de:.1}");
        println!("      glass rect moves     {cg:?}  probe median {mg:.1} max dev {dg:.1}");
    };
    // Left half of SRC_TWO (flat 0x80), outside every rect used below.
    let probe_out = cr.map(|(cx, cy, _, _)| (cx + 480, cy + 120));
    interp_phase("sdr-motion", SRC_MOTION, &m, None);
    interp_phase("sdr-flat", SRC_TWO, &m, probe_out);
    let log_now = std::fs::read_to_string(&log_path).unwrap_or_default();
    for l in ["sdr-motion", "sdr-flat"] {
        println!(
            "    log {l} glass span: {}",
            log_counts(&log_between(&log_now, &format!("interp-{l}-glass"), &format!("interp-{l}-end")))
        );
    }

    // ---- 6. HDR passthrough -----------------------------------------------
    println!("\n[6] HDR: SDR target vs PQ passthrough (two flat levels, glass over each)");
    let left = GRect::new(200.0, 300.0, 500.0, 400.0, 24.0);
    let right = GRect::new(1220.0, 300.0, 500.0, 400.0, 24.0);
    let hdr_probe = |label: &str, src: &str, pq_target: bool, m: &Mpv| {
        assert!(m.load(src));
        m.set_str("pause", "yes").unwrap();
        m.set_glass(&Glass::default()).unwrap();
        m.pump(800, None);
        println!(
            "  {label}: video gamma={:?} target gamma={:?} target prim={:?} target peak={:?}",
            m.get_str("video-params/gamma"),
            m.get_str("video-target-params/gamma"),
            m.get_str("video-target-params/primaries"),
            m.get_str("video-target-params/sig-peak"),
        );
        let b = out.join(format!("12-{label}-base.png"));
        m.shot(&b, "window").unwrap();
        for pq in [0, 1] {
            let gpath = out.join(format!("12-{label}-glass-pq{pq}.png"));
            m.set_glass(&Glass { pq, ..Glass::with(&[left, right]) }).unwrap();
            m.shot(&gpath, "window").unwrap();
            let (Some(ib), Some(ig)) = (Img::open(&b), Img::open(&gpath)) else {
                println!("    screenshot unreadable");
                continue;
            };
            for (name, r) in [("left 0x80", left), ("right 0xD0", right)] {
                let (cx, cy) = ((r.x + r.w / 2.0) as i64, (r.y + r.h / 2.0) as i64);
                let e0 = ib.mean(cx - 20, cy - 20, cx + 20, cy + 20)[1];
                let e1 = ig.mean(cx - 20, cy - 20, cx + 20, cy + 20)[1];
                if pq_target {
                    let (l0, l1) = (pq_eotf(e0), pq_eotf(e1));
                    println!(
                        "    glass_pq={pq} {name}: code {e0:.4} -> {e1:.4}, PQ-decoded {l0:.1} -> {l1:.1} nits, linear ratio {:.3}",
                        l1 / l0.max(1e-9)
                    );
                } else {
                    println!(
                        "    glass_pq={pq} {name}: code {e0:.4} -> {e1:.4}, encoded ratio {:.3} (0.8^(1/2.4) = {:.3})",
                        e1 / e0.max(1e-9),
                        0.8f64.powf(1.0 / 2.4)
                    );
                }
            }
        }
        if !pq_target {
            // The SDR path with each style's real look (glass::look: dim,
            // cap, lift, sat): the flat grays carry no chroma, so sat is
            // irrelevant here, and the lift is neutral.
            for style in [GlassStyle::Frosted, GlassStyle::Liquid] {
                let lk = super::glass::look(style, 1.0);
                let gpath = out.join(format!("12-{label}-glass-cap-{style:?}.png"));
                m.set_glass(&Glass {
                    dim: lk.dim,
                    cap: lk.cap,
                    lift: lk.lift,
                    sat: lk.sat,
                    ..Glass::with(&[left, right])
                })
                .unwrap();
                m.shot(&gpath, "window").unwrap();
                if let (Some(ib), Some(ig)) = (Img::open(&b), Img::open(&gpath)) {
                    for (name, r) in [("left 0x80", left), ("right 0xD0", right)] {
                        let (cx, cy) = ((r.x + r.w / 2.0) as i64, (r.y + r.h / 2.0) as i64);
                        let e0 = ib.mean(cx - 20, cy - 20, cx + 20, cy + 20)[1];
                        let e1 = ig.mean(cx - 20, cy - 20, cx + 20, cy + 20)[1];
                        let want = sdr_capped(e0, lk.dim, lk.cap, lk.lift, 2.4);
                        println!(
                            "    {style:?} dim={} cap={} lift={} {name}: code {e0:.4} -> {e1:.4} (model {want:.4})",
                            lk.dim, lk.cap, lk.lift
                        );
                    }
                } else {
                    println!("    screenshot unreadable");
                }
            }
        }
    };
    hdr_probe("sdr", SRC_TWO, false, &m);
    // Aura's passthrough set (player.rs apply_hdr_options "passthrough"), set between files.
    for (k, v) in [
        ("target-colorspace-hint", "yes"),
        ("target-colorspace-hint-strict", "no"),
        ("target-prim", "bt.2020"),
        ("target-trc", "pq"),
        ("target-contrast", "inf"),
        ("hdr-compute-peak", "yes"),
        ("tone-mapping", "auto"),
        ("target-peak", "auto"),
    ] {
        if let Err(e) = m.set_str(k, v) {
            println!("  {k}={v}: {e}");
        }
    }
    let _ = m.cmd(&["stop"]);
    m.pump(300, None);
    hdr_probe("pq", SRC_TWO_PQ, true, &m);
    if probe_out.is_some() {
        // Peak-detection restart check: a flat PQ field, glass moves, interpolation on.
        interp_phase("pq-flat", SRC_TWO_PQ, &m, probe_out);
        // Same with peak detection off, to attribute the delayed frames.
        m.set_str("hdr-compute-peak", "no").unwrap();
        interp_phase("pq-flat-nopeak", SRC_TWO_PQ, &m, probe_out);
        m.set_str("hdr-compute-peak", "yes").unwrap();
        // And with interpolation off (Aura's other setting).
        m.set_str("interpolation", "no").unwrap();
        m.set_str("video-sync", "audio").unwrap();
        interp_phase("pq-flat-no-interp", SRC_TWO_PQ, &m, probe_out);
    }
    for (k, v) in [
        ("target-colorspace-hint", "no"),
        ("target-colorspace-hint-strict", "yes"),
        ("target-prim", "bt.709"),
        ("target-trc", "bt.1886"),
        ("target-contrast", "auto"),
        ("target-peak", "203"),
        ("tone-mapping", "mobius"),
    ] {
        let _ = m.set_str(k, v);
    }
    m.set_str("interpolation", "no").unwrap();
    m.set_str("video-sync", "audio").unwrap();
    let _ = m.cmd(&["stop"]);
    m.pump(300, None);

    // ---- 7. with an upscaler chain ----------------------------------------
    println!("\n[7] Anime4K Mode A chain + glass appended last");
    let sdir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/shaders"));
    let chain = [
        "Anime4K_Clamp_Highlights.glsl",
        "Anime4K_Restore_CNN_VL.glsl",
        "Anime4K_Upscale_CNN_x2_VL.glsl",
        "Anime4K_AutoDownscalePre_x2.glsl",
        "Anime4K_AutoDownscalePre_x4.glsl",
        "Anime4K_Upscale_CNN_x2_M.glsl",
    ];
    if chain.iter().all(|f| sdir.join(f).exists()) {
        assert!(m.load(SRC_SMALL));
        m.set_str("pause", "no").unwrap();
        m.cmd(&["change-list", "glsl-shaders", "clr", ""]).unwrap();
        for (i, f) in chain.iter().enumerate() {
            let op = if i == 0 { "set" } else { "append" };
            m.cmd(&["change-list", "glsl-shaders", op, &fwd(&sdir.join(f))]).unwrap();
        }
        m.cmd(&["change-list", "glsl-shaders", "append", &fwd(&good)]).unwrap();
        m.set_glass(&Glass::default()).unwrap();
        m.pump(2500, None);
        print_passes("Mode A, glass_n=0", &passes(&m), true);
        m.set_glass(&Glass::with(&[bar, menu])).unwrap();
        m.mark("a4k-glass-start");
        m.pump(2000, None);
        m.mark("a4k-glass-end");
        print_passes("Mode A, 2 rects", &passes(&m), true);
        m.set_str("pause", "yes").unwrap();
        m.pump(300, None);
        m.set_glass(&Glass::default()).unwrap();
        let ab = out.join("13-anime4k-base.png");
        m.shot(&ab, "window").unwrap();
        m.set_glass(&Glass::with(&[bar, menu])).unwrap();
        let ag = out.join("13-anime4k-glass.png");
        m.shot(&ag, "window").unwrap();
        check_place(&ab, &ag, &[bar, menu], (0.0, 0.0), "anime4k+glass", &mut fails);
        // What cinema.rs set_shader_profile does on a profile switch.
        m.cmd(&["change-list", "glsl-shaders", "clr", ""]).unwrap();
        for (i, f) in chain.iter().enumerate() {
            let op = if i == 0 { "set" } else { "append" };
            m.cmd(&["change-list", "glsl-shaders", op, &fwd(&sdir.join(f))]).unwrap();
        }
        let list = m.get_str("glsl-shaders").unwrap_or_default();
        println!(
            "  after clr + profile re-apply: glass still in glsl-shaders = {}; glsl-shader-opts kept = {}",
            list.contains(SHADER_NAME),
            m.get_str("glsl-shader-opts").map(|s| s.contains("glass_n=2")).unwrap_or(false)
        );
        let log_now = std::fs::read_to_string(&log_path).unwrap_or_default();
        println!("  log while glass ran on top of Mode A: {}", log_counts(&log_between(&log_now, "a4k-glass-start", "a4k-glass-end")));
    } else {
        println!("  skipped: Anime4K files not present in {}", sdir.display());
    }

    // ---- 8. failure modes -------------------------------------------------
    println!("\n[8] failure modes");
    assert!(m.load(SRC_MOTION));
    m.set_str("pause", "yes").unwrap();
    m.cmd(&["change-list", "glsl-shaders", "clr", ""]).unwrap();
    m.set_glass(&Glass::default()).unwrap();
    m.pump(400, None);
    let fb = out.join("14-fail-base.png");
    m.shot(&fb, "window").unwrap();
    let missing = out.join("does_not_exist.glsl");
    for (label, path) in [("parse-error", &parse_bad), ("glsl-error", &glsl_bad), ("missing-file", &missing)] {
        m.mark(&format!("fail-{label}-start"));
        m.cmd(&["change-list", "glsl-shaders", "set", &fwd(path)]).unwrap();
        // Keys for every name: the broken copies have other basenames.
        let g = Glass::with(&[bar, menu]);
        let opts_any = g.opts().replace(&format!("{SHADER_NAME}/"), "");
        m.cmd(&["change-list", "glsl-shader-opts", "add", &opts_any]).unwrap();
        m.set_str("pause", "no").unwrap();
        m.pump(800, None);
        m.set_str("pause", "yes").unwrap();
        m.pump(300, None);
        let p = out.join(format!("14-fail-{label}.png"));
        m.shot(&p, "window").unwrap();
        m.mark(&format!("fail-{label}-end"));
        let ps = passes(&m);
        let glass_passes = ps.as_ref().map(|p| p.list.iter().filter(|x| x.0.contains("aura glass")).count());
        let mean = Img::open(&p).map(|i| i.mean(0, 0, i.w as i64, i.h as i64)[1]).unwrap_or(-1.0);
        let log_now = std::fs::read_to_string(&log_path).unwrap_or_default();
        let seg = log_between(&log_now, &format!("fail-{label}-start"), &format!("fail-{label}-end"));
        let errs: Vec<&str> = seg
            .lines()
            .filter(|l| l.contains("[e]") || l.contains("[w]"))
            .filter(|l| !l.contains("AURA-MARK"))
            .take(6)
            .collect();
        println!("  {label}: picture mean green {mean:.3} (video still renders if > 0), glass passes in vo-passes {glass_passes:?}");
        for e in errs {
            println!("      log: {}", e.trim());
        }
        m.cmd(&["change-list", "glsl-shader-opts", "clr", ""]).unwrap();
    }
    // The good shader still works after the failures (fresh base: the
    // failure runs above advanced the clip).
    m.cmd(&["change-list", "glsl-shaders", "set", &fwd(&good)]).unwrap();
    m.set_glass(&Glass::default()).unwrap();
    let fb = out.join("14-fail-base-after.png");
    m.shot(&fb, "window").unwrap();
    m.set_glass(&Glass::with(&[bar, menu])).unwrap();
    let after = out.join("14-good-after-failures.png");
    m.shot(&after, "window").unwrap();
    check_place(&fb, &after, &[bar, menu], (0.0, 0.0), "good-after-failures", &mut fails);

    // ---- log summary ------------------------------------------------------
    let log_all = std::fs::read_to_string(&log_path).unwrap_or_default();
    println!("\n[log] latency spans:");
    for l in ["playing", "paused"] {
        println!(
            "  {l} glass updates (12): {}",
            log_counts(&log_between(&log_all, &format!("lat-{l}-start"), &format!("lat-{l}-eq")))
        );
        println!(
            "  {l} brightness changes (12): {}",
            log_counts(&log_between(&log_all, &format!("lat-{l}-eq"), &format!("lat-{l}-end")))
        );
    }
    println!("  whole run: {}", log_counts(&log_all));
    println!("  mpv log: {}", log_path.display());

    drop(m);
    if !fails.is_empty() {
        panic!("glass checks failed:\n  {}", fails.join("\n  "));
    }
}
