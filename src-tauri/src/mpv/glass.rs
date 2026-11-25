// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv/glass.rs`: "Real glass over video" (opt-in, experimental,
//! machine-local; `AppSettings::real_glass`).
//!
//! The video is a native mpv child window UNDER the WebView2, so a CSS
//! `backdrop-filter` on a player surface samples nothing. This feature moves
//! the blur, the darken and (in the Liquid style) the rim refraction into an
//! mpv user shader on the OUTPUT stage (`aura_glass.glsl`, embedded here),
//! which draws them into the video itself under up to [`MAX_RECTS`] rounded
//! rectangles: the bottom control bar and any open docked player menu. The
//! web layer keeps drawing the rim, the shading and the content on top.
//!
//! This file holds the pure half: projection from CSS to mpv OUTPUT pixels,
//! the full parameter string, and the state machine the engine thread drives
//! (`engine.rs`, `EngineCommand::Glass`). The rules it follows were measured
//! by the ignored runtime test (`glass_shader_tests.rs`) and are written up
//! in `.claude/rules/mpv.md` ("Real glass over video"):
//!
//! 1. The shader is written to `app_data_dir()/shaders/aura_glass_v3.glsl`
//!    and APPENDED LAST with `change-list glsl-shaders append` (never
//!    `set_property`, landmine 8). Its basename is the option-key prefix
//!    (`aura_glass_v3/glass_n=...`), and mpv caches a parsed shader by PATH
//!    for the life of the VO, so a changed shader needs a new versioned name
//!    ([`SHADER_NAME`]) together with its key prefix. `cinema.rs` clears the
//!    list on every upscaler change, so the engine re-appends after a `clr`.
//! 2. Parameters go as ONE `change-list glsl-shader-opts add` with the FULL
//!    key set (mpv resets every parameter it is not given). Every update
//!    resets mpv's renderer (one late frame with HDR + interpolation), so an
//!    update is sent only on a state change, deduplicated against the last
//!    string, never per frame, and the glass is turned off (n=0) while the
//!    window is being resized or switching fullscreen.
//! 3. Sent with `mpv_command_async` (the synchronous form parks the engine
//!    thread 6 to 9 ms on the VO while playing, landmine 11).
//! 4. Coordinates: physical px relative to the clipped video rect,
//!    `x = css_x*dpr - max(ml,0)`, `y = css_y*dpr - inset - max(mt,0)`.
//! 5. The in-shader fade runs on source PTS, which freezes while paused, so
//!    a hide while paused is immediate and a show always snaps in.
//! 6. Screenshots bake the glass in: the engine sends n=0 around one.
//! 7. A shader the GPU cannot run is silently disabled by libplacebo, so the
//!    engine checks `vo-passes` for the composite pass and gives up cleanly.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The shader source, embedded so the feature never depends on a bundled
/// resource (`src-tauri/shaders/*.glsl` is git-ignored third-party content).
pub const SHADER_SRC: &str = include_str!("aura_glass.glsl");

/// Basename of the written shader file, which is ALSO the option-key prefix.
/// Bump the version (file name and prefix together) whenever the shader
/// changes: mpv keeps the parsed copy of a path for the VO's lifetime.
pub const SHADER_NAME: &str = "aura_glass_v3";

/// The shader's rect slots.
pub const MAX_RECTS: usize = 4;

/// `reply_userdata` of every glass `mpv_command_async`, so the engine's
/// event drain can tell their COMMAND_REPLY events apart.
pub const REPLY_ID: u64 = 0x4155_5241_474C_4153; // "AURAGLAS"

/// `//!DESC` of the full-resolution pass; its presence in `vo-passes` is the
/// proof that the shader runs on this GPU.
pub const COMPOSITE_PASS: &str = "aura glass composite";

/// Hide fade, wall seconds (scaled by the playback speed into source PTS).
/// Matched to the bar's 500 ms CSS opacity fade (it starts 30 ms late, see
/// `update`), so the bar's text never fades out over raw, undimmed video.
const FADE_S: f64 = 0.47;
/// After the fade, the rects are dropped (n=0) so a hidden bar costs no GPU.
/// The surfaces keep their light face until then (the bar is invisible by
/// that point, so the fill coming back is never seen).
const CLEAR_AFTER: Duration = Duration::from_millis(500 + 250);
/// How long the window geometry must hold still before the glass returns.
const SUSPEND: Duration = Duration::from_millis(250);
/// First `vo-passes` check after the glass went live, and the retry spacing.
const VERIFY_DELAY: Duration = Duration::from_millis(1500);
/// Checks before the feature is declared unavailable on this system.
const VERIFY_ATTEMPTS: u8 = 3;
/// Back-off for a failed (gated) property read.
const READ_RETRY: Duration = Duration::from_millis(250);
/// Wait after a zoom / pan / panscan write before re-reading the video rect.
const RECHECK_DELAY: Duration = Duration::from_millis(120);
/// Wait after a load / VIDEO_RECONFIG before reading the video rect:
/// `osd-dimensions` come from the last OSD render, so a read in the tick of
/// the event returns the PREVIOUS geometry until a frame at the new one has
/// been drawn.
const AREA_DELAY: Duration = Duration::from_millis(150);
/// Wait after a `target-*` / tone-mapping write before reading
/// `video-target-params`: vo_gpu_next updates it only after it has drawn a
/// frame with the new options, so a same-tick read sees the OLD transfer.
const TARGET_DELAY: Duration = Duration::from_millis(250);

/// True once the composite pass was found missing (`vo-passes`): the GPU
/// cannot run the shader. Process-lifetime; turning the setting off and on
/// again retries. Read by the `player_glass` status action.
static UNAVAILABLE: AtomicBool = AtomicBool::new(false);

pub fn is_unavailable() -> bool {
    UNAVAILABLE.load(Ordering::Acquire)
}

fn set_unavailable(v: bool) {
    UNAVAILABLE.store(v, Ordering::Release);
}

/// A glass surface as the frontend measured it: CSS px from the webview's
/// top-left (which is the main window's client top-left), plus its corner
/// radius in CSS px.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub r: f64,
}

/// The DRAWN glass material (`<html data-glass>`): Frosted is blur only,
/// Liquid adds a subtle inward rim refraction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GlassStyle {
    #[default]
    Frosted,
    Liquid,
}

/// The clipped video destination rect inside mpv's window (the OUTPUT
/// texture), from `osd-dimensions`. `ml` / `mt` are already `max(.,0)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VideoArea {
    pub ml: f64,
    pub mt: f64,
    pub ow: f64,
    pub oh: f64,
}

impl VideoArea {
    /// From the six `osd-dimensions` sub-properties. The margins go negative
    /// under video-zoom / pan while the destination is clipped at 0, hence
    /// the `max(.,0)` on every one of them.
    pub fn from_osd(w: f64, h: f64, ml: f64, mt: f64, mr: f64, mb: f64) -> Option<VideoArea> {
        if ![w, h, ml, mt, mr, mb].iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 {
            return None;
        }
        let (ml, mt) = (ml.max(0.0), mt.max(0.0));
        let ow = w - ml - mr.max(0.0);
        let oh = h - mt - mb.max(0.0);
        if ow < 1.0 || oh < 1.0 {
            return None;
        }
        Some(VideoArea { ml, mt, ow, oh })
    }
}

/// The live output transfer (`video-target-params/gamma`). The shader
/// darkens in linear light, so it must know what it is decoding.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub pq: bool,
    pub gamma: f64,
}

impl Target {
    pub const DEFAULT: Target = Target { pq: false, gamma: 2.2 };

    pub fn from_gamma(s: &str) -> Target {
        match s.trim() {
            "pq" => Target { pq: true, gamma: 2.2 },
            "bt.1886" => Target { pq: false, gamma: 2.4 },
            _ => Target::DEFAULT,
        }
    }
}

/// One rect in physical px relative to the clipped video rect.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhysRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub r: f64,
}

/// CSS px (webview) -> physical px relative to the OUTPUT texture. `inset`
/// is the engine host's top offset in PHYSICAL px (36 windowed, 0 in
/// fullscreen): `TITLE_BAR_H` is applied to `GetClientRect`, which is
/// physical, so it is NOT multiplied by the DPR.
pub fn project(r: &CssRect, dpr: f64, inset: f64, a: &VideoArea) -> PhysRect {
    PhysRect {
        x: r.x * dpr - a.ml,
        y: r.y * dpr - inset - a.mt,
        w: r.w * dpr,
        h: r.h * dpr,
        r: r.r * dpr,
    }
}

/// Share of `p` that lies over the video (0..1).
pub fn overlap_frac(p: &PhysRect, a: &VideoArea) -> f64 {
    let area = p.w * p.h;
    if area <= 0.0 {
        return 0.0;
    }
    let iw = (p.x + p.w).min(a.ow) - p.x.max(0.0);
    let ih = (p.y + p.h).min(a.oh) - p.y.max(0.0);
    if iw <= 0.0 || ih <= 0.0 {
        return 0.0;
    }
    (iw * ih / area).clamp(0.0, 1.0)
}

/// The material's look, in the shader's units. Blur taps and rim widths
/// scale with the DPR so the frost looks the same at 150 %.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// Linear-light multiplier before the cap (1.0 = dark and mid pass
    /// through at their own level).
    pub dim: f64,
    /// Luminance soft cap, linear, relative to SDR white (PQ: x white nits):
    /// what keeps white text legible over a bright frame.
    pub cap: f64,
    /// Additive white lift after the cap (linear, x SDR white): the
    /// lit-material lift. A white frame ends at `cap + lift * (1 - cap)`.
    pub lift: f64,
    /// Saturation lift (CSS `saturate()`), 1 = unchanged.
    pub sat: f64,
    pub blur: f64,
    pub refract: f64,
    pub rim: f64,
}

pub fn look(style: GlassStyle, dpr: f64) -> Look {
    let k = if dpr.is_finite() { dpr.clamp(0.5, 4.0) } else { 1.0 };
    match style {
        // Blur, a faint lift and a saturation lift: the frosted pane. No
        // dim: dark and mid frames pass at their own level under the flat
        // 0.045 black CSS face in glass-misc.css. The cap holds a WHITE
        // frame near 0.15 linear (about 103/255 encoded at 2.2 with the
        // face, 111 at bt.1886), which keeps white text at about 5.6:1
        // (5.0:1 bt.1886) on a pure white frame, before the tight text
        // shadow. 0.22 measured 123/255 and 4.2:1: too bright over light
        // content. The shader's soft cap carries the bright-frame
        // legibility; the face is only a faint tint.
        GlassStyle::Frosted => Look { dim: 1.0, cap: 0.15, lift: 0.002, sat: 1.30, blur: k.min(8.0), refract: 0.0, rim: 22.0 * k },
        // A lit material: a 0.004 white lift (black reads as about 28/255
        // encoded at 2.2 under the flat 0.03 white CSS sheen; 0.010 with a
        // 0.05..0.02 sheen gave 39, a flat mid grey over black), a stronger
        // saturation lift, a lighter frost than Frosted (k * 0.8: video
        // detail reads softened rather than erased; the pyramid's own floor
        // is about 8 px even at 0) and a subtle INWARD lens at the rim
        // (positive refract samples from inside the rect: the edge
        // magnifies what lies just inside it, like the CSS displacement on
        // the rest of the app). cap 0.14 holds a WHITE frame near 0.14
        // linear (about 110/255 with the sheen, white text about 5.1:1 at
        // 2.2 and 4.5:1 at bt.1886 before the shadow; 0.20 gave 3.8:1).
        GlassStyle::Liquid => Look { dim: 1.0, cap: 0.14, lift: 0.004, sat: 1.50, blur: (k * 0.8).min(8.0), refract: 9.0 * k, rim: 16.0 * k },
    }
}

/// Everything one `glsl-shader-opts` update carries.
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub rects: Vec<PhysRect>,
    pub ow: f64,
    pub look: Look,
    pub alpha: f64,
    pub fade_from: f64,
    pub fade_t0: f64,
    pub fade_dur: f64,
    pub target: Target,
    pub white_nits: f64,
}

impl Params {
    /// n = 0 with neutral values: every pass skipped through `WHEN`.
    pub fn off() -> Params {
        Params {
            rects: Vec::new(),
            ow: 0.0,
            look: look(GlassStyle::Frosted, 1.0),
            alpha: 1.0,
            fade_from: 1.0,
            fade_t0: 0.0,
            fade_dur: 0.0,
            target: Target::DEFAULT,
            white_nits: 203.0,
        }
    }

    /// The `change-list glsl-shader-opts add` value: EVERY key, prefixed
    /// with [`SHADER_NAME`], fixed precision so equal states compare equal.
    pub fn opts(&self) -> String {
        let p = SHADER_NAME;
        let n = self.rects.len().min(MAX_RECTS);
        let mut kv: Vec<String> = Vec::with_capacity(16 + MAX_RECTS * 6);
        kv.push(format!("{p}/glass_n={n}"));
        kv.push(format!("{p}/glass_ow={:.0}", self.ow.max(0.0)));
        kv.push(format!("{p}/glass_dim={:.3}", self.look.dim));
        kv.push(format!("{p}/glass_blur={:.3}", self.look.blur));
        kv.push(format!("{p}/glass_refract={:.2}", self.look.refract));
        kv.push(format!("{p}/glass_rim={:.2}", self.look.rim.max(0.5)));
        kv.push(format!("{p}/glass_alpha={:.3}", self.alpha));
        kv.push(format!("{p}/glass_fade_from={:.3}", self.fade_from));
        kv.push(format!("{p}/glass_fade_t0={:.3}", self.fade_t0));
        kv.push(format!("{p}/glass_fade_dur={:.3}", self.fade_dur));
        kv.push(format!("{p}/glass_pq={}", if self.target.pq { 1 } else { 0 }));
        kv.push(format!("{p}/glass_gamma={:.2}", self.target.gamma));
        kv.push(format!("{p}/glass_white_nits={:.1}", self.white_nits));
        kv.push(format!("{p}/glass_cap={:.3}", self.look.cap));
        kv.push(format!("{p}/glass_sat={:.3}", self.look.sat));
        kv.push(format!("{p}/glass_lift={:.3}", self.look.lift));
        for i in 0..MAX_RECTS {
            let r = self.rects.get(i).copied().unwrap_or(PhysRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0, r: 0.0 });
            kv.push(format!("{p}/g{i}x={:.1}", r.x));
            kv.push(format!("{p}/g{i}y={:.1}", r.y));
            kv.push(format!("{p}/g{i}w={:.1}", r.w));
            kv.push(format!("{p}/g{i}h={:.1}", r.h));
            kv.push(format!("{p}/g{i}r={:.1}", r.r));
            kv.push(format!("{p}/g{i}s=1"));
        }
        kv.join(",")
    }
}

/// The off string, built once per call site (cheap; only used on change).
pub fn off_opts() -> String {
    Params::off().opts()
}

/// What the engine knows this tick (from its own pump state).
#[derive(Clone, Copy, Debug)]
pub struct Ctx {
    /// A file is loaded and its first frame has been shown.
    pub file_ready: bool,
    /// Host top inset, physical px (36 windowed, 0 fullscreen).
    pub inset: f64,
}

/// Outcome of one `vo-passes` check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verify {
    Ok,
    Retry,
    Fail,
}

/// The fade the next update describes (source PTS seconds).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Fade {
    t0: f64,
    dur: f64,
}

/// The engine thread's glass state. Bounded: at most [`MAX_RECTS`] rects and
/// two short strings.
pub struct GlassState {
    /// Forward-slash path of the written shader while the feature is on.
    pub path: Option<String>,
    /// Whether the shader is in mpv's `glsl-shaders` list (a `clr` from the
    /// upscaler picker drops it; the engine re-appends).
    pub in_list: bool,
    /// The composite pass never ran: given up for this enable.
    pub failed: bool,
    rects: Vec<CssRect>,
    dpr: f64,
    visible: bool,
    style: GlassStyle,
    area: Option<VideoArea>,
    /// The cached video rect is not to be trusted (load, reconfig, resize,
    /// zoom / pan): the glass stays off until it is read again.
    area_dirty: bool,
    /// The video MAY have moved (a zoom / pan / panscan write): re-read, but
    /// keep using the cached rect meanwhile. The frontend's `refresh_video`
    /// nudges video-zoom there and back several times after every load, and
    /// treating each nudge as "unknown" would flicker the glass off and on.
    area_recheck: bool,
    target: Target,
    target_dirty: bool,
    next_read: Option<Instant>,
    suspend_until: Option<Instant>,
    fade: Option<Fade>,
    clear_at: Option<Instant>,
    /// Something changed since the last evaluation.
    needs_eval: bool,
    /// The last opts string sent; empty = nothing sent since enable (the
    /// shader's own defaults, n = 0).
    pub last_sent: String,
    /// Whether `last_sent` had any rect.
    pub last_active: bool,
    verify_at: Option<Instant>,
    verify_attempts: u8,
    verified: bool,
    /// After a first failed check: drop the `glass_ow` guard (0 = any width)
    /// in case the clipped width we computed differs from libplacebo's by a
    /// rounding pixel, before declaring the shader unrunnable.
    relax_ow: bool,
    /// Last state pushed to the frontend, to emit on change only.
    last_state_key: String,
}

impl Default for GlassState {
    fn default() -> Self {
        GlassState {
            path: None,
            in_list: false,
            failed: false,
            rects: Vec::new(),
            dpr: 1.0,
            visible: false,
            style: GlassStyle::Frosted,
            area: None,
            area_dirty: true,
            area_recheck: false,
            target: Target::DEFAULT,
            target_dirty: true,
            next_read: None,
            suspend_until: None,
            fade: None,
            clear_at: None,
            needs_eval: false,
            last_sent: String::new(),
            last_active: false,
            verify_at: None,
            verify_attempts: 0,
            verified: false,
            relax_ow: false,
            last_state_key: String::new(),
        }
    }
}

impl GlassState {
    pub fn enabled(&self) -> bool {
        self.path.is_some() && !self.failed
    }

    /// Turn the feature on with the written shader at `path`.
    pub fn enable(&mut self, path: String) {
        if self.path.as_deref() == Some(path.as_str()) && self.failed {
            // Already found unrunnable on this GPU: every player mount
            // re-enables, and retrying each time would strip the surfaces'
            // fill for a few seconds per video. Only an explicit off and on
            // (`disable`) tries again.
            return;
        }
        let same_path = self.path.as_deref() == Some(path.as_str());
        if !same_path {
            self.in_list = false;
        }
        self.path = Some(path);
        // Every player mount re-enables. A shader already proven on this GPU
        // keeps its verdict: the `vo-passes` read waits on the VO thread, so
        // it runs once per real enable (a new path, or after `disable`), not
        // once per video.
        if !(same_path && self.verified) {
            self.verified = false;
            self.verify_attempts = 0;
            self.verify_at = None;
            self.relax_ow = false;
        }
        self.area_dirty = true;
        self.target_dirty = true;
        self.needs_eval = true;
    }

    /// Turn the feature off. Returns the path to remove from the list, if it
    /// is in it. The caller sends the off string first when `last_active`.
    pub fn disable(&mut self) -> Option<String> {
        let path = self.path.take();
        let was_in = std::mem::replace(&mut self.in_list, false);
        self.rects.clear();
        self.visible = false;
        self.fade = None;
        self.clear_at = None;
        self.failed = false;
        self.verified = false;
        self.verify_attempts = 0;
        self.verify_at = None;
        self.relax_ow = false;
        set_unavailable(false);
        self.needs_eval = true;
        if was_in { path } else { None }
    }

    /// The frontend's surfaces. `playing` is `Some((time_pos, speed))` while
    /// the video advances; `None` when paused or unknown (no fade possible).
    pub fn update(
        &mut self,
        rects: Vec<CssRect>,
        dpr: f64,
        visible: bool,
        style: GlassStyle,
        now: Instant,
        playing: Option<(f64, f64)>,
    ) {
        let was = self.visible;
        self.rects = rects
            .into_iter()
            .filter(|r| {
                [r.x, r.y, r.w, r.h, r.r].iter().all(|v| v.is_finite()) && r.w >= 1.0 && r.h >= 1.0
            })
            .map(|r| CssRect {
                x: r.x.clamp(-100_000.0, 100_000.0),
                y: r.y.clamp(-100_000.0, 100_000.0),
                w: r.w.min(100_000.0),
                h: r.h.min(100_000.0),
                r: r.r.clamp(0.0, 10_000.0),
            })
            .take(MAX_RECTS)
            .collect();
        self.dpr = if dpr.is_finite() { dpr.clamp(0.5, 8.0) } else { 1.0 };
        self.style = style;
        self.visible = visible;
        if was && !visible {
            match playing {
                Some((t, speed)) if t.is_finite() => {
                    let sp = if speed.is_finite() && speed > 0.0 { speed.min(8.0) } else { 1.0 };
                    // A hair past the current position: the next drawn frame
                    // still shows the glass at full strength.
                    self.fade = Some(Fade { t0: t + 0.03, dur: FADE_S * sp });
                    self.clear_at = Some(now + CLEAR_AFTER);
                }
                // Paused: PTS does not advance, a fade would freeze. Off now.
                _ => {
                    self.fade = None;
                    self.clear_at = None;
                }
            }
        } else if visible {
            // Showing snaps in under the CSS fade.
            self.fade = None;
            self.clear_at = None;
        }
        self.needs_eval = true;
    }

    /// No surfaces (the player unmounted, casting, no file).
    pub fn clear(&mut self) {
        self.rects.clear();
        self.visible = false;
        self.fade = None;
        self.clear_at = None;
        self.needs_eval = true;
    }

    /// mpv refused even the append: nothing to retry every tick, so the
    /// feature reports itself unavailable (the surfaces keep their fill).
    pub fn give_up(&mut self) {
        self.failed = true;
        set_unavailable(true);
        self.needs_eval = true;
    }

    /// Record whether the shader is (now) in mpv's `glsl-shaders` list.
    pub fn set_in_list(&mut self, v: bool) {
        self.in_list = v;
        self.needs_eval = true;
    }

    /// The cached video rect is invalid (load, VIDEO_RECONFIG): the glass
    /// stays off, and the re-read waits [`AREA_DELAY`] for a frame at the
    /// new geometry.
    pub fn mark_area_dirty(&mut self, now: Instant) {
        self.area_dirty = true;
        self.defer_read(now + AREA_DELAY);
        self.needs_eval = true;
    }

    /// Push the next (gated) property read out to at least `t`.
    fn defer_read(&mut self, t: Instant) {
        self.next_read = Some(self.next_read.map_or(t, |cur| cur.max(t)));
    }

    /// See `area_recheck`. The read waits a moment so the VO has applied
    /// the write before `osd-dimensions` is asked.
    pub fn mark_area_recheck(&mut self, now: Instant) {
        self.area_recheck = true;
        self.defer_read(now + RECHECK_DELAY);
    }

    /// The output transfer may have changed: re-read it once the VO has
    /// drawn with the new options ([`TARGET_DELAY`]).
    pub fn mark_target_dirty(&mut self, now: Instant) {
        self.target_dirty = true;
        self.defer_read(now + TARGET_DELAY);
        self.needs_eval = true;
    }

    /// The window geometry changed: off until it holds still for [`SUSPEND`],
    /// then re-read the video rect.
    pub fn suspend(&mut self, now: Instant) {
        self.suspend_until = Some(now + SUSPEND);
        self.area_dirty = true;
        // Never read in the tick of the resize: mpv has not drawn at the new
        // size yet, so `osd-dimensions` still hold the OLD rect. The first
        // read happens once the geometry has held still.
        self.defer_read(now + SUSPEND);
        self.needs_eval = true;
    }

    pub fn needs_area(&self) -> bool {
        self.area_dirty || self.area_recheck
    }

    pub fn needs_target(&self) -> bool {
        self.target_dirty
    }

    /// Whether a (gated) property read may run now. Never while a resize
    /// suspend is running (see [`Self::suspend`]).
    pub fn read_allowed(&self, now: Instant) -> bool {
        self.enabled()
            && self.suspend_until.is_none_or(|t| now >= t)
            && self.next_read.is_none_or(|t| now >= t)
    }

    pub fn set_area(&mut self, a: Option<VideoArea>, now: Instant) {
        match a {
            Some(a) => {
                if self.area != Some(a) {
                    self.needs_eval = true;
                }
                self.area = Some(a);
                self.area_dirty = false;
                self.area_recheck = false;
                if !self.target_dirty {
                    self.next_read = None;
                }
            }
            None => self.next_read = Some(now + READ_RETRY),
        }
        self.needs_eval = true;
    }

    pub fn set_target(&mut self, t: Target) {
        if self.target != t {
            self.needs_eval = true;
        }
        self.target = t;
        self.target_dirty = false;
        if !self.needs_area() {
            self.next_read = None;
        }
    }

    /// Whether [`Self::desired`] must be re-evaluated this tick.
    pub fn should_eval(&self, now: Instant) -> bool {
        self.needs_eval
            || self.suspend_until.is_some_and(|t| now >= t)
            || self.clear_at.is_some_and(|t| now >= t)
    }

    /// The parameters the shader should have now, or None for n = 0.
    pub fn desired(&mut self, now: Instant, ctx: &Ctx) -> Option<Params> {
        self.needs_eval = false;
        if self.suspend_until.is_some_and(|t| now >= t) {
            self.suspend_until = None;
        }
        if self.clear_at.is_some_and(|t| now >= t) {
            self.clear_at = None;
            self.fade = None;
        }
        if !self.enabled() || !self.in_list || !ctx.file_ready || self.suspend_until.is_some() {
            return None;
        }
        if self.rects.is_empty() || (!self.visible && self.clear_at.is_none()) {
            return None;
        }
        if self.area_dirty {
            return None;
        }
        let a = self.area?;
        let rects: Vec<PhysRect> = self
            .rects
            .iter()
            .map(|r| project(r, self.dpr, ctx.inset, &a))
            // A rect wholly over the letterbox bars has nothing to blur
            // (the bars are drawn after the OUTPUT hook): skip its passes.
            .filter(|p| overlap_frac(p, &a) > 0.0)
            .collect();
        if rects.is_empty() {
            return None;
        }
        let (alpha, fade_from, fade_t0, fade_dur) = match self.fade {
            Some(f) => (0.0, 1.0, f.t0, f.dur),
            None => (1.0, 1.0, 0.0, 0.0),
        };
        Some(Params {
            rects,
            ow: if self.relax_ow { 0.0 } else { a.ow.round() },
            look: look(self.style, self.dpr),
            alpha,
            fade_from,
            fade_t0,
            fade_dur,
            target: self.target,
            white_nits: 203.0,
        })
    }

    /// Record a send. Every live send before the check passed (re)arms the
    /// `vo-passes` check [`VERIFY_DELAY`] out, so it always looks at frames
    /// rendered AFTER the latest parameters landed (a check armed during an
    /// earlier show would otherwise read a frame from before this one).
    pub fn on_sent(&mut self, s: String, active: bool, now: Instant) {
        self.last_sent = s;
        self.last_active = active;
        if active && !self.verified && !self.failed {
            self.verify_at = Some(now + VERIFY_DELAY);
        }
    }

    /// A `vo-passes` check is due (only meaningful while rects are live).
    pub fn verify_due(&self, now: Instant) -> bool {
        self.enabled()
            && self.last_active
            && !self.verified
            && self.verify_at.is_some_and(|t| now >= t)
    }

    /// Fold one `vo-passes` read in. `found` = the composite pass is listed.
    pub fn verify_result(&mut self, found: bool, now: Instant) -> Verify {
        if found {
            self.verified = true;
            self.verify_at = None;
            return Verify::Ok;
        }
        self.verify_attempts = self.verify_attempts.saturating_add(1);
        if self.verify_attempts >= VERIFY_ATTEMPTS {
            self.failed = true;
            self.verify_at = None;
            set_unavailable(true);
            self.needs_eval = true;
            return Verify::Fail;
        }
        if !self.relax_ow {
            self.relax_ow = true;
            self.needs_eval = true;
        }
        self.verify_at = Some(now + VERIFY_DELAY);
        Verify::Retry
    }

    /// A check that could not read `vo-passes` (gate closed, read failed):
    /// try again shortly, without spending an attempt.
    pub fn verify_defer(&mut self, now: Instant) {
        if self.verify_at.is_some() {
            self.verify_at = Some(now + READ_RETRY);
        }
    }

    /// The state the frontend needs: whether the glass is drawn (so player
    /// surfaces may drop their baked fill), whether it is available at all,
    /// and the video rect in CSS px (surfaces mostly over the letterbox bars
    /// keep their fill, and are not even sent). The rect is reported
    /// whenever it is known, not only while drawing: the frontend uses it to
    /// decide which surfaces to send, and a rect tied to `active` would
    /// oscillate (no rect: send all; active: drop the letterboxed ones; none
    /// left: inactive, no rect again). None when nothing changed.
    pub fn state_json(&mut self, inset: f64) -> Option<serde_json::Value> {
        // A rect that is being re-read (resize, reconfig) is still reported:
        // it only steers which surfaces are sent, and dropping it would make
        // the frontend send every surface for a moment and then correct
        // itself, costing an extra renderer reset per resize.
        let video = if self.enabled() {
            self.area.map(|a| VideoCss {
                x: round2(a.ml / self.dpr),
                y: round2((a.mt + inset) / self.dpr),
                w: round2(a.ow / self.dpr),
                h: round2(a.oh / self.dpr),
            })
        } else {
            None
        };
        let state = GlassUiState { active: self.last_active, available: !self.failed, video };
        let key = format!("{state:?}");
        if key == self.last_state_key {
            return None;
        }
        self.last_state_key = key;
        serde_json::to_value(state).ok()
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Serialize, Debug, Clone, Copy)]
struct VideoCss {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize, Debug)]
struct GlassUiState {
    active: bool,
    available: bool,
    video: Option<VideoCss>,
}

/// What `player_glass` asks the engine to do.
pub enum GlassCmd {
    /// Some(forward-slash path) = on with that shader; None = off.
    Enable(Option<String>),
    Update { rects: Vec<CssRect>, dpr: f64, visible: bool, style: GlassStyle },
    Clear,
    /// After an upscaler chain change: make sure the glass is LAST again.
    EnsureLast,
}

// ---------------------------------------------------------------------------
// The Tauri command
// ---------------------------------------------------------------------------

/// One tagged command for the whole feature (one registration, three sites).
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GlassAction {
    /// Follow the setting: on writes the shader and appends it; off removes it.
    Enable { on: bool },
    /// The player's glass surfaces changed (rects, visibility, material).
    Update {
        rects: Vec<CssRect>,
        dpr: f64,
        visible: bool,
        #[serde(default)]
        style: GlassStyle,
    },
    /// No surfaces: the player unmounted, casting, no file.
    Clear,
    /// Just report the status.
    Status,
}

#[derive(Serialize)]
pub struct GlassStatus {
    /// False once the GPU was found unable to run the shader.
    pub available: bool,
}

/// Write the embedded shader to `app_data_dir()/shaders/<SHADER_NAME>.glsl`
/// (only when missing or different) and return mpv's forward-slash form of
/// the path, with any `\\?\` prefix stripped (landmine 8).
#[cfg(target_os = "windows")]
fn write_shader(app: &tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("shaders");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{SHADER_NAME}.glsl"));
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() != Some(SHADER_SRC) {
        let tmp = path.with_extension("glsl.tmp");
        std::fs::write(&tmp, SHADER_SRC).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    // Best effort: the previous versions' files are never loaded again.
    for old in ["aura_glass_v1.glsl", "aura_glass_v2.glsl"] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(mpv_path(&path.to_string_lossy()))
}

/// `\\?\C:\x` -> `C:/x`, `\\?\UNC\srv\x` -> `//srv/x` (cinema.rs does the same).
pub fn mpv_path(raw: &str) -> String {
    let cleaned = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .or_else(|| raw.strip_prefix(r"\\?\").map(String::from))
        .unwrap_or_else(|| raw.to_string());
    cleaned.replace('\\', "/")
}

/// "Real glass over video": the frontend's single entry point. Every action
/// is a non-blocking submit to the engine thread (which sends to mpv
/// asynchronously), so this never waits on mpv.
#[tauri::command]
pub async fn player_glass(app: tauri::AppHandle, action: GlassAction) -> Result<GlassStatus, String> {
    #[cfg(target_os = "windows")]
    {
        use super::engine::submit_glass;
        match action {
            GlassAction::Enable { on } => {
                // The setting is the authority: a stale frontend cannot turn
                // the shader on behind a switch that is off.
                if on && crate::settings::snapshot().real_glass {
                    let path = write_shader(&app)?;
                    crate::devlog!(info, "mpv", "real glass: enabled ({SHADER_NAME})");
                    submit_glass(GlassCmd::Enable(Some(path)))?;
                } else {
                    submit_glass(GlassCmd::Enable(None))?;
                }
            }
            GlassAction::Update { rects, dpr, visible, style } => {
                submit_glass(GlassCmd::Update { rects, dpr, visible, style })?;
            }
            GlassAction::Clear => submit_glass(GlassCmd::Clear)?,
            GlassAction::Status => {}
        }
        Ok(GlassStatus { available: !is_unavailable() })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, action);
        Err("playback engine is Windows-only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area_1080() -> VideoArea {
        VideoArea::from_osd(1920.0, 1044.0, 0.0, 0.0, 0.0, 0.0).unwrap()
    }

    #[test]
    fn projection_uses_physical_inset_and_margins() {
        // 150 %, windowed (36 physical px inset), pillarboxed by 240 px.
        let a = VideoArea::from_osd(2880.0, 1584.0, 240.0, 0.0, 240.0, 0.0).unwrap();
        assert_eq!(a.ow, 2400.0);
        let p = project(&CssRect { x: 200.0, y: 600.0, w: 400.0, h: 100.0, r: 16.0 }, 1.5, 36.0, &a);
        assert_eq!(p, PhysRect { x: 60.0, y: 864.0, w: 600.0, h: 150.0, r: 24.0 });
    }

    #[test]
    fn zoom_margins_clamp_at_zero() {
        let a = VideoArea::from_osd(1920.0, 1080.0, -397.0, -223.0, -397.0, -223.0).unwrap();
        assert_eq!((a.ml, a.mt, a.ow, a.oh), (0.0, 0.0, 1920.0, 1080.0));
        assert!(VideoArea::from_osd(0.0, 1080.0, 0.0, 0.0, 0.0, 0.0).is_none());
        assert!(VideoArea::from_osd(1920.0, 1080.0, f64::NAN, 0.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn overlap_over_letterbox() {
        // 2.39:1 in 1920x1080: mt = mb = 138.
        let a = VideoArea::from_osd(1920.0, 1080.0, 0.0, 138.0, 0.0, 138.0).unwrap();
        // A bar wholly inside the bottom bar.
        let bar = PhysRect { x: 100.0, y: 820.0, w: 1700.0, h: 100.0, r: 16.0 };
        assert_eq!(overlap_frac(&bar, &a), 0.0);
        let half = PhysRect { x: 0.0, y: 754.0, w: 100.0, h: 100.0, r: 0.0 };
        assert!((overlap_frac(&half, &a) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn opts_is_the_full_prefixed_key_set() {
        let s = off_opts();
        let keys: Vec<&str> = s.split(',').collect();
        let prefix = format!("{SHADER_NAME}/");
        assert_eq!(keys.len(), 16 + MAX_RECTS * 6);
        assert!(keys.iter().all(|k| k.starts_with(&prefix)));
        assert!(s.starts_with(&format!("{prefix}glass_n=0,")));
        // Every key the opts set is a //!PARAM the shader declares.
        for k in keys {
            let name = k.trim_start_matches(prefix.as_str()).split('=').next().unwrap();
            assert!(SHADER_SRC.contains(&format!("//!PARAM {name}\n")) || SHADER_SRC.contains(&format!("//!PARAM {name}\r\n")), "{name}");
        }
    }

    #[test]
    fn both_styles_lift_dark_and_cap_bright() {
        for style in [GlassStyle::Frosted, GlassStyle::Liquid] {
            let l = look(style, 1.0);
            assert!(l.cap < 1.0 && l.cap > 0.0, "{style:?}");
            assert!(l.dim > l.cap, "{style:?}: a dark or mid frame must pass lighter than the cap");
            assert!(l.dim <= 1.0, "{style:?}: glass_dim PARAM maximum");
            assert!(l.sat >= 1.0, "{style:?}");
            assert!(l.lift >= 0.0 && l.lift <= 0.02, "{style:?}");
            assert!(
                l.cap + l.lift * (1.0 - l.cap) <= 0.16,
                "{style:?}: a white frame must stay under 0.16 linear so white text keeps about 4.5:1 or better (bt.1886) before the CSS face"
            );
            assert!(l.lift <= 0.005, "{style:?}: a bigger lift reads as a flat mid grey over black");
        }
        // The Liquid frost is lighter than Frosted's (video reads softened,
        // not erased), and both stay within the glass_blur PARAM range.
        assert!(look(GlassStyle::Liquid, 1.0).blur < look(GlassStyle::Frosted, 1.0).blur);
        assert!(look(GlassStyle::Liquid, 4.0).blur <= 8.0 && look(GlassStyle::Frosted, 4.0).blur <= 8.0);
    }

    #[test]
    fn target_from_live_gamma() {
        assert_eq!(Target::from_gamma("pq"), Target { pq: true, gamma: 2.2 });
        assert_eq!(Target::from_gamma("bt.1886"), Target { pq: false, gamma: 2.4 });
        assert_eq!(Target::from_gamma("srgb"), Target::DEFAULT);
    }

    #[test]
    fn frosted_never_refracts() {
        assert_eq!(look(GlassStyle::Frosted, 1.5).refract, 0.0);
        assert!(look(GlassStyle::Liquid, 1.0).refract > 0.0);
    }

    fn live_state(now: Instant) -> GlassState {
        let mut g = GlassState::default();
        g.enable("C:/x/aura_glass_v3.glsl".into());
        g.in_list = true;
        g.set_area(Some(area_1080()), now);
        g.set_target(Target::DEFAULT);
        g
    }

    #[test]
    fn hide_fades_while_playing_then_clears() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 36.0 };
        let mut g = live_state(now);
        let bar = vec![CssRect { x: 100.0, y: 900.0, w: 1100.0, h: 90.0, r: 16.0 }];
        g.update(bar.clone(), 1.0, true, GlassStyle::Frosted, now, Some((10.0, 1.0)));
        let p = g.desired(now, &ctx).expect("shown");
        assert_eq!((p.alpha, p.fade_dur), (1.0, 0.0));
        assert_eq!(p.rects[0].y, 900.0 - 36.0);
        g.update(bar.clone(), 1.0, false, GlassStyle::Frosted, now, Some((10.0, 1.0)));
        let p = g.desired(now, &ctx).expect("fading");
        assert_eq!(p.alpha, 0.0);
        assert!((p.fade_t0 - 10.03).abs() < 1e-9 && (p.fade_dur - FADE_S).abs() < 1e-9);
        let later = now + CLEAR_AFTER + Duration::from_millis(1);
        assert!(g.should_eval(later));
        assert!(g.desired(later, &ctx).is_none());
    }

    #[test]
    fn hide_while_paused_is_immediate() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 0.0 };
        let mut g = live_state(now);
        let bar = vec![CssRect { x: 100.0, y: 900.0, w: 1100.0, h: 90.0, r: 16.0 }];
        g.update(bar.clone(), 1.0, true, GlassStyle::Liquid, now, None);
        assert!(g.desired(now, &ctx).is_some());
        g.update(bar, 1.0, false, GlassStyle::Liquid, now, None);
        assert!(g.desired(now, &ctx).is_none());
    }

    #[test]
    fn resize_suspends_until_reread() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 36.0 };
        let mut g = live_state(now);
        g.update(vec![CssRect { x: 0.0, y: 900.0, w: 500.0, h: 90.0, r: 0.0 }], 1.0, true, GlassStyle::Frosted, now, None);
        assert!(g.desired(now, &ctx).is_some());
        g.suspend(now);
        assert!(g.desired(now, &ctx).is_none());
        // The engine must not read osd-dimensions in the tick of the resize
        // (they still describe the old size), nor while it continues.
        assert!(g.needs_area());
        assert!(!g.read_allowed(now));
        assert!(!g.read_allowed(now + SUSPEND - Duration::from_millis(1)));
        let later = now + SUSPEND + Duration::from_millis(1);
        assert!(g.read_allowed(later));
        // Settled, but the rect has not been re-read yet.
        assert!(g.desired(later, &ctx).is_none());
        g.set_area(Some(area_1080()), later);
        assert!(g.desired(later, &ctx).is_some());
    }

    #[test]
    fn reconfig_and_target_writes_delay_the_read() {
        let now = Instant::now();
        let mut g = live_state(now);
        g.mark_area_dirty(now);
        assert!(!g.read_allowed(now));
        assert!(g.read_allowed(now + AREA_DELAY));
        g.set_area(Some(area_1080()), now + AREA_DELAY);
        // An HDR mode switch: video-target-params lags until a frame is
        // drawn with the new options.
        g.mark_target_dirty(now);
        assert!(g.needs_target());
        assert!(!g.read_allowed(now));
        assert!(g.read_allowed(now + TARGET_DELAY));
        // An area read that lands first does not open the gate for the
        // still-pending target read.
        let mut g = live_state(now);
        g.mark_target_dirty(now);
        g.mark_area_recheck(now);
        g.set_area(Some(area_1080()), now + RECHECK_DELAY);
        assert!(!g.read_allowed(now + RECHECK_DELAY));
        assert!(g.read_allowed(now + TARGET_DELAY));
    }

    #[test]
    fn remount_keeps_a_passed_verification() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 36.0 };
        let mut g = live_state(now);
        g.update(vec![CssRect { x: 0.0, y: 900.0, w: 500.0, h: 90.0, r: 0.0 }], 1.0, true, GlassStyle::Frosted, now, None);
        let p = g.desired(now, &ctx).unwrap();
        g.on_sent(p.opts(), true, now);
        assert_eq!(g.verify_result(true, now + VERIFY_DELAY), Verify::Ok);
        // The next player mount re-enables the same path: no second check.
        g.enable("C:/x/aura_glass_v3.glsl".into());
        g.on_sent(p.opts(), true, now);
        assert!(!g.verify_due(now + VERIFY_DELAY * 2));
        // Off and on again re-arms it.
        let _ = g.disable();
        g.enable("C:/x/aura_glass_v3.glsl".into());
        g.in_list = true;
        g.on_sent(p.opts(), true, now);
        assert!(g.verify_due(now + VERIFY_DELAY));
    }

    #[test]
    fn zoom_nudge_rechecks_without_dropping_the_glass() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 36.0 };
        let mut g = live_state(now);
        g.update(vec![CssRect { x: 0.0, y: 900.0, w: 500.0, h: 90.0, r: 0.0 }], 1.0, true, GlassStyle::Frosted, now, None);
        assert!(g.desired(now, &ctx).is_some());
        g.mark_area_recheck(now);
        assert!(g.needs_area());
        assert!(!g.read_allowed(now));
        // Still drawn on the cached rect while the re-read is pending.
        g.update(vec![CssRect { x: 0.0, y: 900.0, w: 500.0, h: 90.0, r: 0.0 }], 1.0, true, GlassStyle::Frosted, now, None);
        assert!(g.desired(now, &ctx).is_some());
        assert!(g.read_allowed(now + RECHECK_DELAY));
    }

    #[test]
    fn verification_relaxes_ow_then_fails() {
        let now = Instant::now();
        let ctx = Ctx { file_ready: true, inset: 36.0 };
        let mut g = live_state(now);
        g.update(vec![CssRect { x: 0.0, y: 900.0, w: 500.0, h: 90.0, r: 0.0 }], 1.0, true, GlassStyle::Frosted, now, None);
        let p = g.desired(now, &ctx).unwrap();
        assert_eq!(p.ow, 1920.0);
        g.on_sent(p.opts(), true, now);
        let t1 = now + VERIFY_DELAY;
        assert!(g.verify_due(t1));
        assert_eq!(g.verify_result(false, t1), Verify::Retry);
        assert_eq!(g.desired(t1, &ctx).unwrap().ow, 0.0);
        assert_eq!(g.verify_result(false, t1), Verify::Retry);
        assert_eq!(g.verify_result(false, t1), Verify::Fail);
        assert!(g.failed);
        assert!(g.desired(t1, &ctx).is_none());
        // A re-enable (the next player mount) does not retry...
        g.enable("C:/x/aura_glass_v3.glsl".into());
        assert!(g.failed);
        // ...turning the setting off and on again does.
        let _ = g.disable();
        g.enable("C:/x/aura_glass_v3.glsl".into());
        assert!(!g.failed);
    }

    #[test]
    fn mpv_path_strips_extended_prefix() {
        assert_eq!(mpv_path(r"\\?\C:\Users\a\shaders\x.glsl"), "C:/Users/a/shaders/x.glsl");
        assert_eq!(mpv_path(r"\\?\UNC\srv\share\x.glsl"), "//srv/share/x.glsl");
        assert_eq!(mpv_path(r"C:\a\b.glsl"), "C:/a/b.glsl");
    }
}
